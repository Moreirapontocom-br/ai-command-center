// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createFineGrainedTokenProvider } from '../auth/credentials.ts';
import { CANARY_TOKEN, jsonResponse, rawSnapshot } from '../test/fixtures.ts';
import { createGraphQLClient, GITHUB_GRAPHQL_ENDPOINT, type FetchLike } from './client.ts';
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
      clientWith(() => Promise.resolve(jsonResponse({ message: 'Bad credentials' }, { status: 401 }))).query('query{x}', VARS),
    );
    expect(error.code).toBe('unauthorized');
    // A mensagem do GitHub não é repassada.
    expect(error.message).not.toContain('Bad credentials');
  });

  it('erro de permissão (403 sem indicação de limite)', async () => {
    const error = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({ message: 'Resource not accessible' }, { status: 403 }))).query('query{x}', VARS),
    );
    expect(error.code).toBe('forbidden');
  });

  it('repositório fora do escopo do token (NOT_FOUND no GraphQL)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(jsonResponse({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }] }));
    expect((await codeOf(clientWith(fetchImpl).query('query{x}', VARS))).code).toBe('forbidden');
  });

  it('limite primário (403 + x-ratelimit-remaining: 0) informa quando a cota volta', async () => {
    const error = await codeOf(
      clientWith(() =>
        Promise.resolve(
          jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794350400' } }),
        ),
      ).query('query{x}', VARS),
    );
    expect(error.code).toBe('rate_limited');
    expect(error.resetAt).toBe(new Date(1794350400 * 1000).toISOString());
  });

  it('limite secundário (429 + retry-after)', async () => {
    const error = await codeOf(
      clientWith(() => Promise.resolve(jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }))).query('query{x}', VARS),
    );
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
  });

  it('limite sinalizado no corpo GraphQL (RATE_LIMITED)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(jsonResponse({ data: { repository: null }, errors: [{ type: 'RATE_LIMITED' }] }));
    expect((await codeOf(clientWith(fetchImpl).query('query{x}', VARS))).code).toBe('rate_limited');
  });

  it('falha de conexão', async () => {
    const error = await codeOf(clientWith(() => Promise.reject(new TypeError('fetch failed'))).query('query{x}', VARS));
    expect(error.code).toBe('network');
  });

  it('tempo limite excedido', async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const error = await codeOf(clientWith(fetchImpl, 20).query('query{x}', VARS));
    expect(error.code).toBe('timeout');
  });

  it('resposta que não é JSON ou sem dados', async () => {
    const notJson: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }));
    expect((await codeOf(clientWith(notJson).query('query{x}', VARS))).code).toBe('upstream_invalid');

    const noData: FetchLike = () => Promise.resolve(jsonResponse({ errors: [{ type: 'SOMETHING' }] }));
    expect((await codeOf(clientWith(noData).query('query{x}', VARS))).code).toBe('upstream_invalid');
  });

  it('erro 5xx do GitHub', async () => {
    const error = await codeOf(clientWith(() => Promise.resolve(jsonResponse({}, { status: 502 }))).query('query{x}', VARS));
    expect(error.code).toBe('upstream_error');
  });

  it('devolve erros parciais junto com os dados', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(jsonResponse({ data: rawSnapshot(), errors: [{ type: 'FORBIDDEN', path: ['repository', 'refs'] }] }));
    const result = await clientWith(fetchImpl).query('query{x}', VARS);
    expect(result.partialErrors).toHaveLength(1);
  });
});
