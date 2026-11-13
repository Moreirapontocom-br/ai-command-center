import type { CredentialProvider } from '../auth/credentials.ts';
import { IntegrationError } from './errors.ts';
import { REPO_SNAPSHOT_QUERY } from './queries.ts';
import type { RawGraphQLError, RawGraphQLResponse } from './raw-types.ts';

export const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

/**
 * Allowlist ESTRITA de documentos GraphQL: o cliente só envia documentos idênticos aos aprovados.
 * É a barreira que mantém o servidor somente leitura mesmo quando a credencial pode escrever
 * (ex.: token OAuth do GitHub CLI com escopo `repo`). Incluir um documento exige revisão de PR.
 */
export const APPROVED_DOCUMENTS: ReadonlySet<string> = new Set([REPO_SNAPSHOT_QUERY]);

/** Um documento aprovado precisa ser uma única operação `query`, sem `mutation`/`subscription`. */
export function isReadOnlyDocument(document: string): boolean {
  return /^\s*query\b/.test(document) && !/\b(?:mutation|subscription)\b/i.test(document);
}

// Falha ao carregar o módulo se alguém aprovar um documento que não é somente leitura.
for (const document of APPROVED_DOCUMENTS) {
  if (!isReadOnlyDocument(document)) throw new Error('Documento GraphQL aprovado não é somente leitura.');
}

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

  if (status === 403) return new IntegrationError('forbidden', { reason: 'http_403' });
  return new IntegrationError('upstream_error');
}

function errorFromGraphQLErrors(errors: RawGraphQLError[], headers: Headers): IntegrationError {
  const types = new Set(errors.map((error) => error.type));
  if (types.has('RATE_LIMITED')) {
    return new IntegrationError('rate_limited', { resetAt: resetAtFromHeaders(headers) });
  }
  // Para tokens fine-grained, um repositório fora do escopo do token aparece como NOT_FOUND. Para o
  // navegador os dois casos são `forbidden` (não revela se o repositório existe); o motivo exato
  // fica só no log do servidor.
  if (types.has('FORBIDDEN')) return new IntegrationError('forbidden', { reason: 'graphql_forbidden' });
  if (types.has('NOT_FOUND')) return new IntegrationError('forbidden', { reason: 'graphql_not_found' });
  return new IntegrationError('upstream_invalid');
}

export function createGraphQLClient(options: GraphQLClientOptions): GraphQLClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function authorizationHeader(): Promise<string> {
    try {
      return await options.credentials.getAuthorizationHeader();
    } catch {
      // O erro do provedor nunca é repassado (não carrega saída de processos nem segredos).
      throw new IntegrationError('missing_credentials', { reason: 'credential_unavailable' });
    }
  }

  async function send(query: string, variables: Record<string, string | number>): Promise<Response> {
    const authorization = await authorizationHeader();
    try {
      return await fetchImpl(GITHUB_GRAPHQL_ENDPOINT, {
        method: 'POST', // GraphQL usa POST mesmo para leitura; a consulta enviada é sempre `query`.
        headers: {
          Authorization: authorization,
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
  }

  return {
    async query<T>(query: string, variables: Record<string, string | number>) {
      // Bloqueio antes de obter a credencial ou tocar a rede.
      if (!APPROVED_DOCUMENTS.has(query)) {
        throw new IntegrationError('internal', { reason: 'document_not_approved' });
      }

      let response = await send(query, variables);

      // Credencial renovável (ex.: GitHub CLI) recusada: UMA renovação e UMA nova tentativa.
      if (response.status === 401 && options.credentials.invalidate) {
        await response.body?.cancel();
        options.credentials.invalidate();
        response = await send(query, variables);
        if (response.status === 401) {
          throw new IntegrationError('unauthorized', { reason: 'credential_rejected_after_renewal' });
        }
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
