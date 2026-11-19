import type { DispatchResult, ExecutionResult, ExecutorPort, QueueSubject } from '../queue/ports.ts';

/**
 * Executor COMPOSTO da fila central (Issue #028, D6): um único `ExecutorPort` para o agendador
 * (#012), que encaminha cada item pelo TIPO declarado nos parâmetros de execução:
 * - `execution.executor === 'gateway'` → executor do Agent Gateway;
 * - qualquer outro formato → executor do sandbox (#021), com os parâmetros intactos.
 *
 * Nenhum agendamento paralelo é criado. Só aceita executores `simulated` (nenhum executor real).
 *
 * Ciclo de vida das referências (R2 da revisão do PR #48):
 * - item → executor: da preparação até o fim útil do item. É liberada NA HORA quando o despacho
 *   comprovadamente não começou (`not_started`), quando o cancelamento é confirmado e no descarte;
 * - token → executor: do despacho iniciado até o fim da RETENÇÃO, para que a verificação de origem
 *   (I8) continue reconhecendo a repetição de um resultado legítimo (liquidação pendente, resultado
 *   tardio). Depois disso o resultado é recusado como não autenticado — nunca aceito;
 * - retenção de 24 h desde o último uso (bem acima do prazo máximo de qualquer execução, 30 min) e
 *   teto de entradas: nada se acumula indefinidamente.
 * Sem rota conhecida (ex.: depois de um reinício) → `not_supported`/`not_started`/não autenticado.
 */
export const ROUTING_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ROUTING_MAX_ENTRIES = 10_000;

export interface RoutingExecutor extends ExecutorPort {
  /** Quantas referências estão retidas (diagnóstico e testes). */
  references(): { items: number; tokens: number };
}

export function createRoutingExecutor(options: { gateway: ExecutorPort; sandbox: ExecutorPort; now?: () => number }): RoutingExecutor {
  const { gateway, sandbox } = options;
  const now = options.now ?? Date.now;
  if (gateway.kind !== 'simulated' || sandbox.kind !== 'simulated') throw new Error('real_execution_disabled');
  const byItem = new Map<string, { target: ExecutorPort; at: number }>();
  const byToken = new Map<string, { target: ExecutorPort; itemId: string; at: number }>();
  const isGateway = (params: unknown) => typeof params === 'object' && params !== null && !Array.isArray(params) && Object.hasOwn(params, 'executor') && (params as Record<string, unknown>).executor === 'gateway';
  const pick = (params: unknown) => (isGateway(params) ? gateway : sandbox);

  /** Reinsere (vai para o fim da ordem) e aplica o teto, descartando as mais antigas. */
  function touch<V>(map: Map<string, V>, key: string, value: V) {
    map.delete(key);
    map.set(key, value);
    while (map.size > ROUTING_MAX_ENTRIES) map.delete(map.keys().next().value as string);
  }
  function prune() {
    const limit = now() - ROUTING_RETENTION_MS;
    for (const [key, entry] of byItem) if (entry.at < limit) byItem.delete(key);
    for (const [key, entry] of byToken) if (entry.at < limit) byToken.delete(key);
  }
  function forgetItem(itemId: string) {
    byItem.delete(itemId);
    for (const [token, entry] of byToken) if (entry.itemId === itemId) byToken.delete(token);
  }

  return {
    kind: 'simulated',
    validate(subject, params) {
      return pick(params).validate(subject, params);
    },
    async prepare(subject, params) {
      prune();
      const target = pick(params);
      touch(byItem, subject.itemId, { target, at: now() });
      return target.prepare(subject, params);
    },
    async dispatch(input): Promise<DispatchResult> {
      prune();
      const entry = byItem.get(input.itemId);
      if (!entry) return { kind: 'not_started', code: 'not_prepared', retryable: false };
      const result = await entry.target.dispatch(input);
      if (result.kind === 'not_started') {
        // Nada começou: não haverá resultado deste token (um reintento é OUTRO item).
        forgetItem(input.itemId);
      } else {
        touch(byItem, input.itemId, { target: entry.target, at: now() });
        touch(byToken, input.token, { target: entry.target, itemId: input.itemId, at: now() });
      }
      return result;
    },
    async cancel(subject: QueueSubject) {
      const entry = byItem.get(subject.itemId);
      if (!entry) return 'not_supported';
      const result = await entry.target.cancel(subject);
      // Parada confirmada: o item terminou; um resultado tardio dele é recusado.
      if (result === 'cancelled') forgetItem(subject.itemId);
      return result;
    },
    async discard(subject: QueueSubject) {
      const entry = byItem.get(subject.itemId);
      forgetItem(subject.itemId);
      if (entry) await entry.target.discard(subject);
    },
    verifyResult(result: ExecutionResult) {
      prune();
      const entry = byToken.get(result.token);
      if (!entry || entry.itemId !== result.itemId) return false;
      // O sandbox simulado (#021) ainda não emite prova de origem (resíduo registrado da #012):
      // mantém o vínculo por token/tentativa/época. O gateway sempre exige a prova.
      if (typeof entry.target.verifyResult !== 'function') return entry.target === sandbox;
      return entry.target.verifyResult(result);
    },
    references() {
      return { items: byItem.size, tokens: byToken.size };
    },
  };
}
