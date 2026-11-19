// @vitest-environment node
/**
 * Issue #012, PR 2: agendador da fila sobre a pilha REAL de teste — fila em disco, aprovações (#011)
 * em disco, controlador (#022) pelo adaptador e sandbox (#021) com provedor SIMULADO. Nada executa.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import { createSandboxQueueExecutor } from '../sandbox/queueExecutor.ts';
import { createSandboxService } from '../sandbox/service.ts';
import { addItem, moveTo, PROJECT, PROJECT_B, queueCode, spawnQueueWorker, TASK } from '../test/queueFixtures.ts';
import { createSchedulerStack, driveToRunning, itemOf, startCalls, TASK_B, TASK_C, TASK_D, testCatalog, tokenOf, type SchedulerStack, type StackOptions } from '../test/schedulerFixtures.ts';
import { ADMITTED_WINDOW_MS, QUEUE_TTL_MS, retryDelayMs } from './contracts.ts';
import type { DispatchResult, ExecutorPort } from './ports.ts';

const MIN = 60_000;
const stacks: SchedulerStack[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.close();
});
async function stack(options: StackOptions = {}) {
  const s = await createSchedulerStack(options);
  stacks.push(s);
  return s;
}
const events = (s: SchedulerStack, event: string, itemId?: string) => s.store.history().filter((e) => e.data.event === event && (itemId === undefined || e.data.itemId === itemId));
const capacity = (s: SchedulerStack) => s.admission.controller()!.capacityInUse();
/** Pedidos de aprovação de componentes (sem as confirmações de configuração do PO). */
const componentApprovals = (s: SchedulerStack) => s.service.list('admin').filter((a) => a.requestedBy.kind === 'system');

describe('submissão (idempotência, identidade, projeto)', () => {
  it('mesma chave + mesmo pedido → mesmo item; conteúdo diferente → conflito; nada executa', async () => {
    const s = await stack();
    const body = s.body();
    const first = await s.scheduler.submit('admin', body);
    const again = await s.scheduler.submit('admin', structuredClone(body));
    expect(again.id).toBe(first.id);
    expect(s.store.items()).toHaveLength(1);
    expect(first).toMatchObject({ state: 'queued', attempt: 0, approvalId: null, run: { chainAttempt: 1, capacity: 'none', admission: null, dispatch: null } });
    expect(await queueCode(s.scheduler.submit('admin', { ...body, priority: 'high' }))).toBe('idempotency_conflict');
    expect(await queueCode(s.scheduler.submit('admin', { ...body, execution: { ...(body.execution as object), credentialScopes: ['repo.write_work_branch'] } }))).toBe('idempotency_conflict');
    // Submeter não inicia nada.
    expect(s.provider.calls).toEqual([]);
    expect(componentApprovals(s)).toHaveLength(0);
  });

  it('valida identidade, projeto, tarefa, agente, parâmetros e chaves reservadas', async () => {
    const s = await stack();
    expect(await queueCode(s.scheduler.submit('Not Valid!', s.body()))).toBe('invalid_identity');
    expect(await queueCode(s.scheduler.submit('intruder', s.body()))).toBe('not_found');
    expect(await queueCode(s.scheduler.submit('admin', s.body({ taskId: '99999999-9999-4999-8999-999999999999' })))).toBe('not_found');
    expect(await queueCode(s.scheduler.submit('admin', s.body({ agentId: 'gemini' })))).toBe('agent_not_assigned');
    expect(await queueCode(s.scheduler.submit('admin', s.body({ idempotencyKey: 'retry:forged-key' })))).toBe('invalid_idempotency_key');
    expect(await queueCode(s.scheduler.submit('admin', { ...s.body(), extra: 1 }))).toBe('invalid_request');
    expect(await queueCode(s.scheduler.submit('admin', s.body({ admission: { action: 'tool.use', mode: 'subscription_assisted', durationSeconds: 3600, estimatedCostMinor: null, maxTokens: null } })))).toBe('duration_out_of_limits');
    expect(await queueCode(s.scheduler.submit('admin', s.body({ execution: { ...(s.body().execution as object), projectId: PROJECT } })))).toBe('invalid_params');
    expect(s.store.items()).toHaveLength(0);
  });

  it('bloqueado (barreira/kill switch) → nada novo entra na fila', async () => {
    const s = await stack();
    await s.authority.engage({ scope: { kind: 'project', projectId: PROJECT }, actor: { kind: 'system', id: 'acc-queue' }, reason: 'test' });
    expect(await queueCode(s.scheduler.submit('admin', s.body()))).toBe('execution_blocked');
    expect(await queueCode(s.scheduler.submit('admin', s.body({ projectId: PROJECT_B })))).toBe('resolved');
  });
});

