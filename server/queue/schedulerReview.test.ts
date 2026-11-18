// @vitest-environment node
/**
 * Issue #012, PR 2 — revisão independente R1–R4 e escolhas técnicas confirmadas pelo PO.
 * Pilha real de teste (fila + aprovações em disco, controlador, sandbox SIMULADO). Nada executa.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../limits/contracts.ts';
import { PROJECT, PROJECT_B, queueCode, TASK } from '../test/queueFixtures.ts';
import { createSchedulerStack, driveToRunning, itemOf, startCalls, TASK_B, tokenOf, type SchedulerStack, type StackOptions } from '../test/schedulerFixtures.ts';
import type { ExecutionResult } from './ports.ts';
import { settledCost } from './scheduler.ts';

const stacks: SchedulerStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
async function stack(options: StackOptions = {}) {
  const s = await createSchedulerStack(options);
  stacks.push(s);
  return s;
}
const capacity = (s: SchedulerStack) => s.admission.controller()!.capacityInUse();
const subject = (s: SchedulerStack, id: string) => ({ itemId: id, ownerId: 'admin', projectId: itemOf(s, id).projectId, taskId: itemOf(s, id).taskId, agentId: 'claude-code' });
const events = (s: SchedulerStack, event: string) => s.store.history().filter((e) => e.data.event === event);
async function runningItem(s: SchedulerStack, overrides: Record<string, unknown> = {}) {
  const item = await s.scheduler.submit('admin', s.body(overrides));
  expect((await driveToRunning(s, item.id)).state).toBe('running');
  return item.id;
}
/** Tenta admitir uma tarefa nova e devolve o relatório do último ciclo. */
async function tryAnother(s: SchedulerStack) {
  const next = await s.scheduler.submit('admin', s.body({ taskId: TASK_B }));
  await s.scheduler.tick();
  await s.approveAll();
  await s.scheduler.tick();
  await s.approveAll();
  return { id: next.id, report: await s.scheduler.tick() };
}

