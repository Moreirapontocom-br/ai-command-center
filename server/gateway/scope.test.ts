// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { createGatewayStack, PROJECT, PROJECT_B, TASK, TASK_B, type GatewayStack } from '../test/gatewayFixtures.ts';

/** I1 — escopo por tarefa a partir de uma aprovação autêntica e de uso único da #011. */

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

describe('escopo por tarefa (I1)', () => {
  it('pedido registra o escopo e a aprovação com a apresentação de TODOS os limites; nada é usável antes de ativar', async () => {
    g = await createGatewayStack();
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    expect(scope.state).toBe('awaiting_approval');
    expect(scope.validUntil).toBeNull();
    const pending = g.s.service.list('admin').filter((a) => a.state === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].binding).toMatchObject({ action: 'agent.invoke', resource: { type: 'gateway_scope', id: scope.id }, subject: { kind: 'agent', id: 'claude-code' }, paramsDigest: scope.paramsDigest });
    expect(pending[0].presentation).toMatchObject({ kind: 'gateway.scope', params: { scopeId: scope.id, maxInvocations: 3, budgetMinor: 0, externalSharing: false } });
    // Sem ativação, invocar é recusado.
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).toBe('scope_not_active');
  });

  it('aprovação pendente: ativar é recusado sem consumir nada; aprovada: consome UMA vez e ativa', async () => {
    g = await createGatewayStack();
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('approval_pending');
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).toBe('awaiting_approval');
    await g.approveAll();
    const active = await g.gateway.activateScope('admin', PROJECT, scope.id);
    expect(active.state).toBe('active');
    expect(active.approvals).toHaveLength(1);
    const approval = g.s.service.get('admin', active.approvals[0].approvalId)!;
    expect(approval.state).toBe('consumed');
    expect(g.s.service.attemptsOf('admin', approval.id).map((t) => [t.component, t.state])).toEqual([['gateway', 'succeeded']]);
    // Validade nunca além da aprovação original (60 min da classe `execution`).
    expect(Date.parse(active.validUntil!)).toBeLessThanOrEqual(Date.parse(approval.validUntil!));
    // Replay: ativar de novo não reutiliza a aprovação.
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('invalid_transition');
  });

  it('canal assistido exige DUAS aprovações (agent.invoke + data.send_external) e vale no máximo o TTL de publicação (15 min)', async () => {
    g = await createGatewayStack();
    const scope = await g.gateway.requestScope('admin', g.scopeBody({ channel: 'assisted', validitySeconds: 3600 }));
    const pending = g.s.service.list('admin').filter((a) => a.state === 'pending');
    expect(pending.map((a) => a.binding.action).sort()).toEqual(['agent.invoke', 'data.send_external']);
    await g.approveAll();
    const active = await g.gateway.activateScope('admin', PROJECT, scope.id);
    expect(active.approvals.map((a) => a.action)).toEqual(['agent.invoke', 'data.send_external']);
    const at = g.s.h.clock.now;
    expect(Date.parse(active.validUntil!) - at).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('aprovação rejeitada: nada é consumido e ativar só abre um pedido NOVO; ativações concorrentes consomem no máximo uma vez', async () => {
    g = await createGatewayStack();
    const rejected = await g.gateway.requestScope('admin', g.scopeBody());
    await g.s.rejectAll();
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, rejected.id))).toBe('approval_pending');
    expect(g.gateway.getScope('admin', PROJECT, rejected.id)!.state).toBe('awaiting_approval');
    const forScope = g.s.service.list('admin').filter((a) => a.binding.resource.id === rejected.id);
    expect(forScope.map((a) => a.state).sort()).toEqual(['pending', 'rejected']);
    await g.s.rejectAll();

    const scope = await g.gateway.requestScope('admin', g.scopeBody({ taskId: TASK_B }));
    await g.approveAll();
    const results = await Promise.all([1, 2, 3].map(() => codeOf(g!.gateway.activateScope('admin', PROJECT, scope.id))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    const consumed = g.s.service.list('admin').filter((a) => a.binding.resource.id === scope.id);
    expect(consumed).toHaveLength(1);
    expect(g.s.service.attemptsOf('admin', consumed[0].id)).toHaveLength(1);
  });

  it('aprovação forjada ou de outro componente nunca ativa: o verificador só aceita recibos do componente gateway', async () => {
    g = await createGatewayStack({
      gateway: {
        // Verificador que aceitaria qualquer coisa NÃO é o confiável: aqui, um verificador "de outro componente".
        approvalVerifier: { id: 'acc-approvals:sandbox', kind: 'trusted', verifyGrant: (grant) => g!.s.service.verifierFor('sandbox').verifyGrant(grant) },
      },
    });
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    await g.approveAll();
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('approval_not_authentic');
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).toBe('failed');
    // A aprovação continua consumida (sem reutilização) e a tentativa registrada como falha.
    const approval = g.s.service.list('admin').find((a) => a.binding.resource.id === scope.id)!;
    expect(approval.state).toBe('consumed');
    expect(g.s.service.attemptsOf('admin', approval.id)[0].state).toBe('failed');
  });

  it('sem verificador ou sem núcleo de aprovações: negado (fail-closed)', async () => {
    g = await createGatewayStack({ gateway: { approvalVerifier: undefined } });
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    await g.approveAll();
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('approval_verifier_unavailable');
    await g.close();
    g = await createGatewayStack({ gateway: { approvals: undefined } });
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody()))).toBe('approvals_unavailable');
  });

  it('aprovação expirada (TTL da #011) não ativa nem vira autorização', async () => {
    g = await createGatewayStack();
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    await g.approveAll();
    g.s.advance(61 * 60 * 1000);
    // A aprovação vencida não é consumida: o pedido volta a ficar pendente (nova decisão do PO).
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('approval_pending');
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).toBe('awaiting_approval');
    const states = g.s.service.list('admin').filter((a) => a.binding.resource.id === scope.id).map((a) => a.state).sort();
    expect(states).toEqual(['expired', 'pending']);
    expect(states).not.toContain('consumed');
  });

  it('o escopo expira com o tempo; validade monotônica e versão da política conferidas a cada uso', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope({ validitySeconds: 120 });
    g.s.advance(121 * 1000);
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).toBe('scope_expired');
    const swept = await g.gateway.sweep();
    expect(swept.expiredScopes).toBe(1);
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).toBe('expired');
    expect(DEFAULT_POLICY.version).toBe(scope.policyVersion);
  });

  it('revogação exige confirmação de identidade do dono e encerra o escopo', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope();
    expect(await codeOf(g.gateway.revokeScope('admin', PROJECT, scope.id, { proofId: 'x', identity: { userId: 'admin', sessionKey: 'y' } }))).toBe('identity_not_confirmed');
    expect(await codeOf(g.gateway.revokeScope('admin', PROJECT, scope.id, { ...(await g.confirm()), identity: { userId: 'chatgpt', sessionKey: 'z' } }))).toBe('identity_not_confirmed');
    const revoked = await g.gateway.revokeScope('admin', PROJECT, scope.id, await g.confirm());
    expect(revoked.state).toBe('revoked');
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).toBe('scope_revoked');
  });

  it('kill switch/barreira: recusa pedidos e revoga os escopos do projeto', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope();
    await g.s.gate.engage({ kind: 'project', projectId: PROJECT }, 'emergency_stop');
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).not.toBe('ok');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ taskId: TASK_B })))).not.toBe('ok');
    expect(await g.gateway.engageKillSwitch({ kind: 'project', projectId: PROJECT }, 'emergency_stop')).toEqual([scope.id]);
    expect(g.gateway.getScope('admin', PROJECT, scope.id)!.state).toBe('revoked');
  });

  it('reinício DURANTE a ativação: a intenção vira `failed` e a aprovação consumida nunca vira escopo', async () => {
    g = await createGatewayStack({
      gateway: {
        approvalVerifier: {
          id: 'acc-approvals:gateway',
          kind: 'trusted',
          verifyGrant: () => {
            throw new Error('queda simulada');
          },
        },
      },
    });
    const scope = await g.gateway.requestScope('admin', g.scopeBody());
    await g.approveAll();
    // Grava `activating` à mão (como se o processo caísse depois da intenção) e reinicia.
    await g.store.commit((tx) => {
      const s = tx.body.scopes.find((x) => x.id === scope.id)!;
      Object.assign(s, { state: 'activating', reason: 'activation_in_progress' });
    });
    await g.restartGateway();
    const after = g.gateway.getScope('admin', PROJECT, scope.id)!;
    expect(after.state).toBe('failed');
    expect(after.reason).toBe('activation_interrupted');
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT, scope.id))).toBe('invalid_transition');
  });

  it('isolamento: outro dono/projeto é indistinguível de inexistente; agente não atribuído é negado', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope();
    expect(g.gateway.getScope('admin', PROJECT_B, scope.id)).toBeNull();
    expect(g.gateway.getScope('outro', PROJECT, scope.id)).toBeNull();
    expect(await codeOf(g.gateway.activateScope('admin', PROJECT_B, scope.id))).toBe('not_found');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ agentIds: ['chatgpt'] })))).toBe('agent_not_assigned');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ taskId: TASK, projectId: PROJECT_B, agentIds: ['gemini'] })))).toBe('agent_not_assigned');
  });

  it('formato fechado; API cobrada bloqueada com orçamento R$ 0', async () => {
    g = await createGatewayStack();
    expect(await codeOf(g.gateway.requestScope('admin', { ...g.scopeBody(), extra: 1 }))).toBe('invalid_request');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ agentIds: ['claude-code', 'chatgpt'] })))).toBe('invalid_request');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ budgetMinor: 100 })))).toBe('invalid_request');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ mode: 'metered_api', budgetMinor: 100 })))).toBe('paid_usage_unavailable');
    expect(await codeOf(g.gateway.requestScope('admin', g.scopeBody({ validitySeconds: 99_999 })))).toBe('invalid_request');
  });
});