describe('ciclo: prioridade, FIFO, duas aprovações e execução simulada', () => {
  it('ordena por prioridade e depois FIFO; só o primeiro elegível ocupa a vaga', async () => {
    const order: string[] = [];
    const s = await stack({ executor: (base) => ({ ...base, prepare: (subject, params) => (order.push(subject.itemId), base.prepare(subject, params)) }) });
    const low = await s.scheduler.submit('admin', s.body({ priority: 'low' }));
    s.advance(1);
    const high1 = await s.scheduler.submit('admin', s.body({ priority: 'high', taskId: TASK_B }));
    s.advance(1);
    const medium = await s.scheduler.submit('admin', s.body({ priority: 'medium', taskId: TASK_C }));
    s.advance(1);
    const high2 = await s.scheduler.submit('admin', s.body({ priority: 'high', taskId: TASK_D }));
    await s.scheduler.tick();
    expect(order).toEqual([high1.id, high2.id, medium.id, low.id]);
    // Aprovações de execução (4) → depois as de admissão; o de maior prioridade e mais antigo vence.
    await s.approveAll();
    await s.scheduler.tick();
    await s.approveAll();
    const report = await s.scheduler.tick();
    expect(report.dispatched).toEqual([high1.id]);
    expect(itemOf(s, high1.id).state).toBe('running');
    for (const id of [high2.id, medium.id, low.id]) expect(itemOf(s, id).state).toBe('queued');
    expect(report.refused).toContainEqual({ itemId: high2.id, code: 'concurrency_limit', class: 'recoverable' });
    expect(startCalls(s)).toBe(1);
  });

  it('uma tarefa por vez: itens da mesma tarefa esperam a vez (sem disputar a aprovação pendente)', async () => {
    const s = await stack();
    const first = await s.scheduler.submit('admin', s.body());
    s.advance(1);
    const second = await s.scheduler.submit('admin', s.body());
    const report = await s.scheduler.tick();
    expect(report.refused).toContainEqual({ itemId: second.id, code: 'task_busy', class: 'recoverable' });
    expect(componentApprovals(s).filter((a) => a.state === 'pending')).toHaveLength(1);
    await driveToRunning(s, first.id);
    expect((await s.scheduler.tick()).refused).toContainEqual({ itemId: second.id, code: 'task_busy', class: 'recoverable' });
    await s.scheduler.onResult(await s.executor.report(tokenOf(s, first.id), 'completed'));
    expect((await driveToRunning(s, second.id)).state).toBe('running');
    expect(componentApprovals(s).filter((a) => a.state === 'superseded')).toHaveLength(0);
  });

  it('Q3: aprovação de admissão (limits) e de execução (sandbox) são distintas e de uso único', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    // Primeiro só existe o pedido de execução; aprová-lo NÃO admite.
    expect(componentApprovals(s).map((a) => a.requestedBy.id)).toEqual(['sandbox']);
    await s.approveAll();
    await s.scheduler.tick();
    expect(itemOf(s, item.id).state).toBe('queued');
    expect(componentApprovals(s).filter((a) => a.state === 'pending').map((a) => a.requestedBy.id)).toEqual(['limits']);
    await s.approveAll();
    await s.scheduler.tick();
    const running = itemOf(s, item.id);
    expect(running.state).toBe('running');
    const approvals = componentApprovals(s);
    const sandboxApproval = approvals.find((a) => a.requestedBy.id === 'sandbox')!;
    const limitsApproval = approvals.find((a) => a.requestedBy.id === 'limits')!;
    expect(sandboxApproval.id).not.toBe(limitsApproval.id);
    expect([sandboxApproval.state, limitsApproval.state]).toEqual(['consumed', 'consumed']);
    expect(running.approvalId).toBe(limitsApproval.id);
    expect(running.run!.admission!.approvalIds).toEqual([limitsApproval.id]);
    expect(s.executor.recordOf({ itemId: item.id, ownerId: 'admin', projectId: PROJECT, taskId: TASK, agentId: 'claude-code' })!.approvalId).toBe(sandboxApproval.id);
    expect(s.service.attemptsOf('admin', sandboxApproval.id)).toEqual([expect.objectContaining({ component: 'sandbox', state: 'succeeded' })]);
    expect(s.service.attemptsOf('admin', limitsApproval.id)).toEqual([expect.objectContaining({ component: 'limits', state: 'succeeded' })]);
  });

  it('integração: intenção gravada antes do despacho, início confirmado, término e vaga liberada', async () => {
    const seen: string[] = [];
    const s = await stack({
      executor: (base) => ({
        ...base,
        dispatch: (input) => {
          // G1: quando o executor é chamado, a intenção (token) JÁ está gravada.
          const item = s.store.items().find((i) => i.id === input.itemId)!;
          seen.push(`${item.state}:${item.run!.dispatch!.token === input.token}:${item.attempt}`);
          return base.dispatch(input);
        },
      }),
    });
    const item = await s.scheduler.submit('admin', s.body());
    expect((await driveToRunning(s, item.id)).state).toBe('running');
    expect(seen).toEqual(['dispatching:true:1']);
    expect(events(s, 'queue.dispatch_intent', item.id)).toHaveLength(1);
    expect(capacity(s)).toBe(1);
    const result = await s.executor.report(tokenOf(s, item.id), 'completed');
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: true, reason: 'completed', persisted: true, settlement: 'settled' });
    expect(itemOf(s, item.id)).toMatchObject({ state: 'succeeded', run: { capacity: 'released', outcome: { kind: 'completed' } } });
    expect(capacity(s)).toBe(0);
    // Nada real: provedor simulado, sem código executado.
    expect(REAL_EXECUTION_ENABLED).toBe(false);
    expect(s.provider.executesCode).toBe(false);
    expect(s.provider.calls.map((c) => c.op)).toEqual(['prepare', 'start', 'destroy']);
  });

  it('ciclos simultâneos: o concorrente não roda; a admissão e o início acontecem uma única vez', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    await s.scheduler.tick();
    await s.approveAll();
    const [a, b] = await Promise.all([s.scheduler.tick(), s.scheduler.tick()]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect([a.blocked, b.blocked]).toContain('tick_in_progress');
    expect(itemOf(s, item.id).state).toBe('running');
    expect(s.admission.controller()!.list('admin', PROJECT)).toHaveLength(1);
    expect(startCalls(s)).toBe(1);
  });
});

