// @vitest-environment node
/**
 * Issue #020: política de autonomia aplicada no servidor HTTP real — avaliação antes de cada ação,
 * matriz somente leitura, isolamento, negação auditada e ausência de rotas de alteração da main.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent, PolicyMatrixResponse } from '../../shared/contracts.ts';
import { createAuditSequence, openAuditLog } from '../audit/auditLog.ts';
import { createFineGrainedTokenProvider } from '../auth/credentials.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { createConsoleLogger } from '../logger.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { PolicyValidationError, type Policy } from '../policy/engine.ts';
import { openProjectStore, STORE_FORMAT } from '../projects/projectStore.ts';
import type { SnapshotService } from '../snapshotService.ts';
import { openTaskStore } from '../tasks/taskStore.ts';
import { createTestAuth, sessionCookieFor } from '../test/authFixtures.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const REPO = ALLOWED_REPOSITORIES[0];
const MINE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const THEIRS = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

let servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const project = (id: string, ownerId: string) => ({
  id, ownerId, name: 'P', description: '', objective: '', status: 'active', repositories: [REPO],
  createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
});

async function startApp(policy?: Policy) {
  const dir = await mkdtemp(join(tmpdir(), 'acc-http-policy-'));
  dirs.push(dir);
  await writeFile(join(dir, 'projects.json'), JSON.stringify({ format: STORE_FORMAT, version: 1, projects: [project(MINE, 'admin'), project(THEIRS, 'user-b')], activeProjects: [] }));
  const sequence = createAuditSequence();
  const auth = await createTestAuth();
  const projects = await openProjectStore({ filePath: join(dir, 'projects.json'), allowedRepositories: ALLOWED_REPOSITORIES, sequence });
  const tasks = await openTaskStore({ filePath: join(dir, 'tasks.json'), sequence });
  const audit = await openAuditLog({ filePath: join(dir, 'audit.json'), sequence });
  const snapshots: SnapshotService = { getSnapshot: vi.fn(async () => ({ snapshot: {} as never, freshness: { stale: false, staleReason: null } })) };
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: { port, allowedRepositories: ALLOWED_REPOSITORIES, allowedOrigins: [ORIGIN], credentials: createFineGrainedTokenProvider(CANARY_TOKEN), rateLimitPerMinute: 10_000 },
    snapshots, auth, projects, tasks, audit, policy,
    logger: createConsoleLogger(() => {}),
  });
  server.on('request', (req, res) => void handler(req, res));
  const cookie = await sessionCookieFor(auth);
  function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return new Promise<{ status: number; headers: Record<string, unknown>; json: () => any }>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const req = request({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: () => JSON.parse(body) }));
      });
      req.on('error', reject);
      req.end(init.body);
    });
  }
  const get = (path: string) => call(path, { headers: { cookie } });
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const events = async (): Promise<AuditEvent[]> => (await get('/api/audit?limit=200')).json().events;
  return { call, get, post, events, cookie, dir, snapshots };
}

const decisionOf = (matrix: PolicyMatrixResponse, subjectId: string, action: string) =>
  matrix.subjects.find((s) => s.subject.id === subjectId)!.evaluations.find((e) => e.action === action)!;

describe('matriz de políticas do projeto', () => {
  it('mostra decisões da pessoa e de cada agente, com motivo e risco', async () => {
    const app = await startApp();
    const res = await app.get(`/api/projects/${MINE}/policy`);
    expect(res.status).toBe(200);
    const matrix: PolicyMatrixResponse = res.json();
    expect(matrix.policyVersion).toBe(DEFAULT_POLICY.version);
    expect(matrix.subjects.map((s) => `${s.subject.kind}:${s.subject.id}`)).toEqual([
      'human:admin', 'agent:chatgpt', 'agent:claude-code', 'agent:gemini', 'agent:nemotron',
    ]);
    expect(decisionOf(matrix, 'admin', 'task.assign')).toMatchObject({ decision: 'ALLOW', risk: 'medium' });
    expect(decisionOf(matrix, 'admin', 'repo.push_main')).toMatchObject({ decision: 'DENY', reason: 'main_is_protected' });
    expect(decisionOf(matrix, 'admin', 'repo.merge')).toMatchObject({ decision: 'UNAVAILABLE', requiresApproval: true });
    // Sem tarefa atribuída, agente não acessa nem para ler.
    expect(decisionOf(matrix, 'claude-code', 'task.read')).toMatchObject({ decision: 'DENY', reason: 'agent_not_assigned' });
    expect(decisionOf(matrix, 'claude-code', 'permissions.change')).toMatchObject({ decision: 'DENY', reason: 'agent_cannot_change_permissions' });
  });

  it('atribuir tarefa a agente continua permitido e dá acesso de LEITURA, nunca execução', async () => {
    const app = await startApp();
    const task = await app.post(`/api/projects/${MINE}/tasks`, { title: 'T', assignee: { kind: 'agent', agentId: 'claude-code' } });
    expect(task.status).toBe(201);
    expect(task.json().status).toBe('pending');
    const matrix: PolicyMatrixResponse = (await app.get(`/api/projects/${MINE}/policy`)).json();
    expect(matrix.subjects.find((s) => s.subject.id === 'claude-code')!.assigned).toBe(true);
    expect(decisionOf(matrix, 'claude-code', 'task.read').decision).toBe('ALLOW');
    expect(decisionOf(matrix, 'claude-code', 'task.status_change').decision).toBe('REQUIRE_APPROVAL');
    expect(decisionOf(matrix, 'claude-code', 'sandbox.execute')).toMatchObject({ decision: 'UNAVAILABLE', requiresApproval: true });
    expect(decisionOf(matrix, 'claude-code', 'repo.merge').decision).not.toBe('ALLOW');
    expect(decisionOf(matrix, 'gemini', 'task.read').decision).toBe('DENY');
    // Nenhum evento de execução é registrado.
    expect((await app.events()).some((e) => e.actor.kind === 'agent')).toBe(false);
  });

  it('projeto de outro dono: 404; sem sessão: 401; consulta com parâmetros (ex.: escolher sujeito): 400', async () => {
    const app = await startApp();
    expect((await app.get(`/api/projects/${THEIRS}/policy`)).status).toBe(404);
    expect((await app.call(`/api/projects/${MINE}/policy`)).status).toBe(401);
    expect((await app.get(`/api/projects/${MINE}/policy?subject=agent:claude-code`)).status).toBe(400);
    expect((await app.get(`/api/projects/abc/policy`)).status).toBe(404);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s na política: 405 (não há edição pela API)', async (method) => {
    const app = await startApp();
    const res = await app.call(`/api/projects/${MINE}/policy`, {
      method,
      headers: { cookie: app.cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ rules: [{ id: 'X', subject: 'agent:*', categories: ['critical'], effect: 'allow', maxRisk: 'high' }] }),
    });
    expect(res.status).toBe(405);
  });

  it('não existe rota para merge, push na main, deploy ou permissões', async () => {
    const app = await startApp();
    for (const path of [`/api/repos/${REPO}/merge`, `/api/repos/${REPO}/git/refs/heads/main`, '/api/deploy', '/api/permissions', `/api/projects/${MINE}/merge`]) {
      const res = await app.post(path, {});
      expect([404, 405]).toContain(res.status);
    }
  });
});

describe('aplicação da política antes de cada ação', () => {
  /** Política restritiva de teste: a pessoa só observa; criar exige aprovação. */
  const readOnly: Policy = {
    version: 'teste-somente-leitura',
    rules: [
      { id: 'T1-observar', subject: 'human:owner', categories: ['observe'], effect: 'allow', maxRisk: 'low' },
      { id: 'T2-criar-com-aprovacao', subject: 'human:owner', actions: ['task.create'], effect: 'require_approval', maxRisk: 'medium' },
    ],
  };

  it('ação sem regra: 403 policy_denied, nada gravado, decisão auditada', async () => {
    const app = await startApp(readOnly);
    const before = await readFile(join(app.dir, 'projects.json'), 'utf8');
    const res = await app.post('/api/projects', { name: 'Bloqueado' });
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe('policy_denied');
    expect(await readFile(join(app.dir, 'projects.json'), 'utf8')).toBe(before);
    const [last] = await app.events();
    expect(last).toMatchObject({
      action: 'policy.decision',
      outcome: 'blocked',
      actor: { kind: 'human', id: 'admin' },
      context: { policyAction: 'project.create', decision: 'DENY', reason: 'no_matching_rule', risk: 'medium', rule: null },
    });
  });

  it('ação que exige aprovação sem aprovação: 403 approval_required, auditada com a regra', async () => {
    const app = await startApp(readOnly);
    const res = await app.post(`/api/projects/${MINE}/tasks`, { title: 'x' });
    expect(res.status).toBe(403);
    expect(res.json().error.code).toBe('approval_required');
    const [last] = await app.events();
    expect(last).toMatchObject({ action: 'policy.decision', projectId: MINE, context: { decision: 'REQUIRE_APPROVAL', rule: 'T2-criar-com-aprovacao' } });
    expect((await app.get(`/api/projects/${MINE}/tasks`)).json().tasks).toEqual([]);
  });

  it('leitura permitida continua funcionando; atribuição sob política sem regra para atribuir é negada', async () => {
    const app = await startApp({
      version: 'sem-atribuicao',
      rules: [{ id: 'T', subject: 'human:owner', categories: ['observe'], actions: ['task.create', 'task.update'], effect: 'allow', maxRisk: 'medium' }],
    });
    expect((await app.get(`/api/projects/${MINE}/tasks`)).status).toBe(200);
    expect((await app.post(`/api/projects/${MINE}/tasks`, { title: 'ok' })).status).toBe(201);
    const res = await app.post(`/api/projects/${MINE}/tasks`, { title: 'x', assignee: { kind: 'agent', agentId: 'gemini' } });
    expect(res.status).toBe(403);
    expect((await app.events())[0].context).toMatchObject({ policyAction: 'task.assign', decision: 'DENY' });
  });

  it('política padrão: o fluxo do MVP continua igual', async () => {
    const app = await startApp();
    expect((await app.post('/api/projects', { name: 'Novo' })).status).toBe(201);
    const t = (await app.post(`/api/projects/${MINE}/tasks`, { title: 'T' })).json();
    expect((await app.post(`/api/projects/${MINE}/tasks/${t.id}`, { status: 'in_progress', assignee: { kind: 'human', userId: 'admin' } })).status).toBe(200);
    expect((await app.get('/api/audit')).status).toBe(200);
    expect((await app.get(`/api/projects/${MINE}/repositories/${REPO}/snapshot`)).status).toBe(200);
  });

  it('política inválida (crítica liberada) impede criar o servidor', async () => {
    await expect(
      startApp({ version: 'x', rules: [{ id: 'X', subject: 'human:owner', categories: ['critical'], effect: 'allow', maxRisk: 'high' }] }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });
});
