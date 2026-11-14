import { randomUUID } from 'node:crypto';
import {
  POLICY_ACTIONS,
  type AgentRef,
  type ApprovalGrant,
  type PolicyAction,
  type PolicyActionInfo,
  type PolicyEvaluation,
} from '../../shared/contracts.ts';
import type { Logger } from '../logger.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { evaluatePolicy, type Policy } from '../policy/engine.ts';
import type { ProjectStore } from '../projects/projectStore.ts';
import type { TaskStore } from '../tasks/taskStore.ts';
import {
  ADMISSION_TERMINAL,
  BUDGET_CURRENCY,
  DEFAULT_LIMITS,
  MAX_HUMAN_APPROVAL_TTL_MS,
  type Admission,
  type AdmissionRequestInput,
  type ApprovalVerifier,
  type CancellationResult,
  type ControllerAuditEntry,
  type ControllerLimits,
  type HumanApproval,
  type KillSwitchScope,
  type KillSwitchState,
  type ProviderProfile,
  type ProviderQuota,
  type ProviderUnavailability,
  type UsageMode,
} from './contracts.ts';
import { defaultProviderCatalog } from './providers.ts';
import {
  isAgentId,
  limitsFingerprint,
  parseAdmissionRequest,
  parseHumanApproval,
  parseLimits,
  REASON_TOKEN,
  requestFingerprint,
} from './validation.ts';

/**
 * Controlador de orçamento, quotas e kill switch (Issue #022) — camada PREPARATÓRIA.
 *
 * - Independente de provedor: não autentica em contas de IA, não chama APIs, não executa nada.
 *   Nenhuma rota HTTP o usa. A integração efetiva é do futuro Agent Gateway (#028).
 * - Admissão SÍNCRONA: todas as verificações e a reserva acontecem sem `await` entre elas, então
 *   pedidos concorrentes no mesmo processo nunca se intercalam (sem reserva dupla, sem 2 vagas).
 * - Custo é decidido pelo catálogo do servidor, nunca pelo chamador. Cobrança desconhecida é
 *   bloqueada. Custo > 0 exige a ação crítica `spend.create` da #020 (indisponível no catálogo
 *   real) e orçamento aprovado (R$ 0 por padrão): em produção, nenhuma operação paga é admitida.
 * - Assinaturas: nenhum saldo de tokens é presumido nem inventado; valem limites de tarefas,
 *   duração, concorrência e solicitações.
 * - Limites e kill switch são do CONTROLADOR (o que o ACC admite). Cancelar é um PEDIDO a quem
 *   hospeda a execução; não há garantia de interrupção física de provedor externo.
 * - Estado em memória: persistência (inclusive do kill switch) e filas são das #011/#012.
 * - Aprovações humanas só valem se um verificador CONFIÁVEL (#011) atestar a origem; sem ele,
 *   alteração de limites e reativação do kill switch são negadas.
 * - Término lógico ≠ interrupção confirmada: a vaga de concorrência só é liberada quando a
 *   operação comprovadamente terminou ou foi interrompida.
 */

export class LimitsError extends Error {
  name = 'LimitsError';
  readonly code: string;
  readonly evaluation: PolicyEvaluation | null;
  constructor(code: string, evaluation: PolicyEvaluation | null = null) {
    super(code);
    this.code = code;
    this.evaluation = evaluation;
  }
}

export type ControllerActor = { kind: 'human'; id: string } | { kind: 'system'; id: 'acc' };

export interface UsageReport {
  /** Custo informado pelo provedor na reconciliação (`unknown` quando ele não informa). */
  cost: { kind: 'confirmed'; amountMinor: number } | { kind: 'unknown' } | { kind: 'none' };
  /** Tokens informados pelo provedor (só `metered_api`); `null` se não informados. */
  tokens: number | null;
}

/** Máximo de quotas oficiais ativas por provedor/modo (memória limitada; excedente é recusado). */
const MAX_ACTIVE_QUOTAS = 20;

export interface LimitsControllerOptions {
  projects: Pick<ProjectStore, 'get'>;
  tasks: Pick<TaskStore, 'get'>;
  policy?: Policy;
  /** Apenas para testes: catálogo da #020 com capacidades simuladas como disponíveis. */
  policyCatalog?: Record<PolicyAction, PolicyActionInfo>;
  /** Apenas para testes: catálogo de provedores (o padrão é tudo `unverified`). */
  providers?: ProviderProfile[];
  /** Quem hospeda a execução trata o pedido de cancelamento (sem ele: `not_supported`). */
  cancelHandler?: (admission: Admission) => Promise<CancellationResult>;
  /**
   * Verificador de ORIGEM das aprovações humanas (fluxo confiável: Issue #011). Ausente em
   * produção hoje: por isso alteração de limites e reativação do kill switch são negadas.
   * Os testes usam `createSimulatedApprovalVerifier()`, explícito e só para testes.
   */
  approvalVerifier?: ApprovalVerifier;
  now?: () => number;
  generateId?: () => string;
  logger?: Logger;
}

