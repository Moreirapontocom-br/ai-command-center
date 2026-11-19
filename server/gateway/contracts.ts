import { AGENT_IDS, type AgentRef } from '../../shared/contracts.ts';
import { PRESENTATION_GATEWAY_CAPABILITIES, PRESENTATION_GATEWAY_CHANNELS, PRESENTATION_GATEWAY_MAX, PRESENTATION_INPUT_KINDS } from '../../shared/approvalPresentation.ts';
import { USAGE_MODES, type UsageMode } from '../limits/contracts.ts';

/**
 * Contratos do Agent Gateway (Issue #028) — núcleo DORMENTE e SIMULADO.
 *
 * - Nenhum provedor real: só adaptadores `simulated` (nada sai do ACC) e o canal `assisted`, em que
 *   uma PESSOA autenticada leva o pacote à ferramenta da própria assinatura e traz o resultado.
 * - Nenhuma credencial, rede, subprocesso ou rota HTTP (teste estrutural em `security.test.ts`).
 * - Toda invocação exige um ESCOPO DE TAREFA ativo (I1): criado por uma aprovação humana autêntica
 *   e de uso único da #011, com agente, projeto, tarefa, operações, dados, validade, número de
 *   invocações e orçamento delimitados. O escopo nunca dura mais que a aprovação que o criou.
 * - Entradas e saídas de agentes são DADOS NÃO CONFIÁVEIS: nunca escolhem escopo, agente, destino,
 *   ferramenta ou política.
 */

export const GATEWAY_CAPABILITIES = PRESENTATION_GATEWAY_CAPABILITIES;
export type AgentCapability = (typeof GATEWAY_CAPABILITIES)[number];

/** Canal: `simulated` (adaptador interno, sem envio externo) ou `assisted` (pessoa no meio). */
export const GATEWAY_CHANNELS = PRESENTATION_GATEWAY_CHANNELS;
export type GatewayChannel = (typeof GATEWAY_CHANNELS)[number];

export const GATEWAY_INPUT_KINDS = PRESENTATION_INPUT_KINDS;
export type GatewayInputKind = (typeof GATEWAY_INPUT_KINDS)[number];

export const GATEWAY_AGENTS = AGENT_IDS;
export const GATEWAY_USAGE_MODES = USAGE_MODES;

/** Limites (conservadores). Ampliar qualquer um exige PR revisado. */
export const GATEWAY_LIMITS = {
  dataRefs: PRESENTATION_GATEWAY_MAX.dataRefs,
  maxInvocations: PRESENTATION_GATEWAY_MAX.invocations,
  /** Validade PEDIDA de um escopo; a efetiva é limitada pela validade das aprovações. */
  maxValiditySeconds: PRESENTATION_GATEWAY_MAX.validitySeconds,
  minValiditySeconds: 60,
  maxOutputBytes: PRESENTATION_GATEWAY_MAX.outputBytes,
  maxBudgetMinor: PRESENTATION_GATEWAY_MAX.budgetMinor,
  /** Instruções da pessoa (texto curto, tratado como dado). */
  maxInstructionBytes: 4 * 1024,
  /** Conteúdo resolvido de cada referência de dados. */
  maxRefBytes: 16 * 1024,
  /** Pacote assistido completo. */
  maxPackageBytes: 128 * 1024,
  /** Prazo de uma invocação simulada. */
  maxTimeoutSeconds: 10 * 60,
  /** Janela para a pessoa trazer o resultado de um pacote liberado (I4). Não renova autorização. */
  relayWindowMs: 24 * 60 * 60 * 1000,
  /** Retenção dos conteúdos (P3): padrão conservador e faixa permitida. */
  contentRetentionDays: { default: 30, min: 1, max: 90 },
  maxRecords: 10_000,
} as const;

export const SCOPE_STATES = ['awaiting_approval', 'activating', 'active', 'failed', 'exhausted', 'expired', 'revoked'] as const;
export type ScopeState = (typeof SCOPE_STATES)[number];
export const SCOPE_TRANSITIONS: Readonly<Record<ScopeState, readonly ScopeState[]>> = Object.freeze({
  awaiting_approval: ['activating', 'failed', 'expired', 'revoked'],
  // `activating → awaiting_approval`: aprovação ainda pendente (nada consumido).
  activating: ['active', 'failed', 'awaiting_approval'],
  active: ['exhausted', 'expired', 'revoked'],
  failed: [],
  exhausted: ['expired', 'revoked'],
  expired: [],
  revoked: [],
});

