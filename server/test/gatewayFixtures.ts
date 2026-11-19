import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POLICY_ACTIONS, type AgentRef, type PolicyAction, type PolicyActionInfo } from '../../shared/contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext, type StepUpRegistry } from '../approvals/identity.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { createSimulatedAdapters, type SimulatedAdapter } from '../gateway/adapters.ts';
import { createContentManager, type ContentManager } from '../gateway/content.ts';
import { createRoutingExecutor } from '../gateway/routingExecutor.ts';
import { createGateway, type Gateway, type GatewayServiceOptions } from '../gateway/service.ts';
import { GATEWAY_CONTENT_KEY_DOMAIN, GATEWAY_KEY_DOMAIN, openGatewayStore, type GatewayStore } from '../gateway/store.ts';
import type { ExecutionResult } from '../queue/ports.ts';
import { openSealedBlobStore } from '../storage/sealedBlobs.ts';
import { deriveSubkey } from '../storage/subkeys.ts';
import { TEST_ADMIN_PASSWORD, testPasswordHash } from './authFixtures.ts';
import { createSchedulerStack, testCatalog, TASK_B, TASK_C, TASK_D, type SchedulerStack, type StackOptions } from './schedulerFixtures.ts';
import { PROJECT, PROJECT_B, TASK } from './queueFixtures.ts';

/**
 * Pilha de teste do Agent Gateway (Issue #028): a pilha REAL do agendador (#012: fila, aprovações
 * #011, controlador #022, sandbox #021 simulado) + o gateway com ledger e conteúdos cifrados em
 * disco temporário, adaptadores SIMULADOS e o executor composto. Só testes (`server/test`).
 */

export const TASK_GPT = '88888888-8888-4888-8888-888888888888';
export const TASK_GEMINI = '99999999-9999-4999-8999-999999999999';
export const TASK_NEMO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export { PROJECT, PROJECT_B, TASK, TASK_B, TASK_C, TASK_D };

/** Catálogo de TESTE: no real, `agent.invoke` e `data.send_external` são indisponíveis. */
export const gatewayCatalog: Record<PolicyAction, PolicyActionInfo> = {
  ...testCatalog,
  'agent.invoke': { ...POLICY_ACTIONS['agent.invoke'], available: true },
  'data.send_external': { ...POLICY_ACTIONS['data.send_external'], available: true },
};

export const CTX: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('gateway-session').digest('hex') };

export interface GatewayStack {
  s: SchedulerStack;
  gateway: Gateway;
  store: GatewayStore;
  content: ContentManager;
  adapters: Record<AgentRef, SimulatedAdapter>;
  identity: StepUpRegistry;
  dirs: { root: string; gateway: string; anchor: string; content: string };
  keys: { mac: { keyId: string; key: Buffer }; content: { keyId: string; key: Buffer } };
  data: Map<string, string>;
  /** Prova de confirmação de identidade (uso único) para a sessão de teste. */
  confirm(): Promise<{ proofId: string; identity: IdentityContext }>;
  /** Aprova todos os pedidos pendentes do núcleo (#011). */
  approveAll(): Promise<number>;
  /** Pede, aprova e ativa um escopo; devolve o escopo ativo. */
  activeScope(overrides?: Record<string, unknown>): Promise<ReturnType<Gateway['getScope']> & object>;
  scopeBody(overrides?: Record<string, unknown>): Record<string, unknown>;
  taskBody(scopeId: string, overrides?: Record<string, unknown>): Record<string, unknown>;
  /** Ciclo completo: tick, espera os adaptadores, entrega os resultados (com prova) à fila. */
  cycle(rounds?: number): Promise<Array<{ result: ExecutionResult; receipt: unknown }>>;
  /** "Reinício" do gateway (e, opcionalmente, da fila): reabre o ledger e recria o serviço. */
  restartGateway(options?: { queue?: boolean }): Promise<void>;
  close(): Promise<void>;
}

