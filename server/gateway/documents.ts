import { isIsoDate } from '../storage/jsonFile.ts';
import {
  BRIDGE_LIMITS,
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
  ENTRY_VERDICTS,
  ORDER_LIMITS,
  PR_RULE_RESULTS,
  PR_RULES,
  SCOPE_STATES,
  SCOPE_TRANSITIONS,
  type GatewayBody,
  type GatewayHistoryData,
  type OrderVerification,
} from './contracts.ts';
import { claudeWorkBranchFor, PRESENTATION_CODE_CHANGE } from '../../shared/approvalPresentation.ts';

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
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const NODE_ID = /^[A-Za-z0-9_=-]{1,100}$/;
const SCOPE_FIELDS = [
  'id', 'ownerId', 'projectId', 'taskId', 'agentIds', 'capabilities', 'dataRefs', 'channel', 'mode', 'externalSharing', 'maxInvocations', 'budgetMinor', 'validitySeconds', 'maxOutputBytes',
  'paramsDigest', 'policyVersion', 'state', 'reason', 'createdAt', 'updatedAt', 'approvalDeadline', 'validUntil', 'approvals', 'usedInvocations', 'spentMinor',
] as const;

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

/** Issue #008: ordem do Claude Code dentro do escopo (`code.change` só aqui, sempre sozinha). */
function checkCode(s: Record<string, unknown>) {
  const caps = s.capabilities as string[];
  if (!Object.hasOwn(s, 'code')) {
    if (caps.includes(PRESENTATION_CODE_CHANGE.capability)) fail();
    return;
  }
  const c = PRESENTATION_CODE_CHANGE;
  if (caps.length !== 1 || caps[0] !== c.capability) fail();
  if ((s.agentIds as string[])[0] !== c.agentId || s.channel !== c.channel || s.mode !== c.mode || s.maxInvocations !== 1) fail();
  const k = exact(s.code, ['orderId', 'idempotencyKey', 'requestDigest', 'repository', 'repositoryId', 'baseSha', 'workBranch', 'inputDigest', 'criteriaCount', 'createdBy']);
  const orderId = uuid(k.orderId);
  if (typeof k.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(k.idempotencyKey)) fail();
  hex(k.requestDigest);
  if (typeof k.repository !== 'string' || !REPOSITORY.test(k.repository)) fail();
  if (typeof k.repositoryId !== 'string' || !NODE_ID.test(k.repositoryId)) fail();
  if (typeof k.baseSha !== 'string' || !SHA40.test(k.baseSha)) fail();
  if (k.workBranch !== claudeWorkBranchFor(s.taskId as string, orderId)) fail();
  hex(k.inputDigest);
  int(k.criteriaCount, 0, ORDER_LIMITS.maxCriteria);
  ownerId(k.createdBy);
}

