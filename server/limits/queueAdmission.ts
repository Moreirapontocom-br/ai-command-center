import type { AdmissionDraft, AdmissionPort, AdmissionRestoreRecord, ExecutionUsage, LimitsEvidence, QueueSubject } from '../queue/ports.ts';
import { DEFAULT_LIMITS, type Admission, type AdmissionState } from './contracts.ts';
import { createLimitsController, LimitsError, type LimitsController, type LimitsControllerOptions } from './controller.ts';
import { limitsFingerprint, parseAdmissionRequest, requestFingerprint } from './validation.ts';

/**
 * Adaptador do controlador de limites (#022) para a fila (Issue #012, PR 2). Fica em
 * `server/limits/` (a fila não importa o controlador) e só depende dos TIPOS de `queue/ports.ts`.
 *
 * - O controlador só existe depois de `restore()` (Q1): até lá toda admissão é recusada
 *   (`not_restored`). Restaurar duas vezes é recusado.
 * - Os limites NÃO têm persistência comprovada nesta fase: o controlador nasce com `DEFAULT_LIMITS`
 *   e a impressão digital deles é conferida com a gravada em cada reserva (Q2).
 * - A admissão usa a aprovação PRÓPRIA do controlador (`admitWithApproval`, componente `limits`),
 *   distinta da aprovação `sandbox.execute` do executor (Q3).
 */

const PROBE_UUID = '00000000-0000-4000-8000-000000000000';

const STATE_OF: Readonly<Record<string, AdmissionState>> = {
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  revoked: 'cancelled',
  expired: 'expired',
  interrupted: 'failed',
};

export interface QueueAdmissionAdapter extends AdmissionPort {
  /** Controlador restaurado (inspeção/testes); `null` antes de `restore()`. */
  controller(): LimitsController | null;
}

export interface QueueAdmissionOptions extends Omit<LimitsControllerOptions, 'restore'> {
  /**
   * Evidência durável das alterações de limites (R3), lida dos registros EXISTENTES do núcleo de
   * aprovações (#011: aprovações `limits.change` consumidas e suas tentativas) e injetada por quem
   * monta o servidor. Ausente → `unknown` → o agendador não restaura (bloqueado).
   */
  limitsHistory?: () => LimitsEvidence;
}

