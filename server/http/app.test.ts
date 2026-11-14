// @vitest-environment node
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFineGrainedTokenProvider, type CredentialProvider } from '../auth/credentials.ts';
import { createGhCliCredentialProvider } from '../auth/ghCli.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { IntegrationError } from '../github/errors.ts';
import { createConsoleLogger } from '../logger.ts';
import type { SnapshotService } from '../snapshotService.ts';
import { createTestAuth, sessionCookieFor } from '../test/authFixtures.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { createRequestHandler, type AppDeps } from './app.ts';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Options {
  withToken?: boolean;
  credentials?: CredentialProvider | null;
  snapshots?: SnapshotService | null;
  rateLimitPerMinute?: number;
}

async function startApp({ withToken = true, credentials, snapshots, rateLimitPerMinute = 100 }: Options = {}) {
  const auth = await createTestAuth();
  const sessionCookie = await sessionCookieFor(auth);
  const logLines: string[] = [];
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as AddressInfo).port;

  const deps: AppDeps = {
    config: {
      port,
      allowedRepositories: ALLOWED_REPOSITORIES,
      allowedOrigins: ['http://localhost:5173'],
      credentials: credentials !== undefined ? credentials : withToken ? createFineGrainedTokenProvider(CANARY_TOKEN) : null,
      rateLimitPerMinute,
    },
    snapshots: snapshots === undefined ? null : snapshots,
    auth,
    logger: createConsoleLogger((line) => logLines.push(line)),
  };
  const handler = createRequestHandler(deps);
  server.on('request', (req, res) => void handler(req, res));

  /** Por padrão envia a sessão do administrador; `anonymous: true` simula um visitante. */
  function call(path: string, init: { method?: string; headers?: Record<string, string>; anonymous?: boolean; body?: string } = {}) {
    const authHeaders: Record<string, string> = init.anonymous ? {} : { cookie: sessionCookie };
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...authHeaders, ...init.headers } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }

  return { call, logLines, port, auth, sessionCookie };
}

const SNAPSHOT_PATH = '/api/repos/Moreirapontocom-br/ai-command-center/snapshot';

function fakeSnapshots(impl: SnapshotService['getSnapshot']): SnapshotService {
  return { getSnapshot: vi.fn(impl) };
}

