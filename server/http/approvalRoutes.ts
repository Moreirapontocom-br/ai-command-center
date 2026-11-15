import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  APPROVAL_HOLD_REASONS,
  AUDIT_QUERY_LIMITS,
  type ApiErrorCode,
  type ApprovalAttemptView,
  type ApprovalDetail,
  type ApprovalDetailResponse,
  type ApprovalHistoryItemView,
  type ApprovalHistoryResponse,
  type ApprovalHoldView,
  type ApprovalListResponse,
  type ApprovalSummary,
  type AuditOutcome,
  type StepUpResponse,
} from '../../shared/contracts.ts';
import { bindingDigest } from '../approvals/binding.ts';
import { ApprovalError, HISTORY_RETENTION_DAYS, HOLD_NOTE_MAX, type LedgerApproval, type LedgerAttempt } from '../approvals/contracts.ts';
import type { IdentityContext, StepUpRegistry } from '../approvals/identity.ts';
import type { ApprovalService } from '../approvals/service.ts';
import { ADMIN_USER_ID } from '../auth/adminAuth.ts';
import type { Session } from '../auth/sessions.ts';
import type { AuditLog } from '../audit/auditLog.ts';
import type { AuditEventInput } from '../audit/events.ts';
import { IntegrationError } from '../github/errors.ts';
import type { Logger } from '../logger.ts';
import type { ProjectStore } from '../projects/projectStore.ts';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';

/**
 * Rotas de aprovação humana (Issue #011, PR 2). Todas exigem a sessão do administrador; as de
 * escrita (POST) passam antes pela proteção CSRF/Origin/JSON do `app.ts`.
 *
 * - A IDENTIDADE vem sempre da sessão: `userId` da sessão e `sessionKey` = SHA-256 do token do
 *   cookie. Nenhum corpo aceita `userId`, `approvedBy`, `ownerId` ou indicação de administrador
 *   (corpos com chaves fechadas: qualquer campo extra → 400).
 * - Decidir, revogar, reconhecer, preservar e configurar exigem prova de confirmação de identidade
 *   (senha, `POST /api/approvals/step-up`): uso único, presa à sessão, válida por 5 minutos, com
 *   bloqueio após 5 falhas. A prova nunca vai para logs nem para a auditoria.
 * - Aprovar exige o `bindingDigest` que o navegador recalculou a partir do que exibiu.
 * - Não há rota que execute agentes, admita operações, inicie sandbox, acione ou libere o kill
 *   switch (N9) ou altere limites. Aprovar nunca torna disponível uma capacidade indisponível.
 * - Histórico oficial = o do núcleo (encadeado, na mesma gravação atômica da decisão). A auditoria
 *   da #006 recebe um espelho; a falha do espelho é registrada no log e não desfaz nada.
 */

export interface ApprovalsRuntime {
  service: ApprovalService;
  identity: StepUpRegistry;
}

export interface ApprovalRouteIo {
  readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  assertOnlyParams(url: URL, allowed: string[]): void;
}

const LIST = '/api/approvals';
const STEP_UP = '/api/approvals/step-up';
const OWNER_CONFIRMATIONS = '/api/approvals/owner-confirmations';
const HISTORY = '/api/approvals/history';
const HOLDS = '/api/approvals/history/holds';
const PURGE = '/api/approvals/history/purge';
const HOLD_REMOVE = /^\/api\/approvals\/history\/holds\/([^/]+)\/remove$/;
const ATTEMPT_ACK = /^\/api\/approvals\/attempts\/([^/]+)\/acknowledge$/;
const ITEM_ACTION = /^\/api\/approvals\/([^/]+)\/(approve|reject|revoke)$/;
const ITEM = /^\/api\/approvals\/([^/]+)$/;

export const APPROVAL_POST_ROUTES: readonly string[] = Object.freeze([
  STEP_UP,
  '/api/approvals/:id/approve',
  '/api/approvals/:id/reject',
  '/api/approvals/:id/revoke',
  OWNER_CONFIRMATIONS,
  '/api/approvals/attempts/:id/acknowledge',
  HOLDS,
  '/api/approvals/history/holds/:id/remove',
  PURGE,
]);

const POST_LITERALS = [STEP_UP, OWNER_CONFIRMATIONS, HOLDS, PURGE];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4096;
const MAX_CONCURRENT_STEP_UPS = 2;

