import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { POLICY_ACTIONS, type PolicyAction, type PolicyActionInfo, type Project, type Task } from '../../shared/contracts.ts';
import { approvalPresentationDigest, type ApprovalPresentation } from '../../shared/approvalPresentation.ts';
import { bindingDigest, paramsDigestOf } from '../approvals/binding.ts';
import type { ApprovalBinding } from '../approvals/contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from '../approvals/identity.ts';
import { createEnvKeyProvider } from '../approvals/keyProvider.ts';
import { createApprovalService } from '../approvals/service.ts';
import { openApprovalStore, type ApprovalStore } from '../approvals/store.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { defaultProviderCatalog } from '../limits/providers.ts';
import { createQueueAdmissionPort, type QueueAdmissionAdapter } from '../limits/queueAdmission.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { createBarrierGate, type BarrierGate } from '../queue/barrierGate.ts';
import type { BarrierAuthority } from '../queue/contracts.ts';
import type { AdmissionPort, ExecutorPort, TaskLookup } from '../queue/ports.ts';
import { createQueueScheduler, type QueueScheduler } from '../queue/scheduler.ts';
import type { QueueStore } from '../queue/store.ts';
import { createSandboxQueueExecutor, type SandboxQueueExecutor } from '../sandbox/queueExecutor.ts';
import { createSandboxService, type SandboxService } from '../sandbox/service.ts';
import { createSimulatedProvider, type SimulatedProvider } from '../sandbox/simulatedProvider.ts';
import { TEST_ADMIN_PASSWORD, testPasswordHash } from './authFixtures.ts';
import { createQueueHarness, PROJECT, PROJECT_B, TASK, type QueueHarness } from './queueFixtures.ts';

/**
 * Pilha de teste do agendador (Issue #012, PR 2): fila REAL em disco, núcleo de aprovações REAL em
 * disco (#011), controlador (#022) pelo adaptador da fila e sandbox (#021) com o provedor SIMULADO
 * (não executa nada). Só para testes (pasta `server/test`, fora das verificações estruturais).
 */

export const TASK_B = '55555555-5555-4555-8555-555555555555';
export const TASK_C = '66666666-6666-4666-8666-666666666666';
export const TASK_D = '77777777-7777-4777-8777-777777777777';
export const REPO = 'Moreirapontocom-br/ai-command-center';
export const SHA = 'c'.repeat(40);
const CTX: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('session').digest('hex') };

/** Catálogo de TESTE: no real, sandbox/ferramentas/gasto são indisponíveis. */
export const testCatalog: Record<PolicyAction, PolicyActionInfo> = {
  ...POLICY_ACTIONS,
  'sandbox.execute': { ...POLICY_ACTIONS['sandbox.execute'], available: true },
  'tool.use': { ...POLICY_ACTIONS['tool.use'], available: true },
};

export interface SchedulerStack {
  h: QueueHarness;
  clock: { mono: number };
  advance(ms: number): void;
  service: ReturnType<typeof createApprovalService>;
  approvalStore: ApprovalStore;
  authority: BarrierAuthority;
  store: QueueStore;
  gate: BarrierGate;
  admission: QueueAdmissionAdapter;
  sandbox: SandboxService;
  provider: SimulatedProvider;
  executor: SandboxQueueExecutor;
  scheduler: QueueScheduler;
  tasks: TaskLookup;
  /** Outro adaptador do controlador sobre as mesmas dependências (ainda não restaurado). */
  makeAdmission(): QueueAdmissionAdapter;
  /** Aprova todos os pedidos pendentes (cada um com prova própria de step-up). */
  approveAll(): Promise<number>;
  rejectAll(): Promise<number>;
  /** Libera a barreira global (confirmação do PO, componente interno do núcleo). */
  releaseGlobal(): Promise<void>;
  /** "Reinício": fecha a fila, reabre (nova época), novo controlador/sandbox/agendador. */
  restart(options?: { executor?: ExecutorPort; restore?: boolean }): Promise<void>;
  body(overrides?: Record<string, unknown>): Record<string, unknown>;
  close(): Promise<void>;
}

export interface StackOptions {
  executor?: (base: SandboxQueueExecutor) => ExecutorPort;
  admission?: (base: QueueAdmissionAdapter) => AdmissionPort;
  /** `false`: o controlador fica SEM o núcleo de aprovações (aprovação ausente). */
  admissionApprovals?: boolean;
  providers?: ReturnType<typeof defaultProviderCatalog>;
  catalog?: Record<PolicyAction, PolicyActionInfo>;
  restore?: boolean;
}

