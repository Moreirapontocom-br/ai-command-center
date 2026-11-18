import { isIsoDate } from '../storage/jsonFile.ts';
import {
  CANCELLATION_RESULTS,
  CAPACITY_STATES,
  COST_STATUSES,
  isTerminal,
  MAX_CHAIN_ATTEMPTS,
  MAX_PENDING_BARRIERS,
  OUTCOME_KINDS,
  QUEUE_HOLDING_STATES,
  QUEUE_TTL_MS,
  MAX_QUEUE_ITEMS,
  QUEUE_AGENTS,
  QUEUE_EVENTS,
  QUEUE_ITEM_STATES,
  QUEUE_PRIORITIES,
  QUEUE_TRANSITIONS,
  scopeKey,
  type BarrierScope,
  type PendingBarrier,
  type QueueBody,
  type QueueHistoryData,
  type QueueItem,
  type QueueRun,
} from './contracts.ts';

/**
 * Validação ESTRITA dos registros persistidos da fila (Issue #012, PR 1). Campo extra, ausente,
 * estado desconhecido ou invariante quebrada → inválido (o armazenamento fica indisponível na
 * abertura; numa alteração, a gravação é recusada). Nada é "corrigido" na leitura.
 */

export class QueueDocumentError extends Error {
  name = 'QueueDocumentError';
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REASON = /^[a-z0-9_]{1,64}$/;
export const ACTOR_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DETAIL = /^[A-Za-z0-9 ._:#/-]{1,200}$/;

const fail = (what: string): never => {
  throw new QueueDocumentError(what);
};
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exactKeys(value: unknown, expected: readonly string[], what: string): Record<string, unknown> {
  if (!isPlain(value)) fail(what);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== expected.length || !expected.every((key) => Object.hasOwn(record, key))) fail(what);
  return record;
}
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositive = (v: unknown): v is number => isCount(v) && v > 0;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isReason = (v: unknown): v is string => typeof v === 'string' && REASON.test(v);

const ITEM_FIELDS = ['id', 'idempotencyKey', 'ownerId', 'projectId', 'taskId', 'agentId', 'priority', 'state', 'attempt', 'approvalId', 'createdAt', 'updatedAt', 'stateEpoch', 'reason', 'closedAt'] as const;

export function checkItem(raw: unknown, index: number): QueueItem {
  const what = `item ${index}`;
  // Q10: documentos do PR 1 não têm `run`; os do PR 2 o têm completo (nunca parcial).
  const i = exactKeys(raw, isPlain(raw) && Object.hasOwn(raw, 'run') ? [...ITEM_FIELDS, 'run'] : ITEM_FIELDS, what);
  if (!isUuid(i.id) || typeof i.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(i.idempotencyKey)) fail(what);
  if (typeof i.ownerId !== 'string' || !ACTOR_ID.test(i.ownerId) || !isUuid(i.projectId) || !isUuid(i.taskId)) fail(what);
  if (!oneOf(QUEUE_AGENTS)(i.agentId) || !oneOf(QUEUE_PRIORITIES)(i.priority) || !oneOf(QUEUE_ITEM_STATES)(i.state)) fail(what);
  if (!isCount(i.attempt) || !(i.approvalId === null || isUuid(i.approvalId))) fail(what);
  if (!isIsoDate(i.createdAt) || !isIsoDate(i.updatedAt) || Date.parse(i.updatedAt as string) < Date.parse(i.createdAt as string)) fail(what);
  if (!isPositive(i.stateEpoch) || !(i.reason === null || isReason(i.reason)) || !(i.closedAt === null || isIsoDate(i.closedAt))) fail(what);
  const item = i as unknown as QueueItem;
  // Invariantes por estado.
  if (isTerminal(item.state) !== (item.closedAt !== null)) fail(what);
  if (item.state !== 'queued' && item.reason === null) fail(what);
  if (['admitted', 'dispatching', 'running', 'interrupted', 'succeeded'].includes(item.state) && item.approvalId === null) fail(what);
  if (['dispatching', 'running', 'interrupted', 'succeeded'].includes(item.state) && item.attempt < 1) fail(what);
  if (['queued', 'admitted'].includes(item.state) && item.attempt !== 0) fail(what);
  if (Object.hasOwn(i, 'run')) checkRunInvariants(item, checkRun(i.run, what), what);
  return item;
}

// ---------- Extensão do PR 2 (`run`) ----------

const HEX64 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^[a-z]{1,16}:[0-9a-f]{64}$/;
const ACTION = /^[a-z]{1,32}\.[a-z_]{1,32}$/;
const MODE = /^[a-z_]{1,32}$/;
const EXEC_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const EXEC_STRING = /^[^\u0000-\u001f\u007f]{0,512}$/;
const EXECUTION_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EXECUTION_BYTES = 8 * 1024;
const isIntIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const isIsoOrNull = (v: unknown) => v === null || isIsoDate(v);
export const RUN_FIELDS = ['version', 'request', 'expiresAt', 'notBefore', 'retryOf', 'chainAttempt', 'admissionIntentAt', 'admission', 'dispatch', 'cancellation', 'capacity', 'outcome'] as const;

/** Parâmetros do executor: JSON simples, limitado em profundidade, tamanho e caracteres. */
export function checkExecutionParams(raw: unknown, what = 'parâmetros de execução'): void {
  const walk = (value: unknown, depth: number) => {
    if (depth > 6) fail(what);
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) fail(what);
      return;
    }
    if (typeof value === 'string') {
      if (!EXEC_STRING.test(value)) fail(what);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 32) fail(what);
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!isPlain(value)) fail(what);
    const keys = Object.keys(value as object);
    if (keys.length > 32 || keys.some((k) => !EXEC_KEY.test(k))) fail(what);
    for (const key of keys) walk((value as Record<string, unknown>)[key], depth + 1);
  };
  if (!isPlain(raw)) fail(what);
  walk(raw, 0);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_EXECUTION_BYTES) fail(what);
}

