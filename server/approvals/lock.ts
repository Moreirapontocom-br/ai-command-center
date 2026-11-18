import { acquireLock, processAlive, type LockFileOps, type StoreLock } from '../storage/lock.ts';
import { approvalErrors } from './canonical.ts';

/**
 * Escritor único do núcleo de aprovações (R2/R4). Desde a Issue #012 (D7) a implementação fica em
 * `server/storage/lock.ts`; este módulo mantém a API, os NOMES DOS ARQUIVOS e a semântica de antes:
 * erros `ApprovalError` com os mesmos códigos (`store_locked`, `lock_unavailable`,
 * `lock_recovery_stale`, `lock_recovery_failed`). Na retomada, um `ApprovalError` (ex.:
 * `store_locked` de um bloqueio trocado no meio) continua sendo repassado intacto — só falhas
 * inesperadas viram `lock_recovery_failed`.
 */
export type { LockFileOps, StoreLock };
export { processAlive };

export const LOCK_FILE = 'approvals.lock';
export const TAKEOVER_FILE = 'approvals.lock.takeover';

export function acquireStoreLock(
  directory: string,
  options: { now?: () => number; ops?: LockFileOps; alive?: (pid: number) => boolean } = {},
): Promise<StoreLock> {
  return acquireLock(directory, { lock: LOCK_FILE, takeover: TAKEOVER_FILE }, { ...options, errors: approvalErrors });
}