export const INVOCATION_STATES = ['requested', 'queued', 'dispatched', 'succeeded', 'failed', 'uncertain', 'cancelled', 'interrupted', 'refused'] as const;
export type InvocationState = (typeof INVOCATION_STATES)[number];
export const INVOCATION_TERMINAL: readonly InvocationState[] = ['succeeded', 'failed', 'uncertain', 'cancelled', 'interrupted', 'refused'];
export const INVOCATION_TRANSITIONS: Readonly<Record<InvocationState, readonly InvocationState[]>> = Object.freeze({
  requested: ['queued', 'refused', 'interrupted'],
  queued: ['dispatched', 'refused', 'cancelled'],
  dispatched: ['succeeded', 'failed', 'uncertain', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  uncertain: [],
  cancelled: [],
  interrupted: [],
  refused: [],
});

/**
 * Handoff do fluxo assistido (D5/I4). Nenhum estado ocupa vaga automática da fila: só a INGESTÃO
 * do resultado (`relayed → validated`) passa pela fila, como item próprio e curto.
 */
export const HANDOFF_STATES = ['prepared', 'awaiting_relay', 'relayed', 'validated', 'rejected', 'expired', 'revoked'] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];
export const HANDOFF_TERMINAL: readonly HandoffState[] = ['validated', 'rejected', 'expired', 'revoked'];
export const HANDOFF_TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = Object.freeze({
  prepared: ['awaiting_relay', 'expired', 'revoked'],
  awaiting_relay: ['relayed', 'rejected', 'expired', 'revoked'],
  relayed: ['validated', 'rejected', 'revoked'],
  validated: [],
  rejected: [],
  expired: [],
  revoked: [],
});

