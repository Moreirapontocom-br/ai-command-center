import { isIsoDate } from '../storage/jsonFile.ts';
import {
  CONTENT_KINDS,
  GATEWAY_AGENTS,
  GATEWAY_CAPABILITIES,
  GATEWAY_CHANNELS,
  GATEWAY_EVENTS,
  GATEWAY_INPUT_KINDS,
  GATEWAY_LIMITS,
  GATEWAY_USAGE_MODES,
  HANDOFF_STATES,
  HANDOFF_TRANSITIONS,
  INVOCATION_STATES,
  INVOCATION_TRANSITIONS,
  SCOPE_STATES,
  SCOPE_TRANSITIONS,
  type GatewayBody,
  type GatewayHistoryData,
} from './contracts.ts';

/**
 * Validação ESTRITA dos documentos do gateway (Issue #028). Tudo que entra no ledger assinado (ou
 * sai dele na abertura) passa por aqui: formato fechado, tipos, listas fechadas, datas ISO e
 * tokens. `checkGatewayChange` impõe as transições permitidas e a imutabilidade dos vínculos.
 */

export class GatewayDocumentError extends Error {
  name = 'GatewayDocumentError';
  readonly code = 'gateway_document_invalid';
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REASON = /^[a-z0-9_]{1,64}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const OWNER_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PARAMS_DIGEST = /^gateway\.scope:[0-9a-f]{64}$/;
const DATA_REF = /^[A-Za-z0-9._/#:-]{1,200}$/;
const POLICY_VERSION = /^[A-Za-z0-9_:.#\-/]{1,200}$/;
const ADAPTER_ID = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9._:/-]{1,64}$/;
const DETAIL = /^[a-z0-9_ :.-]{1,200}$/;

const fail = (): never => {
  throw new GatewayDocumentError('documento do gateway inválido');
};
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function exact(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(v)) fail();
  const r = v as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || !keys.every((k) => Object.hasOwn(r, k))) fail();
  return r;
}
const uuid = (v: unknown) => (typeof v === 'string' && UUID.test(v) ? v : fail());
const uuidOrNull = (v: unknown) => (v === null ? null : uuid(v));
const iso = (v: unknown) => (isIsoDate(v) ? v : fail());
const isoOrNull = (v: unknown) => (v === null ? null : iso(v));
const reasonOrNull = (v: unknown) => (v === null ? null : typeof v === 'string' && REASON.test(v) ? v : fail());
const hex = (v: unknown) => (typeof v === 'string' && HEX64.test(v) ? v : fail());
const hexOrNull = (v: unknown) => (v === null ? null : hex(v));
const oneOf = <T extends string>(list: readonly T[], v: unknown): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fail());
const int = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail());
const bool = (v: unknown) => (typeof v === 'boolean' ? v : fail());
const ownerId = (v: unknown) => (typeof v === 'string' && OWNER_ID.test(v) ? v : fail());
function list<T>(v: unknown, max: number, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v) || v.length > max) fail();
  return (v as unknown[]).map(item);
}
function dataRefs(v: unknown) {
  const refs = list(v, GATEWAY_LIMITS.dataRefs, (raw) => {
    const d = exact(raw, ['kind', 'ref']);
    const ref = typeof d.ref === 'string' && DATA_REF.test(d.ref) && !d.ref.includes('..') ? d.ref : fail();
    return { kind: oneOf(GATEWAY_INPUT_KINDS, d.kind), ref };
  });
  if (new Set(refs.map((r) => `${r.kind}|${r.ref}`)).size !== refs.length) fail();
  return refs;
}

function checkUsage(v: unknown) {
  if (v === null) return;
  const u = exact(v, ['cost', 'tokens']);
  if (!(u.tokens === null || (typeof u.tokens === 'number' && Number.isSafeInteger(u.tokens) && u.tokens >= 0))) fail();
  const c = u.cost as Record<string, unknown>;
  if (!isPlain(c)) fail();
  if (c.kind === 'none' || c.kind === 'unknown') exact(c, ['kind']);
  else if (c.kind === 'confirmed') {
    exact(c, ['kind', 'amountMinor']);
    int(c.amountMinor, 0, Number.MAX_SAFE_INTEGER);
  } else fail();
}

