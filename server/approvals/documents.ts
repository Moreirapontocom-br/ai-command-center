import { APPROVAL_METHODS } from '../../shared/contracts.ts';
import { isIsoDate } from '../storage/jsonFile.ts';
import { HUMAN_ID, isPlain, parseBinding, bindingDigest, REASON, UUID } from './binding.ts';
import { sha256Hex, canonicalJson, without } from './canonical.ts';
import {
  APPROVAL_CLASSES,
  APPROVAL_EVENTS,
  APPROVAL_STATES,
  ATTEMPT_STATES,
  CONFIRMATION_METHODS,
  HISTORY_RETENTION_DAYS,
  HOLD_NOTE_MAX,
  HOLD_REASONS,
  RECEIPT_COMPONENTS,
  type ApprovalClass,
  type ApprovalEvent,
  type Barrier,
  type HoldReason,
  type LedgerApproval,
  type LedgerAttempt,
} from './contracts.ts';

/**
 * Formatos persistidos do núcleo de aprovações e sua validação ESTRITA. Qualquer campo extra,
 * ausente, estado desconhecido ou invariante quebrada torna o documento inválido — e o
 * armazenamento indisponível (nega tudo). Nada é "corrigido" na leitura.
 */

export const LEDGER_FORMAT = 'acc-approvals-ledger';
export const HISTORY_FORMAT = 'acc-approvals-history';
export const ANCHOR_FORMAT = 'acc-approvals-anchor';
export const DOCUMENT_VERSION = 1;

export interface LedgerBody {
  approvals: LedgerApproval[];
  attempts: LedgerAttempt[];
  barriers: { global: Barrier | null; projects: Record<string, Barrier> };
  compaction: { lastAt: string | null; removed: number };
}

export interface LedgerDocument extends LedgerBody {
  format: typeof LEDGER_FORMAT;
  version: typeof DOCUMENT_VERSION;
  lineage: string;
  keyId: string;
  generation: number;
  prevHead: string | null;
  epoch: number;
  updatedAt: string;
  mac: string;
}

export interface HistoryEntry {
  kind: 'entry';
  seq: number;
  at: string;
  prevHash: string | null;
  hash: string;
  /** Geração do ledger que esta entrada descreve (permite detectar entradas não aplicadas). */
  ledgerGeneration: number;
  event: ApprovalEvent;
  actor: { kind: 'human' | 'system'; id: string };
  approvalId: string | null;
  attemptId: string | null;
  projectId: string | null;
  class: ApprovalClass | null;
  action: string | null;
  bindingDigest: string | null;
  from: string | null;
  to: string | null;
  reason: string | null;
  /** Só em preservação/recuperação: valores curtos e saneados. */
  detail: string | null;
}

/** Entradas descartadas pela retenção: o encadeamento é preservado sem o conteúdo. */
export interface HistoryTombstone {
  kind: 'tombstone';
  firstSeq: number;
  seq: number;
  prevHash: string | null;
  hash: string;
  purged: number;
}

export type HistoryItem = HistoryEntry | HistoryTombstone;

export interface Hold {
  id: string;
  approvalId: string;
  reason: HoldReason;
  note: string | null;
  createdAt: string;
  createdBy: string;
}

export interface HistoryBody {
  retentionDays: number;
  items: HistoryItem[];
  holds: Hold[];
}

export interface HistoryDocument extends HistoryBody {
  format: typeof HISTORY_FORMAT;
  version: typeof DOCUMENT_VERSION;
  lineage: string;
  keyId: string;
  mac: string;
}

export interface AnchorDocument {
  format: typeof ANCHOR_FORMAT;
  version: typeof DOCUMENT_VERSION;
  lineage: string;
  keyId: string;
  epoch: number;
  ledger: { generation: number; head: string };
  history: { seq: number; head: string };
  updatedAt: string;
  mac: string;
}

export class DocumentError extends Error {
  name = 'DocumentError';
}

const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const ACTOR_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_.]{0,63}$/;

function fail(detail: string): never {
  throw new DocumentError(detail);
}

function keys(value: unknown, expected: string[], what: string): Record<string, unknown> {
  if (!isPlain(value)) fail(what);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) fail(what);
  return value;
}