export const isApprovalPath = (pathname: string) => pathname === LIST || pathname.startsWith(`${LIST}/`);

/** Métodos aceitos por um caminho de aprovações (`null` se não for de aprovações). */
export function approvalMethods(pathname: string): readonly string[] | null {
  if (!isApprovalPath(pathname)) return null;
  if (POST_LITERALS.includes(pathname) || HOLD_REMOVE.test(pathname) || ATTEMPT_ACK.test(pathname) || ITEM_ACTION.test(pathname)) return ['POST'];
  return ['GET', 'HEAD'];
}

export function approvalRouteName(pathname: string): string {
  if (pathname === STEP_UP) return 'approvals.step_up';
  if (pathname === HISTORY || pathname.startsWith(`${HISTORY}/`)) return 'approvals.history';
  if (pathname === OWNER_CONFIRMATIONS) return 'approvals.configuration';
  if (ATTEMPT_ACK.test(pathname)) return 'approvals.attempt';
  if (ITEM_ACTION.test(pathname)) return 'approvals.decision';
  return 'approvals';
}

const fail = (code: ApiErrorCode): never => {
  throw new IntegrationError(code);
};

/** Código do núcleo → código público (nunca o código interno, que pode revelar detalhes). */
export function publicCode(code: string): ApiErrorCode {
  if (['approval_not_issued', 'attempt_not_found', 'hold_not_found'].includes(code)) return 'not_found';
  if (code === 'step_up_failed') return 'confirmation_failed';
  if (['step_up_locked', 'step_up_capacity'].includes(code)) return 'confirmation_locked';
  if (['step_up_required', 'step_up_expired', 'step_up_session_mismatch', 'identity_mismatch', 'identity_invalid', 'confirmation_method_unavailable'].includes(code)) {
    return 'confirmation_required';
  }
  if (code === 'killswitch_engaged') return 'approval_blocked';
  if (['approval_expired'].includes(code)) return 'approval_expired';
  if (['binding_mismatch', 'binding_changed', 'policy_version_mismatch'].includes(code)) return 'approval_binding_mismatch';
  if (code === 'invalid_transition') return 'approval_conflict';
  if (code.startsWith('invalid_') || ['hold_note_too_long', 'action_not_approvable', 'missing_sha', 'use_owner_confirmation'].includes(code)) return 'bad_request';
  if (code.startsWith('store_') || code.startsWith('key_') || ['history_full', 'mac_invalid', 'document_invalid'].includes(code)) return 'approvals_unavailable';
  if (
    ['already_decided', 'invalid_transition', 'self_approval', 'approver_not_human', 'approval_already_used', 'attempt_not_reserved', 'not_requester', 'receipt_missing'].includes(code) ||
    code.startsWith('approval_') ||
    code.startsWith('receipt_')
  ) {
    return 'approval_conflict';
  }
  return 'internal';
}

