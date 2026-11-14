// @vitest-environment node
/**
 * Issue #004: rotas de projetos no servidor HTTP real — autenticação, CSRF, validação, isolamento
 * entre projetos/donos, persistência e vínculo de repositórios sem consultas arbitrárias.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { createTestAuth, sessionCookieFor } from '../test/authFixtures.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const REPO = ALLOWED_REPOSITORIES[0];
const OTHER_OWNER_PROJECT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MISSING_PROJECT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Arquivo inicial com um projeto de OUTRO dono, para testar acesso cruzado. */
async function seededFile() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-http-projects-'));
  dirs.push(dir);
  const filePath = join(dir, 'projects.json');
  await mkdir(dir, { recursive: true });
  await writeFile(
    filePath,
    JSON.stringify({
      format: STORE_FORMAT,
      version: 1, // formato v1 (Issue #004): exercita a migração para v2
      projects: [
        {
          id: OTHER_OWNER_PROJECT,
          ownerId: 'user-b',
          name: 'Projeto de outro usuário',
          description: 'confidencial',
          objective: '',
          status: 'active',
          repositories: [REPO],
          createdAt: '2026-11-13T10:00:00.000Z',
          updatedAt: '2026-11-13T10:00:00.000Z',
        },
      ],
      activeProjects: [{ ownerId: 'user-b', projectId: OTHER_OWNER_PROJECT }],
    }),
  );
  return filePath;
}

async function startApp(options: { withProjects?: boolean } = {}) {
  const logLines: string[] = [];
  const auth = await createTestAuth();
  const filePath = await seededFile();
  const projects = options.withProjects === false ? null : await openProjectStore({ filePath, allowedRepositories: ALLOWED_REPOSITORIES });
  const snapshots: SnapshotService = {
    getSnapshot: vi.fn(async () => ({ snapshot: { ok: true } as never, freshness: { stale: false, staleReason: null } })),
  };
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: {
      port,
      allowedRepositories: ALLOWED_REPOSITORIES,
      allowedOrigins: [ORIGIN],
      credentials: createFineGrainedTokenProvider(CANARY_TOKEN),
      rateLimitPerMinute: 1000,
    },
    snapshots,
    auth,
    projects,
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
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }
  const get = (path: string, headers: Record<string, string> = { cookie }) => call(path, { headers });
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return call(path, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }
  return { call, get, post, cookie, filePath, snapshots, logLines };
}

describe('projetos: CRUD autenticado', () => {
  it('cria projeto sem GitHub, lista, edita, seleciona e persiste no arquivo', async () => {
    const { get, post, filePath } = await startApp();
    const empty = await get('/api/projects');
    expect(empty.status).toBe(200);
    // O projeto de outro dono não aparece.
    expect(empty.json()).toEqual({ projects: [], activeProjectId: null, linkableRepositories: [REPO] });

    const created = await post('/api/projects', { name: 'Pesquisa de mercado', objective: 'Validar a ideia' });
    expect(created.status).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ name: 'Pesquisa de mercado', objective: 'Validar a ideia', status: 'planning', repositories: [] });
    expect(project).not.toHaveProperty('ownerId');

    const edited = await post(`/api/projects/${project.id}`, { status: 'active', repositories: [REPO] });
    expect(edited.status).toBe(200);
    expect(edited.json()).toMatchObject({ status: 'active', repositories: [REPO], name: 'Pesquisa de mercado' });

    const selected = await post('/api/projects/active', { projectId: project.id });
    expect(selected.json()).toEqual({ activeProjectId: project.id });
    expect((await get(`/api/projects/${project.id}`)).json()).toMatchObject({ id: project.id, status: 'active' });

    const list = (await get('/api/projects')).json();
    expect(list.activeProjectId).toBe(project.id);
    expect(list.projects).toHaveLength(1);

    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    expect(onDisk.projects.map((p: { ownerId: string }) => p.ownerId).sort()).toEqual(['admin', 'user-b']);
    expect(onDisk.activeProjects).toContainEqual({ ownerId: 'admin', projectId: project.id });

    expect((await post('/api/projects/active', { projectId: null })).json()).toEqual({ activeProjectId: null });
  });

  it.each([
    ['GET', '/api/projects'],
    ['GET', `/api/projects/${MISSING_PROJECT}`],
    ['GET', `/api/projects/${MISSING_PROJECT}/repositories/${REPO}/snapshot`],
    ['POST', '/api/projects'],
    ['POST', `/api/projects/${MISSING_PROJECT}`],
    ['POST', '/api/projects/active'],
  ])('%s %s sem sessão: 401, sem ler o corpo nem tocar o arquivo', async (method, path) => {
    const { call, filePath } = await startApp();
    const before = await readFile(filePath, 'utf8');
    const res = await call(path, {
      method,
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ name: 'x', projectId: null }) : undefined,
    });
    expect(res.status).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
    expect(await readFile(filePath, 'utf8')).toBe(before);
  });

  it('cookie de sessão inválido também recebe 401', async () => {
    const { get } = await startApp();
    expect((await get('/api/projects', { cookie: `acc_session=${'A'.repeat(43)}` })).status).toBe(401);
  });
});

