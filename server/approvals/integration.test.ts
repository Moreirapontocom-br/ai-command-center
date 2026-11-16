// @vitest-environment node
/**
 * Issue #011 (PR 2): integração do núcleo de aprovações com a política (#020), o sandbox (#021) e
 * o controlador de limites/kill switch (#022), sobre um armazenamento real em disco. Nada executa:
 * o provedor de sandbox é o simulado (só testes) e os catálogos "disponíveis" são de teste.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POLICY_ACTIONS, type ApprovalGrant, type Project, type Task } from '../../shared/contracts.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { createLimitsController, type ControllerActor } from '../limits/controller.ts';
import { defaultProviderCatalog } from '../limits/providers.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { evaluatePolicy } from '../policy/engine.ts';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import type { SandboxProvider } from '../sandbox/provider.ts';
import { createSandboxService } from '../sandbox/service.ts';
import { createSimulatedProvider } from '../sandbox/simulatedProvider.ts';
import { TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { bindingDigest, paramsDigestOf } from './binding.ts';
import { approvalPresentationDigest, sandboxWorkBranchFor, sandboxWorkspaceIdFor, type ApprovalPresentation } from '../../shared/approvalPresentation.ts';
import type { ApprovalBinding, LedgerApproval } from './contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from './identity.ts';
import { createEnvKeyProvider } from './keyProvider.ts';
import { createMaintenanceScheduler } from './maintenance.ts';
import { createApprovalService } from './service.ts';
import { openApprovalStore, type ApprovalStore } from './store.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const T1 = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const SHA = 'c'.repeat(40);
const REPO = 'Moreirapontocom-br/ai-command-center';
const START = Date.parse('2026-11-15T12:00:00Z');
const MIN = 60_000;
const VERSION = DEFAULT_POLICY.version;
const CTX: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('session').digest('hex') };
const HUMAN: ControllerActor = { kind: 'human', id: 'admin' };
/** Resumo da apresentação (vínculo + parâmetros entregues pelo componente real), como o navegador envia. */
const pd = (a: LedgerApproval) => {
  expect(a.presentation).toBeDefined();
  return approvalPresentationDigest(a.bindingDigest, a.presentation as ApprovalPresentation);
};

const roots: string[] = [];
const stores: ApprovalStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

/** Catálogos de TESTE: no real, sandbox, ferramentas, merge e gasto são indisponíveis. */
const testCatalog = {
  ...POLICY_ACTIONS,
  'sandbox.execute': { ...POLICY_ACTIONS['sandbox.execute'], available: true },
  'tool.use': { ...POLICY_ACTIONS['tool.use'], available: true },
  'repo.merge': { ...POLICY_ACTIONS['repo.merge'], available: true },
};

