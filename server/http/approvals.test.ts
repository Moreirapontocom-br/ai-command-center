// @vitest-environment node
/**
 * Issue #011 (PR 2): rotas HTTP de aprovação humana, de ponta a ponta no servidor real —
 * sessão, CSRF, identidade derivada da sessão, confirmação por senha (uso único, presa à sessão,
 * 5 minutos, bloqueio após falhas), decisão sobre o vínculo exato, expiração, histórico,
 * preservação, retenção, espelho na auditoria da #006 e ausência de vazamentos.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { approvalBindingDigest } from '../../shared/approvalDigest.ts';
import { approvalPresentationDigest, checkPresentation, type ApprovalPresentation } from '../../shared/approvalPresentation.ts';
import type { ApprovalDetail, ApprovalListResponse } from '../../shared/contracts.ts';
import { bindingDigest, paramsDigestOf } from '../approvals/binding.ts';
import type { ApprovalBinding, LedgerApproval } from '../approvals/contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from '../approvals/identity.ts';
import { createEnvKeyProvider } from '../approvals/keyProvider.ts';
import { createApprovalService } from '../approvals/service.ts';
import { openApprovalStore, type ApprovalStore } from '../approvals/store.ts';
import { createAuditSequence, openAuditLog } from '../audit/auditLog.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { createConsoleLogger } from '../logger.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { openProjectStore } from '../projects/projectStore.ts';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const START = Date.parse('2026-11-15T12:00:00Z');
const MIN = 60_000;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const VERSION = DEFAULT_POLICY.version;
const TASK = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
/** Parâmetros exatos do sandbox (correção R1); `n` distingue dois conjuntos de parâmetros. */
const sandboxParams = (n = 1) => ({
  requestId: n === 1 ? '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' : '8b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e',
  repository: 'Moreirapontocom-br/ai-command-center',
  network: { default: 'deny', allow: n === 1 ? [] : ['registry.npmjs.org'] },
  credentials: { scopes: ['repo.read'], ttlSeconds: 600, productionSecrets: 'denied', productionDatabase: 'denied' },
  limits: { timeoutSeconds: 600, cpu: 1, memoryMb: 512, diskMb: 1024 },
  inputs: [{ kind: 'issue', ref: 'acc#11', trust: 'untrusted' }],
});
/** Resumo da apresentação (vínculo + parâmetros) como o navegador envia ao aprovar. */
const pd = (a: Pick<LedgerApproval, 'bindingDigest' | 'presentation'>) => (a.presentation ? approvalPresentationDigest(a.bindingDigest, a.presentation as ApprovalPresentation) : 'f'.repeat(64));

