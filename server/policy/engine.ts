import {
  AGENT_IDS,
  POLICY_ACTIONS,
  POLICY_CATEGORIES,
  RISK_LEVELS,
  type ApprovalGrant,
  type PolicyAction,
  type PolicyActionInfo,
  type PolicyCategory,
  type PolicyEvaluation,
  type PolicyReason,
  type PolicySubject,
  type RiskLevel,
} from '../../shared/contracts.ts';

/**
 * Motor de políticas de autonomia (Issue #020). Função pura e determinística: mesma entrada, mesma
 * decisão. Ordem de avaliação (a primeira que se aplica decide):
 *
 * 1. Requisição malformada ou ação fora do catálogo → DENY.
 * 2. Regras FIXAS, que nenhuma política altera: push na main é sempre negado; agente nunca altera
 *    permissões; projeto fora do escopo do sujeito → DENY; agente fora de projeto, ou sem tarefa
 *    atribuída no projeto, → DENY (invariante, independente de `requiresAssignment`).
 * 3. Regras da política: sem regra aplicável → DENY (negação por padrão). Regra `deny` → DENY.
 * 4. Capacidade inexistente no ACC → UNAVAILABLE (informando se exigiria aprovação).
 * 5. Regra `require_approval` (ou ação crítica) → REQUIRE_APPROVAL, salvo aprovação válida para
 *    EXATAMENTE esta operação → ALLOW com `approvalId` (uso único: quem chama consome).
 * 6. ALLOW.
 */

export type RuleSubject = 'human:owner' | 'agent:*' | `agent:${(typeof AGENT_IDS)[number]}`;
export type RuleEffect = 'allow' | 'require_approval' | 'deny';

export interface PolicyRule {
  id: string;
  subject: RuleSubject;
  /** Ações cobertas, por nome e/ou categoria. */
  actions?: PolicyAction[];
  categories?: PolicyCategory[];
  effect: RuleEffect;
  /** A regra só se aplica a ações com risco até este nível. */
  maxRisk: RiskLevel;
  /** Para agentes: exige tarefa atribuída ao agente no projeto. */
  requiresAssignment?: boolean;
}

export interface Policy {
  version: string;
  rules: PolicyRule[];
}

export interface PolicyRequest {
  subject: PolicySubject;
  action: string;
  projectId: string | null;
  resource?: { type: string; id: string } | null;
  target?: { sha: string | null; ref: string | null } | null;
  approval?: ApprovalGrant | null;
}

/** Fatos resolvidos pelo servidor (nunca informados pelo cliente). */
export interface PolicyFacts {
  /** O projeto pertence ao dono do sujeito (ou a ação não envolve projeto). */
  projectAccessible: boolean;
  /** Para agentes: há tarefa do projeto atribuída a este agente. */
  agentAssigned: boolean;
  now: number;
  /** Ids de aprovações já consumidas (uso único). */
  usedApprovals: ReadonlySet<string>;
  /**
   * Issue #011 (N4): id do grant `owner_confirmation` cuja origem o SERVIDOR atestou pelo núcleo
   * de aprovações (recibo validado). Sem isto, `owner_confirmation` é recusado como antes
   * (`self_approval`). Nunca vem do cliente.
   */
  verifiedOwnerConfirmationId?: string | null;
  /**
   * Issue #008 (D-08.3, §10.7 da especificação): fatos do fluxo ASSISTIDO, montados SÓ pelo Agent
   * Gateway a partir do escopo persistido e da habilitação do projeto gravada no ledger dele.
   * Nunca vêm do cliente nem do agente. Ausentes, incompletos ou divergentes → a exceção não se
   * aplica (a ação continua `UNAVAILABLE`).
   */
  assisted?: AssistedFacts | null;
}

export interface AssistedFacts {
  channel: string;
  mode: string;
  capability: string;
  component: string;
  projectId: string;
  projectEnabled: boolean;
}

/**
 * Exceção FECHADA à indisponibilidade global (Issue #008, D-08.3/D-08.11). As flags globais de
 * `agent.invoke` e `data.send_external` continuam `available: false` em `POLICY_ACTIONS`; só estas
 * DUAS combinações exatas deixam de ser `UNAVAILABLE`, e apenas com o projeto habilitado. A exceção
 * NÃO dispensa nenhuma regra: as duas ações continuam exigindo aprovação humana (A4/A6, crítica).
 * Mudar esta lista exige autorização do PO, PR próprio, testes próprios e revisão independente.
 */