export function createQueueAdmissionPort(input: QueueAdmissionOptions): QueueAdmissionAdapter {
  const { limitsHistory, ...options } = input;
  const now = options.now ?? Date.now;
  let controller: LimitsController | null = null;

  const inputOf = (key: string, subject: Omit<QueueSubject, 'itemId' | 'ownerId'>, params: object) => ({
    idempotencyKey: key,
    projectId: subject.projectId,
    taskId: subject.taskId,
    agentId: subject.agentId,
    ...params,
  });
  const currentFingerprint = () => limitsFingerprint(controller ? controller.getLimits() : DEFAULT_LIMITS);
  const costOf = (a: Admission) => ({ status: a.cost.status, reservedMinor: a.cost.reservedMinor, confirmedMinor: a.cost.confirmedMinor });
  const draftOf = (a: Admission, fingerprint: string): AdmissionDraft => ({
    admissionId: a.id,
    admittedAt: a.admittedAt,
    deadline: a.deadline,
    approvalIds: [...a.approvalIds],
    cost: costOf(a),
    tokensCeiling: a.tokens?.ceiling ?? null,
    limitsFingerprint: currentFingerprint(),
    controllerFingerprint: fingerprint,
  });

  function restoredAdmission(r: AdmissionRestoreRecord): { admission: Admission; fingerprint: string } {
    const snapshot = r.snapshot!;
    const input = parseAdmissionRequest(inputOf(r.itemId, r, r.params), DEFAULT_LIMITS);
    const fingerprint = requestFingerprint(input);
    if (fingerprint !== snapshot.controllerFingerprint) throw new LimitsError('restore_invalid');
    const held = r.capacity === 'held';
    // Depois do reinício só um item `interrupted` pode ocupar vaga; o resto já foi encerrado.
    if (held && r.state !== 'interrupted') throw new LimitsError('restore_invalid');
    if (!held && r.capacity !== 'released') throw new LimitsError('restore_invalid');
    const state = STATE_OF[r.state];
    if (!state) throw new LimitsError('restore_invalid');
    const at = new Date(now()).toISOString();
    return {
      fingerprint,
      admission: {
        id: snapshot.admissionId,
        idempotencyKey: r.itemId,
        ownerId: r.ownerId,
        projectId: r.projectId,
        taskId: r.taskId,
        agentId: input.agentId,
        action: input.action,
        mode: input.mode,
        state,
        reason: held ? 'restored_uncertain' : 'restored',
        admittedAt: snapshot.admittedAt,
        deadline: snapshot.deadline,
        finishedAt: r.closedAt ?? at,
        // Custo não confirmado continua contando pela reserva (conservador, G2).
        cost: {
          status: snapshot.cost.status === 'confirmed' ? 'confirmed' : snapshot.cost.status === 'none' ? 'none' : 'unknown',
          reservedMinor: snapshot.cost.reservedMinor,
          confirmedMinor: snapshot.cost.confirmedMinor,
          currency: 'BRL',
        },
        tokens: input.mode === 'metered_api' ? { ceiling: snapshot.tokensCeiling ?? 0, reported: null } : null,
        // Vaga ocupada sem parada confirmada: o pedido de cancelamento não teve confirmação.
        cancellation: r.cancellation && r.cancellation.result !== 'pending' ? { ...r.cancellation } : held ? { requestedAt: r.cancellation?.requestedAt ?? at, result: 'not_supported' } : null,
        capacity: held ? 'held' : 'released',
        approvalIds: [...snapshot.approvalIds],
      },
    };
  }

  const existingFor = (c: LimitsController, ownerId: string, projectId: string, key: string) => c.list(ownerId, projectId).find((a) => a.idempotencyKey === key) ?? null;
  const knownCode = (error: unknown) => {
    const code = (error as { code?: unknown })?.code;
    return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
  };

  return {
    controller: () => controller,
    limitsFingerprint: currentFingerprint,
    limitsEvidence(): LimitsEvidence {
      if (!limitsHistory) return { kind: 'unknown' };
      const evidence = limitsHistory();
      if (evidence?.kind === 'never_changed') return { kind: 'never_changed' };
      if (evidence?.kind === 'last_applied' && typeof evidence.fingerprint === 'string') return { kind: 'last_applied', fingerprint: evidence.fingerprint };
      return { kind: 'unknown' };
    },

    validate(params) {
      try {
        parseAdmissionRequest(inputOf('validate-probe', { projectId: PROBE_UUID, taskId: PROBE_UUID, agentId: 'claude-code' }, params), controller ? controller.getLimits() : DEFAULT_LIMITS);
        return { ok: true };
      } catch (error) {
        return { ok: false, code: knownCode(error) ?? 'invalid_params' };
      }
    },

    restore(records) {
      if (controller) throw new LimitsError('already_restored');
      const admissions: Array<{ admission: Admission; fingerprint: string }> = [];
      const uncertain: Array<{ agentId: Admission['agentId']; mode: Admission['mode']; at: string }> = [];
      for (const r of records) {
        if (r.snapshot) {
          admissions.push(restoredAdmission(r));
        } else if (r.intentAt !== null) {
          const input = parseAdmissionRequest(inputOf(r.itemId, r, r.params), DEFAULT_LIMITS);
          uncertain.push({ agentId: input.agentId, mode: input.mode, at: r.intentAt });
        }
      }
      controller = createLimitsController({ ...options, restore: { admissions, uncertain } });
    },

    async admit(input) {
      const c = controller;
      if (!c) return { ok: false, code: 'not_restored' };
      const raw = inputOf(input.key, input, input.params);
      let fingerprint: string;
      try {
        fingerprint = requestFingerprint(parseAdmissionRequest(raw, c.getLimits()));
      } catch (error) {
        return { ok: false, code: knownCode(error) ?? 'invalid_params' };
      }
      try {
        const admission = await c.admitWithApproval(input.ownerId, raw);
        return { ok: true, draft: draftOf(admission, fingerprint) };
      } catch (error) {
        // Recusa SÓ quando nenhuma admissão existe para a chave; senão o resultado é a admissão
        // ativa (idempotente) ou, se já encerrada, incerto (lança → o agendador bloqueia).
        const existing = existingFor(c, input.ownerId, input.projectId, input.key);
        if (existing && existing.state === 'admitted' && existing.capacity === 'held') return { ok: true, draft: draftOf(existing, fingerprint) };
        if (existing) throw error;
        const code = knownCode(error);
        if (code === null) throw error;
        return { ok: false, code };
      }
    },

    async releaseNotDispatched(subject, admissionId) {
      const c = controller;
      if (!c) return;
      const a = c.get(subject.ownerId, subject.projectId, admissionId);
      if (!a || a.capacity !== 'held') return;
      if (a.state === 'admitted') await c.cancel(subject.ownerId, subject.projectId, admissionId).catch(() => undefined);
      const after = c.get(subject.ownerId, subject.projectId, admissionId);
      // A fila comprova que nada foi despachado: o host confirma que não há operação ativa.
      if (after && after.capacity === 'held' && after.state !== 'admitted' && after.cancellation?.result !== 'pending') {
        c.confirmStopped({ kind: 'system', id: 'acc' }, subject.ownerId, subject.projectId, admissionId);
      }
    },

    settle(subject, admissionId, outcome, usage: ExecutionUsage) {
      const c = controller;
      if (!c) throw new LimitsError('not_restored');
      const a = c.get(subject.ownerId, subject.projectId, admissionId);
      if (!a) throw new LimitsError('not_found');
      if (a.state === 'admitted') {
        try {
          return costOf(c.complete(subject.ownerId, subject.projectId, admissionId, outcome === 'completed' ? 'completed' : 'failed', usage));
        } catch (error) {
          if (!(error instanceof LimitsError) || error.code !== 'expired') throw error;
        }
      }
      // Já encerrada logicamente (expirada, cancelada, restaurada): o executor comprovou o término.
      return costOf(c.confirmStopped({ kind: 'system', id: 'acc' }, subject.ownerId, subject.projectId, admissionId));
    },

    async engageKillSwitch(scope, reason) {
      if (!controller) return;
      await controller.engageKillSwitch({ kind: 'system', id: 'acc' }, scope, reason);
    },

    killSwitchEngaged(projectId) {
      if (!controller) return false;
      const status = controller.killSwitchStatus(projectId ?? undefined);
      return projectId === null ? status.global.engaged : status.global.engaged || (status.project?.engaged ?? false);
    },
  };
}