/** Formato (não a semântica, que é da `AdmissionPort`) dos parâmetros de admissão. */
export function checkAdmissionParams(raw: unknown, what = 'parâmetros de admissão'): void {
  const a = exactKeys(raw, ['action', 'mode', 'durationSeconds', 'estimatedCostMinor', 'maxTokens'], what);
  if (typeof a.action !== 'string' || !ACTION.test(a.action) || typeof a.mode !== 'string' || !MODE.test(a.mode)) fail(what);
  if (!isIntIn(a.durationSeconds, 1, 24 * 60 * 60)) fail(what);
  if (!(a.estimatedCostMinor === null || isIntIn(a.estimatedCostMinor, 0, Number.MAX_SAFE_INTEGER))) fail(what);
  if (!(a.maxTokens === null || isIntIn(a.maxTokens, 1, Number.MAX_SAFE_INTEGER))) fail(what);
}

function checkSnapshot(raw: unknown, what: string) {
  const s = exactKeys(raw, ['admissionId', 'admittedAt', 'deadline', 'dispatchBy', 'approvalIds', 'cost', 'tokensCeiling', 'limitsFingerprint', 'controllerFingerprint'], what);
  if (!isUuid(s.admissionId) || !isIsoDate(s.admittedAt) || !isIsoDate(s.deadline) || !isIsoDate(s.dispatchBy)) fail(what);
  if (time(s.deadline as string) <= time(s.admittedAt as string) || time(s.dispatchBy as string) <= time(s.admittedAt as string)) fail(what);
  const ids = s.approvalIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2 || !ids.every(isUuid) || new Set(ids).size !== ids.length) fail(what);
  const c = exactKeys(s.cost, ['status', 'reservedMinor', 'confirmedMinor'], what);
  if (!oneOf(COST_STATUSES)(c.status) || !isCount(c.reservedMinor) || !(c.confirmedMinor === null || isCount(c.confirmedMinor))) fail(what);
  if ((c.status === 'confirmed') !== (c.confirmedMinor !== null)) fail(what);
  if (c.status === 'none' && c.reservedMinor !== 0) fail(what);
  if (!(s.tokensCeiling === null || isPositive(s.tokensCeiling))) fail(what);
  if (typeof s.limitsFingerprint !== 'string' || !FINGERPRINT.test(s.limitsFingerprint)) fail(what);
  if (typeof s.controllerFingerprint !== 'string' || !HEX64.test(s.controllerFingerprint)) fail(what);
}