describe('R1 — liquidação só depois da persistência', () => {
  it('falha ao gravar o resultado: o controlador NÃO é liquidado, a vaga continua ocupada e o agendador bloqueia', async () => {
    const s = await stack();
    const id = await runningItem(s);
    const result = await s.executor.report(tokenOf(s, id), 'completed');
    s.failCommits(1);
    expect(await queueCode(s.scheduler.onResult(result))).toBe('store_write_failed');
    expect(itemOf(s, id)).toMatchObject({ state: 'running', run: { capacity: 'held' } });
    expect(capacity(s)).toBe(1);
    expect(s.scheduler.status().blocked).toBe('persist_failed');
    // Nenhuma vaga é reutilizada nesta sessão.
    expect((await s.scheduler.tick()).blocked).toBe('persist_failed');
    // O resultado repetido é adiado (bloqueio por falha): nada muda.
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: false, reason: 'result_deferred_blocked' });
    expect(capacity(s)).toBe(1);
    // Reinício: o ledger (sem o desfecho) prevalece — interrompido, vaga ocupada.
    await s.restart();
    expect(itemOf(s, id)).toMatchObject({ state: 'interrupted', run: { capacity: 'held' } });
    expect(capacity(s)).toBe(1);
  });

  it('falha ao liquidar depois de gravar: ledger com o desfecho, controlador mais restritivo, bloqueio; reinício reconstrói do ledger', async () => {
    let failSettle = true;
    const s = await stack({
      admission: (base) => ({
        ...base,
        settle: (...args) => {
          if (failSettle) {
            failSettle = false;
            throw new Error('controller_down');
          }
          return base.settle(...args);
        },
      }),
    });
    const id = await runningItem(s);
    expect(await s.scheduler.onResult(await s.executor.report(tokenOf(s, id), 'completed'))).toEqual({ accepted: true, reason: 'completed' });
    expect(itemOf(s, id)).toMatchObject({ state: 'succeeded', run: { capacity: 'released' } });
    expect(capacity(s)).toBe(1); // controlador não liquidado: vaga continua ocupada nesta sessão
    expect(s.scheduler.status().blocked).toBe('settlement_failed');
    expect(events(s, 'queue.settlement_divergence').map((e) => e.data.reason)).toEqual(['settlement_failed']);
    expect((await tryAnother(s)).report.admitted).toEqual([]);
    await s.restart();
    expect(capacity(s)).toBe(0);
    expect(s.scheduler.status()).toEqual({ restored: true, blocked: null });
    expect(itemOf(s, id).run!.admission!.cost).toEqual({ status: 'none', reservedMinor: 0, confirmedMinor: null });
  });

  it('custo divergente entre ledger e controlador → bloqueio', async () => {
    const s = await stack({ admission: (base) => ({ ...base, settle: (...args) => ({ ...base.settle(...args), status: 'unknown' as const }) }) });
    const id = await runningItem(s);
    await s.scheduler.onResult(await s.executor.report(tokenOf(s, id), 'completed'));
    expect(s.scheduler.status().blocked).toBe('settlement_divergence');
  });

  it('cancelamento: falha ao gravar a parada confirmada → nada liquidado; a vaga continua ocupada', async () => {
    const s = await stack();
    const id = await runningItem(s);
    s.failCommits(1, 1); // 1ª gravação (pedido) passa; 2ª (parada confirmada) falha
    expect(await queueCode(s.scheduler.cancel('admin', PROJECT, id))).toBe('store_write_failed');
    expect(itemOf(s, id)).toMatchObject({ state: 'running', run: { capacity: 'held', cancellation: { result: 'pending' } } });
    expect(capacity(s)).toBe(1);
    expect(s.scheduler.status().blocked).toBe('persist_failed');
  });

  it('liquidação repetida é idempotente; resultado repetido é ignorado', async () => {
    const s = await stack();
    const id = await runningItem(s);
    const result = await s.executor.report(tokenOf(s, id), 'completed');
    await s.scheduler.onResult(result);
    const admissionId = itemOf(s, id).run!.admission!.admissionId;
    const usage = { cost: { kind: 'none' as const }, tokens: null };
    const first = s.admission.settle(subject(s, id), admissionId, 'completed', usage);
    expect(s.admission.settle(subject(s, id), admissionId, 'stopped', usage)).toEqual(first);
    expect(capacity(s)).toBe(0);
    expect(s.admission.controller()!.auditTrail().filter((e) => e.event === 'capacity_released')).toHaveLength(1);
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: false, reason: 'late_result' });
  });

  it('custo desconhecido nunca é descartado (mesma regra conservadora do controlador)', () => {
    const none = { kind: 'none' as const };
    expect(settledCost({ status: 'estimated', reservedMinor: 500, confirmedMinor: null }, 'metered_api', { cost: none, tokens: null })).toEqual({ status: 'unknown', reservedMinor: 500, confirmedMinor: null });
    expect(settledCost({ status: 'estimated', reservedMinor: 500, confirmedMinor: null }, 'metered_api', { cost: { kind: 'unknown' }, tokens: 10 })).toEqual({ status: 'unknown', reservedMinor: 500, confirmedMinor: null });
    expect(settledCost({ status: 'unknown', reservedMinor: 500, confirmedMinor: null }, 'subscription_assisted', { cost: none, tokens: null })).toMatchObject({ status: 'unknown', reservedMinor: 500 });
    expect(settledCost({ status: 'estimated', reservedMinor: 500, confirmedMinor: null }, 'metered_api', { cost: { kind: 'confirmed', amountMinor: 120 }, tokens: 10 })).toEqual({ status: 'confirmed', reservedMinor: 500, confirmedMinor: 120 });
    expect(settledCost({ status: 'none', reservedMinor: 0, confirmedMinor: null }, 'subscription_assisted', { cost: none, tokens: null })).toEqual({ status: 'none', reservedMinor: 0, confirmedMinor: null });
  });

  it('consumo incoerente com o modo é recusado antes de gravar ou liquidar', async () => {
    const s = await stack();
    const id = await runningItem(s);
    const result = await s.executor.report(tokenOf(s, id), 'completed');
    expect(await s.scheduler.onResult({ ...result, usage: { cost: { kind: 'none' }, tokens: 5 } })).toEqual({ accepted: false, reason: 'invalid_usage' });
    expect(itemOf(s, id).state).toBe('running');
    expect(capacity(s)).toBe(1);
  });
});