const MAX_AUDIT_ENTRIES = 1000;

export function createLimitsController(options: LimitsControllerOptions) {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;
  const policy = options.policy ?? DEFAULT_POLICY;
  const policyCatalog = options.policyCatalog ?? POLICY_ACTIONS;
  const iso = (ms = now()) => new Date(ms).toISOString();

  let limits: ControllerLimits = parseLimits(DEFAULT_LIMITS);
  const providers = new Map<string, ProviderProfile>();
  for (const profile of options.providers ?? defaultProviderCatalog()) providers.set(`${profile.provider}|${profile.mode}`, structuredClone(profile));
  /** Relatos oficiais de indisponibilidade temporária (sobrepostos ao catálogo, nunca o ampliam). */
  const unavailability = new Map<string, ProviderUnavailability>();
  /** Quotas oficiais de solicitações, separadas da indisponibilidade; todas as ativas se aplicam. */
  const quotas = new Map<string, ProviderQuota[]>();

  const admissions = new Map<string, Admission>();
  const byIdempotency = new Map<string, { admissionId: string; fingerprint: string }>();
  const usedApprovals = new Set<string>();
  const usedHumanApprovals = new Set<string>();
  const killGlobal: KillSwitchState = { engaged: false, reason: null, engagedAt: null, engagedBy: null };
  const killProjects = new Map<string, KillSwitchState>();
  const auditTrail: ControllerAuditEntry[] = [];
  let auditSeq = 0;

  const actorLabel = (actor: ControllerActor | { kind: 'agent'; id: AgentRef }) => `${actor.kind}:${actor.id}`;

  function audit(entry: Omit<ControllerAuditEntry, 'seq' | 'at'>) {
    const safe: ControllerAuditEntry = {
      seq: ++auditSeq,
      at: iso(),
      ...entry,
      reason: REASON_TOKEN.test(entry.reason) ? entry.reason : 'invalid_reason',
    };
    auditTrail.push(safe);
    if (auditTrail.length > MAX_AUDIT_ENTRIES) auditTrail.splice(0, auditTrail.length - MAX_AUDIT_ENTRIES);
    options.logger?.log(safe.decision === 'denied' ? 'warn' : 'info', 'Limits', {
      event: safe.event,
      decision: safe.decision,
      reason: safe.reason,
      projectId: safe.projectId,
      admissionId: safe.admissionId,
    });
  }

  function deny(code: string, ctx: { actor: string; projectId: string | null }, evaluation: PolicyEvaluation | null = null, decision: 'denied' | 'unavailable' = 'denied'): never {
    audit({ event: 'admission_decision', actor: ctx.actor, projectId: ctx.projectId, admissionId: null, decision, reason: code });
    throw new LimitsError(code, evaluation);
  }

  // ---------- Kill switch ----------

  function killState(projectId: string): KillSwitchState {
    return killProjects.get(projectId) ?? { engaged: false, reason: null, engagedAt: null, engagedBy: null };
  }

  // ---------- Provedores ----------

  const stillValid = (until: string | null) => until === null || Date.parse(until) > now();

  function activeUnavailability(key: string): ProviderUnavailability | null {
    const report = unavailability.get(key);
    if (!report) return null;
    if (!stillValid(report.until)) {
      unavailability.delete(key);
      return null;
    }
    return report;
  }

  /** Quotas oficiais ainda vigentes (as expiradas são descartadas). */
  function activeQuotas(key: string): ProviderQuota[] {
    const list = (quotas.get(key) ?? []).filter((q) => stillValid(q.until));
    if (list.length === 0) quotas.delete(key);
    else quotas.set(key, list);
    return list;
  }

  function validateReport(reason: unknown, until: unknown) {
    if (typeof reason !== 'string' || !REASON_TOKEN.test(reason)) throw new LimitsError('invalid_report');
    if (until !== null && (typeof until !== 'string' || !Number.isFinite(Date.parse(until)))) throw new LimitsError('invalid_report');
  }

  // ---------- Orçamento ----------

  /** Exposição de uma admissão: confirmado, se houver; senão a reserva (estimado ou desconhecido). */
  const exposure = (a: Admission) => (a.cost.status === 'confirmed' ? (a.cost.confirmedMinor ?? 0) : a.cost.reservedMinor);

  function committed(filter: (a: Admission) => boolean = () => true): number {
    let total = 0;
    for (const a of admissions.values()) if (filter(a)) total += exposure(a);
    return total;
  }

  // ---------- Ciclo de vida ----------

  const isActive = (a: Admission) => a.state === 'admitted';
  /** Vaga ocupada: a operação pode estar ativa (inclusive depois do término lógico). */
  const holdsCapacity = (a: Admission) => a.capacity === 'held';

  function releaseCapacity(a: Admission, reason: string, actor: string) {
    if (a.capacity === 'released') return;
    a.capacity = 'released';
    audit({ event: 'capacity_released', actor, projectId: a.projectId, admissionId: a.id, decision: 'recorded', reason });
  }

  /**
   * Pede cancelamento a quem hospeda a execução e registra o resultado (sem prometer interrupção).
   * Só `cancelled` libera a vaga; `failed`, `not_supported` e `pending` a mantêm ocupada. Um pedido
   * em andamento não é duplicado.
   */
  async function requestCancellation(a: Admission, event: string): Promise<CancellationResult | 'pending'> {
    if (a.cancellation?.result === 'pending') return 'pending';
    a.cancellation = { requestedAt: iso(), result: 'pending' };
    let result: CancellationResult = 'not_supported';
    if (options.cancelHandler) {
      try {
        result = await options.cancelHandler(structuredClone(a));
        if (!['cancelled', 'not_supported', 'failed'].includes(result)) result = 'failed';
      } catch {
        result = 'failed';
      }
    }
    a.cancellation = { requestedAt: a.cancellation.requestedAt, result };
    audit({ event, actor: 'system:acc', projectId: a.projectId, admissionId: a.id, decision: 'recorded', reason: `cancellation_${result}` });
    if (result === 'cancelled') releaseCapacity(a, 'cancellation_confirmed', 'system:acc');
    return result;
  }

  /** Término LÓGICO (estado). Não libera a vaga: isso depende de confirmação (ver `capacity`). */
  function finish(a: Admission, state: Admission['state'], reason: string | null) {
    a.state = state;
    a.reason = reason;
    a.finishedAt = iso();
    // Reserva não confirmada passa a "desconhecido": continua contando (conservador).
    if (a.cost.status === 'estimated') a.cost.status = 'unknown';
  }

  /** Expira (sincronamente) o que passou do prazo; devolve as expiradas para pedir cancelamento. */
  function sweepOverdue(): Admission[] {
    const expired: Admission[] = [];
    for (const a of admissions.values()) {
      if (isActive(a) && Date.parse(a.deadline) <= now()) {
        finish(a, 'expired', 'duration_exceeded');
        audit({ event: 'admission_expired', actor: 'system:acc', projectId: a.projectId, admissionId: a.id, decision: 'recorded', reason: 'duration_exceeded' });
        expired.push(a);
      }
    }
    return expired;
  }

  function find(ownerId: string, projectId: string, id: string): Admission {
    const a = admissions.get(id);
    if (!a || a.ownerId !== ownerId || a.projectId !== projectId) throw new LimitsError('not_found');
    return a;
  }

  function policyCheck(ownerId: string, input: AdmissionRequestInput, action: PolicyAction, approval: ApprovalGrant | null) {
    const project = options.projects.get(ownerId, input.projectId);
    const task = project ? options.tasks.get(ownerId, input.projectId, input.taskId) : null;
    return evaluatePolicy(
      policy,
      {
        subject: { kind: 'agent', id: input.agentId },
        action,
        projectId: input.projectId,
        resource: { type: 'task', id: input.taskId },
        target: { sha: null, ref: null },
        approval,
      },
      {
        projectAccessible: project !== null,
        agentAssigned: task?.assignee?.kind === 'agent' && task.assignee.agentId === input.agentId,
        now: now(),
        usedApprovals,
      },
      policyCatalog,
    );
  }

  function requirePolicyAllow(evaluation: PolicyEvaluation, ctx: { actor: string; projectId: string }, prefix: '' | 'spend_') {
    if (evaluation.decision === 'ALLOW' && (!evaluation.requiresApproval || evaluation.approvalId !== null)) return;
    if (evaluation.decision === 'UNAVAILABLE') deny(prefix === 'spend_' ? 'paid_usage_unavailable' : 'capability_unavailable', ctx, evaluation, 'unavailable');
    if (evaluation.decision === 'REQUIRE_APPROVAL') deny(`${prefix}${evaluation.reason === 'approval_invalid' ? 'approval_invalid' : 'approval_required'}`, ctx, evaluation);
    deny(`${prefix}policy_denied`, ctx, evaluation);
  }

  /** Problema da aprovação humana para esta operação exata, ou `null`. */
  function humanApprovalProblem(approval: HumanApproval, operation: HumanApproval['operation'], target: string): string | null {
    if (usedHumanApprovals.has(approval.id)) return 'approval_already_used';
    if (approval.operation !== operation) return 'approval_wrong_operation';
    if (approval.target !== target) return 'approval_wrong_target';
    const approvedAt = Date.parse(approval.approvedAt);
    const expiresAt = Date.parse(approval.expiresAt);
    if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) return 'approval_invalid_dates';
    if (expiresAt <= approvedAt || expiresAt - approvedAt > MAX_HUMAN_APPROVAL_TTL_MS) return 'approval_invalid_validity';
    if (now() < approvedAt) return 'approval_not_yet_valid';
    if (now() >= expiresAt) return 'approval_expired';
    return null;
  }

  function consumeHumanApproval(actor: ControllerActor, raw: unknown, operation: HumanApproval['operation'], target: string, projectId: string | null) {
    const ctx = { actor: actorLabel(actor), projectId };
    // Só uma pessoa autenticada pede; agentes e o sistema nunca alteram limites nem reativam.
    if (actor.kind !== 'human') {
      audit({ event: operation, actor: ctx.actor, projectId, admissionId: null, decision: 'denied', reason: 'human_required' });
      throw new LimitsError('human_required');
    }
    let approval: HumanApproval;
    try {
      approval = parseHumanApproval(raw);
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'invalid_approval';
      audit({ event: operation, actor: ctx.actor, projectId, admissionId: null, decision: 'denied', reason: code });
      throw new LimitsError(code);
    }
    // Origem: campos válidos não bastam. Sem verificador confiável, a mudança sensível é negada.
    const verifier = options.approvalVerifier;
    if (!verifier) {
      audit({ event: operation, actor: ctx.actor, projectId, admissionId: null, decision: 'denied', reason: 'approval_verifier_unavailable' });
      throw new LimitsError('approval_verifier_unavailable');
    }
    let verification: ReturnType<ApprovalVerifier['verify']>;
    try {
      verification = verifier.verify(structuredClone(approval));
    } catch {
      verification = { authentic: false, reason: 'approval_verification_failed' };
    }
    if (!verification.authentic) {
      const detail = REASON_TOKEN.test(verification.reason) ? verification.reason : 'approval_not_authentic';
      audit({ event: operation, actor: ctx.actor, projectId, admissionId: null, decision: 'denied', reason: detail });
      throw new LimitsError('approval_not_authentic');
    }
    // Identidade autenticada pelo verificador deve ser exatamente a declarada, e humana.
    if (verification.approverId !== approval.approvedBy.id || isAgentId(verification.approverId)) {
      audit({ event: operation, actor: ctx.actor, projectId, admissionId: null, decision: 'denied', reason: 'approver_identity_mismatch' });
      throw new LimitsError('approver_identity_mismatch');
    }
    const problem = humanApprovalProblem(approval, operation, target);
    if (problem) {
      audit({ event: operation, actor: ctx.actor, projectId, admissionId: null, decision: 'denied', reason: problem });
      throw new LimitsError(problem);
    }
    usedHumanApprovals.add(approval.id);
  }

  return {
    /**
     * Admite uma tarefa/execução se TODAS as verificações passarem. Idempotente pela chave do
     * chamador (por dono): o mesmo pedido devolve a mesma admissão, sem nova reserva.
     */
    admit(ownerId: string, raw: unknown, approvals: { action?: ApprovalGrant | null; spend?: ApprovalGrant | null } = {}): Admission {
      const input = parseAdmissionRequest(raw, limits);
      const actor = `agent:${input.agentId}`;
      const ctx = { actor, projectId: input.projectId };

      // Idempotência antes de tudo: repetir um pedido já admitido não cria nada novo.
      const idemKey = `${ownerId}|${input.idempotencyKey}`;
      const fingerprint = requestFingerprint(input);
      const previous = byIdempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) deny('idempotency_conflict', ctx);
        audit({ event: 'admission_replayed', actor, projectId: input.projectId, admissionId: previous.admissionId, decision: 'recorded', reason: 'idempotent_replay' });
        return structuredClone(admissions.get(previous.admissionId)!);
      }

      // Expira as vencidas e pede o cancelamento; a vaga só volta se ele for confirmado.
      for (const a of sweepOverdue()) void requestCancellation(a, 'admission_cancel_requested');

      if (killGlobal.engaged) deny('kill_switch_engaged', ctx);
      if (killState(input.projectId).engaged) deny('kill_switch_engaged', ctx);

      const project = options.projects.get(ownerId, input.projectId);
      if (!project) deny('not_found', ctx);
      const task = options.tasks.get(ownerId, input.projectId, input.taskId);
      if (!task) deny('not_found', ctx);
      if (task!.status === 'done' || task!.status === 'cancelled') deny('task_not_active', ctx);

      // Provedor: a escolha do modo não prova que a conta oferece a capacidade.
      const key = `${input.agentId}|${input.mode}`;
      const profile = providers.get(key);
      if (!profile) deny('provider_unavailable', ctx, null, 'unavailable');
      if (profile!.status === 'unverified') deny('provider_unverified', ctx, null, 'unavailable');
      if (profile!.status !== 'available') deny('provider_unavailable', ctx, null, 'unavailable');
      if (activeUnavailability(key)) deny('provider_unavailable', ctx, null, 'unavailable');
      // Quotas oficiais: o limite do catálogo E todas as quotas relatadas vigentes se aplicam
      // (cada uma restringe; nenhuma substitui ou amplia outra).
      const officialLimits = [...(profile!.officialRequestLimit ? [profile!.officialRequestLimit] : []), ...activeQuotas(key)];
      for (const limit of officialLimits) {
        const since = now() - limit.windowSeconds * 1000;
        const recent = [...admissions.values()].filter((a) => a.agentId === input.agentId && a.mode === input.mode && Date.parse(a.admittedAt) > since);
        if (recent.length >= limit.count) deny('provider_request_limit', ctx);
      }

      // Custo: SEMPRE pelo catálogo do servidor. Desconhecido = bloqueado.
      const metered = input.mode === 'metered_api';
      if (profile!.billing === 'unknown') deny('cost_unknown', ctx);
      if (profile!.billing === 'metered' && !metered) deny('cost_unknown', ctx);
      if (metered && profile!.billing !== 'metered') deny('cost_unknown', ctx);

      // Quotas do ACC.
      // Concorrência conta VAGAS OCUPADAS, não só estados ativos: operação cancelada ou expirada
      // sem interrupção confirmada continua potencialmente ativa.
      const occupied = [...admissions.values()].filter(holdsCapacity).length;
      if (occupied >= limits.maxConcurrent) deny('concurrency_limit', ctx);
      const windowStart = now() - limits.rateLimit.windowSeconds * 1000;
      if ([...admissions.values()].filter((a) => Date.parse(a.admittedAt) > windowStart).length >= limits.rateLimit.count) deny('rate_limited', ctx);

      // Autorização da #020 para a ação em si.
      const actionEval = policyCheck(ownerId, input, input.action, approvals.action ?? null);
      requirePolicyAllow(actionEval, ctx, '');

      // Custo > 0: ação crítica `spend.create` (#020) + orçamento global/projeto/provedor.
      let spendEval: PolicyEvaluation | null = null;
      const estimate = metered ? input.estimatedCostMinor! : 0;
      if (metered) {
        spendEval = policyCheck(ownerId, input, 'spend.create', approvals.spend ?? null);
        requirePolicyAllow(spendEval, ctx, 'spend_');
        if (committed() + estimate > limits.budget.globalMinor) deny('budget_exceeded', ctx);
        const projectCap = limits.budget.perProjectMinor[input.projectId];
        if (projectCap !== undefined && committed((a) => a.projectId === input.projectId) + estimate > projectCap) deny('project_budget_exceeded', ctx);
        const providerCap = limits.budget.perProviderMinor[input.agentId];
        if (providerCap !== undefined && committed((a) => a.agentId === input.agentId) + estimate > providerCap) deny('provider_budget_exceeded', ctx);
      }

      // Tudo aprovado: consome aprovações (uso único) e registra a admissão com a reserva.
      const approvalIds = [actionEval.approvalId, spendEval?.approvalId ?? null].filter((id): id is string => id !== null);
      for (const id of approvalIds) usedApprovals.add(id);
      const at = now();
      const admission: Admission = {
        id: generateId(),
        idempotencyKey: input.idempotencyKey,
        ownerId,
        projectId: input.projectId,
        taskId: input.taskId,
        agentId: input.agentId,
        action: input.action,
        mode: input.mode,
        state: 'admitted',
        reason: null,
        admittedAt: iso(at),
        deadline: iso(at + input.durationSeconds * 1000),
        finishedAt: null,
        cost: { status: metered ? 'estimated' : 'none', reservedMinor: estimate, confirmedMinor: null, currency: BUDGET_CURRENCY },
        tokens: metered ? { ceiling: input.maxTokens!, reported: null } : null,
        cancellation: null,
        capacity: 'held',
        approvalIds,
      };
      admissions.set(admission.id, admission);
      byIdempotency.set(idemKey, { admissionId: admission.id, fingerprint });
      audit({ event: 'admission_decision', actor, projectId: input.projectId, admissionId: admission.id, decision: 'allowed', reason: metered ? 'admitted_with_reservation' : 'admitted_no_additional_cost' });
      return structuredClone(admission);
    },

    /** Encerra uma admissão e reconcilia o custo informado pelo provedor. */
    complete(ownerId: string, projectId: string, id: string, outcome: 'completed' | 'failed', usage: UsageReport): Admission {
      const a = find(ownerId, projectId, id);
      if (!isActive(a)) throw new LimitsError('invalid_transition');
      if (Date.parse(a.deadline) <= now()) {
        finish(a, 'expired', 'duration_exceeded');
        audit({ event: 'admission_expired', actor: 'system:acc', projectId, admissionId: id, decision: 'recorded', reason: 'duration_exceeded' });
        void requestCancellation(a, 'admission_cancel_requested');
        throw new LimitsError('expired');
      }
      const metered = a.mode === 'metered_api';
      if (!metered && usage.tokens !== null) throw new LimitsError('tokens_not_applicable');
      const cost = usage.cost;
      if (cost.kind === 'confirmed' && (!Number.isInteger(cost.amountMinor) || cost.amountMinor < 0)) throw new LimitsError('invalid_usage');
      if (usage.tokens !== null && (!Number.isInteger(usage.tokens) || usage.tokens < 0)) throw new LimitsError('invalid_usage');

      finish(a, outcome, outcome === 'failed' ? 'provider_reported_failure' : null);
      // Término informado por quem executa: a operação acabou, a vaga pode ser liberada.
      releaseCapacity(a, 'provider_reported_end', 'system:acc');
      if (cost.kind === 'confirmed') {
        a.cost.status = 'confirmed';
        a.cost.confirmedMinor = cost.amountMinor;
        if (!metered && cost.amountMinor > 0) {
          audit({ event: 'cost_alert', actor: 'system:acc', projectId, admissionId: id, decision: 'recorded', reason: 'unexpected_charge' });
        } else if (cost.amountMinor > a.cost.reservedMinor) {
          audit({ event: 'cost_alert', actor: 'system:acc', projectId, admissionId: id, decision: 'recorded', reason: 'budget_overrun' });
        }
      } else if (cost.kind === 'unknown' || metered) {
        // Provedor não informou: não se inventa valor; a reserva continua contando.
        a.cost.status = 'unknown';
      }
      if (a.tokens) {
        a.tokens.reported = usage.tokens;
        if (usage.tokens !== null && usage.tokens > a.tokens.ceiling) {
          audit({ event: 'cost_alert', actor: 'system:acc', projectId, admissionId: id, decision: 'recorded', reason: 'token_ceiling_exceeded' });
        }
      }
      audit({ event: 'admission_finished', actor: 'system:acc', projectId, admissionId: id, decision: 'recorded', reason: `${outcome}_cost_${a.cost.status}` });
      return structuredClone(a);
    },

    /**
     * Cancela uma admissão ativa (término lógico + pedido de interrupção). Em admissão já
     * encerrada cuja interrupção não foi confirmada (`failed`/`not_supported`), repete o pedido
     * sem mudar o estado. Pedido em andamento não é duplicado.
     */
    async cancel(ownerId: string, projectId: string, id: string): Promise<Admission> {
      const a = find(ownerId, projectId, id);
      if (isActive(a)) {
        finish(a, 'cancelled', 'cancelled_by_user');
      } else if (!(holdsCapacity(a) && a.cancellation !== null && a.cancellation.result !== 'pending')) {
        throw new LimitsError('invalid_transition');
      }
      await requestCancellation(a, 'admission_cancel_requested');
      return structuredClone(a);
    },

    /**
     * Confirmação EXPLÍCITA de que uma operação já encerrada logicamente não está mais ativa
     * (ex.: uso assistido em que a própria pessoa parou, ou o host atesta a parada). Só a pessoa
     * dona do projeto ou o host (`system`); auditado. Libera a vaga de concorrência.
     */
    confirmStopped(actor: ControllerActor, ownerId: string, projectId: string, id: string): Admission {
      const label = actorLabel(actor ?? ({ kind: 'unknown', id: 'unknown' } as never));
      const allowed = (actor?.kind === 'human' && actor.id === ownerId) || (actor?.kind === 'system' && actor.id === 'acc');
      if (!allowed) {
        audit({ event: 'capacity_released', actor: label, projectId, admissionId: id, decision: 'denied', reason: 'invalid_actor' });
        throw new LimitsError('invalid_actor');
      }
      const a = find(ownerId, projectId, id);
      // Ativa: use `complete` ou `cancel`. Pedido de cancelamento em andamento: aguarde o resultado.
      if (isActive(a) || a.cancellation?.result === 'pending') throw new LimitsError('invalid_transition');
      if (!holdsCapacity(a)) return structuredClone(a);
      releaseCapacity(a, actor.kind === 'human' ? 'stop_confirmed_by_human' : 'stop_confirmed_by_host', label);
      return structuredClone(a);
    },

    async expireOverdue(): Promise<Admission[]> {
      const expired = sweepOverdue();
      await Promise.all(expired.map((a) => requestCancellation(a, 'admission_cancel_requested')));
      return expired.map((a) => structuredClone(a));
    },

    /**
     * Kill switch: bloqueia novas admissões IMEDIATAMENTE (antes de qualquer `await`) e pede
     * cancelamento das ativas no escopo. Pessoa autenticada ou o próprio sistema podem acionar.
     */
    async engageKillSwitch(actor: ControllerActor, scope: KillSwitchScope, reason: string) {
      // Tipos não bastam em tempo de execução: agentes nunca operam o kill switch.
      if (!(actor?.kind === 'human' || (actor?.kind === 'system' && actor.id === 'acc'))) throw new LimitsError('invalid_actor');
      const label = actorLabel(actor);
      const safeReason = REASON_TOKEN.test(reason) ? reason : 'unspecified';
      const projectId = scope.kind === 'project' ? scope.projectId : null;
      if (scope.kind === 'project' && actor.kind === 'human' && !options.projects.get(actor.id, scope.projectId)) {
        audit({ event: 'killswitch_engage', actor: label, projectId, admissionId: null, decision: 'denied', reason: 'not_found' });
        throw new LimitsError('not_found');
      }
      const state: KillSwitchState = { engaged: true, reason: safeReason, engagedAt: iso(), engagedBy: label };
      if (scope.kind === 'global') Object.assign(killGlobal, state);
      else killProjects.set(scope.projectId, state);
      audit({ event: 'killswitch_engage', actor: label, projectId, admissionId: null, decision: 'recorded', reason: safeReason });

      // Alvos: ativas no escopo E encerradas cuja interrupção nunca foi confirmada (pede de novo).
      const inScope = (a: Admission) => scope.kind === 'global' || a.projectId === scope.projectId;
      const targets = [...admissions.values()].filter((a) => inScope(a) && (isActive(a) || (holdsCapacity(a) && a.cancellation?.result !== 'pending')));
      for (const a of targets) if (isActive(a)) finish(a, 'cancelled', 'kill_switch');
      const results = await Promise.all(targets.map(async (a) => ({ admissionId: a.id, result: await requestCancellation(a, 'killswitch_cancel_requested') })));
      return { scope, state: structuredClone(state), cancellations: results };
    },

    /** Reativação: só pessoa autenticada, com aprovação humana exata para este escopo. */
    releaseKillSwitch(actor: ControllerActor, scope: KillSwitchScope, approval: unknown): KillSwitchState {
      const target = scope.kind === 'global' ? 'global' : scope.projectId;
      const projectId = scope.kind === 'project' ? scope.projectId : null;
      if (scope.kind === 'project' && actor.kind === 'human' && !options.projects.get(actor.id, scope.projectId)) throw new LimitsError('not_found');
      const current = scope.kind === 'global' ? killGlobal : killState(scope.projectId);
      if (!current.engaged) throw new LimitsError('not_engaged');
      consumeHumanApproval(actor, approval, 'killswitch.release', target, projectId);
      if (scope.kind === 'global') Object.assign(killGlobal, { engaged: false, reason: null, engagedAt: null, engagedBy: null });
      else killProjects.delete(scope.projectId);
      audit({ event: 'killswitch.release', actor: actorLabel(actor), projectId, admissionId: null, decision: 'allowed', reason: 'human_approved' });
      return structuredClone(scope.kind === 'global' ? killGlobal : killState(scope.projectId));
    },

    killSwitchStatus(projectId?: string) {
      return { global: structuredClone(killGlobal), project: projectId ? structuredClone(killState(projectId)) : null };
    },

    /** Alteração de limites: só pessoa autenticada, com aprovação humana para ESTES limites exatos. */
    updateLimits(actor: ControllerActor, proposed: unknown, approval: unknown): ControllerLimits {
      let next: ControllerLimits;
      try {
        next = parseLimits(proposed);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'invalid_limits';
        audit({ event: 'limits.change', actor: actorLabel(actor), projectId: null, admissionId: null, decision: 'denied', reason: code });
        throw new LimitsError(code);
      }
      consumeHumanApproval(actor, approval, 'limits.change', limitsFingerprint(next), null);
      limits = next;
      audit({ event: 'limits.change', actor: actorLabel(actor), projectId: null, admissionId: null, decision: 'allowed', reason: 'human_approved' });
      return structuredClone(limits);
    },

    getLimits: (): ControllerLimits => structuredClone(limits),

    /**
     * Relato OFICIAL de indisponibilidade temporária. Só restringe: não há relato que torne um
     * provedor disponível (isso é o catálogo revisado, #028).
     */
    reportProviderUnavailable(provider: AgentRef, mode: UsageMode, report: ProviderUnavailability) {
      if (!isAgentId(provider) || !providers.has(`${provider}|${mode}`)) throw new LimitsError('provider_unknown');
      if (typeof report !== 'object' || report === null || Object.keys(report).some((k) => !['reason', 'until'].includes(k))) throw new LimitsError('invalid_report');
      validateReport(report.reason, report.until);
      unavailability.set(`${provider}|${mode}`, { reason: report.reason, until: report.until });
      audit({ event: 'provider_unavailable_report', actor: 'system:acc', projectId: null, admissionId: null, decision: 'recorded', reason: report.reason });
    },

    /**
     * Quota OFICIAL de solicitações, SEM declarar o provedor indisponível. Só restringe: é aplicada
     * junto com o limite do catálogo e com as demais quotas vigentes; um relato mais "generoso"
     * não substitui um anterior mais restritivo. Não torna disponível o que não foi verificado.
     */
    reportProviderQuota(provider: AgentRef, mode: UsageMode, quota: ProviderQuota) {
      const key = `${provider}|${mode}`;
      if (!isAgentId(provider) || !providers.has(key)) throw new LimitsError('provider_unknown');
      if (typeof quota !== 'object' || quota === null || Object.keys(quota).some((k) => !['reason', 'count', 'windowSeconds', 'until'].includes(k))) {
        throw new LimitsError('invalid_report');
      }
      validateReport(quota.reason, quota.until);
      const positiveInt = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
      if (!positiveInt(quota.count, 1_000_000) || !positiveInt(quota.windowSeconds, 31 * 24 * 60 * 60)) throw new LimitsError('invalid_report');
      const list = activeQuotas(key);
      if (list.length >= MAX_ACTIVE_QUOTAS) throw new LimitsError('too_many_quotas');
      quotas.set(key, [...list, { reason: quota.reason, count: quota.count, windowSeconds: quota.windowSeconds, until: quota.until }]);
      audit({ event: 'provider_quota_report', actor: 'system:acc', projectId: null, admissionId: null, decision: 'recorded', reason: quota.reason });
    },

    providerStatus(provider: AgentRef, mode: UsageMode) {
      const key = `${provider}|${mode}`;
      const profile = providers.get(key);
      if (!profile) return null;
      const outage = activeUnavailability(key);
      // `effectiveStatus` nunca é mais permissivo que o catálogo.
      const effectiveStatus = profile.status !== 'available' ? profile.status : outage ? 'unavailable' : 'available';
      return { ...structuredClone(profile), effectiveStatus, unavailability: outage ? structuredClone(outage) : null, quotas: structuredClone(activeQuotas(key)) };
    },

    budgetSummary() {
      const all = [...admissions.values()];
      const sum = (status: Admission['cost']['status']) => all.filter((a) => a.cost.status === status).reduce((total, a) => total + exposure(a), 0);
      return {
        currency: BUDGET_CURRENCY,
        authorizedMinor: limits.budget.globalMinor,
        committedMinor: committed(),
        estimatedMinor: sum('estimated'),
        confirmedMinor: sum('confirmed'),
        unknownMinor: sum('unknown'),
      };
    },

    get(ownerId: string, projectId: string, id: string): Admission | null {
      const a = admissions.get(id);
      return a && a.ownerId === ownerId && a.projectId === projectId ? structuredClone(a) : null;
    },

    list(ownerId: string, projectId: string): Admission[] {
      return [...admissions.values()].filter((a) => a.ownerId === ownerId && a.projectId === projectId).map((a) => structuredClone(a));
    },

    /** Admissões em estado `admitted` (término lógico ainda não ocorreu). */
    activeCount: () => [...admissions.values()].filter(isActive).length,

    /** Vagas de concorrência ocupadas (inclui operações encerradas sem interrupção confirmada). */
    capacityInUse: () => [...admissions.values()].filter(holdsCapacity).length,

    auditTrail: (): ControllerAuditEntry[] => structuredClone(auditTrail),
  };
}

export type LimitsController = ReturnType<typeof createLimitsController>;

/** Admissões terminais nunca voltam a `admitted` (exportado para testes de invariantes). */
export const isTerminalAdmission = (a: Admission) => ADMISSION_TERMINAL.includes(a.state);
