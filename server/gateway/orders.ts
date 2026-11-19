import type { ClaudeOrderState, ClaudeOrderVerificationView, ClaudeOrderVerifyResponse, ClaudeOrderView } from '../../shared/contracts.ts';
import type { CompareRead, PullRequestReaderPort } from '../github/prTypes.ts';
import { GatewayError, ORDER_LIMITS, type OrderMark, type OrderVerification } from './contracts.ts';
import { evaluatePullRequest } from './prVerification.ts';
import type { Gateway, HumanConfirm } from './service.ts';

/**
 * Coordenador das ordens do Claude Code (Issue #008) — fluxo ASSISTIDO, sem execução:
 *
 * 1. a pessoa pede a ordem (o servidor lê o SHA de `main` e a identidade do repositório habilitado);
 * 2. o gateway cria o escopo `code.change` e os pedidos de `agent.invoke` + `data.send_external`;
 * 3. a pessoa aprova (#011) e libera o pacote (step-up) — o ACC NÃO envia nada a provedor nenhum;
 * 4. a pessoa usa o Claude Code FORA do ACC e informa `owner/repo#N` (step-up);
 * 5. o ACC lê o PR SOMENTE POR LEITURA (porta injetada) e registra a verificação no histórico.
 *
 * Este módulo não tem rede, credencial, subprocesso nem armazenamento próprios: usa o serviço do
 * gateway (ledger assinado) e a porta de leitura do GitHub (`server/github/prReader.ts`).
 */

export interface ApprovalStatusView {
  id: string;
  action: string;
  state: string;
}

export interface ClaudeOrdersDeps {
  gateway: Gateway;
  /** Leitura do GitHub (somente leitura). `null`: sem credencial no servidor → verificação indisponível. */
  reader: PullRequestReaderPort | null;
  /** Situação dos pedidos de aprovação de um escopo (leitura do núcleo #011; nunca decide). */
  approvalsFor?: (ownerId: string, scopeId: string) => ApprovalStatusView[];
  now?: () => number;
}

type OrderRecord = ReturnType<Gateway['orders']>[number];

const SHA = /^[0-9a-f]{40}$/;
const ACTIONS = ['agent.invoke', 'data.send_external'] as const;

const entryView = (v: OrderVerification): ClaudeOrderVerificationView => ({
  id: v.id,
  seq: v.seq,
  headSha: v.headSha,
  baseSha: v.baseSha,
  verdict: v.verdict,
  rules: v.rules.map((r) => ({ ...r })),
  supersedes: v.supersedes,
  checkedAt: v.checkedAt,
  closes: v.closes,
  reason: v.reason,
});

