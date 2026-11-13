// @vitest-environment node
/**
 * Issue #003 (PR 1): cabeçalhos de segurança, CSP, mascaramento de logs e garantias adicionais de
 * somente leitura. Complementa `security.test.ts` e `http/app.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_SECURITY_HEADERS, appContentSecurityPolicy, appSecurityHeaders } from '../shared/securityHeaders.ts';
import viteConfig from '../vite.config.ts';
import { createFineGrainedTokenProvider } from './auth/credentials.ts';
import { ALLOWED_REPOSITORIES } from './config.ts';
import { APPROVED_DOCUMENTS, createGraphQLClient, GITHUB_GRAPHQL_ENDPOINT, type FetchLike } from './github/client.ts';
import { IntegrationError } from './github/errors.ts';
import { createRequestHandler } from './http/app.ts';
import { createConsoleLogger, isSensitiveKey, redact } from './logger.ts';
import { createSnapshotService, type SnapshotService } from './snapshotService.ts';
import { CANARY_TOKEN, jsonResponse, rawSnapshot } from './test/fixtures.ts';

const COOKIE_VALUE = 'sessao=COOKIECANARY123456; outra=COOKIECANARY654321';
const BASIC_VALUE = 'Basic QkFTSUNDQU5BUlk6c2VuaGE=';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function startApp(snapshots: SnapshotService | null = null, rateLimitPerMinute = 100) {
  const logLines: string[] = [];
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server!.address() as AddressInfo).port;
  const handler = createRequestHandler({
    config: {
      port,
      allowedRepositories: ALLOWED_REPOSITORIES,
      allowedOrigins: ['http://localhost:5173'],
      credentials: createFineGrainedTokenProvider(CANARY_TOKEN),
      rateLimitPerMinute,
    },
    snapshots,
    logger: createConsoleLogger((line) => logLines.push(line)),
  });
  server.on('request', (req, res) => void handler(req, res));

  function call(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  return { call, logLines, port };
}

const SNAPSHOT_PATH = '/api/repos/Moreirapontocom-br/ai-command-center/snapshot';

function expectApiSecurityHeaders(headers: Record<string, unknown>) {
  expect(headers['content-security-policy']).toBe(API_SECURITY_HEADERS['Content-Security-Policy']);
  expect(headers['content-security-policy']).toContain("default-src 'none'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cache-control']).toBe('no-store');
  expect(headers['access-control-allow-origin']).toBeUndefined();
}

describe('cabeçalhos de segurança da API', () => {
  it('estão presentes em sucesso e em todas as respostas de erro', async () => {
    const snapshots: SnapshotService = { getSnapshot: vi.fn(() => Promise.reject(new Error('falha'))) };
    const { call, port } = await startApp(snapshots, 100);
    const responses = [
      await call('/api/status'), // 200
      await call('/api/status', { headers: { host: `evil.example:${port}` } }), // 403
      await call('/nao-existe'), // 404
      await call('/api/status?x=1'), // 400
      await call('/api/status', { method: 'POST' }), // 405
      await call(SNAPSHOT_PATH), // 500
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 403, 404, 400, 405, 500]);
    for (const res of responses) expectApiSecurityHeaders(res.headers);
  });

  it('também na resposta 429 do rate limit', async () => {
    const { call } = await startApp(null, 1);
    await call('/api/status');
    const res = await call('/api/status');
    expect(res.status).toBe(429);
    expectApiSecurityHeaders(res.headers);
  });
});

describe('Host, Origin e loopback', () => {
  it.each([
    ['sem porta', () => ({ host: '127.0.0.1' })],
    ['porta errada', (port: number) => ({ host: `127.0.0.1:${port + 1}` })],
    ['subdomínio que imita localhost', (port: number) => ({ host: `localhost.evil.example:${port}` })],
    ['IP de rede local', (port: number) => ({ host: `192.168.0.10:${port}` })],
    ['0.0.0.0', (port: number) => ({ host: `0.0.0.0:${port}` })],
    ['Origin "null" (sandbox/arquivo local)', () => ({ origin: 'null' })],
    ['Origin com outra porta', () => ({ origin: 'http://localhost:9999' })],
    ['Origin https da mesma máquina', () => ({ origin: 'https://localhost:5173' })],
    ['Origin com sufixo enganoso', () => ({ origin: 'http://localhost:5173.evil.example' })],
  ])('recusa %s', async (_label, headers) => {
    const { call, port } = await startApp();
    const res = await call('/api/status', { headers: headers(port) });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('forbidden_origin');
  });

  it.each([['127.0.0.1'], ['localhost'], ['LOCALHOST'], ['[::1]']])('aceita Host de loopback %s', async (host) => {
    const { call, port } = await startApp();
    expect((await call('/api/status', { headers: { host: `${host}:${port}` } })).status).toBe(200);
  });

  it('aceita navegação same-origin e sem Origin (ferramentas locais)', async () => {
    const { call } = await startApp();
    expect((await call('/api/status', { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await call('/api/status')).status).toBe(200);
  });
});

describe('cabeçalhos sensíveis nunca aparecem em respostas ou logs', () => {
  it('Cookie, Authorization e Set-Cookie enviados pelo cliente não são ecoados', async () => {
    const snapshots: SnapshotService = {
      getSnapshot: vi.fn(() => Promise.reject(new IntegrationError('forbidden', { reason: 'graphql_not_found' }))),
    };
    const { call, logLines } = await startApp(snapshots);
    const sensitive = { cookie: COOKIE_VALUE, authorization: `Bearer ${CANARY_TOKEN}`, 'set-cookie': COOKIE_VALUE };
    const responses = [
      await call('/api/status', { headers: sensitive }),
      await call(SNAPSHOT_PATH, { headers: sensitive }),
      await call('/api/status', { method: 'DELETE', headers: sensitive }),
      await call('/api/status', { headers: { ...sensitive, origin: 'https://evil.example' } }),
    ];
    const everything = responses.map((r) => r.body + JSON.stringify(r.headers)).join('\n') + logLines.join('\n');
    for (const secret of ['COOKIECANARY', CANARY_TOKEN, 'Bearer ']) expect(everything).not.toContain(secret);
    for (const res of responses) expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('erro interno cuja causa contém cookie/credenciais não vaza na resposta nem no log', async () => {
    const cause = new Error(`falhou: Cookie: ${COOKIE_VALUE}; Authorization: ${BASIC_VALUE}; token ${CANARY_TOKEN}`);
    const snapshots: SnapshotService = { getSnapshot: vi.fn(() => Promise.reject(cause)) };
    const { call, logLines } = await startApp(snapshots);
    const res = await call(SNAPSHOT_PATH);
    expect(res.status).toBe(500);
    const everything = res.body + logLines.join('\n');
    for (const secret of ['COOKIECANARY', 'QkFTSUNDQU5BUlk', CANARY_TOKEN]) expect(everything).not.toContain(secret);
  });
});

describe('logger: mascaramento', () => {
  function capture() {
    const lines: string[] = [];
    return { lines, logger: createConsoleLogger((line) => lines.push(line)) };
  }

  it('mascara campos sensíveis pelo NOME, qualquer que seja o valor', () => {
    const { lines, logger } = capture();
    logger.log('info', 'teste', {
      authorization: 'qualquer-coisa-1',
      Cookie: 'qualquer-coisa-2',
      'set-cookie': 'qualquer-coisa-3',
      'Proxy-Authorization': 'qualquer-coisa-4',
      accessToken: 'qualquer-coisa-5',
      client_secret: 'qualquer-coisa-6',
      password: 'qualquer-coisa-7',
      sessionId: 'qualquer-coisa-8',
      'x-api-key': 'qualquer-coisa-9',
      path: '/api/status',
    });
    expect(lines[0]).not.toMatch(/qualquer-coisa/);
    expect(JSON.parse(lines[0]).path).toBe('/api/status');
  });

  it.each([
    ['cabeçalho Cookie em texto livre', `Cookie: ${COOKIE_VALUE}`, 'COOKIECANARY'],
    ['Set-Cookie em JSON', `{"set-cookie":"${COOKIE_VALUE}"}`, 'COOKIECANARY'],
    ['Authorization Basic', `Authorization: ${BASIC_VALUE}`, 'QkFTSUNDQU5BUlk'],
    ['Basic solto', `credencial ${BASIC_VALUE}`, 'QkFTSUNDQU5BUlk'],
    ['token em query string', `GET /x?access_token=QUERYCANARY123&ok=1`, 'QUERYCANARY'],
    ['senha em formulário', 'user=a&password=SENHACANARY99', 'SENHACANARY'],
    ['token OAuth do gh', 'gho_' + 'G'.repeat(36), 'gho_G'],
    ['token fine-grained', CANARY_TOKEN, CANARY_TOKEN],
  ])('mascara %s na mensagem', (_label, text, secret) => {
    const { lines, logger } = capture();
    logger.log('error', text, { detail: text });
    expect(lines[0]).not.toContain(secret);
    expect(redact(text)).not.toContain(secret);
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('meta não sobrescreve time/level/message', () => {
    const { lines, logger } = capture();
    logger.log('info', 'original', { message: 'forjada', level: 'error' });
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', message: 'original' });
  });

  it('não mascara campos operacionais legítimos', () => {
    for (const key of ['path', 'status', 'method', 'ms', 'code', 'reason', 'authMode', 'repositories', 'url']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });
});

describe('CSP do frontend', () => {
  const production = appContentSecurityPolicy('production');
  const development = appContentSecurityPolicy('development');
  const directive = (csp: string, name: string) =>
    csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';

  it('produção: sem inline, sem eval, sem origens externas', () => {
    expect(production).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|\*|https?:|ws:/);
    expect(directive(production, 'default-src')).toBe("default-src 'self'");
    expect(directive(production, 'script-src')).toBe("script-src 'self'");
    expect(directive(production, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(production, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(production, 'object-src')).toBe("object-src 'none'");
    expect(directive(production, 'base-uri')).toBe("base-uri 'none'");
  });

  it('desenvolvimento: só relaxa script/style inline e WebSocket de loopback (HMR)', () => {
    expect(directive(development, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
    expect(directive(development, 'connect-src')).not.toMatch(/https?:|api\.github\.com|ws:\/\/\*/);
    expect(development).not.toContain('unsafe-eval');
    expect(directive(development, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('o navegador nunca é autorizado a falar diretamente com o GitHub', () => {
    for (const csp of [production, development]) expect(csp).not.toMatch(/github/);
  });

  it('o Vite aplica a política de produção no preview e a de desenvolvimento no dev server', () => {
    const config = viteConfig as { server?: { headers?: unknown }; preview?: { headers?: unknown } };
    expect(config.preview?.headers).toEqual(appSecurityHeaders('production'));
    expect(config.server?.headers).toEqual(appSecurityHeaders('development'));
    expect(appSecurityHeaders('production')).toMatchObject({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
  });

  it('index.html não tem script/estilo inline nem handlers de evento', () => {
    const html = readFileSync('index.html', 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });
});

function sourceFiles(dir: string): Array<{ path: string; code: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative('.', full).replaceAll('\\', '/'), code: readFileSync(full, 'utf8') }];
  });
}

