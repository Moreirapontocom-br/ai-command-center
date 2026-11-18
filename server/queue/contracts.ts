import { AGENT_IDS, TASK_PRIORITIES, type AgentRef, type TaskPriority } from '../../shared/contracts.ts';

/**
 * Contratos da fila de execução (Issue #012, PR 1 — fundação persistente).
 *
 * Este PR só define e PERSISTE os registros; não há admissão, enfileiramento, agendamento,
 * despacho, rota HTTP nem interface (PR 2). `REAL_EXECUTION_ENABLED` continua `false`.
 *
 * Estados de um item (o PR 2 opera as transições; aqui elas são impostas na gravação):
 * - `queued` → aguardando admissão;
 * - `admitted` → admitido pelo controlador (#022), ainda sem despacho;
 * - `dispatching` → intenção de despacho GRAVADA antes de chamar o executor;
 * - `running` → executor confirmou o início;
 * - `interrupted` → estava em `dispatching`/`running` quando a instância parou: o resultado é
 *   INCERTO e o item NUNCA é retomado automaticamente (só desfecho humano: falha/cancelamento/revogação);
 * - terminais: `succeeded`, `failed`, `cancelled`, `expired`, `revoked` (nunca voltam).
 */
export const QUEUE_ITEM_STATES = ['queued', 'admitted', 'dispatching', 'running', 'interrupted', 'succeeded', 'failed', 'cancelled', 'expired', 'revoked'] as const;
export type QueueItemState = (typeof QUEUE_ITEM_STATES)[number];

export const QUEUE_TERMINAL_STATES: readonly QueueItemState[] = ['succeeded', 'failed', 'cancelled', 'expired', 'revoked'];
/** Estados com execução possivelmente em curso: viram `interrupted` ao reiniciar. */
export const QUEUE_IN_FLIGHT_STATES: readonly QueueItemState[] = ['dispatching', 'running'];

/** Transições permitidas (origem → destinos). Nenhuma leva de volta a `queued`, e terminais não saem. */
export const QUEUE_TRANSITIONS: Readonly<Record<QueueItemState, readonly QueueItemState[]>> = {
  queued: ['admitted', 'cancelled', 'expired', 'revoked'],
  admitted: ['dispatching', 'cancelled', 'expired', 'revoked'],
  dispatching: ['running', 'failed', 'cancelled', 'interrupted', 'revoked'],
  running: ['succeeded', 'failed', 'cancelled', 'interrupted', 'revoked'],
  interrupted: ['failed', 'cancelled', 'revoked'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
  revoked: [],
};

export const QUEUE_PRIORITIES = TASK_PRIORITIES;
export type QueuePriority = TaskPriority;
export const QUEUE_AGENTS = AGENT_IDS;
export const MAX_QUEUE_ITEMS = 10_000;
export const MAX_PENDING_BARRIERS = 64;

export interface QueueItem {
  id: string;
  /** Chave de idempotência do pedido (única por dono). */
  idempotencyKey: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  priority: QueuePriority;
  state: QueueItemState;
  /** Quantas vezes houve intenção de despacho (0 enquanto não despachado). */
  attempt: number;
  /** Aprovação de execução da #011 (obrigatória a partir de `admitted`). */
  approvalId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Época em que o estado atual foi gravado. */
  stateEpoch: number;
  /** Motivo-token da última transição (`null` só em `queued` recém-criado). */
  reason: string | null;
  /** Preenchido só nos estados terminais. */
  closedAt: string | null;
}

export type BarrierScope = { kind: 'global' } | { kind: 'project'; projectId: string };

/**
 * Pedido de barreira AINDA NÃO CONFIRMADO como durável na autoridade (#011). Enquanto existir, a
 * fila está bloqueada no escopo, e a cada abertura o pedido é reenviado à autoridade. Só restringe:
 * é removido apenas depois que a barreira durável foi confirmada — nunca libera nada.
 */
export interface PendingBarrier {
  scope: BarrierScope;
  reason: string;
  requestedAt: string;
  epoch: number;
}

export interface QueueBody {
  items: QueueItem[];
  pendingBarriers: PendingBarrier[];
}

export const QUEUE_EVENTS = [
  'queue.store_initialized',
  'queue.store_opened',
  'queue.store_recovered',
  'queue.lock_recovered',
  'queue.history_unapplied',
  'queue.item_recorded',
  'queue.item_transition',
  'queue.item_interrupted',
  'queue.item_expired',
  'queue.barrier_requested',
  'queue.barrier_confirmed',
] as const;
export type QueueEvent = (typeof QUEUE_EVENTS)[number];

export interface QueueHistoryData {
  event: QueueEvent;
  actor: { kind: 'human' | 'system'; id: string };
  itemId: string | null;
  projectId: string | null;
  from: QueueItemState | null;
  to: QueueItemState | null;
  reason: string | null;
  /** Valores curtos e saneados (identificadores, contagens). */
  detail: string | null;
}

export const QUEUE_SYSTEM_ACTOR = { kind: 'system' as const, id: 'acc-queue' };

export class QueueError extends Error {
  name = 'QueueError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Interface ESTREITA da autoridade de barreira (núcleo de aprovações #011, adaptado no `index.ts`).
 * É a única que pode LIBERAR execução; a fila só a consulta e pede acionamentos.
 */
export interface BarrierAuthority {
  status(): { state: 'available' | 'degraded' | 'unavailable'; reason: string | null };
  barriers(): { durable: { global: unknown; projects: Record<string, unknown> }; volatile: readonly string[] };
  engage(input: { scope: BarrierScope; actor: { kind: 'system'; id: string }; reason: string }): Promise<void>;
}

/** A autoridade confirma a barreira DURÁVEL no escopo? Qualquer erro ou dúvida → `false`. */
export function authorityConfirms(authority: BarrierAuthority | null | undefined, scope: BarrierScope): boolean {
  try {
    if (!authority || authority.status().state !== 'available') return false;
    const durable = authority.barriers().durable;
    if (!durable || typeof durable !== 'object') return false;
    if (scope.kind === 'global') return durable.global !== null && durable.global !== undefined;
    const projects = durable.projects;
    return typeof projects === 'object' && projects !== null && Object.hasOwn(projects, scope.projectId) && projects[scope.projectId] != null;
  } catch {
    return false;
  }
}

export const isTerminal = (state: QueueItemState) => QUEUE_TERMINAL_STATES.includes(state);
export const scopeKey = (scope: BarrierScope) => (scope.kind === 'global' ? 'global' : `project:${scope.projectId}`);