const nullable = <T>(value: unknown, check: (v: unknown) => v is T): value is T | null => value === null || check(value);
const isIso = (v: unknown): v is string => isIsoDate(v);
const isReason = (v: unknown): v is string => typeof v === 'string' && REASON.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositive = (v: unknown): v is number => isCount(v) && v > 0;
const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const oneOf = <T extends string>(list: readonly T[]) => (v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

function checkApproval(raw: unknown, index: number): LedgerApproval {
  const what = `aprovação ${index}`;
  const a = keys(raw, ['id', 'ownerId', 'class', 'method', 'binding', 'bindingDigest', 'state', 'epoch', 'requestedBy', 'requestedAt', 'pendingUntil', 'decidedBy', 'decidedAt', 'confirmation', 'validUntil', 'closedAt', 'closedReason', 'attemptId'], what);
  if (!isUuid(a.id) || typeof a.ownerId !== 'string' || !HUMAN_ID.test(a.ownerId)) fail(what);
  if (!oneOf(APPROVAL_CLASSES)(a.class) || !oneOf(APPROVAL_METHODS)(a.method) || !oneOf(APPROVAL_STATES)(a.state)) fail(what);
  let binding;
  try {
    binding = parseBinding(a.binding);
  } catch {
    fail(what);
  }
  if (a.bindingDigest !== bindingDigest(binding)) fail(what);
  if (!nullable(a.epoch, isPositive)) fail(what);
  const by = keys(a.requestedBy, ['kind', 'id'], what);
  if ((by.kind !== 'system' && by.kind !== 'human') || typeof by.id !== 'string' || !ACTOR_ID.test(by.id)) fail(what);
  if (!isIso(a.requestedAt) || !isIso(a.pendingUntil) || !nullable(a.decidedAt, isIso) || !nullable(a.validUntil, isIso) || !nullable(a.closedAt, isIso)) fail(what);
  if (!nullable(a.closedReason, isReason) || !nullable(a.attemptId, isUuid)) fail(what);
  if (a.decidedBy !== null) {
    const d = keys(a.decidedBy, ['kind', 'id'], what);
    if (d.kind !== 'human' || typeof d.id !== 'string' || !HUMAN_ID.test(d.id)) fail(what);
  }
  if (a.confirmation !== null) {
    const c = keys(a.confirmation, ['method', 'at'], what);
    if (!oneOf(CONFIRMATION_METHODS)(c.method) || !isIso(c.at)) fail(what);
  }
  const decided = a.decidedBy !== null && a.decidedAt !== null && a.confirmation !== null;
  // Invariantes por estado.
  if (a.state === 'pending' && (decided || a.epoch !== null || a.attemptId !== null || a.closedAt !== null)) fail(what);
  if (a.state === 'approved' && (!decided || a.epoch === null || a.validUntil === null || a.attemptId !== null || a.closedAt !== null)) fail(what);
  if (a.state === 'consumed' && (!decided || a.epoch === null || a.attemptId === null || a.closedAt === null)) fail(what);
  if (!['pending', 'approved'].includes(a.state as string) && a.closedAt === null) fail(what);
  if (a.method === 'owner_confirmation' && (binding.subject.kind !== 'human' || (a.decidedBy !== null && (a.decidedBy as { id: string }).id !== binding.subject.id))) fail(what);
  return a as unknown as LedgerApproval;
}

function checkAttempt(raw: unknown, index: number): LedgerAttempt {
  const what = `tentativa ${index}`;
  const t = keys(raw, ['id', 'approvalId', 'component', 'state', 'reservedAt', 'epoch', 'outcomeAt', 'reason'], what);
  if (!isUuid(t.id) || !isUuid(t.approvalId) || !oneOf(RECEIPT_COMPONENTS)(t.component) || !oneOf(ATTEMPT_STATES)(t.state)) fail(what);
  if (!isIso(t.reservedAt) || !isPositive(t.epoch) || !nullable(t.outcomeAt, isIso) || !nullable(t.reason, isReason)) fail(what);
  if ((t.state === 'reserved') !== (t.outcomeAt === null)) fail(what);
  return t as unknown as LedgerAttempt;
}

function checkBarrier(raw: unknown, what: string): Barrier {
  const b = keys(raw, ['engagedAt', 'epoch', 'reason'], what);
  if (!isIso(b.engagedAt) || !isPositive(b.epoch) || !isReason(b.reason)) fail(what);
  return b as unknown as Barrier;
}

export function checkLedgerBody(raw: Record<string, unknown>): LedgerBody {
  if (!Array.isArray(raw.approvals) || !Array.isArray(raw.attempts)) fail('estrutura do ledger');
  const approvals = raw.approvals.map(checkApproval);
  const attempts = raw.attempts.map(checkAttempt);
  if (new Set(approvals.map((a) => a.id)).size !== approvals.length) fail('aprovações duplicadas');
  if (new Set(attempts.map((a) => a.id)).size !== attempts.length) fail('tentativas duplicadas');
  const byId = new Map(approvals.map((a) => [a.id, a]));
  for (const attempt of attempts) {
    const approval = byId.get(attempt.approvalId);
    if (!approval || approval.state !== 'consumed' || approval.attemptId !== attempt.id) fail('tentativa sem aprovação consumida');
  }
  for (const approval of approvals) {
    if (approval.state === 'consumed' && !attempts.some((t) => t.id === approval.attemptId)) fail('aprovação consumida sem tentativa');
  }
  const barriers = keys(raw.barriers, ['global', 'projects'], 'barreiras');
  const global = barriers.global === null ? null : checkBarrier(barriers.global, 'barreira global');
  if (!isPlain(barriers.projects)) fail('barreiras de projeto');
  const projects: Record<string, Barrier> = {};
  for (const [projectId, barrier] of Object.entries(barriers.projects)) {
    if (!UUID.test(projectId)) fail('barreira de projeto');
    projects[projectId] = checkBarrier(barrier, 'barreira de projeto');
  }
  const compaction = keys(raw.compaction, ['lastAt', 'removed'], 'compactação');
  if (!nullable(compaction.lastAt, isIso) || !isCount(compaction.removed)) fail('compactação');
  return { approvals, attempts, barriers: { global, projects }, compaction: compaction as LedgerBody['compaction'] };
}

export function checkLedgerDocument(raw: unknown): LedgerDocument {
  const d = keys(raw, ['format', 'version', 'lineage', 'keyId', 'generation', 'prevHead', 'epoch', 'updatedAt', 'approvals', 'attempts', 'barriers', 'compaction', 'mac'], 'ledger');
  if (d.format !== LEDGER_FORMAT) fail('formato do ledger');
  if (d.version !== DOCUMENT_VERSION) fail('versão do ledger');
  if (!isUuid(d.lineage) || typeof d.keyId !== 'string' || !KEY_ID.test(d.keyId) || !isPositive(d.generation) || !nullable(d.prevHead, isHex64)) fail('cabeçalho do ledger');
  if (!isPositive(d.epoch) || !isIso(d.updatedAt) || !isHex64(d.mac)) fail('cabeçalho do ledger');
  checkLedgerBody(d);
  return d as unknown as LedgerDocument;
}

function checkEntry(raw: unknown, index: number): HistoryItem {
  const what = `histórico ${index}`;
  if (isPlain(raw) && raw.kind === 'tombstone') {
    const t = keys(raw, ['kind', 'firstSeq', 'seq', 'prevHash', 'hash', 'purged'], what);
    if (!isPositive(t.firstSeq) || !isPositive(t.seq) || (t.seq as number) < (t.firstSeq as number) || !nullable(t.prevHash, isHex64) || !isHex64(t.hash)) fail(what);
    if (t.purged !== (t.seq as number) - (t.firstSeq as number) + 1) fail(what);
    return t as unknown as HistoryTombstone;
  }
  const e = keys(raw, ['kind', 'seq', 'at', 'prevHash', 'hash', 'ledgerGeneration', 'event', 'actor', 'approvalId', 'attemptId', 'projectId', 'class', 'action', 'bindingDigest', 'from', 'to', 'reason', 'detail'], what);
  if (e.kind !== 'entry' || !isPositive(e.seq) || !isIso(e.at) || !nullable(e.prevHash, isHex64) || !isHex64(e.hash) || !isCount(e.ledgerGeneration)) fail(what);
  if (!oneOf(APPROVAL_EVENTS)(e.event)) fail(what);
  const actor = keys(e.actor, ['kind', 'id'], what);
  if ((actor.kind !== 'human' && actor.kind !== 'system') || typeof actor.id !== 'string' || !ACTOR_ID.test(actor.id)) fail(what);
  if (!nullable(e.approvalId, isUuid) || !nullable(e.attemptId, isUuid) || !nullable(e.projectId, isUuid)) fail(what);
  if (!nullable(e.class, oneOf(APPROVAL_CLASSES)) || !nullable(e.bindingDigest, isHex64)) fail(what);
  const isAction = (v: unknown): v is string => typeof v === 'string' && ACTION.test(v);
  if (!nullable(e.action, isAction) || !nullable(e.from, isReason) || !nullable(e.to, isReason) || !nullable(e.reason, isReason)) fail(what);
  if (e.detail !== null && (typeof e.detail !== 'string' || e.detail.length > 300 || sanitizeNote(e.detail) !== e.detail)) fail(what);
  if (e.hash !== entryHash(without(e as unknown as HistoryEntry, 'hash'))) fail(`${what} (hash)`);
  return e as unknown as HistoryEntry;
}

export function entryHash(entry: Omit<HistoryEntry, 'hash'>): string {
  return sha256Hex(`acc-approval-history-entry:v1\n${canonicalJson(entry)}`);
}

/** Valida o encadeamento: cada item aponta para o hash do anterior, `seq` contínuo. */
export function checkHistoryBody(raw: Record<string, unknown>): HistoryBody {
  if (!Array.isArray(raw.items) || !Array.isArray(raw.holds)) fail('estrutura do histórico');
  const r = raw.retentionDays;
  if (typeof r !== 'number' || !Number.isSafeInteger(r) || r < HISTORY_RETENTION_DAYS.min || r > HISTORY_RETENTION_DAYS.max) fail('retenção');
  const items = raw.items.map(checkEntry);
  let prev: HistoryItem | null = null;
  for (const item of items) {
    const expectedFirst = prev ? prev.seq + 1 : null;
    const first = item.kind === 'tombstone' ? item.firstSeq : item.seq;
    if (expectedFirst !== null && first !== expectedFirst) fail('sequência do histórico');
    if (prev && item.prevHash !== prev.hash) fail('encadeamento do histórico');
    if (!prev && item.kind === 'entry' && item.seq === 1 && item.prevHash !== null) fail('encadeamento do histórico');
    if (prev && prev.kind === 'tombstone' && item.kind === 'tombstone') fail('lápides adjacentes');
    prev = item;
  }
  const holds = raw.holds.map((h, index) => {
    const what = `preservação ${index}`;
    const o = keys(h, ['id', 'approvalId', 'reason', 'note', 'createdAt', 'createdBy'], what);
    if (!isUuid(o.id) || !isUuid(o.approvalId) || !oneOf(HOLD_REASONS)(o.reason) || !isIso(o.createdAt) || typeof o.createdBy !== 'string' || !HUMAN_ID.test(o.createdBy)) fail(what);
    if (o.note !== null && (typeof o.note !== 'string' || o.note.length > HOLD_NOTE_MAX || sanitizeNote(o.note) !== o.note)) fail(what);
    return o as unknown as Hold;
  });
  return { retentionDays: r, items, holds };
}

export function checkHistoryDocument(raw: unknown): HistoryDocument {
  const d = keys(raw, ['format', 'version', 'lineage', 'keyId', 'retentionDays', 'items', 'holds', 'mac'], 'histórico');
  if (d.format !== HISTORY_FORMAT) fail('formato do histórico');
  if (d.version !== DOCUMENT_VERSION) fail('versão do histórico');
  if (!isUuid(d.lineage) || typeof d.keyId !== 'string' || !KEY_ID.test(d.keyId) || !isHex64(d.mac)) fail('cabeçalho do histórico');
  checkHistoryBody(d);
  if ((d.items as unknown[]).length === 0) fail('histórico vazio');
  return d as unknown as HistoryDocument;
}

export function checkAnchorDocument(raw: unknown): AnchorDocument {
  const d = keys(raw, ['format', 'version', 'lineage', 'keyId', 'epoch', 'ledger', 'history', 'updatedAt', 'mac'], 'anchor');
  if (d.format !== ANCHOR_FORMAT) fail('formato do anchor');
  if (d.version !== DOCUMENT_VERSION) fail('versão do anchor');
  if (!isUuid(d.lineage) || typeof d.keyId !== 'string' || !KEY_ID.test(d.keyId) || !isPositive(d.epoch) || !isIso(d.updatedAt) || !isHex64(d.mac)) fail('cabeçalho do anchor');
  const l = keys(d.ledger, ['generation', 'head'], 'anchor');
  const h = keys(d.history, ['seq', 'head'], 'anchor');
  if (!isPositive(l.generation) || !isHex64(l.head) || !isPositive(h.seq) || !isHex64(h.head)) fail('anchor');
  return d as unknown as AnchorDocument;
}

/**
 * Texto opcional de preservação (N8): remove caracteres de controle e formatação invisível,
 * normaliza (NFC) e colapsa espaços. O chamador recusa se passar de 200 caracteres.
 */
export function sanitizeNote(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const ledgerHead = (doc: LedgerDocument) => sha256Hex(`acc-approval-ledger:v1\n${canonicalJson(without(doc, 'mac'))}`);

export function historyTip(items: HistoryItem[]): { seq: number; head: string } {
  const last = items[items.length - 1];
  return { seq: last.seq, head: last.hash };
}
