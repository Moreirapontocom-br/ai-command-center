import { QUEUE_SYSTEM_ACTOR, QueueError, scopeKey, type BarrierScope } from './contracts.ts';
import { REASON } from './documents.ts';
import { parseBarrierScope, type QueueStore } from './store.ts';

/**
 * Portão de barreira da fila (Issue #012, PR 1 — D3).
 *
 * A barreira durável do núcleo de aprovações (#011) é a ÚNICA autoridade que pode LIBERAR
 * execução. Este portão nunca libera nada por conta própria: ele só decide se a fila está
 * BLOQUEADA, e qualquer fonte basta para bloquear:
 * - autoridade ausente, degradada ou indisponível;
 * - barreira durável (global ou do projeto) ou barreira volátil na autoridade;
 * - kill switch do controlador (#022), quando informado;
 * - armazenamento da fila degradado ou indisponível;
 * - pedido de barreira da própria fila ainda não confirmado como durável na autoridade;
 * - qualquer erro ou resposta inesperada numa consulta (fail-closed).
 *
 * Acionamento (`engage`): 1) grava o pedido na fila (durável); 2) aguarda a autoridade gravar a
 * barreira; 3) relê a autoridade e só então remove o pedido. Falha em qualquer passo mantém a fila
 * bloqueada — e, como o pedido continua gravado, ele é reenviado em `reconcile` (inicialização).
 *
 * Não há despacho neste PR: o portão é consultado por quem admitir/despachar no PR 2, na
 * admissão, a cada ciclo, imediatamente antes do despacho e no tratamento de resultados.
 */

/** Interface ESTREITA da autoridade (adaptada do serviço de aprovações no `index.ts`). */
export interface BarrierAuthority {
  status(): { state: 'available' | 'degraded' | 'unavailable'; reason: string | null };
  barriers(): { durable: { global: unknown; projects: Record<string, unknown> }; volatile: readonly string[] };
  engage(input: { scope: BarrierScope; actor: { kind: 'system'; id: string }; reason: string }): Promise<void>;
}

export type GateDecision = { open: true } | { open: false; reason: string };

export interface EngageResult {
  /** A autoridade confirmou a barreira durável no escopo. */
  durable: boolean;
  /** O pedido foi (ou já estava) gravado na fila. */
  recorded: boolean;
}

export interface BarrierGate {
  /** Decisão no instante da consulta. Bloqueado em qualquer dúvida. */
  check(projectId: string | null): GateDecision;
  /** Lança `QueueError('execution_blocked')` se bloqueado. */
  assertOpen(projectId: string | null): void;
  engage(scope: BarrierScope, reason: string): Promise<EngageResult>;
  /** Inicialização: reenvia pedidos pendentes; integridade da fila em dúvida → barreira global. */
  reconcile(): Promise<{ confirmed: number; failed: number }>;
}

/** Motivos de indisponibilidade da fila que indicam integridade em dúvida (perda/adulteração). */
const INTEGRITY_REASONS = new Set([
  'store_missing',
  'install_marker_missing',
  'anchor_missing',
  'ledger_missing',
  'history_missing',
  'document_invalid',
  'key_mismatch',
  'mac_invalid',
  'lineage_mismatch',
  'ledger_rollback',
  'ledger_anchor_mismatch',
  'history_rollback',
  'history_anchor_mismatch',
  'epoch_rollback',
  'history_ahead_of_ledger',
  'file_unreadable',
  'file_is_link',
  'file_not_regular',
  'file_has_hard_links',
  'recovery_failed',
  'recovery_restore_failed',
]);

