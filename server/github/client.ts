import type { CredentialProvider } from '../auth/credentials.ts';
import { IntegrationError } from './errors.ts';
import { MAIN_HEAD_QUERY, PR_VERIFICATION_QUERY, REPO_SNAPSHOT_QUERY } from './queries.ts';
import type { RawGraphQLError, RawGraphQLResponse } from './raw-types.ts';

export const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

/**
 * Allowlist ESTRITA de documentos GraphQL: o cliente só envia documentos idênticos aos aprovados.
 * É a barreira que mantém o servidor somente leitura mesmo quando a credencial pode escrever
 * (ex.: token OAuth do GitHub CLI com escopo `repo`). Incluir um documento exige revisão de PR.
 */
export const APPROVED_DOCUMENTS: ReadonlySet<string> = new Set([
  REPO_SNAPSHOT_QUERY,
  // Issue #008: SHA de `main` na preparação da ordem e leitura do PR na verificação (somente `query`).
  MAIN_HEAD_QUERY,
  PR_VERIFICATION_QUERY,
]);

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

// ---------- Issue #008: ÚNICO endpoint REST (GET) — comparação de dois SHAs (§6.4) ----------

/** Origem da API REST. Só a comparação abaixo é montada sobre ela; nenhuma outra rota REST existe. */
export const GITHUB_REST_ORIGIN = 'https://api.github.com';
/** Caminho FECHADO: `owner/repo` e dois SHAs completos (40 hex, minúsculos). */
export const REST_COMPARE_PATH = /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/;
/** Único parâmetro aceito: o veredito vem de status/ahead_by/behind_by/merge_base_commit (§6.4). */
export const REST_COMPARE_QUERY = '?per_page=1';
const REST_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REST_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const REST_SHA = /^[0-9a-f]{40}$/;

/** Monta a URL da comparação ou recusa ANTES de qualquer credencial ou rede. */
export function compareRequestUrl(owner: string, repo: string, baseSha: string, headSha: string): string {
  if (!REST_OWNER.test(owner) || !REST_REPO.test(repo) || repo === '.' || repo === '..' || !REST_SHA.test(baseSha) || !REST_SHA.test(headSha)) {
    throw new IntegrationError('internal', { reason: 'rest_request_not_allowed' });
  }
  const url = `${GITHUB_REST_ORIGIN}/repos/${owner}/${repo}/compare/${baseSha}...${headSha}${REST_COMPARE_QUERY}`;
  assertAllowedRestRequest('GET', url);
  return url;
}

/**
 * Allowlist REST: só `GET`, só a origem da API, só o caminho de comparação com SHAs completos e só
 * `per_page=1`. Qualquer outro método, caminho, parâmetro, fragmento ou credencial embutida → recusa.
 */
export function assertAllowedRestRequest(method: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new IntegrationError('internal', { reason: 'rest_request_not_allowed' });
  }
  const ok =
    method === 'GET' &&
    parsed.origin === GITHUB_REST_ORIGIN &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === '' &&
    parsed.search === REST_COMPARE_QUERY &&
    REST_COMPARE_PATH.test(parsed.pathname) &&
    url === `${parsed.origin}${parsed.pathname}${parsed.search}`;
  if (!ok) throw new IntegrationError('internal', { reason: 'rest_request_not_allowed' });
}

export type RestCompareResult = { status: 200; body: unknown } | { status: 404 | 422 };

export interface RestCompareClient {
  compare(owner: string, repo: string, baseSha: string, headSha: string): Promise<RestCompareResult>;
}

/**
 * Cliente da comparação REST (somente leitura). Mesma credencial e mesmas regras de erro do
 * cliente GraphQL: 401 → uma renovação (gh-cli); limite → `rate_limited`; 404/422 → sem prova.
 */
export function createRestCompareClient(options: GraphQLClientOptions): RestCompareClient {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  async function send(url: string): Promise<Response> {
    let authorization: string;
    try {
      authorization = await options.credentials.getAuthorizationHeader();
    } catch {
      throw new IntegrationError('missing_credentials', { reason: 'credential_unavailable' });
    }
    assertAllowedRestRequest('GET', url);
    try {
      return await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: authorization, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ai-command-center-readonly' },
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: 'error',
      });
    } catch (cause) {
      const isTimeout = cause instanceof Error && cause.name === 'TimeoutError';
      throw new IntegrationError(isTimeout ? 'timeout' : 'network', { cause });
    }
  }

  return {
    async compare(owner, repo, baseSha, headSha) {
      const url = compareRequestUrl(owner, repo, baseSha, headSha);
      let response = await send(url);
      if (response.status === 401 && options.credentials.invalidate) {
        await response.body?.cancel();
        options.credentials.invalidate();
        response = await send(url);
        if (response.status === 401) throw new IntegrationError('unauthorized', { reason: 'credential_rejected_after_renewal' });
      }
      if (response.status === 404 || response.status === 422) {
        await response.body?.cancel();
        return { status: response.status };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw errorFromHttpStatus(response);
      }
      try {
        return { status: 200, body: (await response.json()) as unknown };
      } catch (cause) {
        throw new IntegrationError('upstream_invalid', { cause });
      }
    },
  };
}
