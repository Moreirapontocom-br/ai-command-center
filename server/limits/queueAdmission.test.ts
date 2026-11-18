// @vitest-environment node
/**
 * Issue #012, PR 2: restauração do controlador (#022) a partir dos registros da fila (Q1/Q2).
 * Nada é inventado: reservas, custo, vagas e aprovações vêm só do que foi gravado; qualquer
 * incoerência impede a criação do controlador.
 */
import { describe, expect, it } from 'vitest';
import type { Project, Task } from '../../shared/contracts.ts';
import type { AdmissionSnapshot } from '../queue/contracts.ts';
import type { AdmissionRestoreRecord } from '../queue/ports.ts';
import { DEFAULT_LIMITS } from './contracts.ts';
import { createLimitsController } from './controller.ts';
import { defaultProviderCatalog } from './providers.ts';
import { createQueueAdmissionPort } from './queueAdmission.ts';
import { limitsFingerprint, parseAdmissionRequest, requestFingerprint } from './validation.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const T1 = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const START = Date.parse('2026-11-18T12:00:00Z');
const projects = { get: (owner: string, id: string) => (owner === 'admin' && id === P1 ? ({ id: P1 } as unknown as Project) : null) };
const tasks = { get: (owner: string, projectId: string, id: string) => (owner === 'admin' && projectId === P1 && id === T1 ? ({ id: T1, status: 'in_progress', assignee: { kind: 'agent', agentId: 'claude-code' } } as Task) : null) };
const providers = defaultProviderCatalog().map((p) => ({ ...p, status: 'available' as const, statusReason: 'verified_for_test' }));
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function record(overrides: Partial<AdmissionRestoreRecord> = {}, cost: AdmissionSnapshot['cost'] = { status: 'none', reservedMinor: 0, confirmedMinor: null }): AdmissionRestoreRecord {
  const itemId = uuid();
  const params = { action: 'tool.use', mode: 'subscription_assisted', durationSeconds: 60, estimatedCostMinor: null, maxTokens: null };
  const fp = requestFingerprint(parseAdmissionRequest({ idempotencyKey: itemId, projectId: P1, taskId: T1, agentId: 'claude-code', ...params }, DEFAULT_LIMITS));
  return {
    itemId,
    ownerId: 'admin',
    projectId: P1,
    taskId: T1,
    agentId: 'claude-code',
    state: 'interrupted',
    params,
    snapshot: {
      admissionId: uuid(),
      admittedAt: new Date(START).toISOString(),
      deadline: new Date(START + 60_000).toISOString(),
      dispatchBy: new Date(START + 60_000).toISOString(),
      approvalIds: [uuid()],
      cost,
      tokensCeiling: null,
      limitsFingerprint: limitsFingerprint(DEFAULT_LIMITS),
      controllerFingerprint: fp,
    },
    intentAt: null,
    capacity: 'held',
    closedAt: null,
    cancellation: null,
    ...overrides,
  };
}
const port = () => createQueueAdmissionPort({ projects, tasks, providers, now: () => START + 5 * 60_000 });

describe('restauração do controlador (Q1/Q2)', () => {
  it('vaga ocupada, aprovação consumida e idempotência restauradas; nada novo cabe na vaga', async () => {
    const p = port();
    const held = record();
    p.restore([held, record({ state: 'succeeded', capacity: 'released', closedAt: new Date(START + 1000).toISOString() })]);
    const c = p.controller()!;
    expect(c.capacityInUse()).toBe(1);
    expect(c.get('admin', P1, held.snapshot!.admissionId)).toMatchObject({ capacity: 'held', state: 'failed', reason: 'restored_uncertain', cancellation: { result: 'not_supported' } });
    expect(await p.admit({ itemId: uuid(), ownerId: 'admin', projectId: P1, taskId: T1, agentId: 'claude-code', key: uuid(), params: held.params })).toEqual({ ok: false, code: 'concurrency_limit' });
    expect(c.auditTrail().some((e) => e.event === 'controller_restored')).toBe(true);
  });

  it('custo não confirmado continua comprometido (conservador); confirmado conta pelo valor confirmado', () => {
    const p = port();
    p.restore([
      record({ state: 'expired', capacity: 'released', closedAt: new Date(START).toISOString() }, { status: 'estimated', reservedMinor: 500, confirmedMinor: null }),
      record({ state: 'succeeded', capacity: 'released', closedAt: new Date(START).toISOString() }, { status: 'confirmed', reservedMinor: 300, confirmedMinor: 120 }),
    ]);
    expect(p.controller()!.budgetSummary()).toMatchObject({ committedMinor: 620, unknownMinor: 500, confirmedMinor: 120 });
  });

  it('admissões incertas (intenção sem reserva) contam no rate limit', async () => {
    const p = port();
    const uncertain = Array.from({ length: DEFAULT_LIMITS.rateLimit.count }, () => ({ ...record(), snapshot: null, capacity: 'none' as const, state: 'expired' as const, intentAt: new Date(START).toISOString() }));
    p.restore(uncertain);
    const r = record();
    expect(await p.admit({ itemId: r.itemId, ownerId: 'admin', projectId: P1, taskId: T1, agentId: 'claude-code', key: r.itemId, params: r.params })).toEqual({ ok: false, code: 'rate_limited' });
  });

  it('incoerência → nenhum controlador (aprovação repetida, impressão digital, vaga em terminal, restauração dupla)', () => {
    const dup = record();
    const again = record();
    again.snapshot!.approvalIds = [...dup.snapshot!.approvalIds];
    expect(() => port().restore([dup, again])).toThrow('restore_invalid');
    const forged = record();
    forged.snapshot!.controllerFingerprint = 'a'.repeat(64);
    expect(() => port().restore([forged])).toThrow('restore_invalid');
    expect(() => port().restore([record({ state: 'succeeded' })])).toThrow('restore_invalid');
    const p = port();
    p.restore([]);
    expect(() => p.restore([])).toThrow('already_restored');
    const notRestored = port();
    expect(notRestored.controller()).toBeNull();
  });

  it('controlador direto: restauração inválida lança e nunca libera nada', () => {
    expect(() => createLimitsController({ projects, tasks, restore: { admissions: [{ admission: { id: 'x' } as never, fingerprint: 'a'.repeat(64) }], uncertain: [] } })).toThrow('restore_invalid');
    expect(() => createLimitsController({ projects, tasks, restore: { admissions: [], uncertain: [{ agentId: 'claude-code', mode: 'free' as never, at: 'x' }] } })).toThrow('restore_invalid');
    // Limites NÃO são restaurados: o controlador restaurado nasce com os padrões.
    const c = createLimitsController({ projects, tasks, restore: { admissions: [], uncertain: [] } });
    expect(c.getLimits()).toEqual(DEFAULT_LIMITS);
  });

  it('antes de restaurar, nada é admitido', async () => {
    const r = record();
    expect(await port().admit({ itemId: r.itemId, ownerId: 'admin', projectId: P1, taskId: T1, agentId: 'claude-code', key: r.itemId, params: r.params })).toEqual({ ok: false, code: 'not_restored' });
  });
});