describe('limites de custo e concorrência', () => {
  it('concorrência: a segunda tarefa espera (recuperável) e é admitida quando a vaga é liberada', async () => {
    const s = await stack();
    const first = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, first.id);
    const second = await s.scheduler.submit('admin', s.body({ taskId: TASK_B }));
    await s.scheduler.tick();
    await s.approveAll();
    const report = await s.scheduler.tick();
    expect(report.refused).toContainEqual({ itemId: second.id, code: 'concurrency_limit', class: 'recoverable' });
    expect(itemOf(s, second.id).state).toBe('queued');
    await s.scheduler.onResult(await s.executor.report(tokenOf(s, first.id), 'completed'));
    expect((await driveToRunning(s, second.id)).state).toBe('running');
  });

  it('custo: API cobrada com orçamento R$ 0 → recusa definitiva, nada reservado nem despachado', async () => {
    const catalog = { ...testCatalog, 'spend.create': { ...testCatalog['spend.create'], available: true } };
    const s = await stack({ catalog });
    const item = await s.scheduler.submit('admin', s.body({ admission: { action: 'tool.use', mode: 'metered_api', durationSeconds: 600, estimatedCostMinor: 500, maxTokens: 1000 } }));
    for (let i = 0; i < 5 && itemOf(s, item.id).state === 'queued'; i += 1) {
      await s.scheduler.tick();
      await s.approveAll();
    }
    expect(itemOf(s, item.id)).toMatchObject({ state: 'failed', reason: 'budget_exceeded', run: { outcome: { kind: 'refused_definitive' }, capacity: 'none', admission: null } });
    expect(s.admission.controller()!.budgetSummary().committedMinor).toBe(0);
    expect(startCalls(s)).toBe(0);
  });

  it('gasto indisponível no catálogo → recuperável (não falha a tarefa)', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body({ admission: { action: 'tool.use', mode: 'metered_api', durationSeconds: 600, estimatedCostMinor: 500, maxTokens: 1000 } }));
    await s.scheduler.tick();
    await s.approveAll();
    await s.scheduler.tick();
    await s.approveAll();
    const report = await s.scheduler.tick();
    expect(itemOf(s, item.id).state).toBe('queued');
    expect(report.refused.map((r) => r.class)).toEqual(['recoverable']);
  });
});

