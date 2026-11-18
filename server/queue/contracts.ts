import { AGENT_IDS, TASK_PRIORITIES, type AgentRef, type TaskPriority } from '../../shared/contracts.ts';

/**
 * Contratos da fila de execução (Issue #012, PR 1 — fundação persistente).
 *
 * PR 1 definiu e PERSISTE os registros. PR 2 acrescenta a extensão `run` (pedido, reserva,
 * despacho, vaga, desfecho) e o agendador DORMENTE (`scheduler.ts`), acionado só por `tick()`
 * explícito, com executor simulado. Sem rota HTTP, interface ou temporizador;
 * `REAL_EXECUTION_ENABLED` continua `false`.
 *
 * Estados de um item (o agendador opera as transições; aqui elas são impostas na gravação):
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
  // PR 2 (Q5): `queued → failed` SÓ para recusa DEFINITIVA classificada (imposto em `checkQueueChange`).
  queued: ['admitted', 'failed', 'cancelled', 'expired', 'revoked'],
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
  /**
   * Extensão do PR 2 (agendamento). AUSENTE nos documentos gravados pelo PR 1 (Q10): itens sem ela
   * nunca são admitidos (faltam parâmetros, reserva e aprovações — nada é inventado); quando
   * presente, é validada por inteiro, sem valores padrão.
   */
  run?: QueueRun;
}

/** Validade de um item `queued` (Q9). */
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
/** Janela entre a admissão e o despacho (Q9). */
export const ADMITTED_WINDOW_MS = 60 * 1000;
/** Tentativas totais por tarefa, incluindo a inicial (Q6). */
export const MAX_CHAIN_ATTEMPTS = 3;
/** Backoff progressivo dos reintentos (Q6): 30 s, 60 s, … com teto de 10 min. */
export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_CAP_MS = 10 * 60 * 1000;
export const retryDelayMs = (chainAttempt: number) => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, chainAttempt - 2), RETRY_CAP_MS);

/** Estados em que a vaga do controlador PODE estar ocupada. */
export const QUEUE_HOLDING_STATES: readonly QueueItemState[] = ['admitted', 'dispatching', 'running', 'interrupted'];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Parâmetros da admissão no controlador (#022), validados semanticamente pela `AdmissionPort`. */
export interface QueueAdmissionParams {
  action: string;
  mode: string;
  durationSeconds: number;
  estimatedCostMinor: number | null;
  maxTokens: number | null;
}

/** Pedido gravado na submissão: imutável; a impressão digital cobre admissão + execução. */
export interface QueueRequest {
  fingerprint: string;
  admission: QueueAdmissionParams;
  /** Parâmetros do executor (simulado), validados semanticamente pela `ExecutorPort`. */
  execution: { [key: string]: JsonValue };
}

export const COST_STATUSES = ['none', 'estimated', 'confirmed', 'unknown'] as const;

/**
 * Reserva e compromisso do controlador para ESTE item (Q1): fonte de verdade para reconstruir o
 * controlador após reinício. Imutável, exceto o custo, que só muda junto com a liberação da vaga.
 */
export interface AdmissionSnapshot {
  admissionId: string;
  admittedAt: string;
  /** Prazo lógico da admissão no controlador. */
  deadline: string;
  /** Limite para o despacho (admittedAt + 60 s). */
  dispatchBy: string;
  /** Aprovações consumidas na admissão (a primeira é a de `item.approvalId`). */
  approvalIds: string[];
  cost: { status: (typeof COST_STATUSES)[number]; reservedMinor: number; confirmedMinor: number | null };
  tokensCeiling: number | null;
  /** Impressão digital dos limites vigentes na admissão (Q2). */
  limitsFingerprint: string;
  /** Impressão digital do pedido no controlador (idempotência restaurada). */
  controllerFingerprint: string;
}

/** Intenção de despacho, gravada ANTES de chamar o executor (G1). */
export interface DispatchRecord {
  /** Token único por tentativa. */
  token: string;
  at: string;
  /** Época da fila em que o despacho foi gravado. */
  epoch: number;
  /** Confirmação de início pelo executor. */
  startedAt: string | null;
  executionRef: string | null;
}

export const CANCELLATION_RESULTS = ['pending', 'cancelled', 'not_supported', 'failed'] as const;
export type QueueCancellationResult = (typeof CANCELLATION_RESULTS)[number];

/**
 * Desfecho classificado (rastreável):
 * - `refused_definitive`: recusa definitiva antes da admissão (Q5);
 * - `not_dispatched`: admitido e nunca despachado (expirou/foi revogado/reinício);
 * - `not_started`: o executor comprovou que NÃO iniciou (única base para reintento, Q6);
 * - `uncertain`: resultado do despacho incerto (timeout, erro, ausência de resposta);
 * - `completed` / `failed_after_start`: término informado pelo executor;
 * - `stop_confirmed`: o executor confirmou a parada após pedido de cancelamento;
 * - `ended_after_interruption`: o executor comprovou o término de um item `interrupted`.
 */
export const OUTCOME_KINDS = ['refused_definitive', 'not_dispatched', 'not_started', 'uncertain', 'completed', 'failed_after_start', 'stop_confirmed', 'ended_after_interruption'] as const;
export type QueueOutcomeKind = (typeof OUTCOME_KINDS)[number];

export interface QueueOutcome {
  kind: QueueOutcomeKind;
  reason: string;
  /** Só `not_started` pode ser reintentável. */
  retryable: boolean;
  at: string;
}

export const CAPACITY_STATES = ['none', 'held', 'released'] as const;

export interface QueueRun {
  version: 1;
  request: QueueRequest;
  expiresAt: string;
  /** Backoff: não é admitido antes disto. */
  notBefore: string | null;
  /** Item anterior (reintento por sucessor, Q6). */
  retryOf: string | null;
  /** Tentativa na cadeia de reintentos (1..3). */
  chainAttempt: number;
  /** Admissão possivelmente em curso no controlador (contabilizada de forma conservadora). */
  admissionIntentAt: string | null;
  admission: AdmissionSnapshot | null;
  dispatch: DispatchRecord | null;
  cancellation: { requestedAt: string; result: QueueCancellationResult } | null;
  /** Ocupação da vaga: `held` até término comprovado. */
  capacity: (typeof CAPACITY_STATES)[number];
  outcome: QueueOutcome | null;
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
  // PR 2 (agendamento).
  'queue.item_submitted',
  'queue.admission_refused',
  'queue.dispatch_intent',
  'queue.dispatch_result',
  'queue.cancel_requested',
  'queue.result_recorded',
  'queue.result_ignored',
  'queue.retry_scheduled',
  'queue.capacity_released',
  'queue.restore_completed',
  'queue.restore_blocked',
  'queue.killswitch_engaged',
  'queue.settlement_divergence',
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
