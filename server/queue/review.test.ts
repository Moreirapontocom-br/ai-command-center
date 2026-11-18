// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addItem, APPROVAL, createQueueHarness, moveTo, newItem, PROJECT, PROJECT_B, queueCode, START, transition, type QueueHarness } from '../test/queueFixtures.ts';
import type { BarrierAuthority, QueueBody, QueueItem } from './contracts.ts';
import { checkQueueChange } from './documents.ts';
import type { QueueStore } from './store.ts';

/**
 * Correções da revisão independente do PR #45:
 * - R1: leituras nunca expõem o estado interno mutável;
 * - R2: pedidos de barreira pendentes só saem com confirmação da autoridade durável;
 * - R3: toda alteração de item existente é controlada campo a campo.
 */
const harnesses: QueueHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});
async function setup() {
  const h = await createQueueHarness('acc-review-');
  harnesses.push(h);
  return h;
}
const snapshotFiles = async (h: QueueHarness) => {
  const read = async (dir: string) => Promise.all((await readdir(dir)).filter((n) => n.endsWith('.json')).sort().map(async (n) => [n, await readFile(join(dir, n), 'utf8')] as const));
  return JSON.stringify([await read(h.queueDir), await read(h.anchorDir)]);
};
const attempt = (fn: () => void) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return (error as Error).name;
  }
};

function authorityStub(confirms: { global: boolean; projects: string[] }): BarrierAuthority {
  return {
    status: () => ({ state: 'available', reason: null }),
    barriers: () => ({
      durable: { global: confirms.global ? { reason: 'x' } : null, projects: Object.fromEntries(confirms.projects.map((p) => [p, { reason: 'x' }])) },
      volatile: [],
    }),
    engage: async () => undefined,
  };
}

describe('R1 — leituras imutáveis em tempo de execução', () => {
  it('itens, pedidos de barreira e histórico devolvidos estão congelados; o estado interno não muda', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const id = await addItem(store);
    const before = JSON.stringify([store.items(), store.pendingBarriers(), store.history()]);
    const files = await snapshotFiles(h);

    const items = store.items() as QueueItem[];
    expect(attempt(() => items.push(newItem()))).toBe('TypeError');
    expect(attempt(() => items.splice(0, 1))).toBe('TypeError');
    expect(attempt(() => ((items[0] as { state: string }).state = 'running'))).toBe('TypeError');
    expect(attempt(() => ((items[0] as { approvalId: string }).approvalId = APPROVAL))).toBe('TypeError');
    const pending = store.pendingBarriers() as QueueBody['pendingBarriers'];
    expect(attempt(() => void pending.splice(0, 1))).toBe('TypeError');
    expect(attempt(() => ((pending[0].scope as { kind: string }).kind = 'project'))).toBe('TypeError');
    expect(attempt(() => ((pending[0] as { reason: string }).reason = 'x'))).toBe('TypeError');
    const history = store.history() as unknown as Array<{ data: { event: string }; hash: string }>;
    expect(attempt(() => (history[0].data.event = 'queue.item_recorded'))).toBe('TypeError');
    expect(attempt(() => (history[0].hash = '0'.repeat(64)))).toBe('TypeError');
    expect(attempt(() => void history.pop())).toBe('TypeError');

    // Nada mudou em memória nem no disco (nenhuma gravação sem commit).
    expect(JSON.stringify([store.items(), store.pendingBarriers(), store.history()])).toBe(before);
    expect(await snapshotFiles(h)).toBe(files);
    expect(store.items()[0].id).toBe(id);
    // E o estado segue gravável e íntegro (MAC/encadeamento) após reabrir.
    await moveTo(store, id, ['admitted']);
    await store.close();
    const again = await h.open();
    expect(again.status().state).toBe('available');
    expect(again.items()[0]).toMatchObject({ state: 'expired', approvalId: APPROVAL }); // admitted expira no reinício (U7)
  });

  it('commit trabalha sobre cópias: mutação seguida de erro não vaza para o estado nem para o disco', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    await addItem(store);
    const before = JSON.stringify(store.items());
    const files = await snapshotFiles(h);
    let leaked: QueueBody | null = null;
    expect(
      await queueCode(
        store.commit((tx) => {
          tx.body.items[0].priority = 'critical';
          tx.body.pendingBarriers.length = 0;
          leaked = tx.body;
          throw new Error('regra de negócio');
        }),
      ),
    ).toBe('unexpected:regra de negócio');
    expect(JSON.stringify(store.items())).toBe(before);
    expect(store.pendingBarriers()).toHaveLength(1);
    // O rascunho que "vazou" do commit não é o estado interno.
    leaked!.items.push(newItem());
    expect(store.items()).toHaveLength(1);
    expect(await snapshotFiles(h)).toBe(files);
    // O resultado devolvido por commit também não é o estado interno.
    const returned = await store.commit((tx) => tx.body.items);
    returned.push(newItem());
    expect(store.items()).toHaveLength(1);
  });
});