const servers: Server[] = [];
const stores: ApprovalStore[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const s of stores.splice(0)) await s.close();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function startApp(options: { approvals?: boolean; releaseBarrier?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acc-approvals-http-'));
  roots.push(root);
  const clock = { wall: START, mono: 1_000 };
  const now = () => clock.wall;
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  const logLines: string[] = [];
  const logger = createConsoleLogger((line) => logLines.push(line));
  const auth = await createTestAuth({ now });
  const sequence = createAuditSequence();
  const projects = await openProjectStore({ filePath: join(root, 'data', 'projects.json'), allowedRepositories: ALLOWED_REPOSITORIES, sequence, now });
  const audit = await openAuditLog({ filePath: join(root, 'data', 'audit.json'), sequence, now });
  const project = await projects.create('admin', { name: 'Projeto Aprovações', description: '', status: 'active', repositories: [] } as never, { kind: 'human', id: 'admin' });

  const key = randomBytes(32).toString('hex');
  const openStore = async (initialize: 'never' | 'if_absent') => {
    const opened = await openApprovalStore({
      approvalsDir: join(root, 'approvals'),
      anchorDir: join(root, 'anchor'),
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: key }),
      environment: { env: {} },
      initialize,
      now,
    });
    stores.push(opened);
    return opened;
  };
  let runtime: { service: ReturnType<typeof createApprovalService>; identity: ReturnType<typeof createStepUpRegistry> } | null = null;
  let store: ApprovalStore | null = null;
  let service: ReturnType<typeof createApprovalService> | null = null;
  let identity: ReturnType<typeof createStepUpRegistry> | null = null;
  if (options.approvals !== false) {
    store = await openStore('if_absent');
    identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now });
    service = createApprovalService({ store, identity, policyVersion: VERSION, now, monotonicNow: () => clock.mono });
    runtime = { service, identity };
    if (options.releaseBarrier !== false) {
      // Instalação nova começa com barreira global: liberada aqui pelo fluxo de configuração do PO.
      const ctx: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('setup').digest('hex') };
      const binding: ApprovalBinding = {
        action: 'killswitch.release',
        projectId: null,
        resource: { type: 'killswitch', id: 'global' },
        target: { sha: null, ref: null },
        subject: { kind: 'human', id: 'admin' },
        paramsDigest: paramsDigestOf('killswitch.release', { scope: 'global' }),
        policyVersion: VERSION,
      };
      const proofId = (await identity.confirm(ctx, 'password', TEST_ADMIN_PASSWORD)).proofId;
      const release = await service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId, identity: ctx });
      const r = await service.reserve({ ownerId: 'admin', approvalId: release.id, component: 'approvals', binding });
      await service.releaseBarrier({ attemptId: r.attemptId });
    }
  }

  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: { port, allowedRepositories: ALLOWED_REPOSITORIES, allowedOrigins: [ORIGIN], credentials: null, rateLimitPerMinute: 10_000 },
    snapshots: null,
    auth,
    projects,
    audit,
    approvals: runtime,
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
    call(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, cookie: string | null) => call(path, { headers: cookie ? { cookie } : {} });
  async function login(): Promise<string> {
    const reply = await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }, null);
    expect(reply.status).toBe(200);
    const header = reply.headers['set-cookie']![0];
    return header.split(';')[0];
  }
  async function proof(cookie: string, password = TEST_ADMIN_PASSWORD) {
    return post('/api/approvals/step-up', { password }, cookie);
  }
  async function proofId(cookie: string) {
    const reply = await proof(cookie);
    expect(reply.status).toBe(200);
    return reply.json().proofId as string;
  }
  /** Pedido de um componente confiável do servidor (sandbox) em nome de um agente. */
  const agentBinding = (overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
    action: 'sandbox.execute',
    projectId: project.id,
    resource: { type: 'task', id: TASK },
    target: { sha: SHA_A, ref: null },
    subject: { kind: 'agent', id: 'claude-code' },
    paramsDigest: paramsDigestOf('sandbox', sandboxParams(1)),
    policyVersion: VERSION,
    ...overrides,
  });
  const mergeParams = () => ({
    projectId: project.id,
    taskId: TASK,
    agentId: 'claude-code',
    action: 'repo.merge',
    mode: 'subscription_assisted',
    durationSeconds: 60,
    estimatedCostMinor: null,
    maxTokens: null,
  });
  const mergeBinding = () => agentBinding({ action: 'repo.merge', resource: { type: 'task', id: TASK }, paramsDigest: paramsDigestOf('admission', mergeParams()) });
  /** O componente real entrega os parâmetros exatos cujo resumo está no vínculo (apresentação). */
  const presentationFor = (binding: ApprovalBinding) => {
    if (binding.action !== 'sandbox.execute') return { requestedBy: 'limits', presentation: { kind: 'admission', params: mergeParams() } };
    const params = [sandboxParams(1), sandboxParams(2)].find((p) => paramsDigestOf('sandbox', p) === binding.paramsDigest);
    return { requestedBy: 'sandbox', presentation: params ? { kind: 'sandbox', params } : undefined };
  };
  const requestApproval = (binding = agentBinding()) => service!.request({ ownerId: 'admin', binding, ...presentationFor(binding) });
  async function detail(cookie: string, id: string): Promise<ApprovalDetail> {
    const reply = await get(`/api/approvals/${id}`, cookie);
    expect(reply.status).toBe(200);
    return reply.json().approval;
  }
  /** Como o navegador: recalcula os resumos a partir do que o servidor exibiu e envia ambos. */
  async function decide(cookie: string, id: string, verb: 'approve' | 'reject') {
    const shown = await detail(cookie, id);
    if (verb === 'reject') return post(`/api/approvals/${id}/reject`, { bindingDigest: shown.bindingDigest, proofId: await proofId(cookie) }, cookie);
    const check = checkPresentation({ binding: shown.binding, bindingDigest: approvalBindingDigest(shown.binding), requestedBy: shown.requestedBy, presentation: shown.presentation });
    const presentationDigest = check.ok ? check.digest : 'f'.repeat(64);
    return post(`/api/approvals/${id}/approve`, { bindingDigest: approvalBindingDigest(shown.binding), presentationDigest, proofId: await proofId(cookie) }, cookie);
  }
  const auditFile = () => readFile(join(root, 'data', 'audit.json'), 'utf8');
  /** Reinício do servidor: reabre o armazenamento (nova época, N1) com um núcleo novo. */
  async function restart() {
    await store!.close();
    store = await openStore('never');
    service = createApprovalService({ store, identity: identity!, policyVersion: VERSION, now, monotonicNow: () => clock.mono });
    runtime!.service = service;
  }
  return { call, post, get, login, proof, proofId, requestApproval, agentBinding, mergeBinding, sandboxParams, detail, decide, svc: () => service!, st: () => store!, restart, advance, logLines, auditFile, project, root };
}