describe('reinício (Q1/Q2/Q8, G1/G2)', () => {
  it('controlador reconstruído do ledger: vaga, reserva e aprovações preservadas; nada é redespachado', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    const running = await driveToRunning(s, item.id);
    const before = startCalls(s);
    expect(before).toBe(1);
    await s.restart();
    const restored = itemOf(s, item.id);
    expect(restored).toMatchObject({ state: 'interrupted', reason: 'instance_restart', run: { capacity: 'held' } });
    expect(restored.run!.admission).toEqual(running.run!.admission);
    expect(s.scheduler.status()).toEqual({ restored: true, blocked: null });
    const controller = s.admission.controller()!;
    expect(controller.capacityInUse()).toBe(1);
    expect(controller.get('admin', PROJECT, running.run!.admission!.admissionId)).toMatchObject({ capacity: 'held', approvalIds: running.run!.admission!.approvalIds });
    // Nova tarefa espera: a vaga do item interrompido NÃO é liberada pelo reinício.
    const next = await s.scheduler.submit('admin', s.body({ taskId: TASK_B }));
    await s.scheduler.tick();
    await s.approveAll();
    const report = await s.scheduler.tick();
    expect(report.refused).toContainEqual({ itemId: next.id, code: 'concurrency_limit', class: 'recoverable' });
    for (let i = 0; i < 3; i += 1) await s.scheduler.tick();
    expect(itemOf(s, item.id).state).toBe('interrupted');
    expect(startCalls(s)).toBe(0); // provedor da nova instância nunca iniciou nada
    expect(s.store.items().some((i) => i.run?.retryOf === item.id)).toBe(false);
  });

  it('reinício DURANTE o despacho: a intenção gravada vira `interrupted`, sem novo despacho', async () => {
    let calls = 0;
    const hanging: ExecutorPort['dispatch'] = () => {
      calls += 1;
      return new Promise<DispatchResult>(() => undefined);
    };
    const s = await stack({ executor: (base) => ({ ...base, dispatch: hanging }) });
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    await s.scheduler.tick();
    await s.approveAll();
    void s.scheduler.tick(); // fica preso no executor
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(calls).toBe(1);
    expect(itemOf(s, item.id)).toMatchObject({ state: 'dispatching', attempt: 1 });
    await s.restart();
    expect(itemOf(s, item.id)).toMatchObject({ state: 'interrupted', reason: 'instance_restart', attempt: 1, run: { capacity: 'held' } });
    await s.scheduler.tick();
    expect(calls).toBe(1);
    expect(capacity(s)).toBe(1);
  });

  it('admitido e não despachado no reinício: expira, libera a vaga e a reserva continua registrada', async () => {
    const s = await stack({
      admission: (base) => ({
        ...base,
        admit: async (input) => {
          const result = await base.admit(input);
          s.advance(ADMITTED_WINDOW_MS + 1); // a janela de despacho passa antes do despacho
          return result;
        },
      }),
    });
    const item = await s.scheduler.submit('admin', s.body());
    for (let i = 0; i < 3; i += 1) {
      await s.scheduler.tick();
      await s.approveAll();
    }
    expect(itemOf(s, item.id).state).toBe('admitted');
    await s.restart();
    expect(itemOf(s, item.id)).toMatchObject({ state: 'expired', reason: 'instance_restart', run: { capacity: 'released', outcome: { kind: 'not_dispatched' } } });
    expect(capacity(s)).toBe(0);
    expect(s.admission.controller()!.list('admin', PROJECT)).toHaveLength(1);
  });

  it('Q2: limites diferentes dos gravados → bloqueado, barreira global acionada, nada admitido', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    // A reserva gravada é imutável; a divergência é simulada no controlador reiniciado, cujos
    // limites vigentes diferem dos gravados (ex.: limites alterados antes do reinício).
    await s.restart({ restore: false });
    const port = s.admission;
    const original = port.limitsFingerprint;
    port.limitsFingerprint = () => `limits:${'f'.repeat(64)}`;
    expect(await s.scheduler.restore()).toEqual({ restored: false, reason: 'limits_unproven' });
    port.limitsFingerprint = original;
    expect(s.gate.check(null)).toEqual({ open: false, reason: 'global_barrier' });
    expect(events(s, 'queue.restore_blocked')).toHaveLength(1);
    const tick = await s.scheduler.tick();
    expect(tick).toMatchObject({ ran: false, blocked: 'limits_unproven' });
  });

  it('Q2: limites alterados durante a sessão (sem persistência) → agendador bloqueado', async () => {
    const s = await stack();
    const port = s.admission;
    port.limitsFingerprint = () => `limits:${'e'.repeat(64)}`;
    await s.scheduler.submit('admin', s.body());
    expect(await s.scheduler.tick()).toMatchObject({ blocked: 'limits_changed_unpersisted', admitted: [] });
    expect(s.scheduler.status().blocked).toBe('limits_changed_unpersisted');
  });

  it('sem restauração nada é admitido', async () => {
    const s = await stack({ restore: false });
    await s.scheduler.submit('admin', s.body());
    expect(await s.scheduler.tick()).toMatchObject({ ran: false, blocked: 'not_restored' });
  });
});

