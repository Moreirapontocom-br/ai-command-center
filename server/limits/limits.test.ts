// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AGENT_IDS, POLICY_ACTIONS, type AgentRef, type ApprovalGrant, type PolicyAction, type Project, type Task } from '../../shared/contracts.ts';
import { createConsoleLogger } from '../logger.ts';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { DEFAULT_LIMITS, HARD_CEILINGS, USAGE_MODES, type CancellationResult, type ControllerLimits, type HumanApproval, type ProviderProfile } from './contracts.ts';
import { createLimitsController, LimitsError, type ControllerActor } from './controller.ts';
import { defaultProviderCatalog } from './providers.ts';
import { createSimulatedApprovalVerifier } from './simulatedApprovalVerifier.ts';
import { limitsFingerprint, LimitsValidationError } from './validation.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P2 = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const T1 = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const T2 = '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c';
const START = Date.parse('2026-11-14T12:00:00Z');
const HUMAN: ControllerActor = { kind: 'human', id: 'admin' };
const SYSTEM: ControllerActor = { kind: 'system', id: 'acc' };

const project = (id: string) => ({ id, repositories: [] }) as unknown as Project;
const task = (id: string, projectId: string, overrides: Partial<Task> = {}) =>
  ({ id, projectId, status: 'in_progress', assignee: { kind: 'agent', agentId: 'claude-code' }, ...overrides }) as Task;

/** Catálogo de provedores de TESTE: tudo "verificado". O padrão real é tudo `unverified`. */
const verifiedCatalog = (): ProviderProfile[] => defaultProviderCatalog().map((p) => ({ ...p, status: 'available', statusReason: 'verified_for_test' }));
/** Catálogo da #020 de TESTE: ferramentas e gasto "existem". No real, ambos são indisponíveis. */
const testPolicyCatalog = {
  ...POLICY_ACTIONS,
  'tool.use': { ...POLICY_ACTIONS['tool.use'], available: true },
  'spend.create': { ...POLICY_ACTIONS['spend.create'], available: true },
};

function setup(
  options: { real?: boolean; providers?: ProviderProfile[]; tasks?: Task[]; cancelHandler?: (a: unknown) => Promise<CancellationResult>; noVerifier?: boolean } = {},
) {
  let clock = START;
  let counter = 0;
  const projects = new Map([[`admin|${P1}`, project(P1)], [`admin|${P2}`, project(P2)]]);
  const tasks = options.tasks ?? [task(T1, P1), task(T2, P2)];
  const logLines: string[] = [];
  // Verificador SIMULADO e explícito (o confiável é da #011). `noVerifier` reproduz a produção atual.
  const verifier = createSimulatedApprovalVerifier();
  const controller = createLimitsController({
    approvalVerifier: options.noVerifier ? undefined : verifier,
    projects: { get: (owner, id) => projects.get(`${owner}|${id}`) ?? null },
    tasks: { get: (owner, projectId, id) => (projects.has(`${owner}|${projectId}`) ? (tasks.find((t) => t.id === id && t.projectId === projectId) ?? null) : null) },
    policyCatalog: options.real ? undefined : testPolicyCatalog,
    providers: options.real ? undefined : (options.providers ?? verifiedCatalog()),
    cancelHandler: options.cancelHandler as never,
    now: () => clock,
    generateId: () => `adm-${String(++counter).padStart(4, '0')}`,
    logger: createConsoleLogger((line) => logLines.push(line)),
  });
  let approvalSeq = 0;
  /** Monta uma aprovação SEM registrá-la no verificador (o que um chamador poderia forjar). */
  const forgeApproval = (operation: HumanApproval['operation'], target: string, overrides: Partial<HumanApproval> = {}): HumanApproval => ({
    id: `human-approval-${++approvalSeq}`,
    operation,
    target,
    approvedBy: { kind: 'human', id: 'admin' },
    approvedAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60 * 60 * 1000).toISOString(),
    ...overrides,
  });
  /** Aprovação "emitida" pelo fluxo (simulado) e, portanto, de origem verificável. */
  const humanApproval = (operation: HumanApproval['operation'], target: string, overrides: Partial<HumanApproval> = {}): HumanApproval =>
    verifier.issue(forgeApproval(operation, target, overrides));
  /** Altera limites pelo caminho oficial (aprovação humana para os limites exatos). */
  const approveLimits = (patch: Partial<ControllerLimits>) => {
    const next = { ...structuredClone(DEFAULT_LIMITS), ...patch } as ControllerLimits;
    return controller.updateLimits(HUMAN, next, humanApproval('limits.change', limitsFingerprint(next)));
  };
  return { controller, logLines, verifier, humanApproval, forgeApproval, approveLimits, advance: (ms: number) => (clock += ms), now: () => clock };
}

let keySeq = 0;
const subscription = (overrides: Record<string, unknown> = {}) => ({
  idempotencyKey: `key-${String(++keySeq).padStart(6, '0')}`,
  projectId: P1,
  taskId: T1,
  agentId: 'claude-code',
  action: 'task.read',
  mode: 'subscription_assisted',
  durationSeconds: 600,
  estimatedCostMinor: null,
  maxTokens: null,
  ...overrides,
});
const metered = (overrides: Record<string, unknown> = {}) => subscription({ mode: 'metered_api', estimatedCostMinor: 500, maxTokens: 20_000, ...overrides });

