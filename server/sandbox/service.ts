import { randomUUID } from 'node:crypto';
import { POLICY_ACTIONS, type ApprovalGrant, type PolicyAction, type PolicyActionInfo, type PolicyEvaluation } from '../../shared/contracts.ts';
import type { Logger } from '../logger.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { evaluatePolicy, type Policy } from '../policy/engine.ts';
import type { ProjectStore } from '../projects/projectStore.ts';
import type { TaskStore } from '../tasks/taskStore.ts';
import {
  REAL_EXECUTION_ENABLED,
  SANDBOX_LIMITS,
  SANDBOX_TRANSITIONS,
  TERMINAL_STATES,
  type SandboxRecord,
  type SandboxSpec,
  type SandboxState,
} from './contracts.ts';
import { SandboxProviderError, type SandboxProvider } from './provider.ts';
import { assertWorkBranch, assertWorkspaceId, parseSandboxRequest, workBranchFor } from './validation.ts';

/**
 * Orquestração do ciclo de vida de sandboxes (Issue #021) — camada preparatória.
 *
 * - Nenhuma rota HTTP usa este serviço: não há API que execute comandos.
 * - Toda solicitação passa pelo motor de políticas da #020 (`sandbox.execute`, sujeito = agente).
 *   No catálogo real a capacidade é `available: false`, então o resultado é UNAVAILABLE e nada é
 *   criado; os testes usam um catálogo simulado para exercitar o fluxo.
 * - Isolamento lógico: cada registro pertence a (dono, projeto, tarefa, agente); consultar ou
 *   operar com outro dono/projeto é indistinguível de inexistente.
 * - Workspace, branch e prazos são DERIVADOS aqui; o chamador não escolhe caminhos nem branch.
 * - Registros em memória (não há execução a retomar); persistência e quotas ficam para #012/#022.
 * - Prazos são verificados em toda operação que avança o ciclo de vida (`authorize`, `start`), sem
 *   depender de `expireOverdue()` ter rodado: o que venceu passa a `expired` e a operação é recusada.
 * - Operações sobre o MESMO registro são serializadas (fila por id): expiração, autorização, início,
 *   resultado e cancelamento nunca se intercalam durante as chamadas assíncronas ao provedor.
 */

export class SandboxError extends Error {
  name = 'SandboxError';
  readonly code: string;
  readonly evaluation: PolicyEvaluation | null;
  constructor(code: string, evaluation: PolicyEvaluation | null = null) {
    super(code);
    this.code = code;
    this.evaluation = evaluation;
  }
}

export interface SandboxServiceOptions {
  provider: SandboxProvider;
  projects: Pick<ProjectStore, 'get'>;
  tasks: Pick<TaskStore, 'get'>;
  policy?: Policy;
  /** Apenas para testes: catálogo em que `sandbox.execute` está disponível. */
  catalog?: Record<PolicyAction, PolicyActionInfo>;
  now?: () => number;
  generateId?: () => string;
  logger?: Logger;
}

export interface SandboxService {
  request(ownerId: string, raw: unknown): Promise<SandboxRecord>;
  authorize(ownerId: string, projectId: string, id: string, approval: ApprovalGrant): Promise<SandboxRecord>;
  start(ownerId: string, projectId: string, id: string): Promise<SandboxRecord>;
  /** Resultado informado pelo provedor (na simulação, pelos testes). */
  report(ownerId: string, projectId: string, id: string, outcome: 'completed' | 'failed', reason?: string): Promise<SandboxRecord>;
  cancel(ownerId: string, projectId: string, id: string): Promise<SandboxRecord>;
  /**
   * Expira registros com prazo vencido (chamado periodicamente por quem hospeda o serviço). É só a
   * varredura: `authorize` e `start` já recusam e expiram o que venceu, mesmo sem esta chamada.
   */
  expireOverdue(): Promise<SandboxRecord[]>;
  get(ownerId: string, projectId: string, id: string): SandboxRecord | null;
  list(ownerId: string, projectId: string): SandboxRecord[];
}

const REASON_TOKEN = /^[a-z0-9_]{1,48}$/;