describe('falha antes de iniciar, resultado incerto, resultado atrasado', () => {
  it('autorização vencida antes do preparo → não iniciado comprovado → sucessor com backoff e NOVAS aprovações', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll(); // execução
    await s.scheduler.tick(); // sandbox autorizado; admissão pendente
    s.advance(61 * MIN); // autorização do sandbox vence
    await s.approveAll(); // admissão
    const report = await s.scheduler.tick();
    const failed = itemOf(s, item.id);
    expect(failed).toMatchObject({ state: 'failed', reason: 'authorization_expired', run: { capacity: 'released', outcome: { kind: 'not_started', retryable: true } } });
    expect(capacity(s)).toBe(0);
    expect(report.retried).toHaveLength(1);
    const successor = itemOf(s, report.retried[0]);
    expect(successor).toMatchObject({ state: 'queued', idempotencyKey: `retry:${item.id}`, run: { retryOf: item.id, chainAttempt: 2, admission: null } });
    expect(Date.parse(successor.run!.notBefore!) - Date.parse(successor.createdAt)).toBe(30_000);
    // Antes do backoff nada acontece; depois, exige nova aprovação de execução.
    const pendingBefore = componentApprovals(s).filter((a) => a.state === 'pending').length;
    await s.scheduler.tick();
    expect(componentApprovals(s).filter((a) => a.state === 'pending').length).toBe(pendingBefore);
    s.advance(30_000);
    await s.scheduler.tick();
    expect(componentApprovals(s).filter((a) => a.state === 'pending').map((a) => a.requestedBy.id)).toEqual(['sandbox']);
    expect((await driveToRunning(s, successor.id)).state).toBe('running');
    expect(startCalls(s)).toBe(1);
  });

  it('no máximo 3 tentativas (30 s, 60 s); não iniciado sem reintento autorizado → só falha', async () => {
    const s = await stack({
      executor: (base) => ({ ...base, prepare: async () => ({ status: 'ready' as const }), dispatch: async () => ({ kind: 'not_started' as const, code: 'provider_busy', retryable: true }) }),
    });
    const item = await s.scheduler.submit('admin', s.body());
    const run = async () => {
      for (let i = 0; i < 3; i += 1) {
        await s.scheduler.tick();
        await s.approveAll();
      }
    };
    await run();
    s.advance(30_000);
    await run();
    s.advance(60_000);
    await run();
    const chain = s.store.items();
    expect(chain.map((i) => [i.state, i.run!.chainAttempt])).toEqual([
      ['failed', 1],
      ['failed', 2],
      ['failed', 3],
    ]);
    expect(Date.parse(chain[2].run!.notBefore!) - Date.parse(chain[2].createdAt)).toBe(60_000);
    expect(chain[2].run!.retryOf).toBe(chain[1].id);
    expect(events(s, 'queue.retry_scheduled')).toHaveLength(2);
    expect(item.id).toBe(chain[0].id);
    expect([retryDelayMs(2), retryDelayMs(3), retryDelayMs(4), retryDelayMs(9)]).toEqual([30_000, 60_000, 120_000, 600_000]);
  });

  it('não iniciado sem reintento autorizado (ex.: execução real desligada) → falha sem sucessor', async () => {
    const s = await stack({
      executor: (base) => ({ ...base, prepare: async () => ({ status: 'ready' as const }), dispatch: async () => ({ kind: 'not_started' as const, code: 'real_execution_disabled', retryable: false }) }),
    });
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    await s.scheduler.tick();
    expect(itemOf(s, item.id)).toMatchObject({ state: 'failed', run: { outcome: { kind: 'not_started', retryable: false } } });
    expect(s.store.items()).toHaveLength(1);
  });

  it('resultado incerto (falha parcial do provedor, erro, timeout) → `interrupted`, vaga ocupada, sem reintento', async () => {
    const s = await stack();
    s.provider.failNext('start', 'boom', 'detalhe interno', { partial: true });
    const item = await s.scheduler.submit('admin', s.body());
    const after = await driveToRunning(s, item.id);
    expect(after).toMatchObject({ state: 'interrupted', reason: 'dispatch_uncertain', run: { capacity: 'held', outcome: null } });
    expect(capacity(s)).toBe(1);
    for (let i = 0; i < 3; i += 1) await s.scheduler.tick();
    expect(startCalls(s)).toBe(1);
    expect(s.store.items()).toHaveLength(1);
    expect(JSON.stringify(s.store.history())).not.toContain('detalhe interno');

    const t = await stack({ executor: (base) => ({ ...base, dispatch: async () => Promise.reject(new Error('timeout')) }) });
    const other = await t.scheduler.submit('admin', t.body());
    expect((await driveToRunning(t, other.id)).state).toBe('interrupted');
  });

  it('resultado atrasado, de outro token, tentativa ou época é ignorado; terminal nunca muda', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    const result = await s.executor.report(tokenOf(s, item.id), 'completed');
    expect(await s.scheduler.onResult({ ...result, token: '99999999-9999-4999-8999-999999999999' })).toEqual({ accepted: false, reason: 'result_mismatch', persisted: false, settlement: 'not_applicable' });
    expect(await s.scheduler.onResult({ ...result, attempt: 2 })).toEqual({ accepted: false, reason: 'result_mismatch', persisted: false, settlement: 'not_applicable' });
    expect(await s.scheduler.onResult({ ...result, epoch: result.epoch + 1 })).toEqual({ accepted: false, reason: 'result_mismatch', persisted: false, settlement: 'not_applicable' });
    expect(await s.scheduler.onResult({ ...result, extra: true })).toEqual({ accepted: false, reason: 'invalid_result', persisted: false, settlement: 'not_applicable' });
    expect(itemOf(s, item.id).state).toBe('running');
    expect(await s.scheduler.onResult(result)).toEqual({ accepted: true, reason: 'completed', persisted: true, settlement: 'settled' });
    const closed = itemOf(s, item.id);
    expect(await s.scheduler.onResult({ ...result, outcome: 'failed', reason: 'late' })).toEqual({ accepted: false, reason: 'late_result', persisted: false, settlement: 'not_applicable' });
    expect(itemOf(s, item.id)).toEqual(closed);
    expect(events(s, 'queue.result_ignored').length).toBe(5);
  });

  it('Q8: término comprovado de um `interrupted` libera a vaga, mas o item NÃO volta a executar', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    const late = await s.executor.report(tokenOf(s, item.id), 'completed'); // resultado que chega "tarde"
    await s.restart();
    expect(capacity(s)).toBe(1);
    expect(await s.scheduler.onResult(late)).toEqual({ accepted: true, reason: 'interrupted_end_recorded', persisted: true, settlement: 'settled' });
    expect(itemOf(s, item.id)).toMatchObject({ state: 'interrupted', run: { capacity: 'released', outcome: { kind: 'ended_after_interruption', reason: 'reported_succeeded' } } });
    expect(capacity(s)).toBe(0);
    expect(await s.scheduler.onResult(late)).toEqual({ accepted: false, reason: 'already_resolved', persisted: false, settlement: 'not_applicable' });
    await s.scheduler.tick();
    expect(itemOf(s, item.id).state).toBe('interrupted');
  });
});