export async function createGatewayStack(options: { stack?: StackOptions; gateway?: Partial<GatewayServiceOptions>; delayMs?: number } = {}): Promise<GatewayStack> {
  const root = await mkdtemp(join(tmpdir(), 'acc-gateway-'));
  const dirs = { root, gateway: join(root, 'gateway'), anchor: join(root, 'anchor'), content: join(root, 'content') };
  const master = randomBytes(32);
  const macKey = deriveSubkey(master, GATEWAY_KEY_DOMAIN);
  const contentKey = deriveSubkey(master, GATEWAY_CONTENT_KEY_DOMAIN);
  const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now: () => g.s?.h.clock.now ?? Date.now() });
  const adapters = createSimulatedAdapters({}, options.delayMs ?? 0);
  const data = new Map<string, string>([
    [`${PROJECT}|task|${TASK}`, 'Descrição da tarefa A (dado de projeto).'],
    [`${PROJECT}|issue|#12`, 'Corpo da issue 12.'],
    [`${PROJECT_B}|task|${TASK}`, 'Dado PRIVADO do projeto B.'],
  ]);
  const g = {} as GatewayStack;
  let seq = 0;

  async function openGateway() {
    g.store = await openGatewayStore({ gatewayDir: dirs.gateway, anchorDir: dirs.anchor, separateFrom: [dirs.content], environment: { env: {} }, loadKey: () => macKey, initialize: 'if_absent', now: () => g.s.h.clock.now });
    const blobs = await openSealedBlobStore({ dir: dirs.content, environment: { env: {} }, loadKey: () => contentKey, separateFrom: [dirs.gateway, dirs.anchor] });
    g.content = createContentManager({ store: g.store, blobs, now: () => g.s.h.clock.now });
    const s = () => g.s;
    g.gateway = createGateway({
      store: g.store,
      content: g.content,
      adapters,
      projects: { get: (o, id) => s().fixtures.projects.get(o, id) },
      tasks: { get: (o, p, id) => s().fixtures.tasks.get(o, p, id) },
      resolveData: ({ projectId, kind, ref }) => data.get(`${projectId}|${kind}|${ref}`) ?? null,
      approvals: { request: (i) => s().service.request(i), reserve: (i) => s().service.reserve(i), recordOutcome: (i) => s().service.recordOutcome(i) },
      approvalVerifier: { id: 'acc-approvals:gateway', kind: 'trusted', verifyGrant: (grant) => s().service.verifierFor('gateway').verifyGrant(grant) },
      identity: { consume: (proofId, ctx) => identity.consume(proofId, ctx) },
      barriers: { blocked: (projectId) => {
        const decision = s().gate.check(projectId);
        return decision.open ? null : decision.reason;
      } },
      queue: { submit: (o, raw) => s().scheduler.submit(o, raw), cancel: (o, p, id) => s().scheduler.cancel(o, p, id) },
      catalog: gatewayCatalog,
      now: () => s().h.clock.now,
      monotonicNow: () => s().clock.mono,
      ...options.gateway,
    });
  }

  // O executor composto busca SEMPRE o gateway atual (sobrevive aos reinícios do gateway).
  const routing = (base: Parameters<NonNullable<StackOptions['executor']>>[0]) =>
    createRoutingExecutor({
      sandbox: base,
      gateway: {
        kind: 'simulated',
        validate: (a, b) => g.gateway.executor.validate(a, b),
        prepare: (a, b) => g.gateway.executor.prepare(a, b),
        dispatch: (a) => g.gateway.executor.dispatch(a),
        cancel: (a) => g.gateway.executor.cancel(a),
        discard: (a) => g.gateway.executor.discard(a),
        verifyResult: (r) => g.gateway.executor.verifyResult!(r),
      },
    });

  g.s = await createSchedulerStack({
    catalog: gatewayCatalog,
    extraTasks: [
      { projectId: PROJECT, taskId: TASK_GPT, agentId: 'chatgpt' },
      { projectId: PROJECT, taskId: TASK_GEMINI, agentId: 'gemini' },
      { projectId: PROJECT, taskId: TASK_NEMO, agentId: 'nemotron' },
    ],
    ...options.stack,
    executor: routing,
  });
  await openGateway();

  Object.assign(g, {
    adapters,
    identity,
    dirs,
    keys: { mac: macKey, content: contentKey },
    data,
    async confirm() {
      return { proofId: (await identity.confirm(CTX, 'password', TEST_ADMIN_PASSWORD)).proofId, identity: CTX };
    },
    approveAll() {
      // Decisões do PO no núcleo (#011), cada uma com prova de step-up e o resumo da apresentação.
      return g.s.approveAll();
    },
    scopeBody(overrides = {}) {
      return {
        projectId: PROJECT,
        taskId: TASK,
        agentIds: ['claude-code'],
        capabilities: ['text.review'],
        dataRefs: [{ kind: 'task', ref: TASK }],
        channel: 'simulated',
        mode: 'subscription_assisted',
        maxInvocations: 3,
        budgetMinor: 0,
        validitySeconds: 1800,
        maxOutputBytes: 4096,
        ...overrides,
      };
    },
    async activeScope(overrides = {}) {
      const body = g.scopeBody(overrides);
      const scope = await g.gateway.requestScope('admin', body);
      await g.s.approveAll();
      return g.gateway.activateScope('admin', scope.projectId, scope.id);
    },
    taskBody(scopeId: string, overrides = {}) {
      seq += 1;
      return {
        idempotencyKey: `gw-test-${String(seq).padStart(4, '0')}`,
        projectId: PROJECT,
        taskId: TASK,
        agentId: 'claude-code',
        scopeId,
        capability: 'text.review',
        inputs: [{ kind: 'task', ref: TASK }],
        instructions: 'Revise a tarefa.',
        timeoutSeconds: 60,
        maxOutputBytes: 4096,
        ...overrides,
      };
    },
    async cycle(rounds = 3) {
      const delivered: Array<{ result: ExecutionResult; receipt: unknown }> = [];
      for (let round = 0; round < rounds; round += 1) {
        await g.s.scheduler.tick();
        await g.gateway.executor.idle();
        for (const result of g.gateway.executor.drain()) delivered.push({ result, receipt: await g.s.scheduler.onResult(result) });
        await g.s.approveAll();
      }
      return delivered;
    },
    async restartGateway(opts: { queue?: boolean } = {}) {
      await g.store.close();
      await openGateway();
      if (opts.queue) await g.s.restart();
    },
    async close() {
      await g.store.close().catch(() => undefined);
      await g.s.close();
      await rm(root, { recursive: true, force: true });
    },
  });
  return g;
}