const grant = (action: PolicyAction, overrides: Partial<ApprovalGrant> = {}): ApprovalGrant => ({
  id: `grant-${action}-${++keySeq}`,
  action,
  projectId: P1,
  resource: { type: 'task', id: T1 },
  target: { sha: null, ref: null },
  subject: { kind: 'agent', id: 'claude-code' },
  approvedBy: { kind: 'human', id: 'admin' },
  approvedAt: '2026-11-14T12:00:00Z',
  expiresAt: '2026-11-14T18:00:00Z',
  ...overrides,
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'no_error';
};

describe('padrões aprovados pelo PO e catálogo real', () => {
  it('limites iniciais: R$ 0, 1 simultânea, 10 min, teto de tokens só para API', () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxConcurrent: 1,
      maxDurationSeconds: 600,
      rateLimit: { count: 30, windowSeconds: 3600 },
      budget: { globalMinor: 0, perProjectMinor: {}, perProviderMinor: {} },
      meteredApiTokenCeilingPerTask: 20_000,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it('catálogo real: nenhum provedor verificado; NENHUMA admissão em nenhum modo', () => {
    const { controller } = setup({ real: true });
    for (const agentId of AGENT_IDS) {
      for (const mode of USAGE_MODES) {
        const body = mode === 'metered_api' ? metered({ agentId }) : subscription({ agentId, mode });
        expect(code(() => controller.admit('admin', body))).toBe('provider_unverified');
      }
    }
    expect(controller.activeCount()).toBe(0);
    expect(controller.budgetSummary()).toMatchObject({ currency: 'BRL', authorizedMinor: 0, committedMinor: 0 });
  });

  it('classificação de cobrança conservadora: créditos gratuitos não presumidos, Nemotron sem assinatura', () => {
    const catalog = defaultProviderCatalog();
    expect(catalog.every((p) => p.status === 'unverified')).toBe(true);
    expect(catalog.filter((p) => p.mode === 'metered_api').every((p) => p.billing === 'metered')).toBe(true);
    expect(catalog.filter((p) => p.mode === 'official_integration').every((p) => p.billing === 'unknown')).toBe(true);
    expect(catalog.find((p) => p.provider === 'nemotron' && p.mode === 'subscription_assisted')?.billing).toBe('unknown');
  });

  it('execução real continua desabilitada (#021)', () => {
    expect(REAL_EXECUTION_ENABLED).toBe(false);
  });
});

describe('orçamento R$ 0 e operações pagas', () => {
  it('orçamento R$ 0: API cobrada é recusada mesmo com gasto aprovado; nada é reservado', () => {
    const { controller } = setup();
    expect(code(() => controller.admit('admin', metered(), { spend: grant('spend.create') }))).toBe('budget_exceeded');
    expect(controller.budgetSummary().committedMinor).toBe(0);
  });

  it('operação paga sem autorização de gasto: exige aprovação de spend.create (#020)', () => {
    const { controller, approveLimits } = setup();
    approveLimits({ budget: { globalMinor: 10_000, perProjectMinor: {}, perProviderMinor: {} } });
    expect(code(() => controller.admit('admin', metered()))).toBe('spend_approval_required');
    expect(code(() => controller.admit('admin', metered(), { spend: grant('spend.create', { subject: { kind: 'agent', id: 'gemini' } }) }))).toBe('spend_approval_invalid');
  });

  it('com o catálogo real da #020, gasto é indisponível mesmo com orçamento aprovado', () => {
    const providers = verifiedCatalog();
    const ctx = setup({ providers });
    // Recria com catálogo de política REAL e provedores verificados.
    const real = createLimitsController({
      projects: { get: (_o, id) => (id === P1 ? project(P1) : null) },
      tasks: { get: () => task(T1, P1) },
      providers,
      approvalVerifier: ctx.verifier,
      now: ctx.now,
    });
    const next = { ...structuredClone(DEFAULT_LIMITS), budget: { globalMinor: 10_000, perProjectMinor: {}, perProviderMinor: {} } };
    real.updateLimits(HUMAN, next, ctx.humanApproval('limits.change', limitsFingerprint(next)));
    expect(code(() => real.admit('admin', metered(), { spend: grant('spend.create') }))).toBe('paid_usage_unavailable');
    expect(real.budgetSummary().committedMinor).toBe(0);
  });

  it.each([
    ['campo "free" declarado pelo chamador', subscription({ free: true }), 'invalid_request'],
    ['campo "billing" declarado pelo chamador', metered({ billing: 'included' }), 'invalid_request'],
    ['API com estimativa zero (alegação de gratuidade)', metered({ estimatedCostMinor: 0 }), 'free_claim_not_trusted'],
    ['API sem estimativa (custo desconhecido)', metered({ estimatedCostMinor: null }), 'cost_estimate_required'],
    ['custo em fração de centavo', metered({ estimatedCostMinor: 1.5 }), 'invalid_cost_estimate'],
    ['assinatura com custo informado', subscription({ estimatedCostMinor: 100 }), 'cost_not_applicable'],
  ])('não confia no chamador: %s', (_case, body, expected) => {
    const { controller } = setup();
    expect(code(() => controller.admit('admin', body))).toBe(expected);
  });

  it('custo desconhecido é bloqueado: Nemotron sem assinatura e integrações oficiais não apuradas', () => {
    const { controller } = setup();
    expect(code(() => controller.admit('admin', subscription({ agentId: 'nemotron', taskId: T1 })))).toBe('cost_unknown');
    expect(code(() => controller.admit('admin', subscription({ mode: 'official_integration' })))).toBe('cost_unknown');
  });

  it('catálogo inconsistente (modo de assinatura marcado como cobrado) também é custo desconhecido', () => {
    const providers = verifiedCatalog().map((p) => (p.mode === 'subscription_assisted' ? { ...p, billing: 'metered' as const } : p));
    const { controller } = setup({ providers });
    expect(code(() => controller.admit('admin', subscription()))).toBe('cost_unknown');
  });
});

describe('reserva, reconciliação e concorrência de orçamento', () => {
  function funded(budget: Partial<ControllerLimits['budget']> = {}, extra: Partial<ControllerLimits> = {}) {
    const ctx = setup({ tasks: [task(T1, P1), task(T2, P2)] });
    ctx.approveLimits({ maxConcurrent: 4, budget: { globalMinor: 1_000, perProjectMinor: {}, perProviderMinor: {}, ...budget }, ...extra });
    const admitPaid = (overrides: Record<string, unknown> = {}) => {
      const body = metered(overrides);
      const p = (overrides.projectId as string) ?? P1;
      const t = (overrides.taskId as string) ?? T1;
      return ctx.controller.admit('admin', body, { spend: grant('spend.create', { projectId: p, resource: { type: 'task', id: t } }) });
    };
    return { ...ctx, admitPaid };
  }

  it('reservas concorrentes não ultrapassam o orçamento (uma passa, a outra é recusada)', async () => {
    const { controller, admitPaid } = funded();
    const results = await Promise.allSettled([Promise.resolve().then(() => admitPaid({ estimatedCostMinor: 600 })), Promise.resolve().then(() => admitPaid({ estimatedCostMinor: 600 }))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'budget_exceeded' } });
    expect(controller.budgetSummary()).toMatchObject({ committedMinor: 600, estimatedMinor: 600 });
  });

  it('reconciliação: confirmado menor libera a diferença; confirmado maior gera alerta de estouro', () => {
    const { controller, admitPaid } = funded();
    const a = admitPaid({ estimatedCostMinor: 600 });
    const done = controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'confirmed', amountMinor: 200 }, tokens: 1500 });
    expect(done.cost).toEqual({ status: 'confirmed', reservedMinor: 600, confirmedMinor: 200, currency: 'BRL' });
    expect(done.tokens).toEqual({ ceiling: 20_000, reported: 1500 });
    expect(admitPaid({ estimatedCostMinor: 800 }).state).toBe('admitted');
    expect(controller.budgetSummary()).toMatchObject({ committedMinor: 1000, confirmedMinor: 200, estimatedMinor: 800 });

    const second = controller.list('admin', P1).find((x) => x.state === 'admitted')!;
    controller.complete('admin', P1, second.id, 'completed', { cost: { kind: 'confirmed', amountMinor: 900 }, tokens: 25_000 });
    const alerts = controller.auditTrail().filter((e) => e.event === 'cost_alert').map((e) => e.reason);
    expect(alerts).toEqual(['budget_overrun', 'token_ceiling_exceeded']);
    expect(code(() => admitPaid({ estimatedCostMinor: 1 }))).toBe('budget_exceeded');
  });

  it('custo não informado pelo provedor fica "desconhecido" e a reserva continua contando', () => {
    const { controller, admitPaid } = funded();
    const a = admitPaid({ estimatedCostMinor: 700 });
    expect(controller.complete('admin', P1, a.id, 'failed', { cost: { kind: 'unknown' }, tokens: null }).cost).toMatchObject({ status: 'unknown', confirmedMinor: null });
    expect(controller.budgetSummary()).toMatchObject({ committedMinor: 700, unknownMinor: 700 });
    expect(code(() => admitPaid({ estimatedCostMinor: 400 }))).toBe('budget_exceeded');
  });

  it('restrições opcionais por projeto e por provedor só restringem', () => {
    const { admitPaid } = funded({ perProjectMinor: { [P1]: 300 }, perProviderMinor: { 'claude-code': 400 } });
    expect(code(() => admitPaid({ estimatedCostMinor: 301 }))).toBe('project_budget_exceeded');
    expect(admitPaid({ estimatedCostMinor: 300 }).state).toBe('admitted');
    // P2: sem teto de projeto, mas ainda sob o teto do provedor (300 + 101 > 400) e o global.
    expect(code(() => admitPaid({ projectId: P2, taskId: T2, estimatedCostMinor: 101 }))).toBe('provider_budget_exceeded');
    expect(admitPaid({ projectId: P2, taskId: T2, estimatedCostMinor: 100 }).state).toBe('admitted');
  });

  it('teto de tokens da API: pedido acima do teto é recusado', () => {
    const { controller } = funded();
    expect(code(() => controller.admit('admin', metered({ maxTokens: 20_001 })))).toBe('tokens_out_of_limits');
  });
});

