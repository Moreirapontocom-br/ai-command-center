import type { AgentRef, PolicyAction } from '../../shared/contracts.ts';

/**
 * Contratos do controlador de orçamento, quotas e kill switch (Issue #022) — camada PREPARATÓRIA.
 *
 * Diretriz do PO: assinaturas primeiro, orçamento adicional ZERO. Estes limites pertencem ao
 * controlador do ACC: eles decidem o que o ACC ADMITE. Não são garantia de interrupção física de
 * um provedor externo, nem refletem saldo, quota ou plano de qualquer conta de IA.
 */

/**
 * Modos de uso (modelagem; a seleção de um modo NUNCA implica que a conta/provedor o oferece):
 * - `subscription_assisted`: uso assistido e explícito de ferramenta incluída numa assinatura
 *   (a pessoa usa a ferramenta; o ACC só organiza e limita). Sem saldo de tokens presumido.
 * - `official_integration`: integração oficial autorizada pelo provedor, com condições próprias.
 * - `metered_api`: API com consumo mensurável e possível cobrança separada.
 */
export const USAGE_MODES = ['subscription_assisted', 'official_integration', 'metered_api'] as const;
export type UsageMode = (typeof USAGE_MODES)[number];

/** Moeda única do orçamento. Valores sempre em centavos inteiros (sem ponto flutuante). */
export const BUDGET_CURRENCY = 'BRL' as const;

/**
 * Situação de um provedor num modo, mantida no SERVIDOR (código revisado + relatos oficiais).
 * - `unverified`: ninguém verificou oficialmente que a capacidade existe para esta conta (#028).
 * - `available`: verificada; admissões possíveis dentro dos limites.
 * - `unavailable`: indisponível (relato oficial do provedor ou decisão do PO).
 */
export type ProviderStatus = 'unverified' | 'available' | 'unavailable';

/**
 * Cobrança adicional, segundo o catálogo do servidor (nunca segundo o chamador):
 * - `included`: sem cobrança adicional conhecida além da assinatura existente;
 * - `metered`: consumo cobrado à parte (exige orçamento e a ação `spend.create` da #020);
 * - `unknown`: não se sabe; tratado como cobrança possível e BLOQUEADO.
 */
export type BillingClass = 'included' | 'metered' | 'unknown';

export interface ProviderProfile {
  provider: AgentRef;
  mode: UsageMode;
  status: ProviderStatus;
  billing: BillingClass;
  /** Motivo do status como token (ex.: `not_verified_issue_028`, `rate_limited`). */
  statusReason: string;
  /** Até quando um relato oficial de indisponibilidade/limite vale (ISO), se informado. */
  statusUntil: string | null;
  /** Limite de solicitações informado OFICIALMENTE pelo provedor, se houver (nunca estimado). */
  officialRequestLimit: { count: number; windowSeconds: number } | null;
}

/** Limites do controlador. Mudar qualquer valor exige aprovação humana (`updateLimits`). */
export interface ControllerLimits {
  /** Execuções/tarefas admitidas ao mesmo tempo, em todo o ACC. */
  maxConcurrent: number;
  /** Duração lógica máxima de uma admissão, em segundos. */
  maxDurationSeconds: number;
  /** Admissões por janela (rate limit do próprio ACC), em todo o ACC. */
  rateLimit: { count: number; windowSeconds: number };
  /** Orçamento adicional autorizado, em centavos de BRL. */
  budget: {
    globalMinor: number;
    /** Restrições opcionais (só RESTRINGEM; o global sempre vale). */
    perProjectMinor: Record<string, number>;
    perProviderMinor: Partial<Record<AgentRef, number>>;
  };
  /** Teto conservador de tokens por tarefa, SÓ para `metered_api`. Não é saldo de assinatura. */
  meteredApiTokenCeilingPerTask: number;
}

/** Limites iniciais aprovados pelo PO (Issue #022). */
export const DEFAULT_LIMITS: ControllerLimits = Object.freeze({
  maxConcurrent: 1,
  maxDurationSeconds: 10 * 60,
  rateLimit: Object.freeze({ count: 30, windowSeconds: 60 * 60 }),
  budget: Object.freeze({ globalMinor: 0, perProjectMinor: Object.freeze({}), perProviderMinor: Object.freeze({}) }),
  meteredApiTokenCeilingPerTask: 20_000,
}) as ControllerLimits;

/** Tetos rígidos: nem com aprovação os limites podem passar disto nesta camada. */
export const HARD_CEILINGS = {
  maxConcurrent: 4,
  maxDurationSeconds: 30 * 60,
  rateLimitCount: 500,
  rateLimitWindowSeconds: 24 * 60 * 60,
  budgetMinor: 100_000_00,
  meteredApiTokenCeilingPerTask: 200_000,
} as const;

