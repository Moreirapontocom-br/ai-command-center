import { randomBytes } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ApprovalError } from './contracts.ts';

/**
 * Escritor único (R2): um arquivo de bloqueio criado com `wx` (exclusivo) no diretório do ledger.
 * Outro processo (ou outra instância no mesmo processo) que tente abrir o mesmo armazenamento é
 * recusado com `store_locked`. Um bloqueio só é considerado abandonado quando foi criado NESTA
 * máquina e o processo dono não existe mais; nesse caso é retomado e isso fica registrado no
 * histórico. Bloqueio de outra máquina nunca é retomado automaticamente.
 */
export interface StoreLock {
  readonly recovered: boolean;
  release(): Promise<void>;
}

export const LOCK_FILE = 'approvals.lock';

interface LockContent {
  pid: number;
  host: string;
  nonce: string;
  at: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, mas pertence a outro usuário.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function tryCreate(path: string, content: LockContent): Promise<boolean> {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(content), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new ApprovalError('lock_unavailable');
  }
}

export async function acquireStoreLock(directory: string, now: () => number = Date.now): Promise<StoreLock> {
  const path = join(directory, LOCK_FILE);
  const content: LockContent = { pid: process.pid, host: hostname(), nonce: randomBytes(16).toString('hex'), at: new Date(now()).toISOString() };
  let recovered = false;
  if (!(await tryCreate(path, content))) {
    let existing: Partial<LockContent> | null;
    try {
      existing = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContent>;
    } catch {
      existing = null;
    }
    const stale =
      existing !== null &&
      typeof existing.pid === 'number' &&
      Number.isSafeInteger(existing.pid) &&
      existing.host === content.host &&
      existing.pid !== process.pid &&
      !processAlive(existing.pid);
    if (!stale) throw new ApprovalError('store_locked');
    await rm(path, { force: true });
    if (!(await tryCreate(path, content))) throw new ApprovalError('store_locked');
    recovered = true;
  }
  let released = false;
  return {
    recovered,
    async release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContent>;
        if (current.nonce === content.nonce) await rm(path, { force: true });
      } catch {
        // Bloqueio já removido ou ilegível: nada a liberar.
      }
    },
  };
}