describe('R2 — pedidos de barreira pendentes', () => {
  it('commit público não remove, não altera e não substitui pedidos (mesmo após reabrir)', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent', authority: authorityStub({ global: true, projects: [] }) });
    expect(store.pendingBarriers()).toHaveLength(1);
    for (const change of [
      (b: QueueBody) => void b.pendingBarriers.splice(0, 1),
      (b: QueueBody) => void (b.pendingBarriers.length = 0),
      (b: QueueBody) => void (b.pendingBarriers[0].reason = 'outro_motivo'),
      (b: QueueBody) => void (b.pendingBarriers[0].epoch = 99),
      (b: QueueBody) => void (b.pendingBarriers[0] = { scope: { kind: 'project', projectId: PROJECT }, reason: 'troca', requestedAt: new Date(START).toISOString(), epoch: 1 }),
    ]) {
      expect(await queueCode(store.commit((tx) => change(tx.body)))).toBe('change_rejected');
    }
    expect(store.status()).toEqual({ state: 'available', reason: null });
    expect(store.pendingBarriers()).toMatchObject([{ scope: { kind: 'global' }, reason: 'queue_initial_install' }]);
    await store.close();
    const again = await h.open();
    expect(again.pendingBarriers()).toHaveLength(1);
  });

  it('acrescentar pedido pelo commit é permitido (só restringe), com a época da gravação', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const add = (epoch: number) =>
      store.commit((tx) => void tx.body.pendingBarriers.push({ scope: { kind: 'project', projectId: PROJECT_B }, reason: 'extra_stop', requestedAt: new Date(START).toISOString(), epoch }));
    expect(await queueCode(add(7))).toBe('change_rejected');
    expect(await queueCode(add(store.epoch()))).toBe('resolved');
    expect(store.pendingBarriers()).toHaveLength(2);
  });

  it('clearBarrierRequest exige confirmação durável da autoridade injetada, no escopo exato', async () => {
    // Sem autoridade: nunca remove.
    const h1 = await setup();
    const none = await h1.open({ initialize: 'if_absent' });
    expect(await queueCode(none.clearBarrierRequest({ kind: 'global' }))).toBe('barrier_not_confirmed');
    expect(none.pendingBarriers()).toHaveLength(1);

    // Autoridade que NÃO confirma (sem barreira global durável, ou indisponível): não remove.
    const h2 = await setup();
    const unconfirmed = await h2.open({ initialize: 'if_absent', authority: authorityStub({ global: false, projects: [PROJECT] }) });
    expect(await queueCode(unconfirmed.clearBarrierRequest({ kind: 'global' }))).toBe('barrier_not_confirmed');
    expect(unconfirmed.pendingBarriers()).toHaveLength(1);
    const h3 = await setup();
    const down = await h3.open({ initialize: 'if_absent', authority: { ...authorityStub({ global: true, projects: [] }), status: () => ({ state: 'degraded', reason: 'write_failed' }) } });
    expect(await queueCode(down.clearBarrierRequest({ kind: 'global' }))).toBe('barrier_not_confirmed');
    const h4 = await setup();
    const throwing = await h4.open({ initialize: 'if_absent', authority: { ...authorityStub({ global: true, projects: [] }), barriers: () => { throw new Error('x'); } } });
    expect(await queueCode(throwing.clearBarrierRequest({ kind: 'global' }))).toBe('barrier_not_confirmed');

    // Barreira de projeto confirmada NÃO remove o pedido global; e vice-versa.
    const h5 = await setup();
    const projectOnly = await h5.open({ initialize: 'if_absent', authority: authorityStub({ global: false, projects: [PROJECT] }) });
    await projectOnly.recordBarrierRequest({ kind: 'project', projectId: PROJECT_B }, 'other_stop');
    expect(await queueCode(projectOnly.clearBarrierRequest({ kind: 'project', projectId: PROJECT_B }))).toBe('barrier_not_confirmed');
    await projectOnly.recordBarrierRequest({ kind: 'project', projectId: PROJECT }, 'this_stop');
    expect(await queueCode(projectOnly.clearBarrierRequest({ kind: 'project', projectId: PROJECT }))).toBe('resolved');
    expect(projectOnly.pendingBarriers().map((b) => b.reason).sort()).toEqual(['other_stop', 'queue_initial_install']);

    // Confirmação legítima: remove só aquele pedido e registra no histórico.
    const h6 = await setup();
    const ok = await h6.open({ initialize: 'if_absent', authority: authorityStub({ global: true, projects: [] }) });
    expect(await queueCode(ok.clearBarrierRequest({ kind: 'global' }))).toBe('resolved');
    expect(ok.pendingBarriers()).toEqual([]);
    expect(ok.history().at(-1)!.data).toMatchObject({ event: 'queue.barrier_confirmed', reason: 'queue_initial_install' });
    // Pedido inexistente: nada a fazer, nada gravado.
    expect(await queueCode(ok.clearBarrierRequest({ kind: 'global' }))).toBe('resolved');
    for (const s of [none, unconfirmed, down, throwing, projectOnly]) expect(s.status().state).toBe('available');
  });

  it('a permissão de remoção vale para UM escopo exato (regra pura)', () => {
    const at = new Date(START).toISOString();
    const g = { scope: { kind: 'global' as const }, reason: 'a', requestedAt: at, epoch: 1 };
    const p = { scope: { kind: 'project' as const, projectId: PROJECT }, reason: 'b', requestedAt: at, epoch: 1 };
    const before: QueueBody = { items: [], pendingBarriers: [g, p] };
    const run = (after: QueueBody, allow: unknown) => attempt(() => checkQueueChange(before, after, { epoch: 1, allow }));
    expect(run({ items: [], pendingBarriers: [p] }, { kind: 'clear_barrier', scopeKey: 'global' })).toBe('ok');
    expect(run({ items: [], pendingBarriers: [p] }, null)).toBe('QueueDocumentError');
    expect(run({ items: [], pendingBarriers: [g] }, { kind: 'clear_barrier', scopeKey: 'global' })).toBe('QueueDocumentError');
    expect(run({ items: [], pendingBarriers: [] }, { kind: 'clear_barrier', scopeKey: 'global' })).toBe('QueueDocumentError');
    expect(run({ items: [], pendingBarriers: [p] }, { kind: 'other', scopeKey: 'global' })).toBe('QueueDocumentError');
  });
});