describe('R2 — resultados durante bloqueio: só reconciliação, nunca despacho/reintento/reativação', () => {
  const reconcileUnder = async (engage: (s: SchedulerStack) => Promise<unknown>, expected: string) => {
    const s = await stack();
    const id = await runningItem(s);
    const waiting = await s.scheduler.submit('admin', s.body({ taskId: TASK_B }));
    const result = await s.executor.report(tokenOf(s, id), 'completed');
    await engage(s);
    const starts = startCalls(s);
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: true, reason: 'completed' });
    expect(itemOf(s, id)).toMatchObject({ state: 'succeeded', run: { capacity: 'released' } });
    expect(capacity(s)).toBe(0);
    expect(events(s, 'queue.result_recorded').at(-1)!.data.detail).toContain(`under ${expected}`);
    // Nada novo: nenhum despacho, nenhum sucessor, nada reativado.
    await s.scheduler.tick();
    expect(startCalls(s)).toBe(starts);
    expect(s.store.items().some((i) => i.run?.retryOf)).toBe(false);
    expect(['queued', 'revoked']).toContain(itemOf(s, waiting.id).state);
    return s;
  };

  it('barreira global', async () => {
    await reconcileUnder((s) => s.authority.engage({ scope: { kind: 'global' }, actor: { kind: 'system', id: 'acc-queue' }, reason: 'test' }), 'global_barrier');
  });

  it('barreira de projeto', async () => {
    await reconcileUnder((s) => s.authority.engage({ scope: { kind: 'project', projectId: PROJECT }, actor: { kind: 'system', id: 'acc-queue' }, reason: 'test' }), 'project_barrier');
  });

  it('kill switch com parada não confirmada: o resultado tardio reconcilia; revogados continuam revogados', async () => {
    const s = await stack({ executor: (base) => ({ ...base, cancel: async () => 'not_supported' as const }) });
    const id = await runningItem(s);
    const queued = await s.scheduler.submit('admin', s.body({ taskId: TASK_B }));
    const result = await s.executor.report(tokenOf(s, id), 'failed', 'tool_error');
    const kill = await s.scheduler.engageKillSwitch({ kind: 'global' }, 'emergency_stop');
    expect(kill.revoked).toEqual([queued.id]);
    expect(itemOf(s, id)).toMatchObject({ state: 'running', run: { capacity: 'held' } });
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: true, reason: 'tool_error' });
    expect(itemOf(s, id)).toMatchObject({ state: 'failed', run: { capacity: 'released', outcome: { kind: 'failed_after_start' }, cancellation: { result: 'not_supported' } } });
    expect(events(s, 'queue.result_recorded').at(-1)!.data.detail).toContain('under kill_switch_engaged');
    await s.scheduler.tick();
    expect(itemOf(s, queued.id).state).toBe('revoked');
    expect(startCalls(s)).toBe(1);
    expect(s.store.items()).toHaveLength(2);
  });

  it('resultado atrasado depois da parada confirmada pelo kill switch é ignorado', async () => {
    const s = await stack();
    const id = await runningItem(s);
    const result = await s.executor.report(tokenOf(s, id), 'completed').catch(() => null);
    await s.scheduler.engageKillSwitch({ kind: 'project', projectId: PROJECT }, 'emergency_stop');
    expect(itemOf(s, id).state).toBe('revoked');
    const late: ExecutionResult = result ?? { itemId: id, token: tokenOf(s, id), attempt: 1, epoch: itemOf(s, id).run!.dispatch!.epoch, outcome: 'succeeded', reason: null, usage: { cost: { kind: 'none' }, tokens: null } };
    expect(await s.scheduler.onResult(late)).toEqual({ accepted: false, reason: 'late_result' });
    expect(itemOf(s, id).state).toBe('revoked');
  });

  it('controlador fora de confiança (não restaurado) → resultado adiado, nada gravado nem liquidado', async () => {
    const s = await stack();
    const id = await runningItem(s);
    const result = await s.executor.report(tokenOf(s, id), 'completed');
    await s.restart({ restore: false });
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: false, reason: 'result_deferred_not_restored' });
    expect(itemOf(s, id)).toMatchObject({ state: 'interrupted', run: { capacity: 'held', outcome: null } });
  });
});