export function checkRun(raw: unknown, what: string): QueueRun {
  const r = exactKeys(raw, RUN_FIELDS, what);
  if (r.version !== 1) fail(what);
  const req = exactKeys(r.request, ['fingerprint', 'admission', 'execution'], what);
  if (typeof req.fingerprint !== 'string' || !HEX64.test(req.fingerprint)) fail(what);
  checkAdmissionParams(req.admission, what);
  checkExecutionParams(req.execution, what);
  if (!isIsoDate(r.expiresAt) || !isIsoOrNull(r.notBefore) || !(r.retryOf === null || isUuid(r.retryOf))) fail(what);
  if (!isIntIn(r.chainAttempt, 1, MAX_CHAIN_ATTEMPTS) || (r.retryOf === null) !== (r.chainAttempt === 1)) fail(what);
  if (!isIsoOrNull(r.admissionIntentAt)) fail(what);
  if (r.admission !== null) checkSnapshot(r.admission, what);
  if (r.dispatch !== null) {
    const d = exactKeys(r.dispatch, ['token', 'at', 'epoch', 'startedAt', 'executionRef'], what);
    if (!isUuid(d.token) || !isIsoDate(d.at) || !isPositive(d.epoch) || !isIsoOrNull(d.startedAt)) fail(what);
    if (!(d.executionRef === null || (typeof d.executionRef === 'string' && EXECUTION_REF.test(d.executionRef)))) fail(what);
    if ((d.startedAt === null) !== (d.executionRef === null)) fail(what);
  }
  if (r.cancellation !== null) {
    const c = exactKeys(r.cancellation, ['requestedAt', 'result'], what);
    if (!isIsoDate(c.requestedAt) || !oneOf(CANCELLATION_RESULTS)(c.result)) fail(what);
  }
  if (!oneOf(CAPACITY_STATES)(r.capacity)) fail(what);
  if (r.outcome !== null) {
    const o = exactKeys(r.outcome, ['kind', 'reason', 'retryable', 'at'], what);
    if (!oneOf(OUTCOME_KINDS)(o.kind) || !isReason(o.reason) || typeof o.retryable !== 'boolean' || !isIsoDate(o.at)) fail(what);
    if (o.retryable && o.kind !== 'not_started') fail(what);
  }
  return r as unknown as QueueRun;
}

/** Coerência entre estado do item e extensão (vaga, reserva, despacho, desfecho). */
function checkRunInvariants(item: QueueItem, run: QueueRun, what: string) {
  const created = time(item.createdAt);
  if (time(run.expiresAt) <= created || time(run.expiresAt) - created > QUEUE_TTL_MS) fail(what);
  if (run.notBefore !== null && time(run.notBefore) < created) fail(what);
  const holding = QUEUE_HOLDING_STATES.includes(item.state);
  if (run.capacity === 'held' && (!holding || run.admission === null)) fail(what);
  if (['admitted', 'dispatching', 'running'].includes(item.state) && (run.capacity !== 'held' || run.admission === null)) fail(what);
  if (item.state === 'queued' && (run.admission !== null || run.dispatch !== null || run.capacity !== 'none' || run.outcome !== null || run.cancellation !== null)) fail(what);
  if (['dispatching', 'running', 'interrupted'].includes(item.state) && run.dispatch === null) fail(what);
  if (item.state === 'dispatching' && run.dispatch!.startedAt !== null) fail(what);
  if (item.state === 'running' && run.dispatch!.startedAt === null) fail(what);
  if (run.dispatch !== null && (run.admission === null || item.attempt < 1)) fail(what);
  if (run.admission !== null && item.approvalId !== run.admission.approvalIds[0]) fail(what);
  if (run.admission === null && item.approvalId !== null) fail(what);
  if (isTerminal(item.state) && run.capacity === 'held') fail(what);
  if (run.capacity === 'none' && run.admission !== null) fail(what);
  if (item.state === 'failed' && run.outcome === null) fail(what);
}

