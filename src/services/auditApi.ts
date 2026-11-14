import { AUDIT_ACTIONS, AUDIT_OUTCOMES, type AuditAction, type AuditListResponse, type AuditOutcome } from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

/** Consulta somente leitura do histórico de auditoria (Issue #006). Não existe escrita pelo navegador. */

export interface AuditFilters {
  projectId?: string;
  action?: AuditAction;
  outcome?: AuditOutcome;
  before?: number;
  limit?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEvent(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.seq === 'number' &&
    typeof value.at === 'string' &&
    (AUDIT_ACTIONS as readonly unknown[]).includes(value.action) &&
    (AUDIT_OUTCOMES as readonly unknown[]).includes(value.outcome) &&
    isObject(value.actor) &&
    isObject(value.resource) &&
    isObject(value.context)
  );
}

export async function fetchAudit(filters: AuditFilters = {}, signal?: AbortSignal): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(key, String(value));
  const query = params.toString();
  const body = await requestJson(`/api/audit${query ? `?${query}` : ''}`, { signal });
  if (
    !isObject(body) ||
    !Array.isArray(body.events) ||
    !body.events.every(isEvent) ||
    !(body.nextBefore === null || typeof body.nextBefore === 'number') ||
    !isObject(body.retention)
  ) {
    throw new ApiClientError('upstream_invalid');
  }
  return body as unknown as AuditListResponse;
}
