// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayStack, PROJECT, type GatewayStack } from '../test/gatewayFixtures.ts';

/** Revisão complementar do PR #48: R1 (falha de persistência na ativação) e R2 (referências retidas). */

let g: GatewayStack | null = null;
afterEach(async () => {
  if (g) g.faults.failWrite = null;
  await g?.close();
  g = null;
});
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};
const HOUR = 60 * 60 * 1000;

describe('R1 — falha de persistência na ativação do escopo', () => {
  it('ledger grava `active`, o anchor falha e a gravação de recuperação também falha: nunca fica usável, nem depois do reinício', async () => {
    g = await createGatewayStack({
      gateway: {
        approvalVerifier: {
          id: 'acc-approvals:gateway',
          kind: 'trusted',
          verifyGrant: (grant) => {
            const verification = g!.s.service.verifierFor('gateway').verifyGrant(grant);
            // A partir daqui (gravação do escopo ativo e recuperação), toda gravação do anchor falha.
            g!.faults.failWrite = (path) => path.endsWith('gateway-anchor.json');
            return verification;
          },
        },
      },
    });
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    await g.approveAll();
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).not.toBe('ok');
    // Em memória: nada ativo; o armazenamento degradado recusa qualquer uso (fail-closed).
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).not.toBe('active');
    expect(g.store.status().state).toBe('degraded');
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).toBe('store_degraded');
    // A aprovação continua consumida e a tentativa terminou como falha (sem reutilização).
    const approval = g.s.service.list('admin').find((a) => a.binding.resource.id === scope.id)!;
    expect(approval.state).toBe('consumed');
    expect(g.s.service.attemptsOf('admin', approval.id).map((t) => t.state)).toEqual(['failed']);

    // Reinício: o ledger (uma geração à frente do anchor) é aceito, mas o escopo NÃO volta usável.
    g.faults.failWrite = null;
    await g.restartGateway();
    const after = g.gateway.getScope('admin', PROJECT, scope.id)!;
    expect(['expired', 'failed']).toContain(after.state);
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).not.toBe('ok');
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('invalid_transition');
    expect(g.s.service.get('admin', approval.id)!.state).toBe('consumed');
  });

  it('a ativação falha e a gravação de `failed` também falha: fica `activating` (inutilizável) e o reinício conclui como `failed`', async () => {
    g = await createGatewayStack({
      gateway: {
        approvalVerifier: {
          id: 'acc-approvals:gateway',
          kind: 'trusted',
          verifyGrant: () => {
            g!.faults.failWrite = () => true; // a recuperação não consegue gravar nada
            return { authentic: false, reason: 'forged' };
          },
        },
      },
    });
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    await g.approveAll();
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('approval_not_authentic');
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).toBe('activating');
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).not.toBe('ok');
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).not.toBe('ok');
    g.faults.failWrite = null;
    await g.restartGateway();
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!).toMatchObject({ state: 'failed', reason: 'activation_interrupted' });
    const approval = g.s.service.list('admin').find((a) => a.binding.resource.id === scope.id)!;
    expect(approval.state).toBe('consumed');
  });

  it('reinício encerra escopos ativos (como as aprovações concedidas da #011): nenhuma autorização atravessa o reinício', async () => {
    g = await createGatewayStack();
    const simulated = await g.activeScope();
    const assisted = await g.activeScope({ channel: 'assisted', validitySeconds: 900, taskId: '55555555-5555-4555-8555-555555555555', dataRefs: [] });
    const body = (scopeId: string) => {
      const b = g!.taskBody(scopeId, { taskId: '55555555-5555-4555-8555-555555555555', inputs: [] });
      delete b.timeoutSeconds;
      return b;
    };
    const prepared = await g.gateway.prepareHandoff('admin', body(assisted.id));
    const waiting = await g.gateway.prepareHandoff('admin', body(assisted.id));
    await g.gateway.releaseHandoff('admin', PROJECT, waiting.id, await g.confirm());
    await g.restartGateway();
    expect(g.gateway.getScope('admin', PROJECT, simulated.id)!).toMatchObject({ state: 'expired', reason: 'restart_closed' });
    expect(g.gateway.getScope('admin', PROJECT, assisted.id)!).toMatchObject({ state: 'expired', reason: 'restart_closed' });
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(simulated.id)))).toBe('scope_expired');
    // Pacote ainda não liberado: não pode mais sair. Já liberado: a pessoa ainda pode trazer o resultado.
    expect(g.gateway.getHandoff('admin', PROJECT, prepared.id)!.state).toBe('expired');
    expect(g.gateway.getHandoff('admin', PROJECT, waiting.id)!.state).toBe('awaiting_relay');
    await g.gateway.relayResult('admin', PROJECT, waiting.id, { text: 'trazido depois do reinício', modelReported: null, confirm: await g.confirm() });
    expect(g.gateway.getHandoff('admin', PROJECT, waiting.id)!.state).toBe('relayed');
  });
});