/** Validade máxima de uma aprovação humana de limites/reativação. */
export const MAX_HUMAN_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Pedido de admissão (o que o chamador, em nome de um agente, pode informar). */
export interface AdmissionRequestInput {
  /** Chave idempotente escolhida pelo chamador (mesmo pedido → mesma admissão). */
  idempotencyKey: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  /** Ação da #020 que a admissão cobre (ex.: `tool.use`, `sandbox.execute`). */
  action: PolicyAction;
  mode: UsageMode;
  /** Duração pedida (≤ limite). */
  durationSeconds: number;
  /** Só `metered_api`: estimativa de custo em centavos (reservada) e teto de tokens. */
  estimatedCostMinor: number | null;
  maxTokens: number | null;
}

export const ADMISSION_STATES = ['admitted', 'completed', 'failed', 'cancelled', 'expired'] as const;
export type AdmissionState = (typeof ADMISSION_STATES)[number];
export const ADMISSION_TERMINAL: readonly AdmissionState[] = ['completed', 'failed', 'cancelled', 'expired'];

/**
 * Situação do custo:
 * - `none`: sem cobrança adicional conhecida (catálogo `included`); nada é medido nem inventado;
 * - `estimated`: reservado pela estimativa, ainda não confirmado;
 * - `confirmed`: valor informado pelo provedor na reconciliação;
 * - `unknown`: o provedor não informou; a reserva continua contando (conservador).
 */
export type CostStatus = 'none' | 'estimated' | 'confirmed' | 'unknown';

export interface Admission {
  id: string;
  idempotencyKey: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  action: PolicyAction;
  mode: UsageMode;
  state: AdmissionState;
  reason: string | null;
  admittedAt: string;
  deadline: string;
  finishedAt: string | null;
  cost: { status: CostStatus; reservedMinor: number; confirmedMinor: number | null; currency: typeof BUDGET_CURRENCY };
  /** Tokens: `null` nos modos de assinatura (não há saldo nem medição presumidos). */
  tokens: { ceiling: number; reported: number | null } | null;
  /** Kill switch: pedido de cancelamento ao responsável pela execução e seu resultado. */
  cancellation: { requestedAt: string; result: CancellationResult | 'pending' } | null;
  /**
   * Ocupação da vaga de concorrência, SEPARADA do estado lógico. Fica `held` enquanto a operação
   * pode estar ativa: só passa a `released` quando o término é informado (`complete`), quando o
   * cancelamento é confirmado (`cancelled`) ou quando uma pessoa/o host confirma a interrupção.
   */
  capacity: 'held' | 'released';
  approvalIds: string[];
}

/** O que quem hospeda o controlador conseguiu fazer ao receber um pedido de cancelamento. */
export type CancellationResult = 'cancelled' | 'not_supported' | 'failed';

/**
 * Aprovação humana para alterar limites ou reativar o kill switch. Vale para UMA operação exata
 * (`operation` + `target`), é de uso único e tem validade curta. O fluxo persistente é da #011.
 */
export interface HumanApproval {
  id: string;
  operation: 'limits.change' | 'killswitch.release';
  /** `limits.change`: impressão digital dos novos limites. `killswitch.release`: `global` ou id do projeto. */
  target: string;
  approvedBy: { kind: 'human'; id: string };
  approvedAt: string;
  expiresAt: string;
}

/**
 * Resultado da verificação de ORIGEM de uma aprovação humana. Campos válidos não provam nada: só
 * um verificador confiável (o fluxo persistente da Issue #011) atesta que a aprovação foi emitida
 * por quem diz e não foi alterada. `approverId` é a identidade AUTENTICADA do aprovador.
 */
export type ApprovalVerification = { authentic: true; approverId: string } | { authentic: false; reason: string };

/**
 * Contrato do verificador de aprovações (implementação real: Issue #011). Síncrono, porque a
 * admissão e as mudanças sensíveis não intercalam `await`. Sem verificador configurado, o
 * controlador NEGA alteração de limites e reativação do kill switch.
 */
export interface ApprovalVerifier {
  readonly id: string;
  /** `simulated`: apenas para testes; nunca deve ser configurado em produção. */
  readonly kind: 'simulated' | 'trusted';
  verify(approval: HumanApproval): ApprovalVerification;
}

/** Relato OFICIAL de indisponibilidade temporária (só restringe; nunca torna algo disponível). */
export interface ProviderUnavailability {
  reason: string;
  until: string | null;
}

/**
 * Quota OFICIAL de solicitações informada pelo provedor, SEM declará-lo indisponível. Só restringe:
 * soma-se ao limite do catálogo e às demais quotas ativas (todas são aplicadas); nunca o amplia.
 */
export interface ProviderQuota {
  reason: string;
  count: number;
  windowSeconds: number;
  until: string | null;
}

export type KillSwitchScope = { kind: 'global' } | { kind: 'project'; projectId: string };

export interface KillSwitchState {
  engaged: boolean;
  reason: string | null;
  engagedAt: string | null;
  engagedBy: string | null;
}

/** Entrada do registro auditável (só tokens e ids; nunca texto livre, credenciais ou conteúdo). */
export interface ControllerAuditEntry {
  seq: number;
  at: string;
  event: string;
  actor: string;
  projectId: string | null;
  admissionId: string | null;
  decision: 'allowed' | 'denied' | 'unavailable' | 'recorded';
  reason: string;
}