describe('autenticação, CSRF e identidade (grupo A)', () => {
  it('sem sessão ou com sessão inválida: 401, em leitura e em decisão', async () => {
    const app = await startApp();
    const request = await app.requestApproval();
    expect((await app.get('/api/approvals', null)).status).toBe(401);
    expect((await app.get(`/api/approvals/${request.id}`, 'acc_session=invalido')).status).toBe(401);
    const reply = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId: 'x'.repeat(43) }, null);
    expect(reply.status).toBe(401);
    expect((await app.post('/api/approvals/step-up', { password: TEST_ADMIN_PASSWORD }, 'acc_session=' + 'A'.repeat(43))).status).toBe(401);
    expect(app.svc().get('admin', request.id)!.state).toBe('pending');
  });

  it('CSRF: sem Origin, origem não autorizada, cross-site e corpo que não é JSON são recusados antes da sessão', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const path = `/api/approvals/${request.id}/approve`;
    const body = JSON.stringify({ bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId: 'x'.repeat(43) });
    const base = { cookie, 'content-type': 'application/json' };
    expect((await app.call(path, { method: 'POST', headers: base, body })).status).toBe(403);
    expect((await app.call(path, { method: 'POST', headers: { ...base, origin: 'http://evil.example' }, body })).status).toBe(403);
    expect((await app.call(path, { method: 'POST', headers: { ...base, origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, body })).status).toBe(403);
    expect((await app.call(path, { method: 'POST', headers: { ...base, origin: ORIGIN, 'sec-fetch-site': 'same-site' }, body })).status).toBe(403);
    expect((await app.call(path, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect((await app.call('/api/approvals/step-up', { method: 'POST', headers: { ...base, origin: ORIGIN, host: 'evil.example' }, body: '{}' })).status).toBe(403);
    expect(app.svc().get('admin', request.id)!.state).toBe('pending');
  });

  it('campos inesperados e identidade declarada pelo cliente são recusados (400); cabeçalhos não mudam quem aprova', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const proofId = await app.proofId(cookie);
    for (const extra of [{ userId: 'claude-code' }, { approvedBy: { kind: 'human', id: 'admin' } }, { ownerId: 'admin' }, { admin: true }, { decision: 'approve' }]) {
      const reply = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId, ...extra }, cookie);
      expect(reply.status).toBe(400);
    }
    expect((await app.post('/api/approvals/step-up', { password: TEST_ADMIN_PASSWORD, userId: 'admin' }, cookie)).status).toBe(400);
    expect((await app.post('/api/approvals/step-up', ['x'], cookie)).status).toBe(400);
    expect((await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: 'nao-hex', proofId }, cookie)).status).toBe(400);
    expect((await app.post('/api/approvals/nao-uuid/approve', { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId }, cookie)).status).toBe(404);
    // Cabeçalhos "de identidade" são ignorados: a decisão é sempre da pessoa da sessão.
    const reply = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId }, cookie, { 'x-user-id': 'claude-code', 'x-approved-by': 'gemini' });
    expect(reply.status).toBe(200);
    expect(reply.json().approval).toMatchObject({ state: 'approved', decidedBy: { kind: 'human', id: 'admin' } });
  });

  it('senha incorreta é recusada; 5 falhas bloqueiam a confirmação mesmo com a senha certa', async () => {
    const app = await startApp();
    const cookie = await app.login();
    for (let i = 0; i < 5; i += 1) {
      const reply = await app.proof(cookie, 'senha-errada');
      expect(reply.status).toBe(403);
      expect(reply.json().error.code).toBe('confirmation_failed');
    }
    const locked = await app.proof(cookie);
    expect(locked.status).toBe(429);
    expect(locked.json().error.code).toBe('confirmation_locked');
    app.advance(15 * MIN);
    const again = await app.login();
    expect((await app.proof(again)).status).toBe(200);
  });

  it('confirmações simultâneas são limitadas (scrypt), sem afetar as seguintes', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const replies = await Promise.all([app.proof(cookie), app.proof(cookie), app.proof(cookie), app.proof(cookie)]);
    const statuses = replies.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    expect((await app.proof(cookie)).status).toBe(200);
  });

  it('prova expirada (5 min), reutilizada ou de outra sessão é recusada; logout encerra as provas', async () => {
    const app = await startApp();
    let cookie = await app.login();
    const a = await app.requestApproval();
    const b = await app.requestApproval(app.agentBinding({ resource: { type: 'task', id: '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c' } }));

    const expired = await app.proofId(cookie);
    app.advance(5 * MIN);
    const late = await app.post(`/api/approvals/${a.id}/approve`, { bindingDigest: a.bindingDigest, presentationDigest: pd(a), proofId: expired }, cookie);
    expect(late.status).toBe(403);
    expect(late.json().error.code).toBe('confirmation_required');

    const once = await app.proofId(cookie);
    expect((await app.post(`/api/approvals/${a.id}/reject`, { bindingDigest: a.bindingDigest, proofId: once }, cookie)).status).toBe(200);
    const reused = await app.post(`/api/approvals/${b.id}/reject`, { bindingDigest: b.bindingDigest, proofId: once }, cookie);
    expect(reused.status).toBe(403);
    expect(reused.json().error.code).toBe('confirmation_required');

    // Prova obtida na sessão A, apresentada pela sessão B (novo login revoga A).
    const fromA = await app.proofId(cookie);
    cookie = await app.login();
    const other = await app.post(`/api/approvals/${b.id}/approve`, { bindingDigest: b.bindingDigest, presentationDigest: pd(b), proofId: fromA }, cookie);
    expect(other.status).toBe(403);
    expect(other.json().error.code).toBe('confirmation_required');

    const beforeLogout = await app.proofId(cookie);
    expect((await app.post('/api/auth/logout', {}, cookie)).status).toBe(200);
    cookie = await app.login();
    expect((await app.post(`/api/approvals/${b.id}/approve`, { bindingDigest: b.bindingDigest, presentationDigest: pd(b), proofId: beforeLogout }, cookie)).status).toBe(403);
    expect(app.svc().get('admin', b.id)!.state).toBe('pending');
  });
});

