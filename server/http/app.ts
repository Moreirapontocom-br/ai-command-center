import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorBody, ApiErrorCode, SessionResponse, StatusResponse } from '../../shared/contracts.ts';
import { API_SECURITY_HEADERS } from '../../shared/securityHeaders.ts';
import { readCookie, type AuthService } from '../auth/adminAuth.ts';
import type { Session } from '../auth/sessions.ts';
import type { ServerConfig } from '../config.ts';
import { ERROR_HTTP_STATUS, IntegrationError } from '../github/errors.ts';
import type { Logger } from '../logger.ts';
import type { SnapshotService } from '../snapshotService.ts';
import { createRateLimiter } from './rateLimiter.ts';

export interface AppDeps {
  config: Pick<
    ServerConfig,
    'port' | 'allowedRepositories' | 'allowedOrigins' | 'credentials' | 'rateLimitPerMinute'
  >;
  snapshots: SnapshotService | null;
  /** Autenticação do administrador do ACC. Toda rota fora de `PUBLIC_ROUTES` exige sessão válida. */
  auth: AuthService;
  logger: Logger;
  now?: () => number;
}

/**
 * Únicas rotas que aceitam POST: login e logout. Elas não alteram dados de negócio nem chegam ao
 * GitHub. Todas as demais rotas continuam somente leitura (GET/HEAD).
 */
export const POST_ROUTES: readonly string[] = Object.freeze(['/api/auth/login', '/api/auth/logout']);
/** Rotas acessíveis sem sessão. Nenhuma devolve dados do GitHub nem da configuração. */
export const PUBLIC_ROUTES: readonly string[] = Object.freeze(['/api/auth/session', ...POST_ROUTES]);

const READ_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD']);
const MAX_BODY_BYTES = 4096;

export function allowedMethods(pathname: string): readonly string[] {
  return POST_ROUTES.includes(pathname) ? ['POST'] : READ_METHODS;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SNAPSHOT_ROUTE = /^\/api\/repos\/([^/]+)\/([^/]+)\/snapshot$/;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    // CSP `default-src 'none'`, frame-ancestors/X-Frame-Options, nosniff e no-referrer.
    ...API_SECURITY_HEADERS,
    // Sem cabeçalhos CORS: o navegador só acessa a API pela mesma origem (proxy do Vite).
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: IntegrationError, extraHeaders: Record<string, string> = {}) {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.resetAt ? { resetAt: error.resetAt } : {}),
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    },
  };
  const headers: Record<string, string> = { ...extraHeaders };
  if (error.retryAfterSeconds) headers['Retry-After'] = String(error.retryAfterSeconds);
  sendJson(res, ERROR_HTTP_STATUS[error.code], body, headers);
}

function fail(code: ApiErrorCode, extra?: { retryAfterSeconds?: number }): never {
  throw new IntegrationError(code, extra);
}

/**
 * Proteções contra uso indevido de um servidor local:
 * - `Host` precisa ser o próprio loopback (bloqueia DNS rebinding);
 * - `Origin`, se enviado, precisa ser uma origem conhecida do Vite;
 * - `Sec-Fetch-Site: cross-site` é recusado (páginas de terceiros não podem disparar consultas).
 */
function assertTrustedRequest(req: IncomingMessage, deps: AppDeps) {
  const port = deps.config.port;
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!allowedHosts.includes((req.headers.host ?? '').toLowerCase())) fail('forbidden_origin');

  const origin = req.headers.origin;
  if (origin !== undefined && !deps.config.allowedOrigins.includes(origin)) fail('forbidden_origin');

  if (req.headers['sec-fetch-site'] === 'cross-site') fail('forbidden_origin');
}

/**
 * CSRF nas rotas POST (login/logout), além do cookie `SameSite=Strict`:
 * - `Origin` obrigatório e igual a uma origem conhecida;
 * - `Sec-Fetch-Site`, se enviado, precisa ser `same-origin` (recusa `same-site`, ex.: outra porta);
 * - corpo `application/json`, que um formulário de outro site não envia sem preflight CORS
 *   (e o servidor não responde a CORS).
 */
function assertSafePost(req: IncomingMessage, deps: AppDeps) {
  const origin = req.headers.origin;
  if (origin === undefined || !deps.config.allowedOrigins.includes(origin)) fail('forbidden_origin');
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') fail('forbidden_origin');
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') fail('unsupported_media_type');
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) fail('payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) fail('payload_too_large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return fail('bad_request');
  }
}

function parseLoginBody(body: unknown): { email: string; password: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('bad_request');
  const { email, password, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length > 0) fail('bad_request');
  if (typeof email !== 'string' || typeof password !== 'string') fail('bad_request');
  if (email.length === 0 || email.length > 320 || password.length === 0 || password.length > 256) fail('bad_request');
  return { email, password };
}

function sessionBody(session: Session): SessionResponse {
  return { authenticated: true, user: { email: session.email }, expiresAt: new Date(session.expiresAt).toISOString() };
}

/** Resolve `owner/repo` da URL contra a lista autorizada (comparação sem diferenciar maiúsculas). */
function resolveAllowedRepository(owner: string, repo: string, allowed: readonly string[]): string {
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    fail('bad_request');
  }
  const requested = `${owner}/${repo}`.toLowerCase();
  const match = allowed.find((fullName) => fullName.toLowerCase() === requested);
  // 404 em vez de 403: não revela se o repositório existe ou se o token tem acesso a ele.
  return match ?? fail('not_found');
}

