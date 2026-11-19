// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayStack, PROJECT, PROJECT_B, TASK, TASK_B, type GatewayStack } from '../test/gatewayFixtures.ts';

/** D5/I4 — fluxo assistido: a pessoa leva o pacote à ferramenta e traz o resultado, sem ocupar vaga. */

let g: GatewayStack | null = null;
afterEach(async () => {
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
const itemOf = (g: GatewayStack, id: string) => g.s.store.items().find((i) => i.id === id)!;
const HOUR = 60 * 60 * 1000;

async function assistedScope(g: GatewayStack, overrides: Record<string, unknown> = {}) {
  return g.activeScope({ channel: 'assisted', validitySeconds: 900, ...overrides });
}
const handoffBody = (g: GatewayStack, scopeId: string, overrides: Record<string, unknown> = {}) => {
  const body = g.taskBody(scopeId, overrides);
  delete body.timeoutSeconds;
  return body;
};

describe('fluxo assistido (D5/I4)', () => {
  it('preparar → liberar (step-up) → esperar → trazer → ingerir pela fila → validado, com proveniência human_relayed', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g);
    const handoff = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    expect(handoff.state).toBe('prepared');
    expect(g.gateway.handoffResult('admin', PROJECT, handoff.id).outcome).toBe('needs_human');
    // Sem confirmação de identidade, nada é liberado.
    expect(await codeOf(g.gateway.releaseHandoff('admin', PROJECT, handoff.id, { proofId: 'nao', identity: { userId: 'admin', sessionKey: 'x' } }))).toBe('identity_not_confirmed');
    const released = await g.gateway.releaseHandoff('admin', PROJECT, handoff.id, await g.confirm());
    expect(released.handoff.state).toBe('awaiting_relay');
    expect(released.package).toContain('canal assistido: uso manual pela pessoa');
    expect(released.package).toContain('Descrição da tarefa A');
    // Esperando a pessoa: nenhum item na fila.
    expect(g.s.store.items()).toHaveLength(0);
    const relayed = await g.gateway.relayResult('admin', PROJECT, handoff.id, { text: 'Revisão feita na ferramenta externa.', modelReported: 'gpt-x', confirm: await g.confirm() });
    expect(relayed.state).toBe('relayed');
    expect(relayed.ingestQueueItemId).not.toBeNull();
    const delivered = await g.cycle();
    expect(delivered[0].receipt).toMatchObject({ accepted: true, reason: 'completed' });
    const done = g.gateway.getHandoff('admin', PROJECT, handoff.id)!;
    expect(done.state).toBe('validated');
    expect(done.provenance).toMatchObject({ channel: 'assisted', adapter: { kind: 'assisted' }, relayedBy: { kind: 'human', id: 'admin' }, modelReported: 'gpt-x', requestDigest: done.packageDigest });
    const result = g.gateway.handoffResult('admin', PROJECT, handoff.id);
    expect(result.outcome).toBe('succeeded');
    expect(await g.gateway.readContent('admin', PROJECT, result.output!.contentId)).toBe('Revisão feita na ferramenta externa.');
  });

  it('I4: uma espera humana de HORAS não ocupa a única vaga — outra tarefa independente roda até o fim', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g);
    const handoff = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    await g.gateway.releaseHandoff('admin', PROJECT, handoff.id, await g.confirm());
    g.s.advance(5 * HOUR);
    // Tarefa independente (outra tarefa, canal simulado), com maxConcurrent = 1.
    const other = await g.activeScope({ taskId: TASK_B, dataRefs: [] });
    const inv = await g.gateway.invoke('admin', g.taskBody(other.id, { taskId: TASK_B, inputs: [] }));
    await g.cycle();
    expect(g.gateway.result('admin', PROJECT, inv.id)!.outcome).toBe('succeeded');
    expect(itemOf(g, inv.queueItemId!).state).toBe('succeeded');
    // O handoff continua esperando, e a pessoa ainda pode trazer o resultado dentro da janela.
    expect(g.gateway.getHandoff('admin', PROJECT, handoff.id)!.state).toBe('awaiting_relay');
    await g.gateway.relayResult('admin', PROJECT, handoff.id, { text: 'ok', modelReported: null, confirm: await g.confirm() });
    await g.cycle();
    expect(g.gateway.getHandoff('admin', PROJECT, handoff.id)!.state).toBe('validated');
  });

  it('liberar exige escopo válido: depois da validade (15 min de publicação) não sai nada', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g);
    const handoff = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    g.s.advance(16 * 60 * 1000);
    expect(await codeOf(g.gateway.releaseHandoff('admin', PROJECT, handoff.id, await g.confirm()))).toBe('scope_expired');
    await g.gateway.sweep();
    expect(g.gateway.getHandoff('admin', PROJECT, handoff.id)!.state).toBe('expired');
  });

  it('janela de retorno vencida, revogação e barreira: resultado recusado', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g, { maxInvocations: 3 });
    const late = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    await g.gateway.releaseHandoff('admin', PROJECT, late.id, await g.confirm());
    const revoked = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    await g.gateway.releaseHandoff('admin', PROJECT, revoked.id, await g.confirm());
    g.s.advance(25 * HOUR);
    expect(await codeOf(g.gateway.relayResult('admin', PROJECT, late.id, { text: 'tarde', modelReported: null, confirm: await g.confirm() }))).toBe('handoff_expired');
    expect(g.gateway.getHandoff('admin', PROJECT, late.id)!.state).toBe('expired');
    await g.close();

    g = await createGatewayStack();
    const s2 = await assistedScope(g, { maxInvocations: 3 });
    const h2 = await g.gateway.prepareHandoff('admin', handoffBody(g, s2.id));
    await g.gateway.releaseHandoff('admin', PROJECT, h2.id, await g.confirm());
    await g.gateway.revokeScope('admin', PROJECT, s2.id, await g.confirm());
    expect(g.gateway.getHandoff('admin', PROJECT, h2.id)!.state).toBe('revoked');
    expect(await codeOf(g.gateway.relayResult('admin', PROJECT, h2.id, { text: 'x', modelReported: null, confirm: await g.confirm() }))).toBe('invalid_transition');

    const s3 = await assistedScope(g, { taskId: TASK_B, dataRefs: [] });
    const h3 = await g.gateway.prepareHandoff('admin', handoffBody(g, s3.id, { taskId: TASK_B, inputs: [] }));
    await g.gateway.releaseHandoff('admin', PROJECT, h3.id, await g.confirm());
    await g.s.gate.engage({ kind: 'project', projectId: PROJECT }, 'emergency_stop');
    expect(await codeOf(g.gateway.relayResult('admin', PROJECT, h3.id, { text: 'x', modelReported: null, confirm: await g.confirm() }))).not.toBe('ok');
  });

  it('resultado trazido com segredo ou grande demais é recusado sem gravar; outro dono/projeto não alcança o handoff', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g, { maxOutputBytes: 64 });
    const handoff = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id, { maxOutputBytes: 64 }));
    await g.gateway.releaseHandoff('admin', PROJECT, handoff.id, await g.confirm());
    const fakeToken = ['ghp', 'A'.repeat(36)].join('_');
    expect(await codeOf(g.gateway.relayResult('admin', PROJECT, handoff.id, { text: `token ${fakeToken}`, modelReported: null, confirm: await g.confirm() }))).toBe('secret_detected');
    expect(await codeOf(g.gateway.relayResult('admin', PROJECT, handoff.id, { text: 'x'.repeat(65), modelReported: null, confirm: await g.confirm() }))).toBe('output_rejected');
    expect(g.store.body().contents.filter((c) => c.kind === 'relayed_result')).toHaveLength(0);
    expect(await codeOf(g.gateway.relayResult('admin', PROJECT_B, handoff.id, { text: 'x', modelReported: null, confirm: await g.confirm() }))).toBe('not_found');
    expect(await codeOf(g.gateway.releaseHandoff('outro', PROJECT, handoff.id, await g.confirm()))).toBe('identity_mismatch');
    expect(g.gateway.getHandoff('admin', PROJECT, handoff.id)!.state).toBe('awaiting_relay');
  });

  it('canal simulado não serve para handoff e vice-versa; nenhuma sessão, cookie ou token de assinatura é pedido', async () => {
    g = await createGatewayStack();
    const simulated = await g.activeScope();
    expect(await codeOf(g.gateway.prepareHandoff('admin', handoffBody(g, simulated.id)))).toBe('scope_exceeded');
    const assisted = await assistedScope(g, { taskId: TASK_B, dataRefs: [] });
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(assisted.id, { taskId: TASK_B, inputs: [] })))).toBe('scope_exceeded');
  });

  it('reinício: o handoff à espera sobrevive; a ingestão pode ser resubmetida sem duplicar o item', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g);
    const handoff = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    await g.gateway.releaseHandoff('admin', PROJECT, handoff.id, await g.confirm());
    await g.restartGateway({ queue: true });
    expect(g.gateway.getHandoff('admin', PROJECT, handoff.id)!.state).toBe('awaiting_relay');
    const relayed = await g.gateway.relayResult('admin', PROJECT, handoff.id, { text: 'depois do reinício', modelReported: null, confirm: await g.confirm() });
    const again = await g.gateway.retryIngest('admin', PROJECT, handoff.id);
    expect(again.ingestQueueItemId).toBe(relayed.ingestQueueItemId);
    expect(g.s.store.items().filter((i) => i.id === relayed.ingestQueueItemId)).toHaveLength(1);
    await g.cycle();
    expect(g.gateway.getHandoff('admin', PROJECT, handoff.id)!.state).toBe('validated');
  });

  it('pacote pode ser relido só com nova confirmação e dentro do escopo', async () => {
    g = await createGatewayStack();
    const scope = await assistedScope(g);
    const handoff = await g.gateway.prepareHandoff('admin', handoffBody(g, scope.id));
    const first = await g.gateway.releaseHandoff('admin', PROJECT, handoff.id, await g.confirm());
    expect(await g.gateway.readPackage('admin', PROJECT, handoff.id, await g.confirm())).toBe(first.package);
    g.s.advance(16 * 60 * 1000);
    expect(await codeOf(g.gateway.readPackage('admin', PROJECT, handoff.id, await g.confirm()))).toBe('scope_expired');
    expect(TASK).toBeDefined();
  });
});
