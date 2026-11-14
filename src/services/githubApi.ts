import type { SnapshotResponse, StatusResponse } from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

export { ApiClientError, type ClientErrorCode } from './apiClient';

/**
 * Cliente do servidor intermediário. O navegador NUNCA fala com api.github.com nem recebe
 * credenciais: só consulta os endpoints fixos de `/api` na própria origem.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStatusResponse(value: unknown): value is StatusResponse {
  return isObject(value) && typeof value.configured === 'boolean' && Array.isArray(value.repositories);
}

export function isSnapshotResponse(value: unknown): value is SnapshotResponse {
  return (
    isObject(value) &&
    isObject(value.snapshot) &&
    isObject(value.snapshot.metrics) &&
    Array.isArray(value.snapshot.issues) &&
    Array.isArray(value.snapshot.pullRequests) &&
    Array.isArray(value.snapshot.branches) &&
    isObject(value.freshness)
  );
}

export async function fetchStatus(signal?: AbortSignal): Promise<StatusResponse> {
  const body = await requestJson('/api/status', { signal });
  if (!isStatusResponse(body)) throw new ApiClientError('upstream_invalid');
  return body;
}

export async function fetchSnapshot(
  fullName: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<SnapshotResponse> {
  const [owner, repo] = fullName.split('/').map(encodeURIComponent);
  const query = options.refresh ? '?refresh=1' : '';
  const body = await requestJson(`/api/repos/${owner}/${repo}/snapshot${query}`, { signal: options.signal });
  if (!isSnapshotResponse(body)) throw new ApiClientError('upstream_invalid');
  return body;
}
