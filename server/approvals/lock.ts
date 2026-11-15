import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ApprovalError } from './contracts.ts';

/**
 * Escritor único (R2/R4): arquivo de bloqueio criado com `wx` (criação exclusiva, atômica também
 * no Windows) no diretório do ledger. Outra instância — outro processo ou o mesmo processo — que
 * tente abrir o mesmo armazenamento recebe `store_locked`.
 *
 * Retomada de bloqueio abandonado (processo encerrado sem liberar):
 * - só se o bloqueio for DESTA máquina, com conteúdo legível, de OUTRO pid e esse pid não existir;
 *   conteúdo ilegível, link, outra máquina, pid vivo (ou reutilizado pelo sistema) → `store_locked`
 *   (fail-closed: exige remoção humana do arquivo, procedimento documentado);
 * - é serializada por um segundo arquivo exclusivo (`approvals.lock.takeover`): só um recuperador
 *   por vez. Dentro dele o bloqueio é relido e só é removido se ainda for EXATAMENTE o abandonado
 *   (mesmo nonce) — um recuperador atrasado nunca apaga o bloqueio que outro acabou de criar;
 * - qualquer falha na retomada → `lock_recovery_failed`; o arquivo de retomada é sempre removido.
 *   Se o próprio arquivo de retomada estiver abandonado, → `lock_recovery_stale` (intervenção humana).
 *
 * Liberação: só remove o arquivo se o nonce ainda for o desta instância.
 */
export interface StoreLock {
  readonly recovered: boolean;
  release(): Promise<void>;
}

export const LOCK_FILE = 'approvals.lock';
export const TAKEOVER_FILE = 'approvals.lock.takeover';

interface LockContent {
  pid: number;
  host: string;
  nonce: string;
  at: string;
}

/** Operações de arquivo (injetáveis só para testes de falha). */
export interface LockFileOps {
  create(path: string, content: string): Promise<boolean>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  isRegularFile(path: string): Promise<boolean>;
}

const defaultOps: LockFileOps = {
  async create(path, content) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  },
  read: (path) => readFile(path, 'utf8'),
  remove: (path) => rm(path),
  async isRegularFile(path) {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
  },
};

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, mas pertence a outro usuário.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parse(text: string): LockContent | null {
  try {
    const value = JSON.parse(text) as Partial<LockContent>;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    if (typeof value.host !== 'string' || typeof value.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(value.nonce)) return null;
    return value as LockContent;
  } catch {
    return null;
  }
}

export async function acquireStoreLock(
  directory: string,
  options: { now?: () => number; ops?: LockFileOps; alive?: (pid: number) => boolean } = {},
): Promise<StoreLock> {
  const now = options.now ?? Date.now;
  const ops = options.ops ?? defaultOps;
  const alive = options.alive ?? processAlive;
  const path = join(directory, LOCK_FILE);
  const takeoverPath = join(directory, TAKEOVER_FILE);
  const mine = (): LockContent => ({ pid: process.pid, host: hostname(), nonce: randomBytes(16).toString('hex'), at: new Date(now()).toISOString() });
  const content = mine();
  const serialized = JSON.stringify(content);

  const create = async (target: string, text: string) => {
    try {
      return await ops.create(target, text);
    } catch {
      throw new ApprovalError('lock_unavailable');
    }
  };

  /** Bloqueio existente é abandonado? Lança `store_locked` em qualquer dúvida. */
  async function readStale(): Promise<LockContent> {
    let text: string;
    try {
      if (!(await ops.isRegularFile(path))) throw new ApprovalError('store_locked');
      text = await ops.read(path);
    } catch {
      throw new ApprovalError('store_locked');
    }
    const existing = parse(text);
    if (!existing || existing.host !== content.host || existing.pid === process.pid || alive(existing.pid)) throw new ApprovalError('store_locked');
    return existing;
  }

  let recovered = false;
  if (!(await create(path, serialized))) {
    const stale = await readStale();
    // Só um recuperador por vez.
    if (!(await create(takeoverPath, JSON.stringify(mine())))) {
      let takeoverOwner: LockContent | null;
      try {
        takeoverOwner = parse(await ops.read(takeoverPath));
      } catch {
        takeoverOwner = null;
      }
      const abandoned = takeoverOwner !== null && takeoverOwner.host === content.host && takeoverOwner.pid !== process.pid && !alive(takeoverOwner.pid);
      throw new ApprovalError(abandoned ? 'lock_recovery_stale' : 'store_locked');
    }
    try {
      // Relê dentro da exclusão: remove apenas se ainda for exatamente o bloqueio abandonado.
      const again = parse(await ops.read(path));
      if (!again || again.nonce !== stale.nonce) throw new ApprovalError('store_locked');
      await ops.remove(path);
      if (!(await ops.create(path, serialized))) throw new ApprovalError('store_locked');
      recovered = true;
    } catch (error) {
      throw error instanceof ApprovalError ? error : new ApprovalError('lock_recovery_failed');
    } finally {
      await ops.remove(takeoverPath).catch(() => undefined);
    }
  }

  let released = false;
  return {
    recovered,
    async release() {
      if (released) return;
      released = true;
      try {
        const current = parse(await ops.read(path));
        if (current && current.nonce === content.nonce) await ops.remove(path);
      } catch {
        // Bloqueio já removido ou ilegível: nada a liberar (nunca remove o de outra instância).
      }
    },
  };
}