describe('cancelamento', () => {
  it('queued → cancelled; terminal → invalid_transition; de outro dono/projeto → not_found', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick(); // prepara (sandbox pendente)
    expect(await queueCode(s.scheduler.cancel('admin', PROJECT_B, item.id))).toBe('not_found');
    expect(await queueCode(s.scheduler.cancel('intruder', PROJECT, item.id))).toBe('not_found');
    expect((await s.scheduler.cancel('admin', PROJECT, item.id)).state).toBe('cancelled');
    expect(s.sandbox.list('admin', PROJECT).map((r) => r.state)).toEqual(['cancelled']); // preparação descartada
    expect(await queueCode(s.scheduler.cancel('admin', PROJECT, item.id))).toBe('invalid_transition');
  });

  it('admitted → cancelled com a reserva liberada (nunca despachado)', async () => {
    const s = await stack({
      admission: (base) => ({
        ...base,
        admit: async (input) => {
          const result = await base.admit(input);
          s.advance(ADMITTED_WINDOW_MS + 1);
          return result;
        },
      }),
    });
    const item = await s.scheduler.submit('admin', s.body());
    for (let i = 0; i < 3; i += 1) {
      await s.scheduler.tick();
      await s.approveAll();
    }
    expect(capacity(s)).toBe(1);
    const cancelled = await s.scheduler.cancel('admin', PROJECT, item.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', run: { capacity: 'released', outcome: { kind: 'not_dispatched' } } });
    expect(capacity(s)).toBe(0);
    expect(startCalls(s)).toBe(0);
  });

  it('running: parada confirmada → cancelled e vaga liberada; sem confirmação → continua ocupada', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    expect(await s.scheduler.cancel('admin', PROJECT, item.id)).toMatchObject({ state: 'cancelled', run: { capacity: 'released', outcome: { kind: 'stop_confirmed' }, cancellation: { result: 'cancelled' } } });
    expect(capacity(s)).toBe(0);

    const t = await stack({ executor: (base) => ({ ...base, cancel: async () => 'not_supported' as const }) });
    const other = await t.scheduler.submit('admin', t.body());
    await driveToRunning(t, other.id);
    expect(await t.scheduler.cancel('admin', PROJECT, other.id)).toMatchObject({ state: 'running', run: { capacity: 'held', cancellation: { result: 'not_supported' } } });
    expect(capacity(t)).toBe(1);
    expect(events(t, 'queue.cancel_requested', other.id)).toHaveLength(2);
  });

  it('interrupted após reinício: o executor não conhece a execução → vaga continua ocupada', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    await s.restart();
    expect(await s.scheduler.cancel('admin', PROJECT, item.id)).toMatchObject({ state: 'interrupted', run: { capacity: 'held', cancellation: { result: 'not_supported' } } });
    expect(capacity(s)).toBe(1);
  });
});

describe('kill switch (Q4) e revogação', () => {
  it('projeto: barreira durável, revoga pendentes, pede parada das execuções; outro projeto intacto', async () => {
    const s = await stack();
    const running = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, running.id);
    const queued = await s.scheduler.submit('admin', s.body({ taskId: TASK_B }));
    const other = await s.scheduler.submit('admin', s.body({ projectId: PROJECT_B }));
    const result = await s.scheduler.engageKillSwitch({ kind: 'project', projectId: PROJECT }, 'emergency_stop');
    expect(result.durable).toBe(true);
    expect(result.revoked.sort()).toEqual([running.id, queued.id].sort());
    expect(itemOf(s, running.id)).toMatchObject({ state: 'revoked', run: { capacity: 'released', outcome: { kind: 'stop_confirmed' } } });
    expect(itemOf(s, queued.id)).toMatchObject({ state: 'revoked', run: { capacity: 'none' } });
    expect(itemOf(s, other.id).state).toBe('queued');
    expect(s.authority.barriers().durable.projects[PROJECT]).toBeTruthy();
    expect(s.gate.check(PROJECT)).toMatchObject({ open: false });
    expect(await queueCode(s.scheduler.submit('admin', s.body()))).toBe('execution_blocked');
  });

  it('global: nada mais é admitido; liberar a barreira NÃO reativa revogados; reintento nunca é criado', async () => {
    const s = await stack();
    const a = await s.scheduler.submit('admin', s.body());
    const b = await s.scheduler.submit('admin', s.body({ projectId: PROJECT_B }));
    const result = await s.scheduler.engageKillSwitch({ kind: 'global' }, 'emergency_stop');
    expect(result).toMatchObject({ durable: true });
    expect([itemOf(s, a.id).state, itemOf(s, b.id).state]).toEqual(['revoked', 'revoked']);
    expect(await s.scheduler.tick()).toMatchObject({ admitted: [], blocked: expect.any(String) });
    await s.releaseGlobal();
    // Nesta instância o kill switch continua acionado (memória do controlador e da fila).
    expect((await s.scheduler.tick()).admitted).toEqual([]);
    await s.restart();
    await s.scheduler.tick();
    expect([itemOf(s, a.id).state, itemOf(s, b.id).state]).toEqual(['revoked', 'revoked']);
    expect(s.store.items().some((i) => i.run?.retryOf)).toBe(false);
    // Nova tarefa exige novo envio e novas aprovações.
    const again = await s.scheduler.submit('admin', s.body());
    expect((await driveToRunning(s, again.id)).state).toBe('running');
  });

  it('execução sem parada confirmada: continua ocupando a vaga e nada novo despacha', async () => {
    const s = await stack({ executor: (base) => ({ ...base, cancel: async () => 'failed' as const }) });
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    const result = await s.scheduler.engageKillSwitch({ kind: 'global' }, 'emergency_stop');
    expect(result.cancellationRequested).toEqual([item.id]);
    expect(itemOf(s, item.id)).toMatchObject({ state: 'running', run: { capacity: 'held', cancellation: { result: 'failed' } } });
    expect(capacity(s)).toBe(1);
  });
});