/** Relações entre itens: reintentos, aprovações, admissões e tokens nunca reutilizados. */
function checkRunRelations(items: QueueItem[]) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const successors = new Set<string>();
  const approvals = new Set<string>();
  const admissions = new Set<string>();
  const tokens = new Set<string>();
  for (const item of items) {
    const run = item.run;
    if (!run) continue;
    if (run.admission) {
      if (admissions.has(run.admission.admissionId)) fail('admissão reutilizada');
      admissions.add(run.admission.admissionId);
      for (const id of run.admission.approvalIds) {
        if (approvals.has(id)) fail('aprovação reutilizada');
        approvals.add(id);
      }
    }
    if (run.dispatch) {
      if (tokens.has(run.dispatch.token)) fail('token de despacho reutilizado');
      tokens.add(run.dispatch.token);
    }
    if (run.retryOf === null) continue;
    const previous = byId.get(run.retryOf);
    if (!previous || !previous.run || successors.has(previous.id)) fail('reintento inválido');
    successors.add(previous!.id);
    const prev = previous!.run!;
    const same = previous!.ownerId === item.ownerId && previous!.projectId === item.projectId && previous!.taskId === item.taskId && previous!.agentId === item.agentId;
    if (!same || prev.request.fingerprint !== run.request.fingerprint || run.chainAttempt !== prev.chainAttempt + 1) fail('reintento inválido');
    if (previous!.state !== 'failed' || prev.outcome?.kind !== 'not_started' || !prev.outcome.retryable) fail('reintento sem comprovação de não início');
  }
}

function checkScope(raw: unknown, what: string): BarrierScope {
  if (isPlain(raw) && raw.kind === 'global') {
    exactKeys(raw, ['kind'], what);
    return { kind: 'global' };
  }
  const s = exactKeys(raw, ['kind', 'projectId'], what);
  if (s.kind !== 'project' || !isUuid(s.projectId)) fail(what);
  return { kind: 'project', projectId: s.projectId as string };
}

function checkPendingBarrier(raw: unknown, index: number): PendingBarrier {
  const what = `barreira pendente ${index}`;
  const b = exactKeys(raw, ['scope', 'reason', 'requestedAt', 'epoch'], what);
  const scope = checkScope(b.scope, what);
  if (!isReason(b.reason) || !isIsoDate(b.requestedAt) || !isPositive(b.epoch)) fail(what);
  return { scope, reason: b.reason as string, requestedAt: b.requestedAt as string, epoch: b.epoch as number };
}

export function checkQueueBody(raw: unknown): QueueBody {
  const body = exactKeys(raw, ['items', 'pendingBarriers'], 'corpo da fila');
  if (!Array.isArray(body.items) || !Array.isArray(body.pendingBarriers)) fail('corpo da fila');
  const items = (body.items as unknown[]).map(checkItem);
  const pendingBarriers = (body.pendingBarriers as unknown[]).map(checkPendingBarrier);
  if (items.length > MAX_QUEUE_ITEMS) fail('itens demais');
  if (pendingBarriers.length > MAX_PENDING_BARRIERS) fail('barreiras pendentes demais');
  if (new Set(items.map((i) => i.id)).size !== items.length) fail('itens duplicados');
  if (new Set(items.map((i) => `${i.ownerId}\n${i.idempotencyKey}`)).size !== items.length) fail('idempotência duplicada');
  if (new Set(pendingBarriers.map((b) => scopeKey(b.scope))).size !== pendingBarriers.length) fail('barreiras pendentes duplicadas');
  checkRunRelations(items);
  return { items, pendingBarriers };
}

