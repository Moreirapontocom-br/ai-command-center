import { randomUUID } from 'node:crypto';
import { POLICY_ACTIONS, type ApprovalGrant, type PolicyAction } from '../../shared/contracts.ts';
import type { ApprovalVerification, ApprovalVerifier, HumanApproval } from '../limits/contracts.ts';
import { bindingClass, bindingDigest, inScope, isAgentId, paramsDigestOf, parseBinding, parseComponentId, parseScope, REASON, scopeKey, UUID } from './binding.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import {
  APPROVAL_TRANSITIONS,
  APPROVAL_TTL_MS,
  ApprovalError,
  ATTEMPT_TRANSITIONS,
  COMPACTION_AFTER_MS,
  CONFIGURATION_OPERATIONS,
  HISTORY_RETENTION_DAYS,
  HOLD_NOTE_MAX,
  HOLD_REASONS,
  PENDING_TTL_MS,
  RECEIPT_COMPONENTS,
  RECEIPT_TTL_MS,
  RECOVERY_REASONS,
  type ApprovalBinding,
  type ApprovalState,
  type AttemptState,
  type BarrierScope,
  type HoldReason,
  type LedgerApproval,
  type LedgerAttempt,
  type ReceiptComponent,
  type RecoveryReason,
} from './contracts.ts';
import { sanitizeNote, type HistoryItem, type HistoryTombstone } from './documents.ts';
import { assertHumanContext, type IdentityContext, type StepUpRegistry } from './identity.ts';
import { verifyApprovalPresentation } from './presentation.ts';
import type { ApprovalStore, HistoryInput, StoreTransaction } from './store.ts';

/**
 * Serviço do núcleo de aprovações (Issue #011, PR 1) — o "gate".
 *
 * Separa quatro momentos (R1):
 * 1. DECISÃO humana (`decide`/`confirmOwner`), sempre com prova de *step-up* de uso único;
 * 2. RESERVA durável (`reserve`): `approved → consumed` + tentativa `reserved`, gravadas ANTES de
 *    qualquer efeito; só depois da gravação é emitido o recibo;
 * 3. RECIBO (memória, 30 s, uso único), preso à tentativa, à aprovação, à época, ao componente e ao
 *    resumo EXATO do objeto entregue; validado de forma síncrona pelo verificador do componente;
 * 4. RESULTADO (`recordOutcome`): `succeeded` exige recibo validado; `failed` sempre possível.
 *
 * Falha antes da reserva: nada consumido. Falha depois: a aprovação continua consumida; ao
 * reiniciar, a tentativa vira `indeterminate` e só a confirmação do PO a encerra — nunca há
 * repetição automática. Repetir exige NOVA aprovação.
 *
 * Barreiras (R3/D6/N3/N6): acionar uma barreira é síncrono em memória (efeito imediato) e depois
 * durável no ledger; revoga as aprovações de execução não usadas do escopo e invalida recibos
 * pendentes. Reserva e validação de recibo consultam a barreira durável, a volátil e o kill switch
 * do controlador #022 (quando informado). Só uma aprovação de configuração consumida a libera.
 *
 * PR 2: ligado ao servidor (rotas de decisão do administrador, `server/http/approvalRoutes.ts`), ao
 * sandbox (#021) e ao controlador (#022) por `ApprovalCoordinator` + verificador confiável. Nenhuma
 * dessas ligações executa algo: execução real continua desligada.
 */

export interface ApprovalServiceOptions {
  store: ApprovalStore;
  identity: StepUpRegistry;
  /** Versão da política (#020) em vigor; pedidos de outra versão são recusados. */
  policyVersion: string;
  /** Kill switch volátil do controlador #022 (PR 2). `true` = acionado no escopo. */
  controllerKillSwitch?: (projectId: string | null) => boolean;
  now?: () => number;
  /** Relógio monotônico em ms (padrão `performance.now`): voltar o relógio do sistema não estende prazos. */
  monotonicNow?: () => number;
  generateId?: () => string;
}

export interface Reservation {
  attemptId: string;
  approvalId: string;
  component: ReceiptComponent;
  /** Para ações da #020 (sandbox, ferramentas, gasto, merge…). */
  grant: ApprovalGrant | null;
  /** Para `limits.change`/`killswitch.release` (#022). */
  humanApproval: HumanApproval | null;
  receiptExpiresAt: string;
}

/** Verificador CONFIÁVEL entregue a um componente: implementa o contrato da #022 e o grant da #020. */
export interface TrustedApprovalVerifier extends ApprovalVerifier {
  readonly kind: 'trusted';
  readonly component: ReceiptComponent;
  verifyGrant(grant: ApprovalGrant): ApprovalVerification;
}

interface Receipt {
  attemptId: string;
  approvalId: string;
  component: ReceiptComponent;
  epoch: number;
  objectDigest: string;
  binding: ApprovalBinding;
  approverId: string;
  expiresAtWall: number;
  expiresAtMono: number;
}

const SYSTEM = { kind: 'system' as const, id: 'acc-approvals' };
const DAY = 24 * 60 * 60 * 1000;
const PURGE_MIN_AGE_MS = HISTORY_RETENTION_DAYS.min * DAY;

const objectDigest = (kind: 'grant' | 'human', value: unknown) => sha256Hex(`acc-approval-receipt:${kind}\n${canonicalJson(value)}`);