describe('aprovações pelo administrador (grupo B)', () => {
  it('lista e detalhe mostram o vínculo exato; o resumo do navegador coincide com o do servidor', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const list: ApprovalListResponse = (await app.get('/api/approvals', cookie)).json();
    expect(list.subsystem).toEqual({ state: 'available', reason: null, barriers: { global: false, projects: [] }, realExecutionEnabled: false });
    // Além do pedido, aparece a confirmação do PO que liberou a barreira inicial (consumida).
    expect(list.approvals.map((a) => a.state).sort()).toEqual(['consumed', 'pending']);
    expect(list.approvals[0]).toMatchObject({
      id: request.id,
      action: 'sandbox.execute',
      projectId: app.project.id,
      projectName: 'Projeto Aprovações',
      subject: { kind: 'agent', id: 'claude-code' },
      requestedBy: { kind: 'system', id: 'sandbox' },
      state: 'pending',
      requestedAt: '2026-11-15T12:00:00.000Z',
      pendingUntil: '2026-11-16T12:00:00.000Z',
    });
    const shown = await app.detail(cookie, request.id);
    expect(shown.binding).toEqual(app.agentBinding());
    expect(shown.presentable).toBe(true);
    expect(approvalBindingDigest(shown.binding)).toBe(shown.bindingDigest);
    expect(shown.bindingDigest).toBe(bindingDigest(app.agentBinding()));
  });

  it('aprovação válida: estado approved, validade por classe (execução 1 h), histórico oficial e espelho na #006', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const reply = await app.decide(cookie, request.id, 'approve');
    expect(reply.status).toBe(200);
    expect(reply.json().approval).toMatchObject({ state: 'approved', class: 'execution', validUntil: '2026-11-15T13:00:00.000Z', confirmationMethod: 'password' });
    const history = (await app.get('/api/approvals/history', cookie)).json();
    expect(history.items.map((i: { event: string }) => i.event)).toContain('approval.approved');
    expect(history.retentionDays).toBe(365);
    const audit = JSON.parse(await app.auditFile());
    const decision = audit.events.find((e: { action: string }) => e.action === 'approval.decision');
    expect(decision).toMatchObject({ outcome: 'success', actor: { kind: 'human', id: 'admin' }, resource: { type: 'approval', id: request.id }, context: { operation: 'approve', policyAction: 'sandbox.execute', to: 'approved' } });
    expect(audit.events.some((e: { action: string; outcome: string }) => e.action === 'approval.confirmation' && e.outcome === 'success')).toBe(true);
  });

  it('rejeição e revogação ficam registradas; revogada não volta a aprovada', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const rejected = await app.requestApproval();
    expect((await app.decide(cookie, rejected.id, 'reject')).json().approval.state).toBe('rejected');
    expect((await app.decide(cookie, rejected.id, 'approve')).status).toBe(409);

    const other = await app.requestApproval(app.agentBinding({ resource: { type: 'task', id: '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c' } }));
    await app.decide(cookie, other.id, 'approve');
    const revoked = await app.post(`/api/approvals/${other.id}/revoke`, { proofId: await app.proofId(cookie) }, cookie);
    expect(revoked.status).toBe(200);
    expect(revoked.json().approval.state).toBe('revoked');
    expect((await app.decide(cookie, other.id, 'approve')).json().error.code).toBe('approval_conflict');
    expect((await app.post(`/api/approvals/${other.id}/revoke`, { proofId: await app.proofId(cookie) }, cookie)).status).toBe(409);
    const events = app.svc().history().items.flatMap((i) => (i.kind === 'entry' ? [i.event] : []));
    expect(events).toEqual(expect.arrayContaining(['approval.rejected', 'approval.revoked']));
  });

  it('expiração: merge vale 15 min; execução 1 h; pedido pendente vence em 24 h e não pode mais ser aprovado', async () => {
    const app = await startApp();
    let cookie = await app.login();
    const merge = await app.requestApproval(app.mergeBinding());
    const approved = await app.decide(cookie, merge.id, 'approve');
    expect(approved.json().approval).toMatchObject({ class: 'merge', validUntil: '2026-11-15T12:15:00.000Z' });
    app.advance(15 * MIN);
    cookie = await app.login();
    expect((await app.detail(cookie, merge.id)).state).toBe('expired');

    const pending = await app.requestApproval();
    app.advance(24 * 60 * MIN);
    cookie = await app.login();
    expect((await app.detail(cookie, pending.id)).state).toBe('expired');
    const late = await app.decide(cookie, pending.id, 'approve');
    expect(late.status).toBe(409);
    expect(late.json().error.code).toBe('approval_expired');
  });

  it('SHA ou parâmetros alterados: o pedido anterior é substituído; resumo divergente nunca aprova', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const first = await app.requestApproval();
    const second = await app.requestApproval(app.agentBinding({ target: { sha: SHA_B, ref: null } }));
    expect((await app.detail(cookie, first.id)).state).toBe('superseded');
    expect((await app.decide(cookie, first.id, 'approve')).status).toBe(409);
    // O navegador apresentou outro vínculo (ex.: SHA antigo): o servidor recusa.
    const wrong = await app.post(`/api/approvals/${second.id}/approve`, { bindingDigest: first.bindingDigest, presentationDigest: pd(first), proofId: await app.proofId(cookie) }, cookie);
    expect(wrong.status).toBe(409);
    expect(wrong.json().error.code).toBe('approval_binding_mismatch');
    const third = await app.requestApproval(app.agentBinding({ target: { sha: SHA_B, ref: null }, paramsDigest: paramsDigestOf('sandbox', sandboxParams(2)) }));
    expect((await app.detail(cookie, second.id)).state).toBe('superseded');
    expect((await app.decide(cookie, third.id, 'approve')).status).toBe(200);
  });

  it('acesso a registro inexistente ou de outro contexto é indistinguível (404)', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const missing = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect((await app.get(`/api/approvals/${missing}`, cookie)).status).toBe(404);
    const other = await app.svc().request({ ownerId: 'user-b', requestedBy: 'sandbox', binding: app.agentBinding(), presentation: { kind: 'sandbox', params: sandboxParams(1) } });
    expect((await app.get(`/api/approvals/${other.id}`, cookie)).status).toBe(404);
    const reply = await app.post(`/api/approvals/${other.id}/approve`, { bindingDigest: other.bindingDigest, presentationDigest: pd(other), proofId: await app.proofId(cookie) }, cookie);
    expect(reply.status).toBe(404);
    expect(app.svc().get('user-b', other.id)!.state).toBe('pending');
    expect((await app.get('/api/approvals', cookie)).json().approvals.some((a: { id: string }) => a.id === other.id)).toBe(false);
  });

  it('bloqueio de emergência: instalação nova começa bloqueada; aprovar execução é recusado (423), rejeitar continua possível', async () => {
    const app = await startApp({ releaseBarrier: false });
    const cookie = await app.login();
    const list: ApprovalListResponse = (await app.get('/api/approvals', cookie)).json();
    expect(list.subsystem.barriers.global).toBe(true);
    const request = await app.requestApproval();
    const blocked = await app.decide(cookie, request.id, 'approve');
    expect(blocked.status).toBe(423);
    expect(blocked.json().error.code).toBe('approval_blocked');
    expect((await app.decide(cookie, request.id, 'reject')).status).toBe(200);
  });
});