describe('assinaturas: sem saldo de tokens presumido e sem cobrança adicional', () => {
  it('admissão por assinatura não tem tokens nem custo; pedir teto de tokens é recusado', () => {
    const { controller } = setup();
    expect(code(() => controller.admit('admin', subscription({ maxTokens: 20_000 })))).toBe('tokens_not_applicable');
    const a = controller.admit('admin', subscription());
    expect(a).toMatchObject({ state: 'admitted', mode: 'subscription_assisted', tokens: null, cost: { status: 'none', reservedMinor: 0, confirmedMinor: null } });
  });

  it('encerramento por assinatura não aceita consumo de tokens inventado e não gera custo', () => {
    const { controller } = setup();
    const a = controller.admit('admin', subscription());
    expect(code(() => controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: 1234 }))).toBe('tokens_not_applicable');
    const done = controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(done).toMatchObject({ state: 'completed', cost: { status: 'none', reservedMinor: 0 }, tokens: null });
    expect(controller.budgetSummary()).toMatchObject({ committedMinor: 0, confirmedMinor: 0, unknownMinor: 0 });
  });

  it('cobrança inesperada informada numa assinatura é registrada como alerta (sem esconder)', () => {
    const { controller } = setup();
    const a = controller.admit('admin', subscription());
    controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'confirmed', amountMinor: 50 }, tokens: null });
    expect(controller.auditTrail().filter((e) => e.event === 'cost_alert').map((e) => e.reason)).toEqual(['unexpected_charge']);
  });

  it('fluxo completo por assinatura não consome aprovação de gasto nem orçamento', () => {
    const { controller } = setup();
    for (let i = 0; i < 3; i++) {
      const a = controller.admit('admin', subscription());
      controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    }
    expect(controller.list('admin', P1).every((a) => a.approvalIds.length === 0 && a.cost.status === 'none')).toBe(true);
    expect(controller.budgetSummary().committedMinor).toBe(0);
  });
});

