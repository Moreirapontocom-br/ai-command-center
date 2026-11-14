import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  type AuditAction,
  type AuditActor,
  type AuditContextValue,
  type AuditEvent,
  type AuditOutcome,
} from '../../shared/contracts.ts';
import { isIsoDate } from '../storage/jsonFile.ts';

/**
 * Construção e validação de eventos de auditoria (Issue #006).
 *
 * Proteção contra contaminação: `context` aceita apenas chaves de uma lista fixa e valores do tipo
 * "token" (`[A-Za-z0-9_:.-]`, até 64 caracteres), números finitos, booleanos ou `null`, além de
 * listas curtas de tokens. Texto livre (títulos, descrições, e-mails, mensagens de erro), cabeçalhos,
 * cookies, senhas, hashes e tokens não cabem nesse formato. Isso vale tanto ao criar quanto ao
 * ler o arquivo.
 */

/** Evento armazenado: o público mais o dono (`null` = evento da instância, visível ao administrador). */
export interface StoredAuditEvent extends AuditEvent {
  ownerId: string | null;
}

export interface AuditEventInput {
  action: AuditAction;
  actor: AuditActor;
  ownerId: string | null;
  projectId: string | null;
  resource: AuditEvent['resource'];
  outcome: AuditOutcome;
  context?: Record<string, AuditContextValue>;
}

/** Sequência global (um processo): cada store informa o maior `seq` lido para continuar dali. */
export interface AuditSequence {
  next(): number;
  observe(seq: number): void;
}

export function createAuditSequence(): AuditSequence {
  let last = 0;
  return {
    next: () => (last += 1),
    observe: (seq) => {
      if (seq > last) last = seq;
    },
  };
}

const TOKEN = /^[A-Za-z0-9_:.-]{1,64}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACTOR_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const RESOURCE_TYPES = ['project', 'task', 'session', 'route'] as const;

/** Chaves de contexto permitidas. Novas chaves exigem revisão (e entram aqui). */
export const CONTEXT_KEYS = [
  'from',
  'to',
  'fields',
  'status',
  'priority',
  'origin',
  'reason',
  'route',
  'method',
  'evidence',
  'cleared',
  'hadSession',
  'policyAction',
  'decision',
  'risk',
  'rule',
] as const;

function isContextValue(value: unknown): value is AuditContextValue {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return TOKEN.test(value);
  return Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && TOKEN.test(item));
}

export function isValidContext(context: unknown): context is Record<string, AuditContextValue> {
  if (typeof context !== 'object' || context === null || Array.isArray(context)) return false;
  return Object.entries(context).every(
    ([key, value]) => (CONTEXT_KEYS as readonly string[]).includes(key) && isContextValue(value),
  );
}

function isActor(value: unknown): value is AuditActor {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    Object.keys(a).length === 2 &&
    (a.kind === 'human' || a.kind === 'agent' || a.kind === 'system') &&
    typeof a.id === 'string' &&
    ACTOR_ID.test(a.id)
  );
}

/** Monta um evento válido. Lança erro de programação se algum campo violar o formato. */
export function makeEvent(input: AuditEventInput, seq: number, at: string): StoredAuditEvent {
  const event: StoredAuditEvent = {
    id: randomUUID(),
    seq,
    at,
    action: input.action,
    actor: { kind: input.actor.kind, id: input.actor.id },
    ownerId: input.ownerId,
    projectId: input.projectId,
    resource: { type: input.resource.type, id: input.resource.id },
    outcome: input.outcome,
    context: { ...(input.context ?? {}) },
  };
  if (!validateEvent(event)) throw new Error('Evento de auditoria fora do formato permitido.');
  return event;
}

export function validateEvent(raw: unknown): raw is StoredAuditEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  const keys = ['id', 'seq', 'at', 'action', 'actor', 'ownerId', 'projectId', 'resource', 'outcome', 'context'];
  if (Object.keys(e).length !== keys.length || !keys.every((key) => key in e)) return false;
  const resource = e.resource as Record<string, unknown> | null;
  return (
    typeof e.id === 'string' &&
    ID.test(e.id) &&
    typeof e.seq === 'number' &&
    Number.isSafeInteger(e.seq) &&
    e.seq > 0 &&
    isIsoDate(e.at) &&
    (AUDIT_ACTIONS as readonly unknown[]).includes(e.action) &&
    isActor(e.actor) &&
    (e.ownerId === null || (typeof e.ownerId === 'string' && ACTOR_ID.test(e.ownerId))) &&
    (e.projectId === null || (typeof e.projectId === 'string' && ID.test(e.projectId))) &&
    typeof resource === 'object' &&
    resource !== null &&
    Object.keys(resource).length === 2 &&
    (RESOURCE_TYPES as readonly unknown[]).includes(resource.type) &&
    (resource.id === null || (typeof resource.id === 'string' && TOKEN.test(resource.id))) &&
    (AUDIT_OUTCOMES as readonly unknown[]).includes(e.outcome) &&
    isValidContext(e.context)
  );
}

/** Lista de eventos persistida junto de outro documento, com o total já descartado por retenção. */
export interface EventLog {
  events: StoredAuditEvent[];
  droppedEvents: number;
}

/**
 * Valida a lista de eventos de um arquivo: formato de cada evento, ids e `seq` únicos e ordem
 * crescente. Informa a sequência global do maior `seq` lido.
 */
export function validateEventLog(raw: unknown, dropped: unknown, sequence: AuditSequence, corrupt: (detail: string) => never): EventLog {
  if (!Array.isArray(raw)) corrupt('eventos de auditoria');
  if (typeof dropped !== 'number' || !Number.isSafeInteger(dropped) || dropped < 0) corrupt('contador de retenção');
  const events = raw as unknown[];
  events.forEach((event, index) => {
    if (!validateEvent(event)) corrupt(`evento de auditoria ${index}`);
  });
  const typed = events as StoredAuditEvent[];
  for (let i = 1; i < typed.length; i += 1) {
    if (typed[i].seq <= typed[i - 1].seq) corrupt(`ordem dos eventos de auditoria (${i})`);
  }
  if (new Set(typed.map((e) => e.id)).size !== typed.length) corrupt('ids de eventos duplicados');
  for (const event of typed) sequence.observe(event.seq);
  return { events: typed, droppedEvents: dropped as number };
}

/**
 * Retenção: mantém no máximo `max` eventos. Primeiro descarta os mais antigos de clientes não
 * autenticados (`actor.id === 'anonymous'`), para que ruído externo não empurre para fora o
 * histórico atribuível; depois, os mais antigos em geral. O total descartado fica registrado.
 */
export function applyRetention(log: EventLog, max: number) {
  let excess = log.events.length - max;
  if (excess <= 0) return;
  log.droppedEvents += excess;
  const kept: StoredAuditEvent[] = [];
  for (const event of log.events) {
    if (excess > 0 && event.actor.kind === 'system' && event.actor.id === 'anonymous') {
      excess -= 1;
      continue;
    }
    kept.push(event);
  }
  log.events = excess > 0 ? kept.slice(excess) : kept;
}

/** Converte para o formato público (sem `ownerId`), como cópia. */
export function toPublicEvent({ ownerId: _ownerId, ...event }: StoredAuditEvent): AuditEvent { // eslint-disable-line @typescript-eslint/no-unused-vars
  return structuredClone(event);
}