async function setup(options: { realCatalog?: boolean; provider?: SandboxProvider; taskStatus?: Task['status'] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acc-approvals-int-'));
  roots.push(root);
  const clock = { wall: START, mono: 1_000 };
  const now = () => clock.wall;
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  const key = randomBytes(32).toString('hex');
  const open = async (initialize: 'never' | 'if_absent' = 'never') => {
    const store = await openApprovalStore({
      approvalsDir: join(root, 'approvals'),
      anchorDir: join(root, 'anchor'),
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: key }),
      environment: { env: {} },
      initialize,
      now,
    });
    stores.push(store);
    return store;
  };
  const store = await open('if_absent');
  const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now });
  // Ligação circular (como no servidor real): o núcleo consulta o kill switch do controlador, e o
  // controlador aciona a barreira do núcleo ao acionar o kill switch.
  let controller: ReturnType<typeof createLimitsController> | null = null;
  const service = createApprovalService({
    store,
    identity,
    policyVersion: VERSION,
    now,
    monotonicNow: () => clock.mono,
    controllerKillSwitch: (projectId) => {
      const status = controller!.killSwitchStatus(projectId ?? undefined);
      return projectId === null ? status.global.engaged : (status.project?.engaged ?? false);
    },
  });
  const proof = async () => (await identity.confirm(CTX, 'password', TEST_ADMIN_PASSWORD)).proofId;

  const project = { id: P1, ownerId: 'admin', repositories: [REPO] } as unknown as Project;
  const task = { id: T1, projectId: P1, status: options.taskStatus ?? 'in_progress', assignee: { kind: 'agent', agentId: 'claude-code' } } as Task;
  const projects = { get: (owner: string, id: string) => (owner === 'admin' && id === P1 ? project : null) };
  const tasks = { get: (owner: string, projectId: string, id: string) => (owner === 'admin' && projectId === P1 && id === T1 ? task : null) };

  const provider = options.provider ?? createSimulatedProvider();
  const sandbox = createSandboxService({
    provider,
    projects,
    tasks,
    catalog: options.realCatalog ? undefined : testCatalog,
    approvalVerifier: service.verifierFor('sandbox'),
    approvals: service,
    now,
  });
  controller = createLimitsController({
    projects,
    tasks,
    policyCatalog: options.realCatalog ? undefined : testCatalog,
    providers: defaultProviderCatalog().map((p) => ({ ...p, status: 'available', statusReason: 'verified_for_test' })),
    approvalVerifier: service.verifierFor('limits'),
    approvals: service,
    onKillSwitchEngaged: (scope, reason) => {
      void service.engageBarrier({ scope, actor: { kind: 'system', id: 'acc-limits' }, reason }).catch(() => undefined);
    },
    now,
  });

  const configBinding = (action: 'killswitch.release', scope = 'global'): ApprovalBinding => ({
    action,
    projectId: scope === 'global' ? null : scope,
    resource: { type: 'killswitch', id: scope },
    target: { sha: null, ref: null },
    subject: { kind: 'human', id: 'admin' },
    paramsDigest: paramsDigestOf('killswitch.release', { scope }),
    policyVersion: VERSION,
  });
  /** Confirmação do PO para liberar uma barreira (aprovação de configuração, 15 min). */
  const ownerRelease = async (scope = 'global') => {
    const binding = configBinding('killswitch.release', scope);
    return service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await proof(), identity: CTX });
  };
  // Instalação nova: barreira global; liberada pelo PO (componente interno do núcleo).
  const initial = await ownerRelease();
  const reservation = await service.reserve({ ownerId: 'admin', approvalId: initial.id, component: 'approvals', binding: configBinding('killswitch.release') });
  await service.releaseBarrier({ attemptId: reservation.attemptId });

  const approvePending = async () => {
    const pending = service.list('admin').filter((a) => a.state === 'pending');
    expect(pending).toHaveLength(1);
    return service.decide({ ownerId: 'admin', approvalId: pending[0].id, decision: 'approve', bindingDigest: pending[0].bindingDigest, presentationDigest: pd(pending[0]), proofId: await proof(), identity: CTX });
  };
  const sandboxBody = () => ({
    projectId: P1,
    taskId: T1,
    agentId: 'claude-code',
    repository: REPO,
    baseSha: SHA,
    networkAllowlist: [],
    credentialScopes: ['repo.read'],
    limits: { timeoutSeconds: 600, cpu: 1, memoryMb: 1024, diskMb: 2048 },
    inputs: [],
  });
  let keySeq = 0;
  const admission = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: `key-${String(++keySeq).padStart(6, "0")}`,
    projectId: P1,
    taskId: T1,
    agentId: 'claude-code',
    action: 'tool.use',
    mode: 'subscription_assisted',
    durationSeconds: 60,
    estimatedCostMinor: null,
    maxTokens: null,
    ...overrides,
  });
  return { service, store, sandbox, controller: controller!, identity, proof, approvePending, ownerRelease, sandboxBody, admission, advance, open, provider, key, root };
}

const forgedGrant = (overrides: Partial<ApprovalGrant> = {}): ApprovalGrant => ({
  id: '11111111-1111-4111-8111-111111111111',
  action: 'sandbox.execute',
  projectId: P1,
  resource: { type: 'task', id: T1 },
  target: { sha: SHA, ref: null },
  subject: { kind: 'agent', id: 'claude-code' },
  approvedBy: { kind: 'human', id: 'admin' },
  approvedAt: '2026-11-15T12:00:00.000Z',
  expiresAt: '2026-11-15T13:00:00.000Z',
  ...overrides,
});

