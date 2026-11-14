// @vitest-environment node
/**
 * Issue #006: auditoria de ponta a ponta no servidor HTTP real — eventos registrados, autor da
 * sessão, imutabilidade pela API, isolamento, ausência de segredos, persistência, consistência
 * entre alteração e evento quando a gravação falha, filtros e limites.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../../shared/contracts.ts';
import { createAuditSequence, openAuditLog } from '../audit/auditLog.ts';
import { createFineGrainedTokenProvider } from '../auth/credentials.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { createConsoleLogger } from '../logger.ts';
import { openProjectStore, STORE_FORMAT } from '../projects/projectStore.ts';
import type { SnapshotService } from '../snapshotService.ts';
import { writeFileAtomic } from '../storage/jsonFile.ts';
import { openTaskStore } from '../tasks/taskStore.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const REPO = ALLOWED_REPOSITORIES[0];
const MINE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MINE_TOO = '2c5ea4c0-4067-4e6c-8e0b-1b2c3d4e5f60';
const THEIRS = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

let servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const project = (id: string, ownerId: string) => ({
  id, ownerId, name: `P-${id.slice(0, 4)}`, description: '', objective: '', status: 'active', repositories: [REPO],
  createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
});

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-http-audit-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'projects.json'),
    JSON.stringify({
      format: STORE_FORMAT,
      version: 1,
      projects: [project(MINE, 'admin'), project(MINE_TOO, 'admin'), project(THEIRS, 'user-b')],
      activeProjects: [],
    }),
  );
  return dir;
}

type Failing = { projects?: boolean; tasks?: boolean; audit?: boolean };

async function startApp(options: { dir?: string; failing?: Failing } = {}) {
  const dir = options.dir ?? (await dataDir());
  const failing: Failing = options.failing ?? {};
  const writer = (key: keyof Failing) => async (path: string, content: string) => {
    if (failing[key]) throw new Error('disco cheio');
    await writeFileAtomic(path, content);
  };
  const logLines: string[] = [];
  const auth = await createTestAuth();
  const sequence = createAuditSequence();
  const projects = await openProjectStore({ filePath: join(dir, 'projects.json'), allowedRepositories: ALLOWED_REPOSITORIES, sequence, writeFile: writer('projects') });
  const tasks = await openTaskStore({ filePath: join(dir, 'tasks.json'), sequence, writeFile: writer('tasks') });
  const audit = await openAuditLog({ filePath: join(dir, 'audit.json'), sequence, writeFile: writer('audit') });
  const snapshots: SnapshotService = { getSnapshot: vi.fn() };
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: { port, allowedRepositories: ALLOWED_REPOSITORIES, allowedOrigins: [ORIGIN], credentials: createFineGrainedTokenProvider(CANARY_TOKEN), rateLimitPerMinute: 10_000 },
    snapshots, auth, projects, tasks, audit,
    logger: createConsoleLogger((line) => logLines.push(line)),
  });
  server.on('request', (req, res) => void handler(req, res));

  function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }
  const jsonHeaders = { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  async function login(password = TEST_ADMIN_PASSWORD) {
    const res = await call('/api/auth/login', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ email: TEST_ADMIN_EMAIL, password }) });
    const cookie = String(([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];
    return { res, cookie };
  }
  const { cookie } = await login();
  const get = (path: string, c = cookie) => call(path, { headers: { cookie: c } });
  const post = (path: string, body: unknown, c = cookie) => call(path, { method: 'POST', headers: { ...jsonHeaders, cookie: c }, body: JSON.stringify(body) });
  const events = async (query = ''): Promise<AuditEvent[]> => (await get(`/api/audit${query}`)).json().events;
  return { call, get, post, login, events, cookie, dir, failing, logLines };
}

describe('auditoria: eventos registrados', () => {
  it('projetos, seleção, tarefas, status, responsável e confirmação de conclusão, com autor da sessão', async () => {
    const app = await startApp();
    const created = (await app.post('/api/projects', { name: 'Auditado' })).json();
    await app.post(`/api/projects/${created.id}`, { status: 'paused', name: 'Renomeado' });
    await app.post('/api/projects/active', { projectId: MINE });
    const task = (await app.post(`/api/projects/${MINE}/tasks`, { title: 'T' })).json();
    await app.post(`/api/projects/${MINE}/tasks/${task.id}`, { assignee: { kind: 'agent', agentId: 'claude-code' } });
    await app.post(`/api/projects/${MINE}/tasks/${task.id}`, { status: 'in_progress' });
    await app.post(`/api/projects/${MINE}/tasks/${task.id}`, {
      status: 'done',
      references: [{ kind: 'pull_request', repository: REPO, number: 39 }],
    });

    const list = await app.events();
    const actions = list.map((e) => e.action).reverse();
    expect(actions).toEqual([
      'auth.login',
      'project.created',
      'project.updated',
      'project.activated',
      'task.created',
      'task.assignee_changed',
      'task.status_changed',
      'task.status_changed',
      'task.completion_confirmed',
      'task.updated',
    ]);
    // Ordem determinística por seq estritamente decrescente e ids únicos.
    const seqs = list.map((e) => e.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    expect(new Set(list.map((e) => e.id)).size).toBe(list.length);
    // Todo evento de alteração é da pessoa da sessão; nenhum é atribuído a agente.
    for (const e of list) expect(e.actor).toEqual({ kind: 'human', id: 'admin' });
    expect(list.some((e) => e.actor.kind === 'agent')).toBe(false);

    const byAction = (action: string) => list.find((e) => e.action === action)!;
    expect(byAction('project.updated')).toMatchObject({ projectId: created.id, outcome: 'success', context: { fields: ['name', 'status'], from: 'planning', to: 'paused' } });
    expect(byAction('task.assignee_changed').context).toEqual({ from: null, to: 'agent:claude-code' });
    expect(byAction('task.completion_confirmed')).toMatchObject({ resource: { type: 'task', id: task.id }, context: { evidence: ['pull_request'], to: 'agent:claude-code' } });
  });

  it('login recusado e bloqueado, logout e acessos negados, sem dados sensíveis', async () => {
    const app = await startApp();
    await app.login('senha-errada-CANARIA-999');
    await app.call('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', cookie: app.cookie }, body: '{"name":"csrf"}' });
    await app.call('/api/projects', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"name":"anon"}' });
    await app.get(`/api/projects/${THEIRS}`);
    await app.post(`/api/projects/${THEIRS}/tasks`, { title: 'invasão' });

    const list = await app.events();
    const rejected = list.find((e) => e.action === 'auth.login_rejected')!;
    expect(rejected).toMatchObject({ actor: { kind: 'system', id: 'anonymous' }, outcome: 'failure', context: { reason: 'invalid_credentials' } });
    const denied = list.filter((e) => e.action === 'access.denied');
    expect(denied.map((e) => e.context.reason).sort()).toEqual(['forbidden_origin', 'not_found', 'not_found', 'unauthenticated']);
    // O projeto de outro dono nunca aparece como projeto do evento.
    expect(denied.every((e) => e.projectId === null)).toBe(true);
    expect(denied.find((e) => e.context.reason === 'unauthenticated')!.actor).toEqual({ kind: 'system', id: 'anonymous' });

    const logout = await app.post('/api/auth/logout', {});
    expect(logout.status).toBe(200);
    const { cookie } = await app.login();
    const all = (await app.get('/api/audit?limit=200', cookie)).json().events as AuditEvent[];
    expect(all.find((e) => e.action === 'auth.logout')).toMatchObject({ actor: { kind: 'human', id: 'admin' }, context: { hadSession: true } });

    // Nada de senha, hash, cookie, token, e-mail ou corpo em nenhum arquivo ou resposta.
    const files = await Promise.all(['projects.json', 'tasks.json', 'audit.json'].map((f) => readFile(join(app.dir, f), 'utf8').catch(() => '')));
    const everything = files.join('\n') + JSON.stringify(all) + app.logLines.join('\n');
    for (const secret of [TEST_ADMIN_PASSWORD, 'senha-errada-CANARIA-999', await testPasswordHash(), app.cookie.split('=')[1], cookie.split('=')[1], CANARY_TOKEN, TEST_ADMIN_EMAIL, 'invasão', 'csrf']) {
      expect(everything).not.toContain(secret);
    }
  });

  it('login bloqueado pelo limite de tentativas: evento "blocked"', async () => {
    const app = await startApp();
    for (let i = 0; i < 6; i += 1) await app.login(`errada-${i}-123456`);
    const rejected = (await app.events('?action=auth.login_rejected&limit=200'));
    expect(rejected.some((e) => e.outcome === 'blocked' && e.context.reason === 'too_many_requests')).toBe(true);
  });

  it('escrita recusada por regra de negócio: evento "blocked" com o motivo, sem alterar dados', async () => {
    const app = await startApp();
    const task = (await app.post(`/api/projects/${MINE}/tasks`, { title: 'T', assignee: { kind: 'agent', agentId: 'gemini' } })).json();
    await app.post(`/api/projects/${MINE}/tasks/${task.id}`, { status: 'in_progress' });
    expect((await app.post(`/api/projects/${MINE}/tasks/${task.id}`, { status: 'done' })).status).toBe(422);
    const [last] = await app.events();
    expect(last).toMatchObject({ action: 'task.updated', outcome: 'blocked', projectId: MINE, resource: { type: 'task', id: task.id }, context: { reason: 'evidence_required' } });
    expect((await app.events('?action=task.completion_confirmed'))).toEqual([]);
  });
});

describe('auditoria: consistência com falhas de gravação', () => {
  it('falha ao gravar projetos: nada muda, nenhum evento de sucesso, evento de falha avulso', async () => {
    const app = await startApp();
    const before = await readFile(join(app.dir, 'projects.json'), 'utf8');
    app.failing.projects = true;
    const res = await app.post('/api/projects', { name: 'Não gravado' });
    expect(res.status).toBe(500);
    app.failing.projects = false;
    expect(await readFile(join(app.dir, 'projects.json'), 'utf8')).toBe(before);
    expect((await app.get('/api/projects')).json().projects.map((p: { name: string }) => p.name)).not.toContain('Não gravado');
    const list = await app.events('?action=project.created');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ outcome: 'failure', context: { reason: 'internal' } });
  });

  it('alteração e evento ficam no MESMO arquivo: após reiniciar, cada alteração tem o seu evento', async () => {
    const app = await startApp();
    const task = (await app.post(`/api/projects/${MINE}/tasks`, { title: 'T' })).json();
    await app.post(`/api/projects/${MINE}/tasks/${task.id}`, { status: 'planned' });
    const disk = JSON.parse(await readFile(join(app.dir, 'tasks.json'), 'utf8'));
    expect(disk.version).toBe(2);
    expect(disk.events.map((e: AuditEvent) => e.action)).toEqual(['task.created', 'task.status_changed']);
    expect(disk.tasks[0].status).toBe('planned');

    const restarted = await startApp({ dir: app.dir });
    const actions = (await restarted.events('?limit=200')).map((e) => e.action);
    expect(actions.filter((a) => a.startsWith('task.'))).toEqual(['task.status_changed', 'task.created']);
    // A sequência continua crescente depois do reinício.
    const seqs = (await restarted.events('?limit=200')).map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('falha ao gravar a auditoria no login: 503 e nenhuma sessão criada', async () => {
    const app = await startApp();
    app.failing.audit = true;
    const { res, cookie } = await app.login();
    expect(res.status).toBe(503);
    expect(res.json().error.code).toBe('audit_unavailable');
    expect(cookie).toBe('');
    // O cookie anterior também deixou de valer (login revoga todas as sessões).
    expect((await app.get('/api/projects')).status).toBe(401);
  });

  it('falha ao gravar a auditoria no logout: a sessão é encerrada e a resposta é erro, não sucesso', async () => {
    const app = await startApp();
    app.failing.audit = true;
    const res = await app.post('/api/auth/logout', {});
    expect(res.status).toBe(503);
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/);
    app.failing.audit = false;
    expect((await app.get('/api/projects')).status).toBe(401);
  });

  it('falha ao gravar evento de recusa: a resposta continua a recusa e o servidor registra o erro', async () => {
    const app = await startApp();
    app.failing.audit = true;
    const res = await app.get(`/api/projects/${THEIRS}`);
    expect(res.status).toBe(404);
    expect(app.logLines.join('\n')).toContain('audit_write_failed');
  });
});

describe('auditoria: API somente leitura, isolamento e filtros', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s em /api/audit: 405 e nenhum evento alterado', async (method) => {
    const app = await startApp();
    const before = await readFile(join(app.dir, 'audit.json'), 'utf8');
    const res = await app.call('/api/audit', { method, headers: { cookie: app.cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
    expect(await readFile(join(app.dir, 'audit.json'), 'utf8')).toBe(before);
  });

  it('sem sessão: 401', async () => {
    const app = await startApp();
    expect((await app.call('/api/audit')).status).toBe(401);
  });

  it('histórico de outro dono nunca aparece; filtro por projeto de outro dono: 404', async () => {
    const app = await startApp();
    const sequence = createAuditSequence();
    // Eventos do outro dono gravados diretamente no arquivo de projetos.
    const store = await openProjectStore({ filePath: join(app.dir, 'projects.json'), allowedRepositories: ALLOWED_REPOSITORIES, sequence });
    await store.update('user-b', THEIRS, { name: 'Alterado pelo outro' }, { kind: 'human', id: 'user-b' });
    const restarted = await startApp({ dir: app.dir });
    const list = await restarted.events('?limit=200');
    expect(list.some((e) => e.projectId === THEIRS)).toBe(false);
    expect(list.some((e) => e.actor.id === 'user-b')).toBe(false);
    expect((await restarted.get(`/api/audit?projectId=${THEIRS}`)).status).toBe(404);
  });

  it('filtros por projeto, ação e resultado; paginação com before/limit', async () => {
    const app = await startApp();
    await app.post(`/api/projects/${MINE}/tasks`, { title: 'A' });
    await app.post(`/api/projects/${MINE_TOO}/tasks`, { title: 'B' });
    await app.post(`/api/projects/${MINE_TOO}/tasks`, { title: 'C', status: 'done' });

    const mine = await app.events(`?projectId=${MINE}`);
    expect(mine.map((e) => e.action)).toEqual(['task.created']);
    const other = await app.events(`?projectId=${MINE_TOO}`);
    expect(other.map((e) => `${e.action}/${e.outcome}`)).toEqual(['task.created/blocked', 'task.created/success']);
    expect((await app.events('?outcome=blocked')).map((e) => e.context.reason)).toEqual(['invalid_status_transition']);
    expect((await app.events('?action=auth.login')).length).toBe(1);

    const page1 = (await app.get('/api/audit?limit=2')).json();
    expect(page1.events).toHaveLength(2);
    expect(page1.nextBefore).toBe(page1.events[1].seq);
    const page2 = (await app.get(`/api/audit?limit=2&before=${page1.nextBefore}`)).json();
    expect(page2.events[0].seq).toBeLessThan(page1.nextBefore);
    expect(page2.retention).toEqual({ droppedEvents: 0 });
  });

  it.each([
    'limit=0', 'limit=201', 'limit=abc', 'before=-1', 'action=project.deleted', 'outcome=ok', 'projectId=abc',
    'owner=user-b', 'limit=1&limit=2',
  ])('consulta inválida (%s): 400', async (query) => {
    const app = await startApp();
    expect((await app.get(`/api/audit?${query}`)).status).toBe(400);
  });
});
