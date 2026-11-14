import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ActiveProjectResponse,
  ApiErrorBody,
  ApiErrorCode,
  ProjectListResponse,
  SessionResponse,
  TaskListResponse,
  StatusResponse,
} from '../../shared/contracts.ts';
import { AGENT_IDS, AUDIT_ACTIONS, AUDIT_OUTCOMES, AUDIT_QUERY_LIMITS } from '../../shared/contracts.ts';
import type { AuditAction, AuditActor, AuditListResponse, AuditOutcome } from '../../shared/contracts.ts';
import { queryAudit, type AuditLog } from '../audit/auditLog.ts';
import type { AuditEventInput } from '../audit/events.ts';
import { API_SECURITY_HEADERS } from '../../shared/securityHeaders.ts';
import { ADMIN_USER_ID, readCookie, type AuthService } from '../auth/adminAuth.ts';
import type { Session } from '../auth/sessions.ts';
import type { ServerConfig } from '../config.ts';
import { ERROR_HTTP_STATUS, IntegrationError } from '../github/errors.ts';
import type { Logger } from '../logger.ts';
import type { ProjectStore } from '../projects/projectStore.ts';
import { parseActiveProject, parseProjectCreate, parseProjectUpdate, PROJECT_ID_PATTERN } from '../projects/validation.ts';
import type { TaskStore } from '../tasks/taskStore.ts';
import { parseTaskCreate, parseTaskUpdate, TASK_ID_PATTERN, type TaskInputContext } from '../tasks/validation.ts';
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
  /** Tarefas por projeto (Issue #005). Ausente: as rotas de tarefas respondem erro interno. */
  tasks?: TaskStore | null;
  /**
   * Registro de auditoria avulso (Issue #006). Em produção é sempre fornecido (`server/index.ts`).
   * Ausente (apenas em testes antigos): login/logout e recusas não são auditados. Os eventos das
   * alterações de projetos e tarefas ficam nos próprios arquivos delas, independentemente disto.
   */
  audit?: AuditLog | null;
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
const TASKS_ROUTE = /^\/api\/projects\/([^/]+)\/tasks$/;
const TASK_ITEM_ROUTE = /^\/api\/projects\/([^/]+)\/tasks\/([^/]+)$/;
const AUDIT_ROUTE = '/api/audit';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
  '/api/projects/:id/tasks',
  '/api/projects/:id/tasks/:taskId',
]);
/** Rotas acessíveis sem sessão. Nenhuma devolve dados do GitHub, de projetos nem da configuração. */
export const PUBLIC_ROUTES: readonly string[] = Object.freeze(['/api/auth/session', ...AUTH_POST_ROUTES]);

const MAX_AUTH_BODY_BYTES = 4096;
const MAX_PROJECT_BODY_BYTES = 16 * 1024;

