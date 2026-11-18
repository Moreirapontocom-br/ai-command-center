import type { DispatchResult, ExecutionResult, ExecutorPort, QueueSubject } from '../queue/ports.ts';
import { REAL_EXECUTION_ENABLED, TERMINAL_STATES, type SandboxRecord } from './contracts.ts';
import type { SandboxProvider } from './provider.ts';
import { SandboxError, type SandboxService } from './service.ts';
import { parseSandboxRequest } from './validation.ts';

/**
 * Adaptador SIMULADO do sandbox (#021) para a fila (Issue #012, PR 2). Fica em `server/sandbox/`
 * (a fila não importa o sandbox) e só depende dos TIPOS de `queue/ports.ts`.
 *
 * - Só aceita provedor `simulated` que NÃO executa código, e só com `REAL_EXECUTION_ENABLED = false`
 *   (lança na criação em qualquer outro caso). Nada é executado: o provedor simulado só registra.
 * - Aprovação própria da execução (`sandbox.execute`, componente `sandbox`) em `prepare` (Q3).
 * - Idempotência por token (G1): o mesmo token devolve o MESMO resultado sem chamar o provedor de
 *   novo; outro token para um item já despachado é recusado sem tocar no provedor.
 * - Classificação conservadora: só é `not_started` o que comprovadamente não tocou o provedor;
 *   qualquer falha depois de tocar o provedor é `uncertain` (sem reintento).
 * - Registros em memória: após reinício o adaptador não conhece execuções anteriores (cancelamento
 *   devolve `not_supported`; a vaga continua ocupada).
 */

export interface SandboxQueueExecutor extends ExecutorPort {
  /** Resultado informado pelo provedor (na simulação, pelos testes) → para `scheduler.onResult`. */
  report(token: string, outcome: 'completed' | 'failed', reason?: string): Promise<ExecutionResult>;
  recordOf(subject: QueueSubject): SandboxRecord | null;
}

const FORBIDDEN_KEYS = ['projectId', 'taskId', 'agentId'];
const codeOf = (error: unknown, fallback: string) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : fallback;
};