export function createApprovalService(options: ApprovalServiceOptions) {
  const { store, identity } = options;
  const now = options.now ?? Date.now;
  const mono = options.monotonicNow ?? (() => performance.now());
  const generateId = options.generateId ?? randomUUID;
  const iso = (ms = now()) => new Date(ms).toISOString();

  const receipts = new Map<string, Receipt>();
  const validatedAttempts = new Set<string>();
  /** Prazo monotônico de cada aprovação concedida NESTA época (ausente = negar). */
  const monoDeadlines = new Map<string, number>();
  /** Barreiras acionadas em memória (efeito imediato, antes da gravação). */
  const volatileBarriers = new Set<string>();

  const event = (approval: LedgerApproval, extra: Omit<HistoryInput, 'approvalId' | 'projectId' | 'class' | 'action' | 'bindingDigest'>): HistoryInput => ({
    approvalId: approval.id,
    projectId: approval.binding.projectId,
    class: approval.class,
    action: approval.binding.action,
    bindingDigest: approval.bindingDigest,
    ...extra,
  });

  function transition(tx: StoreTransaction, approval: LedgerApproval, to: ApprovalState, reason: string, actor: HistoryInput['actor']) {
    if (!APPROVAL_TRANSITIONS[approval.state].includes(to)) throw new ApprovalError('invalid_transition');
    const from = approval.state;
    approval.state = to;
    if (to !== 'approved') {
      approval.closedAt = iso();
      approval.closedReason = reason;
    }
    const names: Partial<Record<ApprovalState, HistoryInput['event']>> = {
      approved: 'approval.approved',
      rejected: 'approval.rejected',
      withdrawn: 'approval.withdrawn',
      expired: 'approval.expired',
      superseded: 'approval.superseded',
      consumed: 'approval.consumed',
      revoked: 'approval.revoked',
    };
    tx.append(event(approval, { event: names[to]!, actor, from, to, reason }));
  }

  function attemptTransition(tx: StoreTransaction, attempt: LedgerAttempt, to: AttemptState, reason: string | null, actor: HistoryInput['actor']) {
    if (!ATTEMPT_TRANSITIONS[attempt.state].includes(to)) throw new ApprovalError('invalid_transition');
    const from = attempt.state;
    attempt.state = to;
    attempt.outcomeAt = iso();
    attempt.reason = reason;
    const names: Partial<Record<AttemptState, HistoryInput['event']>> = {
      succeeded: 'approval.attempt_succeeded',
      failed: 'approval.attempt_failed',
      indeterminate: 'approval.attempt_indeterminate',
      acknowledged_by_owner: 'approval.attempt_acknowledged',
    };
    tx.append({ event: names[to]!, actor, approvalId: attempt.approvalId, attemptId: attempt.id, from, to, reason });
  }

  const findApproval = (tx: StoreTransaction, id: string, ownerId: string) => {
    const approval = tx.ledger.approvals.find((a) => a.id === id);
    if (!approval || approval.ownerId !== ownerId) throw new ApprovalError('approval_not_issued');
    return approval;
  };

  /** Bloqueado por barreira (durável ou volátil) ou pelo kill switch do controlador? */
  function blocked(tx: { ledger: StoreTransaction['ledger'] } | null, binding: ApprovalBinding): boolean {
    const ledger = tx ? tx.ledger : store.ledger();
    if (ledger.barriers.global || volatileBarriers.has('global')) return true;
    if (binding.projectId !== null && (ledger.barriers.projects[binding.projectId] || volatileBarriers.has(`project:${binding.projectId}`))) return true;
    try {
      if (options.controllerKillSwitch && (options.controllerKillSwitch(null) || (binding.projectId !== null && options.controllerKillSwitch(binding.projectId)))) return true;
    } catch {
      return true; // Falha ao consultar o kill switch → tratado como acionado (fail-closed).
    }
    return false;
  }
  /** Configuração (inclusive a liberação do bloqueio) não é barrada; o resto é. */
  const barredClass = (binding: ApprovalBinding) => bindingClass(binding) !== 'configuration';

  /** Expira o que venceu (pendente e concedida), dentro de uma transação. */
  function expireDue(tx: StoreTransaction, approval: LedgerApproval) {
    const at = now();
    if (approval.state === 'pending' && at >= Date.parse(approval.pendingUntil)) transition(tx, approval, 'expired', 'pending_timeout', SYSTEM);
    else if (approval.state === 'approved') {
      const deadline = monoDeadlines.get(approval.id);
      if (at >= Date.parse(approval.validUntil!) || deadline === undefined || mono() >= deadline || approval.epoch !== tx.epoch) {
        transition(tx, approval, 'expired', 'validity_elapsed', SYSTEM);
        monoDeadlines.delete(approval.id);
      }
    }
  }

  /** Registra uma recusa no histórico sem alterar estado (melhor esforço; nunca libera nada). */
  async function recordDenial(input: HistoryInput) {
    try {
      await store.commit((tx) => tx.append(input));
    } catch {
      // Armazenamento indisponível/degradado: a recusa em si já protege; nada a fazer.
    }
  }

  async function guarded<R>(denial: (code: string) => HistoryInput | null, run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (error) {
      const code = error instanceof ApprovalError ? error.code : 'internal_error';
      const input = denial(REASON.test(code) ? code : 'internal_error');
      if (input && !['store_unavailable', 'store_degraded', 'store_write_failed'].includes(code)) await recordDenial(input);
      throw error instanceof ApprovalError ? error : new ApprovalError('internal_error');
    }
  }

  function consumeProof(proofId: string, ctx: IdentityContext, ownerId: string) {
    assertHumanContext(ctx);
    if (ctx.userId !== ownerId) throw new ApprovalError('identity_mismatch');
    return identity.consume(proofId, ctx);
  }

  function buildArtifacts(approval: LedgerApproval): { grant: ApprovalGrant | null; humanApproval: HumanApproval | null } {
    const b = approval.binding;
    const approvedBy = { kind: 'human' as const, id: approval.decidedBy!.id };
    if (b.action === 'limits.change' || b.action === 'killswitch.release' || b.action === 'gateway.claude_project_enable' || b.action === 'gateway.claude_bridge_credential') {
      return {
        grant: null,
        humanApproval: {
          id: approval.id,
          operation: b.action,
          // Issue #008: a habilitação prende o recibo aos parâmetros exatos (projeto + repositório).
          // Issue #055: a credencial da ponte, idem (projeto, credencial, agente, validade e resumo do token).
          target: b.action === 'killswitch.release' ? b.resource.id : b.paramsDigest,
          approvedBy,
          approvedAt: approval.decidedAt!,
          expiresAt: approval.validUntil!,
        },
      };
    }
    if (Object.hasOwn(POLICY_ACTIONS, b.action)) {
      return {
        grant: {
          id: approval.id,
          method: approval.method,
          action: b.action as PolicyAction,
          projectId: b.projectId,
          resource: { ...b.resource },
          target: { ...b.target },
          subject: { ...b.subject } as ApprovalGrant['subject'],
          approvedBy,
          approvedAt: approval.decidedAt!,
          expiresAt: approval.validUntil!,
        },
        humanApproval: null,
      };
    }
    return { grant: null, humanApproval: null };
  }

  /** Invalida um recibo pendente e encerra a tentativa como `failed` (dentro de uma transação). */
  function invalidateReceipt(tx: StoreTransaction, receipt: Receipt, reason: string) {
    receipts.delete(receipt.approvalId);
    const attempt = tx.ledger.attempts.find((t) => t.id === receipt.attemptId);
    if (attempt && attempt.state === 'reserved') attemptTransition(tx, attempt, 'failed', reason, SYSTEM);
  }

  function scheduleInvalidation(receipt: Receipt, reason: string) {
    receipts.delete(receipt.approvalId);
    void store
      .commit((tx) => {
        const attempt = tx.ledger.attempts.find((t) => t.id === receipt.attemptId);
        tx.append({ event: 'approval.receipt_denied', actor: SYSTEM, approvalId: receipt.approvalId, attemptId: receipt.attemptId, reason });
        if (attempt && attempt.state === 'reserved') attemptTransition(tx, attempt, 'failed', reason, SYSTEM);
      })
      .catch(() => undefined);
  }

  /** Validação SÍNCRONA de um recibo (chamada pelo verificador imediatamente antes do efeito). */
  function validateReceipt(component: ReceiptComponent, id: string, digest: string): ApprovalVerification {
    const status = store.status();
    if (status.state !== 'available') return { authentic: false, reason: status.state === 'degraded' ? 'store_degraded' : 'store_unavailable' };
    const receipt = receipts.get(id);
    if (!receipt) return { authentic: false, reason: 'receipt_missing' };
    const deny = (reason: string): ApprovalVerification => {
      scheduleInvalidation(receipt, reason);
      return { authentic: false, reason };
    };
    if (receipt.component !== component) return deny('receipt_wrong_component');
    if (receipt.epoch !== store.epoch()) return deny('receipt_wrong_epoch');
    if (now() >= receipt.expiresAtWall || mono() >= receipt.expiresAtMono) return deny('receipt_expired');
    if (receipt.objectDigest !== digest) return deny('receipt_operation_mismatch');
    if (barredClass(receipt.binding) && blocked(null, receipt.binding)) return deny('killswitch_engaged');
    receipts.delete(id);
    validatedAttempts.add(receipt.attemptId);
    return { authentic: true, approverId: receipt.approverId };
  }

  function expireReceipts(tx: StoreTransaction) {
    for (const receipt of [...receipts.values()]) {
      if (now() >= receipt.expiresAtWall || mono() >= receipt.expiresAtMono) invalidateReceipt(tx, receipt, 'receipt_expired');
    }
  }

  /** Aplica uma operação interna de configuração (componente `approvals`) com recibo próprio. */
  async function applyInternal(attemptId: string, action: ApprovalBinding['action'], params: unknown, apply: (tx: StoreTransaction, binding: ApprovalBinding) => void) {
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) throw new ApprovalError('attempt_not_found');
    const receipt = [...receipts.values()].find((r) => r.attemptId === attemptId);
    if (!receipt) throw new ApprovalError('receipt_missing');
    if (receipt.binding.action !== action) throw new ApprovalError('receipt_operation_mismatch');
    const expectedParams = action === 'killswitch.release' ? receipt.binding.paramsDigest : paramsDigestOf(action, params);
    if (receipt.binding.paramsDigest !== expectedParams) throw new ApprovalError('receipt_operation_mismatch');
    const verification = validateReceipt('approvals', receipt.approvalId, receipt.objectDigest);
    if (!verification.authentic) throw new ApprovalError(verification.reason);
    await store.commit((tx) => {
      const attempt = tx.ledger.attempts.find((t) => t.id === attemptId);
      if (!attempt || attempt.state !== 'reserved') throw new ApprovalError('attempt_not_reserved');
      apply(tx, receipt.binding);
      attemptTransition(tx, attempt, 'succeeded', null, { kind: 'human', id: verification.approverId });
    });
    validatedAttempts.delete(attemptId);
  }

  function releaseBarrierIn(tx: StoreTransaction, scope: BarrierScope, actorId: string) {
    const key = scopeKey(scope);
    if (scope.kind === 'global') tx.ledger.barriers.global = null;
    else delete tx.ledger.barriers.projects[scope.projectId];
    // Restaura autoridade: a barreira volátil só sai depois que a liberação foi gravada (R3).
    tx.afterCommit(() => volatileBarriers.delete(key));
    tx.append({ event: 'approval.barrier_released', actor: { kind: 'human', id: actorId }, projectId: scope.kind === 'project' ? scope.projectId : null, reason: 'human_approved', detail: `scope ${scope.kind}` });
  }

  const killswitchScope = (binding: ApprovalBinding): BarrierScope =>
    binding.resource.id === 'global' ? { kind: 'global' } : { kind: 'project', projectId: binding.resource.id };

  function validateKillswitchBinding(binding: ApprovalBinding) {
    if (binding.action !== 'killswitch.release') return;
    const scope = binding.resource.id === 'global' ? null : binding.resource.id;
    if (binding.resource.type !== 'killswitch' || (scope !== null && !UUID.test(scope)) || binding.projectId !== scope) throw new ApprovalError('invalid_binding');
    if (binding.paramsDigest !== paramsDigestOf('killswitch.release', { scope: scope ?? 'global' })) throw new ApprovalError('invalid_binding');
  }

  /** Valida a apresentação contra o vínculo (R1); devolve a cópia normalizada ou recusa. */
  function presentationFor(binding: ApprovalBinding, digest: string, requestedBy: LedgerApproval['requestedBy'], raw: unknown) {
    const check = verifyApprovalPresentation({ binding, bindingDigest: digest, requestedBy, presentation: raw as LedgerApproval['presentation'] });
    if (!check.ok) throw new ApprovalError(check.reason);
    return check.presentation;
  }

  const service = {
    /**
     * Pedido de aprovação, feito por um COMPONENTE DO SERVIDOR em nome de uma tarefa (nunca por um
     * agente pela web; agentes não têm credencial nem rota nesta fase). Ações de pessoas usam
     * `confirmOwner`. Mesmo vínculo → mesmo pedido; vínculo da mesma operação com SHA/parâmetros/
     * política diferentes torna os anteriores `superseded`.
     */
    request(input: { ownerId: string; requestedBy: string; binding: unknown; presentation?: unknown }): Promise<LedgerApproval> {
      return guarded(
        () => null,
        async () => {
          const requester = parseComponentId(input.requestedBy);
          const binding = parseBinding(input.binding);
          validateKillswitchBinding(binding);
          // Operações de configuração do próprio ACC só nascem da confirmação do PO (nunca de agente).
          if (binding.subject.kind !== 'agent' || (CONFIGURATION_OPERATIONS as readonly string[]).includes(binding.action)) throw new ApprovalError('use_owner_confirmation');
          if (binding.policyVersion !== options.policyVersion) throw new ApprovalError('policy_version_mismatch');
          const cls = bindingClass(binding);
          const digest = bindingDigest(binding);
          // Correção R1: os parâmetros exatos entregues pelo componente precisam reproduzir o
          // `paramsDigest` no formato esperado para ESTE solicitante; senão nada é criado.
          // Sem apresentação o pedido é registrado, mas só pode ser rejeitado.
          const presentation = input.presentation === undefined ? undefined : presentationFor(binding, digest, { kind: 'system', id: requester }, input.presentation);
          return store.commit((tx) => {
            const sameOperation = (a: LedgerApproval) =>
              a.ownerId === input.ownerId &&
              a.binding.action === binding.action &&
              a.binding.projectId === binding.projectId &&
              a.binding.resource.type === binding.resource.type &&
              a.binding.resource.id === binding.resource.id &&
              a.binding.subject.kind === binding.subject.kind &&
              a.binding.subject.id === binding.subject.id;
            for (const a of tx.ledger.approvals) if (a.state === 'pending' || a.state === 'approved') expireDue(tx, a);
            const existing = tx.ledger.approvals.find((a) => sameOperation(a) && a.bindingDigest === digest && (a.state === 'pending' || a.state === 'approved'));
            if (existing) return structuredClone(existing);
            for (const a of tx.ledger.approvals) {
              if (sameOperation(a) && (a.state === 'pending' || a.state === 'approved')) {
                transition(tx, a, 'superseded', 'binding_changed', SYSTEM);
                monoDeadlines.delete(a.id);
              }
            }
            const at = now();
            const approval: LedgerApproval = {
              id: generateId(),
              ownerId: input.ownerId,
              class: cls,
              method: 'approval',
              binding,
              bindingDigest: digest,
              state: 'pending',
              epoch: null,
              requestedBy: { kind: 'system', id: requester },
              requestedAt: iso(at),
              pendingUntil: iso(at + PENDING_TTL_MS),
              decidedBy: null,
              decidedAt: null,
              confirmation: null,
              validUntil: null,
              closedAt: null,
              closedReason: null,
              attemptId: null,
              ...(presentation ? { presentation } : {}),
            };
            tx.ledger.approvals.push(approval);
            tx.append(event(approval, { event: 'approval.requested', actor: { kind: 'system', id: requester }, to: 'pending', reason: 'requested' }));
            return structuredClone(approval);
          });
        },
      );
    },

    /**
     * Decisão do PO sobre um pedido de OUTRO sujeito. Exige prova de *step-up* desta sessão e o
     * `bindingDigest` exibido (aprova-se exatamente o que foi mostrado).
     */
    decide(input: {
      ownerId: string;
      approvalId: string;
      decision: 'approve' | 'reject';
      bindingDigest: string;
      /** Obrigatório para aprovar (R1): resumo do vínculo + parâmetros que o navegador exibiu. */
      presentationDigest?: string | null;
      proofId: string;
      identity: IdentityContext;
    }): Promise<LedgerApproval> {
      return guarded(
        (code) => ({ event: 'approval.decision_denied', actor: { kind: 'human', id: typeof input.identity?.userId === 'string' && /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(input.identity.userId) ? input.identity.userId : 'unknown' }, approvalId: UUID.test(String(input.approvalId)) ? input.approvalId : null, reason: code }),
        async () => {
          if (input.decision !== 'approve' && input.decision !== 'reject') throw new ApprovalError('invalid_decision');
          const confirmation = consumeProof(input.proofId, input.identity, input.ownerId);
          const deciderId = input.identity.userId;
          return store.commit((tx) => {
            const approval = findApproval(tx, input.approvalId, input.ownerId);
            expireDue(tx, approval);
            if (approval.state !== 'pending') throw new ApprovalError(approval.state === 'expired' ? 'approval_expired' : 'already_decided');
            if (approval.bindingDigest !== input.bindingDigest) throw new ApprovalError('binding_mismatch');
            if (isAgentId(deciderId)) throw new ApprovalError('approver_not_human');
            if (approval.binding.subject.kind === 'human' && approval.binding.subject.id === deciderId) throw new ApprovalError('self_approval');
            approval.decidedBy = { kind: 'human', id: deciderId };
            approval.decidedAt = iso();
            approval.confirmation = { method: confirmation.method, at: confirmation.at };
            if (input.decision === 'reject') {
              transition(tx, approval, 'rejected', 'rejected_by_owner', { kind: 'human', id: deciderId });
              return structuredClone(approval);
            }
            if (barredClass(approval.binding) && blocked(tx, approval.binding)) throw new ApprovalError('killswitch_engaged');
            // Correção R1: aprovar exige os parâmetros apresentados, válidos e coerentes com o
            // vínculo, E o resumo da apresentação que o administrador conferiu. Um `bindingDigest`
            // ou `paramsDigest` coincidente nunca basta. (Rejeitar não depende disto.)
            const presented = verifyApprovalPresentation(approval);
            if (!presented.ok) throw new ApprovalError(presented.reason);
            if (typeof input.presentationDigest !== 'string' || input.presentationDigest !== presented.digest) throw new ApprovalError('presentation_mismatch');
            const at = now();
            approval.epoch = tx.epoch;
            approval.validUntil = iso(at + APPROVAL_TTL_MS[approval.class]);
            transition(tx, approval, 'approved', 'approved_by_owner', { kind: 'human', id: deciderId });
            // Concede autoridade: só depois da gravação (R3 da revisão).
            const deadline = mono() + APPROVAL_TTL_MS[approval.class];
            tx.afterCommit(() => monoDeadlines.set(approval.id, deadline));
            return structuredClone(approval);
          });
        },
      );
    },

    /**
     * Confirmação especial do PO (D2/R4) para uma operação CRÍTICA ou de CONFIGURAÇÃO que ele
     * mesmo iniciou. O sujeito é a pessoa da sessão (nunca um valor informado); a prova de
     * *step-up* é desta sessão e de uso único. Não vale para a classe `execution`.
     */
    confirmOwner(input: { ownerId: string; binding: unknown; bindingDigest: string; proofId: string; identity: IdentityContext; presentation?: unknown }): Promise<LedgerApproval> {
      return guarded(
        (code) => ({ event: 'approval.decision_denied', actor: { kind: 'human', id: typeof input.identity?.userId === 'string' && /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(input.identity.userId) ? input.identity.userId : 'unknown' }, reason: code }),
        async () => {
          const binding = parseBinding(input.binding);
          validateKillswitchBinding(binding);
          const confirmation = consumeProof(input.proofId, input.identity, input.ownerId);
          const userId = input.identity.userId;
          if (binding.subject.kind !== 'human' || binding.subject.id !== userId) throw new ApprovalError('invalid_owner_confirmation');
          const cls = bindingClass(binding);
          if (cls === 'execution') throw new ApprovalError('invalid_owner_confirmation');
          if (binding.policyVersion !== options.policyVersion) throw new ApprovalError('policy_version_mismatch');
          const digest = bindingDigest(binding);
          if (digest !== input.bindingDigest) throw new ApprovalError('binding_mismatch');
          const presentation = input.presentation === undefined ? undefined : presentationFor(binding, digest, { kind: 'human', id: userId }, input.presentation);
          return store.commit((tx) => {
            if (barredClass(binding) && blocked(tx, binding)) throw new ApprovalError('killswitch_engaged');
            const at = now();
            const approval: LedgerApproval = {
              id: generateId(),
              ownerId: input.ownerId,
              class: cls,
              method: 'owner_confirmation',
              binding,
              bindingDigest: digest,
              state: 'pending',
              epoch: null,
              requestedBy: { kind: 'human', id: userId },
              requestedAt: iso(at),
              pendingUntil: iso(at + PENDING_TTL_MS),
              decidedBy: null,
              decidedAt: null,
              confirmation: null,
              validUntil: null,
              closedAt: null,
              closedReason: null,
              attemptId: null,
              ...(presentation ? { presentation } : {}),
            };
            tx.ledger.approvals.push(approval);
            tx.append(event(approval, { event: 'approval.requested', actor: { kind: 'human', id: userId }, to: 'pending', reason: 'owner_initiated' }));
            approval.decidedBy = { kind: 'human', id: userId };
            approval.decidedAt = iso(at);
            approval.confirmation = { method: confirmation.method, at: confirmation.at };
            approval.epoch = tx.epoch;
            approval.validUntil = iso(at + APPROVAL_TTL_MS[cls]);
            transition(tx, approval, 'approved', 'owner_confirmed', { kind: 'human', id: userId });
            tx.append(event(approval, { event: 'approval.owner_confirmed', actor: { kind: 'human', id: userId }, reason: confirmation.method }));
            const deadline = mono() + APPROVAL_TTL_MS[cls];
            tx.afterCommit(() => monoDeadlines.set(approval.id, deadline));
            return structuredClone(approval);
          });
        },
      );
    },

    /** Retirada pelo componente que pediu (pedido não mais necessário). */
    withdraw(input: { ownerId: string; approvalId: string; requestedBy: string }): Promise<LedgerApproval> {
      return store.commit((tx) => {
        const approval = findApproval(tx, input.approvalId, input.ownerId);
        if (approval.requestedBy.kind !== 'system' || approval.requestedBy.id !== parseComponentId(input.requestedBy)) throw new ApprovalError('not_requester');
        transition(tx, approval, 'withdrawn', 'withdrawn_by_requester', { kind: 'system', id: approval.requestedBy.id });
        return structuredClone(approval);
      });
    },

    /** Revogação pelo PO: `approved → revoked`; recibo pendente é invalidado (tentativa `failed`). */
    revoke(input: { ownerId: string; approvalId: string; proofId: string; identity: IdentityContext }): Promise<LedgerApproval> {
      return guarded(
        (code) => ({ event: 'approval.transition_denied', actor: SYSTEM, approvalId: UUID.test(String(input.approvalId)) ? input.approvalId : null, reason: code }),
        async () => {
          consumeProof(input.proofId, input.identity, input.ownerId);
          return store.commit((tx) => {
            const approval = findApproval(tx, input.approvalId, input.ownerId);
            const actor = { kind: 'human' as const, id: input.identity.userId };
            const receipt = receipts.get(approval.id);
            if (approval.state === 'consumed' && receipt) {
              invalidateReceipt(tx, receipt, 'revoked');
              return structuredClone(approval);
            }
            transition(tx, approval, 'revoked', 'revoked_by_owner', actor);
            monoDeadlines.delete(approval.id);
            return structuredClone(approval);
          });
        },
      );
    },

    /**
     * Reserva durável (R1). O chamador informa o vínculo que VAI executar; ele é revalidado e
     * comparado ao aprovado. Só depois da gravação o recibo é emitido.
     */
    reserve(input: { ownerId: string; approvalId: string; component: ReceiptComponent; binding: unknown }): Promise<Reservation> {
      return guarded(
        (code) => ({ event: 'approval.consume_denied', actor: SYSTEM, approvalId: UUID.test(String(input.approvalId)) ? input.approvalId : null, reason: code }),
        async () => {
          if (!(RECEIPT_COMPONENTS as readonly string[]).includes(input.component)) throw new ApprovalError('invalid_component');
          const expected = parseBinding(input.binding);
          if (expected.policyVersion !== options.policyVersion) throw new ApprovalError('policy_version_mismatch');
          const digest = bindingDigest(expected);
          const attemptId = generateId();
          const reserved = await store.commit((tx) => {
            expireReceipts(tx);
            const approval = findApproval(tx, input.approvalId, input.ownerId);
            expireDue(tx, approval);
            if (approval.state !== 'approved') throw new ApprovalError(approval.state === 'consumed' ? 'approval_already_used' : `approval_${approval.state}`);
            if (approval.epoch !== tx.epoch) throw new ApprovalError('approval_expired');
            if (approval.bindingDigest !== digest) {
              // Mesma operação com SHA/parâmetros/política diferentes → a aprovação deixa de valer.
              const same = approval.binding.action === expected.action && approval.binding.resource.id === expected.resource.id && approval.binding.projectId === expected.projectId;
              if (same) {
                transition(tx, approval, 'superseded', 'binding_changed', SYSTEM);
                monoDeadlines.delete(approval.id);
                return { superseded: true as const };
              }
              throw new ApprovalError('binding_mismatch');
            }
            if (approval.decidedBy === null || isAgentId(approval.decidedBy.id)) throw new ApprovalError('approver_not_human');
            if (approval.method === 'approval' && approval.binding.subject.kind === 'human' && approval.binding.subject.id === approval.decidedBy.id) throw new ApprovalError('self_approval');
            if (barredClass(approval.binding) && blocked(tx, approval.binding)) throw new ApprovalError('killswitch_engaged');
            transition(tx, approval, 'consumed', 'reserved', SYSTEM);
            approval.attemptId = attemptId;
            monoDeadlines.delete(approval.id);
            const attempt: LedgerAttempt = { id: attemptId, approvalId: approval.id, component: input.component, state: 'reserved', reservedAt: iso(), epoch: tx.epoch, outcomeAt: null, reason: null };
            tx.ledger.attempts.push(attempt);
            return { superseded: false as const, approval: structuredClone(approval) };
          });
          if (reserved.superseded) throw new ApprovalError('binding_changed');
          const artifacts = buildArtifacts(reserved.approval);
          const object = artifacts.grant ?? artifacts.humanApproval;
          const wall = now() + RECEIPT_TTL_MS;
          receipts.set(reserved.approval.id, {
            attemptId,
            approvalId: reserved.approval.id,
            component: input.component,
            epoch: store.epoch(),
            objectDigest: object ? objectDigest(artifacts.grant ? 'grant' : 'human', object) : objectDigest('human', { id: reserved.approval.id, binding: reserved.approval.bindingDigest }),
            binding: reserved.approval.binding,
            approverId: reserved.approval.decidedBy!.id,
            expiresAtWall: wall,
            expiresAtMono: mono() + RECEIPT_TTL_MS,
          });
          return { attemptId, approvalId: reserved.approval.id, component: input.component, ...artifacts, receiptExpiresAt: iso(wall) };
        },
      );
    },

    /** Verificador confiável para UM componente (recibos de outros componentes são recusados). */
    verifierFor(component: ReceiptComponent): TrustedApprovalVerifier {
      if (!(RECEIPT_COMPONENTS as readonly string[]).includes(component) || component === 'approvals') throw new ApprovalError('invalid_component');
      return Object.freeze({
        id: `acc-approvals:${component}`,
        kind: 'trusted' as const,
        component,
        verify(approval: HumanApproval): ApprovalVerification {
          try {
            return validateReceipt(component, approval.id, objectDigest('human', approval));
          } catch {
            return { authentic: false, reason: 'approval_verification_failed' };
          }
        },
        verifyGrant(grant: ApprovalGrant): ApprovalVerification {
          try {
            return validateReceipt(component, grant.id, objectDigest('grant', grant));
          } catch {
            return { authentic: false, reason: 'approval_verification_failed' };
          }
        },
      });
    },

    /** Resultado da operação. `succeeded` só depois que o recibo foi validado pelo verificador. */
    recordOutcome(input: { attemptId: string; outcome: 'succeeded' | 'failed'; reason?: string | null }): Promise<LedgerAttempt> {
      return store.commit((tx) => {
        const attempt = tx.ledger.attempts.find((t) => t.id === input.attemptId);
        if (!attempt) throw new ApprovalError('attempt_not_found');
        if (attempt.component === 'approvals') throw new ApprovalError('internal_component');
        const reason = input.reason ?? null;
        if (reason !== null && !REASON.test(reason)) throw new ApprovalError('invalid_reason');
        if (input.outcome === 'succeeded') {
          if (!validatedAttempts.has(attempt.id)) throw new ApprovalError('receipt_not_validated');
          attemptTransition(tx, attempt, 'succeeded', reason, SYSTEM);
          const approval = tx.ledger.approvals.find((a) => a.id === attempt.approvalId)!;
          // A liberação do kill switch do controlador (#022) libera também a barreira durável.
          if (approval.binding.action === 'killswitch.release') releaseBarrierIn(tx, killswitchScope(approval.binding), approval.decidedBy!.id);
        } else {
          const receipt = receipts.get(attempt.approvalId);
          if (receipt && receipt.attemptId === attempt.id) receipts.delete(attempt.approvalId);
          attemptTransition(tx, attempt, 'failed', reason ?? 'operation_failed', SYSTEM);
        }
        validatedAttempts.delete(attempt.id);
        return structuredClone(attempt);
      });
    },

    /** O PO reconhece uma tentativa `indeterminate` (sem reexecutar nada). */
    acknowledgeAttempt(input: { ownerId: string; attemptId: string; proofId: string; identity: IdentityContext }): Promise<LedgerAttempt> {
      return guarded(
        () => null,
        async () => {
          consumeProof(input.proofId, input.identity, input.ownerId);
          return store.commit((tx) => {
            const attempt = tx.ledger.attempts.find((t) => t.id === input.attemptId);
            if (!attempt) throw new ApprovalError('attempt_not_found');
            findApproval(tx, attempt.approvalId, input.ownerId);
            attemptTransition(tx, attempt, 'acknowledged_by_owner', 'owner_acknowledged', { kind: 'human', id: input.identity.userId });
            return structuredClone(attempt);
          });
        },
      );
    },

    /**
     * Aciona a barreira de emergência no escopo (D6/N3). Efeito IMEDIATO em memória; depois,
     * durável: revoga as aprovações de execução não usadas do escopo e invalida recibos pendentes
     * (exceto configuração). Falha de gravação mantém a barreira volátil e degrada o armazenamento.
     */
    engageBarrier(input: { scope: unknown; actor: { kind: 'human' | 'system'; id: string }; reason: string }): Promise<void> {
      const scope = parseScope(input.scope);
      if (!REASON.test(input.reason)) throw new ApprovalError('invalid_reason');
      volatileBarriers.add(scopeKey(scope));
      return store.commit((tx) => {
        const barrier = { engagedAt: iso(), epoch: tx.epoch, reason: input.reason };
        if (scope.kind === 'global') tx.ledger.barriers.global ??= barrier;
        else tx.ledger.barriers.projects[scope.projectId] ??= barrier;
        tx.append({ event: 'approval.barrier_engaged', actor: input.actor, projectId: scope.kind === 'project' ? scope.projectId : null, reason: input.reason, detail: `scope ${scope.kind}` });
        for (const approval of tx.ledger.approvals) {
          if (approval.state === 'approved' && approval.class === 'execution' && inScope(approval.binding, scope)) {
            transition(tx, approval, 'revoked', 'killswitch', SYSTEM);
            monoDeadlines.delete(approval.id);
          }
        }
        for (const receipt of [...receipts.values()]) {
          if (barredClass(receipt.binding) && inScope(receipt.binding, scope)) invalidateReceipt(tx, receipt, 'killswitch_engaged');
        }
      });
    },

    /** Libera a barreira durável com uma aprovação `killswitch.release` reservada (componente `approvals`). */
    releaseBarrier(input: { attemptId: string }): Promise<void> {
      return applyInternal(input.attemptId, 'killswitch.release', null, (tx, binding) => releaseBarrierIn(tx, killswitchScope(binding), binding.subject.id));
    },

    /** Muda a retenção do histórico (N10) com aprovação de configuração reservada. */
    changeRetention(input: { attemptId: string; days: number }): Promise<void> {
      if (!Number.isSafeInteger(input.days) || input.days < HISTORY_RETENTION_DAYS.min || input.days > HISTORY_RETENTION_DAYS.max) return Promise.reject(new ApprovalError('invalid_retention'));
      return applyInternal(input.attemptId, 'approvals.retention_change', { days: input.days }, (tx, binding) => {
        const from = tx.history.retentionDays;
        tx.history.retentionDays = input.days;
        tx.append({ event: 'approval.retention_changed', actor: { kind: 'human', id: binding.subject.id }, reason: 'human_approved', detail: `days ${from} to ${input.days}` });
      });
    },

    /** Descarte administrativo (D7): só entradas anteriores a `before` (≥ 30 dias) e sem preservação. */
    purgeHistory(input: { attemptId: string; before: string }): Promise<void> {
      const before = Date.parse(input.before);
      if (!Number.isFinite(before) || new Date(before).toISOString() !== input.before || before > now() - PURGE_MIN_AGE_MS) return Promise.reject(new ApprovalError('invalid_purge_window'));
      return applyInternal(input.attemptId, 'approvals.history_purge', { before: input.before }, (tx, binding) => {
        const purged = purge(tx, before);
        tx.append({ event: 'approval.history_purged', actor: { kind: 'human', id: binding.subject.id }, reason: 'administrative', detail: `count ${purged}` });
      });
    },

    /** Preservação justificada (N8): impede descarte e compactação dos registros da aprovação. */
    addHold(input: { ownerId: string; approvalId: string; reason: HoldReason; note?: string | null; proofId: string; identity: IdentityContext }): Promise<void> {
      return guarded(
        () => null,
        async () => {
          if (!(HOLD_REASONS as readonly string[]).includes(input.reason)) throw new ApprovalError('invalid_hold_reason');
          const note = input.note == null ? null : sanitizeNote(String(input.note));
          if (note !== null && note.length > HOLD_NOTE_MAX) throw new ApprovalError('hold_note_too_long');
          consumeProof(input.proofId, input.identity, input.ownerId);
          await store.commit((tx) => {
            const approval = tx.ledger.approvals.find((a) => a.id === input.approvalId && a.ownerId === input.ownerId);
            const known = approval || tx.history.items.some((i) => i.kind === 'entry' && i.approvalId === input.approvalId);
            if (!known) throw new ApprovalError('approval_not_issued');
            tx.history.holds.push({ id: generateId(), approvalId: input.approvalId, reason: input.reason, note: note === '' ? null : note, createdAt: iso(), createdBy: input.identity.userId });
            tx.append({ event: 'approval.hold_added', actor: { kind: 'human', id: input.identity.userId }, approvalId: input.approvalId, reason: input.reason });
          });
        },
      );
    },

    removeHold(input: { ownerId: string; holdId: string; proofId: string; identity: IdentityContext }): Promise<void> {
      return guarded(
        () => null,
        async () => {
          consumeProof(input.proofId, input.identity, input.ownerId);
          await store.commit((tx) => {
            const index = tx.history.holds.findIndex((h) => h.id === input.holdId);
            if (index < 0) throw new ApprovalError('hold_not_found');
            const [hold] = tx.history.holds.splice(index, 1);
            tx.append({ event: 'approval.hold_removed', actor: { kind: 'human', id: input.identity.userId }, approvalId: hold.approvalId, reason: hold.reason });
          });
        },
      );
    },

    /**
     * Manutenção periódica (o PR 2 agenda): expira pedidos e aprovações vencidos, encerra recibos
     * vencidos, compacta registros terminais antigos (N7) e aplica a retenção do histórico (D7).
     */
    sweep(): Promise<void> {
      return store.commit((tx) => {
        expireReceipts(tx);
        for (const approval of tx.ledger.approvals) expireDue(tx, approval);
        compact(tx);
        const cutoff = now() - tx.history.retentionDays * DAY;
        const purged = purge(tx, cutoff);
        if (purged > 0) tx.append({ event: 'approval.history_purged', actor: SYSTEM, reason: 'retention', detail: `count ${purged}` });
      });
    },

    /**
     * Recuperação ADMINISTRATIVA (R2/5.5): só com o armazenamento indisponível, com confirmação
     * recente do PO e motivo da lista fechada. Preserva as evidências em quarentena, nunca reativa
     * aprovações antigas e deixa a BARREIRA GLOBAL ativa (liberar exige nova aprovação).
     */
    async recover(input: { ownerId: string; reason: RecoveryReason; proofId: string; identity: IdentityContext }): Promise<{ quarantineId: string }> {
      if (!(RECOVERY_REASONS as readonly string[]).includes(input.reason)) throw new ApprovalError('invalid_recovery_reason');
      consumeProof(input.proofId, input.identity, input.ownerId);
      receipts.clear();
      validatedAttempts.clear();
      monoDeadlines.clear();
      volatileBarriers.add('global');
      return store.recover({ actorId: input.identity.userId, reason: input.reason });
    },

    /** Ids consumidos, exceto o indicado (para `PolicyFacts.usedApprovals` no consumo atual). */
    consumedApprovalIds(except: string | null = null): ReadonlySet<string> {
      return new Set(store.ledger().approvals.filter((a) => a.state === 'consumed' && a.id !== except).map((a) => a.id));
    },

    list(ownerId: string): LedgerApproval[] {
      return store.ledger().approvals.filter((a) => a.ownerId === ownerId).map((a) => structuredClone(a));
    },

    barriers() {
      const ledger = store.ledger();
      return { durable: structuredClone(ledger.barriers), volatile: [...volatileBarriers].sort() };
    },

    status: () => store.status(),

    policyVersion: options.policyVersion,

    /** Uma aprovação do dono (cópia), ou `null` (inexistente ou de outro dono: indistinguíveis). */
    get(ownerId: string, approvalId: string): LedgerApproval | null {
      const approval = store.ledger().approvals.find((a) => a.id === approvalId && a.ownerId === ownerId);
      return approval ? structuredClone(approval) : null;
    },

    /** Tentativas de uso de uma aprovação do dono. */
    attemptsOf(ownerId: string, approvalId: string): LedgerAttempt[] {
      const approval = store.ledger().approvals.find((a) => a.id === approvalId && a.ownerId === ownerId);
      if (!approval) return [];
      return store.ledger().attempts.filter((t) => t.approvalId === approvalId).map((t) => structuredClone(t));
    },

    /** Histórico oficial (cópia, sem MACs): itens, preservações e retenção. */
    history() {
      const history = store.history();
      return { retentionDays: history.retentionDays, items: structuredClone(history.items), holds: structuredClone(history.holds) };
    },

    /**
     * Operação de configuração do próprio núcleo iniciada pelo PO (D2/N10/D7), em um único passo:
     * valida os parâmetros, confirma a identidade (prova de uso único desta sessão), cria a
     * aprovação `owner_confirmation`, reserva-a (componente interno) e aplica. O vínculo é montado
     * pelo SERVIDOR a partir dos parâmetros recebidos; o sujeito é sempre a pessoa da sessão.
     */
    async configure(input: {
      ownerId: string;
      operation: 'approvals.retention_change' | 'approvals.history_purge';
      params: { days?: unknown; before?: unknown };
      proofId: string;
      identity: IdentityContext;
    }): Promise<LedgerApproval> {
      assertHumanContext(input.identity);
      let params: { days: number } | { before: string };
      if (input.operation === 'approvals.retention_change') {
        const days = input.params.days;
        if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < HISTORY_RETENTION_DAYS.min || days > HISTORY_RETENTION_DAYS.max) throw new ApprovalError('invalid_retention');
        params = { days };
      } else if (input.operation === 'approvals.history_purge') {
        const before = input.params.before;
        const ms = typeof before === 'string' ? Date.parse(before) : NaN;
        if (typeof before !== 'string' || !Number.isFinite(ms) || new Date(ms).toISOString() !== before || ms > now() - PURGE_MIN_AGE_MS) throw new ApprovalError('invalid_purge_window');
        params = { before };
      } else {
        throw new ApprovalError('action_not_approvable');
      }
      const binding: ApprovalBinding = {
        action: input.operation,
        projectId: null,
        resource: { type: 'approvals', id: 'history' },
        target: { sha: null, ref: null },
        subject: { kind: 'human', id: input.identity.userId },
        paramsDigest: paramsDigestOf(input.operation, params),
        policyVersion: options.policyVersion,
      };
      const approval = await service.confirmOwner({
        ownerId: input.ownerId,
        binding,
        bindingDigest: bindingDigest(binding),
        proofId: input.proofId,
        identity: input.identity,
        presentation: { kind: input.operation, params },
      });
      const reservation = await service.reserve({ ownerId: input.ownerId, approvalId: approval.id, component: 'approvals', binding });
      if ('days' in params) await service.changeRetention({ attemptId: reservation.attemptId, days: params.days });
      else await service.purgeHistory({ attemptId: reservation.attemptId, before: params.before });
      return service.get(input.ownerId, approval.id) ?? approval;
    },

    /**
     * Atesta (N4) um grant `owner_confirmation` reservado para o componente `policy`: devolve o id
     * para `PolicyFacts.verifiedOwnerConfirmationId` só se o recibo for válido. Qualquer outra coisa
     * (grant forjado, de outro componente, vencido, `approval` comum) → `null`.
     */
    attestOwnerConfirmation(grant: ApprovalGrant): string | null {
      if (grant?.method !== 'owner_confirmation') return null;
      const verification = service.verifierFor('policy').verifyGrant(grant);
      return verification.authentic && verification.approverId === grant.approvedBy.id ? grant.id : null;
    },
  };
  return service;

  /** Compactação (N7): terminais com mais de 30 dias, sem preservação e sem tentativa em aberto. */
  function compact(tx: StoreTransaction) {
    const held = new Set(tx.history.holds.map((h) => h.approvalId));
    const cutoff = now() - COMPACTION_AFTER_MS;
    const removable = new Set(
      tx.ledger.approvals
        .filter((a) => a.closedAt !== null && Date.parse(a.closedAt) <= cutoff && !held.has(a.id))
        .filter((a) => {
          const attempt = a.attemptId ? tx.ledger.attempts.find((t) => t.id === a.attemptId) : null;
          return !attempt || !['reserved', 'indeterminate'].includes(attempt.state);
        })
        .map((a) => a.id),
    );
    if (removable.size === 0) return;
    tx.ledger.approvals = tx.ledger.approvals.filter((a) => !removable.has(a.id));
    tx.ledger.attempts = tx.ledger.attempts.filter((t) => !removable.has(t.approvalId));
    tx.ledger.compaction = { lastAt: iso(), removed: tx.ledger.compaction.removed + removable.size };
    tx.append({ event: 'approval.compacted', actor: SYSTEM, reason: 'compaction', detail: `count ${removable.size}` });
  }

  /**
   * Retenção do histórico: entradas anteriores a `cutoff`, sem preservação e que não sejam a
   * última, viram lápides (o encadeamento continua verificável). Devolve quantas foram descartadas.
   */
  function purge(tx: StoreTransaction, cutoff: number): number {
    const held = new Set(tx.history.holds.map((h) => h.approvalId));
    const liveIds = new Set(tx.ledger.approvals.map((a) => a.id));
    const items = tx.history.items;
    const out: HistoryItem[] = [];
    let purged = 0;
    items.forEach((item, index) => {
      const last = out[out.length - 1];
      const isLast = index === items.length - 1;
      const purgeable =
        item.kind === 'entry' &&
        !isLast &&
        Date.parse(item.at) < cutoff &&
        !(item.approvalId && (held.has(item.approvalId) || liveIds.has(item.approvalId)));
      if (item.kind === 'tombstone' || purgeable) {
        const count = item.kind === 'tombstone' ? item.purged : 1;
        if (item.kind === 'entry') purged += 1;
        if (last && last.kind === 'tombstone') {
          const merged: HistoryTombstone = { ...last, seq: item.seq, hash: item.hash, purged: last.purged + count };
          out[out.length - 1] = merged;
        } else {
          out.push({ kind: 'tombstone', firstSeq: item.kind === 'tombstone' ? item.firstSeq : item.seq, seq: item.seq, prevHash: item.prevHash, hash: item.hash, purged: count });
        }
      } else {
        out.push(item);
      }
    });
    tx.history.items = out;
    return purged;
  }
}

export type ApprovalService = ReturnType<typeof createApprovalService>;

/** O que um componente do servidor (sandbox #021, controlador #022) usa do núcleo. */
export type ApprovalCoordinator = Pick<ApprovalService, 'request' | 'reserve' | 'recordOutcome'> & Partial<Pick<ApprovalService, 'confirmOwner'>>;
