// @vitest-environment node
/**
 * Issue #008 (PR 2): rotas HTTP das ordens do Claude Code, de ponta a ponta no servidor real —
 * sessão, CSRF, política, confirmação de identidade (uso único), isolamento por projeto, pacote só na
 * liberação, verificação somente leitura, espelho na auditoria (#006) e ausência de vazamentos.
 * O GitHub é FALSO (memória); nenhuma chamada a provedor de IA.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalPresentationDigest, type ApprovalPresentation } from '../../shared/approvalPresentation.ts';
import { bindingDigest, paramsDigestOf } from '../approvals/binding.ts';
import type { ApprovalBinding } from '../approvals/contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from '../approvals/identity.ts';
import { createEnvKeyProvider } from '../approvals/keyProvider.ts';
import { createApprovalService } from '../approvals/service.ts';
import { openApprovalStore, type ApprovalStore } from '../approvals/store.ts';
import { createAuditSequence, openAuditLog } from '../audit/auditLog.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { createContentManager } from '../gateway/content.ts';
import { createClaudeOrders } from '../gateway/orders.ts';
import { createGateway } from '../gateway/service.ts';
import { GATEWAY_CONTENT_KEY_DOMAIN, GATEWAY_KEY_DOMAIN, openGatewayStore, type GatewayStore } from '../gateway/store.ts';
import { assistedProfileAvailable } from '../limits/providers.ts';
import { createConsoleLogger } from '../logger.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { openProjectStore } from '../projects/projectStore.ts';
import { openSealedBlobStore } from '../storage/sealedBlobs.ts';
import { deriveSubkey } from '../storage/subkeys.ts';
import { openTaskStore } from '../tasks/taskStore.ts';
import { conformingPr, createFakeGitHub, REPO_ID } from '../test/claudeOrderFixtures.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const START = Date.parse('2026-11-19T12:00:00Z');
const REPO = ALLOWED_REPOSITORIES[0];
const VERSION = DEFAULT_POLICY.version;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function startApp(options: { gateway?: boolean; barrier?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acc-claude-http-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const clock = { wall: START, mono: 1_000 };
  const now = () => clock.wall;
  const logLines: string[] = [];
  const logger = createConsoleLogger((line) => logLines.push(line));
  const auth = await createTestAuth({ now });
  const sequence = createAuditSequence();
  const projects = await openProjectStore({ filePath: join(root, 'data', 'projects.json'), allowedRepositories: ALLOWED_REPOSITORIES, sequence, now });
  const tasks = await openTaskStore({ filePath: join(root, 'data', 'tasks.json'), sequence, now });
  const audit = await openAuditLog({ filePath: join(root, 'data', 'audit.json'), sequence, now });
  const project = await projects.create('admin', { name: 'Projeto Claude', description: '', status: 'active', repositories: [REPO] } as never, { kind: 'human', id: 'admin' });
  const other = await projects.create('admin', { name: 'Projeto B', description: '', status: 'active', repositories: [REPO] } as never, { kind: 'human', id: 'admin' });
  const fields = (title: string, agentId = 'claude-code') => ({ title, description: `Descrição de ${title}`, status: 'pending' as const, priority: 'medium' as const, assignee: { kind: 'agent' as const, agentId: agentId as 'claude-code' }, dependsOn: [], references: [] });
  const task = await tasks.create('admin', project.id, fields('Tarefa do Claude'), { actor: 'admin' });
  const gptTask = await tasks.create('admin', project.id, fields('Tarefa do ChatGPT', 'chatgpt'), { actor: 'admin' });

  const master = randomBytes(32);
  const store: ApprovalStore = await openApprovalStore({ approvalsDir: join(root, 'approvals'), anchorDir: join(root, 'anchor'), keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: master.toString('hex') }), environment: { env: {} }, initialize: 'if_absent', now });
  cleanup.push(() => store.close());
  const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now });
  const service = createApprovalService({ store, identity, policyVersion: VERSION, now, monotonicNow: () => clock.mono });
  if (options.barrier !== true) {
    const ctx: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('setup').digest('hex') };
    const binding: ApprovalBinding = { action: 'killswitch.release', projectId: null, resource: { type: 'killswitch', id: 'global' }, target: { sha: null, ref: null }, subject: { kind: 'human', id: 'admin' }, paramsDigest: paramsDigestOf('killswitch.release', { scope: 'global' }), policyVersion: VERSION };
    const release = await service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: (await identity.confirm(ctx, 'password', TEST_ADMIN_PASSWORD)).proofId, identity: ctx });
    const r = await service.reserve({ ownerId: 'admin', approvalId: release.id, component: 'approvals', binding });
    await service.releaseBarrier({ attemptId: r.attemptId });
  }

  const github = createFakeGitHub();
  github.main = { repositoryId: REPO_ID, nameWithOwner: REPO, sha: 'b'.repeat(40) };
  let gatewayStore: GatewayStore | null = null;
  let claudeOrders = null;
  if (options.gateway !== false) {
    const gs = await openGatewayStore({ gatewayDir: join(root, 'gateway'), anchorDir: join(root, 'anchor'), separateFrom: [join(root, 'content')], environment: { env: {} }, loadKey: () => deriveSubkey(master, GATEWAY_KEY_DOMAIN), initialize: 'if_absent', now });
    gatewayStore = gs;
    cleanup.push(() => gs.close());
    const blobs = await openSealedBlobStore({ dir: join(root, 'content'), environment: { env: {} }, loadKey: () => deriveSubkey(master, GATEWAY_CONTENT_KEY_DOMAIN), separateFrom: [join(root, 'gateway'), join(root, 'anchor')] });
    const verifier = service.verifierFor('gateway');
    const gateway = createGateway({
      store: gs,
      content: createContentManager({ store: gs, blobs, now }),
      adapters: {},
      projects,
      tasks,
      resolveData: ({ ownerId, projectId, kind, ref }) => (kind === 'task' ? (tasks.get(ownerId, projectId, ref)?.description ?? null) : null),
      approvals: { request: (i) => service.request(i), reserve: (i) => service.reserve(i), recordOutcome: (i) => service.recordOutcome(i), confirmOwner: (i) => service.confirmOwner(i) },
      approvalVerifier: { id: verifier.id, kind: verifier.kind, verifyGrant: (g) => verifier.verifyGrant(g), verify: (a) => verifier.verify(a) },
      identity: { consume: (p, ctx) => identity.consume(p, ctx) },
      barriers: {
        blocked: (projectId) => {
          const b = service.barriers();
          if (b.durable.global !== null || b.volatile.includes('global')) return 'global_barrier';
          return b.durable.projects[projectId] ? 'project_barrier' : null;
        },
      },
      assistedProfileAvailable: () => assistedProfileAvailable(),
      now,
      monotonicNow: () => clock.mono,
    });
    claudeOrders = {
      orders: createClaudeOrders({
        gateway,
        reader: github,
        approvalsFor: (ownerId, scopeId) => service.list(ownerId).filter((a) => a.binding.resource.id === scopeId).map((a) => ({ id: a.id, action: a.binding.action, state: a.state })),
        now,
      }),
      status: () => gs.status(),
    };
  }

  const server: Server = createServer();
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: { port, allowedRepositories: ALLOWED_REPOSITORIES, allowedOrigins: [ORIGIN], credentials: null, rateLimitPerMinute: 10_000 },
    snapshots: null,
    auth,
    projects,
    tasks,
    audit,
    approvals: { service, identity },
    claudeOrders,
    logger,
    now,
  });
  server.on('request', (req, res) => void handler(req, res));

  function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  }
  const post = (path: string, body: unknown, cookie: string | null, headers: Record<string, string> = {}) =>
    call(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });
  const get = (path: string, cookie: string | null) => call(path, { headers: cookie ? { cookie } : {} });
  async function login(): Promise<string> {
    const reply = await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }, null);
    expect(reply.status).toBe(200);
    return (reply.headers['set-cookie'] as string[])[0].split(';')[0];
  }
  async function proofId(cookie: string): Promise<string> {
    const reply = await post('/api/approvals/step-up', { password: TEST_ADMIN_PASSWORD }, cookie);
    expect(reply.status).toBe(200);
    return reply.json().proofId as string;
  }
  /** Aprova pela rota real (step-up + resumos recalculados, como o navegador). */
  async function approveAll(cookie: string) {
    for (const a of service.list('admin').filter((x) => x.state === 'pending')) {
      const reply = await post(`/api/approvals/${a.id}/approve`, { bindingDigest: a.bindingDigest, presentationDigest: approvalPresentationDigest(a.bindingDigest, a.presentation as ApprovalPresentation), proofId: await proofId(cookie) }, cookie);
      expect(reply.status).toBe(200);
    }
  }
  return { post, get, login, proofId, approveAll, project, other, task, gptTask, github, logLines, audit, service, gatewayStore, advance: (ms: number) => ((clock.wall += ms), (clock.mono += ms)) };
}

