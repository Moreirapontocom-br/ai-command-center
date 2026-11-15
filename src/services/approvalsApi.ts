import {
  APPROVAL_STATE_NAMES,
  type ApprovalDetailResponse,
  type ApprovalHistoryResponse,
  type ApprovalHoldReason,
  type ApprovalHoldView,
  type ApprovalListResponse,
  type StepUpResponse,
} from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

/**
 * Cliente das aprovações humanas (Issue #011, PR 2). O navegador nunca informa quem aprova: a
 * identidade é a da sessão (cookie HttpOnly). Toda decisão leva a prova de confirmação de
 * identidade (`confirmIdentity`), de uso único, e — ao aprovar/rejeitar — o resumo do vínculo que
 * o próprio navegador recalculou a partir do que exibiu.
 */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const invalid = (): never => {
  throw new ApiClientError('upstream_invalid');
};

function asDetail(body: unknown): ApprovalDetailResponse {
  if (!isObject(body) || !isObject(body.approval) || typeof body.approval.id !== 'string' || !(APPROVAL_STATE_NAMES as readonly unknown[]).includes(body.approval.state)) invalid();
  return body as unknown as ApprovalDetailResponse;
}

export async function fetchApprovals(signal?: AbortSignal): Promise<ApprovalListResponse> {
  const body = await requestJson('/api/approvals', { signal });
  if (!isObject(body) || !isObject(body.subsystem) || !Array.isArray(body.approvals)) invalid();
  return body as unknown as ApprovalListResponse;
}

export async function fetchApproval(approvalId: string, signal?: AbortSignal): Promise<ApprovalDetailResponse> {
  return asDetail(await requestJson(`/api/approvals/${encodeURIComponent(approvalId)}`, { signal }));
}

export async function fetchApprovalHistory(signal?: AbortSignal): Promise<ApprovalHistoryResponse> {
  const body = await requestJson('/api/approvals/history', { signal });
  if (!isObject(body) || !Array.isArray(body.items) || typeof body.retentionDays !== 'number') invalid();
  return body as unknown as ApprovalHistoryResponse;
}

/** Confirma a identidade com a senha; devolve uma prova de uso único (≤ 5 min, só esta sessão). */
export async function confirmIdentity(password: string): Promise<StepUpResponse> {
  const body = await requestJson('/api/approvals/step-up', { post: { password } });
  if (!isObject(body) || typeof body.proofId !== 'string') invalid();
  return body as unknown as StepUpResponse;
}

export async function approveApproval(approvalId: string, bindingDigest: string, proofId: string) {
  return asDetail(await requestJson(`/api/approvals/${encodeURIComponent(approvalId)}/approve`, { post: { bindingDigest, proofId } }));
}

export async function rejectApproval(approvalId: string, bindingDigest: string, proofId: string) {
  return asDetail(await requestJson(`/api/approvals/${encodeURIComponent(approvalId)}/reject`, { post: { bindingDigest, proofId } }));
}

export async function revokeApproval(approvalId: string, proofId: string) {
  return asDetail(await requestJson(`/api/approvals/${encodeURIComponent(approvalId)}/revoke`, { post: { proofId } }));
}

export async function acknowledgeAttempt(attemptId: string, proofId: string) {
  return requestJson(`/api/approvals/attempts/${encodeURIComponent(attemptId)}/acknowledge`, { post: { proofId } });
}

export async function changeRetention(days: number, proofId: string) {
  return asDetail(await requestJson('/api/approvals/owner-confirmations', { post: { operation: 'approvals.retention_change', days, proofId } }));
}

export async function purgeHistory(before: string, proofId: string) {
  return asDetail(await requestJson('/api/approvals/history/purge', { post: { before, proofId } }));
}

export async function addHold(approvalId: string, reason: ApprovalHoldReason, note: string | null, proofId: string) {
  const body = await requestJson('/api/approvals/history/holds', { post: { approvalId, reason, note, proofId } });
  if (!isObject(body) || !Array.isArray(body.holds)) invalid();
  return (body as { holds: ApprovalHoldView[] }).holds;
}

export async function removeHold(holdId: string, proofId: string) {
  const body = await requestJson(`/api/approvals/history/holds/${encodeURIComponent(holdId)}/remove`, { post: { proofId } });
  if (!isObject(body) || !Array.isArray(body.holds)) invalid();
  return (body as { holds: ApprovalHoldView[] }).holds;
}