describe('admissão: permissões, idempotência, concorrência, duração e solicitações', () => {
  it('permissões da #020: agente sem a tarefa atribuída é negado; ferramenta exige aprovação de uso único', () => {
    const { controller } = setup({ tasks: [task(T1, P1, { assignee: { kind: 'agent', agentId: 'gemini' } }), task(T2, P2)] });
    expect(() => controller.admit('admin', subscription())).toThrow(LimitsError);
    expect(code(() => controller.admit('admin', subscription()))).toBe('policy_denied');

    const ok = setup();
    expect(code(() => ok.controller.admit('admin', subscription({ action: 'tool.use' })))).toBe('approval_required');
    const toolGrant = grant('tool.use');
    const a = ok.controller.admit('admin', subscription({ action: 'tool.use' }), { action: toolGrant });
    expect(a.approvalIds).toEqual([toolGrant.id]);
    ok.controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(code(() => ok.controller.admit('admin', subscription({ action: 'tool.use' }), { action: toolGrant }))).toBe('approval_invalid');
  });

  it('ação crítica da #020 nunca é liberada por admissão (push na main)', () => {
    const { controller } = setup();
    expect(code(() => controller.admit('admin', subscription({ action: 'repo.push_main' })))).toBe('policy_denied');
  });

  it('projeto de outro dono, tarefa inexistente ou inativa: recusados', () => {
    const { controller } = setup({ tasks: [task(T1, P1, { status: 'done' })] });
    expect(code(() => controller.admit('user-b', subscription()))).toBe('not_found');
    expect(code(() => controller.admit('admin', subscription({ projectId: P2, taskId: T2 })))).toBe('not_found');
    expect(code(() => controller.admit('admin', subscription()))).toBe('task_not_active');
  });

  it('idempotência: mesmo pedido devolve a mesma admissão; mesma chave com outro conteúdo é conflito', () => {
    const { controller } = setup();
    const body = subscription();
    const first = controller.admit('admin', body);
    const again = controller.admit('admin', { ...body });
    expect(again.id).toBe(first.id);
    expect(controller.activeCount()).toBe(1);
    expect(code(() => controller.admit('admin', { ...body, durationSeconds: 300 }))).toBe('idempotency_conflict');
    // Mesmo depois de encerrada, a chave continua apontando para a mesma admissão.
    controller.complete('admin', P1, first.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(controller.admit('admin', { ...body })).toMatchObject({ id: first.id, state: 'completed' });
    expect(controller.list('admin', P1)).toHaveLength(1);
  });

  it('idempotência com reserva: repetir um pedido pago não reserva de novo', () => {
    const { controller, approveLimits } = setup();
    approveLimits({ budget: { globalMinor: 1_000, perProjectMinor: {}, perProviderMinor: {} } });
    const body = metered({ estimatedCostMinor: 600 });
    const spend = grant('spend.create');
    const a = controller.admit('admin', body, { spend });
    expect(controller.admit('admin', { ...body }, { spend }).id).toBe(a.id);
    expect(controller.budgetSummary().committedMinor).toBe(600);
  });

  it('uma execução simultânea: a segunda é recusada até a primeira terminar', async () => {
    const { controller } = setup();
    const results = await Promise.allSettled([0, 1, 2].map(() => Promise.resolve().then(() => controller.admit('admin', subscription()))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['concurrency_limit', 'concurrency_limit']);
    const active = controller.list('admin', P1)[0];
    controller.complete('admin', P1, active.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
  });

  it('duração acima de 10 minutos é recusada', () => {
    const { controller } = setup();
    expect(code(() => controller.admit('admin', subscription({ durationSeconds: 601 })))).toBe('duration_out_of_limits');
  });

  it('expiração do prazo: encerrar depois do prazo é recusado; a vaga é liberada e o cancelamento pedido', async () => {
    const cancelHandler = vi.fn(async () => 'cancelled' as const);
    const { controller, advance } = setup({ cancelHandler });
    const a = controller.admit('admin', subscription({ durationSeconds: 60 }));
    advance(59_999);
    expect(code(() => controller.admit('admin', subscription()))).toBe('concurrency_limit');
    advance(1);
    expect(code(() => controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null }))).toBe('expired');
    await vi.waitFor(() => expect(controller.get('admin', P1, a.id)?.cancellation?.result).toBe('cancelled'));
    expect(controller.get('admin', P1, a.id)).toMatchObject({ state: 'expired', reason: 'duration_exceeded' });
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
    expect(cancelHandler).toHaveBeenCalledTimes(1);
  });

  it('expireOverdue expira e libera a vaga mesmo sem nova admissão; reserva não confirmada fica "desconhecida"', async () => {
    const { controller, approveLimits, advance } = setup();
    approveLimits({ budget: { globalMinor: 1_000, perProjectMinor: {}, perProviderMinor: {} } });
    controller.admit('admin', metered({ estimatedCostMinor: 400 }), { spend: grant('spend.create') });
    advance(600_000);
    const [expired] = await controller.expireOverdue();
    expect(expired).toMatchObject({ state: 'expired', cost: { status: 'unknown', reservedMinor: 400 }, cancellation: { result: 'not_supported' } });
    expect(controller.activeCount()).toBe(0);
    expect(controller.budgetSummary().unknownMinor).toBe(400);
  });

  it('limite de solicitações do ACC por janela', () => {
    const { controller, approveLimits, advance } = setup();
    approveLimits({ rateLimit: { count: 2, windowSeconds: 3600 } });
    for (let i = 0; i < 2; i++) {
      const a = controller.admit('admin', subscription());
      controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    }
    expect(code(() => controller.admit('admin', subscription()))).toBe('rate_limited');
    advance(3600_000);
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
  });

  it('estado terminal não é reaberto', async () => {
    const { controller } = setup();
    const a = controller.admit('admin', subscription());
    await controller.cancel('admin', P1, a.id);
    expect(code(() => controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null }))).toBe('invalid_transition');
    // Repetir o cancelamento só repete o PEDIDO de interrupção; o estado continua terminal.
    await expect(controller.cancel('admin', P1, a.id)).resolves.toMatchObject({ state: 'cancelled', reason: 'cancelled_by_user' });
    expect(controller.get('admin', P1, a.id)?.state).toBe('cancelled');
    // Interrupção confirmada: agora sim não há mais o que cancelar.
    controller.confirmStopped(HUMAN, 'admin', P1, a.id);
    await expect(controller.cancel('admin', P1, a.id)).rejects.toMatchObject({ code: 'invalid_transition' });
  });
});