describe('R3 — limites: reiniciar nunca amplia limites reduzidos', () => {
  const reduced = { ...structuredClone(DEFAULT_LIMITS), rateLimit: { count: 5, windowSeconds: 3600 } };

  it('limites padrão, nunca alterados (evidência no #011) → restaura', async () => {
    const s = await stack();
    await s.restart();
    expect(s.admission.limitsEvidence()).toEqual({ kind: 'never_changed' });
    expect(s.scheduler.status()).toEqual({ restored: true, blocked: null });
  });

  it('limites reduzidos: bloqueia na sessão; após reinício (com pendente e interrompido) não restaura e aciona a barreira', async () => {
    const s = await stack();
    const running = await runningItem(s);
    const pending = await s.scheduler.submit('admin', s.body({ projectId: PROJECT_B }));
    await s.changeLimits(reduced);
    expect(s.admission.controller()!.getLimits().rateLimit.count).toBe(5);
    expect((await s.scheduler.tick()).blocked).toBe('limits_changed_unpersisted');
    const reservation = itemOf(s, running).run!.admission;
    await s.restart();
    // O controlador novo teria os limites PADRÃO (mais permissivos): a restauração é recusada.
    expect(s.admission.limitsEvidence()).toMatchObject({ kind: 'last_applied' });
    expect(s.scheduler.status()).toEqual({ restored: false, blocked: 'limits_unproven' });
    expect(s.admission.controller()).toBeNull();
    expect(s.gate.check(null)).toEqual({ open: false, reason: 'global_barrier' });
    expect(await s.scheduler.tick()).toMatchObject({ ran: false, blocked: 'limits_unproven' });
    // Nada perdido nem liberado: reservas gravadas intactas, pendente continua pendente.
    expect(itemOf(s, running)).toMatchObject({ state: 'interrupted', run: { capacity: 'held' } });
    expect(itemOf(s, running).run!.admission).toEqual(reservation);
    expect(itemOf(s, pending.id).state).toBe('queued');
  });

  it('limites alterados e depois devolvidos aos padrões (comprovado) → restaura', async () => {
    const s = await stack();
    await s.changeLimits(reduced);
    s.advance(1000);
    await s.changeLimits(structuredClone(DEFAULT_LIMITS));
    await s.restart();
    expect(s.scheduler.status()).toEqual({ restored: true, blocked: null });
  });

  it('sem evidência dos limites anteriores → bloqueado (mesmo com limites padrão)', async () => {
    const s = await stack({ limitsHistory: null, restore: false });
    expect(await s.scheduler.restore()).toEqual({ restored: false, reason: 'limits_evidence_missing' });
    expect(s.gate.check(null)).toMatchObject({ open: false });
  });

  it('alteração de limites com desfecho incerto no #011 → bloqueado', async () => {
    const s = await stack({ limitsHistory: () => ({ kind: 'unknown' }), restore: false });
    expect(await s.scheduler.restore()).toEqual({ restored: false, reason: 'limits_evidence_missing' });
  });
});

describe('escolhas técnicas mantidas pelo PO', () => {
  it('1) `sandbox.execute` é aprovada antes da admissão', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    const order = () => s.service.list('admin').filter((a) => a.requestedBy.kind === 'system').map((a) => a.requestedBy.id);
    expect(order()).toEqual(['sandbox']);
    await s.approveAll();
    await s.scheduler.tick();
    expect(order()).toEqual(['sandbox', 'limits']);
    expect(itemOf(s, item.id).state).toBe('queued');
  });

  it('2) uma execução por tarefa por vez (inclusive enquanto um item da tarefa está interrompido)', async () => {
    const s = await stack();
    const first = await runningItem(s);
    await s.restart();
    const second = await s.scheduler.submit('admin', s.body());
    expect((await s.scheduler.tick()).refused).toContainEqual({ itemId: second.id, code: 'task_busy', class: 'recoverable' });
    expect(itemOf(s, first).state).toBe('interrupted');
  });

  it('3) submissões bloqueadas durante kill switch ou barreira', async () => {
    const s = await stack();
    await s.scheduler.engageKillSwitch({ kind: 'project', projectId: PROJECT }, 'emergency_stop');
    expect(await queueCode(s.scheduler.submit('admin', s.body()))).toBe('execution_blocked');
    await s.authority.engage({ scope: { kind: 'global' }, actor: { kind: 'system', id: 'acc-queue' }, reason: 'test' });
    expect(await queueCode(s.scheduler.submit('admin', s.body({ projectId: PROJECT_B })))).toBe('execution_blocked');
  });

  it('4) `interrupted` nunca volta a executar; a vaga só sai com confirmação confiável do executor', async () => {
    const s = await stack({ executor: (base) => ({ ...base, cancel: async () => 'not_supported' as const }) });
    const id = await runningItem(s);
    const late = await s.executor.report(tokenOf(s, id), 'completed');
    await s.restart();
    await s.scheduler.cancel('admin', PROJECT, id); // sem confirmação → nada muda
    for (let i = 0; i < 3; i += 1) await s.scheduler.tick();
    expect(itemOf(s, id)).toMatchObject({ state: 'interrupted', attempt: 1, run: { capacity: 'held' } });
    expect(capacity(s)).toBe(1);
    await s.scheduler.onResult(late); // confirmação do executor (token/tentativa/época gravados)
    expect(itemOf(s, id)).toMatchObject({ state: 'interrupted', attempt: 1, run: { capacity: 'released', outcome: { kind: 'ended_after_interruption' } } });
    expect(s.store.items().filter((i) => i.taskId === TASK)).toHaveLength(1);
  });
});