export function createBarrierGate(options: {
  authority: BarrierAuthority | null;
  store: QueueStore | null;
  /** Kill switch do controlador (#022), quando houver instância. Lançar = acionado. */
  controllerKillSwitch?: (projectId: string | null) => boolean;
}): BarrierGate {
  const { authority, store } = options;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <R>(task: () => Promise<R>): Promise<R> => {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  };

  function decide(projectId: string | null): GateDecision {
    if (!authority) return { open: false, reason: 'authority_missing' };
    if (!store) return { open: false, reason: 'queue_store_missing' };
    const queueStatus = store.status();
    if (queueStatus.state !== 'available') return { open: false, reason: `queue_store_${queueStatus.state}` };
    const pending = store.pendingBarriers();
    if (pending.some((b) => b.scope.kind === 'global' || (projectId !== null && b.scope.projectId === projectId))) return { open: false, reason: 'queue_barrier_pending' };
    const authStatus = authority.status();
    if (authStatus?.state !== 'available') return { open: false, reason: `authority_${authStatus?.state ?? 'unknown'}` };
    const barriers = authority.barriers();
    if (!barriers || typeof barriers !== 'object' || !barriers.durable || typeof barriers.durable.projects !== 'object' || barriers.durable.projects === null || !Array.isArray(barriers.volatile)) {
      return { open: false, reason: 'authority_unexpected' };
    }
    if (barriers.durable.global !== null) return { open: false, reason: 'global_barrier' };
    if (barriers.volatile.includes('global')) return { open: false, reason: 'volatile_barrier' };
    if (projectId !== null) {
      if (Object.hasOwn(barriers.durable.projects, projectId) && barriers.durable.projects[projectId] != null) return { open: false, reason: 'project_barrier' };
      if (barriers.volatile.includes(`project:${projectId}`)) return { open: false, reason: 'volatile_barrier' };
    }
    if (options.controllerKillSwitch && (options.controllerKillSwitch(null) || (projectId !== null && options.controllerKillSwitch(projectId)))) return { open: false, reason: 'controller_kill_switch' };
    return { open: true };
  }

  const check = (projectId: string | null): GateDecision => {
    try {
      return decide(projectId);
    } catch {
      return { open: false, reason: 'query_failed' };
    }
  };

  /** A autoridade confirma a barreira DURÁVEL no escopo? (qualquer erro → não) */
  function confirmed(scope: BarrierScope): boolean {
    try {
      if (!authority || authority.status().state !== 'available') return false;
      const durable = authority.barriers().durable;
      return scope.kind === 'global' ? durable.global != null : durable.projects?.[scope.projectId] != null;
    } catch {
      return false;
    }
  }

  async function engageNow(scope: BarrierScope, reason: string): Promise<EngageResult> {
    let recorded = false;
    if (store && store.status().state === 'available') {
      try {
        await store.recordBarrierRequest(scope, reason);
        recorded = true;
      } catch {
        recorded = false; // A fila fica degradada → bloqueada; a autoridade ainda é acionada.
      }
    }
    if (!authority) return { durable: false, recorded };
    try {
      await authority.engage({ scope, actor: QUEUE_SYSTEM_ACTOR, reason });
    } catch {
      return { durable: false, recorded };
    }
    if (!confirmed(scope)) return { durable: false, recorded };
    if (recorded) {
      try {
        await store!.clearBarrierRequest(scope);
      } catch {
        // Pedido continua gravado (ou a fila degradou): segue bloqueada; nada é liberado.
      }
    }
    return { durable: true, recorded };
  }

  return {
    check,
    assertOpen(projectId) {
      const decision = check(projectId);
      if (!decision.open) throw new QueueError('execution_blocked');
    },
    engage(rawScope, reason) {
      let scope: BarrierScope;
      try {
        scope = parseBarrierScope(rawScope);
      } catch (error) {
        return Promise.reject(error);
      }
      if (typeof reason !== 'string' || !REASON.test(reason)) return Promise.reject(new QueueError('invalid_reason'));
      return serial(() => engageNow(scope, reason));
    },
    reconcile() {
      return serial(async () => {
        let ok = 0;
        let failed = 0;
        if (!store) return { confirmed: 0, failed: 0 };
        const status = store.status();
        if (status.state === 'unavailable' && status.reason !== null && INTEGRITY_REASONS.has(status.reason)) {
          // Fila sem integridade comprovada: não há onde gravar o pedido; aciona a autoridade.
          const result = await engageNow({ kind: 'global' }, 'queue_integrity');
          return result.durable ? { confirmed: 1, failed: 0 } : { confirmed: 0, failed: 1 };
        }
        if (status.state !== 'available') return { confirmed: 0, failed: 0 };
        const seen = new Set<string>();
        for (const pending of [...store.pendingBarriers()]) {
          const key = scopeKey(pending.scope);
          if (seen.has(key)) continue;
          seen.add(key);
          const result = await engageNow(pending.scope, pending.reason);
          if (result.durable) ok += 1;
          else failed += 1;
        }
        return { confirmed: ok, failed };
      });
    },
  };
}
