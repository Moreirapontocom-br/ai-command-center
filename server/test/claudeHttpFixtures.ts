/**
 * Pilha HTTP REAL das ordens do Claude Code para testes (Issues #008 e #055): servidor, sessão, CSRF,
 * aprovações (#011), gateway com ledger assinado, auditoria (#006) e, opcionalmente, a ponte MCP
 * local. O GitHub é FALSO (memória); nenhuma chamada a provedor de IA.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect } from 'vitest';
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
import { createBridgeOrders, type BridgeOrders } from '../gateway/bridge.ts';
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
import { createFakeGitHub, REPO_ID } from './claudeOrderFixtures.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, testPasswordHash } from './authFixtures.ts';
import { createRequestHandler } from '../http/app.ts';
import { publicOrderCode } from '../http/claudeOrderRoutes.ts';

export const ORIGIN = 'http://localhost:5173';
export const START = Date.parse('2026-11-19T12:00:00Z');
export const REPO = ALLOWED_REPOSITORIES[0];
export const VERSION = DEFAULT_POLICY.version;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => undefined);
});

export interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function startApp(options: { gateway?: boolean; barrier?: boolean; bridge?: boolean } = {}) {
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
  let bridgeOrders: BridgeOrders | null = null;
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
      bridgeEnabled: () => options.bridge === true,
      now,
      monotonicNow: () => clock.mono,
    });
    claudeOrders = {
      orders: createClaudeOrders({
        gateway,
        reader: github,
        approvalsFor: (ownerId, scopeId) => service.list(ownerId).filter((a) => a.binding.resource.id === scopeId).map((a) => ({ id: a.id, action: a.binding.action, state: a.state })),
        publicCode: (code) => publicOrderCode(code),
        now,
      }),
      status: () => gs.status(),
    };
    if (options.bridge === true) bridgeOrders = createBridgeOrders({ gateway, orders: claudeOrders.orders });
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
    bridge: bridgeOrders,
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
  return { root, port, call, post, get, login, proofId, approveAll, project, other, task, gptTask, tasks, github, logLines, audit, service, identity, gatewayStore, bridgeOrders, advance: (ms: number) => ((clock.wall += ms), (clock.mono += ms)) };
}

export type App = Awaited<ReturnType<typeof startApp>>;
export const ordersPath = (app: App, projectId = app.project.id) => `/api/projects/${projectId}/claude-orders`;
export const createPath = (app: App, taskId = app.task.id, projectId = app.project.id) => `/api/projects/${projectId}/tasks/${taskId}/claude-orders`;
export const enable = async (app: App, cookie: string) => {
  const reply = await app.post(`/api/projects/${app.project.id}/claude-enablement`, { enabled: true, repository: REPO, proofId: await app.proofId(cookie) }, cookie);
  expect(reply.status).toBe(200);
  return reply;
};
let keySeq = 0;
export const createBody = (overrides: Record<string, unknown> = {}) => ({ idempotencyKey: `http-order-${String(++keySeq).padStart(5, '0')}`, objective: 'Implementar X.', acceptanceCriteria: ['Testes passam'], ...overrides });