describe('integração GitHub exclusivamente de leitura (Issue #003)', () => {
  const server = sourceFiles('server');
  const frontend = sourceFiles('src');

  it('o único método HTTP declarado no servidor é o POST do GraphQL (leitura via query)', () => {
    const methods = server.flatMap((f) => [...f.code.matchAll(/method:\s*['"]([A-Z]+)['"]/g)].map((m) => `${f.path}:${m[1]}`));
    expect(methods).toEqual(['server/github/client.ts:POST']);
  });

  it('nenhuma referência a endpoints REST de escrita, permissões ou administração', () => {
    const forbidden =
      /\/(?:collaborators|permissions|hooks|keys|secrets|protection|rulesets|merges|merge|dispatches|git\/refs|contents|invitations|actions)\b/;
    const hits = [...server, ...frontend].filter((f) => forbidden.test(f.code.replace(/^\s*(?:\/\/|\*).*$/gm, '')));
    expect(hits.map((f) => f.path)).toEqual([]);
  });

  it('os documentos aprovados não mencionam campos de mutation conhecidos', () => {
    for (const document of APPROVED_DOCUMENTS) {
      expect(document).not.toMatch(/\b(?:create|update|delete|add|remove|merge|close|reopen|dismiss|lock|unlock)[A-Z]\w*\s*\(/);
    }
  });

  it('em execução, o cliente só envia query aprovada ao endpoint fixo, sem cookies', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ data: rawSnapshot() }));
    const client = createGraphQLClient({ credentials: createFineGrainedTokenProvider(CANARY_TOKEN), fetchImpl, timeoutMs: 1000 });
    const service = createSnapshotService({ client, cacheTtlMs: 0, minRefreshIntervalMs: 0 });
    await service.getSnapshot(ALLOWED_REPOSITORIES[0], { refresh: true });

    expect(fetchImpl).toHaveBeenCalled();
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe(GITHUB_GRAPHQL_ENDPOINT);
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('error');
      const headers = new Headers(init.headers);
      expect(headers.has('cookie')).toBe(false);
      const body = JSON.parse(String(init.body)) as { query: string };
      expect(APPROVED_DOCUMENTS.has(body.query)).toBe(true);
      expect(body.query).not.toMatch(/\bmutation\b/);
    }
  });

  it('o snapshot entregue ao navegador não contém o token nem cabeçalhos de autenticação', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ data: rawSnapshot() }));
    const client = createGraphQLClient({ credentials: createFineGrainedTokenProvider(CANARY_TOKEN), fetchImpl, timeoutMs: 1000 });
    const { call } = await startApp(createSnapshotService({ client, cacheTtlMs: 0, minRefreshIntervalMs: 0 }));
    const res = await call(SNAPSHOT_PATH);
    expect(res.status).toBe(200);
    expect(res.body + JSON.stringify(res.headers)).not.toMatch(new RegExp(`${CANARY_TOKEN}|Bearer|authorization`, 'i'));
  });

  it('o frontend não lê variáveis de ambiente nem monta cabeçalhos de autenticação', () => {
    expect(frontend.filter((f) => /import\.meta\.env|process\.env/.test(f.code)).map((f) => f.path)).toEqual([]);
    // O NOME `GITHUB_TOKEN` aparece legitimamente no texto de ajuda da UI; aqui se procuram valores e cabeçalhos.
    expect(frontend.filter((f) => /authorization|bearer|github_pat_|\bgh[pousr]_/i.test(f.code)).map((f) => f.path)).toEqual([]);
    expect(frontend.filter((f) => /credentials:\s*['"]include['"]/.test(f.code)).map((f) => f.path)).toEqual([]);
  });
});
