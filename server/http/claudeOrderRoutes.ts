import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ApiErrorCode,
  AuditAction,
  AuditContextValue,
  AuditOutcome,
  ClaudeEnablementResponse,
  ClaudeOrderListResponse,
  ClaudeOrderPackageResponse,
  ClaudeOrderResponse,
  ClaudeOrderVerifyResponse,
  PolicyAction,
} from '../../shared/contracts.ts';
import type { AuditLog } from '../audit/auditLog.ts';
import { ADMIN_USER_ID } from '../auth/adminAuth.ts';
import type { Session } from '../auth/sessions.ts';
import { GATEWAY_LIMITS, ORDER_LIMITS } from '../gateway/contracts.ts';
import type { ClaudeOrders } from '../gateway/orders.ts';
import { IntegrationError } from '../github/errors.ts';
import type { Logger } from '../logger.ts';
import type { ProjectStore } from '../projects/projectStore.ts';
import type { TaskStore } from '../tasks/taskStore.ts';

/**
 * Rotas das ordens do Claude Code (Issue #008, PR 2) — fluxo ASSISTIDO. Nenhuma rota executa
 * código, inicia processo, chama provedor de IA ou escreve no GitHub: elas só preparam, registram
 * e LEEM (o PR, somente leitura). Todas exigem a sessão do administrador; as de escrita (POST)
 * passam antes pela proteção CSRF/Origin/JSON do `app.ts`, e a política (#020) é avaliada antes.
 *
 * - Identidade sempre da sessão (`sessionKey` = SHA-256 do token do cookie); nenhum corpo aceita
 *   dono, aprovador, projeto de outra rota, repositório da ordem, branch, SHA ou capacidade.
 * - Liberar o pacote, informar o PR, cancelar e mudar a habilitação exigem confirmação recente de
 *   identidade (prova de uso único de `POST /api/approvals/step-up`).
 * - O pacote só aparece na resposta da liberação; a listagem nunca o devolve.
 * - A liberação usa `/package` (não `/release`): o teste estrutural do servidor proíbe rotas POST
 *   com `release` (N9, liberação de kill switch) e a recusa é mantida, não contornada.
 */

export const CLAUDE_ORDER_POST_ROUTES: readonly string[] = Object.freeze([
  '/api/projects/:id/tasks/:taskId/claude-orders',
  '/api/projects/:id/claude-enablement',
  '/api/claude-orders/:orderId/package',
  '/api/claude-orders/:orderId/forwarded',
  '/api/claude-orders/:orderId/pr',
  '/api/claude-orders/:orderId/verify',
  '/api/claude-orders/:orderId/cancel',
]);

const PROJECT_ORDERS = /^\/api\/projects\/([^/]+)\/claude-orders$/;
const TASK_ORDERS = /^\/api\/projects\/([^/]+)\/tasks\/([^/]+)\/claude-orders$/;
const ENABLEMENT = /^\/api\/projects\/([^/]+)\/claude-enablement$/;
const ORDER_ACTION = /^\/api\/claude-orders\/([^/]+)\/(package|forwarded|pr|verify|cancel)$/;
const ORDERS_PREFIX = '/api/claude-orders/';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const TOKEN = /^[a-z0-9_]{1,64}$/;
const MAX_CREATE_BYTES = 16 * 1024;
const MAX_SMALL_BYTES = 4096;

export const isClaudeOrderPath = (pathname: string) => PROJECT_ORDERS.test(pathname) || TASK_ORDERS.test(pathname) || ENABLEMENT.test(pathname) || pathname.startsWith(ORDERS_PREFIX);

/** Métodos aceitos (`null` se o caminho não for destas rotas). */
export function claudeOrderMethods(pathname: string): readonly string[] | null {
  if (PROJECT_ORDERS.test(pathname)) return ['GET', 'HEAD'];
  if (TASK_ORDERS.test(pathname) || ENABLEMENT.test(pathname) || ORDER_ACTION.test(pathname)) return ['POST'];
  if (pathname.startsWith(ORDERS_PREFIX)) return ['GET', 'HEAD'];
  return null;
}