describe('R3 — alterações de itens existentes controladas campo a campo', () => {
  async function storeWith(state: 'queued' | 'admitted' | 'running' | 'interrupted') {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const id = await addItem(store);
    const path = { queued: [], admitted: ['admitted'], running: ['admitted', 'dispatching', 'running'], interrupted: ['admitted', 'dispatching', 'interrupted'] } as const;
    await moveTo(store, id, [...path[state]]);
    return { h, store, id };
  }
  const edit = (store: QueueStore, id: string, fn: (item: QueueItem, epoch: number) => void) =>
    queueCode(store.commit((tx) => fn(tx.body.items.find((i) => i.id === id)!, tx.epoch)));
  const later = (iso: string, ms = 1000) => new Date(Date.parse(iso) + ms).toISOString();

  it('prioridade: só enquanto `queued` e sem transição', async () => {
    const { store, id } = await storeWith('queued');
    expect(await edit(store, id, (i) => (i.priority = 'high'))).toBe('resolved');
    expect(store.items()[0].priority).toBe('high');
    expect(await edit(store, id, (i, epoch) => Object.assign(i, { priority: 'low', state: 'admitted', approvalId: APPROVAL, reason: 'x', stateEpoch: epoch }))).toBe('change_rejected');
    const admitted = await storeWith('admitted');
    expect(await edit(admitted.store, admitted.id, (i) => (i.priority = 'critical'))).toBe('change_rejected');
    const running = await storeWith('running');
    expect(await edit(running.store, running.id, (i) => (i.priority = 'low'))).toBe('change_rejected');
  });

  it('motivo, época, aprovação, encerramento e tentativa não mudam sem transição', async () => {
    for (const state of ['queued', 'admitted', 'running', 'interrupted'] as const) {
      const { store, id } = await storeWith(state);
      expect(await edit(store, id, (i) => (i.reason = 'editado'))).toBe('change_rejected');
      expect(await edit(store, id, (i) => (i.stateEpoch += 1))).toBe('change_rejected');
      expect(await edit(store, id, (i) => (i.approvalId = '55555555-5555-4555-8555-555555555555'))).toBe('change_rejected');
      expect(await edit(store, id, (i) => (i.attempt += 1))).toBe('change_rejected');
      expect(await edit(store, id, (i) => (i.closedAt = i.updatedAt))).toBe('change_rejected');
      expect(store.status().state).toBe('available');
    }
  });

  it('datas: updatedAt nunca regride; createdAt é identidade', async () => {
    const { store, id } = await storeWith('admitted');
    const item = store.items()[0];
    expect(await edit(store, id, (i) => (i.updatedAt = new Date(Date.parse(item.updatedAt) - 1).toISOString()))).toBe('change_rejected');
    expect(await edit(store, id, (i) => (i.createdAt = later(item.createdAt)))).toBe('change_rejected');
    // Avançar o relógio do registro sem mudar mais nada é inofensivo e permitido.
    expect(await edit(store, id, (i) => (i.updatedAt = later(item.updatedAt)))).toBe('resolved');
  });

  it('transição: época da gravação, aprovação só ao entrar em `admitted`, encerramento coerente', async () => {
    const q = await storeWith('queued');
    // Aprovação vinculada fora da admissão (ex.: cancelamento) → recusada.
    expect(await edit(q.store, q.id, (i, epoch) => Object.assign(i, { state: 'cancelled', reason: 'x', stateEpoch: epoch, approvalId: APPROVAL, closedAt: i.updatedAt }))).toBe('change_rejected');
    // Época errada na transição → recusada.
    expect(await edit(q.store, q.id, (i, epoch) => Object.assign(i, { state: 'admitted', reason: 'x', stateEpoch: epoch + 1, approvalId: APPROVAL }))).toBe('change_rejected');
    // Terminal com closedAt diferente de updatedAt → recusado.
    expect(await edit(q.store, q.id, (i, epoch) => Object.assign(i, { state: 'cancelled', reason: 'x', stateEpoch: epoch, closedAt: later(i.updatedAt) }))).toBe('change_rejected');
    // Correto.
    expect(await edit(q.store, q.id, (i, epoch) => Object.assign(i, { state: 'admitted', reason: 'admitted_test', stateEpoch: epoch, approvalId: APPROVAL }))).toBe('resolved');
    // Aprovação nunca é trocada depois de vinculada, nem numa transição.
    expect(await edit(q.store, q.id, (i, epoch) => Object.assign(i, { state: 'dispatching', reason: 'x', stateEpoch: epoch, attempt: 1, approvalId: '55555555-5555-4555-8555-555555555555' }))).toBe('change_rejected');
    expect(await queueCode(q.store.commit((tx) => transition(tx, q.id, 'dispatching')))).toBe('resolved');
  });

  it('itens novos: época da gravação, sem motivo, updatedAt = createdAt', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const push = (overrides: Partial<QueueItem>) => queueCode(store.commit((tx) => void tx.body.items.push(newItem({ stateEpoch: tx.epoch, ...overrides }))));
    expect(await push({ stateEpoch: 9 })).toBe('change_rejected');
    expect(await push({ reason: 'x' })).toBe('change_rejected');
    expect(await push({ updatedAt: later(new Date(START).toISOString()) })).toBe('change_rejected');
    expect(await push({})).toBe('resolved');
  });

  it('identidade e terminais continuam imutáveis', async () => {
    const { store, id } = await storeWith('queued');
    for (const fn of [(i: QueueItem) => (i.projectId = PROJECT_B), (i: QueueItem) => (i.idempotencyKey = 'req-outro-valor-123'), (i: QueueItem) => (i.ownerId = 'outro'), (i: QueueItem) => (i.agentId = 'gemini')]) {
      expect(await edit(store, id, fn)).toBe('change_rejected');
    }
    await moveTo(store, id, ['cancelled']);
    expect(await edit(store, id, (i) => (i.updatedAt = later(i.updatedAt)))).toBe('change_rejected');
  });

  it('reinício com relógio atrasado: interrompido sem regredir updatedAt (fila continua disponível)', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const id = await addItem(store);
    await moveTo(store, id, ['admitted', 'dispatching']);
    const updatedAt = store.items()[0].updatedAt;
    await store.close();
    h.clock.now = START - 24 * 60 * 60 * 1000; // relógio voltou um dia
    const again = await h.open();
    expect(again.status().state).toBe('available');
    expect(again.items()[0]).toMatchObject({ state: 'interrupted', updatedAt });
  });
});
