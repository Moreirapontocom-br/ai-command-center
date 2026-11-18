import { isIsoDate } from '../storage/jsonFile.ts';
import {
  isTerminal,
  MAX_PENDING_BARRIERS,
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
  const i = exactKeys(raw, ITEM_FIELDS, what);
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
  return item;
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
