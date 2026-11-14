// @vitest-environment node
/**
 * Issue #003 (PR 2): autenticação do administrador e controle de acesso de ponta a ponta no
 * servidor HTTP real (login, sessão, logout, CSRF, bloqueio de tentativas, escopo e vazamentos).
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_SECURITY_HEADERS } from '../../shared/securityHeaders.ts';
import type { AuthOptions } from '../auth/adminAuth.ts';
import { createFineGrainedTokenProvider } from '../auth/credentials.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';
import { createConsoleLogger } from '../logger.ts';
import type { SnapshotService } from '../snapshotService.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from '../test/authFixtures.ts';
import { CANARY_TOKEN } from '../test/fixtures.ts';
import { createRequestHandler } from './app.ts';

const ORIGIN = 'http://localhost:5173';
const SNAPSHOT_PATH = '/api/repos/Moreirapontocom-br/ai-command-center/snapshot';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function startApp(options: { auth?: Partial<AuthOptions> & { withAdmin?: boolean }; rateLimitPerMinute?: number } = {}) {
  let clock = 1_000_000;
  const logLines: string[] = [];
  const auth = await createTestAuth({ now: () => clock, ...options.auth });
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
      rateLimitPerMinute: options.rateLimitPerMinute ?? 1000,
    },
    snapshots,
    auth,
    logger: createConsoleLogger((line) => logLines.push(line)),
  });
  server.on('request', (req, res) => void handler(req, res));

  function call(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...init.headers } },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }),
          );
        },
      );
      req.on('error', reject);
      req.end(init.body);
    });
  }

  /** POST como o navegador faria pela própria origem (proxy do Vite). */
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return call(path, {
      method: 'POST',
      headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  async function login(email = TEST_ADMIN_EMAIL, password = TEST_ADMIN_PASSWORD, headers: Record<string, string> = {}) {
    const res = await post('/api/auth/login', { email, password }, headers);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const cookie = setCookie[0]?.split(';')[0] ?? '';
    return { res, cookie };
  }

  const advance = (ms: number) => {
    clock += ms;
  };
  return { call, post, login, logLines, snapshots, advance, auth };
}

describe('login', () => {
  it('login válido cria sessão com cookie seguro e dá acesso às rotas privadas', async () => {
    const { login, call } = await startApp();
    const { res, cookie } = await login();
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ authenticated: true, user: { email: TEST_ADMIN_EMAIL }, expiresAt: expect.any(String) });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^acc_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800$/);
    for (const [key, value] of Object.entries(API_SECURITY_HEADERS)) expect(res.headers[key.toLowerCase()]).toBe(value);
    expect(res.headers['cache-control']).toBe('no-store');

    expect((await call('/api/status', { headers: { cookie } })).status).toBe(200);
    expect((await call(SNAPSHOT_PATH, { headers: { cookie } })).status).toBe(200);
    const session = await call('/api/auth/session', { headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, user: { email: TEST_ADMIN_EMAIL } });
  });

  it.each([
    ['senha errada', TEST_ADMIN_EMAIL, 'senha-errada-qualquer'],
    ['e-mail desconhecido', 'intruso@example.test', TEST_ADMIN_PASSWORD],
  ])('login inválido (%s): 401 genérico, sem cookie e sem detalhes', async (_case, email, password) => {
    const { login } = await startApp();
    const { res } = await login(email, password);
    expect(res.status).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'invalid_credentials', message: 'E-mail ou senha inválidos.' } });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['JSON inválido', '{email:'],
    ['corpo vazio', ''],
    ['campos ausentes', { email: TEST_ADMIN_EMAIL }],
    ['tipos errados', { email: TEST_ADMIN_EMAIL, password: 123 }],
    ['campo extra', { email: TEST_ADMIN_EMAIL, password: 'x', admin: true }],
    ['array', [TEST_ADMIN_EMAIL]],
  ])('corpo malformado (%s) → 400', async (_case, body) => {
    const { post } = await startApp();
    expect((await post('/api/auth/login', body)).status).toBe(400);
  });

  it('corpo acima de 4 KiB → 413 e a conexão é encerrada (login e logout)', async () => {
    const { post } = await startApp();
    for (const path of ['/api/auth/login', '/api/auth/logout']) {
      const res = await post(path, { email: TEST_ADMIN_EMAIL, password: 'x'.repeat(5000) });
      expect(res.status, path).toBe(413);
      expect(res.headers.connection, path).toBe('close');
    }
  });

  it('Content-Length acima do limite é recusado antes da leitura', async () => {
    const { call } = await startApp();
    const res = await call('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '100000' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('__proto__/constructor no corpo não poluem objetos: 400', async () => {
    const { post } = await startApp();
    for (const body of [
      `{"email":"${TEST_ADMIN_EMAIL}","password":"x","__proto__":{"admin":true}}`,
      `{"email":"${TEST_ADMIN_EMAIL}","password":"x","constructor":{"prototype":{"admin":true}}}`,
    ]) {
      expect((await post('/api/auth/login', body)).status).toBe(400);
    }
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('Content-Type JSON com charset é aceito; logout exige objeto JSON', async () => {
    const { post, login } = await startApp();
    const ok = await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD }, {
      'content-type': 'application/json; charset=utf-8',
    });
    expect(ok.status).toBe(200);
    const { cookie } = await login();
    for (const body of ['', 'nao-json', '[]', 'null', '"x"']) {
      expect((await post('/api/auth/logout', body, { cookie })).status, body).toBe(400);
    }
  });

  it('sem administrador configurado: login 503 e sessão informa authConfigured=false', async () => {
    const { login, call } = await startApp({ auth: { withAdmin: false } });
    const { res } = await login();
    expect(res.status).toBe(503);
    expect(res.json().error.code).toBe('auth_not_configured');
    expect((await call('/api/auth/session')).json()).toEqual({ authenticated: false, authConfigured: false });
    expect((await call('/api/status')).status).toBe(401);
  });

  it('rotaciona a sessão no mesmo navegador: o novo login revoga o cookie anterior', async () => {
    const { login, call } = await startApp();
    const first = await login();
    const second = await login(TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, { cookie: first.cookie });
    expect(second.cookie).not.toBe(first.cookie);
    expect((await call('/api/status', { headers: { cookie: first.cookie } })).status).toBe(401);
    expect((await call('/api/status', { headers: { cookie: second.cookie } })).status).toBe(200);
  });
});

