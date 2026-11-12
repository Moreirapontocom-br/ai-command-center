import { describe, expect, it, vi } from 'vitest';
import { apiError, configuredStatus, json, snapshotReply } from '../test/githubFixtures';
import { ApiClientError, fetchSnapshot, fetchStatus } from './githubApi';

function stubFetch(reply: Response | Error) {
  const mock = vi.fn(() => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)));
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function errorCode(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiClientError);
  return (error as ApiClientError).code;
}

describe('githubApi', () => {
  it('consulta apenas endpoints internos de mesma origem', async () => {
    const mock = stubFetch(snapshotReply());
    await fetchSnapshot('Moreirapontocom-br/ai-command-center', { refresh: true });
    expect(mock).toHaveBeenCalledWith(
      '/api/repos/Moreirapontocom-br/ai-command-center/snapshot?refresh=1',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('lê o status da integração', async () => {
    stubFetch(json(configuredStatus));
    await expect(fetchStatus()).resolves.toEqual(configuredStatus);
  });

  it('propaga o código de erro normalizado do servidor', async () => {
    stubFetch(apiError('rate_limited', 429, { resetAt: '2026-11-10T21:00:00Z' }));
    const error = (await fetchSnapshot('a/b').catch((e: unknown) => e)) as ApiClientError;
    expect(error.code).toBe('rate_limited');
    expect(error.resetAt).toBe('2026-11-10T21:00:00Z');
  });

  it('falha de conexão com o servidor local', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    expect(await errorCode(fetchStatus())).toBe('server_unreachable');
  });

  it('resposta que não é JSON (servidor não iniciado / proxy ausente)', async () => {
    stubFetch(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await errorCode(fetchStatus())).toBe('server_unreachable');
    stubFetch(new Response('', { status: 502 }));
    expect(await errorCode(fetchStatus())).toBe('server_unreachable');
  });

  it('JSON em formato inesperado', async () => {
    stubFetch(json({ algo: 'diferente' }));
    expect(await errorCode(fetchStatus())).toBe('upstream_invalid');
    stubFetch(json({ snapshot: {} }));
    expect(await errorCode(fetchSnapshot('a/b'))).toBe('upstream_invalid');
  });
});
