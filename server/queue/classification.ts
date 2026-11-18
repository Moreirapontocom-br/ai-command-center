/**
 * Classificação EXPLÍCITA das recusas de admissão/preparação (Issue #012, PR 2 — Q5).
 *
 * - `definitive`: violação de política ou condição que comprovadamente NÃO se resolve com espera ou
 *   disponibilidade (exige mudar o pedido, a política ou os limites aprovados). Só estas levam
 *   `queued → failed`.
 * - `recoverable`: limite de concorrência, rate limit, aprovação pendente, indisponibilidade
 *   (transitória ou ainda não verificada) e qualquer código DESCONHECIDO. O item continua
 *   `queued` e expira pelo TTL de 24 h se nunca puder ser admitido — nunca é declarado falho só
 *   porque um provedor está indisponível.
 */
export type RefusalClass = 'definitive' | 'recoverable';

export const DEFINITIVE_REFUSALS: ReadonlySet<string> = new Set([
  // Política (#020) e aprovações (#011) inválidas para ESTE pedido.
  'policy_denied',
  'spend_policy_denied',
  'approval_invalid',
  'spend_approval_invalid',
  'approval_not_authentic',
  'approver_identity_mismatch',
  // Projeto/tarefa/agente (#004/#005).
  'not_found',
  'task_not_active',
  'agent_not_assigned',
  'repository_not_linked',
  // Pedido incompatível com os limites/custos aprovados (só muda com nova aprovação humana).
  'idempotency_conflict',
  'cost_unknown',
  'budget_exceeded',
  'project_budget_exceeded',
  'provider_budget_exceeded',
  'duration_out_of_limits',
  'tokens_out_of_limits',
  'invalid_request',
  'invalid_params',
  'admission_without_approval',
  // Execução real desligada (exige PR aprovado; não há espera que resolva).
  'real_execution_disabled',
]);

export const RECOVERABLE_REFUSALS: ReadonlySet<string> = new Set([
  'concurrency_limit',
  'rate_limited',
  'provider_request_limit',
  'provider_unavailable',
  'provider_unverified',
  'capability_unavailable',
  'paid_usage_unavailable',
  'approval_pending',
  'approval_required',
  'spend_approval_required',
  'approvals_unavailable',
  'approval_verifier_unavailable',
  'kill_switch_engaged',
  'killswitch_engaged',
  'store_unavailable',
  'store_degraded',
  'not_restored',
  'expired',
  'task_busy',
]);

/** Recusas que bloqueiam TODO o ciclo (recursos globais): itens seguintes não passam à frente. */
export const GLOBAL_REFUSALS: ReadonlySet<string> = new Set(['concurrency_limit', 'rate_limited', 'not_restored']);

export function classifyRefusal(code: string): RefusalClass {
  if (DEFINITIVE_REFUSALS.has(code)) return 'definitive';
  return 'recoverable';
}

/** Ordem de prioridade (maior primeiro); empate → FIFO por criação e posição no ledger. */
export const PRIORITY_RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2, low: 3 };