function checkScope(raw: unknown) {
  const s = exact(raw, isPlain(raw) && Object.hasOwn(raw, 'code') ? [...SCOPE_FIELDS, 'code'] : SCOPE_FIELDS);
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
  checkCode(s);
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

const BASE_BODY = ['scopes', 'invocations', 'handoffs', 'contents'] as const;
const ORDER_BODY = ['verifications', 'orderMarks', 'projectSettings'] as const;
/** Issue #055 — ponte MCP: conjuntos SOMENTE DE ACRÉSCIMO (nada é reescrito nem removido). */
const BRIDGE_BODY = ['bridgeCredentials', 'bridgeRevocations', 'orderDeliveries', 'prProposals'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function checkCredential(raw: unknown) {
  const c = exact(raw, ['id', 'ownerId', 'projectId', 'agentId', 'tokenDigest', 'createdAt', 'createdBy', 'expiresAt', 'approvalId']);
  uuid(c.id);
  ownerId(c.ownerId);
  uuid(c.projectId);
  if (c.agentId !== 'claude-code') fail();
  hex(c.tokenDigest);
  const created = Date.parse(iso(c.createdAt) as string);
  ownerId(c.createdBy);
  const expires = Date.parse(iso(c.expiresAt) as string);
  uuid(c.approvalId);
  // Validade de 1 a 30 dias, fixada na criação (nunca estendida).
  if (expires <= created || expires - created > BRIDGE_LIMITS.credentialMaxDays * DAY_MS) fail();
}

function checkRevocation(raw: unknown) {
  const r = exact(raw, ['id', 'ownerId', 'credentialId', 'at', 'by', 'reason']);
  uuid(r.id);
  ownerId(r.ownerId);
  uuid(r.credentialId);
  iso(r.at);
  ownerId(r.by);
  if (typeof r.reason !== 'string' || !REASON.test(r.reason)) fail();
}

function checkDelivery(raw: unknown) {
  const d = exact(raw, ['id', 'ownerId', 'projectId', 'orderId', 'kind', 'at', 'by', 'credentialId', 'keyDigest', 'requestDigest']);
  uuid(d.id);
  ownerId(d.ownerId);
  uuid(d.projectId);
  uuid(d.orderId);
  const kind = oneOf(['offered', 'claimed'] as const, d.kind);
  iso(d.at);
  ownerId(d.by);
  if (kind === 'offered') {
    // Disponibilizar é da pessoa e não é preso a uma credencial.
    if (d.credentialId !== null || d.keyDigest !== null || d.requestDigest !== null) fail();
  } else {
    uuid(d.credentialId);
    hex(d.keyDigest);
    hex(d.requestDigest);
  }
}

function checkProposal(raw: unknown) {
  const p = exact(raw, ['id', 'ownerId', 'projectId', 'orderId', 'credentialId', 'claimId', 'prNumber', 'keyDigest', 'requestDigest', 'at']);
  uuid(p.id);
  ownerId(p.ownerId);
  uuid(p.projectId);
  uuid(p.orderId);
  uuid(p.credentialId);
  uuid(p.claimId);
  int(p.prNumber, 1, ORDER_LIMITS.maxPrNumber);
  hex(p.keyDigest);
  hex(p.requestDigest);
  iso(p.at);
}

/** Coerência da ponte (Issue #055): credenciais, revogações, entregas e propostas entre si e com as ordens. */
function checkBridge(b: GatewayBody, orders: Map<string, { ownerId: string; projectId: string; baseSha: string; scopeId: string }>) {
  const credentials = new Map<string, { ownerId: string; projectId: string }>();
  const digests = new Set<string>();
  for (const c of b.bridgeCredentials ?? []) {
    if (digests.has(c.tokenDigest)) fail();
    digests.add(c.tokenDigest);
    credentials.set(c.id, { ownerId: c.ownerId, projectId: c.projectId });
  }
  const revoked = new Set<string>();
  for (const r of b.bridgeRevocations ?? []) {
    const c = credentials.get(r.credentialId);
    if (!c || c.ownerId !== r.ownerId || revoked.has(r.credentialId)) fail();
    revoked.add(r.credentialId);
  }
  const handoffs = new Set(b.handoffs.filter((h) => h.capability === PRESENTATION_CODE_CHANGE.capability).map((h) => h.id));
  const seen = new Set<string>();
  const claims = new Map<string, { orderId: string; credentialId: string }>();
  const keys = new Set<string>();
  for (const d of b.orderDeliveries ?? []) {
    const o = orders.get(d.orderId);
    if (!o || o.ownerId !== d.ownerId || o.projectId !== d.projectId || !handoffs.has(d.orderId)) fail();
    const key = `${d.orderId}|${d.kind}`;
    if (seen.has(key)) fail();
    // Recebimento só depois da disponibilização (ordem do histórico).
    if (d.kind === 'claimed') {
      if (!seen.has(`${d.orderId}|offered`)) fail();
      const c = credentials.get(d.credentialId!);
      if (!c || c.ownerId !== d.ownerId || c.projectId !== d.projectId) fail();
      if (keys.has(d.keyDigest!)) fail();
      keys.add(d.keyDigest!);
      claims.set(d.id, { orderId: d.orderId, credentialId: d.credentialId! });
    }
    seen.add(key);
  }
  const perOrder = new Map<string, number>();
  const proposalKeys = new Set<string>();
  for (const p of b.prProposals ?? []) {
    const o = orders.get(p.orderId);
    if (!o || o.ownerId !== p.ownerId || o.projectId !== p.projectId) fail();
    const claim = claims.get(p.claimId);
    if (!claim || claim.orderId !== p.orderId || claim.credentialId !== p.credentialId) fail();
    if (proposalKeys.has(p.keyDigest)) fail();
    proposalKeys.add(p.keyDigest);
    const count = (perOrder.get(p.orderId) ?? 0) + 1;
    if (count > BRIDGE_LIMITS.maxProposals) fail();
    perOrder.set(p.orderId, count);
  }
}

function checkVerification(raw: unknown) {
  const v = exact(raw, ['id', 'ownerId', 'projectId', 'orderId', 'seq', 'headSha', 'baseSha', 'verdict', 'rules', 'evidence', 'supersedes', 'checkedAt', 'checkedBy', 'closes', 'reason']);
  uuid(v.id);
  ownerId(v.ownerId);
  uuid(v.projectId);
  uuid(v.orderId);
  int(v.seq, 1, ORDER_LIMITS.maxVerifications + 1);
  const verdict = oneOf(ENTRY_VERDICTS, v.verdict);
  if (!(v.headSha === null || (typeof v.headSha === 'string' && SHA40.test(v.headSha)))) fail();
  if (typeof v.baseSha !== 'string' || !SHA40.test(v.baseSha)) fail();
  const rules = list(v.rules, PR_RULES.length, (r) => {
    const x = exact(r, ['rule', 'result', 'reason']);
    return { rule: oneOf(PR_RULES, x.rule), result: oneOf(PR_RULE_RESULTS, x.result), reason: reasonOrNull(x.reason) };
  });
  const e = exact(v.evidence, ['pullRequest', 'compare', 'confirm']);
  hexOrNull(e.pullRequest);
  hexOrNull(e.compare);
  hexOrNull(e.confirm);
  uuidOrNull(v.supersedes);
  iso(v.checkedAt);
  const by = exact(v.checkedBy, ['kind', 'id']);
  oneOf(['human', 'system'] as const, by.kind);
  ownerId(by.id);
  const closes = bool(v.closes);
  reasonOrNull(v.reason);
  if (verdict === 'cancelled') {
    // Encerramento administrativo: final, sem leitura nem regras.
    if (!closes || rules.length !== 0 || e.pullRequest !== null || e.compare !== null || e.confirm !== null) fail();
  } else {
    // Verificação real: as 13 regras, uma vez cada, na ordem; cabeça confirmada; resumo da consulta.
    if (rules.map((r) => r.rule).join(',') !== PR_RULES.join(',') || e.pullRequest === null || e.confirm === null) fail();
    // Sem cabeça só quando o PR comprovadamente não existe (V2), o que encerra a ordem.
    if (v.headSha === null && (verdict !== 'nonconforming' || rules[1].result !== 'fail')) fail();
    // Só `nonconforming` encerra; `conforming` exige todas as provas (nenhuma regra pendente/falha).
    if (closes !== (verdict === 'nonconforming')) fail();
    if (verdict === 'conforming' && (e.compare === null || rules.some((r) => r.result === 'pending' || r.result === 'fail'))) fail();
    if (verdict === 'needs_review' && (rules.some((r) => r.result === 'fail') || !rules.some((r) => r.result === 'pending'))) fail();
    if (verdict === 'nonconforming' && !rules.some((r) => r.result === 'fail')) fail();
  }
}

function checkMark(raw: unknown) {
  const m = exact(raw, ['id', 'ownerId', 'projectId', 'orderId', 'kind', 'at', 'by', 'prNumber']);
  uuid(m.id);
  ownerId(m.ownerId);
  uuid(m.projectId);
  uuid(m.orderId);
  const kind = oneOf(['forwarded', 'pr_linked'] as const, m.kind);
  iso(m.at);
  ownerId(m.by);
  if (kind === 'pr_linked') int(m.prNumber, 1, ORDER_LIMITS.maxPrNumber);
  else if (m.prNumber !== null) fail();
}

function checkSetting(raw: unknown) {
  const p = exact(raw, ['id', 'ownerId', 'projectId', 'enabled', 'repository', 'at', 'by', 'approvalId', 'reason']);
  uuid(p.id);
  ownerId(p.ownerId);
  uuid(p.projectId);
  const enabled = bool(p.enabled);
  iso(p.at);
  ownerId(p.by);
  if (typeof p.reason !== 'string' || !REASON.test(p.reason)) fail();
  // Habilitar exige repositório e a aprovação de configuração consumida; desabilitar não tem nenhum dos dois.
  if (enabled) {
    if (typeof p.repository !== 'string' || !REPOSITORY.test(p.repository)) fail();
    uuid(p.approvalId);
  } else if (p.repository !== null || p.approvalId !== null) fail();
}

/** Coerência entre ordens, handoffs, marcas e verificações (Issue #008). */
function checkOrders(b: GatewayBody) {
  const orders = new Map<string, { ownerId: string; projectId: string; baseSha: string; scopeId: string }>();
  const keys = new Set<string>();
  for (const s of b.scopes) {
    if (!s.code) continue;
    if (orders.has(s.code.orderId)) fail();
    const key = `${s.ownerId}|${s.code.idempotencyKey}`;
    if (keys.has(key)) fail();
    keys.add(key);
    orders.set(s.code.orderId, { ownerId: s.ownerId, projectId: s.projectId, baseSha: s.code.baseSha, scopeId: s.id });
  }
  // Handoff de `code.change` = a ordem do próprio escopo (id = `orderId`), um por ordem.
  for (const h of b.handoffs) {
    if (h.capability !== PRESENTATION_CODE_CHANGE.capability) continue;
    const order = orders.get(h.id);
    if (!order || order.scopeId !== h.scopeId || order.ownerId !== h.ownerId || order.projectId !== h.projectId) fail();
  }
  const same = (x: { ownerId: string; projectId: string; orderId: string }) => {
    const o = orders.get(x.orderId);
    if (!o || o.ownerId !== x.ownerId || o.projectId !== x.projectId) fail();
    return o!;
  };
  const marks = new Set<string>();
  for (const m of b.orderMarks ?? []) {
    same(m);
    const key = `${m.orderId}|${m.kind}`;
    if (marks.has(key)) fail();
    marks.add(key);
  }
  // Histórico: `seq` 1, 2, 3… sem lacuna; `supersedes` = a entrada anterior; nada depois de uma final.
  const last = new Map<string, OrderVerification>();
  for (const v of b.verifications ?? []) {
    const o = same(v);
    if (v.baseSha !== o.baseSha) fail();
    const previous = last.get(v.orderId);
    if (previous) {
      if (previous.closes || v.seq !== previous.seq + 1 || v.supersedes !== previous.id || Date.parse(v.checkedAt) < Date.parse(previous.checkedAt)) fail();
    } else if (v.seq !== 1 || v.supersedes !== null) fail();
    if (v.verdict !== 'cancelled' && v.seq > ORDER_LIMITS.maxVerifications) fail();
    // Só há verificação de PR com a referência vinculada.
    if (v.verdict !== 'cancelled' && !marks.has(`${v.orderId}|pr_linked`)) fail();
    last.set(v.orderId, v);
  }
  checkBridge(b, orders);
}

export function checkGatewayBody(raw: unknown): GatewayBody {
  // Ledgers da #028 (sem os conjuntos da #008) continuam válidos: os conjuntos novos são aditivos.
  // Issue #055: os conjuntos da ponte só existem junto com os da #008.
  const hasOrders = isPlain(raw) && Object.hasOwn(raw, 'verifications');
  const hasBridge = isPlain(raw) && Object.hasOwn(raw, 'bridgeCredentials');
  if (hasBridge && !hasOrders) fail();
  const b = exact(raw, [...BASE_BODY, ...(hasOrders ? ORDER_BODY : []), ...(hasBridge ? BRIDGE_BODY : [])]);
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
  if (Object.hasOwn(b, 'verifications')) {
    for (const [name, check] of [
      ['verifications', checkVerification],
      ['orderMarks', checkMark],
      ['projectSettings', checkSetting],
    ] as const) {
      const items = list(b[name], max, (x) => x as Record<string, unknown>);
      items.forEach(check);
      if (new Set(items.map((x) => x.id)).size !== items.length) fail();
    }
  }
  if (hasBridge) {
    for (const [name, check] of [
      ['bridgeCredentials', checkCredential],
      ['bridgeRevocations', checkRevocation],
      ['orderDeliveries', checkDelivery],
      ['prProposals', checkProposal],
    ] as const) {
      const items = list(b[name], max, (x) => x as Record<string, unknown>);
      items.forEach(check);
      if (new Set(items.map((x) => x.id)).size !== items.length) fail();
    }
  }
  checkOrders(raw as GatewayBody);
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
  scopes: ['ownerId', 'projectId', 'taskId', 'agentIds', 'capabilities', 'dataRefs', 'channel', 'mode', 'externalSharing', 'maxInvocations', 'budgetMinor', 'validitySeconds', 'maxOutputBytes', 'paramsDigest', 'policyVersion', 'createdAt', 'approvalDeadline', 'code'],
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
  // Issue #008: histórico de verificações, marcas e habilitações são SOMENTE DE ACRÉSCIMO — o que
  // existia continua idêntico e na mesma posição (nada é apagado, reescrito nem reordenado).
  for (const name of [...ORDER_BODY, ...BRIDGE_BODY]) {
    const old = (before[name] ?? []) as readonly unknown[];
    const now = (after[name] ?? []) as readonly unknown[];
    if (now.length < old.length || old.some((entry, i) => !same(entry, now[i]))) throw new GatewayDocumentError('histórico somente de acréscimo alterado');
  }
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