describe('sandbox (#021) com o gate da #011', () => {
  it('pedido aparece para o PO; sem aprovação fica pendente; aprovado → autorizado uma única vez', async () => {
    const ctx = await setup();
    const record = await ctx.sandbox.request('admin', ctx.sandboxBody());
    expect(record).toMatchObject({ state: 'requested', reason: 'awaiting_approval' });
    const pending = ctx.service.list('admin').filter((a) => a.state === 'pending');
    expect(pending).toEqual([expect.objectContaining({ class: 'execution', requestedBy: { kind: 'system', id: 'sandbox' }, binding: expect.objectContaining({ action: 'sandbox.execute', projectId: P1 }) })]);
    await expect(ctx.sandbox.authorizeWithApproval('admin', P1, record.id)).rejects.toMatchObject({ code: 'approval_pending' });

    const approved = await ctx.approvePending();
    const authorized = await ctx.sandbox.authorizeWithApproval('admin', P1, record.id);
    expect(authorized).toMatchObject({ state: 'authorized', approvalId: approved.id });
    expect(ctx.service.get('admin', approved.id)!.state).toBe('consumed');
    expect(ctx.service.attemptsOf('admin', approved.id)).toEqual([expect.objectContaining({ component: 'sandbox', state: 'succeeded' })]);
    // Execução real desligada: o simulado não executa nada; nenhum provedor real existe.
    expect(REAL_EXECUTION_ENABLED).toBe(false);
  });

  it('R3: o que o PO vê é exatamente a especificação que será autorizada (tudo exceto ownerId), coerente com o vínculo', async () => {
    const ctx = await setup();
    const record = await ctx.sandbox.request('admin', ctx.sandboxBody());
    const pending = ctx.service.list('admin').find((a) => a.state === 'pending')!;
    const { ownerId, ...expected } = record.spec;
    expect(ownerId).toBe('admin');
    expect(pending.ownerId).toBe(ownerId);
    expect(pending.presentation).toEqual({ kind: 'sandbox', params: expected });
    expect(pending.binding).toMatchObject({
      projectId: record.spec.projectId,
      resource: { type: 'task', id: record.spec.taskId },
      subject: { kind: 'agent', id: record.spec.agentId },
      target: { sha: record.spec.git!.baseSha, ref: record.spec.git!.workBranch },
    });
    // Outra solicitação idêntica gera OUTRO id (e outro workspace/branch): a aprovação de uma não serve à outra.
    const second = await ctx.sandbox.request('admin', ctx.sandboxBody());
    expect(second.id).not.toBe(record.id);
    expect(ctx.service.get('admin', pending.id)!.state).toBe('superseded');
    const approved = await ctx.approvePending();
    expect(approved.presentation).toEqual({ kind: 'sandbox', params: (({ ownerId: _o, ...rest }) => rest)(second.spec) }); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(await ctx.sandbox.authorizeWithApproval('admin', P1, second.id)).toMatchObject({ state: 'authorized', approvalId: approved.id });
  });

  it('grant forjado, de outro componente ou já usado é recusado; o sandbox nunca confia nos campos', async () => {
    const ctx = await setup();
    const record = await ctx.sandbox.request('admin', ctx.sandboxBody());
    await expect(ctx.sandbox.authorize('admin', P1, record.id, forgedGrant({ target: { sha: SHA, ref: record.spec.git!.workBranch } }))).rejects.toMatchObject({ code: 'approval_not_authentic' });

    const approved = await ctx.approvePending();
    const binding = ctx.service.get('admin', approved.id)!.binding;
    // Recibo emitido para o controlador (#022) apresentado ao sandbox → recusado.
    const wrongComponent = await ctx.service.reserve({ ownerId: 'admin', approvalId: approved.id, component: 'limits', binding });
    await expect(ctx.sandbox.authorize('admin', P1, record.id, wrongComponent.grant!)).rejects.toMatchObject({ code: 'approval_not_authentic' });
    // A aprovação já foi consumida (reserva única): não serve para nova tentativa.
    await expect(ctx.sandbox.authorizeWithApproval('admin', P1, record.id)).rejects.toMatchObject({ code: 'approval_pending' });
    expect(ctx.sandbox.get('admin', P1, record.id)!.state).toBe('requested');
  });

  it('sujeito ou projeto incompatível com o grant é recusado pela política antes de gastar o recibo', async () => {
    const ctx = await setup();
    const record = await ctx.sandbox.request('admin', ctx.sandboxBody());
    const approved = await ctx.approvePending();
    const binding = ctx.service.get('admin', approved.id)!.binding;
    const reservation = await ctx.service.reserve({ ownerId: 'admin', approvalId: approved.id, component: 'sandbox', binding });
    const otherSubject = { ...reservation.grant!, subject: { kind: 'agent' as const, id: 'gemini' as const } };
    await expect(ctx.sandbox.authorize('admin', P1, record.id, otherSubject)).rejects.toMatchObject({ code: 'approval_invalid' });
    // O recibo original continua válido para o vínculo exato.
    await expect(ctx.sandbox.authorize('admin', P1, record.id, reservation.grant!)).resolves.toMatchObject({ state: 'authorized' });
  });

  it('autorizado não significa executado: provedor que executa código continua recusado', async () => {
    const real: SandboxProvider = { ...createSimulatedProvider(), id: 'fake-real', isolation: 'microvm', executesCode: true };
    const ctx = await setup({ provider: real });
    const record = await ctx.sandbox.request('admin', ctx.sandboxBody());
    await ctx.approvePending();
    await ctx.sandbox.authorizeWithApproval('admin', P1, record.id);
    await expect(ctx.sandbox.start('admin', P1, record.id)).rejects.toMatchObject({ code: 'real_execution_disabled' });
  });

  it('capacidade indisponível (catálogo real): nada é pedido e aprovação válida não a torna disponível', async () => {
    const ctx = await setup({ realCatalog: true });
    await expect(ctx.sandbox.request('admin', ctx.sandboxBody())).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(ctx.service.list('admin').filter((a) => a.state === 'pending')).toEqual([]);
    // Mesmo com uma aprovação concedida e reservada para sandbox.execute, a política diz UNAVAILABLE.
    const requestId = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const params = {
      requestId,
      projectId: P1,
      taskId: T1,
      agentId: 'claude-code',
      workspace: { id: sandboxWorkspaceIdFor(requestId), exclusive: true, hostPathAccess: 'none' },
      git: { repository: REPO, baseSha: SHA, workBranch: sandboxWorkBranchFor('claude-code', T1, requestId), mainWritable: false },
      network: { default: 'deny', allow: [] },
      credentials: { scopes: ['repo.read'], ttlSeconds: 600, productionSecrets: 'denied', productionDatabase: 'denied' },
      limits: { timeoutSeconds: 600, cpu: 1, memoryMb: 512, diskMb: 1024 },
      inputs: [],
    };
    const binding: ApprovalBinding = {
      action: 'sandbox.execute',
      projectId: P1,
      resource: { type: 'task', id: T1 },
      target: { sha: SHA, ref: params.git.workBranch },
      subject: { kind: 'agent', id: 'claude-code' },
      paramsDigest: paramsDigestOf('sandbox', params),
      policyVersion: VERSION,
    };
    await ctx.service.request({ ownerId: 'admin', requestedBy: 'sandbox', binding, presentation: { kind: 'sandbox', params } });
    const approved = await ctx.approvePending();
    const reservation = await ctx.service.reserve({ ownerId: 'admin', approvalId: approved.id, component: 'policy', binding });
    const evaluation = evaluatePolicy(
      DEFAULT_POLICY,
      { subject: binding.subject, action: 'sandbox.execute', projectId: P1, resource: binding.resource, target: binding.target, approval: reservation.grant },
      { projectAccessible: true, agentAssigned: true, now: START, usedApprovals: new Set() },
    );
    expect(evaluation.decision).toBe('UNAVAILABLE');
  });

  it('falha depois da reserva: a aprovação continua consumida e repetir exige nova aprovação', async () => {
    const ctx = await setup();
    const record = await ctx.sandbox.request('admin', ctx.sandboxBody());
    const approved = await ctx.approvePending();
    ctx.advance(61 * MIN); // a solicitação do sandbox venceu, mas a aprovação também (1 h)
    await expect(ctx.sandbox.authorizeWithApproval('admin', P1, record.id)).rejects.toMatchObject({ code: 'expired' });
    expect(['approved', 'expired']).toContain(ctx.service.get('admin', approved.id)!.state);
  });
});