export function checkQueueEntry(raw: unknown): QueueHistoryData {
  const e = exactKeys(raw, ['event', 'actor', 'itemId', 'projectId', 'from', 'to', 'reason', 'detail'], 'entrada');
  if (!oneOf(QUEUE_EVENTS)(e.event)) fail('entrada');
  const actor = exactKeys(e.actor, ['kind', 'id'], 'entrada');
  if ((actor.kind !== 'human' && actor.kind !== 'system') || typeof actor.id !== 'string' || !ACTOR_ID.test(actor.id)) fail('entrada');
  if (!(e.itemId === null || isUuid(e.itemId)) || !(e.projectId === null || isUuid(e.projectId))) fail('entrada');
  if (!(e.from === null || oneOf(QUEUE_ITEM_STATES)(e.from)) || !(e.to === null || oneOf(QUEUE_ITEM_STATES)(e.to))) fail('entrada');
  if (!(e.reason === null || isReason(e.reason)) || !(e.detail === null || (typeof e.detail === 'string' && DETAIL.test(e.detail)))) fail('entrada');
  return e as unknown as QueueHistoryData;
}

/** Identidade do item: nunca muda depois de gravada. */
const IMMUTABLE: ReadonlyArray<keyof QueueItem> = ['idempotencyKey', 'ownerId', 'projectId', 'taskId', 'agentId', 'createdAt'];
/** Campos que só mudam JUNTO com uma transição de estado (R3). */
const TRANSITION_ONLY: ReadonlyArray<keyof QueueItem> = ['state', 'reason', 'stateEpoch', 'closedAt', 'approvalId', 'attempt'];

/**
 * Permissão de remoção de UM pedido de barreira (R2). Só o armazenamento da fila a fornece, por um
 * caminho interno (`clearBarrierRequest`) e depois de confirmar a barreira durável na autoridade;
 * o `commit` público nunca repassa permissões.
 */
export interface BarrierClearance {
  kind: 'clear_barrier';
  scopeKey: string;
}

const isClearance = (allow: unknown): allow is BarrierClearance =>
  typeof allow === 'object' && allow !== null && (allow as BarrierClearance).kind === 'clear_barrier' && typeof (allow as BarrierClearance).scopeKey === 'string';
const time = (iso: string) => Date.parse(iso);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Regras entre a versão gravada e a nova, impostas em TODA gravação (inclusive na abertura de época).
 *
 * Itens existentes (R3):
 * - nunca são removidos; identidade (`IMMUTABLE`) nunca muda;
 * - terminais (inclusive `revoked`) nunca mudam em nada;
 * - SEM transição: `state`, `reason`, `stateEpoch`, `closedAt`, `approvalId` e `attempt` não mudam;
 *   `priority` só muda enquanto `queued` (repriorização prevista para o PR 2); `updatedAt` não regride;
 * - COM transição: só as de `QUEUE_TRANSITIONS`; `stateEpoch` = época da gravação; `updatedAt` não
 *   regride; tentativa só cresce (+1) ao entrar em `dispatching`; aprovação só pode ser vinculada
 *   (de `null`) ao entrar em `admitted` e nunca é trocada; terminal exige `closedAt = updatedAt`;
 *   `priority` não muda na mesma gravação.
 *
 * Itens novos: `queued`, tentativa 0, sem aprovação, sem motivo, sem encerramento,
 * `stateEpoch` = época da gravação e `updatedAt = createdAt`.
 *
 * Pedidos de barreira (R2): podem ser ACRESCENTADOS (com a época da gravação); os existentes nunca
 * são alterados e só são removidos com `BarrierClearance` do mesmo escopo — um por gravação.
 */