export const CONTENT_KINDS = ['package', 'relayed_result', 'agent_output'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** Referência de dados autorizada (o conteúdo é resolvido pelo servidor, nunca pelo chamador). */
export interface GatewayDataRef {
  kind: GatewayInputKind;
  ref: string;
}

/** Escopo de tarefa (I1). Persistido no ledger assinado; imutável exceto estado e contadores. */
export interface GatewayScope {
  id: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentIds: AgentRef[];
  capabilities: AgentCapability[];
  dataRefs: GatewayDataRef[];
  channel: GatewayChannel;
  mode: UsageMode;
  externalSharing: boolean;
  maxInvocations: number;
  budgetMinor: number;
  validitySeconds: number;
  maxOutputBytes: number;
  /** Resumo dos parâmetros (o mesmo `paramsDigest` das aprovações). */
  paramsDigest: string;
  /** Versão da política (#020) em vigor no pedido; outra versão invalida o escopo. */
  policyVersion: string;
  state: ScopeState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  /** Prazo para a aprovação (enquanto `awaiting_approval`). */
  approvalDeadline: string;
  /** Validade EFETIVA (mínimo entre a pedida e a das aprovações). `null` antes de ativar. */
  validUntil: string | null;
  /**
   * Aprovações originais (#011) consumidas na ativação: id, resumo do vínculo e do grant, e o
   * aprovador autenticado. Uma por ação (`agent.invoke` e, se houver envio externo, `data.send_external`).
   */
  approvals: Array<{ action: 'agent.invoke' | 'data.send_external'; approvalId: string; bindingDigest: string; grantDigest: string; approverId: string; expiresAt: string }>;
  usedInvocations: number;
  spentMinor: number;
}

/** Proveniência obrigatória de todo resultado (§4.3 da especificação). */
export interface GatewayProvenance {
  provider: AgentRef;
  mode: UsageMode;
  channel: GatewayChannel;
  adapter: { id: string; version: string; kind: 'simulated' | 'assisted' };
  /** O que o provedor (ou a pessoa) declarou; nunca verificado. */
  modelReported: string | null;
  requestDigest: string;
  responseDigest: string | null;
  startedAt: string;
  finishedAt: string | null;
  relayedBy: { kind: 'human'; id: string } | null;
}

export interface GatewayUsage {
  cost: { kind: 'none' } | { kind: 'unknown' } | { kind: 'confirmed'; amountMinor: number };
  tokens: number | null;
}

/** Invocação de um adaptador simulado (canal `simulated`), executada pela fila (D6). */
export interface GatewayInvocation {
  id: string;
  idempotencyKey: string;
  requestDigest: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  scopeId: string;
  capability: AgentCapability;
  inputs: GatewayDataRef[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  state: InvocationState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  queueItemId: string | null;
  outputContentId: string | null;
  provenance: GatewayProvenance | null;
  usage: GatewayUsage | null;
}

/** Handoff do fluxo assistido (canal `assisted`). */
export interface GatewayHandoff {
  id: string;
  idempotencyKey: string;
  requestDigest: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  scopeId: string;
  capability: AgentCapability;
  inputs: GatewayDataRef[];
  maxOutputBytes: number;
  state: HandoffState;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  packageContentId: string;
  packageDigest: string;
  releasedAt: string | null;
  releasedBy: string | null;
  /** Prazo para trazer o resultado (só depois da liberação). */
  relayDeadline: string | null;
  resultContentId: string | null;
  resultDigest: string | null;
  ingestQueueItemId: string | null;
  provenance: GatewayProvenance | null;
}

/** Referência auditável de um conteúdo cifrado (P3). O conteúdo nunca vai para o ledger. */
export interface GatewayContentRef {
  id: string;
  ownerId: string;
  projectId: string;
  kind: ContentKind;
  /** Registro de origem (handoff ou invocação). */
  sourceId: string;
  digest: string;
  bytes: number;
  createdAt: string;
  expiresAt: string;
  state: 'stored' | 'deleted';
  deletedAt: string | null;
  deletedReason: string | null;
}

export interface GatewayBody {
  scopes: GatewayScope[];
  invocations: GatewayInvocation[];
  handoffs: GatewayHandoff[];
  contents: GatewayContentRef[];
}

export const GATEWAY_EVENTS = [
  'gateway.store_initialized',
  'gateway.store_opened',
  'gateway.scope_requested',
  'gateway.scope_activated',
  'gateway.scope_activation_failed',
  'gateway.scope_closed',
  'gateway.invocation',
  'gateway.invocation_refused',
  'gateway.invocation_result',
  'gateway.handoff',
  'gateway.handoff_released',
  'gateway.handoff_relayed',
  'gateway.handoff_closed',
  'gateway.content_stored',
  'gateway.content_deleted',
  'gateway.provider_status',
  'gateway.interrupted',
] as const;
export type GatewayEvent = (typeof GATEWAY_EVENTS)[number];

/** Entrada do histórico: só tokens, ids e resumos (nunca conteúdo, instruções ou credenciais). */
export interface GatewayHistoryData {
  event: GatewayEvent;
  actor: { kind: 'human' | 'system'; id: string };
  projectId: string | null;
  ref: string | null;
  reason: string;
  detail: string | null;
}

/** Pedido de invocação (§4.2). `ownerId` vem SEMPRE da sessão/servidor, nunca do corpo. */
export interface AgentTaskRequest {
  idempotencyKey: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  scopeId: string;
  capability: AgentCapability;
  inputs: GatewayDataRef[];
  instructions: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

/** Resultado padronizado (§4.3). A saída é dado não confiável; o conteúdo fica cifrado (P3). */
export interface AgentTaskResult {
  invocationId: string;
  idempotencyKey: string;
  outcome: 'succeeded' | 'failed' | 'needs_human' | 'unavailable';
  reason: string | null;
  output: { kind: 'text'; bytes: number; digest: string; contentId: string; trust: 'untrusted' } | null;
  provenance: GatewayProvenance | null;
  usage: GatewayUsage | null;
}

/** Recusa ou estado de um adaptador antes de qualquer envio (nada foi processado). */
export type AdapterAvailability = { ok: true } | { ok: false; code: 'provider_unavailable' | 'rate_limited' | 'quota_exhausted'; retryable: boolean; until: string | null };

export type AdapterOutcome =
  | { kind: 'succeeded'; text: string; modelReported: string | null; usage: GatewayUsage }
  | { kind: 'failed'; code: string; usage: GatewayUsage }
  | { kind: 'aborted' };

/**
 * Adaptador de provedor. Nesta fase só existe o simulado: `kind` é sempre `simulated`, sem rede,
 * sem credencial e sem execução externa. Um adaptador `official` exigirá PR próprio aprovado.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly version: string;
  readonly kind: 'simulated';
  readonly provider: AgentRef;
  readonly capabilities: readonly AgentCapability[];
  /** `false` para o Nemotron: a falta dele nunca bloqueia os demais (§3.6). */
  readonly required: boolean;
  availability(): AdapterAvailability;
  /** Processa o pacote (texto já sanitizado). Deve respeitar `signal` (cancelamento/timeout). */
  invoke(input: { capability: AgentCapability; text: string; maxOutputBytes: number }, signal: AbortSignal): Promise<AdapterOutcome>;
}

export class GatewayError extends Error {
  name = 'GatewayError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const GATEWAY_SYSTEM_ACTOR = { kind: 'system' as const, id: 'acc-gateway' };