describe('controlador (#022) com o gate da #011', () => {
  it('admissão que exige aprovação: pedido pendente → PO aprova → admitida; nova admissão exige nova aprovação', async () => {
    const ctx = await setup();
    await expect(ctx.controller.admitWithApproval('admin', ctx.admission())).rejects.toMatchObject({ code: 'approval_pending' });
    const approved = await ctx.approvePending();
    const admitted = await ctx.controller.admitWithApproval('admin', ctx.admission());
    expect(admitted).toMatchObject({ state: 'admitted', approvalIds: [approved.id], cost: { status: 'none', reservedMinor: 0 } });
    expect(ctx.service.attemptsOf('admin', approved.id)).toEqual([expect.objectContaining({ component: 'limits', state: 'succeeded' })]);
    ctx.controller.complete('admin', P1, admitted.id, 'completed', { cost: { kind: 'none' }, tokens: null });
    ctx.controller.confirmStopped(HUMAN, 'admin', P1, admitted.id);
    await expect(ctx.controller.admitWithApproval('admin', ctx.admission())).rejects.toMatchObject({ code: 'approval_pending' });
  });

  it('grant forjado ou de outro componente é recusado pelo controlador', async () => {
    const ctx = await setup();
    const forged = forgedGrant({ action: 'tool.use', target: { sha: null, ref: null } });
    expect(() => ctx.controller.admit('admin', ctx.admission(), { action: forged })).toThrow(expect.objectContaining({ code: 'approval_not_authentic' }));
    await expect(ctx.controller.admitWithApproval('admin', ctx.admission())).rejects.toMatchObject({ code: 'approval_pending' });
    const approved = await ctx.approvePending();
    const binding = ctx.service.get('admin', approved.id)!.binding;
    const forSandbox = await ctx.service.reserve({ ownerId: 'admin', approvalId: approved.id, component: 'sandbox', binding });
    expect(() => ctx.controller.admit('admin', ctx.admission(), { action: forSandbox.grant! })).toThrow(expect.objectContaining({ code: 'approval_not_authentic' }));
    expect(ctx.controller.activeCount()).toBe(0);
  });

  it('orçamento R$ 0: nenhuma aprovação autoriza gasto (spend indisponível no catálogo real)', async () => {
    const ctx = await setup({ realCatalog: true });
    await expect(ctx.controller.admitWithApproval('admin', ctx.admission({ mode: 'metered_api', estimatedCostMinor: 100, maxTokens: 1000 }))).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(ctx.service.list('admin').filter((a) => a.state === 'pending')).toEqual([]);
    expect(ctx.controller.getLimits().budget.globalMinor).toBe(0);
  });

  it('kill switch: bloqueia, revoga aprovações de execução não usadas e invalida recibos; a liberação exige aprovação de configuração e não reativa nada', async () => {
    const ctx = await setup();
    await ctx.sandbox.request('admin', ctx.sandboxBody());
    const unused = await ctx.approvePending();
    const receiptHolder = await ctx.controller.admitWithApproval('admin', ctx.admission()).catch((e: { code: string }) => e.code);
    expect(receiptHolder).toBe('approval_pending');
    const toolApproval = await ctx.approvePending();
    const toolBinding = ctx.service.get('admin', toolApproval.id)!.binding;
    const reservation = await ctx.service.reserve({ ownerId: 'admin', approvalId: toolApproval.id, component: 'limits', binding: toolBinding });

    const engaged = ctx.controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'manual_stop');
    // Efeito IMEDIATO (síncrono, antes de qualquer gravação): barreira volátil e verificação recusada.
    expect(ctx.service.barriers().volatile).toContain('global');
    expect(ctx.service.verifierFor('limits').verifyGrant(reservation.grant!)).toMatchObject({ authentic: false, reason: 'killswitch_engaged' });
    await expect(ctx.service.reserve({ ownerId: 'admin', approvalId: unused.id, component: 'sandbox', binding: ctx.service.get('admin', unused.id)!.binding })).rejects.toMatchObject({
      code: expect.stringMatching(/^(killswitch_engaged|approval_revoked)$/),
    });
    await engaged;
    // Depois, durável: a aprovação de execução não usada é revogada definitivamente.
    await vi.waitFor(() => expect(ctx.service.get('admin', unused.id)!.state).toBe('revoked'));
    expect(ctx.service.barriers().durable.global).not.toBeNull();
    // Recibo pendente invalidado: o grant reservado antes do bloqueio não serve mais.
    expect(() => ctx.controller.admit('admin', ctx.admission(), { action: reservation.grant! })).toThrow(expect.objectContaining({ code: 'kill_switch_engaged' }));

    // Liberação com aprovação de EXECUÇÃO não serve; só a de configuração (killswitch.release).
    await expect(ctx.controller.releaseKillSwitchWithApproval(HUMAN, { kind: 'global' }, unused.id)).rejects.toBeTruthy();
    const release = await ctx.ownerRelease();
    expect(release).toMatchObject({ class: 'configuration', validUntil: new Date(START + 15 * MIN).toISOString() });
    await ctx.controller.releaseKillSwitchWithApproval(HUMAN, { kind: 'global' }, release.id);
    expect(ctx.controller.killSwitchStatus().global.engaged).toBe(false);
    expect(ctx.service.barriers().durable.global).toBeNull();
    // Nada volta: revogadas continuam revogadas; a liberação é de uso único.
    expect(ctx.service.get('admin', unused.id)!.state).toBe('revoked');
    await expect(ctx.controller.releaseKillSwitchWithApproval(HUMAN, { kind: 'global' }, release.id)).rejects.toMatchObject({ code: 'approval_already_used' });
  });

  it('liberação vencida (15 min) é recusada; agentes e o sistema nunca liberam', async () => {
    const ctx = await setup();
    await ctx.controller.engageKillSwitch(HUMAN, { kind: 'global' }, 'manual_stop');
    const release = await ctx.ownerRelease();
    ctx.advance(15 * MIN);
    await expect(ctx.controller.releaseKillSwitchWithApproval(HUMAN, { kind: 'global' }, release.id)).rejects.toMatchObject({ code: 'approval_expired' });
    await expect(ctx.controller.releaseKillSwitchWithApproval({ kind: 'system', id: 'acc' }, { kind: 'global' }, release.id)).rejects.toMatchObject({ code: 'human_required' });
    expect(ctx.controller.killSwitchStatus().global.engaged).toBe(true);
  });
});