describe('histórico, preservação, retenção e tentativas (grupos B/D)', () => {
  it('retenção: só pela confirmação do PO, dentro de 30 dias a 5 anos; operações de kill switch/limites não são aceitas', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const bad = await app.post('/api/approvals/owner-confirmations', { operation: 'approvals.retention_change', days: 10, proofId: await app.proofId(cookie) }, cookie);
    expect(bad.status).toBe(400);
    for (const operation of ['killswitch.release', 'limits.change', 'repo.merge', 'approvals.history_purge']) {
      const refused = await app.post('/api/approvals/owner-confirmations', { operation, days: 90, proofId: await app.proofId(cookie) }, cookie);
      expect(refused.status).toBe(400);
    }
    const ok = await app.post('/api/approvals/owner-confirmations', { operation: 'approvals.retention_change', days: 90, proofId: await app.proofId(cookie) }, cookie);
    expect(ok.status).toBe(200);
    expect(ok.json().approval).toMatchObject({ method: 'owner_confirmation', class: 'configuration', state: 'consumed', action: 'approvals.retention_change' });
    expect((await app.get('/api/approvals/history', cookie)).json().retentionDays).toBe(90);
    const audit = JSON.parse(await app.auditFile());
    expect(audit.events.find((e: { action: string; outcome: string }) => e.action === 'approval.configuration' && e.outcome === 'success')).toMatchObject({ context: { operation: 'retention_change', to: 90 } });
  });

  it('preservação impede o descarte; descarte exige janela de 30 dias; remoção da preservação é auditada', async () => {
    const app = await startApp();
    let cookie = await app.login();
    const kept = await app.requestApproval();
    await app.decide(cookie, kept.id, 'reject');
    const held = await app.post('/api/approvals/history/holds', { approvalId: kept.id, reason: 'incident', note: 'Revisar <script>', proofId: await app.proofId(cookie) }, cookie);
    expect(held.status).toBe(201);
    expect(held.json().holds).toEqual([expect.objectContaining({ approvalId: kept.id, reason: 'incident' })]);
    expect((await app.post('/api/approvals/history/holds', { approvalId: kept.id, reason: 'outro', proofId: await app.proofId(cookie) }, cookie)).status).toBe(400);

    app.advance(40 * 24 * 60 * MIN);
    cookie = await app.login();
    const tooRecent = new Date(START + 20 * 24 * 60 * MIN).toISOString();
    expect((await app.post('/api/approvals/history/purge', { before: tooRecent, proofId: await app.proofId(cookie) }, cookie)).status).toBe(400);
    const before = new Date(START + 5 * 24 * 60 * MIN).toISOString();
    const purged = await app.post('/api/approvals/history/purge', { before, proofId: await app.proofId(cookie) }, cookie);
    expect(purged.status).toBe(200);
    const history = (await app.get(`/api/approvals/history?approvalId=${kept.id}`, cookie)).json();
    expect(history.items.map((i: { event: string }) => i.event)).toEqual(expect.arrayContaining(['approval.requested', 'approval.rejected']));

    const holdId = history.holds[0].id;
    const removed = await app.post(`/api/approvals/history/holds/${holdId}/remove`, { proofId: await app.proofId(cookie) }, cookie);
    expect(removed.status).toBe(200);
    expect(removed.json().holds).toEqual([]);
    const audit = JSON.parse(await app.auditFile());
    expect(audit.events.filter((e: { action: string }) => e.action === 'approval.hold').map((e: { context: { operation: string } }) => e.context.operation)).toEqual(['hold_add', 'hold_remove']);
    // A observação (texto livre) nunca vai para a auditoria.
    expect(await app.auditFile()).not.toContain('Revisar');
  });

  it('reinício: aprovação concedida expira (N1); tentativa reservada vira indeterminada e só o PO a reconhece', async () => {
    const app = await startApp();
    let cookie = await app.login();
    const used = await app.requestApproval();
    await app.decide(cookie, used.id, 'approve');
    const unused = await app.requestApproval(app.agentBinding({ resource: { type: 'task', id: '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c' } }));
    await app.decide(cookie, unused.id, 'approve');
    const reservation = await app.svc().reserve({ ownerId: 'admin', approvalId: used.id, component: 'sandbox', binding: app.agentBinding() });
    await app.restart();
    cookie = await app.login();
    expect((await app.detail(cookie, unused.id)).state).toBe('expired');
    const shown = await app.detail(cookie, used.id);
    expect(shown.state).toBe('consumed');
    expect(shown.attempts).toEqual([expect.objectContaining({ id: reservation.attemptId, state: 'indeterminate' })]);
    // A aprovação consumida nunca volta a valer: nova reserva é recusada.
    await expect(app.svc().reserve({ ownerId: 'admin', approvalId: used.id, component: 'sandbox', binding: app.agentBinding() })).rejects.toMatchObject({ code: 'approval_already_used' });
    const ack = await app.post(`/api/approvals/attempts/${reservation.attemptId}/acknowledge`, { proofId: await app.proofId(cookie) }, cookie);
    expect(ack.status).toBe(200);
    expect(ack.json().attempt).toMatchObject({ state: 'acknowledged_by_owner' });
    expect((await app.post(`/api/approvals/attempts/${reservation.attemptId}/acknowledge`, { proofId: await app.proofId(cookie) }, cookie)).status).toBe(409);
    expect((await app.detail(cookie, used.id)).state).toBe('consumed');
  });

  it('armazenamento corrompido: o subsistema fica indisponível (503), nunca libera', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    await app.st().close();
    const { writeFile } = await import('node:fs/promises');
    const ledgerPath = join(app.root, 'approvals', 'approvals-ledger.json');
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
    ledger.approvals[ledger.approvals.length - 1].state = 'approved';
    await writeFile(ledgerPath, JSON.stringify(ledger));
    await app.restart();
    expect(app.svc().status().state).toBe('unavailable');
    const list = (await app.get('/api/approvals', cookie)).json();
    expect(list.subsystem.state).toBe('unavailable');
    expect(list.approvals).toEqual([]);
    expect((await app.get(`/api/approvals/${request.id}`, cookie)).status).toBe(503);
    expect((await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId: 'x'.repeat(43) }, cookie)).status).toBe(503);
  });

  it('subsistema não configurado: lista informa indisponível e qualquer decisão responde 503', async () => {
    const app = await startApp({ approvals: false });
    const cookie = await app.login();
    const list = (await app.get('/api/approvals', cookie)).json();
    expect(list).toEqual({ subsystem: { state: 'unavailable', reason: 'not_configured', barriers: { global: true, projects: [] }, realExecutionEnabled: false }, approvals: [] });
    const reply = await app.post('/api/approvals/step-up', { password: TEST_ADMIN_PASSWORD }, cookie);
    expect(reply.status).toBe(503);
    expect(reply.json().error.code).toBe('approvals_unavailable');
    expect((await app.get('/api/approvals/history', cookie)).status).toBe(503);
    // O restante do ACC continua funcionando.
    expect((await app.get('/api/projects', cookie)).status).toBe(200);
  });
});