describe('expiração (Q9)', () => {
  it('queued expira em 24 h (preparação descartada); legado do PR 1 também', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    s.advance(QUEUE_TTL_MS);
    const report = await s.scheduler.tick();
    expect(report.expired).toEqual([item.id]);
    expect(itemOf(s, item.id)).toMatchObject({ state: 'expired', reason: 'ttl_expired' });
    expect(s.sandbox.list('admin', PROJECT).map((r) => r.state)).toEqual(['cancelled']);
  });

  it('admitted sem despacho em 60 s → expira e libera a reserva', async () => {
    const s = await stack({
      admission: (base) => ({
        ...base,
        admit: async (input) => {
          const result = await base.admit(input);
          s.advance(ADMITTED_WINDOW_MS + 1);
          return result;
        },
      }),
    });
    const item = await s.scheduler.submit('admin', s.body());
    for (let i = 0; i < 3; i += 1) {
      await s.scheduler.tick();
      await s.approveAll();
    }
    expect(itemOf(s, item.id).state).toBe('admitted');
    await s.scheduler.tick();
    expect(itemOf(s, item.id)).toMatchObject({ state: 'expired', reason: 'dispatch_window_expired', run: { capacity: 'released', outcome: { kind: 'not_dispatched' } } });
    expect(capacity(s)).toBe(0);
  });

  it('execução além do prazo: pede a parada; sem confirmação a vaga NÃO é liberada', async () => {
    const s = await stack({ executor: (base) => ({ ...base, cancel: async () => 'not_supported' as const }) });
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    s.advance(11 * MIN);
    const report = await s.scheduler.tick();
    expect(report.cancelRequested).toEqual([item.id]);
    expect(itemOf(s, item.id)).toMatchObject({ state: 'running', run: { capacity: 'held', cancellation: { result: 'not_supported' } } });
    expect(capacity(s)).toBe(1);

    const t = await stack();
    const other = await t.scheduler.submit('admin', t.body());
    await driveToRunning(t, other.id);
    t.advance(11 * MIN);
    await t.scheduler.tick();
    expect(itemOf(t, other.id)).toMatchObject({ state: 'failed', reason: 'duration_exceeded', run: { capacity: 'released', outcome: { kind: 'stop_confirmed' } } });
  });
});

describe('recusas recuperáveis x definitivas (Q5) e aprovações', () => {
  it('provedor temporariamente indisponível: continua queued (histórico sem repetição) e é admitido depois', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    s.admission.controller()!.reportProviderUnavailable('claude-code', 'subscription_assisted', { reason: 'provider_outage', until: new Date(s.h.clock.now + 10 * MIN).toISOString() });
    for (let i = 0; i < 3; i += 1) expect((await s.scheduler.tick()).refused).toEqual([{ itemId: item.id, code: 'provider_unavailable', class: 'recoverable' }]);
    expect(itemOf(s, item.id).state).toBe('queued');
    expect(events(s, 'queue.admission_refused', item.id).filter((e) => e.data.reason === 'provider_unavailable')).toHaveLength(1);
    s.advance(11 * MIN);
    expect((await driveToRunning(s, item.id)).state).toBe('running');
  });

  it('provedor não verificado (catálogo real) → recuperável, nunca falha; expira pelo TTL', async () => {
    // Issue #008: no catálogo real só `claude-code/subscription_assisted` está disponível; outro modo segue não verificado.
    const s = await stack({ providers: (await import('../limits/providers.ts')).defaultProviderCatalog() });
    const item = await s.scheduler.submit('admin', s.body({ admission: { action: 'tool.use', mode: 'official_integration', durationSeconds: 600, estimatedCostMinor: null, maxTokens: null } }));
    await s.scheduler.tick();
    await s.approveAll();
    const report = await s.scheduler.tick();
    expect(report.refused).toEqual([{ itemId: item.id, code: 'provider_unverified', class: 'recoverable' }]);
    expect(itemOf(s, item.id).state).toBe('queued');
  });

  it('aprovação ausente (sem núcleo no controlador) → recuperável; nada admitido', async () => {
    const s = await stack({ admissionApprovals: false });
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    const report = await s.scheduler.tick();
    expect(report.refused).toEqual([{ itemId: item.id, code: 'approvals_unavailable', class: 'recoverable' }]);
    expect(itemOf(s, item.id)).toMatchObject({ state: 'queued', run: { admissionIntentAt: null } });
  });

  it('aprovação rejeitada ou vencida → novo pedido pendente; o item nunca é admitido sem aprovação válida', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    await s.scheduler.tick();
    expect(await s.rejectAll()).toBe(1); // admissão rejeitada
    await s.scheduler.tick();
    expect(itemOf(s, item.id).state).toBe('queued');
    const pending = componentApprovals(s).filter((a) => a.state === 'pending');
    expect(pending.map((a) => a.requestedBy.id)).toEqual(['limits']);
    await s.approveAll();
    s.advance(61 * MIN); // aprovada e vencida sem uso (e o sandbox também venceu)
    await s.scheduler.tick();
    expect(itemOf(s, item.id).state).toBe('queued');
    expect(s.service.list('admin').some((a) => a.state === 'expired')).toBe(true);
    expect(s.admission.controller()!.list('admin', PROJECT)).toHaveLength(0);
  });

  it('recusa definitiva (política negada no executor) → `queued → failed` classificado', async () => {
    const s = await stack({ executor: (base) => ({ ...base, prepare: async () => ({ status: 'refused' as const, code: 'policy_denied' }) }) });
    const item = await s.scheduler.submit('admin', s.body());
    const report = await s.scheduler.tick();
    expect(report.refused).toEqual([{ itemId: item.id, code: 'policy_denied', class: 'definitive' }]);
    expect(itemOf(s, item.id)).toMatchObject({ state: 'failed', reason: 'policy_denied', run: { outcome: { kind: 'refused_definitive' } } });
  });
});

