import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ActiveProjectResponse,
  ApiErrorBody,
  ApiErrorCode,
  ProjectListResponse,
  SessionResponse,
  StatusResponse,
} from '../../shared/contracts.ts';
import { API_SECURITY_HEADERS } from '../../shared/securityHeaders.ts';
import { readCookie, type AuthService } from '../auth/adminAuth.ts';
import type { Session } from '../auth/sessions.ts';
import type { ServerConfig } from '../config.ts';
import { ERROR_HTTP_STATUS, IntegrationError } from '../github/errors.ts';
import type { Logger } from '../logger.ts';
import type { ProjectStore } from '../projects/projectStore.ts';
import { parseActiveProject, parseProjectCreate, parseProjectUpdate, PROJECT_ID_PATTERN } from '../projects/validation.ts';
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
  /** Projetos (Issue #004). Ausente: as rotas de projetos respondem erro interno. */
  projects?: ProjectStore | null;
  logger: Logger;
  now?: () => number;
}

/** Único método de escrita aceito pelo servidor. Não há PUT, PATCH nem DELETE. */
const WRITE_METHOD = 'POST';
const READ_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD']);

const AUTH_POST_ROUTES: readonly string[] = Object.freeze(['/api/auth/login', '/api/auth/logout']);
const PROJECTS_ROUTE = '/api/projects';
const ACTIVE_PROJECT_ROUTE = '/api/projects/active';
const PROJECT_ITEM_ROUTE = /^\/api\/projects\/([^/]+)$/;
const PROJECT_SNAPSHOT_ROUTE = /^\/api\/projects\/([^/]+)\/repositories\/([^/]+)\/([^/]+)\/snapshot$/;

/**
 * Rotas que aceitam POST. Login/logout não alteram dados de negócio; as de projetos (Issue #004)
 * gravam apenas no armazenamento local do ACC. Nenhuma escrita chega ao GitHub, que continua
 * somente leitura. `:id` representa o UUID de um projeto.
 */
export const POST_ROUTES: readonly string[] = Object.freeze([
  ...AUTH_POST_ROUTES,
  PROJECTS_ROUTE,
  ACTIVE_PROJECT_ROUTE,
  '/api/projects/:id',
]);
/** Rotas acessíveis sem sessão. Nenhuma devolve dados do GitHub, de projetos nem da configuração. */
export const PUBLIC_ROUTES: readonly string[] = Object.freeze(['/api/auth/session', ...AUTH_POST_ROUTES]);

const MAX_AUTH_BODY_BYTES = 4096;
const MAX_PROJECT_BODY_BYTES = 16 * 1024;

