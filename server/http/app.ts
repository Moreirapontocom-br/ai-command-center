import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorBody, ApiErrorCode, StatusResponse } from '../../shared/contracts.ts';
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
  logger: Logger;
  now?: () => number;
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
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Sem cabeçalhos CORS: o navegador só acessa a API pela mesma origem (proxy do Vite).
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: IntegrationError) {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.resetAt ? { resetAt: error.resetAt } : {}),
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    },
  };
  const headers: Record<string, string> = error.code === 'method_not_allowed' ? { Allow: 'GET, HEAD' } : {};
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

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    let pathname = '';
    try {
      const url = new URL(req.url ?? '/', 'http://internal');
      pathname = url.pathname;

      if (req.method !== 'GET' && req.method !== 'HEAD') fail('method_not_allowed');
      assertTrustedRequest(req, deps);

      const client = req.socket.remoteAddress ?? 'unknown';
      const verdict = limiter.hit(client);
      if (!verdict.allowed) fail('too_many_requests', { retryAfterSeconds: verdict.retryAfterSeconds });

      if (pathname === '/api/status') {
        assertOnlyParams(url, []);
        const body: StatusResponse = {
          configured: deps.config.credentials !== null,
          authMode: deps.config.credentials?.kind ?? 'none',
          repositories: [...deps.config.allowedRepositories],
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
        });
      }
      sendError(res, integrationError);
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