describe('política (#020): exceção owner_confirmation só com atestado do servidor (D2/N4)', () => {
  it('operação crítica do próprio PO: só o grant reservado e atestado vale; forjado ou de agente não', async () => {
    const ctx = await setup();
    const binding: ApprovalBinding = { action: 'repo.merge', projectId: P1, resource: { type: 'pull_request', id: '44' }, target: { sha: SHA, ref: null }, subject: { kind: 'human', id: 'admin' }, paramsDigest: 'merge:pr-44', policyVersion: VERSION };
    const confirmed = await ctx.service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await ctx.proof(), identity: CTX });
    const reservation = await ctx.service.reserve({ ownerId: 'admin', approvalId: confirmed.id, component: 'policy', binding });
    expect(reservation.grant!.method).toBe('owner_confirmation');
    const request = { subject: binding.subject, action: 'repo.merge', projectId: P1, resource: binding.resource, target: binding.target };
    const facts = (verified: string | null) => ({ projectAccessible: true, agentAssigned: false, now: START, usedApprovals: new Set<string>(), verifiedOwnerConfirmationId: verified });

    // Sem atestado: recusado como autoaprovação.
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: reservation.grant }, facts(null), testCatalog).decision).toBe('REQUIRE_APPROVAL');
    // Forjado (mesmo formato, sem recibo): o atestado nega.
    expect(ctx.service.attestOwnerConfirmation({ ...reservation.grant!, id: '22222222-2222-4222-8222-222222222222' })).toBeNull();
    const verified = ctx.service.attestOwnerConfirmation(reservation.grant!);
    expect(verified).toBe(confirmed.id);
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: reservation.grant }, facts(verified), testCatalog)).toMatchObject({ decision: 'ALLOW', approvalId: confirmed.id });
    // No catálogo real o merge continua indisponível, com ou sem aprovação.
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: reservation.grant }, facts(verified)).decision).toBe('UNAVAILABLE');
    // Recibo de uso único: um segundo atestado não acontece.
    expect(ctx.service.attestOwnerConfirmation(reservation.grant!)).toBeNull();

    // Agente nunca usa a exceção (nem informando `method: owner_confirmation`).
    const agentGrant = { ...reservation.grant!, subject: { kind: 'agent' as const, id: 'claude-code' as const } };
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, subject: agentGrant.subject, approval: agentGrant }, { ...facts(confirmed.id), agentAssigned: true }, testCatalog).decision).toBe('REQUIRE_APPROVAL');
    await expect(ctx.service.confirmOwner({ ownerId: 'admin', binding: { ...binding, subject: { kind: 'agent', id: 'claude-code' } }, bindingDigest: 'x', proofId: await ctx.proof(), identity: CTX })).rejects.toMatchObject({ code: 'invalid_owner_confirmation' });
  });

  it('agente não se autoaprova: identidade de agente nunca confirma nem decide', async () => {
    const ctx = await setup();
    await ctx.sandbox.request('admin', ctx.sandboxBody());
    const pending = ctx.service.list('admin').find((a) => a.state === 'pending')!;
    const agentCtx = { userId: 'claude-code', sessionKey: CTX.sessionKey };
    await expect(ctx.identity.confirm(agentCtx, 'password', TEST_ADMIN_PASSWORD)).rejects.toMatchObject({ code: 'identity_invalid' });
    await expect(ctx.service.decide({ ownerId: 'admin', approvalId: pending.id, decision: 'approve', bindingDigest: pending.bindingDigest, proofId: await ctx.proof(), identity: agentCtx })).rejects.toMatchObject({ code: 'identity_invalid' });
    expect(ctx.service.get('admin', pending.id)!.state).toBe('pending');
  });
});