describe('servidor HTTP somente leitura', () => {
  it('/api/status informa se há credencial sem expor o token', async () => {
    const { call } = await startApp();
    const res = await call('/api/status');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      configured: true,
      authMode: 'fine-grained-token',
      repositories: ['Moreirapontocom-br/ai-command-center'],
    });
    expect(res.body).not.toContain(CANARY_TOKEN);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('/api/status sem credencial', async () => {
    const { call } = await startApp({ withToken: false });
    expect(JSON.parse((await call('/api/status')).body)).toMatchObject({ configured: false, authMode: 'none' });
  });

  it('/api/status informa o modo gh-cli sem executar o `gh` nem expor credenciais', async () => {
    const exec = vi.fn(() => Promise.resolve('gho_' + 'F'.repeat(36)));
    const { call } = await startApp({ credentials: createGhCliCredentialProvider({ exec, env: {} }) });
    const res = await call('/api/status');
    expect(JSON.parse(res.body)).toMatchObject({ configured: true, authMode: 'gh-cli' });
    expect(res.body).not.toContain('gho_');
    expect(exec).not.toHaveBeenCalled();
  });

  it('o motivo interno do erro vai só para o log; a resposta usa a mensagem genérica', async () => {
    const snapshots = fakeSnapshots(() => Promise.reject(new IntegrationError('forbidden', { reason: 'graphql_not_found' })));
    const { call, logLines } = await startApp({ snapshots });
    const res = await call(SNAPSHOT_PATH);
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'forbidden', message: 'A credencial não tem permissão de leitura para este repositório.' },
    });
    expect(res.body).not.toContain('graphql_not_found');
    expect(logLines.some((line) => line.includes('"reason":"graphql_not_found"'))).toBe(true);
  });

  it('snapshot sem credencial responde "missing_credentials"', async () => {
    const { call } = await startApp({ withToken: false, snapshots: null });
    const res = await call(SNAPSHOT_PATH);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('missing_credentials');
  });

  it('serve o snapshot de um repositório autorizado (sem diferenciar maiúsculas)', async () => {
    const snapshots = fakeSnapshots(() =>
      Promise.resolve({ snapshot: { ok: true } as never, freshness: { stale: false, staleReason: null } }),
    );
    const { call } = await startApp({ snapshots });
    const res = await call('/api/repos/moreirapontocom-br/AI-COMMAND-CENTER/snapshot?refresh=1');
    expect(res.status).toBe(200);
    expect(snapshots.getSnapshot).toHaveBeenCalledWith('Moreirapontocom-br/ai-command-center', { refresh: true });
  });

  it('recusa repositórios fora da lista autorizada sem consultar o GitHub', async () => {
    const snapshots = fakeSnapshots(() => Promise.reject(new Error('não deveria ser chamado')));
    const { call } = await startApp({ snapshots });
    for (const path of ['/api/repos/torvalds/linux/snapshot', '/api/repos/Moreirapontocom-br/outro/snapshot']) {
      const res = await call(path);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('not_found');
    }
    expect(snapshots.getSnapshot).not.toHaveBeenCalled();
  });

  it('não funciona como proxy aberto da API do GitHub', async () => {
    const { call } = await startApp({ snapshots: fakeSnapshots(() => Promise.reject(new Error('x'))) });
    for (const path of ['/api/graphql', '/api/repos/Moreirapontocom-br/ai-command-center/issues', '/repos/x/y', '/api/https://api.github.com/user']) {
      expect((await call(path)).status).toBe(404);
    }
  });

  it('valida parâmetros', async () => {
    const { call } = await startApp({ snapshots: fakeSnapshots(() => Promise.reject(new Error('x'))) });
    expect((await call('/api/repos/-bad/ai-command-center/snapshot')).status).toBe(400);
    expect((await call('/api/repos/Moreirapontocom-br/ai%2Fcommand/snapshot')).status).toBe(400);
    // `..` codificado é resolvido pelo parser de URL e a rota simplesmente não existe.
    expect((await call('/api/repos/Moreirapontocom-br/%2e%2e/snapshot')).status).toBe(404);
    expect((await call(`${SNAPSHOT_PATH}?refresh=yes`)).status).toBe(400);
    expect((await call(`${SNAPSHOT_PATH}?query=mutation`)).status).toBe(400);
  });

  it('aceita apenas operações de leitura', async () => {
    const { call } = await startApp();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call(SNAPSHOT_PATH, { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
    }
  });

  it('bloqueia Host externo (DNS rebinding), Origin desconhecida e requisições cross-site', async () => {
    const { call } = await startApp();
    expect((await call('/api/status', { headers: { host: 'evil.example:80' } })).status).toBe(403);
    expect((await call('/api/status', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('/api/status', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await call('/api/status', { headers: { origin: 'http://localhost:5173' } })).status).toBe(200);
  });

  it('limita requisições por cliente', async () => {
    const { call } = await startApp({ rateLimitPerMinute: 2 });
    await call('/api/status');
    await call('/api/status');
    const res = await call('/api/status');
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body).error.code).toBe('too_many_requests');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('erros do GitHub viram respostas normalizadas, sem token nem detalhes internos', async () => {
    const cases: [IntegrationError, number][] = [
      [new IntegrationError('unauthorized', { cause: new Error(CANARY_TOKEN) }), 502],
      [new IntegrationError('forbidden'), 502],
      [new IntegrationError('rate_limited', { resetAt: '2026-11-10T21:00:00.000Z' }), 429],
      [new IntegrationError('network'), 502],
      [new IntegrationError('timeout'), 504],
    ];
    for (const [error, status] of cases) {
      const { call, logLines } = await startApp({ snapshots: fakeSnapshots(() => Promise.reject(error)) });
      const res = await call(SNAPSHOT_PATH);
      expect(res.status).toBe(status);
      expect(JSON.parse(res.body).error.code).toBe(error.code);
      expect(res.body).not.toContain(CANARY_TOKEN);
      expect(logLines.join('\n')).not.toContain(CANARY_TOKEN);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('erro inesperado responde 500 genérico', async () => {
    const { call, logLines } = await startApp({
      snapshots: fakeSnapshots(() => Promise.reject(new Error(`falhou com ${CANARY_TOKEN}`))),
    });
    const res = await call(SNAPSHOT_PATH);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toEqual({ code: 'internal', message: 'Erro interno do servidor.' });
    expect(res.body + logLines.join('\n')).not.toContain(CANARY_TOKEN);
  });

  it('não registra a query string nos logs', async () => {
    const { call, logLines } = await startApp({ snapshots: fakeSnapshots(() => Promise.reject(new Error('x'))) });
    await call(`/api/status?token=${CANARY_TOKEN}`);
    expect(logLines.join('\n')).not.toContain(CANARY_TOKEN);
    expect(logLines.join('\n')).not.toContain('token=');
  });
});
