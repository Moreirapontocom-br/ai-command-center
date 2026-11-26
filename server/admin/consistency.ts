import type { HistoryEntry, HistoryItem } from '../approvals/documents.ts';
import type { EventLog, StoredAuditEvent } from '../audit/events.ts';
import { ADMIN_USER_ID } from '../auth/adminAuth.ts';
import { RELEASE_OPERATION } from './journal.ts';

/**
 * Cruzamento #011 × #006 da liberação da barreira global (Issue #008, fechamento — L3).
 *
 * O diário (`admin-release.journal.json`) mora em `ACC_DATA_DIR`. Se o servidor subir com outro
 * `ACC_DATA_DIR` sobre as MESMAS aprovações, ou se o diário for apagado no meio da operação, ele
 * não vê a pendência. Este módulo torna a segurança independente do diário: a partir dos FATOS da
 * #011 (fonte de verdade) e da #006, decide se toda liberação global humana aplicada tem exatamente
 * UM registro final correlacionado na auditoria.
 *
 * Correlação de uma liberação R (entrada `approval.barrier_released`, global, humana, aplicada):
 * - a MESMA geração do ledger tem exatamente uma `approval.attempt_succeeded` (o commit atômico de
 *   `applyInternal`), que dá `approvalId` (P) e `attemptId`;
 * - o pedido de P (`approval.requested`), se ainda retido, é `killswitch.release` global;
 * - o registro final na #006 é `approval.configuration` com sucesso, do administrador, operação
 *   `barrier_release_global`, `resource = {approval, P}` e `context.seq = R.seq`.
 *
 * Identificador primário: `approvalId` (C2). É um UUID v4 aleatório gerado pela #011 para cada
 * aprovação (`randomUUID`, 122 bits), de uso único (`approval_already_used`), e nunca é reaproveitado
 * entre linhagens (uma linhagem nova começa com ledger vazio). Por isso a correlação NÃO depende do
 * relógio: registros de outras aprovações (inclusive de linhagens antigas com `seq` coincidente) são
 * ignorados e nunca validam esta liberação; registros desta aprovação têm de ser exatos.
 *
 * Resultado:
 * - `consistent`: tudo correlacionado (ou nenhuma liberação);
 * - `missing`: falta o registro de uma ou mais liberações, e nada contradiz os fatos → o comando
 *   pode completar a #006 (reconciliação idempotente; nunca libera nada);
 * - `inconsistent`: registro da MESMA aprovação duplicado ou divergente (seq, ator, dono, escopo,
 *   resultado), correlação ausente na #011, aprovação usada por mais de uma liberação, ator
 *   inesperado ou qualquer erro de leitura → nada é gravado automaticamente; investigação humana.
 *
 * Retenção (C1): a #006 nunca descarta o registro final (`isPreservedEvent`), então a ausência é
 * SEMPRE `missing`, por mais eventos que o registro acumule.
 */

export interface ReleaseFact {
  seq: number;
  at: string;
  approvalId: string;
  attemptId: string;
}

export type ConsistencyReason =
  | 'release_uncorrelated'
  | 'release_actor_unexpected'
  | 'release_approval_unexpected'
  | 'audit_record_mismatch'
  | 'audit_record_duplicate'
  | 'check_failed';

export type ConsistencyResult =
  | { state: 'consistent'; releases: number }
  | { state: 'missing'; missing: ReleaseFact[] }
  | { state: 'inconsistent'; reason: ConsistencyReason };

/** Seqs que a #011 declarou NÃO aplicados (ledger perdido): não contam como fato. */
export function unappliedSeqs(items: readonly HistoryEntry[]): Set<number> {
  const out = new Set<number>();
  for (const e of items) {
    if (e.event !== 'approval.history_unapplied' || typeof e.detail !== 'string') continue;
    const m = /^seq (\d+)-(\d+)$/.exec(e.detail);
    if (!m) continue;
    for (let s = Number(m[1]); s <= Number(m[2]) && s - Number(m[1]) < 100_000; s += 1) out.add(s);
  }
  return out;
}

const entriesOf = (items: readonly HistoryItem[]) => items.filter((i): i is HistoryEntry => i.kind === 'entry');