export function allowedMethods(pathname: string): readonly string[] {
  if (AUTH_POST_ROUTES.includes(pathname) || pathname === ACTIVE_PROJECT_ROUTE) return [WRITE_METHOD];
  // Listar/criar e ler/editar projetos. Um id malformado recebe a mesma resposta de método que um
  // válido; o formato só é verificado depois da autenticação.
  if (
    pathname === PROJECTS_ROUTE ||
    PROJECT_ITEM_ROUTE.test(pathname) ||
    TASKS_ROUTE.test(pathname) ||
    TASK_ITEM_ROUTE.test(pathname)
  ) {
    return [...READ_METHODS, WRITE_METHOD];
  }
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
  /** O autor é sempre o da sessão: o navegador nunca escolhe quem fez a ação. */
  const actorOf = (session: Session): AuditActor => ({ kind: 'human', id: session.userId });
  const ANONYMOUS: AuditActor = { kind: 'system', id: 'anonymous' };

  /** Nome estável da rota para o contexto da auditoria (nunca o caminho cru, que vem de fora). */
  function routeName(pathname: string): string {
    if (pathname === PROJECTS_ROUTE) return 'projects';
    if (pathname === ACTIVE_PROJECT_ROUTE) return 'projects.active';
    if (PROJECT_ITEM_ROUTE.test(pathname)) return 'projects.item';
    if (TASKS_ROUTE.test(pathname)) return 'tasks';
    if (TASK_ITEM_ROUTE.test(pathname)) return 'tasks.item';
    if (PROJECT_SNAPSHOT_ROUTE.test(pathname) || SNAPSHOT_ROUTE.test(pathname)) return 'snapshot';
    if (pathname === AUDIT_ROUTE) return 'audit';
    if (pathname.startsWith('/api/auth/')) return 'auth';
    if (pathname === '/api/status') return 'status';
    return 'other';
  }

  /** Recusas por regra de negócio = `blocked`; entrada inválida e erros internos = `failure`. */
  const BLOCKED_CODES = new Set<ApiErrorCode>([
    'invalid_status_transition',
    'dependencies_unresolved',
    'dependency_cycle',
    'evidence_required',
    'task_limit_reached',
    'project_limit_reached',
    'repository_not_allowed',
  ]);
  const WRITE_ACTIONS: Record<string, AuditAction> = {
    projects: 'project.created',
    'projects.item': 'project.updated',
    'projects.active': 'project.activated',
    tasks: 'task.created',
    'tasks.item': 'task.updated',
  };

  /**
   * Evento para uma requisição recusada ou que falhou, ou `null` se ela não é auditada (ex.: GET
   * anônimo, limite de requisições). Só usa valores do servidor: código do erro, nome da rota,
   * método e ids que passaram pela validação de formato.
   */
  function refusalEvent(req: IncomingMessage, pathname: string, code: ApiErrorCode, session: Session | null): AuditEventInput | null {
    if (code === 'audit_unavailable' || (code === 'too_many_requests' && pathname !== '/api/auth/login')) return null;
    const route = routeName(pathname);
    const isWrite = req.method === WRITE_METHOD;
    const owner = session?.userId ?? null;
    const actor = session ? actorOf(session) : ANONYMOUS;
    const ids = pathname.split('/').filter((part) => UUID.test(part));
    const projectId = session && ids[0] && deps.projects?.get(session.userId, ids[0]) ? ids[0] : null;

    if (pathname === '/api/auth/login') {
      return {
        action: 'auth.login_rejected',
        actor: ANONYMOUS,
        ownerId: null,
        projectId: null,
        resource: { type: 'session', id: null },
        outcome: code === 'too_many_requests' ? 'blocked' : 'failure',
        context: { reason: code },
      };
    }
    const denied = (outcomeOwner: string | null): AuditEventInput => ({
      action: 'access.denied',
      actor,
      ownerId: outcomeOwner,
      projectId,
      resource: { type: 'route', id: route },
      outcome: 'blocked',
      context: { reason: code, route, method: isWrite ? WRITE_METHOD : 'GET' },
    });
    if (isWrite && ['forbidden_origin', 'unsupported_media_type', 'unauthenticated'].includes(code)) return denied(owner);
    if (session && code === 'not_found' && route !== 'other') return denied(owner);
    if (session && isWrite && WRITE_ACTIONS[route]) {
      const taskId = route === 'tasks.item' ? (ids[1] ?? null) : null;
      return {
        action: WRITE_ACTIONS[route],
        actor,
        ownerId: owner,
        projectId,
        resource: route.startsWith('tasks') ? { type: 'task', id: taskId } : { type: 'project', id: projectId },
        outcome: BLOCKED_CODES.has(code) ? 'blocked' : 'failure',
        context: { reason: code },
      };
    }
    if (pathname === '/api/auth/logout') {
      return { action: 'auth.logout', actor, ownerId: owner, projectId: null, resource: { type: 'session', id: null }, outcome: 'failure', context: { reason: code } };
    }
    return null;
  }

  function parseAuditQuery(url: URL) {
    assertOnlyParams(url, ['projectId', 'action', 'outcome', 'before', 'limit']);
    const get = (key: string) => {
      const values = url.searchParams.getAll(key);
      if (values.length > 1) fail('bad_request');
      return values[0];
    };
    const integer = (value: string | undefined, min: number, max: number) => {
      if (value === undefined) return undefined;
      if (!/^\d{1,15}$/.test(value)) fail('bad_request');
      const n = Number(value);
      if (n < min || n > max) fail('bad_request');
      return n;
    };
    const projectId = get('projectId');
    if (projectId !== undefined && !UUID.test(projectId)) fail('bad_request');
    const action = get('action');
    if (action !== undefined && !(AUDIT_ACTIONS as readonly string[]).includes(action)) fail('bad_request');
    const outcome = get('outcome');
    if (outcome !== undefined && !(AUDIT_OUTCOMES as readonly string[]).includes(outcome)) fail('bad_request');
    return {
      projectId,
      action: action as AuditAction | undefined,
      outcome: outcome as AuditOutcome | undefined,
      before: integer(get('before'), 1, Number.MAX_SAFE_INTEGER),
      limit: integer(get('limit'), 1, AUDIT_QUERY_LIMITS.maxLimit),
    };
  }

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
        const project = await store.create(ownerId, fields, actorOf(session));
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
      if (!(await store.setActive(ownerId, projectId, actorOf(session)))) fail('not_found');
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
        const updated = (await store.update(ownerId, projectId, patch, actorOf(session))) ?? fail('not_found');
        deps.logger.log('info', 'Projeto atualizado', { event: 'project_updated', projectId });
        sendJson(res, 200, updated);
        return;
      }
      sendJson(res, 200, store.get(ownerId, projectId) ?? fail('not_found'));
      return;
    }

    const tasksMatch = TASKS_ROUTE.exec(pathname) ?? TASK_ITEM_ROUTE.exec(pathname);
    if (tasksMatch) {
      assertOnlyParams(url, []);
      const [, projectId, taskId] = tasksMatch;
      if (!PROJECT_ID_PATTERN.test(projectId) || (taskId !== undefined && !TASK_ID_PATTERN.test(taskId))) fail('not_found');
      // Isolamento: o projeto precisa ser do usuário; as tarefas são buscadas por (dono, projeto).
      const project = store.get(ownerId, projectId) ?? fail('not_found');
      const tasks = deps.tasks ?? fail('internal');
      const context: TaskInputContext = {
        repositories: project.repositories.filter((name) => session.scope.includes(name)),
        assignableUserIds: [session.userId],
      };

      if (taskId === undefined) {
        if (isWrite) {
          const fields = parseTaskCreate(await readJsonBody(req, MAX_PROJECT_BODY_BYTES), context);
          // Pelo navegador, toda tarefa é manual: a origem nunca vem do cliente.
          const task = await tasks.create(ownerId, projectId, fields, { actor: session.userId, origin: 'manual' });
          deps.logger.log('info', 'Tarefa criada', { event: 'task_created', projectId, taskId: task.id });
          sendJson(res, 201, task);
          return;
        }
        const body: TaskListResponse = {
          tasks: tasks.list(ownerId, projectId),
          assignableUsers: [{ userId: session.userId, label: session.email }],
          agents: [...AGENT_IDS],
        };
        sendJson(res, 200, body);
        return;
      }

      if (isWrite) {
        const patch = parseTaskUpdate(await readJsonBody(req, MAX_PROJECT_BODY_BYTES), context);
        const updated = (await tasks.update(ownerId, projectId, taskId, patch, session.userId)) ?? fail('not_found');
        deps.logger.log('info', 'Tarefa atualizada', { event: 'task_updated', projectId, taskId });
        sendJson(res, 200, updated);
        return;
      }
      sendJson(res, 200, tasks.get(ownerId, projectId, taskId) ?? fail('not_found'));
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
    let authenticated: Session | null = null;
    let rateLimited = false;
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
      if (!verdict.allowed) {
        // Requisições barradas pelo limite global não geram escrita em disco (evita amplificação).
        rateLimited = true;
        fail('too_many_requests', { retryAfterSeconds: verdict.retryAfterSeconds });
      }

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
        if (deps.audit) {
          try {
            await deps.audit.append({
              action: 'auth.login',
              actor: actorOf(result.session),
              ownerId: result.session.userId,
              projectId: null,
              resource: { type: 'session', id: null },
              outcome: 'success',
            });
          } catch {
            // Sem registro, não há login: a sessão recém-criada é revogada (falha fechada).
            auth.logout(`${auth.cookieName}=${result.token}`);
            fail('audit_unavailable');
          }
        }
        deps.logger.log('info', 'Login do administrador', { event: 'login_success' });
        sendJson(res, 200, sessionBody(result.session), { 'Set-Cookie': auth.sessionCookie(result.token) });
        return;
      }

      if (pathname === '/api/auth/logout') {
        assertOnlyParams(url, []);
        // O corpo não é usado, mas é validado com o mesmo limite (objeto JSON, normalmente `{}`).
        const logoutBody = await readJsonBody(req);
        if (typeof logoutBody !== 'object' || logoutBody === null || Array.isArray(logoutBody)) fail('bad_request');
        const leaving = auth.authenticate(cookieHeader)?.session ?? null;
        // A sessão é encerrada mesmo que a auditoria falhe (encerrar é a ação segura); nesse caso
        // a resposta é erro, nunca um sucesso sem registro.
        auth.logout(cookieHeader);
        errorHeaders['Set-Cookie'] = auth.clearedCookie();
        if (deps.audit) {
          try {
            await deps.audit.append({
              action: 'auth.logout',
              actor: leaving ? actorOf(leaving) : ANONYMOUS,
              ownerId: leaving?.userId ?? null,
              projectId: null,
              resource: { type: 'session', id: null },
              outcome: 'success',
              context: { hadSession: leaving !== null },
            });
          } catch {
            fail('audit_unavailable');
          }
        }
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
      authenticated = session;

      if (pathname === AUDIT_ROUTE) {
        const query = parseAuditQuery(url);
        // Filtro por projeto: o projeto precisa ser do usuário (o mesmo 404 de sempre, se não for).
        if (query.projectId !== undefined && !deps.projects?.get(session.userId, query.projectId)) fail('not_found');
        const sources = [deps.projects?.auditLog(), deps.tasks?.auditLog(), deps.audit?.log()].filter((x) => x !== undefined);
        const result = queryAudit(sources, {
          ...query,
          ownerId: session.userId,
          // Eventos sem dono (logins recusados, acessos anônimos negados) só para o administrador.
          includeInstanceEvents: session.userId === ADMIN_USER_ID,
        });
        const body: AuditListResponse = {
          events: result.events,
          nextBefore: result.nextBefore,
          retention: { droppedEvents: result.droppedEvents },
        };
        sendJson(res, 200, body);
        return;
      }

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
      const refusal = deps.audit && !rateLimited ? refusalEvent(req, pathname, integrationError.code, authenticated) : null;
      if (refusal && deps.audit) {
        try {
          await deps.audit.append(refusal);
        } catch {
          // A resposta já é de erro (nada foi alterado); a falha da auditoria vai para o log do servidor.
          deps.logger.log('error', 'Falha ao gravar evento de auditoria', { event: 'audit_write_failed', action: refusal.action });
        }
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
