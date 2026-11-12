// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFineGrainedTokenProvider } from '../auth/credentials.ts';
import { CANARY_TOKEN, jsonResponse, rawSnapshot } from '../test/fixtures.ts';
import { APPROVED_DOCUMENTS, createGraphQLClient, GITHUB_GRAPHQL_ENDPOINT, isReadOnlyDocument, type FetchLike } from './client.ts';
import type { IntegrationError } from './errors.ts';
import { REPO_SNAPSHOT_QUERY } from './queries.ts';

function clientWith(fetchImpl: FetchLike, timeoutMs = 1000) {
  return createGraphQLClient({ credentials: createFineGrainedTokenProvider(CANARY_TOKEN), fetchImpl, timeoutMs });
}

const VARS = { owner: 'Moreirapontocom-br', name: 'ai-command-center' };

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; resetAt?: string; retryAfterSeconds?: number; message: string };
  }
  throw new Error('esperava falha');
}

describe('cliente GraphQL do GitHub', () => {
  it('envia apenas a consulta fixa, com o token somente no cabeçalho Authorization', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse({ data: rawSnapshot() }));
    const result = await clientWith(fetchImpl).query(REPO_SNAPSHOT_QUERY, VARS);

    expect(result.data).toMatchObject({ repository: { nameWithOwner: 'Moreirapontocom-br/ai-command-center' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(GITHUB_GRAPHQL_ENDPOINT);
    expect(url).not.toContain(CANARY_TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CANARY_TOKEN}`);
    expect(String(init.body)).not.toContain(CANARY_TOKEN);
    expect(JSON.parse(String(init.body)).variables).toEqual(VARS);
  });

  it('a consulta do snapshot é somente leitura', () => {
    expect(REPO_SNAPSHOT_QUERY.trim().startsWith('query ')).toBe(true);
    expect(REPO_SNAPSHOT_QUERY).not.toMatch(/\bmutation\b/i);
  });

  it('falha de autenticação (401)', async () => {
    const error = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({ message: 'Bad credentials' }, { status: 401 }))).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    expect(error.code).toBe('unauthorized');
    // A mensagem do GitHub não é repassada.
    expect(error.message).not.toContain('Bad credentials');
  });

  it('erro de permissão (403 sem indicação de limite)', async () => {
    const error = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({ message: 'Resource not accessible' }, { status: 403 }))).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    expect(error.code).toBe('forbidden');
  });

  it('repositório fora do escopo do token (NOT_FOUND no GraphQL)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(jsonResponse({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    expect((await codeOf(clientWith(fetchImpl).query(REPO_SNAPSHOT_QUERY, VARS))).code).toBe('forbidden');
  });

  it('limite primário (403 + x-ratelimit-remaining: 0) informa quando a cota volta', async () => {
    const error = await codeOf(
      clientWith(() =>
        Promise.resolve(
          jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794350400' } }),
        ),
      ).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    expect(error.code).toBe('rate_limited');
    expect(error.resetAt).toBe(new Date(1794350400 * 1000).toISOString());
  });

  it('limite secundário (429 + retry-after)', async () => {
    const error = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }))).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('limite sinalizado no corpo GraphQL (RATE_LIMITED)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(jsonResponse({ data: { repository: null }, errors: [{ type: 'RATE_LIMITED' }] }));
    expect((await codeOf(clientWith(fetchImpl).query(REPO_SNAPSHOT_QUERY, VARS))).code).toBe('rate_limited');
  });

  it('falha de conexão', async () => {
    const error = await codeOf(clientWith(() => Promise.reject(new TypeError('fetch failed'))).query(REPO_SNAPSHOT_QUERY, VARS));
    expect(error.code).toBe('network');
  });

  it('tempo limite excedido', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const error = await codeOf(clientWith(fetchImpl, 20).query(REPO_SNAPSHOT_QUERY, VARS));
    expect(error.code).toBe('timeout');
  });

  it('resposta que não é JSON ou sem dados', async () => {
    const notJson: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }));
    expect((await codeOf(clientWith(notJson).query(REPO_SNAPSHOT_QUERY, VARS))).code).toBe('upstream_invalid');

    const noData: FetchLike = () => Promise.resolve(jsonResponse({ errors: [{ type: 'SOMETHING' }] }));
    expect((await codeOf(clientWith(noData).query(REPO_SNAPSHOT_QUERY, VARS))).code).toBe('upstream_invalid');
  });

  it('erro 5xx do GitHub', async () => {
    const error = await codeOf(clientWith(() => Promise.resolve(jsonResponse({}, { status: 502 }))).query(REPO_SNAPSHOT_QUERY, VARS));
    expect(error.code).toBe('upstream_error');
  });

  it('diferencia internamente NOT_FOUND, FORBIDDEN e HTTP 403, com a mesma mensagem externa', async () => {
    const notFound = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({ data: null, errors: [{ type: 'NOT_FOUND' }] }))).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    const forbidden = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({ data: null, errors: [{ type: 'FORBIDDEN' }] }))).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    const http403 = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({}, { status: 403 }))).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    expect([notFound, forbidden, http403].map((e) => (e as unknown as IntegrationError).reason)).toEqual([
      'graphql_not_found',
      'graphql_forbidden',
      'http_403',
    ]);
    expect(new Set([notFound.code, forbidden.code, http403.code])).toEqual(new Set(['forbidden']));
    expect(new Set([notFound.message, forbidden.message, http403.message]).size).toBe(1);
  });

  it('devolve erros parciais junto com os dados', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(jsonResponse({ data: rawSnapshot(), errors: [{ type: 'FORBIDDEN', path: ['repository', 'refs'] }] }));
    const result = await clientWith(fetchImpl).query(REPO_SNAPSHOT_QUERY, VARS);
    expect(result.partialErrors).toHaveLength(1);
  });
});

describe('allowlist de documentos GraphQL', () => {
  it('aprova somente a consulta do snapshot, que é somente leitura', () => {
    expect([...APPROVED_DOCUMENTS]).toEqual([REPO_SNAPSHOT_QUERY]);
    expect(isReadOnlyDocument(REPO_SNAPSHOT_QUERY)).toBe(true);
    expect(isReadOnlyDocument('mutation { addStar(input: {}) { clientMutationId } }')).toBe(false);
    expect(isReadOnlyDocument('query { x } mutation { y }')).toBe(false);
    expect(isReadOnlyDocument('subscription { x }')).toBe(false);
    expect(isReadOnlyDocument('{ viewer { login } }')).toBe(false);
  });

  it.each([
    ['consulta arbitrária', 'query { viewer { login } }'],
    ['mutation', 'mutation { createIssue(input: {repositoryId: "x", title: "y"}) { issue { id } } }'],
    ['consulta aprovada com mutation anexada', `${REPO_SNAPSHOT_QUERY}\nmutation { x }`],
    ['consulta aprovada com espaço extra', ` ${REPO_SNAPSHOT_QUERY}`],
  ])('bloqueia %s antes de obter a credencial ou tocar a rede', async (_label, document) => {
    const fetchImpl = vi.fn<FetchLike>();
    const credentials = { kind: 'gh-cli' as const, getAuthorizationHeader: vi.fn(() => Promise.resolve('Bearer x')) };
    const error = await codeOf(createGraphQLClient({ credentials, fetchImpl, timeoutMs: 1000 }).query(document, VARS));
    expect(error.code).toBe('internal');
    expect((error as unknown as IntegrationError).reason).toBe('document_not_approved');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(credentials.getAuthorizationHeader).not.toHaveBeenCalled();
  });
});

describe('renovação de credencial após HTTP 401', () => {
  function renewable(...tokens: string[]) {
    let i = 0;
    return {
      kind: 'gh-cli' as const,
      getAuthorizationHeader: vi.fn(() => Promise.resolve(`Bearer ${tokens[Math.min(i, tokens.length - 1)]}`)),
      invalidate: vi.fn(() => {
        i += 1;
      }),
    };
  }
  const unauthorized = () => Promise.resolve(jsonResponse({ message: 'Bad credentials' }, { status: 401 }));
  const ok = () => Promise.resolve(jsonResponse({ data: rawSnapshot() }));

  it('renova uma vez e repete a consulta com a nova credencial', async () => {
    const credentials = renewable('gho_OLD', 'gho_NEW');
    const fetchImpl = vi.fn<FetchLike>().mockImplementationOnce(unauthorized).mockImplementationOnce(ok);
    const result = await createGraphQLClient({ credentials, fetchImpl, timeoutMs: 1000 }).query(REPO_SNAPSHOT_QUERY, VARS);

    expect(result.data).toBeTruthy();
    expect(credentials.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe('Bearer gho_NEW');
  });

  it('se o GitHub recusar de novo, para: uma renovação, uma nova tentativa, sem loop', async () => {
    const credentials = renewable('gho_OLD', 'gho_NEW');
    const fetchImpl = vi.fn<FetchLike>(unauthorized);
    const error = await codeOf(createGraphQLClient({ credentials, fetchImpl, timeoutMs: 1000 }).query(REPO_SNAPSHOT_QUERY, VARS));

    expect(error.code).toBe('unauthorized');
    expect((error as unknown as IntegrationError).reason).toBe('credential_rejected_after_renewal');
    expect(error.message).not.toContain('Bad credentials');
    expect(credentials.invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a nova tentativa segue o tratamento normal de erros (ex.: 403)', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementationOnce(unauthorized).mockResolvedValueOnce(jsonResponse({}, { status: 403 }));
    const error = await codeOf(
      createGraphQLClient({ credentials: renewable('a', 'b'), fetchImpl, timeoutMs: 1000 }).query(REPO_SNAPSHOT_QUERY, VARS),
    );
    expect(error.code).toBe('forbidden');
  });

  it('credencial não renovável (fine-grained) não repete a consulta', async () => {
    const fetchImpl = vi.fn<FetchLike>(unauthorized);
    expect((await codeOf(clientWith(fetchImpl).query(REPO_SNAPSHOT_QUERY, VARS))).code).toBe('unauthorized');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falha ao obter a credencial vira "missing_credentials" sem tocar a rede nem repassar o erro', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const credentials = {
      kind: 'gh-cli' as const,
      getAuthorizationHeader: () => Promise.reject(new Error(`gh: detalhe interno ${CANARY_TOKEN}`)),
    };
    const error = await codeOf(createGraphQLClient({ credentials, fetchImpl, timeoutMs: 1000 }).query(REPO_SNAPSHOT_QUERY, VARS));
    expect(error.code).toBe('missing_credentials');
    expect((error as unknown as IntegrationError).reason).toBe('credential_unavailable');
    expect(error.message).not.toContain(CANARY_TOKEN);
    expect((error as unknown as Error).cause).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