describe('sessão administrativa única (revogação entre navegadores)', () => {
  it('login no navegador B encerra a sessão do navegador A, que nunca enviou o cookie de B', async () => {
    const { login, call } = await startApp();
    const browserA = await login();
    expect((await call('/api/status', { headers: { cookie: browserA.cookie } })).status).toBe(200);

    const browserB = await login(); // sem cookie: outro navegador/dispositivo
    expect(browserB.res.status).toBe(200);
    expect(browserB.cookie).not.toBe(browserA.cookie);

    const revoked = await call('/api/status', { headers: { cookie: browserA.cookie } });
    expect(revoked.status).toBe(401);
    expect(revoked.json().error.code).toBe('unauthenticated');
    expect(String(revoked.headers['set-cookie'])).toMatch(/^acc_session=; .*Max-Age=0$/);
    expect((await call(SNAPSHOT_PATH, { headers: { cookie: browserA.cookie } })).status).toBe(401);
    expect((await call('/api/auth/session', { headers: { cookie: browserA.cookie } })).json()).toEqual({
      authenticated: false,
      authConfigured: true,
    });
    expect((await call('/api/status', { headers: { cookie: browserB.cookie } })).status).toBe(200);
  });

  it('login malsucedido em outro navegador NÃO derruba a sessão ativa', async () => {
    const { login, call } = await startApp();
    const browserA = await login();
    expect((await login(TEST_ADMIN_EMAIL, 'senha-errada-qualquer')).res.status).toBe(401);
    expect((await login('intruso@example.test', TEST_ADMIN_PASSWORD)).res.status).toBe(401);
    expect((await call('/api/status', { headers: { cookie: browserA.cookie } })).status).toBe(200);
  });

  it('logout do navegador revogado não afeta a sessão ativa; logout da ativa encerra tudo', async () => {
    const { login, post, call } = await startApp();
    const browserA = await login();
    const browserB = await login();
    expect((await post('/api/auth/logout', {}, { cookie: browserA.cookie })).status).toBe(200);
    expect((await call('/api/status', { headers: { cookie: browserB.cookie } })).status).toBe(200);

    expect((await post('/api/auth/logout', {}, { cookie: browserB.cookie })).status).toBe(200);
    for (const cookie of [browserA.cookie, browserB.cookie]) {
      expect((await call('/api/status', { headers: { cookie } })).status).toBe(401);
    }
    const again = await login(); // novo login continua possível
    expect((await call('/api/status', { headers: { cookie: again.cookie } })).status).toBe(200);
  });

  it('a sessão ativa continua expirando por inatividade e por tempo absoluto', async () => {
    const { login, call, advance } = await startApp();
    await login(); // navegador A, revogado a seguir
    const browserB = await login();
    advance(31 * 60_000);
    expect((await call('/api/status', { headers: { cookie: browserB.cookie } })).status).toBe(401);
    const browserC = await login();
    for (let elapsed = 0; elapsed < 8 * 60; elapsed += 25) {
      expect((await call('/api/status', { headers: { cookie: browserC.cookie } })).status).toBe(200);
      advance(25 * 60_000);
    }
    expect((await call('/api/status', { headers: { cookie: browserC.cookie } })).status).toBe(401);
  });
});

