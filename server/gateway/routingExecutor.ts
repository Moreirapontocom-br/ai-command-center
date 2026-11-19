import type { DispatchResult, ExecutionResult, ExecutorPort, QueueSubject } from '../queue/ports.ts';

/**
 * Executor COMPOSTO da fila central (Issue #028, D6): um único `ExecutorPort` para o agendador
 * (#012), que encaminha cada item pelo TIPO declarado nos parâmetros de execução:
 * - `execution.executor === 'gateway'` → executor do Agent Gateway;
 * - qualquer outro formato → executor do sandbox (#021), com os parâmetros intactos.
 *
 * Nenhum agendamento paralelo é criado. Só aceita executores `simulated` (nenhum executor real).
 * A rota de cada item é lembrada na preparação; despacho, cancelamento, descarte e a verificação
 * de origem (I8) vão para o executor que preparou o item. Sem rota conhecida (ex.: depois de um
 * reinício) → `not_supported`/`not_started`/não autenticado (conservador).
 */
export function createRoutingExecutor(options: { gateway: ExecutorPort; sandbox: ExecutorPort }): ExecutorPort {
  const { gateway, sandbox } = options;
  if (gateway.kind !== 'simulated' || sandbox.kind !== 'simulated') throw new Error('real_execution_disabled');
  const byItem = new Map<string, ExecutorPort>();
  const byToken = new Map<string, ExecutorPort>();
  const isGateway = (params: unknown) => typeof params === 'object' && params !== null && !Array.isArray(params) && Object.hasOwn(params, 'executor') && (params as Record<string, unknown>).executor === 'gateway';
  const pick = (params: unknown) => (isGateway(params) ? gateway : sandbox);

  return {
    kind: 'simulated',
    validate(subject, params) {
      return pick(params).validate(subject, params);
    },
    async prepare(subject, params) {
      const target = pick(params);
      byItem.set(subject.itemId, target);
      return target.prepare(subject, params);
    },
    async dispatch(input): Promise<DispatchResult> {
      const target = byItem.get(input.itemId);
      if (!target) return { kind: 'not_started', code: 'not_prepared', retryable: false };
      byToken.set(input.token, target);
      return target.dispatch(input);
    },
    async cancel(subject: QueueSubject) {
      const target = byItem.get(subject.itemId);
      return target ? target.cancel(subject) : 'not_supported';
    },
    async discard(subject: QueueSubject) {
      const target = byItem.get(subject.itemId);
      byItem.delete(subject.itemId);
      if (target) await target.discard(subject);
    },
    verifyResult(result: ExecutionResult) {
      const target = byToken.get(result.token);
      if (!target) return false;
      // O sandbox simulado (#021) ainda não emite prova de origem (resíduo registrado da #012):
      // mantém o vínculo por token/tentativa/época. O gateway sempre exige a prova.
      if (typeof target.verifyResult !== 'function') return target === sandbox;
      return target.verifyResult(result);
    },
  };
}
