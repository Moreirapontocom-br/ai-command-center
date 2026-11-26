import { mkdir } from 'node:fs/promises';
import { acquireLock, type AcquireLockOptions, type StoreLock } from '../storage/lock.ts';
import { StorageError } from '../storage/errors.ts';
import { releasePending, type JournalFileOps } from './journal.ts';

/**
 * Lock de instância do ACC (Issue #008, P1 — R1 da revisão final).
 *
 * Um único processo por `ACC_DATA_DIR`: o SERVIDOR e o COMANDO ADMINISTRATIVO de liberação da
 * barreira obtêm este lock ANTES de abrir qualquer arquivo de dados (projetos, tarefas, auditoria,
 * aprovações, fila, gateway). Assim o comando nunca roda com o servidor ativo, e o servidor não sobe
 * enquanto o comando estiver ativo.
 *
 * Implementação: a primitiva já revisada `storage/lock.ts` (criação exclusiva `wx` + fsync, atômica
 * também no Windows), com arquivos próprios. Retomada automática só de lock DESTA máquina, de OUTRO
 * processo que NÃO existe mais, serializada por arquivo de retomada e com releitura do nonce.
 * Conteúdo ilegível, link, outra máquina, processo vivo (inclusive pid reutilizado) → recusa
 * (`store_locked`), e a remoção é humana (passo a passo em `docs/BARRIER_RELEASE.md`). A liberação
 * só remove o arquivo se o nonce ainda for o desta instância.
 */

export const INSTANCE_LOCK_FILES = Object.freeze({ lock: 'acc-instance.lock', takeover: 'acc-instance.lock.takeover' });

export class InstanceLockError extends Error {
  name = 'InstanceLockError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** Obtém o lock de instância em `dataDir` (criado se não existir, sem abrir nenhum arquivo de dados). */
export async function acquireInstanceLock(dataDir: string, options: Omit<AcquireLockOptions, 'errors'> = {}): Promise<StoreLock> {
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
  } catch {
    throw new InstanceLockError('lock_unavailable');
  }
  try {
    return await acquireLock(dataDir, INSTANCE_LOCK_FILES, options);
  } catch (error) {
    throw new InstanceLockError(error instanceof StorageError ? error.code : 'lock_unavailable');
  }
}

/** O servidor abre as aprovações como indisponíveis enquanto houver liberação administrativa pendente. */
export function adminReleasePending(dataDir: string, ops?: JournalFileOps): Promise<boolean> {
  return releasePending(dataDir, ops);
}

export const ADMIN_RECONCILE_PENDING = 'admin_reconcile_pending';