export function claudeOrderRouteName(pathname: string): string {
  if (PROJECT_ORDERS.test(pathname)) return 'claude_orders';
  if (TASK_ORDERS.test(pathname)) return 'claude_orders.create';
  if (ENABLEMENT.test(pathname)) return 'claude_orders.enablement';
  const action = ORDER_ACTION.exec(pathname);
  return action ? `claude_orders.${action[2]}` : 'claude_orders';
}

/**
 * Código do gateway/leitor → código público. Barreira e kill switch (qualquer motivo-token deles)
 * → `approval_blocked`; desconhecido → `internal` (registrado só como token no log).
 */
export function publicOrderCode(code: string): ApiErrorCode {
  const map: Record<string, ApiErrorCode> = {
    not_found: 'not_found',
    scope_not_found: 'not_found',
    invalid_request: 'bad_request',
    pr_reference_required: 'bad_request',
    data_not_found: 'bad_request',
    data_too_large: 'bad_request',
    package_too_large: 'bad_request',
    idempotency_conflict: 'order_conflict',
    invalid_transition: 'order_conflict',
    pr_already_linked: 'order_conflict',
    pr_not_linked: 'order_conflict',
    order_flow_required: 'order_conflict',
    scope_not_active: 'order_conflict',
    scope_exhausted: 'order_conflict',
    scope_exceeded: 'order_conflict',
    task_not_active: 'order_conflict',
    clock_regression: 'order_conflict',
    verification_in_progress: 'order_conflict',
    approval_invalid: 'approval_conflict',
    approval_not_authentic: 'approval_conflict',
    approver_identity_mismatch: 'approval_conflict',
    approval_reserve_failed: 'approval_conflict',
    approval_already_used: 'approval_conflict',
    activation_failed: 'approval_conflict',
    approval_pending: 'approval_required',
    approval_expired: 'approval_expired',
    order_closed: 'order_closed',
    scope_revoked: 'order_closed',
    scope_expired: 'order_expired',
    handoff_expired: 'order_expired',
    identity_not_confirmed: 'confirmation_required',
    identity_mismatch: 'confirmation_required',
    identity_unavailable: 'approvals_unavailable',
    approvals_unavailable: 'approvals_unavailable',
    approval_verifier_unavailable: 'approvals_unavailable',
    policy_version_mismatch: 'approval_binding_mismatch',
    secret_detected: 'secret_detected',
    repository_not_allowed: 'repository_not_allowed',
    project_not_enabled: 'project_not_enabled',
    capability_unavailable: 'capability_unavailable',
    policy_denied: 'policy_denied',
    agent_not_assigned: 'policy_denied',
    pr_reference_invalid: 'pr_reference_invalid',
    verification_limit: 'verification_limit',
    verification_too_soon: 'too_many_requests',
    head_changed: 'head_changed',
    github_unavailable: 'github_unavailable',
    github_response_invalid: 'github_unavailable',
    github_unauthorized: 'github_unauthorized',
    gateway_unavailable: 'gateway_unavailable',
    store_degraded: 'gateway_unavailable',
    store_unavailable: 'gateway_unavailable',
    store_full: 'gateway_unavailable',
    store_write_failed: 'gateway_unavailable',
    change_rejected: 'gateway_unavailable',
  };
  if (Object.hasOwn(map, code)) return map[code];
  // Confirmação de identidade (#011): os mesmos códigos públicos das rotas de aprovação.
  if (code === 'step_up_failed') return 'confirmation_failed';
  if (code === 'step_up_locked' || code === 'step_up_capacity') return 'confirmation_locked';
  if (code.startsWith('step_up_') || code === 'identity_invalid' || code === 'confirmation_method_unavailable') return 'confirmation_required';
  if (code === 'killswitch_engaged') return 'approval_blocked';
  if (code.startsWith('approval_') || code.startsWith('binding_') || code.startsWith('presentation_')) return 'approval_conflict';
  if (code.startsWith('content_')) return 'gateway_unavailable';
  if (/_barrier$|^authority_|kill|^barrier_|^queue_|emergency|^initial_install$|^recovery$/.test(code)) return 'approval_blocked';
  return 'internal';
}