describe('compatibilidade com o PR 1 (Q10) e processos', () => {
  it('item do PR 1 `queued` é lido, nunca admitido e expira; item do PR 1 em curso bloqueia a restauração', async () => {
    const s = await stack({ restore: false });
    const legacy = await addItem(s.store);
    expect(await s.scheduler.restore()).toEqual({ restored: true, reason: null });
    await s.scheduler.tick();
    expect(itemOf(s, legacy)).toMatchObject({ state: 'queued' });
    expect(itemOf(s, legacy).run).toBeUndefined();
    expect(s.provider.calls).toEqual([]);
    s.advance(QUEUE_TTL_MS);
    await s.scheduler.tick();
    expect(itemOf(s, legacy)).toMatchObject({ state: 'expired', reason: 'legacy_ttl_expired' });

    const t = await stack({ restore: false });
    const inFlight = await addItem(t.store);
    await moveTo(t.store, inFlight, ['admitted', 'dispatching', 'running']);
    await t.restart({ restore: false });
    expect(itemOf(t, inFlight).state).toBe('interrupted');
    expect(await t.scheduler.restore()).toEqual({ restored: false, reason: 'legacy_item_unproven' });
    expect(t.gate.check(null)).toEqual({ open: false, reason: 'global_barrier' });
    expect(await queueCode(t.scheduler.cancel('admin', PROJECT, inFlight))).toBe('legacy_item_requires_review');
  });

  it('outro processo segurando a fila → indisponível; nada é admitido nem restaurado', async () => {
    const s = await stack();
    await s.store.close();
    const worker = spawnQueueWorker(s.h, 'hold');
    try {
      expect(await worker.firstLine()).toBe('ready available none');
      await s.restart();
      expect(s.store.status()).toMatchObject({ state: 'unavailable', reason: 'store_locked' });
      expect(s.scheduler.status().restored).toBe(false);
      expect(await s.scheduler.tick()).toMatchObject({ ran: false, blocked: 'store_unavailable' });
      expect(await queueCode(s.scheduler.submit('admin', s.body()))).toBe('store_unavailable');
    } finally {
      worker.child.kill();
      await worker.exited;
    }
  });

  it('dois agendadores na mesma fila: um único despacho por item (intenções gravadas e conferidas)', async () => {
    const s = await stack();
    const { createQueueScheduler } = await import('./scheduler.ts');
    // Mesmo adaptador já restaurado: restaurar de novo é recusado (nada é ampliado).
    expect(() => s.admission.restore([])).toThrow('already_restored');
    const otherAdmission = s.makeAdmission();
    const second = createQueueScheduler({ store: s.store, gate: s.gate, admission: otherAdmission, executor: s.executor, tasks: s.tasks, now: () => s.h.clock.now });
    expect(await second.restore()).toEqual({ restored: true, reason: null });
    const item = await s.scheduler.submit('admin', s.body());
    await s.scheduler.tick();
    await s.approveAll();
    await s.scheduler.tick();
    await s.approveAll();
    await Promise.all([s.scheduler.tick(), second.tick()]);
    expect(itemOf(s, item.id).state).toBe('running');
    expect(startCalls(s)).toBe(1);
    const admissions = s.admission.controller()!.list('admin', PROJECT).length + otherAdmission.controller()!.list('admin', PROJECT).length;
    expect(admissions).toBe(1);
  });
});

describe('adaptador do executor (simulado)', () => {
  it('idempotente por token; outro token para o mesmo item é recusado sem tocar no provedor', async () => {
    const s = await stack();
    const item = await s.scheduler.submit('admin', s.body());
    await driveToRunning(s, item.id);
    const token = tokenOf(s, item.id);
    const subject = { itemId: item.id, ownerId: 'admin', projectId: PROJECT, taskId: TASK, agentId: 'claude-code', attempt: 1, epoch: 1 };
    expect(await s.executor.dispatch({ ...subject, token })).toMatchObject({ kind: 'started' });
    expect(await s.executor.dispatch({ ...subject, token: '99999999-9999-4999-8999-999999999999' })).toEqual({ kind: 'not_started', code: 'duplicate_dispatch', retryable: false });
    expect(startCalls(s)).toBe(1);
  });

  it('recusa provedor que executa código ou não é simulado', async () => {
    const s = await stack();
    const real = { id: 'x', isolation: 'container' as const, executesCode: true, prepare: async () => {}, start: async () => {}, stop: async () => {}, destroy: async () => {} };
    const sandbox = createSandboxService({ provider: real, projects: { get: () => null }, tasks: { get: () => null }, catalog: testCatalog });
    expect(() => createSandboxQueueExecutor({ sandbox, provider: real })).toThrow('real_execution_disabled');
    expect(() => createSandboxQueueExecutor({ sandbox: s.sandbox, provider: { isolation: 'simulated', executesCode: true } })).toThrow('real_execution_disabled');
  });
});