describe('persistência e manutenção (grupo D)', () => {
  it('a barreira durável sobrevive ao reinício e continua bloqueando', async () => {
    const ctx = await setup();
    await ctx.service.engageBarrier({ scope: { kind: 'project', projectId: P1 }, actor: { kind: 'human', id: 'admin' }, reason: 'manual_stop' });
    await ctx.store.close();
    const reopened = await ctx.open();
    expect(reopened.status().state).toBe('available');
    const service = createApprovalService({ store: reopened, identity: ctx.identity, policyVersion: VERSION, now: () => START });
    expect(service.barriers().durable.projects[P1]).toMatchObject({ reason: 'manual_stop' });
  });

  it('bloqueio de escritor único: um segundo servidor sobre os mesmos arquivos fica indisponível', async () => {
    const ctx = await setup();
    const second = await ctx.open();
    expect(second.status()).toMatchObject({ state: 'unavailable', reason: 'store_locked' });
  });

  it('chave errada ou anchor inconsistente: indisponível, nada é liberado', async () => {
    const ctx = await setup();
    await ctx.store.close();
    const wrongKey = await openApprovalStore({
      approvalsDir: join(ctx.root, 'approvals'),
      anchorDir: join(ctx.root, 'anchor'),
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: randomBytes(32).toString('hex') }),
      environment: { env: {} },
    });
    stores.push(wrongKey);
    expect(wrongKey.status().state).toBe('unavailable');
    await wrongKey.close();
    const { writeFile, readFile } = await import('node:fs/promises');
    const anchorPath = join(ctx.root, 'anchor', 'approvals-anchor.json');
    const anchor = JSON.parse(await readFile(anchorPath, 'utf8'));
    anchor.ledger.generation += 5;
    await writeFile(anchorPath, JSON.stringify(anchor));
    const inconsistent = await ctx.open();
    expect(inconsistent.status().state).toBe('unavailable');
  });

  it('recuperação administrativa: quarentena verificada e nova instalação com barreira global', async () => {
    const ctx = await setup();
    await ctx.store.close();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(ctx.root, 'approvals', 'approvals-ledger.json'), '{corrompido');
    const broken = await ctx.open();
    expect(broken.status().state).toBe('unavailable');
    const service = createApprovalService({ store: broken, identity: ctx.identity, policyVersion: VERSION, now: () => START });
    const { quarantineId } = await service.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await ctx.proof(), identity: CTX });
    expect(quarantineId).toBeTruthy();
    expect(broken.status().state).toBe('available');
    expect(service.barriers().durable.global).not.toBeNull();
    expect(service.list('admin')).toEqual([]);
  });

  it('falha de gravação: nada é concedido e o armazenamento degrada (nega o resto)', async () => {
    const ctx = await setup();
    await ctx.sandbox.request('admin', ctx.sandboxBody());
    const pending = ctx.service.list('admin').find((a) => a.state === 'pending')!;
    await ctx.store.close();
    let fail = false;
    const flaky = await openApprovalStore({
      approvalsDir: join(ctx.root, 'approvals'),
      anchorDir: join(ctx.root, 'anchor'),
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: ctx.key }),
      environment: { env: {} },
      now: () => START,
      writeFile: async (path, content) => {
        if (fail) throw new Error('disk_full');
        const { writeFileAtomic } = await import('../storage/jsonFile.ts');
        await writeFileAtomic(path, content);
      },
    });
    stores.push(flaky);
    const service = createApprovalService({ store: flaky, identity: ctx.identity, policyVersion: VERSION, now: () => START });
    fail = true;
    await expect(
      service.decide({ ownerId: 'admin', approvalId: pending.id, decision: 'approve', bindingDigest: pending.bindingDigest, presentationDigest: pd(pending), proofId: await ctx.proof(), identity: CTX }),
    ).rejects.toBeTruthy();
    expect(flaky.status().state).toBe('degraded');
    expect(service.get('admin', pending.id)!.state).toBe('pending');
  });

  it('manutenção: nunca roda duas vezes ao mesmo tempo e falhas não interrompem os ciclos', async () => {
    let release: () => void = () => undefined;
    let runs = 0;
    const errors: string[] = [];
    let tick: () => void = () => undefined;
    const scheduler = createMaintenanceScheduler({
      run: async () => {
        runs += 1;
        if (runs === 2) throw Object.assign(new Error('x'), { code: 'store_degraded' });
        await new Promise<void>((resolve) => (release = resolve));
      },
      onError: (code) => errors.push(code),
      setInterval: (fn) => {
        tick = fn;
        return {};
      },
      clearInterval: () => undefined,
    });
    const first = scheduler.runOnce();
    expect(await scheduler.runOnce()).toBe(false); // em curso: pulado
    tick(); // o temporizador também é pulado
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
    expect(await scheduler.runOnce()).toBe(true);
    expect(errors).toEqual(['store_degraded']);
    scheduler.stop();
    expect(await scheduler.runOnce()).toBe(false);
  });

  it('a manutenção expira pedidos de 24 h e aprovações vencidas (por classe)', async () => {
    const ctx = await setup();
    await ctx.sandbox.request('admin', ctx.sandboxBody());
    const approved = await ctx.approvePending();
    ctx.advance(60 * MIN);
    await ctx.service.sweep();
    expect(ctx.service.get('admin', approved.id)!.state).toBe('expired');
    await ctx.controller.admitWithApproval('admin', ctx.admission()).catch(() => undefined);
    const pending = ctx.service.list('admin').find((a) => a.state === 'pending')!;
    ctx.advance(24 * 60 * MIN);
    await ctx.service.sweep();
    expect(ctx.service.get('admin', pending.id)!.state).toBe('expired');
  });
});