export const ASSISTED_AVAILABILITY = Object.freeze([
  Object.freeze({ action: 'agent.invoke', subject: 'agent:claude-code', channel: 'assisted', mode: 'subscription_assisted', capability: 'code.change', component: 'gateway' } as const),
  Object.freeze({ action: 'data.send_external', subject: 'agent:claude-code', channel: 'assisted', mode: 'subscription_assisted', capability: 'code.change', component: 'gateway' } as const),
]);

const ASSISTED_FACT_KEYS = ['channel', 'mode', 'capability', 'component', 'projectId', 'projectEnabled'];

/** A requisição corresponde EXATAMENTE a uma combinação da exceção, com fatos do servidor? */
export function assistedAvailable(request: PolicyRequest, facts: PolicyFacts): boolean {
  const a = facts.assisted;
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return false;
  const keys = Object.keys(a);
  if (keys.length !== ASSISTED_FACT_KEYS.length || !ASSISTED_FACT_KEYS.every((k) => keys.includes(k))) return false;
  if (a.projectEnabled !== true || typeof a.projectId !== 'string' || request.projectId === null || a.projectId !== request.projectId) return false;
  // A exceção vale só para o escopo do gateway (nunca para rotas, tarefas ou outro recurso).
  if (!request.resource || request.resource.type !== 'gateway_scope') return false;
  const subject = request.subject?.kind === 'agent' ? `agent:${request.subject.id}` : null;
  return ASSISTED_AVAILABILITY.some(
    (e) => e.action === request.action && e.subject === subject && e.channel === a.channel && e.mode === a.mode && e.capability === a.capability && e.component === a.component,
  );
}

export class PolicyValidationError extends Error {
  name = 'PolicyValidationError';
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_:.#\-/]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;
const USER_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
/** Ações que só podem ser aprovadas com o SHA exato (versão) do que será alterado. */
export const SHA_BOUND_ACTIONS: readonly PolicyAction[] = ['repo.merge', 'deploy.publish', 'change.prepare'];
/** Validade máxima de uma aprovação. */
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const isAction = (value: string): value is PolicyAction => Object.hasOwn(POLICY_ACTIONS, value);

/**
 * Valida a política na carga. Invariantes: ids únicos; ações e categorias conhecidas; ação crítica
 * nunca com `allow`; regra de agente específico nunca amplia (`allow` só em `agent:*`); nenhuma
 * regra libera alteração de permissões a agentes nem push na main.
 */
export function validatePolicy(policy: Policy): Policy {
  const fail = (message: string): never => {
    throw new PolicyValidationError(message);
  };
  if (typeof policy.version !== 'string' || policy.version === '') fail('versão ausente');
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    if (ids.has(rule.id)) fail(`regra duplicada: ${rule.id}`);
    ids.add(rule.id);
    const validSubject =
      rule.subject === 'human:owner' ||
      rule.subject === 'agent:*' ||
      (rule.subject.startsWith('agent:') && (AGENT_IDS as readonly string[]).includes(rule.subject.slice(6)));
    if (!validSubject) fail(`sujeito inválido em ${rule.id}`);
    if (!RISK_LEVELS.includes(rule.maxRisk)) fail(`risco inválido em ${rule.id}`);
    if (!['allow', 'require_approval', 'deny'].includes(rule.effect)) fail(`efeito inválido em ${rule.id}`);
    for (const action of rule.actions ?? []) if (!isAction(action)) fail(`ação desconhecida em ${rule.id}`);
    for (const category of rule.categories ?? []) if (!POLICY_CATEGORIES.includes(category)) fail(`categoria desconhecida em ${rule.id}`);
    if ((rule.actions?.length ?? 0) + (rule.categories?.length ?? 0) === 0) fail(`regra sem ações: ${rule.id}`);
    const covered = (Object.keys(POLICY_ACTIONS) as PolicyAction[]).filter((action) => ruleCovers(rule, action));
    if (rule.effect === 'allow' && covered.some((action) => POLICY_ACTIONS[action].critical)) {
      fail(`ação crítica liberada sem aprovação em ${rule.id}`);
    }
    if (rule.effect === 'allow' && rule.subject !== 'human:owner' && rule.subject !== 'agent:*') {
      fail(`regra de agente específico só pode restringir (${rule.id})`);
    }
  }
  return policy;
}

