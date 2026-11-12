import type { ApiErrorCode, SnapshotResponse } from '../shared/contracts.ts';
import type { GraphQLClient } from './github/client.ts';
import { IntegrationError } from './github/errors.ts';
import { normalizeSnapshot } from './github/normalize.ts';
import { REPO_SNAPSHOT_QUERY } from './github/queries.ts';
import type { RawSnapshotData } from './github/raw-types.ts';

/** Falhas transitórias em que é aceitável servir o último snapshot bom, marcado como desatualizado. */
const STALE_FALLBACK_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'rate_limited',
  'network',
  'timeout',
  'upstream_error',
]);

interface CacheEntry {
  response: SnapshotResponse['snapshot'];
  fetchedAtMs: number;
}

export interface SnapshotServiceOptions {
  client: GraphQLClient;
  cacheTtlMs: number;
  minRefreshIntervalMs: number;
  now?: () => number;
}

export interface SnapshotService {
  /** `fullName` deve vir da lista autorizada (validada pela rota). */
  getSnapshot(fullName: string, options?: { refresh?: boolean }): Promise<SnapshotResponse>;
}

export function createSnapshotService(options: SnapshotServiceOptions): SnapshotService {
  const now = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const lastAttempt = new Map<string, number>();
  const inflight = new Map<string, Promise<SnapshotResponse>>();
  /** Última falha desde o último sucesso: mantém o snapshot em cache marcado como desatualizado. */
  const lastFailure = new Map<string, ApiErrorCode>();
  /** Enquanto o GitHub sinalizar limite, nenhuma nova chamada é feita para aquele repositório. */
  const blockedUntil = new Map<string, { untilMs: number; error: IntegrationError }>();

  async function fetchFresh(fullName: string): Promise<SnapshotResponse> {
    const [owner, name] = fullName.split('/');
    lastAttempt.set(fullName, now());
    try {
      const { data, partialErrors } = await options.client.query<RawSnapshotData>(REPO_SNAPSHOT_QUERY, {
        owner,
        name,
      });
      const snapshot = normalizeSnapshot(data, partialErrors, new Date(now()));
      cache.set(fullName, { response: snapshot, fetchedAtMs: now() });
      blockedUntil.delete(fullName);
      lastFailure.delete(fullName);
      return { snapshot, freshness: { stale: false, staleReason: null } };
    } catch (error) {
      const integrationError =
        error instanceof IntegrationError ? error : new IntegrationError('internal', { cause: error });
      lastFailure.set(fullName, integrationError.code);

      if (integrationError.code === 'rate_limited') {
        const resetMs = integrationError.resetAt ? Date.parse(integrationError.resetAt) : NaN;
        const retryMs = (integrationError.retryAfterSeconds ?? 60) * 1000;
        blockedUntil.set(fullName, {
          untilMs: Number.isFinite(resetMs) ? resetMs : now() + retryMs,
          error: integrationError,
        });
      }

      const cached = cache.get(fullName);
      if (cached && STALE_FALLBACK_CODES.has(integrationError.code)) {
        return { snapshot: cached.response, freshness: { stale: true, staleReason: integrationError.code } };
      }
      throw integrationError;
    }
  }

  return {
    async getSnapshot(fullName, { refresh = false } = {}) {
      const current = now();
      const cached = cache.get(fullName);

      const block = blockedUntil.get(fullName);
      if (block && current < block.untilMs) {
        if (cached) {
          return { snapshot: cached.response, freshness: { stale: true, staleReason: 'rate_limited' } };
        }
        throw block.error;
      }

      if (cached) {
        const fresh = current - cached.fetchedAtMs < options.cacheTtlMs;
        const throttled = current - (lastAttempt.get(fullName) ?? 0) < options.minRefreshIntervalMs;
        if ((fresh && !refresh) || throttled) {
          const failure = lastFailure.get(fullName) ?? null;
          return { snapshot: cached.response, freshness: { stale: failure !== null, staleReason: failure } };
        }
      }

      const pending = inflight.get(fullName);
      if (pending) return pending;

      const request = fetchFresh(fullName).finally(() => inflight.delete(fullName));
      inflight.set(fullName, request);
      return request;
    },
  };
}