describe('indisponibilidade e limites informados pelo provedor', () => {
  it('relato oficial de indisponibilidade bloqueia até o prazo informado', () => {
    const { controller, advance } = setup();
    controller.reportProviderUnavailable('claude-code', 'subscription_assisted', { reason: 'provider_outage', until: '2026-11-14T13:00:00Z' });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_unavailable');
    expect(controller.providerStatus('claude-code', 'subscription_assisted')).toMatchObject({ effectiveStatus: 'unavailable', unavailability: { reason: 'provider_outage' }, quotas: [] });
    // Outro provedor/modo não é afetado.
    expect(controller.providerStatus('chatgpt', 'subscription_assisted')).toMatchObject({ effectiveStatus: 'available', unavailability: null });
    advance(60 * 60 * 1000);
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
    expect(controller.providerStatus('claude-code', 'subscription_assisted')).toMatchObject({ effectiveStatus: 'available', unavailability: null });
  });

  it('relato só restringe: nunca torna um provedor disponível; formato inválido é recusado', () => {
    const { controller } = setup({ real: true });
    expect(code(() => controller.reportProviderUnavailable('chatgpt', 'subscription_assisted', { reason: 'ok', until: null, status: 'available' } as never))).toBe('invalid_report');
    expect(code(() => controller.reportProviderUnavailable('chatgpt', 'subscription_assisted', { reason: `leak ${CANARY_TOKEN}`, until: null }))).toBe('invalid_report');
    expect(code(() => controller.reportProviderUnavailable('skynet' as AgentRef, 'metered_api', { reason: 'x', until: null }))).toBe('provider_unknown');
    expect(code(() => controller.reportProviderQuota('chatgpt', 'subscription_assisted', { reason: 'quota', count: 10, windowSeconds: 60, until: null, status: 'available' } as never))).toBe('invalid_report');
    // Quota sobre provedor não verificado: registrada, mas ele continua indisponível para admissão.
    controller.reportProviderQuota('chatgpt', 'subscription_assisted', { reason: 'official_quota', count: 1000, windowSeconds: 60, until: null });
    expect(controller.providerStatus('chatgpt', 'subscription_assisted')).toMatchObject({ effectiveStatus: 'unverified', quotas: [{ count: 1000 }] });
    expect(code(() => controller.admit('admin', subscription({ agentId: 'chatgpt' })))).toBe('provider_unverified');
  });

  it('quota oficial é registrada SEM declarar o provedor indisponível e é aplicada', () => {
    const { controller } = setup();
    controller.reportProviderQuota('claude-code', 'subscription_assisted', { reason: 'official_quota', count: 1, windowSeconds: 3600, until: null });
    expect(controller.providerStatus('claude-code', 'subscription_assisted')).toMatchObject({ effectiveStatus: 'available', unavailability: null, quotas: [{ count: 1, windowSeconds: 3600 }] });
    const a = controller.admit('admin', subscription());
    controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_request_limit');
  });

  it('quota oficial expira no prazo informado; janela da quota também libera', () => {
    const { controller, advance } = setup();
    controller.reportProviderQuota('claude-code', 'subscription_assisted', { reason: 'official_quota', count: 1, windowSeconds: 24 * 3600, until: '2026-11-14T12:30:00Z' });
    const a = controller.admit('admin', subscription());
    controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_request_limit');
    advance(30 * 60 * 1000);
    expect(controller.providerStatus('claude-code', 'subscription_assisted')).toMatchObject({ quotas: [] });
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
  });

  it('quota mais generosa não amplia: a mais restritiva vigente e a do catálogo continuam valendo', () => {
    const providers = verifiedCatalog().map((p) => (p.provider === 'claude-code' && p.mode === 'subscription_assisted' ? { ...p, officialRequestLimit: { count: 2, windowSeconds: 3600 } } : p));
    const { controller } = setup({ providers });
    controller.reportProviderQuota('claude-code', 'subscription_assisted', { reason: 'official_quota', count: 1, windowSeconds: 3600, until: null });
    controller.reportProviderQuota('claude-code', 'subscription_assisted', { reason: 'official_quota_raised', count: 500, windowSeconds: 3600, until: null });
    const a = controller.admit('admin', subscription());
    controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_request_limit');

    // Sem quota relatada, o limite do catálogo (2/h) não é ampliado por uma quota maior.
    const other = setup({ providers });
    other.controller.reportProviderQuota('claude-code', 'subscription_assisted', { reason: 'official_quota', count: 500, windowSeconds: 3600, until: null });
    for (let i = 0; i < 2; i++) {
      const b = other.controller.admit('admin', subscription());
      other.controller.complete('admin', P1, b.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    }
    expect(code(() => other.controller.admit('admin', subscription()))).toBe('provider_request_limit');
  });

  it('quota e indisponibilidade são independentes: o fim da indisponibilidade não apaga a quota', () => {
    const { controller, advance } = setup();
    controller.reportProviderUnavailable('claude-code', 'subscription_assisted', { reason: 'provider_outage', until: '2026-11-14T12:10:00Z' });
    controller.reportProviderQuota('claude-code', 'subscription_assisted', { reason: 'official_quota', count: 1, windowSeconds: 3600, until: null });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_unavailable');
    advance(10 * 60 * 1000);
    const a = controller.admit('admin', subscription());
    controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_request_limit');
  });

  it('limite oficial de solicitações do provedor é respeitado', () => {
    const providers = verifiedCatalog().map((p) => (p.provider === 'claude-code' && p.mode === 'subscription_assisted' ? { ...p, officialRequestLimit: { count: 1, windowSeconds: 3600 } } : p));
    const { controller } = setup({ providers });
    const a = controller.admit('admin', subscription());
    controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    expect(code(() => controller.admit('admin', subscription()))).toBe('provider_request_limit');
  });

  it('provedor explicitamente indisponível no catálogo', () => {
    const providers = verifiedCatalog().map((p) => (p.provider === 'gemini' ? { ...p, status: 'unavailable' as const, statusReason: 'plan_does_not_include' } : p));
    const { controller } = setup({ providers, tasks: [task(T1, P1, { assignee: { kind: 'agent', agentId: 'gemini' } })] });
    expect(code(() => controller.admit('admin', subscription({ agentId: 'gemini' })))).toBe('provider_unavailable');
  });
});

describe('kill switch', () => {
  it('global: bloqueia novas admissões imediatamente e pede cancelamento das ativas', async () => {
    const cancelHandler = vi.fn(async () => 'cancelled' as const);
    const { controller } = setup({ cancelHandler });
    const a = controller.admit('admin', subscription());
    const engaging = controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    // Antes mesmo de os pedidos de cancelamento terminarem, nada novo entra.
    expect(code(() => controller.admit('admin', subscription({ projectId: P2, taskId: T2 })))).toBe('kill_switch_engaged');
    const result = await engaging;
    expect(result.cancellations).toEqual([{ admissionId: a.id, result: 'cancelled' }]);
    expect(controller.get('admin', P1, a.id)).toMatchObject({ state: 'cancelled', reason: 'kill_switch', cancellation: { result: 'cancelled' } });
    expect(controller.killSwitchStatus().global).toMatchObject({ engaged: true, reason: 'emergency_stop', engagedBy: 'human:admin' });
  });

  it('por projeto: bloqueia só aquele projeto', async () => {
    const { controller } = setup({ tasks: [task(T1, P1), task(T2, P2)] });
    await controller.engageKillSwitch(HUMAN, { kind: 'project', projectId: P1 }, 'project_stop');
    expect(code(() => controller.admit('admin', subscription()))).toBe('kill_switch_engaged');
    expect(controller.admit('admin', subscription({ projectId: P2, taskId: T2 })).state).toBe('admitted');
    expect(controller.killSwitchStatus(P1).project).toMatchObject({ engaged: true });
    expect(controller.killSwitchStatus(P2).project).toMatchObject({ engaged: false });
  });

  it('cancelamento sem suporte ou com falha é registrado honestamente (sem prometer interrupção)', async () => {
    const failing = setup({ cancelHandler: async () => Promise.reject(new Error(`token=${CANARY_TOKEN}`)) });
    failing.controller.admit('admin', subscription());
    expect((await failing.controller.engageKillSwitch(SYSTEM, { kind: 'global' }, 'auto_stop')).cancellations[0].result).toBe('failed');
    const unsupported = setup();
    unsupported.controller.admit('admin', subscription());
    expect((await unsupported.controller.engageKillSwitch(SYSTEM, { kind: 'global' }, 'auto_stop')).cancellations[0].result).toBe('not_supported');
    expect(failing.logLines.join('\n') + JSON.stringify(failing.controller.auditTrail())).not.toContain(CANARY_TOKEN);
  });

  it('agente não aciona nem reativa; projeto de outro dono: not_found', async () => {
    const { controller } = setup();
    await expect(controller.engageKillSwitch({ kind: 'agent', id: 'claude-code' } as never, { kind: 'global' }, 'x')).rejects.toMatchObject({ code: 'invalid_actor' });
    await expect(controller.engageKillSwitch({ kind: 'human', id: 'user-b' }, { kind: 'project', projectId: P1 }, 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reativação sem aprovação humana válida é recusada (e auditada)', async () => {
    const { controller, humanApproval, advance } = setup();
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    const release = (actor: ControllerActor, approval: unknown) => code(() => controller.releaseKillSwitch(actor, { kind: 'global' }, approval));
    expect(release(HUMAN, null)).toBe('invalid_approval');
    expect(release(SYSTEM, humanApproval('killswitch.release', 'global'))).toBe('human_required');
    expect(release(HUMAN, humanApproval('killswitch.release', 'global', { approvedBy: { kind: 'human', id: 'claude-code' } }))).toBe('approver_not_human');
    expect(release(HUMAN, { ...humanApproval('killswitch.release', 'global'), approvedBy: { kind: 'agent', id: 'gemini' } })).toBe('approver_not_human');
    expect(release(HUMAN, humanApproval('killswitch.release', P1))).toBe('approval_wrong_target');
    expect(release(HUMAN, humanApproval('limits.change', 'global'))).toBe('approval_wrong_operation');
    const stale = humanApproval('killswitch.release', 'global');
    advance(2 * 60 * 60 * 1000);
    expect(release(HUMAN, stale)).toBe('approval_expired');
    expect(release(HUMAN, humanApproval('killswitch.release', 'global', { expiresAt: '2026-11-20T00:00:00Z' }))).toBe('approval_invalid_validity');
    expect(controller.killSwitchStatus().global.engaged).toBe(true);
    expect(code(() => controller.admit('admin', subscription()))).toBe('kill_switch_engaged');
    const denials = controller.auditTrail().filter((e) => e.event === 'killswitch.release' && e.decision === 'denied');
    expect(denials.length).toBeGreaterThanOrEqual(6);
  });

  it('reativação com aprovação humana exata; aprovação é de uso único; global e projeto independentes', async () => {
    const { controller, humanApproval } = setup();
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    await controller.engageKillSwitch(HUMAN, { kind: 'project', projectId: P1 }, 'project_stop');
    const approval = humanApproval('killswitch.release', 'global');
    expect(controller.releaseKillSwitch(HUMAN, { kind: 'global' }, approval)).toMatchObject({ engaged: false });
    // Projeto continua bloqueado.
    expect(code(() => controller.admit('admin', subscription()))).toBe('kill_switch_engaged');
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'again');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, approval))).toBe('approval_already_used');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'project', projectId: P2 }, humanApproval('killswitch.release', P2)))).toBe('not_engaged');
  });
});