function ruleCovers(rule: PolicyRule, action: PolicyAction): boolean {
  const info = POLICY_ACTIONS[action];
  const listed = (rule.actions ?? []).includes(action) || (rule.categories ?? []).includes(info.category);
  return listed && RISK_ORDER[info.risk] <= RISK_ORDER[rule.maxRisk];
}

function subjectMatches(rule: PolicyRule, subject: PolicySubject): boolean {
  if (subject.kind === 'human') return rule.subject === 'human:owner';
  return rule.subject === 'agent:*' || rule.subject === `agent:${subject.id}`;
}

/** Motivo pelo qual a aprovação não serve para esta operação, ou `null` se serve. */
export function approvalProblem(grant: ApprovalGrant, request: PolicyRequest, facts: PolicyFacts): string | null {
  if (facts.usedApprovals.has(grant.id)) return 'already_used';
  if (grant.action !== request.action) return 'different_action';
  if (grant.projectId !== request.projectId) return 'different_project';
  if (grant.subject.kind !== request.subject.kind || grant.subject.id !== request.subject.id) return 'different_subject';
  if (!request.resource || grant.resource.type !== request.resource.type || grant.resource.id !== request.resource.id) {
    return 'different_resource';
  }
  const needsSha = SHA_BOUND_ACTIONS.includes(grant.action);
  const reqSha = request.target?.sha ?? null;
  if (needsSha && (reqSha === null || grant.target.sha === null)) return 'missing_sha';
  if (grant.target.sha !== reqSha || grant.target.ref !== (request.target?.ref ?? null)) return 'different_target';
  if (grant.approvedBy.kind !== 'human') return 'approver_not_human';
  // Um id de agente nunca vale como aprovador, mesmo rotulado como "human".
  if ((AGENT_IDS as readonly string[]).includes(grant.approvedBy.id)) return 'approver_not_human';
  const method = grant.method ?? 'approval';
  if (method !== 'approval' && method !== 'owner_confirmation') return 'invalid_method';
  // Ninguém aprova a própria ação; agente nunca aprova. Exceção ÚNICA (D2/N4): confirmação do
  // próprio PO, atestada pelo servidor, para operação crítica que ele iniciou.
  if (method === 'owner_confirmation') {
    if (request.subject.kind !== 'human' || grant.approvedBy.id !== request.subject.id) return 'invalid_owner_confirmation';
    if (!POLICY_ACTIONS[grant.action].critical) return 'invalid_owner_confirmation';
    if (!facts.verifiedOwnerConfirmationId || facts.verifiedOwnerConfirmationId !== grant.id) return 'self_approval';
  } else if (request.subject.kind === 'human' && grant.approvedBy.id === request.subject.id) {
    return 'self_approval';
  }
  const approvedAt = Date.parse(grant.approvedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) return 'invalid_dates';
  if (expiresAt - approvedAt > MAX_APPROVAL_TTL_MS || expiresAt <= approvedAt) return 'invalid_validity';
  if (facts.now < approvedAt) return 'not_yet_valid';
  if (facts.now >= expiresAt) return 'expired';
  return null;
}

function isWellFormed(request: PolicyRequest): boolean {
  if (typeof request !== 'object' || request === null) return false;
  const allowed = ['subject', 'action', 'projectId', 'resource', 'target', 'approval'];
  if (Object.keys(request).some((key) => !allowed.includes(key))) return false;
  const s = request.subject as Record<string, unknown> | undefined;
  if (!s || typeof s !== 'object') return false;
  const subjectOk =
    (s.kind === 'human' && typeof s.id === 'string' && USER_ID.test(s.id)) ||
    (s.kind === 'agent' && typeof s.id === 'string' && (AGENT_IDS as readonly string[]).includes(s.id));
  if (!subjectOk || Object.keys(s).length !== 2) return false;
  if (typeof request.action !== 'string') return false;
  if (request.projectId !== null && (typeof request.projectId !== 'string' || !UUID.test(request.projectId))) return false;
  const r = request.resource;
  if (r != null && (typeof r.type !== 'string' || !TOKEN.test(r.type) || typeof r.id !== 'string' || !TOKEN.test(r.id))) return false;
  const t = request.target;
  if (t != null && ((t.sha !== null && (typeof t.sha !== 'string' || !SHA.test(t.sha))) || (t.ref !== null && (typeof t.ref !== 'string' || !TOKEN.test(t.ref))))) {
    return false;
  }
  return true;
}