function checkProvenance(v: unknown) {
  if (v === null) return;
  const p = exact(v, ['provider', 'mode', 'channel', 'adapter', 'modelReported', 'requestDigest', 'responseDigest', 'startedAt', 'finishedAt', 'relayedBy']);
  oneOf(GATEWAY_AGENTS, p.provider);
  oneOf(GATEWAY_USAGE_MODES, p.mode);
  const channel = oneOf(GATEWAY_CHANNELS, p.channel);
  const a = exact(p.adapter, ['id', 'version', 'kind']);
  if (typeof a.id !== 'string' || !ADAPTER_ID.test(a.id) || typeof a.version !== 'string' || !ADAPTER_ID.test(a.version)) fail();
  if (oneOf(['simulated', 'assisted'] as const, a.kind) !== channel) fail();
  if (!(p.modelReported === null || (typeof p.modelReported === 'string' && MODEL.test(p.modelReported)))) fail();
  hex(p.requestDigest);
  hexOrNull(p.responseDigest);
  iso(p.startedAt);
  isoOrNull(p.finishedAt);
  if (p.relayedBy !== null) {
    const r = exact(p.relayedBy, ['kind', 'id']);
    if (r.kind !== 'human') fail();
    ownerId(r.id);
  }
  // Proveniência humana só no canal assistido, e sempre nele.
  if ((p.relayedBy !== null) !== (channel === 'assisted')) fail();
}

function checkScope(raw: unknown) {
  const s = exact(raw, [
    'id', 'ownerId', 'projectId', 'taskId', 'agentIds', 'capabilities', 'dataRefs', 'channel', 'mode', 'externalSharing', 'maxInvocations', 'budgetMinor', 'validitySeconds', 'maxOutputBytes',
    'paramsDigest', 'policyVersion', 'state', 'reason', 'createdAt', 'updatedAt', 'approvalDeadline', 'validUntil', 'approvals', 'usedInvocations', 'spentMinor',
  ]);
  uuid(s.id);
  ownerId(s.ownerId);
  uuid(s.projectId);
  uuid(s.taskId);
  const agents = list(s.agentIds, 1, (a) => oneOf(GATEWAY_AGENTS, a));
  if (agents.length !== 1) fail();
  const caps = list(s.capabilities, GATEWAY_CAPABILITIES.length, (c) => oneOf(GATEWAY_CAPABILITIES, c));
  if (caps.length === 0 || new Set(caps).size !== caps.length) fail();
  dataRefs(s.dataRefs);
  const channel = oneOf(GATEWAY_CHANNELS, s.channel);
  const mode = oneOf(GATEWAY_USAGE_MODES, s.mode);
  if (bool(s.externalSharing) !== (channel === 'assisted')) fail();
  const max = int(s.maxInvocations, 1, GATEWAY_LIMITS.maxInvocations);
  const budget = int(s.budgetMinor, 0, GATEWAY_LIMITS.maxBudgetMinor);
  if (mode !== 'metered_api' && budget !== 0) fail();
  int(s.validitySeconds, GATEWAY_LIMITS.minValiditySeconds, GATEWAY_LIMITS.maxValiditySeconds);
  int(s.maxOutputBytes, 1, GATEWAY_LIMITS.maxOutputBytes);
  if (typeof s.paramsDigest !== 'string' || !PARAMS_DIGEST.test(s.paramsDigest)) fail();
  if (typeof s.policyVersion !== 'string' || !POLICY_VERSION.test(s.policyVersion)) fail();
  const state = oneOf(SCOPE_STATES, s.state);
  reasonOrNull(s.reason);
  iso(s.createdAt);
  iso(s.updatedAt);
  iso(s.approvalDeadline);
  isoOrNull(s.validUntil);
  const approvals = list(s.approvals, 2, (raw) => {
    const a = exact(raw, ['action', 'approvalId', 'bindingDigest', 'grantDigest', 'approverId', 'expiresAt']);
    oneOf(['agent.invoke', 'data.send_external'] as const, a.action);
    uuid(a.approvalId);
    hex(a.bindingDigest);
    hex(a.grantDigest);
    ownerId(a.approverId);
    iso(a.expiresAt);
    return a;
  });
  const used = int(s.usedInvocations, 0, max);
  int(s.spentMinor, 0, budget);
  // Escopo ativo (ou já usado) SEMPRE tem as aprovações consumidas e a validade efetiva.
  const activated = ['active', 'exhausted'].includes(state) || (['expired', 'revoked'].includes(state) && approvals.length > 0);
  if (activated) {
    const expected = channel === 'assisted' ? ['agent.invoke', 'data.send_external'] : ['agent.invoke'];
    if (approvals.map((a) => a.action).join(',') !== expected.join(',') || s.validUntil === null) fail();
  } else if (approvals.length !== 0 || (state !== 'expired' && state !== 'revoked' && s.validUntil !== null)) fail();
  if (state === 'exhausted' && used !== max) fail();
}