function assertOnlyParams(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) fail('bad_request');
  }
}

export function createRequestHandler(deps: AppDeps) {
  const limiter = createRateLimiter({ limit: deps.config.rateLimitPerMinute, windowMs: 60_000, now: deps.now });
  const { auth } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let pathname = '';
    // Cabeçalhos adicionais também em respostas de erro (Allow, Set-Cookie de limpeza).
    const errorHeaders: Record<string, string> = {};
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      pathname = url.pathname;

      const methods = allowedMethods(pathname);
      if (!methods.includes(req.method ?? '')) {
        errorHeaders.Allow = methods.join(', ');
        fail('method_not_allowed');
      }
      assertTrustedRequest(req, deps);

      const client = req.socket.remoteAddress ?? 'unknown';
      const verdict = limiter.hit(client);
      if (!verdict.allowed) fail('too_many_requests', { retryAfterSeconds: verdict.retryAfterSeconds });

      const cookieHeader = req.headers.cookie;
      const presentedCookie = readCookie(cookieHeader, auth.cookieName) !== null;

      if (pathname === '/api/auth/session') {
        assertOnlyParams(url, []);
        const current = auth.authenticate(cookieHeader);
        if (current) {
          sendJson(res, 200, sessionBody(current.session));
        } else {
          const body: SessionResponse = { authenticated: false, authConfigured: auth.configured };
          // Cookie presente mas inválido/expirado: o navegador o descarta.
          sendJson(res, 200, body, presentedCookie ? { 'Set-Cookie': auth.clearedCookie() } : {});
        }
        return;
      }

      if (pathname === '/api/auth/login') {
        assertOnlyParams(url, []);
        assertSafePost(req, deps);
        const credentials = parseLoginBody(await readJsonBody(req));
        const result = await auth.login({ ...credentials, client });
        if (!result.ok) {
          if (result.reason === 'not_configured') fail('auth_not_configured');
          if (result.reason === 'invalid_credentials') {
            deps.logger.log('warn', 'Login recusado', { event: 'login_failure' });
            fail('invalid_credentials');
          }
          deps.logger.log('warn', 'Login temporariamente bloqueado', { event: `login_${result.reason}` });
          fail('too_many_requests', { retryAfterSeconds: result.retryAfterSeconds });
        }
        // Rotação: uma sessão anterior enviada por este navegador é revogada.
        auth.logout(cookieHeader);
        deps.logger.log('info', 'Login do administrador', { event: 'login_success' });
        sendJson(res, 200, sessionBody(result.session), { 'Set-Cookie': auth.sessionCookie(result.token) });
        return;
      }

      if (pathname === '/api/auth/logout') {
        assertOnlyParams(url, []);
        assertSafePost(req, deps);
        auth.logout(cookieHeader);
        deps.logger.log('info', 'Logout', { event: 'logout' });
        const body: SessionResponse = { authenticated: false, authConfigured: auth.configured };
        sendJson(res, 200, body, { 'Set-Cookie': auth.clearedCookie() });
        return;
      }

      // Daqui em diante, toda rota exige sessão válida, ANTES de qualquer validação específica:
      // visitantes não distinguem rotas, parâmetros nem repositórios autorizados.
      const current = auth.authenticate(cookieHeader);
      if (!current) {
        if (presentedCookie) errorHeaders['Set-Cookie'] = auth.clearedCookie();
        fail('unauthenticated');
      }
      const { session } = current;

      if (pathname === '/api/status') {
        assertOnlyParams(url, []);
        const body: StatusResponse = {
          configured: deps.config.credentials !== null,
          authMode: deps.config.credentials?.kind ?? 'none',
          repositories: deps.config.allowedRepositories.filter((name) => session.scope.includes(name)),
        };
        sendJson(res, 200, body);
        return;
      }

      const match = SNAPSHOT_ROUTE.exec(pathname);
      if (match) {
        assertOnlyParams(url, ['refresh']);
        const refreshParam = url.searchParams.get('refresh');
        if (refreshParam !== null && refreshParam !== '1') fail('bad_request');
        const fullName = resolveAllowedRepository(match[1], match[2], deps.config.allowedRepositories);
        // Escopo da sessão: a mesma resposta 404 de um repositório fora da allowlist.
        if (!session.scope.includes(fullName)) fail('not_found');
        if (deps.snapshots === null) fail('missing_credentials');
        const result = await deps.snapshots.getSnapshot(fullName, { refresh: refreshParam === '1' });
        sendJson(res, 200, result);
        return;
      }

      fail('not_found');
    } catch (error) {
      const integrationError =
        error instanceof IntegrationError ? error : new IntegrationError('internal', { cause: error });
      if (integrationError.code === 'internal') {
        deps.logger.log('error', 'Erro interno ao processar requisição', {
          path: pathname,
          error: error instanceof Error ? error.name : 'unknown',
          ...(integrationError.reason ? { reason: integrationError.reason } : {}),
        });
      } else if (integrationError.reason) {
        // Motivo interno (ex.: NOT_FOUND x FORBIDDEN do GraphQL) só no log; a resposta usa o código genérico.
        deps.logger.log('warn', 'Falha na integração com o GitHub', {
          path: pathname,
          code: integrationError.code,
          reason: integrationError.reason,
        });
      }
      sendError(res, integrationError, errorHeaders);
    } finally {
      deps.logger.log('info', 'request', {
        method: req.method ?? '',
        path: pathname, // apenas o caminho: a query string nunca é registrada
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  };
}