describe('alteração de limites exige aprovação humana', () => {
  it('sem aprovação, aprovação para outros limites, ator não humano ou acima do teto: recusada', () => {
    const { controller, humanApproval } = setup();
    const next = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: 2 };
    expect(code(() => controller.updateLimits(HUMAN, next, null))).toBe('invalid_approval');
    const other = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: 3 };
    expect(code(() => controller.updateLimits(HUMAN, next, humanApproval('limits.change', limitsFingerprint(other))))).toBe('approval_wrong_target');
    expect(code(() => controller.updateLimits(SYSTEM, next, humanApproval('limits.change', limitsFingerprint(next))))).toBe('human_required');
    expect(code(() => controller.updateLimits({ kind: 'agent', id: 'claude-code' } as never, next, humanApproval('limits.change', limitsFingerprint(next))))).toBe('human_required');
    const over = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: HARD_CEILINGS.maxConcurrent + 1 };
    expect(code(() => controller.updateLimits(HUMAN, over, humanApproval('limits.change', 'x')))).toBe('limit_out_of_bounds');
    const extra = { ...structuredClone(DEFAULT_LIMITS), unlimited: true };
    expect(code(() => controller.updateLimits(HUMAN, extra, humanApproval('limits.change', 'x')))).toBe('invalid_limits');
    expect(controller.getLimits()).toEqual(DEFAULT_LIMITS);
  });

  it('com aprovação exata, aplica; a mesma aprovação não serve duas vezes', () => {
    const { controller, humanApproval } = setup();
    const next = { ...structuredClone(DEFAULT_LIMITS), maxDurationSeconds: 300 };
    const approval = humanApproval('limits.change', limitsFingerprint(next));
    expect(controller.updateLimits(HUMAN, next, approval).maxDurationSeconds).toBe(300);
    expect(code(() => controller.admit('admin', subscription({ durationSeconds: 301 })))).toBe('duration_out_of_limits');
    expect(code(() => controller.updateLimits(HUMAN, next, approval))).toBe('approval_already_used');
  });

  it('limites devolvidos são cópias (não alteram o estado interno)', () => {
    const { controller } = setup();
    const copy = controller.getLimits();
    copy.budget.globalMinor = 999_999;
    expect(controller.getLimits().budget.globalMinor).toBe(0);
  });
});

describe('proteção de dados e credenciais', () => {
  it('segredos em motivos, chaves e aprovações nunca chegam ao registro auditável nem aos logs', async () => {
    const { controller, logLines, humanApproval } = setup();
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, `Bearer ${CANARY_TOKEN}`);
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, humanApproval('killswitch.release', 'global', { id: CANARY_TOKEN.slice(0, 120) + '!' })))).toBe('invalid_approval');
    expect(code(() => controller.admit('admin', subscription({ idempotencyKey: `secret ${CANARY_TOKEN}` })))).toBe('invalid_idempotency_key');
    const everything = JSON.stringify(controller.auditTrail()) + logLines.join('\n') + JSON.stringify(controller.killSwitchStatus());
    expect(everything).not.toContain(CANARY_TOKEN);
    expect(controller.killSwitchStatus().global.reason).toBe('unspecified');
  });

  it('erros carregam só códigos; o registro auditável só tem tokens', () => {
    const { controller } = setup();
    try {
      controller.admit('admin', subscription({ projectId: `../${CANARY_TOKEN}` }));
    } catch (error) {
      expect(error).toBeInstanceOf(LimitsValidationError);
      expect((error as Error).message).toBe('invalid_project');
    }
    controller.admit('admin', subscription());
    for (const entry of controller.auditTrail()) expect(entry.reason).toMatch(/^[a-z0-9_]{1,48}$/);
  });

  it('admissões devolvidas são cópias', () => {
    const { controller } = setup();
    const a = controller.admit('admin', subscription());
    a.state = 'completed';
    a.cost.reservedMinor = -1;
    expect(controller.get('admin', P1, a.id)).toMatchObject({ state: 'admitted', cost: { reservedMinor: 0 } });
    expect(controller.get('user-b', P1, a.id)).toBeNull();
  });
});