export function createApprovalRoutes(deps: {
  approvals: ApprovalsRuntime | null;
  audit?: AuditLog | null;
  projects?: ProjectStore | null;
  logger: Logger;
  now?: () => number;
}) {
  const clock = deps.now ?? Date.now;
  /** Verificações scrypt simultâneas da confirmação (~128 MiB cada), como no login (#003). */
  let stepUpInFlight = 0;

  function identityOf(session: Session, token: string): IdentityContext {
    return { userId: session.userId, sessionKey: createHash('sha256').update(token).digest('hex') };
  }

  /** Estado exibido: o que venceu por tempo aparece como expirado (a manutenção grava depois). */
  function effectiveState(a: LedgerApproval, at: number): ApprovalSummary['state'] {
    if (a.state === 'pending' && at >= Date.parse(a.pendingUntil)) return 'expired';
    if (a.state === 'approved' && a.validUntil !== null && at >= Date.parse(a.validUntil)) return 'expired';
    return a.state;
  }

  function projectName(ownerId: string, projectId: string | null): string | null {
    if (projectId === null) return null;
    return deps.projects?.get(ownerId, projectId)?.name ?? null;
  }

  function summary(a: LedgerApproval, at: number): ApprovalSummary {
    return {
      id: a.id,
      class: a.class,
      method: a.method,
      action: a.binding.action,
      projectId: a.binding.projectId,
      projectName: projectName(a.ownerId, a.binding.projectId),
      subject: { ...a.binding.subject },
      requestedBy: { ...a.requestedBy },
      state: effectiveState(a, at),
      requestedAt: a.requestedAt,
      pendingUntil: a.pendingUntil,
      validUntil: a.validUntil,
      decidedAt: a.decidedAt,
      closedReason: a.closedReason,
    };
  }

  const attemptView = (t: LedgerAttempt): ApprovalAttemptView => ({ id: t.id, component: t.component, state: t.state, reservedAt: t.reservedAt, outcomeAt: t.outcomeAt, reason: t.reason });
  const holdView = (h: { id: string; approvalId: string; reason: ApprovalHoldView['reason']; note: string | null; createdAt: string }): ApprovalHoldView => ({
    id: h.id,
    approvalId: h.approvalId,
    reason: h.reason,
    note: h.note,
    createdAt: h.createdAt,
  });

  function detail(runtime: ApprovalsRuntime, a: LedgerApproval): ApprovalDetail {
    let presentable: boolean;
    try {
      presentable = bindingDigest(a.binding) === a.bindingDigest;
    } catch {
      presentable = false;
    }
    return {
      ...summary(a, clock()),
      binding: structuredClone(a.binding),
      bindingDigest: a.bindingDigest,
      presentable,
      decidedBy: a.decidedBy ? { ...a.decidedBy } : null,
      confirmationMethod: a.confirmation?.method ?? null,
      attempts: runtime.service.attemptsOf(a.ownerId, a.id).map(attemptView),
      holds: runtime.service.history().holds.filter((h) => h.approvalId === a.id).map(holdView),
    };
  }

  /** Espelho na auditoria da #006 (melhor esforço: o histórico oficial já foi gravado). */
  async function mirror(event: AuditEventInput) {
    if (!deps.audit) return;
    try {
      await deps.audit.append(event);
    } catch {
      deps.logger.log('error', 'Falha ao gravar evento de auditoria', { event: 'audit_write_failed', action: event.action });
    }
  }

  function ownedProject(session: Session, projectId: string | null) {
    return projectId !== null && deps.projects?.get(session.userId, projectId) ? projectId : null;
  }

  // ---------- Corpos (chaves fechadas) ----------

  function object(body: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('bad_request');
    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) fail('bad_request');
    for (const key of keys) if (!Object.hasOwn(record, key)) fail('bad_request');
    return record;
  }
  /** Formato da prova: string curta. Ausente/vencida/reutilizada/de outra sessão → o núcleo recusa. */
  function proofOf(record: Record<string, unknown>): string {
    const proofId = record.proofId;
    if (typeof proofId !== 'string' || proofId.length === 0 || proofId.length > 64) fail('bad_request');
    return proofId as string;
  }

  async function run<R>(runtime: ApprovalsRuntime, work: () => Promise<R>): Promise<R> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      const status = runtime.service.status();
      if (status.state !== 'available') throw new IntegrationError('approvals_unavailable');
      if (error instanceof ApprovalError) {
        const code = publicCode(error.code);
        if (code === 'internal') deps.logger.log('error', 'Falha no núcleo de aprovações', { event: 'approvals_error', reason: /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : 'unknown' });
        throw new IntegrationError(code);
      }
      throw error;
    }
  }

  const outcomeFor = (error: unknown): AuditOutcome => {
    const code = error instanceof IntegrationError ? error.code : 'internal';
    return ['internal', 'approvals_unavailable', 'bad_request'].includes(code) ? 'failure' : 'blocked';
  };
  const reasonOf = (error: unknown) => (error instanceof IntegrationError ? error.code : 'internal');

  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, session: Session, token: string, io: ApprovalRouteIo): Promise<void> {
      const pathname = url.pathname;
      // Administrador único: aprovações são da instância. Outro usuário (futuro) não as vê.
      if (session.userId !== ADMIN_USER_ID) fail('not_found');
      const isWrite = req.method === 'POST';
      const ownerId = session.userId;
      const actor = { kind: 'human' as const, id: session.userId };
      const runtime = deps.approvals;

      if (pathname === LIST && !isWrite) {
        io.assertOnlyParams(url, []);
        if (!runtime) {
          const body: ApprovalListResponse = {
            subsystem: { state: 'unavailable', reason: 'not_configured', barriers: { global: true, projects: [] }, realExecutionEnabled: REAL_EXECUTION_ENABLED },
            approvals: [],
          };
          io.sendJson(res, 200, body);
          return;
        }
        const status = runtime.service.status();
        let approvals: ApprovalSummary[] = [];
        let barriers = { global: true, projects: [] as string[] };
        if (status.state !== 'unavailable') {
          const at = clock();
          approvals = runtime.service
            .list(ownerId)
            .map((a) => summary(a, at))
            .sort((a, b) => Number(b.state === 'pending') - Number(a.state === 'pending') || b.requestedAt.localeCompare(a.requestedAt));
          const current = runtime.service.barriers();
          barriers = {
            global: current.durable.global !== null || current.volatile.includes('global'),
            projects: [...new Set([...Object.keys(current.durable.projects), ...current.volatile.filter((k) => k.startsWith('project:')).map((k) => k.slice(8))])].sort(),
          };
        }
        const body: ApprovalListResponse = {
          subsystem: { state: status.state, reason: status.reason !== null && /^[a-z0-9_]{1,64}$/.test(status.reason) ? status.reason : null, barriers, realExecutionEnabled: REAL_EXECUTION_ENABLED },
          approvals,
        };
        io.sendJson(res, 200, body);
        return;
      }

      if (!runtime) fail('approvals_unavailable');
      const rt = runtime!;
      const ctx = identityOf(session, token);

      if (pathname === HISTORY) {
        io.assertOnlyParams(url, ['before', 'limit', 'approvalId']);
        const get = (key: string) => {
          const values = url.searchParams.getAll(key);
          if (values.length > 1) fail('bad_request');
          return values[0];
        };
        const int = (value: string | undefined, max: number) => {
          if (value === undefined) return undefined;
          if (!/^\d{1,15}$/.test(value) || Number(value) < 1 || Number(value) > max) fail('bad_request');
          return Number(value);
        };
        const before = int(get('before'), Number.MAX_SAFE_INTEGER);
        const limit = int(get('limit'), AUDIT_QUERY_LIMITS.maxLimit) ?? AUDIT_QUERY_LIMITS.defaultLimit;
        const approvalId = get('approvalId');
        if (approvalId !== undefined && !UUID.test(approvalId)) fail('bad_request');
        if (rt.service.status().state === 'unavailable') fail('approvals_unavailable');
        const history = rt.service.history();
        const views: ApprovalHistoryItemView[] = history.items
          .filter((item) => (before === undefined || item.seq < before) && (approvalId === undefined || (item.kind === 'entry' && item.approvalId === approvalId)))
          .reverse()
          .map((item) =>
            item.kind === 'tombstone'
              ? { kind: 'tombstone', firstSeq: item.firstSeq, seq: item.seq, purged: item.purged }
              : {
                  kind: 'entry',
                  seq: item.seq,
                  at: item.at,
                  event: item.event,
                  actor: { ...item.actor },
                  approvalId: item.approvalId,
                  attemptId: item.attemptId,
                  projectId: item.projectId,
                  class: item.class,
                  action: item.action,
                  from: item.from,
                  to: item.to,
                  reason: item.reason,
                },
          );
        const page = views.slice(0, limit);
        const body: ApprovalHistoryResponse = {
          retentionDays: history.retentionDays,
          retentionLimits: { min: HISTORY_RETENTION_DAYS.min, max: HISTORY_RETENTION_DAYS.max },
          items: page,
          nextBefore: views.length > limit ? page[page.length - 1].seq : null,
          holds: history.holds.map(holdView),
        };
        io.sendJson(res, 200, body);
        return;
      }

      const item = ITEM.exec(pathname);
      if (item && !isWrite && !POST_LITERALS.includes(pathname)) {
        io.assertOnlyParams(url, []);
        const [, id] = item;
        if (!UUID.test(id)) fail('not_found');
        if (rt.service.status().state === 'unavailable') fail('approvals_unavailable');
        const approval = rt.service.get(ownerId, id) ?? fail('not_found');
        const body: ApprovalDetailResponse = { approval: detail(rt, approval) };
        io.sendJson(res, 200, body);
        return;
      }

      if (!isWrite) fail('not_found');
      io.assertOnlyParams(url, []);

      if (pathname === STEP_UP) {
        const body = object(await io.readJsonBody(req, MAX_BODY_BYTES), ['password']);
        if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 256) fail('bad_request');
        if (rt.service.status().state !== 'available') fail('approvals_unavailable');
        if (stepUpInFlight >= MAX_CONCURRENT_STEP_UPS) throw new IntegrationError('too_many_requests', { retryAfterSeconds: 1 });
        stepUpInFlight += 1;
        try {
          const proof = await run(rt, () => rt.identity.confirm(ctx, 'password', body.password as string)).finally(() => {
            stepUpInFlight -= 1;
          });
          await mirror({ action: 'approval.confirmation', actor, ownerId, projectId: null, resource: { type: 'approval', id: null }, outcome: 'success', context: { reason: 'password' } });
          deps.logger.log('info', 'Confirmação de identidade', { event: 'approval_confirmation' });
          const response: StepUpResponse = { proofId: proof.proofId, expiresAt: proof.expiresAt };
          io.sendJson(res, 200, response);
        } catch (error) {
          await mirror({ action: 'approval.confirmation', actor, ownerId, projectId: null, resource: { type: 'approval', id: null }, outcome: outcomeFor(error), context: { reason: reasonOf(error) } });
          deps.logger.log('warn', 'Confirmação de identidade recusada', { event: 'approval_confirmation_failure', reason: reasonOf(error) });
          throw error;
        }
        return;
      }

      const action = ITEM_ACTION.exec(pathname);
      if (action) {
        const [, id, verb] = action;
        if (!UUID.test(id)) fail('not_found');
        const body =
          verb === 'revoke'
            ? object(await io.readJsonBody(req, MAX_BODY_BYTES), ['proofId'])
            : object(await io.readJsonBody(req, MAX_BODY_BYTES), ['bindingDigest', 'proofId']);
        const proofId = proofOf(body);
        if (verb !== 'revoke' && (typeof body.bindingDigest !== 'string' || !DIGEST.test(body.bindingDigest))) fail('bad_request');
        const existing = rt.service.status().state === 'unavailable' ? null : rt.service.get(ownerId, id);
        const projectId = ownedProject(session, existing?.binding.projectId ?? null);
        const context = { operation: verb, ...(existing ? { policyAction: existing.binding.action } : {}) };
        try {
          const updated = await run(rt, async () => {
            if (rt.service.status().state !== 'available') fail('approvals_unavailable');
            if (!existing) fail('not_found');
            // Apresentação não verificável → nunca decide (o navegador também bloqueia).
            if (verb === 'approve' && bindingDigest(existing!.binding) !== existing!.bindingDigest) fail('approval_binding_mismatch');
            return verb === 'revoke'
              ? rt.service.revoke({ ownerId, approvalId: id, proofId, identity: ctx })
              : rt.service.decide({ ownerId, approvalId: id, decision: verb as 'approve' | 'reject', bindingDigest: body.bindingDigest as string, proofId, identity: ctx });
          });
          await mirror({ action: 'approval.decision', actor, ownerId, projectId, resource: { type: 'approval', id }, outcome: 'success', context: { ...context, to: updated.state } });
          deps.logger.log('info', 'Decisão sobre aprovação', { event: `approval_${verb}`, approvalId: id });
          const response: ApprovalDetailResponse = { approval: detail(rt, updated) };
          io.sendJson(res, 200, response);
        } catch (error) {
          await mirror({ action: 'approval.decision', actor, ownerId, projectId, resource: { type: 'approval', id }, outcome: outcomeFor(error), context: { ...context, reason: reasonOf(error) } });
          throw error;
        }
        return;
      }

      if (pathname === OWNER_CONFIRMATIONS || pathname === PURGE) {
        const purge = pathname === PURGE;
        const body = purge
          ? object(await io.readJsonBody(req, MAX_BODY_BYTES), ['before', 'proofId'])
          : object(await io.readJsonBody(req, MAX_BODY_BYTES), ['operation', 'days', 'proofId']);
        const proofId = proofOf(body);
        // Nesta fase, a confirmação do PO pela web só cobre a retenção e o descarte do histórico.
        // Liberação do kill switch (N9), limites (#012) e ações críticas (indisponíveis) não.
        if (!purge && body.operation !== 'approvals.retention_change') fail('bad_request');
        const operation = purge ? 'approvals.history_purge' : 'approvals.retention_change';
        const params = purge ? { before: body.before } : { days: body.days };
        const context = { operation: purge ? 'history_purge' : 'retention_change' };
        try {
          const approval = await run(rt, async () => {
            if (rt.service.status().state !== 'available') fail('approvals_unavailable');
            return rt.service.configure({ ownerId, operation, params, proofId, identity: ctx });
          });
          await mirror({ action: 'approval.configuration', actor, ownerId, projectId: null, resource: { type: 'approval', id: approval.id }, outcome: 'success', context: { ...context, ...(purge ? {} : { to: body.days as number }) } });
          const response: ApprovalDetailResponse = { approval: detail(rt, approval) };
          io.sendJson(res, 200, response);
        } catch (error) {
          await mirror({ action: 'approval.configuration', actor, ownerId, projectId: null, resource: { type: 'approval', id: null }, outcome: outcomeFor(error), context: { ...context, reason: reasonOf(error) } });
          throw error;
        }
        return;
      }

      const ack = ATTEMPT_ACK.exec(pathname);
      if (ack) {
        const [, attemptId] = ack;
        if (!UUID.test(attemptId)) fail('not_found');
        const proofId = proofOf(object(await io.readJsonBody(req, MAX_BODY_BYTES), ['proofId']));
        try {
          const attempt = await run(rt, async () => {
            if (rt.service.status().state !== 'available') fail('approvals_unavailable');
            return rt.service.acknowledgeAttempt({ ownerId, attemptId, proofId, identity: ctx });
          });
          await mirror({ action: 'approval.attempt_acknowledged', actor, ownerId, projectId: null, resource: { type: 'approval', id: attempt.approvalId }, outcome: 'success', context: { to: attempt.state } });
          io.sendJson(res, 200, { attempt: attemptView(attempt) });
        } catch (error) {
          await mirror({ action: 'approval.attempt_acknowledged', actor, ownerId, projectId: null, resource: { type: 'approval', id: null }, outcome: outcomeFor(error), context: { reason: reasonOf(error) } });
          throw error;
        }
        return;
      }

      const remove = HOLD_REMOVE.exec(pathname);
      if (pathname === HOLDS || remove) {
        const adding = pathname === HOLDS;
        const body = adding
          ? object(await io.readJsonBody(req, MAX_BODY_BYTES), ['approvalId', 'reason', 'proofId'], ['note'])
          : object(await io.readJsonBody(req, MAX_BODY_BYTES), ['proofId']);
        const proofId = proofOf(body);
        if (remove && !UUID.test(remove[1])) fail('not_found');
        if (adding) {
          if (typeof body.approvalId !== 'string' || !UUID.test(body.approvalId)) fail('bad_request');
          if (typeof body.reason !== 'string' || !(APPROVAL_HOLD_REASONS as readonly string[]).includes(body.reason)) fail('bad_request');
          if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > HOLD_NOTE_MAX)) fail('bad_request');
        }
        const context = { operation: adding ? 'hold_add' : 'hold_remove', ...(adding ? { reason: body.reason as string } : {}) };
        const resourceId = adding ? (body.approvalId as string) : null;
        try {
          await run(rt, async () => {
            if (rt.service.status().state !== 'available') fail('approvals_unavailable');
            if (adding) {
              await rt.service.addHold({ ownerId, approvalId: body.approvalId as string, reason: body.reason as ApprovalHoldView['reason'], note: (body.note as string | null | undefined) ?? null, proofId, identity: ctx });
            } else {
              await rt.service.removeHold({ ownerId, holdId: remove![1], proofId, identity: ctx });
            }
          });
          await mirror({ action: 'approval.hold', actor, ownerId, projectId: null, resource: { type: 'approval', id: resourceId }, outcome: 'success', context });
          io.sendJson(res, adding ? 201 : 200, { holds: rt.service.history().holds.map(holdView) });
        } catch (error) {
          await mirror({ action: 'approval.hold', actor, ownerId, projectId: null, resource: { type: 'approval', id: resourceId }, outcome: outcomeFor(error), context: { operation: context.operation, reason: reasonOf(error) } });
          throw error;
        }
        return;
      }

      fail('not_found');
    },

    /** Encerra as provas de confirmação da sessão (logout). */
    revokeSession(token: string) {
      deps.approvals?.identity.revokeSession(createHash('sha256').update(token).digest('hex'));
    },
  };
}