export function allowedMethods(pathname: string): readonly string[] {
  if (AUTH_POST_ROUTES.includes(pathname) || pathname === ACTIVE_PROJECT_ROUTE) return [WRITE_METHOD];
  // Listar/criar e ler/editar projetos. Um id malformado recebe a mesma resposta de método que um
  // válido; o formato só é verificado depois da autenticação.
  if (pathname === PROJECTS_ROUTE || PROJECT_ITEM_ROUTE.test(pathname)) return [...READ_METHODS, WRITE_METHOD];
  return READ_METHODS;
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
 * CSRF em TODA requisição POST (login, logout e projetos), além do cookie `SameSite=Strict`.
 * Roda antes da autenticação, para que um pedido forjado não chegue nem a renovar a sessão:
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

/**
 * Lê o corpo JSON com limite (4 KiB na autenticação, 16 KiB em projetos), declarado em
 * `Content-Length` ou contado durante a leitura. O conteúdo nunca é registrado em log nem repetido
 * na resposta. Corpo vazio ou inválido → 400.
 */
async function readJsonBody(req: IncomingMessage, maxBytes = MAX_AUTH_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) fail('payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) fail('payload_too_large');
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
  const linkableRepositories = (session: Session) =>
    deps.config.allowedRepositories.filter((name) => session.scope.includes(name));

  /**
   * Rotas de projetos (Issue #004), todas autenticadas. O dono é sempre o `userId` da sessão: o
   * cliente nunca informa de quem é o projeto. Projeto de outro dono responde 404, igual a um
   * inexistente.
   */
  async function handleProjects(req: IncomingMessage, res: ServerResponse, url: URL, session: Session) {
    const store = deps.projects ?? fail('internal');
    const pathname = url.pathname;
    const ownerId = session.userId;
    const isWrite = req.method === WRITE_METHOD;

    if (pathname === PROJECTS_ROUTE) {
      assertOnlyParams(url, []);
      if (isWrite) {
        const fields = parseProjectCreate(await readJsonBody(req, MAX_PROJECT_BODY_BYTES), linkableRepositories(session));
        const project = await store.create(ownerId, fields);
        deps.logger.log('info', 'Projeto criado', { event: 'project_created', projectId: project.id });
        sendJson(res, 201, project);
        return;
      }
      const body: ProjectListResponse = { ...store.list(ownerId), linkableRepositories: linkableRepositories(session) };
      sendJson(res, 200, body);
      return;
    }

    if (pathname === ACTIVE_PROJECT_ROUTE) {
      assertOnlyParams(url, []);
      const projectId = parseActiveProject(await readJsonBody(req, MAX_PROJECT_BODY_BYTES));
      if (!(await store.setActive(ownerId, projectId))) fail('not_found');
      const body: ActiveProjectResponse = { activeProjectId: projectId };
      sendJson(res, 200, body);
      return;
    }

    const item = PROJECT_ITEM_ROUTE.exec(pathname);
    if (item) {
      assertOnlyParams(url, []);
      const projectId = item[1];
      if (!PROJECT_ID_PATTERN.test(projectId)) fail('not_found');
      if (isWrite) {
        const patch = parseProjectUpdate(await readJsonBody(req, MAX_PROJECT_BODY_BYTES), linkableRepositories(session));
        const updated = (await store.update(ownerId, projectId, patch)) ?? fail('not_found');
        deps.logger.log('info', 'Projeto atualizado', { event: 'project_updated', projectId });
        sendJson(res, 200, updated);
        return;
      }
      sendJson(res, 200, store.get(ownerId, projectId) ?? fail('not_found'));
      return;
    }

    const snapshotMatch = PROJECT_SNAPSHOT_ROUTE.exec(pathname);
    if (snapshotMatch) {
      assertOnlyParams(url, ['refresh']);
      const refreshParam = url.searchParams.get('refresh');
      if (refreshParam !== null && refreshParam !== '1') fail('bad_request');
      const [, projectId, owner, repo] = snapshotMatch;
      if (!PROJECT_ID_PATTERN.test(projectId)) fail('not_found');
      const project = store.get(ownerId, projectId) ?? fail('not_found');
      const fullName = resolveAllowedRepository(owner, repo, deps.config.allowedRepositories);
      // Isolamento: só repositórios vinculados a ESTE projeto, dentro do escopo da sessão.
      if (!project.repositories.includes(fullName) || !session.scope.includes(fullName)) fail('not_found');
      if (deps.snapshots === null) fail('missing_credentials');
      sendJson(res, 200, await deps.snapshots.getSnapshot(fullName, { refresh: refreshParam === '1' }));
      return;
    }

    fail('not_found');
  }

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

      if (req.method === WRITE_METHOD) assertSafePost(req, deps);

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
        // `auth.login` já revogou TODAS as sessões anteriores (sessão administrativa única).
        deps.logger.log('info', 'Login do administrador', { event: 'login_success' });
        sendJson(res, 200, sessionBody(result.session), { 'Set-Cookie': auth.sessionCookie(result.token) });
        return;
      }

      if (pathname === '/api/auth/logout') {
        assertOnlyParams(url, []);
        // O corpo não é usado, mas é validado com o mesmo limite (objeto JSON, normalmente `{}`).
        const logoutBody = await readJsonBody(req);
        if (typeof logoutBody !== 'object' || logoutBody === null || Array.isArray(logoutBody)) fail('bad_request');
        auth.logout(cookieHeader);
        deps.logger.log('info', 'Logout', { event: 'logout' });
        const body: SessionResponse = { authenticated: false, authConfigured: auth.configured };
        sendJson(res, 200, body, { 'Set-Cookie': auth.clearedCookie() });
        return;
      }

      // Rotas protegidas. Já foram verificados, nesta ordem e para qualquer visitante: método (405),
      // Host/Origin/Sec-Fetch-Site (403), rate limit (429) e, em POST, CSRF/tipo do corpo (403/415).
      // Agora vem a autenticação (401) e, só
      // depois dela, as validações específicas da rota (parâmetros 400, allowlist/escopo 404, rota
      // inexistente 404): um visitante não distingue rotas, parâmetros nem repositórios.
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

      if (pathname === PROJECTS_ROUTE || pathname.startsWith(`${PROJECTS_ROUTE}/`)) {
        await handleProjects(req, res, url, session);
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
      // Corpo grande demais: o restante não é lido; a conexão é encerrada após a resposta.
      if (integrationError.code === 'payload_too_large') errorHeaders.Connection = 'close';
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