describe('projetos: CSRF e métodos', () => {
  it.each([
    ['sem Origin', { 'content-type': 'application/json' }, 403],
    ['Origin de outro site', { origin: 'https://evil.example', 'content-type': 'application/json' }, 403],
    ['Sec-Fetch-Site same-site (outra porta)', { origin: ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 403],
    ['formulário de outro site', { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 415],
    ['text/plain', { origin: ORIGIN, 'content-type': 'text/plain' }, 415],
  ])('POST %s é recusado (%s) mesmo com cookie válido', async (_case, headers, status) => {
    const { call, get, cookie } = await startApp();
    const res = await call('/api/projects', { method: 'POST', headers: { cookie, ...headers }, body: '{"name":"forjado"}' });
    expect(res.status).toBe(status);
    expect((await get('/api/projects')).json().projects).toEqual([]);
  });

  it('Sec-Fetch-Site cross-site é recusado antes de qualquer rota (403)', async () => {
    const { post } = await startApp();
    expect((await post('/api/projects', { name: 'x' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it.each(['PUT', 'PATCH', 'DELETE'])('%s não existe em rotas de projetos (405)', async (method) => {
    const { call, cookie } = await startApp();
    for (const path of ['/api/projects', `/api/projects/${MISSING_PROJECT}`, '/api/projects/active']) {
      const res = await call(path, { method, headers: { cookie, origin: ORIGIN } });
      expect(res.status).toBe(405);
    }
  });

  it('GET em /api/projects/active responde 405 com Allow: POST', async () => {
    const { get } = await startApp();
    const res = await get('/api/projects/active');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  it('corpo acima de 16 KiB: 413', async () => {
    const { post } = await startApp();
    const res = await post('/api/projects', { name: 'x', description: 'y'.repeat(17 * 1024) });
    expect(res.status).toBe(413);
  });

  it.each([
    ['JSON inválido', '{name:'],
    ['nome ausente', { description: 'x' }],
    ['campo desconhecido', { name: 'x', ownerId: 'user-b' }],
    ['estado inválido', { name: 'x', status: 'deleted' }],
  ])('validação: %s → 400', async (_case, body) => {
    const { post } = await startApp();
    expect((await post('/api/projects', body)).status).toBe(400);
  });

  it('query string em rotas de projetos: 400', async () => {
    const { get } = await startApp();
    expect((await get('/api/projects?owner=user-b')).status).toBe(400);
  });
});

describe('projetos: isolamento e repositórios', () => {
  it('projeto de outro dono é indistinguível de inexistente (404) em todas as operações', async () => {
    const { get, post, filePath, snapshots } = await startApp();
    const before = await readFile(filePath, 'utf8');
    for (const id of [OTHER_OWNER_PROJECT, MISSING_PROJECT]) {
      const responses = [
        await get(`/api/projects/${id}`),
        await post(`/api/projects/${id}`, { name: 'invadido' }),
        await post('/api/projects/active', { projectId: id }),
        await get(`/api/projects/${id}/repositories/${REPO}/snapshot`),
      ];
      for (const res of responses) {
        expect(res.status).toBe(404);
        expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Recurso não encontrado ou não autorizado neste servidor.' } });
        expect(res.body).not.toContain('confidencial');
      }
    }
    expect(await readFile(filePath, 'utf8')).toBe(before);
    expect(snapshots.getSnapshot).not.toHaveBeenCalled();
  });

  it('id malformado ou com travessia de caminho: 404', async () => {
    const { get } = await startApp();
    for (const id of ['abc', '..', '%2e%2e', OTHER_OWNER_PROJECT.toUpperCase()]) {
      expect((await get(`/api/projects/${id}`)).status).toBe(404);
    }
  });

  it('vincular repositório fora da allowlist: 422 sem consultar o GitHub', async () => {
    const { post, snapshots } = await startApp();
    const res = await post('/api/projects', { name: 'x', repositories: ['octocat/hello-world'] });
    expect(res.status).toBe(422);
    expect(res.json().error.code).toBe('repository_not_allowed');
    expect(snapshots.getSnapshot).not.toHaveBeenCalled();
  });

  it('snapshot só de repositório vinculado ao próprio projeto', async () => {
    const { get, post, snapshots } = await startApp();
    const linked = (await post('/api/projects', { name: 'Com GitHub', repositories: [REPO] })).json();
    const unlinked = (await post('/api/projects', { name: 'Sem GitHub' })).json();

    const ok = await get(`/api/projects/${linked.id}/repositories/${REPO}/snapshot?refresh=1`);
    expect(ok.status).toBe(200);
    expect(snapshots.getSnapshot).toHaveBeenCalledWith(REPO, { refresh: true });

    // Mesmo repositório autorizado, mas não vinculado a este projeto.
    expect((await get(`/api/projects/${unlinked.id}/repositories/${REPO}/snapshot`)).status).toBe(404);
    // Repositório fora da allowlist, mesmo pelo projeto vinculado.
    expect((await get(`/api/projects/${linked.id}/repositories/octocat/hello-world/snapshot`)).status).toBe(404);
    expect((await get(`/api/projects/${linked.id}/repositories/${REPO}/snapshot?refresh=2`)).status).toBe(400);
    expect(snapshots.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('desvincular remove o acesso ao snapshot pelo projeto', async () => {
    const { get, post } = await startApp();
    const project = (await post('/api/projects', { name: 'x', repositories: [REPO] })).json();
    await post(`/api/projects/${project.id}`, { repositories: [] });
    expect((await get(`/api/projects/${project.id}/repositories/${REPO}/snapshot`)).status).toBe(404);
  });
});

describe('projetos: logs e indisponibilidade', () => {
  it('logs registram só evento e id, nunca nome, descrição, cookie ou token', async () => {
    const { post, logLines, cookie } = await startApp();
    await post('/api/projects', { name: 'NOME-SECRETO-DO-PROJETO', description: 'DESCRICAO-PRIVADA' });
    const logs = logLines.join('\n');
    expect(logs).toContain('project_created');
    expect(logs).not.toContain('NOME-SECRETO-DO-PROJETO');
    expect(logs).not.toContain('DESCRICAO-PRIVADA');
    expect(logs).not.toContain(cookie.split('=')[1]);
    expect(logs).not.toContain(CANARY_TOKEN);
  });

  it('sem armazenamento configurado: 500 genérico', async () => {
    const { get } = await startApp({ withProjects: false });
    const res = await get('/api/projects');
    expect(res.status).toBe(500);
    expect(res.json().error.code).toBe('internal');
  });
});
