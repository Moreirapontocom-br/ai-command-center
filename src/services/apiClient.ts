import type { ApiErrorBody, ApiErrorCode } from '../../shared/contracts.ts';

/**
 * Único ponto do frontend que faz `fetch`. Só fala com `/api` na própria origem: o cookie de
 * sessão (HttpOnly) é enviado pelo navegador automaticamente (`credentials` padrão, same-origin).
 * O frontend nunca lê, guarda nem monta credenciais.
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

export async function requestJson(
  path: string,
  options: { signal?: AbortSignal; post?: unknown } = {},
): Promise<unknown> {
  const { signal, post } = options;
  const init: RequestInit =
    post === undefined
      ? { headers: { Accept: 'application/json' }, signal }
      : {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(post),
          signal,
        };
  let response: Response;
  try {
    response = await fetch(path, init);
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