/** Liberações globais humanas e aplicadas (todas, ou só as posteriores a `afterSeq`). */
export function appliedGlobalReleases(items: readonly HistoryItem[], afterSeq = 0): HistoryEntry[] {
  const entries = entriesOf(items);
  const lost = unappliedSeqs(entries);
  return entries.filter((e) => e.seq > afterSeq && !lost.has(e.seq) && e.event === 'approval.barrier_released' && e.projectId === null && e.actor.kind === 'human');
}

const isReleaseRecord = (e: StoredAuditEvent) => e.action === 'approval.configuration' && e.outcome === 'success' && e.context.operation === RELEASE_OPERATION;

/** O registro corresponde EXATAMENTE à liberação (identidade, escopo e correlação). */
export function matchesRelease(e: StoredAuditEvent, fact: Pick<ReleaseFact, 'seq' | 'approvalId'>): boolean {
  return (
    isReleaseRecord(e) &&
    e.actor.kind === 'human' &&
    e.actor.id === ADMIN_USER_ID &&
    e.ownerId === ADMIN_USER_ID &&
    e.projectId === null &&
    e.resource.type === 'approval' &&
    e.resource.id === fact.approvalId &&
    e.context.seq === fact.seq
  );
}

export function checkReleaseAudit(history: { items: readonly HistoryItem[] }, audit: Readonly<EventLog>): ConsistencyResult {
  try {
    const entries = entriesOf(history.items);
    const lost = unappliedSeqs(entries);
    const hasTombstones = history.items.some((i) => i.kind === 'tombstone');
    const releases = appliedGlobalReleases(history.items);
    // Qualquer registro desta operação, com QUALQUER resultado: um registro de falha da mesma aprovação contradiz a liberação.
    const records = audit.events.filter((e) => e.action === 'approval.configuration' && e.context.operation === RELEASE_OPERATION);
    const seen = new Set<string>();
    const missing: ReleaseFact[] = [];

    for (const r of releases) {
      if (r.actor.id !== ADMIN_USER_ID) return { state: 'inconsistent', reason: 'release_actor_unexpected' };
      const succeeded = entries.filter((e) => e.event === 'approval.attempt_succeeded' && e.ledgerGeneration === r.ledgerGeneration && !lost.has(e.seq));
      if (succeeded.length !== 1 || succeeded[0].approvalId === null || succeeded[0].attemptId === null) return { state: 'inconsistent', reason: 'release_uncorrelated' };
      const fact: ReleaseFact = { seq: r.seq, at: r.at, approvalId: succeeded[0].approvalId, attemptId: succeeded[0].attemptId };
      // Uso único: uma aprovação nunca sustenta duas liberações.
      if (seen.has(fact.approvalId)) return { state: 'inconsistent', reason: 'release_uncorrelated' };
      seen.add(fact.approvalId);
      const requested = entries.filter((e) => e.event === 'approval.requested' && e.approvalId === fact.approvalId);
      // Pedido descartado pela retenção da #011 (só com tombstones) é aceito; presente, tem de ser o da liberação global.
      if (requested.length === 0 && !hasTombstones) return { state: 'inconsistent', reason: 'release_uncorrelated' };
      if (requested.some((e) => e.action !== 'killswitch.release' || e.projectId !== null)) return { state: 'inconsistent', reason: 'release_approval_unexpected' };

      // C2: relação SÓ pela aprovação (independe do relógio e de outras linhagens).
      const related = records.filter((e) => e.resource.id === fact.approvalId);
      const exact = related.filter((e) => matchesRelease(e, fact));
      if (related.length > exact.length) return { state: 'inconsistent', reason: 'audit_record_mismatch' };
      if (exact.length > 1) return { state: 'inconsistent', reason: 'audit_record_duplicate' };
      if (exact.length === 0) missing.push(fact);
    }
    return missing.length > 0 ? { state: 'missing', missing } : { state: 'consistent', releases: releases.length };
  } catch {
    return { state: 'inconsistent', reason: 'check_failed' };
  }
}

export const ADMIN_AUDIT_INCONSISTENT = 'admin_audit_inconsistent';

/** Sinal interno do servidor: aprovações abertas, mas indisponibilizadas pelo cruzamento (motivo-token). */
export class ReleaseAuditGap extends Error {
  name = 'ReleaseAuditGap';
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
