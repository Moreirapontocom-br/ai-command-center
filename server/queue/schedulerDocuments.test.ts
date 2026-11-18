// @vitest-environment node
/**
 * Issue #012, PR 2: regras de documento da extensão `run`, impostas em TODA gravação. Qualquer
 * alteração que libere vaga, crie permissão ou retome trabalho sem comprovação é recusada.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { addItem, queueCode } from '../test/queueFixtures.ts';
import { createSchedulerStack, driveToRunning, itemOf, type SchedulerStack } from '../test/schedulerFixtures.ts';
import type { QueueBody, QueueItem } from './contracts.ts';
import { checkQueueBody } from './documents.ts';

const stacks: SchedulerStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
async function running() {
  const s = await createSchedulerStack();
  stacks.push(s);
  const item = await s.scheduler.submit('admin', s.body());
  await driveToRunning(s, item.id);
  return { s, id: item.id };
}
const mutate = (s: SchedulerStack, id: string, change: (item: QueueItem, body: QueueBody) => void) =>
  queueCode(
    s.store.commit((tx) => {
      const item = tx.body.items.find((i) => i.id === id)!;
      change(item, tx.body);
    }),
  );
const bodyWith = (s: SchedulerStack, change: (item: QueueItem) => void) => {
  const body = structuredClone({ items: [...s.store.items()], pendingBarriers: [...s.store.pendingBarriers()] }) as QueueBody;
  change(body.items[0]);
  return () => checkQueueBody(body);
};

describe('regras de alteração da extensão `run`', () => {
  it('vaga não é liberada sem desfecho comprovado; terminal sem término informado é recusado', async () => {
    const { s, id } = await running();
    expect(await mutate(s, id, (i) => (i.run!.capacity = 'released'))).toBe('change_rejected');
    expect(
      await mutate(s, id, (i) => {
        Object.assign(i, { state: 'succeeded', reason: 'x', stateEpoch: s.store.epoch(), closedAt: i.updatedAt });
        i.run!.capacity = 'released';
      }),
    ).toBe('change_rejected');
    expect(
      await mutate(s, id, (i) => {
        Object.assign(i, { state: 'cancelled', reason: 'x', stateEpoch: s.store.epoch(), closedAt: i.updatedAt });
        i.run!.capacity = 'released';
        i.run!.outcome = { kind: 'not_dispatched', reason: 'x', retryable: false, at: i.updatedAt };
      }),
    ).toBe('change_rejected');
    expect(itemOf(s, id).state).toBe('running');
  });

  it('pedido, reserva e despacho gravados são imutáveis; desfecho não é apagado', async () => {
    const { s, id } = await running();
    expect(await mutate(s, id, (i) => (i.run!.request.admission.durationSeconds = 1))).toBe('change_rejected');
    expect(await mutate(s, id, (i) => (i.run!.admission!.approvalIds = ['11111111-1111-4111-8111-111111111111']))).toBe('change_rejected');
    expect(await mutate(s, id, (i) => (i.run!.admission!.cost = { status: 'confirmed', reservedMinor: 0, confirmedMinor: 0 }))).toBe('change_rejected');
    expect(await mutate(s, id, (i) => (i.run!.dispatch!.token = '22222222-2222-4222-8222-222222222222'))).toBe('change_rejected');
    expect(await mutate(s, id, (i) => (i.run!.retryOf = null))).toBe('resolved'); // já era null
    expect(await mutate(s, id, (i) => (i.run!.chainAttempt = 2))).toBe('change_rejected');
  });

  it('`interrupted` não vai a terminal nem libera vaga sem comprovação; não volta a executar', async () => {
    const { s, id } = await running();
    await s.restart();
    expect(itemOf(s, id).state).toBe('interrupted');
    expect(await mutate(s, id, (i) => Object.assign(i, { state: 'running', reason: 'x', stateEpoch: s.store.epoch() }))).toBe('change_rejected');
    expect(
      await mutate(s, id, (i) => {
        Object.assign(i, { state: 'failed', reason: 'x', stateEpoch: s.store.epoch(), closedAt: i.updatedAt });
        i.run!.capacity = 'released';
        i.run!.outcome = { kind: 'failed_after_start', reason: 'x', retryable: false, at: i.updatedAt };
      }),
    ).toBe('change_rejected');
    expect(await mutate(s, id, (i) => (i.run!.outcome = { kind: 'ended_after_interruption', reason: 'x', retryable: false, at: i.updatedAt }))).toBe('resolved');
    // Desfecho gravado sem liberar a vaga continua válido (só restringe); a vaga segue ocupada.
    expect(itemOf(s, id).run!.capacity).toBe('held');
  });

  it('`queued → failed` só com recusa definitiva; item do PR 1 nunca vai a `failed` nem ganha `run`', async () => {
    const s = await createSchedulerStack();
    stacks.push(s);
    const item = await s.scheduler.submit('admin', s.body());
    const fail = (kind: string) => (i: QueueItem) => {
      Object.assign(i, { state: 'failed', reason: 'x', stateEpoch: s.store.epoch(), closedAt: i.updatedAt });
      i.run!.outcome = { kind: kind as never, reason: 'x', retryable: false, at: i.updatedAt };
    };
    expect(await mutate(s, item.id, fail('not_started'))).toBe('change_rejected');
    expect(await mutate(s, item.id, fail('refused_definitive'))).toBe('resolved');

    const legacy = await addItem(s.store);
    expect(await mutate(s, legacy, (i) => Object.assign(i, { state: 'failed', reason: 'x', stateEpoch: s.store.epoch(), closedAt: i.updatedAt }))).toBe('change_rejected');
    expect(await mutate(s, legacy, (i) => (i.run = structuredClone(itemOf(s, item.id).run)))).toBe('change_rejected');
  });

  it('item novo nasce sem vaga/reserva; sucessor exige antecessor com não início comprovado', async () => {
    const { s, id } = await running();
    const base = structuredClone(itemOf(s, id)) as QueueItem;
    const fresh = (overrides: Partial<QueueItem['run']> = {}): QueueItem => ({
      ...base,
      id: '88888888-8888-4888-8888-888888888888',
      idempotencyKey: `retry:${id}`,
      state: 'queued',
      attempt: 0,
      approvalId: null,
      reason: null,
      closedAt: null,
      stateEpoch: s.store.epoch(),
      createdAt: base.updatedAt,
      updatedAt: base.updatedAt,
      run: { ...base.run!, retryOf: id, chainAttempt: 2, notBefore: null, admissionIntentAt: null, admission: null, dispatch: null, cancellation: null, capacity: 'none', outcome: null, ...overrides },
    });
    // Antecessor `running` (sem comprovação de não início) → recusado.
    // Recusado pela validação do corpo (`change_invalid`) ou pela regra de alteração (`change_rejected`).
    expect(['change_invalid', 'change_rejected']).toContain(await mutate(s, id, (_i, body) => body.items.push(fresh())));
    expect(['change_invalid', 'change_rejected']).toContain(await mutate(s, id, (_i, body) => body.items.push(fresh({ retryOf: null, chainAttempt: 1, capacity: 'held' }))));
    expect(s.store.items()).toHaveLength(1);
    // Item novo legítimo (sem reintento, sem vaga, sem reserva) é aceito.
    expect(await mutate(s, id, (_i, body) => body.items.push({ ...fresh({ retryOf: null, chainAttempt: 1 }), idempotencyKey: 'fresh-item-key' }))).toBe('resolved');
  });
});

describe('formato estrito (Q10)', () => {
  it('extensão parcial, campo extra, vaga ocupada em terminal ou aprovação incoerente → inválido', async () => {
    const { s } = await running();
    expect(() => bodyWith(s, () => undefined)()).not.toThrow();
    expect(bodyWith(s, (i) => delete (i.run as unknown as Record<string, unknown>).outcome)).toThrow();
    expect(bodyWith(s, (i) => ((i.run as unknown as Record<string, unknown>).extra = 1))).toThrow();
    expect(bodyWith(s, (i) => ((i as unknown as Record<string, unknown>).run = undefined))).toThrow();
    expect(bodyWith(s, (i) => Object.assign(i, { state: 'succeeded', closedAt: i.updatedAt }))).toThrow();
    expect(bodyWith(s, (i) => (i.approvalId = '11111111-1111-4111-8111-111111111111'))).toThrow();
    expect(bodyWith(s, (i) => (i.run!.capacity = 'none'))).toThrow();
    expect(bodyWith(s, (i) => (i.run!.outcome = { kind: 'uncertain', reason: 'x', retryable: true, at: i.updatedAt }))).toThrow();
    expect(bodyWith(s, (i) => (i.run!.request.execution = { bad: '\u0000' }))).toThrow();
    expect(bodyWith(s, (i) => (i.run!.expiresAt = new Date(Date.parse(i.createdAt) + 25 * 3600_000).toISOString()))).toThrow();
  });

  it('documentos gravados pelo PR 2 reabrem íntegros; os do PR 1 continuam legíveis', async () => {
    const { s, id } = await running();
    const legacy = await addItem(s.store);
    await s.restart();
    expect(s.store.status()).toEqual({ state: 'available', reason: null });
    expect(itemOf(s, id).run).toBeDefined();
    expect(itemOf(s, legacy).run).toBeUndefined();
  });
});