describe('segurança e governança (grupos E/F)', () => {
  it('senha, prova, cookie e chave nunca aparecem em logs, auditoria ou respostas de erro', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const proofReply = await app.proof(cookie);
    const proofId = proofReply.json().proofId as string;
    const ok = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId }, cookie);
    const reused = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: pd(request), proofId }, cookie);
    const wrong = await app.proof(cookie, 'senha-errada-canaria');
    const everything = [app.logLines.join('\n'), await app.auditFile(), ok.body, reused.body, wrong.body].join('\n');
    for (const secret of [TEST_ADMIN_PASSWORD, 'senha-errada-canaria', proofId, cookie.split('=')[1]]) expect(everything).not.toContain(secret);
    // Erros só com código e mensagem fixa: nada de código interno do núcleo nem caminhos.
    expect(reused.json()).toEqual({ error: { code: 'confirmation_required', message: expect.any(String) } });
    expect(everything).not.toContain(app.root);
    expect(everything).not.toMatch(/step_up_|already_decided|mac_invalid/);
  });

  it('nenhuma rota executa, admite ou libera algo; aprovar não torna nada disponível', async () => {
    const app = await startApp();
    const cookie = await app.login();
    expect(REAL_EXECUTION_ENABLED).toBe(false);
    for (const path of ['/api/approvals/killswitch/release', '/api/approvals/barrier', '/api/approvals/execute', '/api/approvals/recover']) {
      const reply = await app.post(path, { proofId: await app.proofId(cookie) }, cookie);
      expect([404, 405]).toContain(reply.status);
    }
    const request = await app.requestApproval();
    await app.decide(cookie, request.id, 'approve');
    // A política da #020 continua: sandbox.execute indisponível para o agente, aprovado ou não.
    const project = (await app.get(`/api/projects/${app.project.id}/policy`, cookie)).json();
    const agent = project.subjects.find((s: { subject: { id: string } }) => s.subject.id === 'claude-code');
    expect(agent.evaluations.find((e: { action: string }) => e.action === 'sandbox.execute').decision).not.toBe('ALLOW');
    expect((await app.get('/api/approvals', cookie)).json().subsystem.realExecutionEnabled).toBe(false);
  });
});