function checkInvocation(raw: unknown) {
  const i = exact(raw, [
    'id', 'idempotencyKey', 'requestDigest', 'ownerId', 'projectId', 'taskId', 'agentId', 'scopeId', 'capability', 'inputs', 'timeoutSeconds', 'maxOutputBytes', 'state', 'reason', 'createdAt',
    'updatedAt', 'queueItemId', 'outputContentId', 'provenance', 'usage',
  ]);
  uuid(i.id);
  if (typeof i.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(i.idempotencyKey)) fail();
  hex(i.requestDigest);
  ownerId(i.ownerId);
  uuid(i.projectId);
  uuid(i.taskId);
  oneOf(GATEWAY_AGENTS, i.agentId);
  uuid(i.scopeId);
  oneOf(GATEWAY_CAPABILITIES, i.capability);
  dataRefs(i.inputs);
  int(i.timeoutSeconds, 1, GATEWAY_LIMITS.maxTimeoutSeconds);
  int(i.maxOutputBytes, 1, GATEWAY_LIMITS.maxOutputBytes);
  const state = oneOf(INVOCATION_STATES, i.state);
  reasonOrNull(i.reason);
  iso(i.createdAt);
  iso(i.updatedAt);
  uuidOrNull(i.queueItemId);
  uuidOrNull(i.outputContentId);
  checkProvenance(i.provenance);
  checkUsage(i.usage);
  if (state === 'succeeded' && (i.outputContentId === null || i.provenance === null)) fail();
}

function checkHandoff(raw: unknown) {
  const h = exact(raw, [
    'id', 'idempotencyKey', 'requestDigest', 'ownerId', 'projectId', 'taskId', 'agentId', 'scopeId', 'capability', 'inputs', 'maxOutputBytes', 'state', 'reason', 'createdAt', 'updatedAt',
    'packageContentId', 'packageDigest', 'releasedAt', 'releasedBy', 'relayDeadline', 'resultContentId', 'resultDigest', 'ingestQueueItemId', 'provenance',
  ]);
  uuid(h.id);
  if (typeof h.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(h.idempotencyKey)) fail();
  hex(h.requestDigest);
  ownerId(h.ownerId);
  uuid(h.projectId);
  uuid(h.taskId);
  oneOf(GATEWAY_AGENTS, h.agentId);
  uuid(h.scopeId);
  oneOf(GATEWAY_CAPABILITIES, h.capability);
  dataRefs(h.inputs);
  int(h.maxOutputBytes, 1, GATEWAY_LIMITS.maxOutputBytes);
  const state = oneOf(HANDOFF_STATES, h.state);
  reasonOrNull(h.reason);
  iso(h.createdAt);
  iso(h.updatedAt);
  uuid(h.packageContentId);
  hex(h.packageDigest);
  isoOrNull(h.releasedAt);
  if (h.releasedBy !== null) ownerId(h.releasedBy);
  isoOrNull(h.relayDeadline);
  uuidOrNull(h.resultContentId);
  hexOrNull(h.resultDigest);
  uuidOrNull(h.ingestQueueItemId);
  checkProvenance(h.provenance);
  const released = h.releasedAt !== null;
  if (released !== (h.releasedBy !== null) || released !== (h.relayDeadline !== null)) fail();
  if (['awaiting_relay', 'relayed', 'validated'].includes(state) && !released) fail();
  if (['relayed', 'validated'].includes(state) && (h.resultContentId === null || h.resultDigest === null || h.provenance === null)) fail();
}

function checkContent(raw: unknown) {
  const c = exact(raw, ['id', 'ownerId', 'projectId', 'kind', 'sourceId', 'digest', 'bytes', 'createdAt', 'expiresAt', 'state', 'deletedAt', 'deletedReason']);
  uuid(c.id);
  ownerId(c.ownerId);
  uuid(c.projectId);
  oneOf(CONTENT_KINDS, c.kind);
  uuid(c.sourceId);
  hex(c.digest);
  int(c.bytes, 0, GATEWAY_LIMITS.maxPackageBytes);
  iso(c.createdAt);
  iso(c.expiresAt);
  const state = oneOf(['stored', 'deleted'] as const, c.state);
  isoOrNull(c.deletedAt);
  reasonOrNull(c.deletedReason);
  if ((state === 'deleted') !== (c.deletedAt !== null) || (state === 'deleted') !== (c.deletedReason !== null)) fail();
}

