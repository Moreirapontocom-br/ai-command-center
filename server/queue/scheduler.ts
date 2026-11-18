import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../storage/canonical.ts';
import type { BarrierGate } from './barrierGate.ts';
import { classifyRefusal, GLOBAL_REFUSALS, PRIORITY_RANK } from './classification.ts';
import {
  ADMITTED_WINDOW_MS,
  isTerminal,
  MAX_CHAIN_ATTEMPTS,
  QUEUE_AGENTS,
  QUEUE_PRIORITIES,
  QUEUE_SYSTEM_ACTOR,
  QUEUE_TTL_MS,
  QueueError,
  retryDelayMs,
  scopeKey,
  type AdmissionSnapshot,
  type BarrierScope,
  type JsonValue,
  type QueueAdmissionParams,
  type QueueHistoryData,
  type QueueItem,
  type QueueItemState,
  type QueueOutcome,
  type QueueRun,
} from './contracts.ts';
import { ACTOR_ID, checkAdmissionParams, checkExecutionParams, QueueDocumentError, REASON, UUID } from './documents.ts';
import type { AdmissionPort, AdmissionRestoreRecord, ExecutionResult, ExecutionUsage, ExecutorPort, QueueSubject, TaskLookup } from './ports.ts';
import { parseBarrierScope, type QueueStore, type QueueTransaction } from './store.ts';

/**
 * Agendador da fila (Issue #012, PR 2) — DORMENTE (Q7): não é instanciado no `server/index.ts`, não
 * tem temporizador próprio e só avança quando alguém chama `tick()` (testes e integrações futuras
 * autorizadas). O executor é exclusivamente o simulado; `REAL_EXECUTION_ENABLED` continua `false`.
 *
 * Garantias:
 * - G1 (nenhuma execução duplicada): todas as operações são serializadas; a intenção de despacho
 *   (token único por tentativa) é GRAVADA antes de chamar o executor, que é idempotente por token;
 *   após reinício nada é redespachado (`dispatching`/`running` → `interrupted`); resultado incerto
 *   nunca é reintentado.
 * - G2 (limites preservados): o ledger da fila é a única fonte persistente (Q1); o controlador é
 *   reconstruído dele (`restore`) e qualquer divergência bloqueia e aciona a barreira global (Q2);
 *   vaga só é liberada com término comprovado (Q8); custo desconhecido continua contando.
 * - G3 (nenhuma retomada não autorizada): terminais são imutáveis; revogados/cancelados/interrompidos
 *   nunca são reintentados; reintento só por item SUCESSOR, com nova admissão e novas aprovações, e
 *   só com comprovação de não início (Q6).
 */

export interface QueueSchedulerOptions {
  store: QueueStore;
  gate: BarrierGate;
  admission: AdmissionPort;
  executor: ExecutorPort;
  tasks: TaskLookup;
  now?: () => number;
  generateId?: () => string;
  /** Itens avaliados por ciclo (padrão 8). */
  maxPerTick?: number;
}

export interface SubmitInput {
  idempotencyKey: string;
  projectId: string;
  taskId: string;
  agentId: string;
  priority: string;
  admission: QueueAdmissionParams;
  execution: { [key: string]: JsonValue };
}

export interface TickReport {
  ran: boolean;
  blocked: string | null;
  expired: string[];
  admitted: string[];
  dispatched: string[];
  refused: Array<{ itemId: string; code: string; class: 'definitive' | 'recoverable' }>;
  retried: string[];
  interrupted: string[];
  cancelRequested: string[];
}

/**
 * Recibo de `onResult` — distingue as três situações (revisão final do PR 2):
 * - `accepted: true`  → desfecho GRAVADO no ledger E liquidado no controlador (`settled`);
 * - `accepted: false` + `persisted: true` → desfecho gravado (fonte de verdade), mas a liquidação
 *   ficou `pending` (falhou) ou `divergent` (custo diferente); o agendador está bloqueado e a vaga
 *   continua ocupada no controlador até o reinício reconstruí-lo do ledger;
 * - `accepted: false` + `persisted: false` → nada gravado nem liquidado (ignorado ou adiado).
 */
export interface ResultReceipt {
  accepted: boolean;
  reason: string;
  persisted: boolean;
  settlement: 'settled' | 'pending' | 'divergent' | 'not_applicable';
}

