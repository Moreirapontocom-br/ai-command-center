// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { GraphQLClient } from './github/client.ts';
import { IntegrationError } from './github/errors.ts';
import { createSnapshotService } from './snapshotService.ts';
import { rawSnapshot } from './test/fixtures.ts';

const REPO = 'Moreirapontocom-br/ai-command-center';

function setup() {
  let time = Date.parse('2026-11-10T20:00:00Z');
  const query = vi.fn<GraphQLClient['query']>();
  const service = createSnapshotService({
    client: { query } as GraphQLClient,
    cacheTtlMs: 60_000,
    minRefreshIntervalMs: 15_000,
    now: () => time,
  });
  return { service, query, advance: (ms: number) => (time += ms) };
}

const ok = () => Promise.resolve({ data: rawSnapshot() as never, partialErrors: [] });

describe('snapshotService', () => {
  it('consulta o GitHub com owner e nome separados e usa cache dentro do TTL', async () => {
    const { service, query, advance } = setup();
    query.mockImplementation(ok);

    const first = await service.getSnapshot(REPO);
    advance(30_000);
    const second = await service.getSnapshot(REPO);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual({ owner: 'Moreirapontocom-br', name: 'ai-command-center' });
    expect(first.freshness).toEqual({ stale: false, staleReason: null });
    expect(second.snapshot).toEqual(first.snapshot);
  });

  it('atualização manual respeita o intervalo mínimo entre consultas', async () => {
    const { service, query, advance } = setup();
    query.mockImplementation(ok);
    await service.getSnapshot(REPO);

    advance(5_000);
    await service.getSnapshot(REPO, { refresh: true });
    expect(query).toHaveBeenCalledTimes(1);

    advance(15_000);
    await service.getSnapshot(REPO, { refresh: true });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('agrupa requisições simultâneas em uma única consulta', async () => {
    const { service, query } = setup();
    query.mockImplementation(ok);
    await Promise.all([service.getSnapshot(REPO), service.getSnapshot(REPO), service.getSnapshot(REPO)]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('serve o último snapshot marcado como desatualizado quando a rede falha', async () => {
    const { service, query, advance } = setup();
    query.mockImplementationOnce(ok).mockRejectedValueOnce(new IntegrationError('network'));
    const good = await service.getSnapshot(REPO);

    advance(61_000);
    const stale = await service.getSnapshot(REPO);
    expect(stale.freshness).toEqual({ stale: true, staleReason: 'network' });
    expect(stale.snapshot.fetchedAt).toBe(good.snapshot.fetchedAt);

    // Dentro do intervalo mínimo, continua sinalizando que os dados estão desatualizados.
    advance(1_000);
    expect((await service.getSnapshot(REPO, { refresh: true })).freshness.stale).toBe(true);
  });

  it('não serve cache quando a credencial passa a ser recusada', async () => {
    const { service, query, advance } = setup();
    query.mockImplementationOnce(ok).mockRejectedValueOnce(new IntegrationError('unauthorized'));
    await service.getSnapshot(REPO);
    advance(61_000);
    await expect(service.getSnapshot(REPO)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('após limite de requisições, não consulta o GitHub até o horário de reset', async () => {
    const { service, query, advance } = setup();
    const resetAt = new Date(Date.parse('2026-11-10T20:00:00Z') + 10 * 60_000).toISOString();
    query.mockRejectedValueOnce(new IntegrationError('rate_limited', { resetAt })).mockImplementation(ok);

    await expect(service.getSnapshot(REPO)).rejects.toMatchObject({ code: 'rate_limited', resetAt });
    advance(60_000);
    await expect(service.getSnapshot(REPO, { refresh: true })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(query).toHaveBeenCalledTimes(1);

    advance(10 * 60_000);
    await expect(service.getSnapshot(REPO)).resolves.toMatchObject({ freshness: { stale: false } });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('erros inesperados viram "internal" sem vazar detalhes', async () => {
    const { service, query } = setup();
    query.mockRejectedValueOnce(new Error('detalhe interno'));
    await expect(service.getSnapshot(REPO)).rejects.toMatchObject({ code: 'internal' });
  });
});
