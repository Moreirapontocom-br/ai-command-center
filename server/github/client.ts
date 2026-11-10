import type { CredentialProvider } from '../auth/credentials.ts';
import { IntegrationError } from './errors.ts';
import type { RawGraphQLError, RawGraphQLResponse } from './raw-types.ts';

export const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GraphQLClientOptions {
  credentials: CredentialProvider;
  fetchImpl?: FetchLike;
  timeoutMs: number;
}

export interface GraphQLResult<T> {
  data: T;
  /** Erros parciais: a consulta teve dados, mas algum campo não pôde ser lido. */
  partialErrors: RawGraphQLError[];
}

export interface GraphQLClient {
  query<T>(query: string, variables: Record<string, string | number>): Promise<GraphQLResult<T>>;
}

function resetAtFromHeaders(headers: Headers): string | undefined {
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
}

function retryAfterFromHeaders(headers: Headers): number | undefined {
  const value = Number(headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function errorFromHttpStatus(response: Response): IntegrationError {
  const { status, headers } = response;
  if (status === 401) return new IntegrationError('unauthorized');

  // Limite primário (remaining=0) ou secundário (retry-after / 429), conforme a documentação do GitHub.
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')));
  if (rateLimited) {
    return new IntegrationError('rate_limited', {
      resetAt: resetAtFromHeaders(headers),
      retryAfterSeconds: retryAfterFromHeaders(headers),
    });
  }

  if (status === 403) return new IntegrationError('forbidden');
  return new IntegrationError('upstream_error');
}

function errorFromGraphQLErrors(errors: RawGraphQLError[], headers: Headers): IntegrationError {
  const types = new Set(errors.map((error) => error.type));
  if (types.has('RATE_LIMITED')) {
    return new IntegrationError('rate_limited', { resetAt: resetAtFromHeaders(headers) });
  }
  // Para tokens fine-grained, um repositório fora do escopo do token aparece como NOT_FOUND.
  if (types.has('NOT_FOUND') || types.has('FORBIDDEN')) return new IntegrationError('forbidden');
  return new IntegrationError('upstream_invalid');
}

export function createGraphQLClient(options: GraphQLClientOptions): GraphQLClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async query<T>(query: string, variables: Record<string, string | number>) {
      let response: Response;
      try {
        response = await fetchImpl(GITHUB_GRAPHQL_ENDPOINT, {
          method: 'POST', // GraphQL usa POST mesmo para leitura; a consulta enviada é sempre `query`.
          headers: {
            Authorization: await options.credentials.getAuthorizationHeader(),
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github+json',
            'User-Agent': 'ai-command-center-readonly',
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(options.timeoutMs),
          redirect: 'error',
        });
      } catch (cause) {
        const isTimeout = cause instanceof Error && cause.name === 'TimeoutError';
        throw new IntegrationError(isTimeout ? 'timeout' : 'network', { cause });
      }

      if (!response.ok) throw errorFromHttpStatus(response);

      let body: RawGraphQLResponse<T>;
      try {
        body = (await response.json()) as RawGraphQLResponse<T>;
      } catch (cause) {
        throw new IntegrationError('upstream_invalid', { cause });
      }
      if (body === null || typeof body !== 'object') throw new IntegrationError('upstream_invalid');

      const errors = Array.isArray(body.errors) ? body.errors : [];
      const data = body.data;
      if (data === null || data === undefined || typeof data !== 'object') {
        throw errorFromGraphQLErrors(errors, response.headers);
      }
      if (errors.some((error) => error.type === 'RATE_LIMITED')) {
        throw errorFromGraphQLErrors(errors, response.headers);
      }

      return { data, partialErrors: errors };
    },
  };
}