export function createSandboxQueueExecutor(options: { sandbox: SandboxService; provider: Pick<SandboxProvider, 'isolation' | 'executesCode'> }): SandboxQueueExecutor {
  if (REAL_EXECUTION_ENABLED || options.provider.isolation !== 'simulated' || options.provider.executesCode) throw new SandboxError('real_execution_disabled');
  const { sandbox } = options;
  /** item → registro do sandbox preparado. */
  const prepared = new Map<string, string>();
  /** token → despacho (resultado memorizado). */
  const dispatches = new Map<string, { subject: QueueSubject; recordId: string; attempt: number; epoch: number; result: Promise<DispatchResult> }>();
  /** item → token já usado. */
  const dispatchedItems = new Map<string, string>();

  const requestOf = (subject: Omit<QueueSubject, 'itemId'>, params: Record<string, unknown>) => ({ ...params, projectId: subject.projectId, taskId: subject.taskId, agentId: subject.agentId });
  const recordOf = (subject: QueueSubject) => {
    const id = prepared.get(subject.itemId);
    return id ? sandbox.get(subject.ownerId, subject.projectId, id) : null;
  };

  async function startRecord(subject: QueueSubject, recordId: string): Promise<DispatchResult> {
    try {
      const record = await sandbox.start(subject.ownerId, subject.projectId, recordId);
      if (record.state === 'running') return { kind: 'started', executionRef: record.id };
      // O provedor falhou depois de ser chamado: pode ter iniciado parcialmente.
      return { kind: 'uncertain', code: 'provider_start_failed' };
    } catch (error) {
      if (error instanceof SandboxError) {
        // Recusas feitas ANTES de qualquer chamada ao provedor (estado inalterado ou sem recursos).
        if (error.code === 'real_execution_disabled' || error.code === 'invalid_transition' || error.code === 'not_found') {
          return { kind: 'not_started', code: error.code, retryable: false };
        }
        if (error.code === 'expired') {
          const record = sandbox.get(subject.ownerId, subject.projectId, recordId);
          // Autorização vencida antes do preparo: nenhum recurso foi criado (`cleanup` intocado).
          if (record && record.cleanup === 'not_needed') return { kind: 'not_started', code: 'authorization_expired', retryable: true };
        }
      }
      return { kind: 'uncertain', code: codeOf(error, 'executor_error') };
    }
  }

  return {
    kind: 'simulated',
    recordOf,

    validate(subject, params) {
      if (FORBIDDEN_KEYS.some((key) => Object.hasOwn(params, key))) return { ok: false, code: 'invalid_params' };
      try {
        parseSandboxRequest(requestOf(subject, params));
        return { ok: true };
      } catch (error) {
        return { ok: false, code: codeOf(error, 'invalid_params') };
      }
    },

    async prepare(subject, params) {
      let record = recordOf(subject);
      if (record && TERMINAL_STATES.includes(record.state)) {
        prepared.delete(subject.itemId);
        record = null;
      }
      try {
        if (!record) {
          record = await sandbox.request(subject.ownerId, requestOf(subject, params));
          prepared.set(subject.itemId, record.id);
        }
        if (record.state === 'requested') record = await sandbox.authorizeWithApproval(subject.ownerId, subject.projectId, record.id);
      } catch (error) {
        return { status: 'refused', code: codeOf(error, 'executor_unavailable') };
      }
      return record.state === 'authorized' ? { status: 'ready' } : { status: 'pending', code: 'sandbox_not_ready' };
    },

    dispatch(input) {
      const known = dispatches.get(input.token);
      if (known) return known.result;
      const subject: QueueSubject = { itemId: input.itemId, ownerId: input.ownerId, projectId: input.projectId, taskId: input.taskId, agentId: input.agentId };
      if (dispatchedItems.has(input.itemId)) return Promise.resolve({ kind: 'not_started', code: 'duplicate_dispatch', retryable: false });
      const recordId = prepared.get(input.itemId);
      if (!recordId) return Promise.resolve({ kind: 'not_started', code: 'not_prepared', retryable: false });
      dispatchedItems.set(input.itemId, input.token);
      // Memorizado ANTES do primeiro `await`: chamadas concorrentes com o mesmo token compartilham.
      const result = startRecord(subject, recordId);
      dispatches.set(input.token, { subject, recordId, attempt: input.attempt, epoch: input.epoch, result });
      return result;
    },

    async cancel(subject) {
      const recordId = prepared.get(subject.itemId);
      if (!recordId || !dispatchedItems.has(subject.itemId)) return 'not_supported';
      const record = sandbox.get(subject.ownerId, subject.projectId, recordId);
      if (!record) return 'not_supported';
      if (TERMINAL_STATES.includes(record.state)) return record.cleanup === 'pending' ? 'failed' : 'cancelled';
      try {
        const after = await sandbox.cancel(subject.ownerId, subject.projectId, recordId);
        return after.cleanup === 'pending' ? 'failed' : 'cancelled';
      } catch {
        return 'failed';
      }
    },

    async discard(subject) {
      if (dispatchedItems.has(subject.itemId)) return;
      const record = recordOf(subject);
      prepared.delete(subject.itemId);
      if (record && !TERMINAL_STATES.includes(record.state)) await sandbox.cancel(subject.ownerId, subject.projectId, record.id).catch(() => undefined);
    },

    async report(token, outcome, reason) {
      const d = dispatches.get(token);
      if (!d) throw new SandboxError('not_found');
      const record = await sandbox.report(d.subject.ownerId, d.subject.projectId, d.recordId, outcome, reason);
      return {
        itemId: d.subject.itemId,
        token,
        attempt: d.attempt,
        epoch: d.epoch,
        outcome: record.state === 'completed' ? 'succeeded' : 'failed',
        reason: record.state === 'completed' ? null : record.reason,
        // Simulado: nada é cobrado nem medido.
        usage: { cost: { kind: 'none' }, tokens: null },
      };
    },
  };
}