type App = Awaited<ReturnType<typeof startApp>>;
const ordersPath = (app: App, projectId = app.project.id) => `/api/projects/${projectId}/claude-orders`;
const createPath = (app: App, taskId = app.task.id, projectId = app.project.id) => `/api/projects/${projectId}/tasks/${taskId}/claude-orders`;
const enable = async (app: App, cookie: string) => {
  const reply = await app.post(`/api/projects/${app.project.id}/claude-enablement`, { enabled: true, repository: REPO, proofId: await app.proofId(cookie) }, cookie);
  expect(reply.status).toBe(200);
  return reply;
};
let keySeq = 0;
const createBody = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: `http-order-${String(++keySeq).padStart(5, '0')}`, objective: 'Implementar X.', acceptanceCriteria: ['Testes passam'], ...overrides });

describe('rotas das ordens do Claude Code', () => {
  it('fluxo completo pela API: habilitar → criar → aprovar → pacote → encaminhado → PR → verificar', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const empty = await app.get(ordersPath(app), cookie);
    expect(empty.status).toBe(200);
    expect(empty.json()).toMatchObject({ gateway: { state: 'available' }, enablement: { enabled: false }, linkableRepositories: [REPO], orders: [] });
    expect((await app.post(createPath(app), createBody(), cookie)).json().error.code).toBe('project_not_enabled');
    await enable(app, cookie);
    const created = await app.post(createPath(app), createBody(), cookie);
    expect(created.status).toBe(201);
    const order = created.json().order;
    expect(order).toMatchObject({ state: 'awaiting_approval', repository: REPO, agentId: 'claude-code' });
    await app.approveAll(cookie);
    // Liberação: `/package` (a rota `/release` não existe: teste estrutural proíbe `release` em POST).
    expect((await app.post(`/api/claude-orders/${order.orderId}/release`, { proofId: 'x' }, cookie)).status).toBe(405);
    const released = await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: await app.proofId(cookie) }, cookie);
    expect(released.status).toBe(200);
    expect(released.json().package).toContain(order.workBranch);
    // A listagem nunca devolve o pacote nem o objetivo.
    const listed = await app.get(ordersPath(app), cookie);
    expect(listed.body).not.toContain('Trabalhe SOMENTE');
    expect(listed.body).not.toContain('Implementar X.');
    expect((await app.post(`/api/claude-orders/${order.orderId}/forwarded`, {}, cookie)).json().order.state).toBe('awaiting_pr');
    app.github.pr = conformingPr(order);
    const linked = await app.post(`/api/claude-orders/${order.orderId}/pr`, { pullRequest: `${REPO}#7`, proofId: await app.proofId(cookie) }, cookie);
    expect(linked.status).toBe(200);
    const verified = await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie);
    expect(verified.status).toBe(200);
    expect(verified.json()).toMatchObject({ order: { state: 'verified' }, outcome: { verdict: 'conforming', created: true } });
    // Espelho na auditoria da #006 (sem conteúdo).
    const events = (await app.get('/api/audit?limit=200', cookie)).json().events as Array<{ action: string; outcome: string; context: Record<string, unknown> }>;
    const actions = events.map((e) => e.action);
    for (const action of ['claude_project.enablement', 'claude_order.requested', 'claude_order.package_released', 'claude_order.forwarded', 'claude_order.pr_linked', 'claude_order.verified']) expect(actions).toContain(action);
    expect(events.find((e) => e.action === 'claude_order.verified')!.context).toMatchObject({ verdict: 'conforming', seq: 1 });
    expect(JSON.stringify(events)).not.toMatch(/Implementar X|Trabalhe SOMENTE|SENHACANARIA/);
    expect(app.logLines.join('\n')).not.toMatch(/Implementar X|Trabalhe SOMENTE|SENHACANARIA/);
    // Verificação muito próxima → 429 com Retry-After.
    const soon = await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie);
    expect(soon.status).toBe(429);
    expect(soon.headers['retry-after']).toBe('30');
  });

  it('CSRF, sessão e método: recusados antes de qualquer efeito', async () => {
    const app = await startApp();
    const cookie = await app.login();
    expect((await app.post(createPath(app), createBody(), cookie, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await app.post(createPath(app), createBody(), cookie, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.post(createPath(app), createBody(), cookie, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await app.post(createPath(app), createBody(), null)).status).toBe(401);
    expect((await app.get(ordersPath(app), null)).status).toBe(401);
    expect((await app.get(createPath(app), cookie)).status).toBe(405);
    expect(app.service.list('admin').filter((a) => a.binding.resource.type === 'gateway_scope')).toHaveLength(0);
  });

  it('corpos fechados: dono, repositório, branch, SHA, capacidade ou agente vindos do cliente → 400', async () => {
    const app = await startApp();
    const cookie = await app.login();
    await enable(app, cookie);
    for (const extra of [{ ownerId: 'x' }, { repository: 'outro/repo' }, { workBranch: 'main' }, { baseSha: 'a'.repeat(40) }, { capability: 'code.change' }, { agentId: 'chatgpt' }, { scopeId: app.task.id }]) {
      expect((await app.post(createPath(app), createBody(extra), cookie)).status).toBe(400);
    }
    // Referência a tarefa de outro projeto ou de outro tipo → 400.
    expect((await app.post(createPath(app), createBody({ dataRefs: [{ kind: 'issue', ref: '#1' }] }), cookie)).status).toBe(400);
    expect((await app.post(createPath(app), createBody({ dataRefs: [{ kind: 'task', ref: '00000000-0000-4000-8000-000000000000' }] }), cookie)).status).toBe(400);
    // Tarefa de outro agente → política (403).
    expect((await app.post(createPath(app, app.gptTask.id), createBody(), cookie)).json().error.code).toBe('policy_denied');
    // Segredo no objetivo → 422 sem gravar.
    const token = ['ghp', 'Z'.repeat(36)].join('_');
    expect((await app.post(createPath(app), createBody({ objective: `token ${token}` }), cookie)).json().error.code).toBe('secret_detected');
  });

  it('step-up obrigatório para pacote, PR, cancelamento e habilitação; prova reutilizada é recusada', async () => {
    const app = await startApp();
    const cookie = await app.login();
    expect((await app.post(`/api/projects/${app.project.id}/claude-enablement`, { enabled: true, repository: REPO, proofId: 'invalida' }, cookie)).json().error.code).toBe('confirmation_required');
    await enable(app, cookie);
    const order = (await app.post(createPath(app), createBody(), cookie)).json().order;
    await app.approveAll(cookie);
    expect((await app.post(`/api/claude-orders/${order.orderId}/package`, {}, cookie)).status).toBe(400);
    expect((await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: 'nao-existe' }, cookie)).json().error.code).toBe('confirmation_required');
    const proof = await app.proofId(cookie);
    expect((await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: proof }, cookie)).status).toBe(200);
    expect((await app.post(`/api/claude-orders/${order.orderId}/pr`, { pullRequest: `${REPO}#7`, proofId: proof }, cookie)).json().error.code).toBe('confirmation_required');
    expect((await app.post(`/api/claude-orders/${order.orderId}/cancel`, {}, cookie)).status).toBe(400);
    expect((await app.post(`/api/claude-orders/${order.orderId}/cancel`, { proofId: await app.proofId(cookie) }, cookie)).json().order.state).toBe('cancelled');
  });

  it('isolamento: habilitar um projeto não habilita outro; ordem inexistente/alheia → 404', async () => {
    const app = await startApp();
    const cookie = await app.login();
    await enable(app, cookie);
    const otherTask = await (async () => (await app.post(`/api/projects/${app.other.id}/tasks`, { title: 'T', description: '', priority: 'medium', assignee: { kind: 'agent', agentId: 'claude-code' } }, cookie)).json())();
    expect((await app.post(createPath(app, otherTask.id, app.other.id), createBody(), cookie)).json().error.code).toBe('project_not_enabled');
    expect((await app.get(ordersPath(app, app.other.id), cookie)).json().enablement.enabled).toBe(false);
    expect((await app.post(`/api/claude-orders/00000000-0000-4000-8000-000000000000/verify`, {}, cookie)).status).toBe(404);
    expect((await app.post(`/api/claude-orders/nao-uuid/verify`, {}, cookie)).status).toBe(404);
    // Repositório fora do projeto/allowlist na habilitação → 422.
    expect((await app.post(`/api/projects/${app.project.id}/claude-enablement`, { enabled: true, repository: 'outro/repo', proofId: await app.proofId(cookie) }, cookie)).json().error.code).toBe('repository_not_allowed');
  });

  it('barreira global ativa (instalação nova, #011 N9): nada é criado — 423, com o restante do ACC funcionando', async () => {
    const app = await startApp({ barrier: true });
    const cookie = await app.login();
    // Habilitar é configuração (não barrada pela barreira).
    await enable(app, cookie);
    const reply = await app.post(createPath(app), createBody(), cookie);
    expect(reply.status).toBe(423);
    expect(reply.json().error.code).toBe('approval_blocked');
    expect((await app.get('/api/projects', cookie)).status).toBe(200);
  });

  it('sem gateway configurado: listagem informa indisponível; escritas → 503', async () => {
    const app = await startApp({ gateway: false });
    const cookie = await app.login();
    expect((await app.get(ordersPath(app), cookie)).json()).toMatchObject({ gateway: { state: 'unavailable', reason: 'not_configured' }, orders: [] });
    expect((await app.post(createPath(app), createBody(), cookie)).json().error.code).toBe('gateway_unavailable');
  });

  it('GitHub indisponível ou HEAD alterado: erro explícito, nada gravado', async () => {
    const app = await startApp();
    const cookie = await app.login();
    await enable(app, cookie);
    const order = (await app.post(createPath(app), createBody(), cookie)).json().order;
    await app.approveAll(cookie);
    await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: await app.proofId(cookie) }, cookie);
    app.github.pr = conformingPr(order);
    await app.post(`/api/claude-orders/${order.orderId}/pr`, { pullRequest: `${REPO}#7`, proofId: await app.proofId(cookie) }, cookie);
    app.github.faults.push('unavailable');
    const down = await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie);
    expect(down.status).toBe(503);
    expect(down.json().error.code).toBe('github_unavailable');
    app.advance(31_000);
    app.github.onPullRequest = (call) => {
      if (call === 2) app.github.pr = { ...app.github.pr!, headRefOid: 'c'.repeat(40), lastCommit: { ...app.github.pr!.lastCommit!, oid: 'c'.repeat(40) } };
    };
    expect((await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie)).json().error.code).toBe('head_changed');
    expect((await app.get(ordersPath(app), cookie)).json().orders[0].history).toEqual([]);
  });
});
