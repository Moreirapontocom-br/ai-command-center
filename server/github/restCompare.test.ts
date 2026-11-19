// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createRestCompareClient, type FetchLike } from './client.ts';

/** Issue #008 — único GET REST (comparação de dois SHAs): erros e credencial, sem escrita. */

const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: Response[], invalidate?: () => void) {
  const fetchImpl = vi.fn<FetchLike>(async () => responses.shift()!);
  const credentials = { kind: 'gh-cli' as const, getAuthorizationHeader: vi.fn(async () => 'Bearer t'), ...(invalidate ? { invalidate } : {}) };
  return { c: createRestCompareClient({ credentials, fetchImpl, timeoutMs: 1000 }), fetchImpl, credentials };
}

describe('cliente REST da comparação', () => {
  it('200 → corpo para normalização; sempre GET na URL fechada com per_page=1', async () => {
    const { c, fetchImpl } = client([json(200, { status: 'ahead' })]);
    expect(await c.compare('o', 'r', BASE, HEAD)).toEqual({ status: 200, body: { status: 'ahead' } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/o/r/compare/${BASE}...${HEAD}?per_page=1`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('404 e 422 → sem prova (sem exceção)', async () => {
    expect(await client([json(404, {})]).c.compare('o', 'r', BASE, HEAD)).toEqual({ status: 404 });
    expect(await client([json(422, {})]).c.compare('o', 'r', BASE, HEAD)).toEqual({ status: 422 });
  });

  it('401 → uma renovação da credencial renovável e uma nova tentativa; persistindo → unauthorized', async () => {
    const invalidate = vi.fn();
    const renewed = client([json(401, {}), json(200, {})], invalidate);
    expect(await renewed.c.compare('o', 'r', BASE, HEAD)).toMatchObject({ status: 200 });
    expect(invalidate).toHaveBeenCalledTimes(1);
    await expect(client([json(401, {}), json(401, {})], vi.fn()).c.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('limite (403 com remaining=0, 429), 403 comum, 5xx e JSON inválido → erros tipados', async () => {
    await expect(client([json(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' })]).c.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(client([json(429, {}, { 'retry-after': '30' })]).c.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
    await expect(client([json(403, {})]).c.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(client([json(502, {})]).c.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'upstream_error' });
    await expect(client([new Response('not json', { status: 200 })]).c.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'upstream_invalid' });
  });

  it('rede e timeout → network/timeout; credencial indisponível → missing_credentials sem rede', async () => {
    const offline = createRestCompareClient({ credentials: { kind: 'gh-cli', getAuthorizationHeader: async () => 'Bearer t' }, fetchImpl: async () => Promise.reject(new TypeError('fetch failed')), timeoutMs: 1000 });
    await expect(offline.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'network' });
    const slow = createRestCompareClient({ credentials: { kind: 'gh-cli', getAuthorizationHeader: async () => 'Bearer t' }, fetchImpl: async () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })), timeoutMs: 1000 });
    await expect(slow.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'timeout' });
    const fetchImpl = vi.fn();
    const noCred = createRestCompareClient({ credentials: { kind: 'gh-cli', getAuthorizationHeader: async () => Promise.reject(new Error('x')) }, fetchImpl, timeoutMs: 1000 });
    await expect(noCred.compare('o', 'r', BASE, HEAD)).rejects.toMatchObject({ code: 'missing_credentials' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