describe('R2 — referências retidas pelo executor composto e pelo executor do gateway', () => {
  it('ciclo completo: referências ficam só enquanto úteis e são descartadas depois da retenção; verificação continua protegendo', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope({ maxInvocations: 5 });
    const inv = await g.gateway.invoke('admin', g.taskBody(scope.id));
    await g.s.scheduler.tick();
    await g.approveAll();
    await g.s.scheduler.tick();
    await g.gateway.executor.idle();
    const [result] = g.gateway.executor.drain();
    expect(g.routing.references()).toEqual({ items: 1, tokens: 1 });
    // Forjado continua recusado; o legítimo é aceito.
    expect(await g.s.scheduler.onResult({ ...result, reason: 'x', outcome: 'failed' })).toMatchObject({ accepted: false, reason: 'result_unauthenticated' });
    expect(await g.s.scheduler.onResult(result)).toMatchObject({ accepted: true });
    // Dentro da retenção, a repetição do mesmo resultado continua reconhecida (tardio, sem efeito).
    expect(await g.s.scheduler.onResult(result)).toMatchObject({ accepted: false, reason: 'late_result' });
    // Depois da retenção, qualquer operação descarta as referências antigas (sem acúmulo).
    g.s.advance(25 * HOUR);
    const other = await g.activeScope({ taskId: '55555555-5555-4555-8555-555555555555', dataRefs: [] });
    await g.gateway.invoke('admin', g.taskBody(other.id, { taskId: '55555555-5555-4555-8555-555555555555', inputs: [] }));
    await g.s.scheduler.tick();
    expect(g.routing.references().tokens).toBe(0);
    expect(g.gateway.executor.references()).toMatchObject({ dispatches: 0, proofs: 0, completions: 0 });
    // Resultado antigo depois do descarte: recusado, nada muda.
    expect(await g.s.scheduler.onResult(result)).toMatchObject({ accepted: false });
    expect(g.s.store.items().find((i) => i.id === inv.queueItemId)!.state).toBe('succeeded');
  });

  it('despacho não iniciado e cancelamento confirmado liberam as referências do item na hora', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope({ maxInvocations: 5 });
    g.adapters['claude-code'].setScenario('unavailable');
    await g.gateway.invoke('admin', g.taskBody(scope.id));
    await g.cycle(2);
    expect(g.routing.references()).toEqual({ items: 0, tokens: 0 });

    g.adapters['claude-code'].setScenario('timeout');
    const inv = await g.gateway.invoke('admin', g.taskBody(scope.id, { timeoutSeconds: 600 }));
    await g.s.scheduler.tick();
    await g.approveAll();
    await g.s.scheduler.tick();
    expect(g.routing.references()).toEqual({ items: 1, tokens: 1 });
    await g.s.scheduler.cancel('admin', PROJECT, inv.queueItemId!);
    expect(g.routing.references()).toEqual({ items: 0, tokens: 0 });
    expect(g.gateway.executor.references().runs).toBe(0);
  });
});