describe('R1: autenticidade das aprovações humanas', () => {
  it('sem verificador confiável (produção atual), mudanças sensíveis são negadas mesmo com aprovação "perfeita"', async () => {
    const { controller, forgeApproval } = setup({ noVerifier: true });
    const next = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: 2 };
    expect(code(() => controller.updateLimits(HUMAN, next, forgeApproval('limits.change', limitsFingerprint(next))))).toBe('approval_verifier_unavailable');
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, forgeApproval('killswitch.release', 'global')))).toBe('approval_verifier_unavailable');
    expect(controller.getLimits()).toEqual(DEFAULT_LIMITS);
    expect(controller.killSwitchStatus().global.engaged).toBe(true);
    expect(controller.auditTrail().filter((e) => e.reason === 'approval_verifier_unavailable')).toHaveLength(2);
  });

  it('aprovação forjada (campos, datas e alvo válidos, mas não emitida) é recusada', async () => {
    const { controller, forgeApproval } = setup();
    const next = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: 2 };
    expect(code(() => controller.updateLimits(HUMAN, next, forgeApproval('limits.change', limitsFingerprint(next))))).toBe('approval_not_authentic');
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, forgeApproval('killswitch.release', 'global')))).toBe('approval_not_authentic');
    expect(controller.auditTrail().filter((e) => e.reason === 'approval_not_issued')).toHaveLength(2);
    expect(controller.getLimits().maxConcurrent).toBe(1);
  });

  it('aprovação emitida e depois adulterada (alvo, validade ou operação) é recusada', async () => {
    const { controller, humanApproval } = setup();
    const next = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: 2 };
    const genuineForOther = humanApproval('limits.change', limitsFingerprint(DEFAULT_LIMITS));
    expect(code(() => controller.updateLimits(HUMAN, next, { ...genuineForOther, target: limitsFingerprint(next) }))).toBe('approval_not_authentic');
    const genuine = humanApproval('limits.change', limitsFingerprint(next));
    expect(code(() => controller.updateLimits(HUMAN, next, { ...genuine, expiresAt: '2026-11-15T11:00:00.000Z' }))).toBe('approval_not_authentic');
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, { ...genuine, operation: 'killswitch.release', target: 'global' }))).toBe('approval_not_authentic');
    expect(controller.auditTrail().filter((e) => e.reason === 'approval_tampered')).toHaveLength(3);
    // A aprovação original, intacta, ainda vale (as tentativas não a consumiram).
    expect(controller.updateLimits(HUMAN, next, genuine).maxConcurrent).toBe(2);
  });

  it('identidade divergente: o aprovador autenticado não é o declarado, ou é um agente', async () => {
    const { controller, verifier, forgeApproval } = setup();
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    const claimsAdmin = verifier.issue(forgeApproval('killswitch.release', 'global'), 'someone-else');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, claimsAdmin))).toBe('approver_identity_mismatch');
    const reallyAgent = verifier.issue(forgeApproval('killswitch.release', 'global'), 'claude-code');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, reallyAgent))).toBe('approver_identity_mismatch');
    expect(controller.killSwitchStatus().global.engaged).toBe(true);
    expect(controller.auditTrail().filter((e) => e.reason === 'approver_identity_mismatch')).toHaveLength(2);
  });

  it('verificador que falha (exceção) ou devolve motivo fora do formato: recusado, sem vazar dados', async () => {
    const throwing = createLimitsController({
      projects: { get: () => null },
      tasks: { get: () => null },
      approvalVerifier: {
        id: 'broken',
        kind: 'trusted',
        verify: () => {
          throw new Error(`db down ${CANARY_TOKEN}`);
        },
      },
    });
    const ctx = setup();
    const next = { ...structuredClone(DEFAULT_LIMITS), maxConcurrent: 2 };
    expect(code(() => throwing.updateLimits(HUMAN, next, ctx.forgeApproval('limits.change', limitsFingerprint(next))))).toBe('approval_not_authentic');
    const weird = createLimitsController({
      projects: { get: () => null },
      tasks: { get: () => null },
      approvalVerifier: { id: 'weird', kind: 'trusted', verify: () => ({ authentic: false, reason: `Bearer ${CANARY_TOKEN}` }) },
    });
    expect(code(() => weird.updateLimits(HUMAN, next, ctx.forgeApproval('limits.change', limitsFingerprint(next))))).toBe('approval_not_authentic');
    const trail = JSON.stringify(throwing.auditTrail()) + JSON.stringify(weird.auditTrail());
    expect(trail).not.toContain(CANARY_TOKEN);
    expect(throwing.auditTrail().at(-1)?.reason).toBe('approval_verification_failed');
    expect(weird.auditTrail().at(-1)?.reason).toBe('approval_not_authentic');
  });

  it('uso único, validade máxima e alvo exato continuam valendo com aprovação autêntica', async () => {
    const { controller, humanApproval, advance } = setup();
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, humanApproval('killswitch.release', P1)))).toBe('approval_wrong_target');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, humanApproval('killswitch.release', 'global', { expiresAt: '2026-11-20T00:00:00Z' })))).toBe('approval_invalid_validity');
    const stale = humanApproval('killswitch.release', 'global');
    advance(2 * 60 * 60 * 1000);
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, stale))).toBe('approval_expired');
    const ok = humanApproval('killswitch.release', 'global');
    controller.releaseKillSwitch(HUMAN, { kind: 'global' }, ok);
    await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'again');
    expect(code(() => controller.releaseKillSwitch(HUMAN, { kind: 'global' }, ok))).toBe('approval_already_used');
  });
});

