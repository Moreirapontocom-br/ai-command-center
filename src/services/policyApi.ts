import { POLICY_DECISIONS, type PolicyMatrixResponse } from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

/** Consulta somente leitura da política de autonomia do projeto (Issue #020). */
export async function fetchPolicyMatrix(projectId: string, signal?: AbortSignal): Promise<PolicyMatrixResponse> {
  const body = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/policy`, { signal });
  const ok =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as PolicyMatrixResponse).policyVersion === 'string' &&
    Array.isArray((body as PolicyMatrixResponse).subjects) &&
    (body as PolicyMatrixResponse).subjects.every(
      (s) => Array.isArray(s.evaluations) && s.evaluations.every((e) => (POLICY_DECISIONS as readonly string[]).includes(e.decision)),
    );
  if (!ok) throw new ApiClientError('upstream_invalid');
  return body as PolicyMatrixResponse;
}