export function createClaudeOrders(deps: ClaudeOrdersDeps) {
  const { gateway } = deps;
  const now = deps.now ?? Date.now;
  /** Última cabeça observada por ordem NESTE processo (base da "leitura atual" da projeção). */
  const observed = new Map<string, { headSha: string | null; at: number }>();

  /** Estado projetado (§5.1) a partir do que está persistido + da última leitura desta execução. */
  function project(record: OrderRecord): ClaudeOrderView {
    const { scope, handoff, marks, verifications } = record;
    const code = scope.code;
    const mark = (kind: OrderMark['kind']) => marks.find((m) => m.kind === kind) ?? null;
    const latest = verifications[verifications.length - 1] ?? null;
    const seen = observed.get(code.orderId) ?? null;
    const fresh = seen !== null && now() - seen.at <= ORDER_LIMITS.freshObservationMs;
    let current = false;
    let staleReason: ClaudeOrderView['verification']['staleReason'] = null;
    let state: ClaudeOrderState;
    let stateReason: string | null;

    if (!handoff) {
      const byScope: Record<string, ClaudeOrderState> = { awaiting_approval: 'awaiting_approval', activating: 'awaiting_approval', active: 'awaiting_approval', exhausted: 'awaiting_approval', failed: 'rejected', expired: 'expired', revoked: 'cancelled' };
      state = byScope[scope.state] ?? 'cancelled';
      stateReason = scope.state === 'awaiting_approval' ? null : scope.reason;
    } else {
      stateReason = handoff.reason;
      switch (handoff.state) {
        case 'prepared':
          state = 'prepared';
          break;
        case 'awaiting_relay':
          state = mark('forwarded') ? 'awaiting_pr' : 'delivered';
          break;
        case 'relayed':
          state = 'pr_linked';
          break;
        case 'rejected':
          state = 'rejected';
          break;
        case 'expired':
          state = 'expired';
          break;
        case 'revoked':
          state = 'cancelled';
          break;
        case 'validated': {
          state = 'pr_linked';
          if (latest?.closes) {
            state = latest.verdict === 'cancelled' ? 'cancelled' : 'rejected';
            stateReason = latest.reason ?? (latest.verdict === 'cancelled' ? 'cancelled' : 'pr_nonconforming');
          } else if (latest?.verdict === 'conforming') {
            // R1: conformidade vale só para o `headSha` confirmado numa leitura ATUAL desta mesma cabeça.
            if (fresh && seen!.headSha === latest.headSha) {
              state = 'verified';
              current = true;
            } else {
              staleReason = fresh && seen!.headSha !== latest.headSha ? 'head_changed' : 'not_rechecked';
              stateReason = staleReason;
            }
          } else if (latest) {
            stateReason = latest.verdict;
            if (fresh && seen!.headSha !== latest.headSha) staleReason = 'head_changed';
          }
          break;
        }
      }
    }

    const statuses = deps.approvalsFor?.(scope.ownerId, scope.id) ?? [];
    const approvals = ACTIONS.map((action) => {
      const consumed = scope.approvals.find((a) => a.action === action);
      const listed = statuses.filter((a) => a.action === action);
      const shown = consumed ? listed.find((a) => a.id === consumed.approvalId) : listed[listed.length - 1];
      return { action, approvalId: consumed?.approvalId ?? shown?.id ?? null, state: shown?.state ?? (consumed ? 'consumed' : 'unknown') };
    });
    const prMark = mark('pr_linked');
    const used = verifications.filter((v) => v.verdict !== 'cancelled').length;
    const lastAt = latest ? Date.parse(latest.checkedAt) : 0;
    const closed = state === 'rejected' || state === 'expired' || state === 'cancelled';
    return {
      orderId: code.orderId,
      projectId: scope.projectId,
      taskId: scope.taskId,
      agentId: 'claude-code',
      repository: code.repository,
      baseSha: code.baseSha,
      workBranch: code.workBranch,
      inputDigest: code.inputDigest,
      criteriaCount: code.criteriaCount,
      dataRefs: scope.dataRefs.map((d) => ({ ...d })),
      createdAt: scope.createdAt,
      state,
      stateReason,
      scope: { id: scope.id, state: scope.state, validUntil: scope.validUntil, approvalDeadline: scope.approvalDeadline, policyVersion: scope.policyVersion },
      approvals,
      package: handoff ? { digest: handoff.packageDigest, releasedAt: handoff.releasedAt, relayDeadline: handoff.relayDeadline } : null,
      forwardedAt: mark('forwarded')?.at ?? null,
      pullRequest: prMark ? { number: prMark.prNumber!, reference: `${code.repository}#${prMark.prNumber}`, url: `https://github.com/${code.repository}/pull/${prMark.prNumber}`, linkedAt: prMark.at } : null,
      verification: {
        latest: latest ? entryView(latest) : null,
        current,
        staleReason,
        observedHeadSha: fresh ? seen!.headSha : null,
        observedAt: fresh ? new Date(seen!.at).toISOString() : null,
        used,
        max: ORDER_LIMITS.maxVerifications,
        nextAllowedAt: latest && !closed ? new Date(lastAt + ORDER_LIMITS.minVerificationIntervalMs).toISOString() : null,
      },
      history: verifications.map(entryView),
      closed,
    };
  }

  function find(ownerId: string, projectId: string, orderId: string): OrderRecord {
    const record = gateway.orders(ownerId, projectId).find((o) => o.scope.code.orderId === orderId);
    if (!record) throw new GatewayError('not_found');
    return record;
  }
  const viewOf = (ownerId: string, projectId: string, orderId: string) => project(find(ownerId, projectId, orderId));

  /** Projeto de uma ordem (o id da ordem é global; o projeto nunca vem do corpo). */
  function projectOf(ownerId: string, orderId: string, projectIds: readonly string[]): string {
    for (const projectId of projectIds) if (gateway.orders(ownerId, projectId).some((o) => o.scope.code.orderId === orderId)) return projectId;
    throw new GatewayError('not_found');
  }

  return {
    project,
    projectOf,

    list(ownerId: string, projectId: string): ClaudeOrderView[] {
      return gateway
        .orders(ownerId, projectId)
        .map(project)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    get: viewOf,

    /**
     * Pedido da ordem. O repositório é o HABILITADO no projeto; o SHA base e a identidade estável
     * vêm de uma leitura do servidor no GitHub. Repetição com a mesma chave não lê o GitHub de novo.
     */
    async create(ownerId: string, projectId: string, taskId: string, body: { idempotencyKey: string; objective: unknown; acceptanceCriteria: unknown; dataRefs: unknown }): Promise<ClaudeOrderView> {
      const replay = gateway.orders(ownerId, projectId).find((o) => o.scope.code.idempotencyKey === body.idempotencyKey);
      let base: { repository: string; repositoryId: string; sha: string };
      if (replay) {
        base = { repository: replay.scope.code.repository, repositoryId: replay.scope.code.repositoryId, sha: replay.scope.code.baseSha };
      } else {
        const setting = gateway.projectSetting(ownerId, projectId);
        if (!setting || !setting.enabled || !setting.repository) throw new GatewayError('project_not_enabled');
        if (!deps.reader) throw new GatewayError('github_unavailable');
        const head = await deps.reader.mainHead(setting.repository);
        if (head.nameWithOwner.toLowerCase() !== setting.repository.toLowerCase() || !SHA.test(head.sha)) throw new GatewayError('github_response_invalid');
        base = { repository: setting.repository, repositoryId: head.repositoryId, sha: head.sha };
      }
      const scope = await gateway.requestOrder(ownerId, { idempotencyKey: body.idempotencyKey, projectId, taskId, objective: body.objective, acceptanceCriteria: body.acceptanceCriteria, dataRefs: body.dataRefs, base });
      return viewOf(ownerId, projectId, scope.code!.orderId);
    },

    async release(ownerId: string, projectId: string, orderId: string, confirm: HumanConfirm): Promise<{ order: ClaudeOrderView; package: string }> {
      const result = await gateway.releaseOrder(ownerId, projectId, orderId, confirm);
      return { order: viewOf(ownerId, projectId, orderId), package: result.package };
    },

    async forwarded(ownerId: string, projectId: string, orderId: string, actorId: string): Promise<ClaudeOrderView> {
      await gateway.markForwarded(ownerId, projectId, orderId, actorId);
      return viewOf(ownerId, projectId, orderId);
    },

    async linkPullRequest(ownerId: string, projectId: string, orderId: string, reference: unknown, confirm: HumanConfirm): Promise<ClaudeOrderView> {
      await gateway.linkPullRequest(ownerId, projectId, orderId, { reference, confirm });
      return viewOf(ownerId, projectId, orderId);
    },

    async cancel(ownerId: string, projectId: string, orderId: string, confirm: HumanConfirm): Promise<ClaudeOrderView> {
      await gateway.cancelOrder(ownerId, projectId, orderId, confirm);
      return viewOf(ownerId, projectId, orderId);
    },

    /**
     * Verificação (D-08.4: leitura direta, fora da fila). Duas leituras do PR (início e fim) e uma
     * comparação REST com a cabeça lida no início. Erro de rede, autorização, limite ou resposta
     * malformada → NADA é gravado e o estado não muda. Nunca cria escopo nem toca em aprovações.
     */
    async verify(ownerId: string, projectId: string, orderId: string, actor: { kind: 'human'; id: string }): Promise<ClaudeOrderVerifyResponse> {
      const facts = await gateway.verificationGate(ownerId, projectId, orderId);
      if (!deps.reader) throw new GatewayError('github_unavailable');
      const reader = deps.reader;
      const done = gateway.beginVerification(orderId);
      try {
        const start = await reader.pullRequest(facts.repository, facts.prNumber);
        let compare: CompareRead | null = null;
        if (start.kind === 'ok' && SHA.test(start.pr.headRefOid)) compare = await reader.compare(facts.repository, facts.baseSha, start.pr.headRefOid);
        const end = await reader.pullRequest(facts.repository, facts.prNumber);
        const outcome = evaluatePullRequest(facts, start, compare, end);
        if (outcome.kind === 'invalid_read') throw new GatewayError('github_response_invalid');
        if (outcome.kind === 'head_changed') {
          observed.set(orderId, { headSha: outcome.observedHeadSha, at: now() });
          throw new GatewayError('head_changed');
        }
        observed.set(orderId, { headSha: outcome.headSha, at: now() });
        const result = await gateway.appendVerification(ownerId, projectId, orderId, outcome, actor);
        return {
          order: viewOf(ownerId, projectId, orderId),
          outcome: {
            headSha: outcome.headSha,
            verdict: outcome.verdict,
            created: result.created,
            rules: outcome.rules.map((r) => ({ ...r })),
            ...outcome.details,
          },
        };
      } finally {
        done();
      }
    },

    enablement(ownerId: string, projectId: string) {
      const setting = gateway.projectSetting(ownerId, projectId);
      return { enabled: setting?.enabled === true, repository: setting?.enabled ? setting.repository : null, at: setting?.at ?? null };
    },

    async enable(ownerId: string, projectId: string, repository: string, confirm: HumanConfirm) {
      await gateway.enableProject(ownerId, projectId, repository, confirm);
      return this.enablement(ownerId, projectId);
    },

    async disable(ownerId: string, projectId: string, confirm: HumanConfirm) {
      await gateway.disableProject(ownerId, projectId, confirm);
      return this.enablement(ownerId, projectId);
    },
  };
}

export type ClaudeOrders = ReturnType<typeof createClaudeOrders>;