describe('R2: vaga de concorrência só é liberada com interrupção confirmada', () => {
  /** Handler de cancelamento controlável: fica pendente até `settle(resultado)`. */
  function gatedCancel() {
    let settle!: (result: CancellationResult) => void;
    const handler = vi.fn(() => new Promise<CancellationResult>((resolve) => (settle = resolve)));
    return { handler, settle: (r: CancellationResult) => settle(r) };
  }

  it.each(['failed', 'not_supported'] as const)('cancelamento "%s": a vaga continua ocupada e nova admissão é recusada', async (result) => {
    const { controller } = setup({ cancelHandler: async () => result });
    const a = controller.admit('admin', subscription());
    const cancelled = await controller.cancel('admin', P1, a.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', capacity: 'held', cancellation: { result } });
    expect(controller.activeCount()).toBe(0);
    expect(controller.capacityInUse()).toBe(1);
    expect(code(() => controller.admit('admin', subscription()))).toBe('concurrency_limit');
  });

  it('cancelamento pendente: a vaga só é liberada quando o resultado "cancelled" chega', async () => {
    const gate = gatedCancel();
    const { controller } = setup({ cancelHandler: gate.handler });
    const a = controller.admit('admin', subscription());
    const cancelling = controller.cancel('admin', P1, a.id);
    expect(controller.get('admin', P1, a.id)).toMatchObject({ state: 'cancelled', capacity: 'held', cancellation: { result: 'pending' } });
    expect(code(() => controller.admit('admin', subscription()))).toBe('concurrency_limit');
    // Pedido em andamento não é duplicado nem confirmado manualmente.
    await expect(controller.cancel('admin', P1, a.id)).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(code(() => controller.confirmStopped(HUMAN, 'admin', P1, a.id))).toBe('invalid_transition');
    gate.settle('cancelled');
    await cancelling;
    expect(controller.get('admin', P1, a.id)).toMatchObject({ capacity: 'released', cancellation: { result: 'cancelled' } });
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
    expect(gate.handler).toHaveBeenCalledTimes(1);
  });

  it('nova tentativa de cancelamento após "failed" pode liberar a vaga', async () => {
    const results: CancellationResult[] = ['failed', 'cancelled'];
    const { controller } = setup({ cancelHandler: async () => results.shift()! });
    const a = controller.admit('admin', subscription());
    await controller.cancel('admin', P1, a.id);
    expect(controller.capacityInUse()).toBe(1);
    expect(await controller.cancel('admin', P1, a.id)).toMatchObject({ state: 'cancelled', capacity: 'released', cancellation: { result: 'cancelled' } });
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
  });

  it('confirmação explícita de parada (pessoa dona ou host) libera a vaga; agente e outro dono não', async () => {
    const { controller } = setup();
    const a = controller.admit('admin', subscription());
    await controller.cancel('admin', P1, a.id);
    expect(code(() => controller.confirmStopped({ kind: 'agent', id: 'claude-code' } as never, 'admin', P1, a.id))).toBe('invalid_actor');
    expect(code(() => controller.confirmStopped({ kind: 'human', id: 'user-b' }, 'admin', P1, a.id))).toBe('invalid_actor');
    expect(code(() => controller.confirmStopped({ kind: 'human', id: 'user-b' }, 'user-b', P1, a.id))).toBe('not_found');
    expect(controller.confirmStopped(HUMAN, 'admin', P1, a.id)).toMatchObject({ state: 'cancelled', capacity: 'released' });
    expect(controller.auditTrail().some((e) => e.event === 'capacity_released' && e.reason === 'stop_confirmed_by_human')).toBe(true);
    // Admissão ativa não é "confirmada parada": use complete/cancel.
    const b = controller.admit('admin', subscription());
    expect(code(() => controller.confirmStopped(SYSTEM, 'admin', P1, b.id))).toBe('invalid_transition');
  });

  it('expiração sem cancelamento confirmado: a vaga continua ocupada', async () => {
    const { controller, advance } = setup();
    const a = controller.admit('admin', subscription({ durationSeconds: 60 }));
    advance(60_000);
    const [expired] = await controller.expireOverdue();
    expect(expired).toMatchObject({ id: a.id, state: 'expired', capacity: 'held', cancellation: { result: 'not_supported' } });
    expect(code(() => controller.admit('admin', subscription()))).toBe('concurrency_limit');
    controller.confirmStopped(SYSTEM, 'admin', P1, a.id);
    expect(controller.admit('admin', subscription()).state).toBe('admitted');
  });

  it('expiração preguiçosa com cancelamento pendente: admissões concorrentes não passam do limite', async () => {
    const gate = gatedCancel();
    const { controller, advance, approveLimits } = setup({ cancelHandler: gate.handler });
    approveLimits({ maxConcurrent: 2 });
    controller.admit('admin', subscription({ durationSeconds: 60 }));
    advance(60_000);
    // A 1ª expira (vaga ainda ocupada, cancelamento pendente); só cabe mais UMA.
    const results = await Promise.allSettled([0, 1, 2].map(() => Promise.resolve().then(() => controller.admit('admin', subscription()))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(controller.capacityInUse()).toBe(2);
    gate.settle('cancelled');
    await vi.waitFor(() => expect(controller.capacityInUse()).toBe(1));
  });

  it('kill switch com cancelamento não confirmado: a vaga fica ocupada mesmo após reativação', async () => {
    const { controller, humanApproval } = setup({ cancelHandler: async () => 'failed' });
    const a = controller.admit('admin', subscription());
    const { cancellations } = await controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'emergency_stop');
    expect(cancellations).toEqual([{ admissionId: a.id, result: 'failed' }]);
    controller.releaseKillSwitch(HUMAN, { kind: 'global' }, humanApproval('killswitch.release', 'global'));
    expect(code(() => controller.admit('admin', subscription()))).toBe('concurrency_limit');
    expect(controller.get('admin', P1, a.id)).toMatchObject({ state: 'cancelled', reason: 'kill_switch', capacity: 'held' });
  });

  it('novo kill switch repete o pedido de cancelamento das operações ainda não interrompidas', async () => {
    const results: CancellationResult[] = ['not_supported', 'cancelled'];
    const { controller } = setup({ cancelHandler: async () => results.shift()! });
    const a = controller.admit('admin', subscription());
    await controller.cancel('admin', P1, a.id);
    expect(controller.capacityInUse()).toBe(1);
    const { cancellations } = await controller.engageKillSwitch(SYSTEM, { kind: 'project', projectId: P1 }, 'project_stop');
    expect(cancellations).toEqual([{ admissionId: a.id, result: 'cancelled' }]);
    expect(controller.get('admin', P1, a.id)).toMatchObject({ state: 'cancelled', reason: 'cancelled_by_user', capacity: 'released' });
  });

  it('término informado pelo provedor (complete) libera a vaga normalmente', () => {
    const { controller } = setup();
    const a = controller.admit('admin', subscription());
    expect(controller.complete('admin', P1, a.id, 'completed', { cost: { kind: 'none' }, tokens: null })).toMatchObject({ capacity: 'released' });
    expect(controller.capacityInUse()).toBe(0);
  });
});