export interface ClaudeOrderRouteIo {
  readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
  assertOnlyParams(url: URL, allowed: string[]): void;
  enforce(session: Session, actions: PolicyAction[], projectId: string | null): void;
}

export function createClaudeOrderRoutes(deps: {
  orders: ClaudeOrders | null;
  gatewayStatus?: () => { state: string; reason: string | null };
  projects?: ProjectStore | null;
  tasks?: TaskStore | null;
  audit?: AuditLog | null;
  allowedRepositories: readonly string[];
  logger: Logger;
}) {
  const fail = (code: ApiErrorCode, extra?: { retryAfterSeconds?: number }): never => {
    throw new IntegrationError(code, extra);
  };

  function object(body: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('bad_request');
    const record = body as Record<string, unknown>;
    for (const key of Object.keys(record)) if (!keys.includes(key) && !optional.includes(key)) fail('bad_request');
    for (const key of keys) if (!Object.hasOwn(record, key)) fail('bad_request');
    return record;
  }
  const proofOf = (record: Record<string, unknown>) => (typeof record.proofId === 'string' && record.proofId.length > 0 && record.proofId.length <= 64 ? record.proofId : fail('bad_request'));

  /** Espelho na auditoria da #006 (melhor esforço: o histórico oficial é o ledger do gateway). */
  async function mirror(action: AuditAction, session: Session, projectId: string | null, orderId: string | null, outcome: AuditOutcome, context: Record<string, AuditContextValue>) {
    if (!deps.audit) return;
    try {
      await deps.audit.append({ action, actor: { kind: 'human', id: session.userId }, ownerId: session.userId, projectId, resource: { type: 'claude_order', id: orderId }, outcome, context });
    } catch {
      deps.logger.log('error', 'Falha ao gravar evento de auditoria', { event: 'audit_write_failed', action });
    }
  }

  /** Erro do gateway → `IntegrationError` público (motivo-token só no log). */
  function translate(error: unknown): IntegrationError {
    if (error instanceof IntegrationError) return error;
    const raw = (error as { code?: unknown })?.code;
    const code = typeof raw === 'string' && TOKEN.test(raw) ? raw : 'internal';
    const mapped = publicOrderCode(code);
    if (mapped === 'internal') deps.logger.log('error', 'Falha nas ordens do Claude Code', { event: 'claude_order_error', reason: code });
    const retry = (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
    if (mapped === 'too_many_requests') return new IntegrationError(mapped, { retryAfterSeconds: Math.ceil(ORDER_LIMITS.minVerificationIntervalMs / 1000) });
    return new IntegrationError(mapped, typeof retry === 'number' && retry > 0 ? { retryAfterSeconds: retry } : {});
  }
  const outcomeFor = (error: IntegrationError): AuditOutcome => (['internal', 'bad_request', 'gateway_unavailable', 'github_unavailable', 'github_unauthorized', 'approvals_unavailable'].includes(error.code) ? 'failure' : 'blocked');

  const ownedProject = (session: Session, projectId: string) => {
    if (!UUID.test(projectId)) fail('not_found');
    return deps.projects?.get(session.userId, projectId) ?? fail('not_found');
  };

  return {
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, session: Session, token: string, io: ClaudeOrderRouteIo): Promise<void> {
      const pathname = url.pathname;
      // Administrador único: as ordens são da instância (o mesmo critério das aprovações).
      if (session.userId !== ADMIN_USER_ID) fail('not_found');
      io.assertOnlyParams(url, []);
      const ownerId = session.userId;
      const identity = { userId: session.userId, sessionKey: createHash('sha256').update(token).digest('hex') };
      const isWrite = req.method === 'POST';

      const list = PROJECT_ORDERS.exec(pathname);
      if (list && !isWrite) {
        const project = ownedProject(session, list[1]);
        io.enforce(session, ['task.read'], project.id);
        const orders = deps.orders;
        const status = deps.gatewayStatus?.() ?? { state: orders ? 'available' : 'unavailable', reason: orders ? null : 'not_configured' };
        const linkable = project.repositories.filter((r) => deps.allowedRepositories.includes(r) && session.scope.includes(r));
        const body: ClaudeOrderListResponse = {
          gateway: { state: orders && status.state === 'available' ? 'available' : 'unavailable', reason: orders ? (status.reason !== null && TOKEN.test(status.reason) ? status.reason : null) : 'not_configured' },
          enablement: orders ? orders.enablement(ownerId, project.id) : { enabled: false, repository: null, at: null },
          linkableRepositories: linkable,
          orders: orders && status.state !== 'unavailable' ? orders.list(ownerId, project.id) : [],
        };
        io.sendJson(res, 200, body);
        return;
      }
      if (!isWrite) fail('not_found');
      const orders = deps.orders ?? fail('gateway_unavailable');

      const create = TASK_ORDERS.exec(pathname);
      if (create) {
        const project = ownedProject(session, create[1]);
        const taskId = create[2];
        if (!UUID.test(taskId) || !deps.tasks?.get(ownerId, project.id, taskId)) fail('not_found');
        io.enforce(session, ['task.update'], project.id);
        const body = object(await io.readJsonBody(req, MAX_CREATE_BYTES), ['idempotencyKey', 'objective', 'acceptanceCriteria'], ['dataRefs']);
        if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(body.idempotencyKey) || body.idempotencyKey.startsWith('retry:')) fail('bad_request');
        // Referências: a própria tarefa sempre; outras só se forem tarefas DESTE projeto (o conteúdo é resolvido no servidor).
        const extra = body.dataRefs === undefined ? [] : Array.isArray(body.dataRefs) && body.dataRefs.length < GATEWAY_LIMITS.dataRefs ? (body.dataRefs as unknown[]) : fail('bad_request');
        const refs = [{ kind: 'task', ref: taskId }];
        for (const raw of extra) {
          const ref = object(raw, ['kind', 'ref']);
          if (ref.kind !== 'task' || typeof ref.ref !== 'string' || !UUID.test(ref.ref) || !deps.tasks?.get(ownerId, project.id, ref.ref)) fail('bad_request');
          if (!refs.some((r) => r.ref === ref.ref)) refs.push({ kind: 'task', ref: ref.ref as string });
        }
        try {
          const order = await orders.create(ownerId, project.id, taskId, { idempotencyKey: body.idempotencyKey as string, objective: body.objective, acceptanceCriteria: body.acceptanceCriteria, dataRefs: refs });
          await mirror('claude_order.requested', session, project.id, order.orderId, 'success', { to: order.state });
          deps.logger.log('info', 'Ordem para Claude Code solicitada', { event: 'claude_order_requested', projectId: project.id, orderId: order.orderId });
          const response: ClaudeOrderResponse = { order };
          io.sendJson(res, 201, response);
        } catch (caught) {
          const error = translate(caught);
          await mirror('claude_order.requested', session, project.id, null, outcomeFor(error), { reason: error.code });
          throw error;
        }
        return;
      }

      const enablement = ENABLEMENT.exec(pathname);
      if (enablement) {
        const project = ownedProject(session, enablement[1]);
        io.enforce(session, ['project.update'], project.id);
        const body = object(await io.readJsonBody(req, MAX_SMALL_BYTES), ['enabled', 'proofId'], ['repository']);
        const proofId = proofOf(body);
        if (typeof body.enabled !== 'boolean') fail('bad_request');
        let repository: string | null = null;
        if (body.enabled) {
          if (typeof body.repository !== 'string' || !REPOSITORY.test(body.repository)) fail('bad_request');
          // Só um repositório vinculado ao projeto, na allowlist do servidor e no escopo da sessão.
          if (!project.repositories.includes(body.repository as string) || !deps.allowedRepositories.includes(body.repository as string) || !session.scope.includes(body.repository as string)) fail('repository_not_allowed');
          repository = body.repository as string;
        } else if (body.repository !== undefined) fail('bad_request');
        try {
          const result = repository ? await orders.enable(ownerId, project.id, repository, { proofId, identity }) : await orders.disable(ownerId, project.id, { proofId, identity });
          await mirror('claude_project.enablement', session, project.id, null, 'success', { to: result.enabled ? 'enabled' : 'disabled' });
          const response: ClaudeEnablementResponse = { enablement: result };
          io.sendJson(res, 200, response);
        } catch (caught) {
          const error = translate(caught);
          await mirror('claude_project.enablement', session, project.id, null, outcomeFor(error), { reason: error.code, to: body.enabled ? 'enabled' : 'disabled' });
          throw error;
        }
        return;
      }

      const action = ORDER_ACTION.exec(pathname);
      if (!action) fail('not_found');
      const [, orderId, verb] = action!;
      if (!UUID.test(orderId)) fail('not_found');
      const projectIds = deps.projects?.list(ownerId).projects.map((p) => p.id) ?? [];
      let projectId: string;
      try {
        projectId = orders.projectOf(ownerId, orderId, projectIds);
      } catch {
        return fail('not_found');
      }
      const audits: Record<string, AuditAction> = {
        package: 'claude_order.package_released',
        forwarded: 'claude_order.forwarded',
        pr: 'claude_order.pr_linked',
        verify: 'claude_order.verified',
        cancel: 'claude_order.cancelled',
      };
      io.enforce(session, verb === 'verify' ? ['github.read', 'task.read'] : ['task.update'], projectId);
      const body =
        verb === 'pr'
          ? object(await io.readJsonBody(req, MAX_SMALL_BYTES), ['pullRequest', 'proofId'])
          : verb === 'package' || verb === 'cancel'
            ? object(await io.readJsonBody(req, MAX_SMALL_BYTES), ['proofId'])
            : object(await io.readJsonBody(req, MAX_SMALL_BYTES), []);
      try {
        if (verb === 'package') {
          const result = await orders.release(ownerId, projectId, orderId, { proofId: proofOf(body), identity });
          await mirror(audits[verb], session, projectId, orderId, 'success', { to: result.order.state });
          deps.logger.log('info', 'Pacote da ordem liberado', { event: 'claude_order_package_released', orderId });
          const response: ClaudeOrderPackageResponse = { order: result.order, package: result.package };
          io.sendJson(res, 200, response);
          return;
        }
        if (verb === 'verify') {
          const result = await orders.verify(ownerId, projectId, orderId, { kind: 'human', id: session.userId });
          const latest = result.order.verification.latest;
          await mirror(audits[verb], session, projectId, orderId, 'success', { verdict: result.outcome.verdict, head: result.outcome.headSha, seq: latest?.seq ?? null, to: result.order.state });
          const response: ClaudeOrderVerifyResponse = result;
          io.sendJson(res, 200, response);
          return;
        }
        const order =
          verb === 'forwarded'
            ? await orders.forwarded(ownerId, projectId, orderId, session.userId)
            : verb === 'pr'
              ? await orders.linkPullRequest(ownerId, projectId, orderId, body.pullRequest, { proofId: proofOf(body), identity })
              : await orders.cancel(ownerId, projectId, orderId, { proofId: proofOf(body), identity });
        await mirror(audits[verb], session, projectId, orderId, 'success', { to: order.state });
        const response: ClaudeOrderResponse = { order };
        io.sendJson(res, 200, response);
      } catch (caught) {
        const error = translate(caught);
        await mirror(audits[verb], session, projectId, orderId, outcomeFor(error), { reason: error.code });
        throw error;
      }
    },
  };
}
