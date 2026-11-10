import type {
  ApiErrorBody,
  ApiErrorCode,
  SnapshotResponse,
  StatusResponse,
} from '../../shared/contracts.ts';

/**
 * Cliente do servidor intermediário. O navegador NUNCA fala com api.github.com nem recebe
 * credenciais: só consulta os endpoints fixos de `/api` na própria origem.
 */

/** `server_unreachable`: o servidor intermediário não respondeu (não iniciado, proxy ausente, rede). */
export type ClientErrorCode = ApiErrorCode | 'server_unreachable';

export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly resetAt: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ClientErrorCode, details: { resetAt?: string; retryAfterSeconds?: number } = {}) {
    super(code);
    this.name = 'ApiClientError';
    this.code = code;
    this.resetAt = details.resetAt;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return isObject(value) && isObject(value.error) && typeof value.error.code === 'string';
}

function isStatusResponse(value: unknown): value is StatusResponse {
  return isObject(value) && typeof value.configured === 'boolean' && Array.isArray(value.repositories);
}

function isSnapshotResponse(value: unknown): value is SnapshotResponse {
  return (
    isObject(value) &&
    isObject(value.snapshot) &&
    isObject(value.snapshot.metrics) &&
    Array.isArray(value.snapshot.issues) &&
    Array.isArray(value.snapshot.pullRequests) &&
    Array.isArray(value.snapshot.branches) &&
    isObject(value.freshness)
  );
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('server_unreachable');
  }

  // Sem o servidor, o proxy do Vite responde com erro sem JSON (ou o host estático devolve HTML).
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new ApiClientError('server_unreachable');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiClientError('server_unreachable');
  }

  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new ApiClientError(body.error.code, {
        resetAt: body.error.resetAt,
        retryAfterSeconds: body.error.retryAfterSeconds,
      });
    }
    throw new ApiClientError('server_unreachable');
  }
  return body;
}

export async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const body = await getJson('/api/status', signal);
  if (!isStatusResponse(body)) throw new ApiClientError('upstream_invalid');
  return body;
}

export async function fetchSnapshot(
  fullName: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<SnapshotResponse> {
  const [owner, repo] = fullName.split('/').map(encodeURIComponent);
  const query = options.refresh ? '?refresh=1' : '';
  const body = await getJson(`/api/repos/${owner}/${repo}/snapshot${query}`, options.signal);
  if (!isSnapshotResponse(body)) throw new ApiClientError('upstream_invalid');
  return body;
}
