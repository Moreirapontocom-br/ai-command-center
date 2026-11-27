import {
  CLAUDE_ORDER_STATES,
  type ClaudeBridgeCredentialResponse,
  type ClaudeBridgeCredentialView,
  type ClaudeOrderConfirmResponse,
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
  if (!isObject(body) || !Array.isArray(body.orders) || !body.orders.every(isOrder) || !isObject(body.enablement) || !isObject(body.gateway) || !isObject(body.bridge)) invalid();
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

// ---------- Issue #055: ponte MCP local ----------

/** Disponibiliza a ordem ao Claude Code pela ponte (step-up). O pacote NÃO volta ao navegador. */
export async function offerClaudeOrder(orderId: string, proofId: string) {
  return asOrder(await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/offer`, { post: { proofId } }));
}

/** Confirma o PR PROPOSTO pelo agente (step-up): vincula e, na mesma ação, verifica (somente leitura). */
export async function confirmClaudeProposal(orderId: string, proposalId: string, proofId: string): Promise<ClaudeOrderConfirmResponse> {
  const body = await requestJson(`/api/claude-orders/${encodeURIComponent(orderId)}/confirm-pr`, { post: { proposalId, proofId } });
  if (!isObject(body) || !isOrder(body.order) || !(body.outcome === null || isObject(body.outcome))) invalid();
  return body as unknown as ClaudeOrderConfirmResponse;
}

/** Cria a credencial local da ponte (aprovação de configuração + step-up). O token vem SÓ aqui. */
export async function createBridgeCredential(projectId: string, validityDays: number, proofId: string): Promise<ClaudeBridgeCredentialResponse> {
  const body = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/claude-bridge/credentials`, { post: { validityDays, proofId } });
  if (!isObject(body) || !isObject(body.credential) || typeof body.token !== 'string' || typeof body.command !== 'string') invalid();
  return body as unknown as ClaudeBridgeCredentialResponse;
}

export async function revokeBridgeCredential(projectId: string, credentialId: string, proofId: string): Promise<{ credential: ClaudeBridgeCredentialView }> {
  const body = await requestJson(`/api/projects/${encodeURIComponent(projectId)}/claude-bridge/credentials/${encodeURIComponent(credentialId)}/revoke`, { post: { proofId } });
  if (!isObject(body) || !isObject(body.credential)) invalid();
  return body as unknown as { credential: ClaudeBridgeCredentialView };
}