describe('R1 — apresentação verificável dos parâmetros (HTTP)', () => {
  it('detalhe traz os parâmetros exatos conferidos pelo servidor; o navegador reproduz os dois resumos', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const shown = await app.detail(cookie, request.id);
    expect(shown).toMatchObject({ presentable: true, presentationIssue: null, presentation: { kind: 'sandbox', params: sandboxParams(1) } });
    const check = checkPresentation({ binding: shown.binding, bindingDigest: approvalBindingDigest(shown.binding), requestedBy: shown.requestedBy, presentation: shown.presentation });
    expect(check).toMatchObject({ ok: true, digest: shown.presentationDigest });
    expect(shown.presentationDigest).toBe(pd(request));
  });

  it('aprovar sem o resumo da apresentação → 400; com resumo de outros parâmetros → 409, nada aprovado', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval();
    const missing = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, proofId: await app.proofId(cookie) }, cookie);
    expect(missing.status).toBe(400);
    const other = approvalPresentationDigest(request.bindingDigest, { kind: 'sandbox', params: sandboxParams(2) } as ApprovalPresentation);
    for (const presentationDigest of [other, request.bindingDigest]) {
      const reply = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest, proofId: await app.proofId(cookie) }, cookie);
      expect(reply.status).toBe(409);
      expect(reply.json().error.code).toBe('approval_presentation_invalid');
    }
    expect(app.svc().get('admin', request.id)!.state).toBe('pending');
  });

  it('pedido sem parâmetros apresentados: exibido como não conferível, aprovar 409, rejeitar 200', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.svc().request({ ownerId: 'admin', requestedBy: 'sandbox', binding: app.agentBinding() });
    const shown = await app.detail(cookie, request.id);
    expect(shown).toMatchObject({ presentable: false, presentation: null, presentationDigest: null, presentationIssue: 'presentation_missing' });
    // O cliente tenta "adivinhar" os parâmetros e calcular um resumo coincidente: continua recusado.
    const guessed = approvalPresentationDigest(request.bindingDigest, { kind: 'sandbox', params: sandboxParams(1) } as ApprovalPresentation);
    const approve = await app.post(`/api/approvals/${request.id}/approve`, { bindingDigest: request.bindingDigest, presentationDigest: guessed, proofId: await app.proofId(cookie) }, cookie);
    expect(approve.status).toBe(409);
    expect(approve.json().error.code).toBe('approval_presentation_invalid');
    expect(app.svc().get('admin', request.id)!.state).toBe('pending');
    const reject = await app.decide(cookie, request.id, 'reject');
    expect(reject.status).toBe(200);
    expect(reject.json().approval.state).toBe('rejected');
  });

  it('os valores dos parâmetros não vão para logs nem para a auditoria', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const request = await app.requestApproval(app.agentBinding({ paramsDigest: paramsDigestOf('sandbox', sandboxParams(2)) }));
    expect((await app.decide(cookie, request.id, 'approve')).status).toBe(200);
    const recorded = [app.logLines.join('\n'), await app.auditFile()].join('\n');
    for (const value of [sandboxParams(2).requestId, 'registry.npmjs.org', 'acc#11']) expect(recorded).not.toContain(value);
  });
});
