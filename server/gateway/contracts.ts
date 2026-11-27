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

/** `order_input` (Issue #008): objetivo e critérios da pessoa, cifrados, à espera da aprovação. */
export const CONTENT_KINDS = ['package', 'relayed_result', 'agent_output', 'order_input'] as const;
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
  /**
   * Issue #008: ordem de trabalho do Claude Code (só em escopos `code.change`). Imutável; tudo vem do
   * servidor e entra na apresentação aprovada (o mesmo `paramsDigest`).
   */
  code?: GatewayCodeOrder;
}

export interface GatewayCodeOrder {
  /** Id da ordem = id do handoff que será preparado depois da aprovação. */
  orderId: string;
  idempotencyKey: string;
  requestDigest: string;
  repository: string;
  /** Identidade estável do repositório no GitHub (id do nó), lida na preparação (V1). */
  repositoryId: string;
  baseSha: string;
  workBranch: string;
  /** Resumo do objetivo + critérios (conteúdo `order_input`, cifrado). */
  inputDigest: string;
  criteriaCount: number;
  createdBy: string;
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

/** Issue #008 — regras V1–V13 do verificador de PR (§6.2). */
export const PR_RULES = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13'] as const;
export type PrRule = (typeof PR_RULES)[number];
/** `info`: regra só informativa (V9, V13). `pending`: sem prova completa ou pendência (→ `needs_review`). */
export const PR_RULE_RESULTS = ['ok', 'pending', 'fail', 'info'] as const;
export type PrRuleResult = (typeof PR_RULE_RESULTS)[number];
export const PR_VERDICTS = ['conforming', 'needs_review', 'nonconforming'] as const;
export type PrVerdict = (typeof PR_VERDICTS)[number];
/** Veredito gravado: os três da verificação + `cancelled` (encerramento por revogação/kill switch/desabilitação). */
export const ENTRY_VERDICTS = [...PR_VERDICTS, 'cancelled'] as const;
export type EntryVerdict = (typeof ENTRY_VERDICTS)[number];

/**
 * Entrada do histórico de verificações (Issue #008, §5.2, R1): SOMENTE DE ACRÉSCIMO, imutável, no
 * mesmo ledger assinado. Nenhum corpo de PR, diff, conteúdo ou lista de arquivos: só códigos e resumos.
 */
export interface OrderVerification {
  id: string;
  ownerId: string;
  projectId: string;
  orderId: string;
  /** 1, 2, 3… por ordem; lacuna ou repetição → ledger recusado. */
  seq: number;
  /** Cabeça do PR confirmada no início e no fim da leitura (V12). `null` só em encerramento `cancelled`. */
  headSha: string | null;
  baseSha: string;
  verdict: EntryVerdict;
  rules: Array<{ rule: PrRule; result: PrRuleResult; reason: string | null }>;
  /** Resumos (SHA-256) das respostas normalizadas: consulta do PR, comparação REST e confirmação do HEAD. */
  evidence: { pullRequest: string | null; compare: string | null; confirm: string | null };
  supersedes: string | null;
  checkedAt: string;
  checkedBy: { kind: 'human' | 'system'; id: string };
  /** Entrada final: nenhuma verificação nova depois dela (`order_closed`). */
  closes: boolean;
  reason: string | null;
}

/** Marcas da ordem (Issue #008): uma de cada tipo por ordem, imutáveis. */
export interface OrderMark {
  id: string;
  ownerId: string;
  projectId: string;
  orderId: string;
  kind: 'forwarded' | 'pr_linked';
  at: string;
  by: string;
  prNumber: number | null;
}

/** Habilitação por projeto (Issue #008, D-08.11): somente de acréscimo; a mais recente vale. */
export interface ProjectSetting {
  id: string;
  ownerId: string;
  projectId: string;
  enabled: boolean;
  repository: string | null;
  at: string;
  by: string;
  /** Aprovação de configuração (#011) consumida na habilitação; `null` na desabilitação. */
  approvalId: string | null;
  reason: string;
}

/**
 * Issue #055 — credencial LOCAL da ponte MCP (nunca uma chave de provedor). Só o resumo SHA-256 do
 * token é gravado; o token aparece uma única vez, na resposta da criação. Registro imutável: a
 * revogação é uma entrada própria (`BridgeRevocation`), e a validade nunca é estendida.
 */
export interface BridgeCredential {
  id: string;
  ownerId: string;
  projectId: string;
  agentId: 'claude-code';
  tokenDigest: string;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  /** Aprovação de configuração (#011) consumida na criação. */
  approvalId: string;
}

/** Revogação de uma credencial da ponte (uma por credencial; somente de acréscimo). */
export interface BridgeRevocation {
  id: string;
  ownerId: string;
  credentialId: string;
  at: string;
  by: string;
  reason: string;
}

/**
 * Entrega da ordem pela ponte (Issue #055), somente de acréscimo:
 * - `offered`: o PO disponibilizou a ordem ao Claude Code (step-up). O pacote foi liberado ao canal
 *   da ponte e NUNCA é devolvido pelo canal manual;
 * - `claimed`: recebimento atômico pelo agente, preso à credencial e à chave de idempotência
 *   (`keyDigest`) e ao conteúdo do pedido (`requestDigest`). Um por ordem.
 */
export interface OrderDelivery {
  id: string;
  ownerId: string;
  projectId: string;
  orderId: string;
  kind: 'offered' | 'claimed';
  at: string;
  by: string;
  credentialId: string | null;
  keyDigest: string | null;
  requestDigest: string | null;
}

/** PR PROPOSTO pelo agente (Issue #055). Nunca é vínculo: só a confirmação do PO (step-up) vincula. */
export interface PrProposal {
  id: string;
  ownerId: string;
  projectId: string;
  orderId: string;
  credentialId: string;
  claimId: string;
  prNumber: number;
  keyDigest: string;
  requestDigest: string;
  at: string;
}

export interface GatewayBody {
  scopes: GatewayScope[];
  invocations: GatewayInvocation[];
  handoffs: GatewayHandoff[];
  contents: GatewayContentRef[];
  /** Issue #008 (aditivos; ausentes em ledgers anteriores = vazios). */
  verifications?: OrderVerification[];
  orderMarks?: OrderMark[];
  projectSettings?: ProjectSetting[];
  /** Issue #055 — ponte MCP (aditivos; ausentes em ledgers anteriores = vazios). */
  bridgeCredentials?: BridgeCredential[];
  bridgeRevocations?: BridgeRevocation[];
  orderDeliveries?: OrderDelivery[];
  prProposals?: PrProposal[];
}

/** Limites da ponte MCP (Issue #055). Ampliar qualquer um exige PR revisado. */
export const BRIDGE_LIMITS = {
  /** Validade máxima de uma credencial (a pessoa escolhe de 1 a 30 dias). */
  credentialMaxDays: 30,
  /** Repetição do recebimento (perda da resposta): mesma credencial, mesma chave, mesmo pedido. */
  claimReplayMs: 15 * 60 * 1000,
  maxProposals: 5,
  /** Corpo de uma requisição MCP e resposta máxima (o pacote tem no máximo 128 KiB). */
  maxRequestBytes: 16 * 1024,
  maxResponseBytes: 512 * 1024,
  /** Requisições por minuto por credencial. */
  requestsPerMinute: 60,
  /** Falhas de autenticação antes do bloqueio temporário da ponte (todas as credenciais). */
  authFailuresBeforeLock: 10,
  authFailureWindowMs: 5 * 60 * 1000,
} as const;

export const BRIDGE_TOKEN_PREFIX = 'accb_';
/** Token da ponte: prefixo fixo + 32 bytes aleatórios em base64url (43 caracteres). */
export const BRIDGE_TOKEN = /^accb_[A-Za-z0-9_-]{43}$/;

/** Limites do fluxo assistido do Claude Code (Issue #008). Ampliar qualquer um exige PR revisado. */
export const ORDER_LIMITS = {
  maxVerifications: 50,
  minVerificationIntervalMs: 30_000,
  /** Uma leitura do PR só conta como "atual" por este tempo (depois, a conformidade aparece desatualizada). */
  freshObservationMs: 5 * 60 * 1000,
  maxCriteria: 20,
  maxCriterionBytes: 512,
  /** Resultado do handoff = só a referência `owner/repo#N`. */
  referenceBytes: 256,
  maxPrNumber: 1_000_000_000,
  /** Validade PEDIDA do escopo; a efetiva é o menor prazo das aprovações (15 min de publicação). */
  validitySeconds: 60 * 60,
} as const;

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
  // Issue #008 — ordens do Claude Code (fluxo assistido).
  'gateway.order_requested',
  'gateway.order_forwarded',
  'gateway.pr_linked',
  'gateway.pr_verified',
  'gateway.pr_verification_superseded',
  'gateway.order_closed',
  'gateway.project_enablement',
  // Issue #055 — ponte MCP local.
  'gateway.bridge_credential_created',
  'gateway.bridge_credential_revoked',
  'gateway.order_offered',
  'gateway.order_claimed',
  'gateway.pr_proposed',
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
/** Ator do histórico para operações pedidas pelo agente pela ponte (o histórico só tem `human`/`system`). */
export const BRIDGE_ACTOR = { kind: 'system' as const, id: 'acc-bridge' };