export function createSandboxService(options: SandboxServiceOptions): SandboxService {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;
  const policy = options.policy ?? DEFAULT_POLICY;
  const catalog = options.catalog ?? POLICY_ACTIONS;
  const records = new Map<string, SandboxRecord>();
  const usedApprovals = new Set<string>();
  /** Fila por registro: a próxima operação só começa quando a anterior termina (com sucesso ou erro). */
  const queues = new Map<string, Promise<void>>();
  const iso = (ms = now()) => new Date(ms).toISOString();
  const log = (event: string, record: SandboxRecord) =>
    options.logger?.log('info', 'Sandbox', { event, requestId: record.id, projectId: record.projectId, state: record.state });

  function find(ownerId: string, projectId: string, id: string): SandboxRecord {
    const record = records.get(id);
    if (!record || record.ownerId !== ownerId || record.projectId !== projectId) throw new SandboxError('not_found');
    return record;
  }

  function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return result;
  }

  const isOverdue = (record: SandboxRecord) => Date.parse(record.deadline) <= now();

  function transition(record: SandboxRecord, to: SandboxState, reason: string | null, deadlineMs?: number) {
    if (!SANDBOX_TRANSITIONS[record.state].includes(to)) throw new SandboxError('invalid_transition');
    const safeReason = reason !== null && REASON_TOKEN.test(reason) ? reason : reason === null ? null : 'provider_error';
    record.history.push({ at: iso(), from: record.state, to, reason: safeReason });
    record.state = to;
    record.reason = safeReason;
    record.updatedAt = iso();
    if (deadlineMs !== undefined) record.deadline = iso(deadlineMs);
    log(`sandbox_${to}`, record);
  }

  /** Descarte: para a execução (se houver) e destrói o workspace; falha vira `cleanup: pending`. */
  async function teardown(record: SandboxRecord, wasRunning: boolean) {
    try {
      if (wasRunning) await options.provider.stop(record.id);
    } catch {
      // segue para o descarte mesmo assim
    }
    try {
      await options.provider.destroy(record.id);
      record.cleanup = 'done';
    } catch {
      record.cleanup = 'pending';
    }
  }

  /**
   * Se o prazo do estado atual venceu, leva o registro a `expired` (transição válida) com o descarte
   * pertinente. Devolve `true` quando expirou. Deve ser chamada dentro de `serialized`.
   */
  async function expireIfOverdue(record: SandboxRecord): Promise<boolean> {
    if (TERMINAL_STATES.includes(record.state) || !isOverdue(record)) return false;
    const wasRunning = record.state === 'running';
    transition(record, 'expired', wasRunning ? 'timeout' : 'not_started_in_time');
    if (wasRunning || record.cleanup === 'pending') await teardown(record, wasRunning);
    return true;
  }

  function evaluate(ownerId: string, spec: SandboxSpec, approval: ApprovalGrant | null) {
    const project = options.projects.get(ownerId, spec.projectId);
    const task = project ? options.tasks.get(ownerId, spec.projectId, spec.taskId) : null;
    const assigned = task?.assignee?.kind === 'agent' && task.assignee.agentId === spec.agentId;
    return evaluatePolicy(
      policy,
      {
        subject: { kind: 'agent', id: spec.agentId },
        action: 'sandbox.execute',
        projectId: spec.projectId,
        resource: { type: 'task', id: spec.taskId },
        target: { sha: spec.git?.baseSha ?? null, ref: spec.git?.workBranch ?? null },
        approval,
      },
      { projectAccessible: project !== null, agentAssigned: assigned, now: now(), usedApprovals },
      catalog,
    );
  }

  return {
    async request(ownerId, raw) {
      const input = parseSandboxRequest(raw);
      const project = options.projects.get(ownerId, input.projectId);
      // Projeto de outro dono: o mesmo "não encontrado" de sempre.
      if (!project) throw new SandboxError('not_found');
      const task = options.tasks.get(ownerId, input.projectId, input.taskId);
      if (!task) throw new SandboxError('not_found');
      if (task.status === 'done' || task.status === 'cancelled') throw new SandboxError('task_not_active');
      if (input.repository !== null && !project.repositories.includes(input.repository)) throw new SandboxError('repository_not_linked');

      const id = generateId();
      const spec: SandboxSpec = {
        requestId: id,
        ownerId,
        projectId: input.projectId,
        taskId: input.taskId,
        agentId: input.agentId,
        workspace: { id: assertWorkspaceId(`ws-${id.replaceAll('-', '')}`), exclusive: true, hostPathAccess: 'none' },
        git:
          input.repository !== null && input.baseSha !== null
            ? { repository: input.repository, baseSha: input.baseSha, workBranch: workBranchFor(input.agentId, input.taskId, id), mainWritable: false }
            : null,
        network: { default: 'deny', allow: [...input.networkAllowlist] },
        credentials: {
          scopes: [...input.credentialScopes],
          ttlSeconds: input.limits.timeoutSeconds,
          productionSecrets: 'denied',
          productionDatabase: 'denied',
        },
        limits: { ...input.limits },
        // Conteúdo externo é dado, não instrução: marcado como não confiável e sem efeito na política.
        inputs: input.inputs.map((i) => ({ ...i, trust: 'untrusted' as const })),
      };
      if (spec.git) assertWorkBranch(spec.git.workBranch);

      const evaluation = evaluate(ownerId, spec, null);
      if (evaluation.decision === 'DENY' || evaluation.decision === 'UNAVAILABLE') {
        throw new SandboxError(evaluation.decision === 'DENY' ? 'policy_denied' : 'capability_unavailable', evaluation);
      }
      const at = now();
      const record: SandboxRecord = {
        id,
        ownerId,
        projectId: spec.projectId,
        taskId: spec.taskId,
        agentId: spec.agentId,
        state: 'requested',
        spec,
        createdAt: iso(at),
        updatedAt: iso(at),
        deadline: iso(at + SANDBOX_LIMITS.approvalWindowSeconds * 1000),
        approvalId: null,
        reason: evaluation.decision === 'REQUIRE_APPROVAL' ? 'awaiting_approval' : null,
        cleanup: 'not_needed',
        history: [{ at: iso(at), from: null, to: 'requested', reason: null }],
      };
      records.set(id, record);
      log('sandbox_requested', record);
      // Política que libere sem aprovação (a padrão nunca libera): autoriza já.
      if (evaluation.decision === 'ALLOW') transition(record, 'authorized', 'allowed_by_rule');
      return structuredClone(record);
    },

    authorize(ownerId, projectId, id, approval) {
      return serialized(id, async () => {
        const record = find(ownerId, projectId, id);
        if (record.state !== 'requested') throw new SandboxError('invalid_transition');
        // Prazo da solicitação vencido: expira antes de avaliar, e a aprovação não é consumida.
        if (await expireIfOverdue(record)) throw new SandboxError('expired');
        const evaluation = evaluate(ownerId, record.spec, approval);
        if (evaluation.decision !== 'ALLOW' || evaluation.approvalId === null) {
          throw new SandboxError(evaluation.decision === 'REQUIRE_APPROVAL' ? 'approval_invalid' : 'policy_denied', evaluation);
        }
        usedApprovals.add(evaluation.approvalId);
        record.approvalId = evaluation.approvalId;
        const deadline = Math.min(Date.parse(approval.expiresAt), now() + SANDBOX_LIMITS.approvalWindowSeconds * 1000);
        transition(record, 'authorized', 'approved', deadline);
        return structuredClone(record);
      });
    },

    start(ownerId, projectId, id) {
      return serialized(id, async () => {
        const record = find(ownerId, projectId, id);
        if (record.state !== 'authorized') throw new SandboxError('invalid_transition');
        // Autorização vencida: expira sem tocar no provedor.
        if (await expireIfOverdue(record)) throw new SandboxError('expired');
        // Execução real desligada: provedor que executa código é recusado sem mudar o estado.
        if (options.provider.executesCode && !REAL_EXECUTION_ENABLED) throw new SandboxError('real_execution_disabled');
        try {
          await options.provider.prepare(record.spec);
          record.cleanup = 'pending';
          // O preparo leva tempo: se a autorização venceu nesse meio-tempo, não inicia; descarta o workspace.
          if (await expireIfOverdue(record)) throw new SandboxError('expired');
          await options.provider.start(record.spec);
        } catch (error) {
          if (error instanceof SandboxError) throw error;
          transition(record, 'failed', error instanceof SandboxProviderError ? error.code : 'provider_error');
          await teardown(record, false);
          return structuredClone(record);
        }
        transition(record, 'running', null, now() + record.spec.limits.timeoutSeconds * 1000);
        return structuredClone(record);
      });
    },

    report(ownerId, projectId, id, outcome, reason) {
      return serialized(id, async () => {
        const record = find(ownerId, projectId, id);
        if (record.state !== 'running') throw new SandboxError('invalid_transition');
        transition(record, outcome, outcome === 'failed' ? (reason ?? 'provider_error') : null);
        await teardown(record, false);
        return structuredClone(record);
      });
    },

    cancel(ownerId, projectId, id) {
      return serialized(id, async () => {
        const record = find(ownerId, projectId, id);
        if (TERMINAL_STATES.includes(record.state)) throw new SandboxError('invalid_transition');
        const wasRunning = record.state === 'running';
        transition(record, 'cancelled', 'cancelled_by_user');
        if (wasRunning || record.cleanup === 'pending') await teardown(record, wasRunning);
        return structuredClone(record);
      });
    },

    async expireOverdue() {
      const expired: SandboxRecord[] = [];
      for (const id of [...records.keys()]) {
        // Reavaliado dentro da fila: uma operação em curso sobre o registro termina antes.
        const result = await serialized(id, async () => {
          const record = records.get(id);
          return record && (await expireIfOverdue(record)) ? structuredClone(record) : null;
        });
        if (result) expired.push(result);
      }
      return expired;
    },

    get(ownerId, projectId, id) {
      const record = records.get(id);
      return record && record.ownerId === ownerId && record.projectId === projectId ? structuredClone(record) : null;
    },

    list(ownerId, projectId) {
      return [...records.values()].filter((r) => r.ownerId === ownerId && r.projectId === projectId).map((r) => structuredClone(r));
    },
  };
}
