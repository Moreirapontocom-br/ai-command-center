import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { storageErrors, type ErrorFactory } from './errors.ts';

/**
 * Escritor único (#011 R2/R4; compartilhado desde a Issue #012, D7): arquivo de bloqueio criado
 * com `wx` (criação exclusiva, atômica também no Windows) no diretório do armazenamento. Outra
 * instância — outro processo ou o mesmo processo — que tente abrir o mesmo armazenamento recebe
 * `store_locked`. Os nomes dos arquivos e a classe de erro vêm do chamador; o núcleo de aprovações
 * continua com `approvals.lock`/`approvals.lock.takeover` e `ApprovalError` (shim em
 * no módulo `lock` das aprovações).
 *
 * Alcance REAL da exclusão: processos na MESMA máquina, sobre disco LOCAL. Não há garantia
 * distribuída nem em compartilhamentos de rede (um bloqueio de outra máquina é sempre tratado como
 * ativo: `store_locked`). O bloqueio não protege contra escrita por fora do ACC — isso é papel do
 * MAC e do anchor.
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

/** Nomes dos arquivos de bloqueio de um armazenamento. */
export interface LockFileNames {
  lock: string;
  takeover: string;
}

export interface AcquireLockOptions {
  now?: () => number;
  ops?: LockFileOps;
  alive?: (pid: number) => boolean;
  /** Padrão: `StorageError`. Erros desta fábrica são repassados intactos na retomada. */
  errors?: ErrorFactory;
}

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

export async function acquireLock(directory: string, names: LockFileNames, options: AcquireLockOptions = {}): Promise<StoreLock> {
  const now = options.now ?? Date.now;
  const ops = options.ops ?? defaultOps;
  const alive = options.alive ?? processAlive;
  const errors = options.errors ?? storageErrors;
  const path = join(directory, names.lock);
  const takeoverPath = join(directory, names.takeover);
  const mine = (): LockContent => ({ pid: process.pid, host: hostname(), nonce: randomBytes(16).toString('hex'), at: new Date(now()).toISOString() });
  const content = mine();
  const serialized = JSON.stringify(content);

  const create = async (target: string, text: string) => {
    try {
      return await ops.create(target, text);
    } catch {
      throw errors.create('lock_unavailable');
    }
  };

  /** Bloqueio existente é abandonado? Lança `store_locked` em qualquer dúvida. */
  async function readStale(): Promise<LockContent> {
    let text: string;
    try {
      if (!(await ops.isRegularFile(path))) throw errors.create('store_locked');
      text = await ops.read(path);
    } catch {
      throw errors.create('store_locked');
    }
    const existing = parse(text);
    if (!existing || existing.host !== content.host || existing.pid === process.pid || alive(existing.pid)) throw errors.create('store_locked');
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
      throw errors.create(abandoned ? 'lock_recovery_stale' : 'store_locked');
    }
    try {
      // Relê dentro da exclusão: remove apenas se ainda for exatamente o bloqueio abandonado.
      const again = parse(await ops.read(path));
      if (!again || again.nonce !== stale.nonce) throw errors.create('store_locked');
      await ops.remove(path);
      if (!(await ops.create(path, serialized))) throw errors.create('store_locked');
      recovered = true;
    } catch (error) {
      throw errors.is(error) ? error : errors.create('lock_recovery_failed');
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