export function checkQueueChange(before: Readonly<QueueBody>, after: Readonly<QueueBody>, context: { epoch: number; allow: unknown }): void {
  const next = new Map(after.items.map((item) => [item.id, item]));
  for (const old of before.items) {
    const item = next.get(old.id);
    if (!item) fail('item removido');
    const now = item!;
    for (const field of IMMUTABLE) if (now[field] !== old[field]) fail('campo imutável alterado');
    if (isTerminal(old.state)) {
      if (!sameJson(now, old)) fail('item terminal alterado');
      continue;
    }
    if (time(now.updatedAt) < time(old.updatedAt)) fail('updatedAt regrediu');
    checkRunChange(old, now, context.epoch);
    if (now.state === old.state) {
      for (const field of TRANSITION_ONLY) if (now[field] !== old[field]) fail('campo alterado sem transição');
      if (now.priority !== old.priority && old.state !== 'queued') fail('prioridade fora da fila');
      continue;
    }
    if (!QUEUE_TRANSITIONS[old.state].includes(now.state)) fail('transição proibida');
    if (now.stateEpoch !== context.epoch) fail('época da transição');
    if (now.attempt !== old.attempt + (now.state === 'dispatching' ? 1 : 0)) fail('tentativa incoerente');
    if (now.priority !== old.priority) fail('prioridade alterada na transição');
    if (old.approvalId !== null ? now.approvalId !== old.approvalId : now.approvalId !== null && now.state !== 'admitted') fail('aprovação trocada');
    if (isTerminal(now.state) && now.closedAt !== now.updatedAt) fail('encerramento incoerente');
  }
  const known = new Set(before.items.map((item) => item.id));
  for (const item of after.items) {
    if (known.has(item.id)) continue;
    if (item.state !== 'queued' || item.attempt !== 0 || item.approvalId !== null || item.closedAt !== null || item.reason !== null) fail('item novo inválido');
    if (item.stateEpoch !== context.epoch || item.updatedAt !== item.createdAt) fail('item novo inválido');
    if (item.run && (item.run.admissionIntentAt !== null || item.run.capacity !== 'none')) fail('item novo inválido');
  }

  const remaining = new Map(after.pendingBarriers.map((b) => [scopeKey(b.scope), b]));
  let removed = 0;
  for (const old of before.pendingBarriers) {
    const key = scopeKey(old.scope);
    const now = remaining.get(key);
    if (now) {
      if (!sameJson(now, old)) fail('pedido de barreira alterado');
      continue;
    }
    if (!isClearance(context.allow) || context.allow.scopeKey !== key) fail('pedido de barreira removido sem confirmação');
    removed += 1;
  }
  if (removed > 1) fail('mais de um pedido de barreira removido');
  const previous = new Set(before.pendingBarriers.map((b) => scopeKey(b.scope)));
  for (const barrier of after.pendingBarriers) {
    if (!previous.has(scopeKey(barrier.scope)) && barrier.epoch !== context.epoch) fail('pedido de barreira com época incoerente');
  }
}

const RUN_IMMUTABLE = ['version', 'request', 'expiresAt', 'notBefore', 'retryOf', 'chainAttempt'] as const;
const SNAPSHOT_IMMUTABLE = ['admissionId', 'admittedAt', 'deadline', 'dispatchBy', 'approvalIds', 'tokensCeiling', 'limitsFingerprint', 'controllerFingerprint'] as const;

/**
 * Regras da extensão `run` entre a versão gravada e a nova (PR 2). Só restringem:
 * - a extensão nunca é acrescentada a um item do PR 1 nem removida; o pedido nunca muda;
 * - item do PR 1 nunca vai de `queued` a `failed` (não tem desfecho classificado);
 * - intenção de admissão só muda enquanto `queued`;
 * - reserva só nasce em `queued → admitted` (com vaga `held`); depois só o custo muda, e só junto
 *   com a liberação da vaga;
 * - intenção de despacho só nasce em `admitted → dispatching` (época da gravação, sem início);
 *   início confirmado só em `dispatching → running`; depois o registro é imutável;
 * - vaga: `none → held` só na admissão; `held → released` só junto de um estado terminal ou, em
 *   `interrupted`, com o desfecho comprovado gravado na mesma alteração (Q8); nunca volta;
 * - pedido de cancelamento nunca é apagado; desfecho é gravado uma única vez;
 * - `failed` exige desfecho: de `queued`, só `refused_definitive` (Q5); de `dispatching`, só
 *   `not_started` ou `uncertain`; de `running`, só término/parada informados pelo executor;
 *   `succeeded` só com término informado.
 */
