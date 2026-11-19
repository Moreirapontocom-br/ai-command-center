import {
  POLICY_ACTIONS,
  type ApprovalMethod,
  type PolicyAction,
  type PolicySubject,
} from '../../shared/contracts.ts';
import type { ApprovalPresentation } from '../../shared/approvalPresentation.ts';

/**
 * Contratos do núcleo de aprovações humanas (Issue #011, PR 1) — camada DORMENTE.
 *
 * Nada aqui é ligado ao servidor neste PR: não há rota HTTP, interface nem consumo pelos
 * controladores da #021/#022 (isso é o PR 2). O núcleo nunca torna uma capacidade disponível:
 * uma aprovação só autoriza o que a política (#020) e os limites (#022) já permitiriam.
 */

/** Classes de aprovação (D5/D10): uma aprovação de uma classe nunca serve para outra. */
export const APPROVAL_CLASSES = ['execution', 'configuration', 'merge', 'publication', 'cost'] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const APPROVAL_STATES = ['pending', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded', 'consumed', 'revoked'] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const APPROVAL_TERMINAL: readonly ApprovalState[] = ['rejected', 'withdrawn', 'expired', 'superseded', 'consumed', 'revoked'];

/** Transições permitidas. Qualquer outra é recusada (`invalid_transition`) e registrada. */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalState, readonly ApprovalState[]>> = Object.freeze({
  pending: ['approved', 'rejected', 'withdrawn', 'expired', 'superseded'],
  approved: ['consumed', 'expired', 'revoked', 'superseded'],
  rejected: [],
  withdrawn: [],
  expired: [],
  superseded: [],
  consumed: [],
  revoked: [],
});

export const ATTEMPT_STATES = ['reserved', 'succeeded', 'failed', 'indeterminate', 'acknowledged_by_owner'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptState, readonly AttemptState[]>> = Object.freeze({
  reserved: ['succeeded', 'failed', 'indeterminate'],
  succeeded: [],
  failed: [],
  indeterminate: ['acknowledged_by_owner'],
  acknowledged_by_owner: [],
});

/** Métodos de confirmação de identidade (D8): só `password` é implementado nesta fase. */
export const CONFIRMATION_METHODS = ['password', 'totp', 'webauthn'] as const;
export type ConfirmationMethod = (typeof CONFIRMATION_METHODS)[number];

/** Operações de configuração do próprio ACC, fora do catálogo da #020 (que é código revisado). */
export const CONFIGURATION_OPERATIONS = [
  'limits.change',
  'killswitch.release',
  'approvals.retention_change',
  'approvals.history_purge',
] as const;
export type ConfigurationOperation = (typeof CONFIGURATION_OPERATIONS)[number];

export type ApprovableAction = PolicyAction | ConfigurationOperation;

/** `repo.push_main` nunca é aprovável: a regra fixa da #020 o nega sempre. */
export const NEVER_APPROVABLE: readonly string[] = ['repo.push_main'];

/**
 * Classe de uma ação, decidida pelo SERVIDOR (nunca pelo chamador). `null` = não aprovável.
 * Não críticas (sandbox, ferramentas, alterações e tarefas feitas por agentes) → `execution`.
 */
export function classOf(action: string): ApprovalClass | null {
  if (NEVER_APPROVABLE.includes(action)) return null;
  if ((CONFIGURATION_OPERATIONS as readonly string[]).includes(action)) return 'configuration';
  if (!Object.hasOwn(POLICY_ACTIONS, action)) return null;
  const info = POLICY_ACTIONS[action as PolicyAction];
  if (!info.critical) return 'execution';
  switch (action as PolicyAction) {
    case 'repo.merge':
      return 'merge';
    case 'deploy.publish':
    case 'data.send_external':
      return 'publication';
    case 'spend.create':
      return 'cost';
    case 'permissions.change':
    case 'secrets.access':
      return 'configuration';
    default:
      return null;
  }
}

const MINUTE = 60 * 1000;
/** TTL de uma aprovação concedida, por classe (D5). */
export const APPROVAL_TTL_MS: Readonly<Record<ApprovalClass, number>> = Object.freeze({
  execution: 60 * MINUTE,
  configuration: 15 * MINUTE,
  merge: 15 * MINUTE,
  publication: 15 * MINUTE,
  cost: 15 * MINUTE,
});
/** Prazo de um pedido pendente (D5). */
export const PENDING_TTL_MS = 24 * 60 * MINUTE;
/** Validade de um recibo de consumo (R1): curto, em memória, nunca persistido. */
export const RECEIPT_TTL_MS = 30 * 1000;
/** Confirmação recente de identidade (N5). */
export const STEP_UP_TTL_MS = 5 * MINUTE;
export const STEP_UP_MAX_FAILURES = 5;
export const STEP_UP_LOCK_MS = 15 * MINUTE;
/** Compactação do estado mínimo (N7): registros terminais após 30 dias. */
export const COMPACTION_AFTER_MS = 30 * 24 * 60 * MINUTE;
/** Retenção do histórico (D7/N10). */
export const HISTORY_RETENTION_DAYS = { default: 365, min: 30, max: 5 * 365 } as const;
/** Texto opcional de preservação (N8). */
export const HOLD_NOTE_MAX = 200;
export const HOLD_REASONS = ['incident', 'security_review', 'dispute', 'legal'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Motivos da recuperação administrativa (lista fechada). */
export const RECOVERY_REASONS = ['integrity_failure', 'corrupted_files', 'key_rotation_failure', 'restore_detected'] as const;
export type RecoveryReason = (typeof RECOVERY_REASONS)[number];

/**
 * Vínculo exato da autorização (imutável após o pedido). O `bindingDigest` canônico é o que o
 * administrador vê e confirma; o consumo recalcula o vínculo e exige igualdade.
 */
export interface ApprovalBinding {
  action: ApprovableAction;
  projectId: string | null;
  resource: { type: string; id: string };
  target: { sha: string | null; ref: string | null };
  subject: PolicySubject;
  /** Resumo dos parâmetros exatos (ex.: `limitsFingerprint` dos novos limites). */
  paramsDigest: string;
  /** Versão da política (#020) em vigor quando o pedido foi feito. */
  policyVersion: string;
}

export type BarrierScope = { kind: 'global' } | { kind: 'project'; projectId: string };

export interface Barrier {
  engagedAt: string;
  epoch: number;
  reason: string;
}

export interface LedgerApproval {
  id: string;
  ownerId: string;
  class: ApprovalClass;
  method: ApprovalMethod;
  binding: ApprovalBinding;
  bindingDigest: string;
  state: ApprovalState;
  /** Época em que foi CONCEDIDA (N1). `null` enquanto pendente. */
  epoch: number | null;
  requestedBy: { kind: 'system' | 'human'; id: string };
  requestedAt: string;
  pendingUntil: string;
  decidedBy: { kind: 'human'; id: string } | null;
  decidedAt: string | null;
  confirmation: { method: ConfirmationMethod; at: string } | null;
  validUntil: string | null;
  closedAt: string | null;
  closedReason: string | null;
  attemptId: string | null;
  /**
   * Parâmetros exatos, em formato fechado (correção R1), entregues pelo componente do servidor
   * que pediu e conferidos contra o `paramsDigest` no pedido. Ausente em registros antigos (PR 1):
   * esses pedidos só podem ser rejeitados.
   */
  presentation?: ApprovalPresentation;
}

export interface LedgerAttempt {
  id: string;
  approvalId: string;
  component: ReceiptComponent;
  state: AttemptState;
  reservedAt: string;
  epoch: number;
  outcomeAt: string | null;
  reason: string | null;
}

/** Componentes que podem receber recibos. Um recibo só vale para o componente indicado. */
/** Issue #028: `gateway` recebe o recibo da aprovação que cria um escopo de tarefa (I1). */
export const RECEIPT_COMPONENTS = ['limits', 'sandbox', 'policy', 'approvals', 'gateway'] as const;
export type ReceiptComponent = (typeof RECEIPT_COMPONENTS)[number];

export const APPROVAL_EVENTS = [
  'approval.store_initialized',
  'approval.store_opened',
  'approval.store_recovered',
  'approval.lock_recovered',
  'approval.history_unapplied',
  'approval.requested',
  'approval.approved',
  'approval.owner_confirmed',
  'approval.rejected',
  'approval.withdrawn',
  'approval.expired',
  'approval.superseded',
  'approval.revoked',
  'approval.consumed',
  'approval.consume_denied',
  'approval.decision_denied',
  'approval.transition_denied',
  'approval.receipt_denied',
  'approval.attempt_succeeded',
  'approval.attempt_failed',
  'approval.attempt_indeterminate',
  'approval.attempt_acknowledged',
  'approval.barrier_engaged',
  'approval.barrier_released',
  'approval.compacted',
  'approval.retention_changed',
  'approval.history_purged',
  'approval.hold_added',
  'approval.hold_removed',
] as const;
export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];

/** Erro do núcleo: `code` é sempre um token (nunca texto livre, caminho ou segredo). */
export class ApprovalError extends Error {
  name = 'ApprovalError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