describe('tentativas excessivas de login', () => {
  it('após 5 falhas, bloqueia por 15 min (429 + Retry-After) mesmo com a senha certa', async () => {
    const { login, advance, logLines } = await startApp();
    for (let i = 0; i < 5; i += 1) expect((await login(TEST_ADMIN_EMAIL, `errada-${i}`)).res.status).toBe(401);

    const blocked = await login();
    expect(blocked.res.status).toBe(429);
    expect(blocked.res.json().error.code).toBe('too_many_requests');
    expect(Number(blocked.res.headers['retry-after'])).toBe(900);
    expect(blocked.res.headers['set-cookie']).toBeUndefined();
    expect(logLines.some((line) => line.includes('"event":"login_locked"'))).toBe(true);

    advance(15 * 60_000);
    expect((await login()).res.status).toBe(200);
  });
});

describe('acesso sem autenticação', () => {
  it('rotas privadas respondem 401 antes das validações específicas da rota, sem consultar o GitHub', async () => {
    const { call, snapshots } = await startApp();
    for (const path of [
      '/api/status',
      SNAPSHOT_PATH,
      `${SNAPSHOT_PATH}?refresh=1`,
      '/api/repos/torvalds/linux/snapshot', // não revela se está fora da allowlist
      '/api/repos/-bad/x/snapshot', // nem se os parâmetros são inválidos
      '/api/rota-inexistente',
      '/',
    ]) {
      const res = await call(path);
      expect(res.status, path).toBe(401);
      expect(res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Sessão ausente, expirada ou encerrada. Faça login.' } });
      expect(res.body).not.toContain('Moreirapontocom-br');
    }
    expect(snapshots.getSnapshot).not.toHaveBeenCalled();
  });

  it('ordem: método (405), origem (403) e rate limit (429) antes da autenticação; validações da rota depois', async () => {
    const { call, login } = await startApp({ rateLimitPerMinute: 4 });
    // Visitante sem sessão:
    expect((await call('/api/status', { method: 'POST', headers: { origin: ORIGIN } })).status).toBe(405);
    expect((await call('/api/status', { headers: { host: 'evil.example:80' } })).status).toBe(403);
    expect((await call('/api/status', { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('/api/repos/-bad/x/snapshot')).status).toBe(401); // 400 só depois da autenticação
    // Com sessão, as validações específicas da rota passam a responder:
    const { cookie } = await login();
    expect((await call('/api/repos/-bad/x/snapshot', { headers: { cookie } })).status).toBe(400);
    expect((await call('/api/repos/torvalds/linux/snapshot', { headers: { cookie } })).status).toBe(404);
    // 405 e 403 respondem antes do limitador; as 4 requisições seguintes esgotam o limite (4/min):
    const limited = await call('/api/status');
    expect(limited.status).toBe(429);
    expect(limited.json().error.code).toBe('too_many_requests');
  });

  it('/api/auth/session é público e não expõe configuração nem repositórios', async () => {
    const { call } = await startApp();
    const res = await call('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ authenticated: false, authConfigured: true });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.each([
    ['token forjado', `acc_session=${'A'.repeat(43)}`],
    ['formato inválido', 'acc_session=../../etc'],
    ['cookie com outro nome', `outra_sessao=${'A'.repeat(43)}`],
  ])('sessão inválida (%s) → 401', async (_case, cookie) => {
    const { call } = await startApp();
    const res = await call('/api/status', { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});

describe('expiração de sessão', () => {
  it('expira após 30 min de inatividade; o cookie é limpo', async () => {
    const { login, call, advance } = await startApp();
    const { cookie } = await login();
    advance(29 * 60_000);
    expect((await call('/api/status', { headers: { cookie } })).status).toBe(200);
    advance(29 * 60_000); // renovada pela requisição anterior
    expect((await call('/api/status', { headers: { cookie } })).status).toBe(200);
    advance(31 * 60_000);
    const expired = await call('/api/status', { headers: { cookie } });
    expect(expired.status).toBe(401);
    expect(String(expired.headers['set-cookie'])).toMatch(/^acc_session=; .*Max-Age=0$/);
    expect((await call('/api/auth/session', { headers: { cookie } })).json()).toEqual({
      authenticated: false,
      authConfigured: true,
    });
  });

  it('expira após 8 h mesmo com uso contínuo', async () => {
    const { login, call, advance } = await startApp();
    const { cookie } = await login();
    for (let elapsed = 0; elapsed < 8 * 60; elapsed += 20) {
      expect((await call('/api/status', { headers: { cookie } })).status).toBe(200);
      advance(20 * 60_000);
    }
    expect((await call('/api/status', { headers: { cookie } })).status).toBe(401);
  });
});

describe('logout', () => {
  it('revoga a sessão no servidor e limpa o cookie; o cookie antigo deixa de valer', async () => {
    const { login, post, call, logLines } = await startApp();
    const { cookie } = await login();
    const res = await post('/api/auth/logout', {}, { cookie });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ authenticated: false, authConfigured: true });
    expect(String(res.headers['set-cookie'])).toBe('acc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    expect((await call('/api/status', { headers: { cookie } })).status).toBe(401);
    expect(logLines.some((line) => line.includes('"event":"logout"'))).toBe(true);
  });

  it('é idempotente sem sessão', async () => {
    const { post } = await startApp();
    expect((await post('/api/auth/logout', {})).status).toBe(200);
  });
});

describe('CSRF nas rotas POST', () => {
  it('login sem Origin, com Origin estranha ou corpo não JSON é recusado e não cria sessão', async () => {
    const { call } = await startApp();
    const body = JSON.stringify({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD });
    const cases: Array<[Record<string, string>, number]> = [
      [{ 'content-type': 'application/json' }, 403],
      [{ origin: 'https://evil.example', 'content-type': 'application/json' }, 403],
      [{ origin: 'http://localhost:3000', 'content-type': 'application/json' }, 403],
      [{ origin: ORIGIN, 'sec-fetch-site': 'same-site', 'content-type': 'application/json' }, 403],
      [{ origin: ORIGIN, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, 403],
      [{ origin: ORIGIN, 'sec-fetch-site': 'none', 'content-type': 'application/json' }, 403],
      [{ origin: 'null', 'content-type': 'application/json' }, 403], // iframe sandbox / arquivo local
      [{ origin: ORIGIN, 'content-type': 'text/plain' }, 415],
      [{ origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, 415],
      [{ origin: ORIGIN }, 415],
    ];
    for (const [headers, status] of cases) {
      const res = await call('/api/auth/login', { method: 'POST', headers, body });
      expect(res.status, JSON.stringify(headers)).toBe(status);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('logout forjado por outro site não encerra a sessão', async () => {
    const { login, call } = await startApp();
    const { cookie } = await login();
    const forged = await call('/api/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(forged.status).toBe(403);
    expect((await call('/api/status', { headers: { cookie } })).status).toBe(200);
  });

  it('login e logout só aceitam POST; as demais rotas continuam GET/HEAD', async () => {
    const { call, login } = await startApp();
    const { cookie } = await login();
    const getLogin = await call('/api/auth/login');
    expect(getLogin.status).toBe(405);
    expect(getLogin.headers.allow).toBe('POST');
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await call('/api/auth/logout', { method })).status).toBe(405);
    }
    const postStatus = await call('/api/status', { method: 'POST', headers: { cookie, origin: ORIGIN } });
    expect(postStatus.status).toBe(405);
    expect(postStatus.headers.allow).toBe('GET, HEAD');
  });
});

describe('escopo autorizado', () => {
  it('sessão sem o repositório no escopo não o vê em /api/status nem consulta o snapshot', async () => {
    const { login, call, snapshots } = await startApp({ auth: { scope: [] } });
    const { cookie } = await login();
    expect((await call('/api/status', { headers: { cookie } })).json().repositories).toEqual([]);
    const res = await call(SNAPSHOT_PATH, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(snapshots.getSnapshot).not.toHaveBeenCalled();
  });
});

describe('não exposição de segredos', () => {
  it('corpos recusados (malformados, grandes, CSRF) não aparecem em logs nem em respostas', async () => {
    const { post, call, logLines } = await startApp();
    const secret = `${TEST_ADMIN_PASSWORD}-recusada`;
    const replies = [
      await post('/api/auth/login', `{"email":"${TEST_ADMIN_EMAIL}","password":"${secret}"`), // JSON quebrado
      await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: secret, extra: 1 }),
      await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: `${secret}${'y'.repeat(5000)}` }),
      await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: secret }, { 'content-type': 'text/plain' }),
      await post('/api/auth/login', { email: TEST_ADMIN_EMAIL, password: secret }, { origin: 'https://evil.example' }),
      await call(`/api/auth/login?password=${secret}`, { method: 'POST' }),
    ];
    const text = replies.map((r) => r.body).join('\n') + logLines.join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(TEST_ADMIN_EMAIL);
  });

  it('senha, cookie de sessão e token do GitHub nunca aparecem em respostas nem em logs', async () => {
    const { login, post, call, logLines } = await startApp();
    await login(TEST_ADMIN_EMAIL, `${TEST_ADMIN_PASSWORD}-errada`);
    const { res, cookie } = await login();
    const token = cookie.split('=')[1];
    const responses = [
      res.body,
      (await call('/api/status', { headers: { cookie } })).body,
      (await call('/api/auth/session', { headers: { cookie } })).body,
      (await call(SNAPSHOT_PATH, { headers: { cookie } })).body,
      (await post('/api/auth/logout', {}, { cookie })).body,
    ].join('\n');
    const logs = logLines.join('\n');
    for (const secret of [TEST_ADMIN_PASSWORD, token, CANARY_TOKEN]) {
      expect(responses).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect(responses + logs).not.toMatch(/scrypt:/);
    // Logs só com metadados: nenhum corpo de requisição nem cabeçalho Cookie/Set-Cookie.
    expect(logs).not.toMatch(/acc_session=|set-cookie|"cookie"|"password"|"email"/i);
    // O e-mail do administrador não é registrado nos eventos de login.
    expect(logs).not.toContain(TEST_ADMIN_EMAIL);
  });
});