export interface QueueScheduler {
  restore(): Promise<{ restored: boolean; reason: string | null }>;
  status(): { restored: boolean; blocked: string | null };
  submit(ownerId: string, raw: unknown): Promise<Readonly<QueueItem>>;
  tick(): Promise<TickReport>;
  cancel(ownerId: string, projectId: string, itemId: string): Promise<Readonly<QueueItem>>;
  onResult(raw: unknown): Promise<ResultReceipt>;
  /** Itens cujo desfecho está gravado mas cuja liquidação no controlador falhou ou divergiu. */
  pendingSettlements(): ReadonlyArray<{ itemId: string; settlement: 'pending' | 'divergent' }>;
  engageKillSwitch(scope: BarrierScope, reason: string): Promise<{ durable: boolean; revoked: string[]; cancellationRequested: string[] }>;
  get(ownerId: string, projectId: string, itemId: string): Readonly<QueueItem> | null;
  list(ownerId: string, projectId: string): ReadonlyArray<Readonly<QueueItem>>;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SUBMIT_FIELDS = ['idempotencyKey', 'projectId', 'taskId', 'agentId', 'priority', 'admission', 'execution'];
const safeReason = (code: unknown, fallback: string) => (typeof code === 'string' && REASON.test(code) ? code : fallback);
const codeOf = (error: unknown, fallback: string) => safeReason((error as { code?: unknown })?.code, fallback);
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function parseSubmit(raw: unknown): SubmitInput {
  if (!isPlain(raw) || Object.keys(raw).length !== SUBMIT_FIELDS.length || !SUBMIT_FIELDS.every((k) => Object.hasOwn(raw, k))) throw new QueueError('invalid_request');
  const r = raw as Record<string, unknown>;
  if (typeof r.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(r.idempotencyKey) || r.idempotencyKey.startsWith('retry:')) throw new QueueError('invalid_idempotency_key');
  if (typeof r.projectId !== 'string' || !UUID.test(r.projectId) || typeof r.taskId !== 'string' || !UUID.test(r.taskId)) throw new QueueError('invalid_request');
  if (!(QUEUE_AGENTS as readonly unknown[]).includes(r.agentId) || !(QUEUE_PRIORITIES as readonly unknown[]).includes(r.priority)) throw new QueueError('invalid_request');
  try {
    checkAdmissionParams(r.admission);
    checkExecutionParams(r.execution);
  } catch (error) {
    if (error instanceof QueueDocumentError) throw new QueueError('invalid_request');
    throw error;
  }
  // Cópia própria (nada do chamador fica referenciado).
  return structuredClone(r) as unknown as SubmitInput;
}

/**
 * Custo liquidado, calculado PELA FILA antes de gravar (R1): a mesma regra conservadora do
 * controlador (#022) — confirmado pelo provedor → confirmado; desconhecido, API cobrada ou reserva
 * estimada → `unknown` com a reserva inteira (nunca descartada); só `none` continua `none`.
 */
export function settledCost(reserved: AdmissionSnapshot['cost'], mode: string, usage: ExecutionUsage): AdmissionSnapshot['cost'] {
  if (usage.cost.kind === 'confirmed') return { status: 'confirmed', reservedMinor: reserved.reservedMinor, confirmedMinor: usage.cost.amountMinor };
  if (reserved.status === 'confirmed') return { ...reserved };
  if (usage.cost.kind === 'unknown' || mode === 'metered_api' || reserved.status !== 'none') return { status: 'unknown', reservedMinor: reserved.reservedMinor, confirmedMinor: null };
  return { status: 'none', reservedMinor: 0, confirmedMinor: null };
}

/**
 * Bloqueios em que um resultado AINDA pode ser reconciliado (R2): o controlador continua confiável.
 * Qualquer outro bloqueio do agendador (divergência, falha de gravação ou de liquidação, admissão
 * incerta) adia o resultado: nada é gravado nem liquidado.
 */
const RESULT_SAFE_BLOCKS: ReadonlySet<string> = new Set(['limits_changed_unpersisted']);

export function createQueueScheduler(options: QueueSchedulerOptions): QueueScheduler {
  const { store, gate, admission, executor, tasks } = options;
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;
  const maxPerTick = options.maxPerTick ?? 8;
  const iso = (ms = now()) => new Date(ms).toISOString();

  let restored = false;
  let blockedReason: string | null = null;
  let baselineLimits: string | null = null;
  let ticking = false;
  /** Kill switch acionado NESTA instância: bloqueia imediatamente, antes de qualquer `await`. */
  const localKill = new Set<string>();
  /** Liquidações incompletas desta sessão (o ledger já tem o desfecho). Nunca são refeitas sozinhas. */
  const unsettled = new Map<string, 'pending' | 'divergent'>();
  /** Último motivo de recusa registrado por item (o histórico só recebe mudanças). */
  const lastRefusal = new Map<string, string>();

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(task: () => Promise<R>): Promise<R> => {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  };

  const entry = (data: Partial<QueueHistoryData> & Pick<QueueHistoryData, 'event'>): QueueHistoryData => ({
    actor: QUEUE_SYSTEM_ACTOR,
    itemId: null,
    projectId: null,
    from: null,
    to: null,
    reason: null,
    detail: null,
    ...data,
  });
  const subjectOf = (item: Readonly<QueueItem>): QueueSubject => ({ itemId: item.id, ownerId: item.ownerId, projectId: item.projectId, taskId: item.taskId, agentId: item.agentId });
  const current = (id: string) => store.items().find((i) => i.id === id) ?? null;
  /** Carimbo que nunca faz `updatedAt` regredir (relógio atrasado). */
  const stamp = (item: QueueItem) => (Date.parse(item.updatedAt) > now() ? item.updatedAt : iso());
  const inScope = (scope: BarrierScope, item: Readonly<QueueItem>) => scope.kind === 'global' || item.projectId === scope.projectId;

  /** Bloqueado para admitir/despachar neste projeto? Qualquer fonte basta; erro = bloqueado. */
  function blockedFor(projectId: string): string | null {
    try {
      if (localKill.has('global') || localKill.has(`project:${projectId}`)) return 'kill_switch_engaged';
      const decision = gate.check(projectId);
      if (!decision.open) return decision.reason;
      if (admission.killSwitchEngaged(null) || admission.killSwitchEngaged(projectId)) return 'controller_kill_switch';
      return null;
    } catch {
      return 'query_failed';
    }
  }

  function txItem(tx: QueueTransaction, id: string): QueueItem {
    const item = tx.body.items.find((i) => i.id === id);
    if (!item) throw new QueueError('not_found');
    return item;
  }

  /** Transição dentro da transação (época, carimbo, encerramento, histórico). */
  function move(tx: QueueTransaction, item: QueueItem, to: QueueItemState, reason: string, patch: Partial<QueueRun> = {}, detail: string | null = null) {
    const from = item.state;
    const at = stamp(item);
    item.state = to;
    item.reason = reason;
    item.updatedAt = at;
    item.stateEpoch = tx.epoch;
    if (isTerminal(to)) item.closedAt = at;
    if (item.run) Object.assign(item.run, patch);
    tx.append(entry({ event: 'queue.item_transition', itemId: item.id, projectId: item.projectId, from, to, reason, detail }));
  }

  const outcome = (kind: QueueOutcome['kind'], reason: string, retryable = false): QueueOutcome => ({ kind, reason: safeReason(reason, 'unspecified'), retryable: kind === 'not_started' && retryable, at: iso() });

  function assertStore() {
    const status = store.status();
    if (status.state !== 'available') throw new QueueError(`store_${status.state}`);
  }

  /** Bloqueia o agendador (o primeiro motivo prevalece) e registra no histórico, se possível. */
  async function block(reason: string, itemId: string | null = null, projectId: string | null = null) {
    blockedReason = blockedReason ?? reason;
    await store.commit((tx) => tx.append(entry({ event: 'queue.settlement_divergence', itemId, projectId, reason }))).catch(() => undefined);
  }

  /**
   * Liquidação DURÁVEL (R1). Ordem: 1) o ledger grava o desfecho, a vaga liberada e o custo
   * conservador; 2) só então o controlador é liquidado; 3) o custo do controlador é conferido.
   * - Falha na gravação: o controlador NÃO é tocado (vaga continua ocupada), o agendador bloqueia
   *   e o erro sobe. No disco o item continua como estava (reinício → `interrupted`, vaga ocupada).
   * - Falha ou divergência na liquidação: o ledger (fonte de verdade) já registra o desfecho; o
   *   controlador fica com a vaga OCUPADA (mais restritivo) e o agendador bloqueia nesta sessão —
   *   nenhuma vaga é reutilizada. No reinício o controlador é reconstruído do ledger.
   * - Liquidação repetida é idempotente no adaptador (vaga já liberada → nada muda).
   */
  async function settleDurably(
    id: string,
    kind: 'completed' | 'failed' | 'stopped',
    usage: ExecutionUsage,
    write: (tx: QueueTransaction, it: QueueItem, cost: AdmissionSnapshot['cost']) => void,
  ): Promise<'settled' | 'pending' | 'divergent'> {
    const item = current(id)!;
    const snapshot = item.run!.admission!;
    const cost = settledCost(snapshot.cost, item.run!.request.admission.mode, usage);
    try {
      await store.commit((tx) => write(tx, txItem(tx, id), cost));
    } catch (error) {
      await block('persist_failed', id, item.projectId);
      throw error;
    }
    let settled: AdmissionSnapshot['cost'];
    try {
      settled = admission.settle(subjectOf(item), snapshot.admissionId, kind, usage);
    } catch {
      unsettled.set(id, 'pending');
      await block('settlement_failed', id, item.projectId);
      return 'pending';
    }
    // Divergência = o que conta no orçamento difere (exposição, mesma regra do controlador:
    // confirmado → valor confirmado; senão → reserva) ou só um dos lados está confirmado.
    // `none` × `unknown` com a mesma exposição não é divergência: o ledger guarda o mais conservador
    // e é dele que o controlador é reconstruído no reinício.
    const exposure = (c: AdmissionSnapshot['cost']) => (c.status === 'confirmed' ? (c.confirmedMinor ?? 0) : c.reservedMinor);
    if (exposure(settled) !== exposure(cost) || (settled.status === 'confirmed') !== (cost.status === 'confirmed')) {
      unsettled.set(id, 'divergent');
      await block('settlement_divergence', id, item.projectId);
      return 'divergent';
    }
    return 'settled';
  }

  /** Recibo a partir do desfecho gravado e do estado da liquidação. */
  const receipt = (reason: string, settlement: 'settled' | 'pending' | 'divergent'): ResultReceipt =>
    settlement === 'settled'
      ? { accepted: true, reason, persisted: true, settlement }
      : { accepted: false, reason: settlement === 'pending' ? 'settlement_failed' : 'settlement_divergence', persisted: true, settlement };

  // ---------- Restauração (Q1/Q2) ----------

  async function blockForDivergence(reason: string) {
    blockedReason = reason;
    await store.commit((tx) => tx.append(entry({ event: 'queue.restore_blocked', reason }))).catch(() => undefined);
    // Divergência relevante: barreira global durável (Q2). Falha aqui mantém tudo bloqueado.
    await gate.engage({ kind: 'global' }, 'queue_restore_divergence').catch(() => undefined);
  }

  async function restoreNow() {
    if (restored) return { restored: true, reason: null };
    if (blockedReason) return { restored: false, reason: blockedReason };
    const status = store.status();
    if (status.state !== 'available') return { restored: false, reason: `store_${status.state}` };
    let baseline: string;
    try {
      baseline = admission.limitsFingerprint();
    } catch {
      await blockForDivergence('limits_unavailable');
      return { restored: false, reason: 'limits_unavailable' };
    }
    const problems: string[] = [];
    const records: AdmissionRestoreRecord[] = [];
    // R3: o controlador restaurado nasce com os limites padrão. Só é aceito se houver EVIDÊNCIA
    // durável de que os limites vigentes antes do reinício eram exatamente esses; sem evidência
    // (ou com alteração aplicada para outros valores) → bloqueado, nunca mais permissivo.
    let evidence: ReturnType<AdmissionPort['limitsEvidence']>;
    try {
      evidence = admission.limitsEvidence();
    } catch {
      evidence = { kind: 'unknown' };
    }
    if (evidence.kind === 'unknown') problems.push('limits_evidence_missing');
    else if (evidence.kind === 'last_applied' && evidence.fingerprint !== baseline) problems.push('limits_unproven');
    for (const item of store.items()) {
      if (!item.run) {
        // Item do PR 1 além de `queued`: não há como comprovar vaga nem reserva (Q10) → bloqueia.
        if (item.state !== 'queued' && !isTerminal(item.state)) problems.push('legacy_item_unproven');
        continue;
      }
      // Depois de uma abertura de época não pode haver nada admitido ou em curso.
      if (['admitted', 'dispatching', 'running'].includes(item.state)) problems.push('in_flight_on_restore');
      if (item.run.admission && item.run.admission.limitsFingerprint !== baseline) problems.push('limits_unproven');
      if (item.run.admission || item.run.admissionIntentAt) {
        records.push({
          ...subjectOf(item),
          state: item.state,
          params: structuredClone(item.run.request.admission),
          snapshot: item.run.admission ? structuredClone(item.run.admission) : null,
          intentAt: item.run.admissionIntentAt,
          capacity: item.run.capacity,
          closedAt: item.closedAt,
          cancellation: item.run.cancellation ? { ...item.run.cancellation } : null,
        });
      }
    }
    if (problems.length === 0) {
      try {
        admission.restore(records);
      } catch {
        problems.push('controller_restore_failed');
      }
    }
    if (problems.length > 0) {
      await blockForDivergence(problems[0]);
      return { restored: false, reason: problems[0] };
    }
    baselineLimits = baseline;
    restored = true;
    const held = records.filter((r) => r.capacity === 'held').length;
    await store.commit((tx) => tx.append(entry({ event: 'queue.restore_completed', reason: 'restored', detail: `admissions ${records.length} held ${held}` }))).catch(() => undefined);
    return { restored: true, reason: null };
  }

  // ---------- Submissão ----------

  async function submitNow(ownerId: string, raw: unknown) {
    assertStore();
    if (typeof ownerId !== 'string' || !ACTOR_ID.test(ownerId)) throw new QueueError('invalid_identity');
    const input = parseSubmit(raw);
    const fingerprint = sha256Hex(
      canonicalJson({ projectId: input.projectId, taskId: input.taskId, agentId: input.agentId, priority: input.priority, admission: input.admission, execution: input.execution }),
    );
    const existing = store.items().find((i) => i.ownerId === ownerId && i.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (!existing.run || existing.run.request.fingerprint !== fingerprint) throw new QueueError('idempotency_conflict');
      return existing;
    }
    const lookup = tasks.check({ ownerId, projectId: input.projectId, taskId: input.taskId, agentId: input.agentId });
    if (lookup !== 'ok') throw new QueueError(lookup);
    const admissionCheck = admission.validate(input.admission);
    if (!admissionCheck.ok) throw new QueueError(safeReason(admissionCheck.code, 'invalid_params'));
    const executionCheck = executor.validate({ ownerId, projectId: input.projectId, taskId: input.taskId, agentId: input.agentId }, input.execution);
    if (!executionCheck.ok) throw new QueueError(safeReason(executionCheck.code, 'invalid_params'));
    // Bloqueado (kill switch, barreira, autoridade): nada novo entra na fila.
    if (blockedFor(input.projectId)) throw new QueueError('execution_blocked');
    const id = generateId();
    const at = now();
    await store.commit((tx) => {
      if (tx.body.items.some((i) => i.ownerId === ownerId && i.idempotencyKey === input.idempotencyKey)) throw new QueueError('idempotency_conflict');
      tx.body.items.push({
        id,
        idempotencyKey: input.idempotencyKey,
        ownerId,
        projectId: input.projectId,
        taskId: input.taskId,
        agentId: input.agentId as QueueItem['agentId'],
        priority: input.priority as QueueItem['priority'],
        state: 'queued',
        attempt: 0,
        approvalId: null,
        createdAt: iso(at),
        updatedAt: iso(at),
        stateEpoch: tx.epoch,
        reason: null,
        closedAt: null,
        run: {
          version: 1,
          request: { fingerprint, admission: input.admission, execution: input.execution },
          expiresAt: iso(at + QUEUE_TTL_MS),
          notBefore: null,
          retryOf: null,
          chainAttempt: 1,
          admissionIntentAt: null,
          admission: null,
          dispatch: null,
          cancellation: null,
          capacity: 'none',
          outcome: null,
        },
      });
      tx.append(entry({ event: 'queue.item_submitted', itemId: id, projectId: input.projectId, to: 'queued', reason: 'submitted' }));
    });
    return current(id)!;
  }

  // ---------- Ciclo ----------

  const emptyReport = (): TickReport => ({ ran: true, blocked: null, expired: [], admitted: [], dispatched: [], refused: [], retried: [], interrupted: [], cancelRequested: [] });

  const discard = async (item: Readonly<QueueItem>) => {
    await executor.discard(subjectOf(item)).catch(() => undefined);
  };

  /** Expirações (Q9): só restringem, então rodam mesmo com a fila bloqueada. */
  async function sweepExpired(report: TickReport) {
    for (const item of store.items()) {
      const t = now();
      if (item.state === 'queued') {
        const deadline = item.run ? Date.parse(item.run.expiresAt) : Date.parse(item.createdAt) + QUEUE_TTL_MS;
        if (t < deadline) continue;
        await store.commit((tx) => {
          const it = txItem(tx, item.id);
          if (it.state === 'queued') move(tx, it, 'expired', item.run ? 'ttl_expired' : 'legacy_ttl_expired');
        });
        report.expired.push(item.id);
        await discard(item);
      } else if (item.state === 'admitted' && item.run?.admission && t >= Date.parse(item.run.admission.dispatchBy)) {
        // Admitido e nunca despachado (sem intenção gravada): a reserva pode ser liberada.
        await store.commit((tx) => {
          const it = txItem(tx, item.id);
          if (it.state === 'admitted') move(tx, it, 'expired', 'dispatch_window_expired', { capacity: 'released', outcome: outcome('not_dispatched', 'dispatch_window_expired') });
        });
        await admission.releaseNotDispatched(subjectOf(item), item.run.admission.admissionId).catch(() => undefined);
        report.expired.push(item.id);
        await discard(item);
      }
    }
  }

  /** Execução além do prazo: pede cancelamento; a vaga continua ocupada até a parada (Q9). */
  async function sweepOverdue(report: TickReport) {
    for (const item of store.items()) {
      if (item.state !== 'running' || !item.run?.admission || item.run.cancellation !== null) continue;
      if (now() < Date.parse(item.run.admission.deadline)) continue;
      await requestCancellation(item.id, 'duration_exceeded', 'failed');
      report.cancelRequested.push(item.id);
    }
  }

  async function recordRefusal(item: Readonly<QueueItem>, rawCode: string, report: TickReport): Promise<'next' | 'stop'> {
    const code = safeReason(rawCode, 'unclassified_refusal');
    const cls = classifyRefusal(code);
    report.refused.push({ itemId: item.id, code, class: cls });
    if (cls === 'definitive') {
      await store.commit((tx) => {
        const it = txItem(tx, item.id);
        if (it.state !== 'queued') return;
        move(tx, it, 'failed', code, { outcome: outcome('refused_definitive', code) });
        tx.append(entry({ event: 'queue.admission_refused', itemId: it.id, projectId: it.projectId, reason: code, detail: 'class definitive' }));
      });
      lastRefusal.delete(item.id);
      await discard(item);
      return 'next';
    }
    if (lastRefusal.get(item.id) !== code) {
      lastRefusal.set(item.id, code);
      await store.commit((tx) => tx.append(entry({ event: 'queue.admission_refused', itemId: item.id, projectId: item.projectId, reason: code, detail: 'class recoverable' }))).catch(() => undefined);
    }
    return GLOBAL_REFUSALS.has(code) ? 'stop' : 'next';
  }

  async function admitCandidate(id: string, report: TickReport): Promise<'next' | 'stop'> {
    const item = current(id);
    if (!item || item.state !== 'queued' || !item.run) return 'next';
    if (blockedFor(item.projectId)) return 'next';
    const subject = subjectOf(item);

    // 1) Aprovação PRÓPRIA da execução (`sandbox.execute`), no executor simulado (Q3).
    let prep: Awaited<ReturnType<ExecutorPort['prepare']>>;
    try {
      prep = await executor.prepare(subject, structuredClone(item.run.request.execution));
    } catch (error) {
      prep = { status: 'pending', code: codeOf(error, 'executor_unavailable') };
    }
    if (prep.status !== 'ready') return recordRefusal(item, prep.code, report);
    if (blockedFor(item.projectId)) return 'next';

    // 2) Intenção de admissão GRAVADA antes de chamar o controlador (contabilizada no reinício).
    try {
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state !== 'queued' || !it.run || it.run.admissionIntentAt !== null) throw new QueueError('admission_in_progress');
        it.run.admissionIntentAt = iso();
        it.updatedAt = stamp(it);
      });
    } catch {
      return 'next';
    }

    // 3) Admissão com a aprovação do controlador (Q3).
    let result: Awaited<ReturnType<AdmissionPort['admit']>>;
    try {
      result = await admission.admit({ ...subject, key: item.id, params: structuredClone(item.run.request.admission) });
    } catch {
      // Erro inesperado: a admissão PODE ter acontecido → a intenção fica gravada e o agendador
      // bloqueia (no reinício o item expira e a intenção conta nos limites).
      blockedReason = 'admission_uncertain';
      return 'stop';
    }
    if (!result.ok) {
      // O adaptador só devolve recusa quando NENHUMA admissão existe para a chave.
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state === 'queued' && it.run) {
          it.run.admissionIntentAt = null;
          it.updatedAt = stamp(it);
        }
      });
      return recordRefusal(current(id)!, result.code, report);
    }

    const draft = result.draft;
    const fingerprintOk = draft.limitsFingerprint === baselineLimits;
    if (draft.approvalIds.length === 0 || !fingerprintOk) {
      // Admissão sem aprovação própria, ou com limites diferentes dos restaurados: desfaz (nunca
      // despachada) e encerra o item; limites divergentes também bloqueiam o agendador (Q2).
      await admission.releaseNotDispatched(subject, draft.admissionId).catch(() => undefined);
      if (!fingerprintOk) blockedReason = 'limits_changed_unpersisted';
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state === 'queued') move(tx, it, 'failed', fingerprintOk ? 'admission_without_approval' : 'limits_unproven', { outcome: outcome('refused_definitive', fingerprintOk ? 'admission_without_approval' : 'limits_unproven') });
      });
      return 'stop';
    }
    try {
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state !== 'queued' || !it.run) throw new QueueError('invalid_transition');
        it.approvalId = draft.approvalIds[0];
        move(tx, it, 'admitted', 'admitted', {
          admission: { ...structuredClone(draft), dispatchBy: iso(Date.parse(draft.admittedAt) + ADMITTED_WINDOW_MS) },
          capacity: 'held',
        });
      });
    } catch {
      // A reserva existe no controlador e não foi gravada: bloqueia (a vaga continua ocupada).
      blockedReason = 'persist_failed';
      return 'stop';
    }
    lastRefusal.delete(id);
    report.admitted.push(id);
    return dispatchAdmitted(id, report);
  }

  async function dispatchAdmitted(id: string, report: TickReport): Promise<'next' | 'stop'> {
    const item = current(id);
    if (!item || item.state !== 'admitted' || !item.run?.admission) return 'next';
    if (now() >= Date.parse(item.run.admission.dispatchBy)) return 'next'; // expira no próximo ciclo
    // Bloqueado: continua `admitted`; a janela de 60 s expira e libera a reserva.
    if (blockedFor(item.projectId)) return 'next';
    const token = generateId();
    // Intenção de despacho GRAVADA antes do executor (G1).
    try {
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state !== 'admitted' || !it.run || it.run.dispatch !== null) throw new QueueError('invalid_transition');
        it.attempt += 1;
        move(tx, it, 'dispatching', 'dispatch_intent', { dispatch: { token, at: iso(), epoch: tx.epoch, startedAt: null, executionRef: null } });
        tx.append(entry({ event: 'queue.dispatch_intent', itemId: id, projectId: it.projectId, reason: 'dispatch_intent', detail: `attempt ${it.attempt} epoch ${tx.epoch}` }));
      });
    } catch {
      return 'next';
    }
    const dispatched = current(id)!;
    const subject = subjectOf(dispatched);
    const admissionId = dispatched.run!.admission!.admissionId;

    // Última verificação imediatamente antes do executor: bloqueado → comprovadamente não iniciado.
    const late = blockedFor(dispatched.projectId);
    if (late) {
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state === 'dispatching') move(tx, it, 'failed', 'blocked_before_dispatch', { capacity: 'released', outcome: outcome('not_started', 'blocked_before_dispatch') });
      });
      await admission.releaseNotDispatched(subject, admissionId).catch(() => undefined);
      await discard(dispatched);
      return 'next';
    }

    let result: Awaited<ReturnType<ExecutorPort['dispatch']>>;
    try {
      result = await executor.dispatch({ ...subject, token, attempt: dispatched.attempt, epoch: dispatched.run!.dispatch!.epoch });
    } catch (error) {
      result = { kind: 'uncertain', code: codeOf(error, 'executor_error') };
    }
    try {
      if (result.kind === 'started') {
        const ref = typeof result.executionRef === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result.executionRef) ? result.executionRef : 'unknown_ref';
        await store.commit((tx) => {
          const it = txItem(tx, id);
          if (it.state !== 'dispatching') throw new QueueError('invalid_transition');
          move(tx, it, 'running', 'started', { dispatch: { ...it.run!.dispatch!, startedAt: iso(), executionRef: ref } });
        });
        report.dispatched.push(id);
        return 'next';
      }
      if (result.kind === 'not_started') {
        const code = safeReason(result.code, 'not_started');
        const chain = dispatched.run!.chainAttempt;
        const retry = result.retryable === true && chain < MAX_CHAIN_ATTEMPTS;
        const successorId = retry ? generateId() : null;
        await store.commit((tx) => {
          const it = txItem(tx, id);
          if (it.state !== 'dispatching') throw new QueueError('invalid_transition');
          move(tx, it, 'failed', code, { capacity: 'released', outcome: outcome('not_started', code, result.retryable === true) });
          if (successorId) {
            const at = now();
            tx.body.items.push({
              id: successorId,
              idempotencyKey: `retry:${it.id}`,
              ownerId: it.ownerId,
              projectId: it.projectId,
              taskId: it.taskId,
              agentId: it.agentId,
              priority: it.priority,
              state: 'queued',
              attempt: 0,
              approvalId: null,
              createdAt: iso(at),
              updatedAt: iso(at),
              stateEpoch: tx.epoch,
              reason: null,
              closedAt: null,
              run: {
                version: 1,
                request: structuredClone(it.run!.request),
                expiresAt: iso(at + QUEUE_TTL_MS),
                notBefore: iso(at + retryDelayMs(chain + 1)),
                retryOf: it.id,
                chainAttempt: chain + 1,
                admissionIntentAt: null,
                admission: null,
                dispatch: null,
                cancellation: null,
                capacity: 'none',
                outcome: null,
              },
            });
            tx.append(entry({ event: 'queue.retry_scheduled', itemId: successorId, projectId: it.projectId, to: 'queued', reason: code, detail: `retry of ${it.id} attempt ${chain + 1}` }));
          }
        });
        await admission.releaseNotDispatched(subject, admissionId).catch(() => undefined);
        if (successorId) report.retried.push(successorId);
        return 'next';
      }
      // Incerto (timeout, erro, ausência de resposta): `interrupted`, vaga ocupada, sem reintento.
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (it.state !== 'dispatching') throw new QueueError('invalid_transition');
        move(tx, it, 'interrupted', 'dispatch_uncertain', {}, `code ${safeReason(result.code, 'uncertain')}`);
      });
      report.interrupted.push(id);
      return 'next';
    } catch {
      // O resultado não foi gravado: no disco o item segue `dispatching` (→ `interrupted` no reinício).
      blockedReason = 'persist_failed';
      return 'stop';
    }
  }

  async function tickNow(): Promise<TickReport> {
    const report = emptyReport();
    const status = store.status();
    if (status.state !== 'available') return { ...report, ran: false, blocked: `store_${status.state}` };
    if (!restored) return { ...report, ran: false, blocked: blockedReason ?? 'not_restored' };
    await sweepExpired(report);
    await sweepOverdue(report);
    if (blockedReason) return { ...report, blocked: blockedReason };
    // Q2: limites alterados nesta sessão não têm persistência comprovada → bloqueado.
    let fingerprint: string | null;
    try {
      fingerprint = admission.limitsFingerprint();
    } catch {
      fingerprint = null;
    }
    if (fingerprint !== baselineLimits) {
      blockedReason = 'limits_changed_unpersisted';
      await store.commit((tx) => tx.append(entry({ event: 'queue.restore_blocked', reason: 'limits_changed_unpersisted' }))).catch(() => undefined);
      return { ...report, blocked: blockedReason };
    }
    const globalDecision = gate.check(null);
    if (!globalDecision.open) return { ...report, blocked: globalDecision.reason };
    if (localKill.has('global')) return { ...report, blocked: 'kill_switch_engaged' };
    const t = now();
    const order = new Map(store.items().map((item, index) => [item.id, index]));
    const candidates = store
      .items()
      .filter((i) => i.state === 'queued' && i.run && (i.run.notBefore === null || Date.parse(i.run.notBefore) <= t))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Date.parse(a.createdAt) - Date.parse(b.createdAt) || order.get(a.id)! - order.get(b.id)!);
    // Uma tarefa por vez (dono/projeto/tarefa/agente): o núcleo de aprovações (#011) mantém UM
    // pedido pendente por operação, então dois itens da mesma tarefa se substituiriam a cada ciclo.
    const taskKey = (i: Readonly<QueueItem>) => `${i.ownerId}|${i.projectId}|${i.taskId}|${i.agentId}`;
    // Execução em curso ou incerta da mesma tarefa também a ocupa (nada de execução paralela/duplicada).
    const occupies = (i: Readonly<QueueItem>) => ['admitted', 'dispatching', 'running'].includes(i.state) || (i.state === 'interrupted' && i.run?.capacity !== 'released');
    const busy = new Set(store.items().filter(occupies).map(taskKey));
    let processed = 0;
    for (const candidate of candidates) {
      if (processed >= maxPerTick || blockedReason) break;
      const key = taskKey(candidate);
      if (busy.has(key)) {
        report.refused.push({ itemId: candidate.id, code: 'task_busy', class: 'recoverable' });
        continue;
      }
      busy.add(key);
      processed += 1;
      if ((await admitCandidate(candidate.id, report)) === 'stop') break;
    }
    if (blockedReason) report.blocked = blockedReason;
    return report;
  }

  // ---------- Cancelamento ----------

  /**
   * Pede a parada ao executor. Só `cancelled` (parada CONFIRMADA) encerra o item e libera a vaga;
   * `not_supported`/`failed` ficam registrados e a vaga continua ocupada (Q4/Q8).
   */
  async function requestCancellation(id: string, reason: string, terminal: 'cancelled' | 'revoked' | 'failed'): Promise<string> {
    const item = current(id);
    if (!item || !item.run?.admission || !['dispatching', 'running', 'interrupted'].includes(item.state)) return 'not_applicable';
    if (item.run.capacity !== 'held') return 'already_released';
    await store.commit((tx) => {
      const it = txItem(tx, id);
      it.run!.cancellation = { requestedAt: it.run!.cancellation?.requestedAt ?? iso(), result: 'pending' };
      it.updatedAt = stamp(it);
      tx.append(entry({ event: 'queue.cancel_requested', itemId: id, projectId: it.projectId, reason }));
    });
    let result: 'cancelled' | 'not_supported' | 'failed';
    try {
      result = await executor.cancel(subjectOf(item));
      if (!['cancelled', 'not_supported', 'failed'].includes(result)) result = 'failed';
    } catch {
      result = 'failed';
    }
    const latest = current(id)!;
    if (result === 'cancelled' && latest.run?.capacity === 'held' && !isTerminal(latest.state)) {
      // De `interrupted` para `failed` exigiria desfecho prévio: a parada vira cancelamento.
      const to = latest.state === 'interrupted' && terminal === 'failed' ? 'cancelled' : terminal;
      // Parada sem relato de consumo: custo desconhecido (a reserva continua contando).
      await settleDurably(id, 'stopped', { cost: { kind: 'unknown' }, tokens: null }, (tx, it, cost) => {
        move(tx, it, to, reason, {
          capacity: 'released',
          outcome: it.run!.outcome ?? outcome('stop_confirmed', reason),
          cancellation: { requestedAt: it.run!.cancellation!.requestedAt, result: 'cancelled' },
          admission: { ...it.run!.admission!, cost },
        });
      });
    } else {
      await store.commit((tx) => {
        const it = txItem(tx, id);
        if (isTerminal(it.state) || !it.run?.cancellation) return;
        it.run.cancellation = { requestedAt: it.run.cancellation.requestedAt, result };
        it.updatedAt = stamp(it);
        tx.append(entry({ event: 'queue.cancel_requested', itemId: id, projectId: it.projectId, reason: `cancellation_${result}` }));
      });
    }
    return result;
  }

  /** Encerra um item ainda não despachado (`queued`/`admitted`), liberando a reserva comprovada. */
  async function closeUndispatched(item: Readonly<QueueItem>, to: 'cancelled' | 'revoked', reason: string) {
    const wasAdmitted = item.state === 'admitted';
    await store.commit((tx) => {
      const it = txItem(tx, item.id);
      if (it.state === 'queued') move(tx, it, to, reason);
      else if (it.state === 'admitted') move(tx, it, to, reason, it.run ? { capacity: 'released', outcome: outcome('not_dispatched', reason) } : {});
    });
    if (wasAdmitted && item.run?.admission) await admission.releaseNotDispatched(subjectOf(item), item.run.admission.admissionId).catch(() => undefined);
    lastRefusal.delete(item.id);
    await discard(item);
  }

  async function cancelNow(ownerId: string, projectId: string, itemId: string) {
    assertStore();
    const item = store.items().find((i) => i.id === itemId && i.ownerId === ownerId && i.projectId === projectId);
    if (!item) throw new QueueError('not_found');
    if (isTerminal(item.state)) throw new QueueError('invalid_transition');
    if (item.state === 'queued' || (item.state === 'admitted' && item.run)) {
      await closeUndispatched(item, 'cancelled', 'cancelled_by_user');
    } else if (!item.run) {
      // Item do PR 1 além de `queued`: sem registro de vaga/reserva → exige revisão humana.
      throw new QueueError('legacy_item_requires_review');
    } else {
      await requestCancellation(itemId, 'cancelled_by_user', 'cancelled');
    }
    return current(itemId)!;
  }

  // ---------- Resultados ----------

  function parseResult(raw: unknown): ExecutionResult | null {
    if (!isPlain(raw)) return null;
    const r = raw as Record<string, unknown>;
    const keys = ['itemId', 'token', 'attempt', 'epoch', 'outcome', 'reason', 'usage'];
    if (Object.keys(r).length !== keys.length || !keys.every((k) => Object.hasOwn(r, k))) return null;
    if (typeof r.itemId !== 'string' || !UUID.test(r.itemId) || typeof r.token !== 'string' || !UUID.test(r.token)) return null;
    if (!Number.isSafeInteger(r.attempt) || !Number.isSafeInteger(r.epoch) || (r.outcome !== 'succeeded' && r.outcome !== 'failed')) return null;
    if (!(r.reason === null || (typeof r.reason === 'string' && REASON.test(r.reason)))) return null;
    const usage = r.usage as Record<string, unknown>;
    if (!isPlain(usage) || !(usage.tokens === null || (Number.isSafeInteger(usage.tokens) && (usage.tokens as number) >= 0))) return null;
    const cost = usage.cost as Record<string, unknown>;
    if (!isPlain(cost)) return null;
    if (!(cost.kind === 'none' || cost.kind === 'unknown' || (cost.kind === 'confirmed' && Number.isSafeInteger(cost.amountMinor) && (cost.amountMinor as number) >= 0))) return null;
    return structuredClone(r) as unknown as ExecutionResult;
  }

  async function ignore(item: Readonly<QueueItem> | null, reason: string) {
    await store
      .commit((tx) => tx.append(entry({ event: 'queue.result_ignored', itemId: item?.id ?? null, projectId: item?.projectId ?? null, reason })))
      .catch(() => undefined);
    return { accepted: false, reason, persisted: false, settlement: 'not_applicable' as const };
  }

  async function onResultNow(raw: unknown) {
    assertStore();
    const result = parseResult(raw);
    if (!result) return ignore(null, 'invalid_result');
    const item = current(result.itemId);
    if (!item || !item.run?.dispatch || !item.run.admission) return ignore(null, 'unknown_item');
    const dispatch = item.run.dispatch;
    // Vínculo: token, tentativa e época do despacho gravado.
    if (dispatch.token !== result.token || item.attempt !== result.attempt || dispatch.epoch !== result.epoch) return ignore(item, 'result_mismatch');
    // Repetição do resultado de um item cuja liquidação ficou incompleta: o desfecho já está gravado;
    // nada é regravado nem liquidado de novo (idempotente, bloqueio mantido) e o recibo continua
    // sinalizando a pendência — inclusive com o agendador bloqueado.
    const unresolved = unsettled.get(item.id);
    if (unresolved) {
      await ignore(item, 'settlement_unresolved');
      return { accepted: false, reason: unresolved === 'pending' ? 'settlement_failed' : 'settlement_divergence', persisted: true, settlement: unresolved };
    }
    if (isTerminal(item.state)) return ignore(item, 'late_result');
    // R2: com o controlador fora de confiança (não restaurado ou bloqueio por divergência/falha),
    // o resultado é ADIADO — nada é gravado nem liquidado; a vaga continua ocupada.
    if (!restored) return ignore(item, 'result_deferred_not_restored');
    if (blockedReason !== null && !RESULT_SAFE_BLOCKS.has(blockedReason)) return ignore(item, 'result_deferred_blocked');
    // Consumo informado incoerente com o modo (tokens fora de API cobrada): recusado ANTES de gravar.
    if (item.run.request.admission.mode !== 'metered_api' && result.usage.tokens !== null) return ignore(item, 'invalid_usage');
    // R2/D3: barreira, kill switch ou bloqueio de limites NÃO impedem a reconciliação de uma
    // execução anterior — só registram desfecho e liberam a vaga comprovadamente livre. Nada é
    // despachado, reintentado ou reativado aqui (nenhum caminho de `onResult` cria item ou despacho).
    const barrier = blockedFor(item.projectId);
    const detail = barrier ? `attempt ${item.attempt} under ${barrier}` : `attempt ${item.attempt}`;
    if (item.state === 'running') {
      const reason = result.outcome === 'succeeded' ? 'completed' : safeReason(result.reason, 'executor_reported_failure');
      const settlement = await settleDurably(item.id, result.outcome === 'succeeded' ? 'completed' : 'failed', result.usage, (tx, it, cost) => {
        move(tx, it, result.outcome, reason, {
          capacity: 'released',
          outcome: outcome(result.outcome === 'succeeded' ? 'completed' : 'failed_after_start', reason),
          admission: { ...it.run!.admission!, cost },
        });
        tx.append(entry({ event: 'queue.result_recorded', itemId: it.id, projectId: it.projectId, reason, detail }));
      });
      return receipt(reason, settlement);
    }
    if (item.state === 'interrupted') {
      // Comprovação de término pelo executor (Q8): libera a vaga; o item NÃO volta a executar.
      if (item.run.capacity !== 'held' || item.run.outcome !== null) return ignore(item, 'already_resolved');
      const settlement = await settleDurably(item.id, 'stopped', result.usage, (tx, it, cost) => {
        Object.assign(it.run!, { capacity: 'released', outcome: outcome('ended_after_interruption', `reported_${result.outcome}`), admission: { ...it.run!.admission!, cost } });
        it.updatedAt = stamp(it);
        tx.append(entry({ event: 'queue.capacity_released', itemId: it.id, projectId: it.projectId, reason: 'executor_confirmed_end', detail: `reported ${result.outcome}${barrier ? ` under ${barrier}` : ''}` }));
      });
      return receipt('interrupted_end_recorded', settlement);
    }
    return ignore(item, 'result_before_start');
  }

  // ---------- Kill switch (Q4) ----------

  async function revokeInScope(scope: BarrierScope, reason: string) {
    const revoked: string[] = [];
    const cancellationRequested: string[] = [];
    for (const item of store.items()) {
      if (!inScope(scope, item) || isTerminal(item.state)) continue;
      // Falha num item nunca interrompe a revogação dos demais (o bloqueio já está acionado).
      try {
        if (item.state === 'queued' || (item.state === 'admitted' && item.run)) {
          await closeUndispatched(item, 'revoked', reason);
          revoked.push(item.id);
        } else if (item.run && ['dispatching', 'running', 'interrupted'].includes(item.state)) {
          const result = await requestCancellation(item.id, reason, 'revoked');
          if (current(item.id)?.state === 'revoked') revoked.push(item.id);
          else if (result !== 'not_applicable') cancellationRequested.push(item.id);
        }
      } catch {
        cancellationRequested.push(item.id);
      }
    }
    return { revoked, cancellationRequested };
  }

  return {
    restore: () => serial(restoreNow),
    status: () => ({ restored, blocked: blockedReason }),
    pendingSettlements: () => [...unsettled].map(([itemId, settlement]) => ({ itemId, settlement })),
    submit: (ownerId, raw) => serial(() => submitNow(ownerId, raw)),
    async tick() {
      // Proteção contra ciclos simultâneos: um ciclo por vez; o concorrente não espera nem repete.
      if (ticking) return { ...emptyReport(), ran: false, blocked: 'tick_in_progress' };
      ticking = true;
      try {
        return await serial(tickNow);
      } finally {
        ticking = false;
      }
    },
    cancel: (ownerId, projectId, itemId) => serial(() => cancelNow(ownerId, projectId, itemId)),
    onResult: (raw) => serial(() => onResultNow(raw)),
    async engageKillSwitch(rawScope, rawReason) {
      const scope = parseBarrierScope(rawScope);
      const reason = safeReason(rawReason, 'kill_switch');
      // 1) Bloqueio IMEDIATO (antes de qualquer `await`): nesta instância e no controlador.
      localKill.add(scopeKey(scope));
      const controllerEngaged = Promise.resolve()
        .then(() => admission.engageKillSwitch(scope, reason))
        .catch(() => undefined);
      // 2) Barreira DURÁVEL (pedido gravado na fila + autoridade #011), aguardada.
      const durable = await gate.engage(scope, reason).then(
        (r) => r.durable,
        () => false,
      );
      await controllerEngaged;
      // 3) Revoga o que não começou e pede a parada do que pode estar em curso (serializado).
      return serial(async () => {
        await store
          .commit((tx) => tx.append(entry({ event: 'queue.killswitch_engaged', projectId: scope.kind === 'project' ? scope.projectId : null, reason, detail: `scope ${scope.kind} durable ${durable}` })))
          .catch(() => undefined);
        const outcome = await revokeInScope(scope, reason);
        return { durable, ...outcome };
      });
    },
    get(ownerId, projectId, itemId) {
      return store.items().find((i) => i.id === itemId && i.ownerId === ownerId && i.projectId === projectId) ?? null;
    },
    list(ownerId, projectId) {
      return store.items().filter((i) => i.ownerId === ownerId && i.projectId === projectId);
    },
  };
}
