import {
  CLAUDE_ORDER_STATES,
  type ClaudeEnablementResponse,
  type ClaudeOrderListResponse,
  type ClaudeOrderPackageResponse,
  type ClaudeOrderResponse,
  type ClaudeOrderVerifyResponse,
  type ClaudeOrderView,
} from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

/**
 * Cliente das ordens do Claude Code (Issue #008). O navegador nunca escolhe repositório, branch, SHA,
 * capacidade nem dono: só envia o objetivo, os critérios e, quando exigido, a prova de confirmação
 * de identidade (`confirmIdentity`, de uso único). Nada aqui executa ou chama provedor.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const invalid = (): never => {
  throw new ApiClientError('upstream_invalid');
};

function isOrder(value: unknown): value is ClaudeOrderView {
  return (
    isObject(value) &&
    typeof value.orderId === 'string' &&
    typeof value.workBranch === 'string' &&
    typeof value.baseSha === 'string' &&
    (CLAUDE_ORDER_STATES as readonly unknown[]).includes(value.state) &&
    Array.isArray(value.approvals) &&
    Array.isArray(value.history) &&
    isObject(value.verification)
  );
}
const asOrder = (body: unknown): ClaudeOrderResponse => (isObject(body) && isOrder(body.order) ? (body as unknown as ClaudeOrderResponse) : invalid());

export async function listClaudeOrders(projectId: string, signal?: AbortSignal): Promise<ClaudeOrderListResponse> {
  const body = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/claude-orders`, { signal });
  if (!isObject(body) || !Array.isArray(body.orders) || !body.orders.every(isOrder) || !isObject(body.enablement) || !isObject(body.gateway)) invalid();
  return body as unknown as ClaudeOrderListResponse;
}

export async function createClaudeOrder(projectId: string, taskId: string, input: { idempotencyKey: string; objective: string; acceptanceCriteria: string[] }) {
  return asOrder(await requestJson(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/claude-orders`, { post: input }));
}

export async function setClaudeEnablement(projectId: string, input: { enabled: true; repository: string; proofId: string } | { enabled: false; proofId: string }): Promise<ClaudeEnablementResponse> {
  const body = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/claude-enablement`, { post: input });
  if (!isObject(body) || !isObject(body.enablement)) invalid();
  return body as unknown as ClaudeEnablementResponse;
}

/** Libera o pacote (step-up). O texto só vem nesta resposta e não é guardado pelo navegador. */
export async function releaseClaudePackage(orderId: string, proofId: string): Promise<ClaudeOrderPackageResponse> {
  const body = await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/package`, { post: { proofId } });
  if (!isObject(body) || !isOrder(body.order) || typeof body.package !== 'string') invalid();
  return body as unknown as ClaudeOrderPackageResponse;
}

export async function markClaudeForwarded(orderId: string) {
  return asOrder(await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/forwarded`, { post: {} }));
}

export async function linkClaudePullRequest(orderId: string, pullRequest: string, proofId: string) {
  return asOrder(await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/pr`, { post: { pullRequest, proofId } }));
}

export async function verifyClaudePullRequest(orderId: string): Promise<ClaudeOrderVerifyResponse> {
  const body = await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/verify`, { post: {} });
  if (!isObject(body) || !isOrder(body.order) || !isObject(body.outcome)) invalid();
  return body as unknown as ClaudeOrderVerifyResponse;
}

export async function cancelClaudeOrder(orderId: string, proofId: string) {
  return asOrder(await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/cancel`, { post: { proofId } }));
}
