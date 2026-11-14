// @vitest-environment node
/**
 * Issue #005: rotas de tarefas no servidor HTTP real — autenticação, CSRF, isolamento entre
 * projetos/donos, validação, regras de status e persistência após reiniciar.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFineGrainedTokenProvider } from '../auth/credentials.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { createConsoleLogger } from '../logger.ts';
import { openProjectStore, STORE_FORMAT } from '../projects/projectStore.ts';
import type { SnapshotService } from '../snapshotService.ts';
import { openTaskStore } from '../tasks/taskStore.ts';
import { createTestAuth, sessionCookieFor, TEST_ADMIN_EMAIL } from '../test/authFixtures.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const REPO = ALLOWED_REPOSITORIES[0];
const MY_PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MY_OTHER_PROJECT = '2c5ea4c0-4067-4e6c-8e0b-1b2c3d4e5f60';
const THEIR_PROJECT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

let servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Reply {
  status: number;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const project = (id: string, ownerId: string, repositories: string[] = []) => ({
  id, ownerId, name: `Projeto ${id.slice(0, 4)}`, description: '', objective: '', status: 'active', repositories,
  createdAt: '2026-11-13T10:00:00.000Z', updatedAt: '2026-11-13T10:00:00.000Z',
});

async function dataDir() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-http-tasks-'));
  dirs.push(dir);
  await writeFile(
    join(dir, 'projects.json'),
    JSON.stringify({
      format: STORE_FORMAT,
      version: 1, // formato v1 (Issue #004): exercita a migração para v2
      projects: [project(MY_PROJECT, 'admin', [REPO]), project(MY_OTHER_PROJECT, 'admin'), project(THEIR_PROJECT, 'user-b', [REPO])],
      activeProjects: [],
    }),
  );
  return dir;
}

async function startApp(dir?: string) {
  const directory = dir ?? (await dataDir());
  const logLines: string[] = [];
  const auth = await createTestAuth();
  const projects = await openProjectStore({ filePath: join(directory, 'projects.json'), allowedRepositories: ALLOWED_REPOSITORIES });
  const tasks = await openTaskStore({ filePath: join(directory, 'tasks.json') });
  const snapshots: SnapshotService = { getSnapshot: vi.fn() };
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: {
      port,
      allowedRepositories: ALLOWED_REPOSITORIES,
      allowedOrigins: [ORIGIN],
      credentials: createFineGrainedTokenProvider(CANARY_TOKEN),
      rateLimitPerMinute: 10_000,
    },
    snapshots,
    auth,
    projects,
    tasks,
    logger: createConsoleLogger((line) => logLines.push(line)),
  });
  server.on('request', (req, res) => void handler(req, res));
  const cookie = await sessionCookieFor(auth);

  function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body, json: () => JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }
  const get = (path: string) => call(path, { headers: { cookie } });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { call, get, post, cookie, dir: directory, logLines, snapshots };
}

const tasksOf = (projectId: string) => `/api/projects/${projectId}/tasks`;

describe('tarefas: CRUD autenticado', () => {
  it('cria, lista, edita e mantém tudo após reiniciar o servidor', async () => {
    const app = await startApp();
    const list = await app.get(tasksOf(MY_PROJECT));
    expect(list.json()).toEqual({
      tasks: [],
      assignableUsers: [{ userId: 'admin', label: TEST_ADMIN_EMAIL }],
      agents: ['chatgpt', 'claude-code', 'gemini', 'nemotron'],
    });

    const created = await app.post(tasksOf(MY_PROJECT), {
      title: 'Implementar #005',
      priority: 'critical',
      assignee: { kind: 'agent', agentId: 'claude-code' },
      references: [{ kind: 'issue', repository: REPO, number: 5 }],
    });
    expect(created.status).toBe(201);
    const task = created.json();
    expect(task).toMatchObject({ projectId: MY_PROJECT, status: 'pending', origin: 'manual', completion: null });

    const started = await app.post(`${tasksOf(MY_PROJECT)}/${task.id}`, { status: 'in_progress' });
    expect(started.json()).toMatchObject({ status: 'in_progress' });
    expect((await app.get(`${tasksOf(MY_PROJECT)}/${task.id}`)).json().history.map((h: { action: string }) => h.action)).toEqual([
      'created',
      'status_changed',
    ]);

    // Novo processo lendo os mesmos arquivos.
    const restarted = await startApp(app.dir);
    const after = (await restarted.get(tasksOf(MY_PROJECT))).json().tasks;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: task.id, status: 'in_progress', priority: 'critical' });
  });

  it.each([
    ['GET', `/api/projects/${MY_PROJECT}/tasks`],
    ['POST', `/api/projects/${MY_PROJECT}/tasks`],
    ['GET', `/api/projects/${MY_PROJECT}/tasks/6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b`],
    ['POST', `/api/projects/${MY_PROJECT}/tasks/6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b`],
  ])('%s %s sem sessão: 401 e nada gravado', async (method, path) => {
    const app = await startApp();
    const res = await app.call(path, {
      method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: method === 'POST' ? '{"title":"x"}' : undefined,
    });
    expect(res.status).toBe(401);
    await expect(readFile(join(app.dir, 'tasks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('tarefas: CSRF, métodos e limites', () => {
  it.each([
    ['sem Origin', { 'content-type': 'application/json' }, 403],
    ['Origin de outro site', { origin: 'https://evil.example', 'content-type': 'application/json' }, 403],
    ['Sec-Fetch-Site same-site', { origin: ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 403],
    ['formulário', { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 415],
  ])('POST %s recusado (%s) mesmo com cookie', async (_case, headers, status) => {
    const app = await startApp();
    const res = await app.call(tasksOf(MY_PROJECT), { method: 'POST', headers: { cookie: app.cookie, ...headers }, body: '{"title":"forjada"}' });
    expect(res.status).toBe(status);
    expect((await app.get(tasksOf(MY_PROJECT))).json().tasks).toEqual([]);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s não existe (405)', async (method) => {
    const app = await startApp();
    const res = await app.call(tasksOf(MY_PROJECT), { method, headers: { cookie: app.cookie, origin: ORIGIN } });
    expect(res.status).toBe(405);
  });

  it('corpo acima de 16 KiB: 413; campos do servidor vindos do cliente: 400', async () => {
    const app = await startApp();
    expect((await app.post(tasksOf(MY_PROJECT), { title: 'x', description: 'y'.repeat(17 * 1024) })).status).toBe(413);
    for (const body of [{ title: 'x', origin: 'agent' }, { title: 'x', completion: null }, { title: 'x', projectId: THEIR_PROJECT }]) {
      expect((await app.post(tasksOf(MY_PROJECT), body)).status).toBe(400);
    }
  });

  it('criar já concluída ou em andamento: 409', async () => {
    const app = await startApp();
    for (const status of ['done', 'in_progress']) {
      const res = await app.post(tasksOf(MY_PROJECT), { title: 'x', status });
      expect(res.status).toBe(409);
      expect(res.json().error.code).toBe('invalid_status_transition');
    }
  });
});

describe('tarefas: isolamento entre projetos e donos', () => {
  it('projeto de outro dono: 404 em listar, criar, ler e editar, sem gravar', async () => {
    const app = await startApp();
    for (const res of [await app.get(tasksOf(THEIR_PROJECT)), await app.post(tasksOf(THEIR_PROJECT), { title: 'invasão' })]) {
      expect(res.status).toBe(404);
    }
    await expect(readFile(join(app.dir, 'tasks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tarefa de um projeto não é acessível nem usada como dependência por outro projeto', async () => {
    const app = await startApp();
    const task = (await app.post(tasksOf(MY_PROJECT), { title: 'A' })).json();
    expect((await app.get(`${tasksOf(MY_OTHER_PROJECT)}/${task.id}`)).status).toBe(404);
    expect((await app.post(`${tasksOf(MY_OTHER_PROJECT)}/${task.id}`, { title: 'x' })).status).toBe(404);
    expect((await app.post(tasksOf(MY_OTHER_PROJECT), { title: 'B', dependsOn: [task.id] })).status).toBe(400);
    expect((await app.get(tasksOf(MY_OTHER_PROJECT))).json().tasks).toEqual([]);
  });

  it('referência só a repositório vinculado ao projeto (projeto sem GitHub: 422)', async () => {
    const app = await startApp();
    const res = await app.post(tasksOf(MY_OTHER_PROJECT), { title: 'x', references: [{ kind: 'pull_request', repository: REPO, number: 1 }] });
    expect(res.status).toBe(422);
    expect(res.json().error.code).toBe('repository_not_allowed');
    expect(app.snapshots.getSnapshot).not.toHaveBeenCalled();
  });

  it('responsável humano só pode ser o usuário da sessão', async () => {
    const app = await startApp();
    expect((await app.post(tasksOf(MY_PROJECT), { title: 'x', assignee: { kind: 'human', userId: 'user-b' } })).status).toBe(400);
    expect((await app.post(tasksOf(MY_PROJECT), { title: 'x', assignee: { kind: 'human', userId: 'admin' } })).status).toBe(201);
  });

  it('ids malformados: 404', async () => {
    const app = await startApp();
    for (const path of [`/api/projects/abc/tasks`, `${tasksOf(MY_PROJECT)}/abc`, `${tasksOf(MY_PROJECT)}/..`]) {
      expect((await app.get(path)).status).toBe(404);
    }
  });
});

describe('tarefas: regras pela API', () => {
  it('dependência circular 422; dependência pendente bloqueia início 409', async () => {
    const app = await startApp();
    const a = (await app.post(tasksOf(MY_PROJECT), { title: 'A' })).json();
    const b = (await app.post(tasksOf(MY_PROJECT), { title: 'B', dependsOn: [a.id] })).json();
    const cycle = await app.post(`${tasksOf(MY_PROJECT)}/${a.id}`, { dependsOn: [b.id] });
    expect(cycle.status).toBe(422);
    expect(cycle.json().error.code).toBe('dependency_cycle');
    const start = await app.post(`${tasksOf(MY_PROJECT)}/${b.id}`, { status: 'in_progress' });
    expect(start.status).toBe(409);
    expect(start.json().error.code).toBe('dependencies_unresolved');
  });

  it('conclusão de tarefa de agente exige evidência; a confirmação é da pessoa logada', async () => {
    const app = await startApp();
    const t = (await app.post(tasksOf(MY_PROJECT), { title: 'A', assignee: { kind: 'agent', agentId: 'gemini' } })).json();
    await app.post(`${tasksOf(MY_PROJECT)}/${t.id}`, { status: 'in_progress' });
    const noEvidence = await app.post(`${tasksOf(MY_PROJECT)}/${t.id}`, { status: 'done' });
    expect(noEvidence.status).toBe(422);
    expect(noEvidence.json().error.code).toBe('evidence_required');
    const done = await app.post(`${tasksOf(MY_PROJECT)}/${t.id}`, {
      status: 'done',
      references: [{ kind: 'branch', repository: REPO, name: 'feature/005-task-management' }],
    });
    expect(done.status).toBe(200);
    expect(done.json().completion).toEqual({ confirmedBy: 'admin', confirmedAt: expect.any(String) });
  });

  it('logs registram ids e eventos, nunca título ou descrição', async () => {
    const app = await startApp();
    await app.post(tasksOf(MY_PROJECT), { title: 'TITULO-PRIVADO', description: 'DESCRICAO-PRIVADA' });
    const logs = app.logLines.join('\n');
    expect(logs).toContain('task_created');
    expect(logs).not.toContain('TITULO-PRIVADO');
    expect(logs).not.toContain('DESCRICAO-PRIVADA');
    expect(logs).not.toContain(app.cookie.split('=')[1]);
  });
});