export async function createSchedulerStack(options: StackOptions = {}): Promise<SchedulerStack> {
  const h = await createQueueHarness('acc-scheduler-');
  const clock = { mono: 1_000 };
  const now = () => h.clock.now;
  const advance = (ms: number) => {
    h.clock.now += ms;
    clock.mono += ms;
  };
  const approvalKey = randomBytes(32).toString('hex');
  const approvalStore = await openApprovalStore({
    approvalsDir: h.approvalsDir,
    anchorDir: h.anchorDir,
    keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: approvalKey }),
    environment: { env: {} },
    initialize: 'if_absent',
    now,
  });
  const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now });
  const stack = {} as SchedulerStack;
  const service = createApprovalService({
    store: approvalStore,
    identity,
    policyVersion: DEFAULT_POLICY.version,
    now,
    monotonicNow: () => clock.mono,
    controllerKillSwitch: (projectId) => (stack.admission ? stack.admission.killSwitchEngaged(projectId) : false),
  });
  const proof = async () => (await identity.confirm(CTX, 'password', TEST_ADMIN_PASSWORD)).proofId;
  const authority: BarrierAuthority = { status: () => service.status(), barriers: () => service.barriers(), engage: (input) => service.engageBarrier(input) };

  const projectA = { id: PROJECT, ownerId: 'admin', repositories: [REPO] } as unknown as Project;
  const projectB = { id: PROJECT_B, ownerId: 'admin', repositories: [REPO] } as unknown as Project;
  const taskOf = (projectId: string, id: string) => ({ id, projectId, status: 'in_progress', assignee: { kind: 'agent', agentId: 'claude-code' } }) as Task;
  const allTasks = new Map([
    [`${PROJECT}|${TASK}`, taskOf(PROJECT, TASK)],
    [`${PROJECT}|${TASK_B}`, taskOf(PROJECT, TASK_B)],
    [`${PROJECT}|${TASK_C}`, taskOf(PROJECT, TASK_C)],
    [`${PROJECT}|${TASK_D}`, taskOf(PROJECT, TASK_D)],
    [`${PROJECT_B}|${TASK}`, taskOf(PROJECT_B, TASK)],
  ]);
  const projects = { get: (owner: string, id: string) => (owner !== 'admin' ? null : id === PROJECT ? projectA : id === PROJECT_B ? projectB : null) };
  const tasksStore = { get: (owner: string, projectId: string, id: string) => (owner === 'admin' ? (allTasks.get(`${projectId}|${id}`) ?? null) : null) };
  const tasks: TaskLookup = {
    check({ ownerId, projectId, taskId, agentId }) {
      if (!projects.get(ownerId, projectId)) return 'not_found';
      const task = tasksStore.get(ownerId, projectId, taskId);
      if (!task) return 'not_found';
      if (task.status === 'done' || task.status === 'cancelled') return 'task_not_active';
      return task.assignee?.kind === 'agent' && task.assignee.agentId === agentId ? 'ok' : 'agent_not_assigned';
    },
  };
  const catalog = options.catalog ?? testCatalog;
  const providers = options.providers ?? defaultProviderCatalog().map((p) => ({ ...p, status: 'available' as const, statusReason: 'verified_for_test' }));

  const makeAdmission = () =>
    createQueueAdmissionPort({
      projects,
      tasks: tasksStore,
      policyCatalog: catalog,
      providers,
      approvalVerifier: service.verifierFor('limits'),
      approvals: options.admissionApprovals === false ? undefined : service,
      onKillSwitchEngaged: (scope, reason) => {
        void service.engageBarrier({ scope, actor: { kind: 'system', id: 'acc-limits' }, reason }).catch(() => undefined);
      },
      now,
    });

  async function build(restore: boolean, executorOverride?: ExecutorPort) {
    stack.store = await h.open({ authority, initialize: 'if_absent' });
    stack.gate = createBarrierGate({ authority, store: stack.store, controllerKillSwitch: (projectId) => stack.admission.killSwitchEngaged(projectId) });
    await stack.gate.reconcile();
    stack.admission = makeAdmission();
    stack.provider = createSimulatedProvider();
    stack.sandbox = createSandboxService({ provider: stack.provider, projects, tasks: tasksStore, catalog, approvalVerifier: service.verifierFor('sandbox'), approvals: service, now });
    stack.executor = createSandboxQueueExecutor({ sandbox: stack.sandbox, provider: stack.provider });
    const executor = executorOverride ?? (options.executor ? options.executor(stack.executor) : stack.executor);
    const admission = options.admission ? options.admission(stack.admission) : stack.admission;
    stack.scheduler = createQueueScheduler({ store: stack.store, gate: stack.gate, admission, executor, tasks, now });
    if (restore) await stack.scheduler.restore();
  }

  const configBinding = (scope = 'global'): ApprovalBinding => ({
    action: 'killswitch.release',
    projectId: scope === 'global' ? null : scope,
    resource: { type: 'killswitch', id: scope },
    target: { sha: null, ref: null },
    subject: { kind: 'human', id: 'admin' },
    paramsDigest: paramsDigestOf('killswitch.release', { scope }),
    policyVersion: DEFAULT_POLICY.version,
  });
  async function releaseGlobal() {
    const binding = configBinding();
    const confirmed = await service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await proof(), identity: CTX });
    const reservation = await service.reserve({ ownerId: 'admin', approvalId: confirmed.id, component: 'approvals', binding });
    await service.releaseBarrier({ attemptId: reservation.attemptId });
  }

  let seq = 0;
  Object.assign(stack, {
    h,
    clock,
    advance,
    service,
    approvalStore,
    authority,
    tasks,
    makeAdmission,
    async approveAll() {
      const pending = service.list('admin').filter((a) => a.state === 'pending');
      for (const a of pending) {
        const digest = approvalPresentationDigest(a.bindingDigest, a.presentation as ApprovalPresentation);
        await service.decide({ ownerId: 'admin', approvalId: a.id, decision: 'approve', bindingDigest: a.bindingDigest, presentationDigest: digest, proofId: await proof(), identity: CTX });
      }
      return pending.length;
    },
    async rejectAll() {
      const pending = service.list('admin').filter((a) => a.state === 'pending');
      for (const a of pending) await service.decide({ ownerId: 'admin', approvalId: a.id, decision: 'reject', bindingDigest: a.bindingDigest, proofId: await proof(), identity: CTX });
      return pending.length;
    },
    releaseGlobal,
    async restart(opts: { executor?: ExecutorPort; restore?: boolean } = {}) {
      await stack.store.close();
      await build(opts.restore ?? true, opts.executor);
    },
    body(overrides: Record<string, unknown> = {}) {
      seq += 1;
      return {
        idempotencyKey: `submit-${String(seq).padStart(4, '0')}`,
        projectId: PROJECT,
        taskId: TASK,
        agentId: 'claude-code',
        priority: 'medium',
        admission: { action: 'tool.use', mode: 'subscription_assisted', durationSeconds: 600, estimatedCostMinor: null, maxTokens: null },
        execution: {
          repository: REPO,
          baseSha: SHA,
          networkAllowlist: [],
          credentialScopes: ['repo.read'],
          limits: { timeoutSeconds: 600, cpu: 1, memoryMb: 1024, diskMb: 2048 },
          inputs: [],
        },
        ...overrides,
      };
    },
    async close() {
      await approvalStore.close().catch(() => undefined);
      await h.cleanup();
    },
  });

  await build(false);
  // Instalação nova: fila e aprovações nascem com barreira global; o PO a libera.
  await releaseGlobal();
  if (options.restore ?? true) await stack.scheduler.restore();
  return stack;
}

/** Leva um item submetido até `running`: aprova (execução e admissão) e roda os ciclos. */
export async function driveToRunning(stack: SchedulerStack, itemId: string, maxRounds = 4) {
  for (let round = 0; round < maxRounds; round += 1) {
    await stack.scheduler.tick();
    const item = stack.store.items().find((i) => i.id === itemId)!;
    if (item.state !== 'queued') return item;
    await stack.approveAll();
  }
  return stack.store.items().find((i) => i.id === itemId)!;
}

export const itemOf = (stack: SchedulerStack, id: string) => stack.store.items().find((i) => i.id === id)!;
export const tokenOf = (stack: SchedulerStack, id: string) => itemOf(stack, id).run!.dispatch!.token;
export const startCalls = (stack: SchedulerStack) => stack.provider.calls.filter((c) => c.op === 'start').length;
export const PROJECT_ID = PROJECT;
export const PROJECT_B_ID = PROJECT_B;
export const TASK_ID = TASK;
export const joinRoot = (h: QueueHarness, name: string) => join(h.root, name);
