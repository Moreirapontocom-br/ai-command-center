import type { AdmissionSnapshot, BarrierScope, JsonValue, QueueAdmissionParams, QueueCancellationResult, QueueItemState } from './contracts.ts';

/**
 * Interfaces ESTREITAS do agendador (Issue #012, PR 2). Só tipos: este arquivo é o único da fila que
 * os adaptadores (`server/limits/queueAdmission.ts`, `server/sandbox/queueExecutor.ts`) importam.
 * A fila nunca importa o controlador (#022), o sandbox (#021) nem o núcleo de aprovações (#011): as
 * implementações são injetadas (teste estrutural em `security.test.ts`).
 */

/** Identidade e vínculo de um item (o que os adaptadores podem ver). */
export interface QueueSubject {
  itemId: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: string;
}

/** Recusa de um adaptador: só um código (token), classificado pela fila (`classification.ts`). */
export interface PortRefusal {
  ok: false;
  code: string;
}

/** Projeto/tarefa do dono (Issues #004/#005). */
export interface TaskLookup {
  check(input: { ownerId: string; projectId: string; taskId: string; agentId: string }): 'ok' | 'not_found' | 'task_not_active' | 'agent_not_assigned';
}

/** Registro da fila entregue à restauração do controlador (Q1): só o que está gravado. */
export interface AdmissionRestoreRecord extends QueueSubject {
  state: QueueItemState;
  params: QueueAdmissionParams;
  /** Reserva gravada (ausente se nunca admitido). */
  snapshot: AdmissionSnapshot | null;
  /** Admissão possivelmente feita e não gravada (conta nos limites, sem reserva inventada). */
  intentAt: string | null;
  capacity: 'none' | 'held' | 'released';
  closedAt: string | null;
  cancellation: { requestedAt: string; result: QueueCancellationResult } | null;
}

export type AdmissionDraft = Omit<AdmissionSnapshot, 'dispatchBy'>;

/** Usage informado pelo executor (simulado: nunca há cobrança). */
export interface ExecutionUsage {
  cost: { kind: 'none' } | { kind: 'unknown' } | { kind: 'confirmed'; amountMinor: number };
  tokens: number | null;
}

/**
 * Evidência DURÁVEL (registros existentes, nunca uma fonte nova) dos limites em vigor antes do
 * reinício (R3): nenhuma alteração jamais aplicada; última alteração aplicada (impressão digital);
 * ou impossível comprovar.
 */
export type LimitsEvidence = { kind: 'never_changed' } | { kind: 'last_applied'; fingerprint: string } | { kind: 'unknown' };

/** Controlador de orçamento, quotas e kill switch (#022), adaptado. */
export interface AdmissionPort {
  /** Impressão digital dos limites em vigor AGORA (Q2). */
  limitsFingerprint(): string;
  /** Evidência dos limites anteriores ao reinício (R3). Ausente/erro = `unknown` = bloqueado. */
  limitsEvidence(): LimitsEvidence;
  /** Validação semântica dos parâmetros na submissão. */
  validate(params: QueueAdmissionParams): { ok: true } | PortRefusal;
  /** Reconstrói o controlador a partir dos registros da fila. Lança se não puder comprovar (Q2). */
  restore(records: readonly AdmissionRestoreRecord[]): void;
  /** Admissão com a aprovação própria do controlador (Q3). Idempotente por `key`. */
  admit(input: QueueSubject & { key: string; params: QueueAdmissionParams }): Promise<{ ok: true; draft: AdmissionDraft } | PortRefusal>;
  /** Libera a reserva de uma admissão comprovadamente NUNCA despachada. */
  releaseNotDispatched(subject: QueueSubject, admissionId: string): Promise<void>;
  /** Término comprovado pelo executor: libera a vaga e reconcilia o custo. */
  settle(subject: QueueSubject, admissionId: string, outcome: 'completed' | 'failed' | 'stopped', usage: ExecutionUsage): AdmissionSnapshot['cost'];
  /** Kill switch do controlador (bloqueio imediato em memória). */
  engageKillSwitch(scope: BarrierScope, reason: string): Promise<void>;
  killSwitchEngaged(projectId: string | null): boolean;
}

/**
 * Resultado de um despacho:
 * - `started`: o executor confirmou o início;
 * - `not_started`: o executor COMPROVA que nada começou (única base para reintento, Q6);
 * - `uncertain`: qualquer outra coisa (erro, timeout, falha parcial) — nunca é reintentado.
 */
export type DispatchResult = { kind: 'started'; executionRef: string } | { kind: 'not_started'; code: string; retryable: boolean } | { kind: 'uncertain'; code: string };

/** Resultado entregue a `onResult` (validado por token, tentativa, época e item). */
export interface ExecutionResult {
  itemId: string;
  token: string;
  attempt: number;
  epoch: number;
  outcome: 'succeeded' | 'failed';
  reason: string | null;
  usage: ExecutionUsage;
  /**
   * Prova de ORIGEM (Issue #028, I8): emitida pelo executor que despachou, nunca gravada no ledger
   * da fila. Obrigatória quando o executor declara `verifyResult`.
   */
  proof?: string;
}

/** Executor (sandbox SIMULADO nesta fase; `REAL_EXECUTION_ENABLED = false`). */
export interface ExecutorPort {
  readonly kind: 'simulated';
  validate(subject: Omit<QueueSubject, 'itemId'>, params: { [key: string]: JsonValue }): { ok: true } | PortRefusal;
  /** Preparação com a aprovação PRÓPRIA da execução (`sandbox.execute`, Q3). Idempotente por item. */
  prepare(subject: QueueSubject, params: { [key: string]: JsonValue }): Promise<{ status: 'ready' } | { status: 'pending'; code: string } | { status: 'refused'; code: string }>;
  /** Despacho idempotente por token: o mesmo token nunca inicia duas vezes (G1). */
  dispatch(input: QueueSubject & { token: string; attempt: number; epoch: number }): Promise<DispatchResult>;
  /** Pedido de cancelamento; `cancelled` = parada CONFIRMADA. */
  cancel(subject: QueueSubject): Promise<'cancelled' | 'not_supported' | 'failed'>;
  /** Descarta uma preparação nunca despachada (melhor esforço). */
  discard(subject: QueueSubject): Promise<void>;
  /**
   * Autenticação da ORIGEM de um resultado (Issue #028, I8). Quando presente, a fila só aceita o
   * resultado se o executor confirmar que foi ele quem o produziu (prova de uso único). Ausente =
   * comportamento da #012 (vínculo por token, tentativa e época).
   */
  verifyResult?(result: ExecutionResult): boolean;
}