export function checkGatewayBody(raw: unknown): GatewayBody {
  const b = exact(raw, ['scopes', 'invocations', 'handoffs', 'contents']);
  const max = GATEWAY_LIMITS.maxRecords;
  for (const [name, check] of [
    ['scopes', checkScope],
    ['invocations', checkInvocation],
    ['handoffs', checkHandoff],
    ['contents', checkContent],
  ] as const) {
    const items = list(b[name], max, (x) => x as Record<string, unknown>);
    items.forEach(check);
    if (new Set(items.map((x) => x.id)).size !== items.length) fail();
  }
  // Idempotência: uma chave por dono em cada tipo de pedido.
  for (const name of ['invocations', 'handoffs'] as const) {
    const keys = (b[name] as Array<{ ownerId: string; idempotencyKey: string }>).map((x) => `${x.ownerId}|${x.idempotencyKey}`);
    if (new Set(keys).size !== keys.length) fail();
  }
  return raw as GatewayBody;
}

export function checkGatewayEntry(raw: unknown): GatewayHistoryData {
  const e = exact(raw, ['event', 'actor', 'projectId', 'ref', 'reason', 'detail']);
  oneOf(GATEWAY_EVENTS, e.event);
  const actor = exact(e.actor, ['kind', 'id']);
  oneOf(['human', 'system'] as const, actor.kind);
  ownerId(actor.id);
  uuidOrNull(e.projectId);
  uuidOrNull(e.ref);
  if (typeof e.reason !== 'string' || !REASON.test(e.reason)) fail();
  if (!(e.detail === null || (typeof e.detail === 'string' && DETAIL.test(e.detail)))) fail();
  return raw as GatewayHistoryData;
}

/** Campos que nunca mudam depois de criados (vínculos, dono, origem). */
const IMMUTABLE = {
  scopes: ['ownerId', 'projectId', 'taskId', 'agentIds', 'capabilities', 'dataRefs', 'channel', 'mode', 'externalSharing', 'maxInvocations', 'budgetMinor', 'validitySeconds', 'maxOutputBytes', 'paramsDigest', 'policyVersion', 'createdAt', 'approvalDeadline'],
  invocations: ['idempotencyKey', 'requestDigest', 'ownerId', 'projectId', 'taskId', 'agentId', 'scopeId', 'capability', 'inputs', 'timeoutSeconds', 'maxOutputBytes', 'createdAt'],
  handoffs: ['idempotencyKey', 'requestDigest', 'ownerId', 'projectId', 'taskId', 'agentId', 'scopeId', 'capability', 'inputs', 'maxOutputBytes', 'createdAt', 'packageContentId', 'packageDigest'],
  contents: ['ownerId', 'projectId', 'kind', 'sourceId', 'digest', 'bytes', 'createdAt', 'expiresAt'],
} as const;
const TRANSITIONS = { scopes: SCOPE_TRANSITIONS, invocations: INVOCATION_TRANSITIONS, handoffs: HANDOFF_TRANSITIONS } as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Regras entre versões: registros nunca somem; vínculos são imutáveis; estados só seguem as
 * transições; contadores do escopo só crescem; aprovações e validade de um escopo só são
 * gravadas na ativação; um conteúdo excluído não volta.
 */
export function checkGatewayChange(before: Readonly<GatewayBody>, after: Readonly<GatewayBody>): void {
  for (const name of ['scopes', 'invocations', 'handoffs', 'contents'] as const) {
    const next = new Map((after[name] as ReadonlyArray<{ id: string }>).map((x) => [x.id, x as Record<string, unknown>]));
    for (const old of before[name] as unknown as ReadonlyArray<Record<string, unknown> & { id: string }>) {
      const now = next.get(old.id);
      if (!now) throw new GatewayDocumentError('registro removido');
      for (const field of IMMUTABLE[name]) if (!same(old[field], now[field])) throw new GatewayDocumentError(`campo imutável alterado: ${field}`);
      if (name === 'contents') {
        if (old.state === 'deleted' && !same(old, now)) throw new GatewayDocumentError('conteúdo excluído alterado');
        continue;
      }
      if (old.state !== now.state) {
        const allowed = (TRANSITIONS[name] as Record<string, readonly string[]>)[old.state as string];
        if (!allowed.includes(now.state as string)) throw new GatewayDocumentError('transição inválida');
      }
      if (name === 'scopes') {
        if ((now.usedInvocations as number) < (old.usedInvocations as number) || (now.spentMinor as number) < (old.spentMinor as number)) throw new GatewayDocumentError('contador do escopo diminuiu');
        const activating = old.state === 'activating' && now.state === 'active';
        if (!activating && (!same(old.approvals, now.approvals) || !same(old.validUntil, now.validUntil))) throw new GatewayDocumentError('aprovações do escopo alteradas fora da ativação');
      }
    }
  }
}