function checkRunChange(old: QueueItem, now: QueueItem, epoch: number) {
  const a = old.run;
  const b = now.run;
  if (!a || !b) {
    if (a || b) fail('extensão acrescentada ou removida');
    if (old.state === 'queued' && now.state === 'failed') fail('falha sem desfecho classificado');
    return;
  }
  for (const field of RUN_IMMUTABLE) if (!sameJson(a[field], b[field])) fail('pedido alterado');
  const moved = (from: string, to: string) => old.state === from && now.state === to;
  if (a.admissionIntentAt !== b.admissionIntentAt && old.state !== 'queued') fail('intenção de admissão fora da fila');

  if (a.admission === null) {
    if (b.admission !== null && !moved('queued', 'admitted')) fail('reserva fora da admissão');
  } else {
    if (b.admission === null) fail('reserva removida');
    for (const field of SNAPSHOT_IMMUTABLE) if (!sameJson(a.admission[field], b.admission![field])) fail('reserva alterada');
    if (!sameJson(a.admission.cost, b.admission!.cost) && !(a.capacity === 'held' && b.capacity === 'released')) fail('custo alterado sem liberação');
  }
  if (moved('queued', 'admitted') && (b.admission === null || b.capacity !== 'held')) fail('admissão sem reserva');

  if (a.dispatch === null) {
    if (b.dispatch !== null && !moved('admitted', 'dispatching')) fail('despacho fora da intenção');
  } else {
    if (b.dispatch === null) fail('despacho removido');
    const d = a.dispatch;
    const e = b.dispatch!;
    if (d.token !== e.token || d.at !== e.at || d.epoch !== e.epoch) fail('despacho alterado');
    if (d.startedAt === null) {
      if (e.startedAt !== null && !moved('dispatching', 'running')) fail('início fora da transição');
    } else if (!sameJson(d, e)) fail('despacho alterado');
  }
  if (moved('admitted', 'dispatching') && (b.dispatch === null || b.dispatch.epoch !== epoch || b.dispatch.startedAt !== null)) fail('intenção de despacho incoerente');
  if (moved('dispatching', 'running') && b.dispatch!.startedAt === null) fail('início sem confirmação');

  if (a.capacity !== b.capacity) {
    const admittedNow = a.capacity === 'none' && b.capacity === 'held' && moved('queued', 'admitted');
    const releasedNow =
      a.capacity === 'held' && b.capacity === 'released' && (isTerminal(now.state) || (old.state === 'interrupted' && now.state === 'interrupted' && a.outcome === null && b.outcome !== null));
    if (!admittedNow && !releasedNow) fail('vaga alterada sem comprovação');
    if (releasedNow) {
      // Liberação sempre acompanhada do desfecho que a comprova (gravado agora ou antes).
      const kind = b.outcome?.kind;
      if (!kind) fail('vaga liberada sem desfecho');
      const proven = old.state === 'admitted' ? kind === 'not_dispatched' : ['not_started', 'completed', 'failed_after_start', 'stop_confirmed', 'ended_after_interruption'].includes(kind!);
      if (!proven) fail('vaga liberada sem comprovação de término');
    }
  }
  if (a.cancellation !== null && (b.cancellation === null || b.cancellation.requestedAt !== a.cancellation.requestedAt)) fail('pedido de cancelamento apagado');
  if (a.outcome !== null && !sameJson(a.outcome, b.outcome)) fail('desfecho alterado');

  if (now.state === 'failed' && old.state !== 'failed') {
    const kind = b.outcome?.kind;
    if (old.state === 'queued' && kind !== 'refused_definitive') fail('falha sem recusa definitiva');
    // Despacho incerto NUNCA vira `failed` (iria liberar a vaga): vai a `interrupted` (Q8).
    if (old.state === 'dispatching' && kind !== 'not_started') fail('falha de despacho sem comprovação de não início');
    if (old.state === 'running' && kind !== 'failed_after_start' && kind !== 'stop_confirmed') fail('falha sem término informado');
    if (old.state === 'interrupted' && a.outcome === null) fail('interrompido sem comprovação');
  }
  if (now.state === 'succeeded' && old.state !== 'succeeded' && b.outcome?.kind !== 'completed') fail('sucesso sem término informado');
}