/**
 * `catalog` existe só para testes (simular uma capacidade disponível); em produção é o catálogo
 * fixo `POLICY_ACTIONS`.
 */
export function evaluatePolicy(
  policy: Policy,
  request: PolicyRequest,
  facts: PolicyFacts,
  catalog: Record<PolicyAction, PolicyActionInfo> = POLICY_ACTIONS,
): PolicyEvaluation {
  const result = (
    decision: PolicyEvaluation['decision'],
    reason: PolicyReason,
    extra: Partial<Pick<PolicyEvaluation, 'ruleId' | 'requiresApproval' | 'approvalId'>> = {},
  ): PolicyEvaluation => ({
    decision,
    action: typeof request?.action === 'string' ? request.action : '',
    risk: typeof request?.action === 'string' && isAction(request.action) ? POLICY_ACTIONS[request.action].risk : null,
    reason,
    ruleId: extra.ruleId ?? null,
    requiresApproval: extra.requiresApproval ?? false,
    approvalId: extra.approvalId ?? null,
  });

  if (!isWellFormed(request)) return result('DENY', 'malformed_request');
  if (!isAction(request.action)) return result('DENY', 'unknown_action');
  const action = request.action;
  const info = catalog[action];
  const { subject } = request;

  // Regras fixas.
  if (action === 'repo.push_main') return result('DENY', 'main_is_protected');
  if (subject.kind === 'agent' && action === 'permissions.change') return result('DENY', 'agent_cannot_change_permissions');
  if (!facts.projectAccessible) return result('DENY', 'project_out_of_scope');
  // Invariante do motor (não configurável): agente só age dentro de um projeto e só se tiver
  // tarefa atribuída nele. Nenhuma política (nem `requiresAssignment: false`) desativa isto.
  if (subject.kind === 'agent' && (request.projectId === null || !facts.agentAssigned)) {
    return result('DENY', 'agent_not_assigned');
  }

  // Regras da política (mais restritiva vence; agente específico só restringe).
  const matching = policy.rules.filter((rule) => subjectMatches(rule, subject) && ruleCovers(rule, action));
  if (matching.length === 0) return result('DENY', 'no_matching_rule');
  const denyRule = matching.find((rule) => rule.effect === 'deny');
  if (denyRule) return result('DENY', 'restricted_by_rule', { ruleId: denyRule.id });
  const base = matching.find((rule) => rule.subject === 'human:owner' || rule.subject === 'agent:*');
  if (!base) return result('DENY', 'no_matching_rule');
  // Defesa em profundidade: `requiresAssignment` nas regras continua valendo (já coberto acima).
  if (subject.kind === 'agent' && matching.some((rule) => rule.requiresAssignment) && !facts.agentAssigned) {
    return result('DENY', 'agent_not_assigned', { ruleId: base.id });
  }
  const approvalRule = matching.find((rule) => rule.effect === 'require_approval');
  // Defesa em profundidade (Issue #008): o que só é disponível pela exceção assistida SEMPRE exige aprovação.
  const viaAssistedException = !info.available && assistedAvailable(request, facts);
  const requiresApproval = info.critical || approvalRule !== undefined || viaAssistedException;
  const decidingRule = approvalRule ?? base;

  // Issue #008: só a exceção fechada troca `UNAVAILABLE` por "disponível" — e a aprovação continua exigida.
  if (!info.available && !viaAssistedException) {
    return result('UNAVAILABLE', 'capability_unavailable', { ruleId: decidingRule.id, requiresApproval });
  }
  if (requiresApproval) {
    if (!request.approval) return result('REQUIRE_APPROVAL', 'approval_required', { ruleId: decidingRule.id, requiresApproval });
    if (approvalProblem(request.approval, request, facts) !== null) {
      return result('REQUIRE_APPROVAL', 'approval_invalid', { ruleId: decidingRule.id, requiresApproval });
    }
    return result('ALLOW', 'approved', { ruleId: decidingRule.id, requiresApproval, approvalId: request.approval.id });
  }
  return result('ALLOW', 'allowed_by_rule', { ruleId: base.id });
}


/** Severidade para combinar várias avaliações de uma mesma operação (a pior decide). */
export const DECISION_SEVERITY: Record<PolicyEvaluation['decision'], number> = {
  ALLOW: 0,
  REQUIRE_APPROVAL: 1,
  UNAVAILABLE: 2,
  DENY: 3,
};
