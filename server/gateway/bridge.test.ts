// @vitest-environment node
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeOf, conformingPr, createOrderStack, HEAD, PROJECT, REPO, TASK, type OrderStack } from '../test/claudeOrderFixtures.ts';
import { PROJECT_B } from '../test/gatewayFixtures.ts';
import { createBridgeOrders, type BridgeOrders } from './bridge.ts';
import { BRIDGE_LIMITS, BRIDGE_TOKEN, type GatewayBody } from './contracts.ts';
import { checkGatewayBody, checkGatewayChange } from './documents.ts';

/**
 * Issue #055 — ponte MCP local, núcleo (gateway + coordenador do agente), com a pilha REAL do gateway,
 * aprovações reais (#011) e GitHub falso. O agente recebe a ordem e PROPÕE o PR; só o PO vincula.
 */

let o: OrderStack | null = null;
const flag = { on: true };
afterEach(async () => {
  await o?.close();
  o = null;
  flag.on = true;
});
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
let keySeq = 0;
const key = (prefix = 'claim') => `${prefix}-${String(++keySeq).padStart(6, '0')}`;

async function stack(): Promise<{ s: OrderStack; bridge: BridgeOrders }> {
  o = await createOrderStack({ gateway: { bridgeEnabled: () => flag.on } });
  await o.enable();
  return { s: o, bridge: createBridgeOrders({ gateway: o.g.gateway, orders: o.orders }) };
}
async function credential(s: OrderStack, projectId = PROJECT, days = 30) {
  const created = await s.orders.createBridgeCredential('admin', projectId, days, await s.g.confirm());
  return { ...created, digest: sha(created.token) };
}
async function offered(s: OrderStack, overrides: Record<string, unknown> = {}) {
  const order = await s.create(overrides);
  await s.g.approveAll();
  await s.orders.offer('admin', order.projectId, order.orderId, await s.g.confirm());
  return s.orders.get('admin', order.projectId, order.orderId);
}
async function ledgerText(s: OrderStack): Promise<string> {
  const files = await readdir(s.g.dirs.gateway);
  return (await Promise.all(files.map((f) => readFile(join(s.g.dirs.gateway, f), 'utf8').catch(() => '')))).join('\n');
}

describe('fluxo pela ponte', () => {
  it('disponibilizar → listar → receber (atômico) → propor PR → o PO confirma (step-up) → vinculado e verificado', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    expect(cred.token).toMatch(BRIDGE_TOKEN);
    expect(cred.credential).toMatchObject({ state: 'active', agentId: 'claude-code', projectId: PROJECT });
    const order = await offered(s);
    expect(order.state).toBe('delivered');
    expect(order.bridge).toMatchObject({ claim: null, proposal: null, proposals: 0 });

    // O agente vê a ordem (sem pacote) e a recebe.
    const listed = bridge.list(cred.digest);
    expect(listed.orders).toEqual([expect.objectContaining({ orderId: order.orderId, repository: REPO, workBranch: order.workBranch, claimed: false, blocked: null })]);
    expect(JSON.stringify(listed)).not.toContain('INSTRUÇÕES FIXAS');
    const claimKey = key();
    const claimed = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey });
    expect(claimed.result.package).toContain(order.workBranch);
    expect(claimed.result.package).toContain('INSTRUÇÕES FIXAS DO ACC');
    expect(claimed.result.replay).toBe(false);
    const afterClaim = s.orders.get('admin', PROJECT, order.orderId);
    expect(afterClaim.state).toBe('awaiting_pr');
    expect(afterClaim.bridge!.claim).toMatchObject({ id: claimed.result.claimId, credentialId: cred.credential.id });

    // Perda da resposta: a MESMA chave devolve o MESMO recebimento (sem gravar outro).
    const again = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey });
    expect(again.result).toMatchObject({ claimId: claimed.result.claimId, replay: true, package: claimed.result.package });
    // Outra chave (mesma credencial) não recebe de novo.
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() }))).toBe('already_claimed');

    // PR PROPOSTO: nada é vinculado.
    const reportKey = key('report');
    const proposal = await bridge.report(cred.digest, { orderId: order.orderId, claimId: claimed.result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: reportKey });
    expect(proposal.result).toMatchObject({ pullRequest: `${REPO}#7`, status: 'awaiting_owner_confirmation', replay: false });
    const pending = s.orders.get('admin', PROJECT, order.orderId);
    expect(pending.pullRequest).toBeNull();
    expect(pending.state).toBe('awaiting_pr');
    expect(pending.bridge!.proposal).toMatchObject({ number: 7, status: 'pending' });
    expect(bridge.status(cred.digest, order.orderId)).toMatchObject({ state: 'awaiting_pr', pullRequest: null, proposal: { status: 'pending' }, verification: null });

    // O PO confirma (step-up): vínculo + verificação somente leitura na MESMA ação, presa ao HEAD lido.
    s.github.pr = conformingPr(order);
    const confirmed = await s.orders.confirmProposal('admin', PROJECT, order.orderId, proposal.result.proposalId, await s.g.confirm(), s.actor);
    expect(confirmed.verificationError).toBeNull();
    expect(confirmed.outcome).toMatchObject({ verdict: 'conforming', headSha: HEAD });
    expect(confirmed.order).toMatchObject({ state: 'verified', pullRequest: { number: 7 } });
    expect(confirmed.order.bridge!.proposal!.status).toBe('confirmed');
    expect(bridge.status(cred.digest, order.orderId)).toMatchObject({ state: 'verified', pullRequest: `${REPO}#7`, verification: { verdict: 'conforming', headSha: HEAD, current: true } });
    // Depois do vínculo, o agente não propõe outro PR.
    expect(await codeOf(bridge.report(cred.digest, { orderId: order.orderId, claimId: claimed.result.claimId, pullRequest: `${REPO}#8`, idempotencyKey: key('report') }))).toBe('pr_already_linked');

    // O token nunca é gravado (só o resumo).
    const ledger = await ledgerText(s);
    expect(ledger).not.toContain(cred.token);
    expect(ledger).not.toContain('accb_');
  });

  it('confirmação exige step-up e a proposta MAIS RECENTE; a verificação que falha não desfaz o vínculo', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const { result } = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() });
    const first = await bridge.report(cred.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') });
    const second = await bridge.report(cred.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#9`, idempotencyKey: key('report') });
    expect(await codeOf(s.orders.confirmProposal('admin', PROJECT, order.orderId, second.result.proposalId, { proofId: 'x', identity: { userId: 'admin', sessionKey: 'k' } }, s.actor))).toBe('identity_not_confirmed');
    expect(await codeOf(s.orders.confirmProposal('admin', PROJECT, order.orderId, first.result.proposalId, await s.g.confirm(), s.actor))).toBe('proposal_superseded');
    s.github.faults.push('unavailable');
    const confirmed = await s.orders.confirmProposal('admin', PROJECT, order.orderId, second.result.proposalId, await s.g.confirm(), s.actor);
    expect(confirmed.verificationError).toBe('github_unavailable');
    expect(confirmed.outcome).toBeNull();
    expect(confirmed.order).toMatchObject({ state: 'pr_linked', pullRequest: { number: 9 } });
  });
});

describe('desligada, credencial e configuração autorizada', () => {
  it('ponte desligada (padrão): credencial, disponibilização e toda operação do agente são recusadas', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    flag.on = false;
    expect(await codeOf(credential(s))).toBe('bridge_disabled');
    const other = await s.create({ taskId: TASK });
    await s.g.approveAll();
    expect(await codeOf(s.orders.offer('admin', PROJECT, other.orderId, await s.g.confirm()))).toBe('bridge_disabled');
    expect(await codeOf(Promise.resolve().then(() => bridge.authenticate(cred.digest)))).toBe('bridge_disabled');
    expect(await codeOf(Promise.resolve().then(() => bridge.list(cred.digest)))).toBe('bridge_disabled');
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() }))).toBe('bridge_disabled');
    // A revogação continua possível com a ponte desligada.
    expect((await s.orders.revokeBridgeCredential('admin', PROJECT, cred.credential.id, await s.g.confirm())).state).toBe('revoked');
  });

  it('criação: aprovação de configuração consumida (#011), validade 1–30 dias, projeto habilitado; rotação revoga a anterior', async () => {
    const { s } = await stack();
    expect(await codeOf(credential(s, PROJECT, 0))).toBe('invalid_request');
    expect(await codeOf(credential(s, PROJECT, 31))).toBe('invalid_request');
    expect(await codeOf(credential(s, PROJECT_B))).toBe('project_not_enabled');
    const first = await credential(s);
    const approvals = s.g.s.service.list('admin').filter((a) => a.binding.action === 'gateway.claude_bridge_credential');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ state: 'consumed', class: 'configuration', binding: { resource: { type: 'bridge_credential', id: first.credential.id } } });
    expect(JSON.stringify(approvals[0].presentation)).toContain(first.digest);
    expect(JSON.stringify(approvals[0])).not.toContain(first.token);
    const second = await credential(s);
    const list = s.g.gateway.bridgeCredentials('admin', PROJECT);
    expect(list.map((c) => [c.id, c.state, c.revokedReason])).toEqual([
      [first.credential.id, 'revoked', 'rotated'],
      [second.credential.id, 'active', null],
    ]);
    expect(await codeOf(Promise.resolve().then(() => s.g.gateway.bridgeAuthenticate(first.digest)))).toBe('bridge_unauthorized');
    expect(s.g.gateway.bridgeAuthenticate(second.digest)).toMatchObject({ credentialId: second.credential.id, projectId: PROJECT, agentId: 'claude-code' });
  });

  it('revogação e expiração valem na requisição seguinte; desabilitar o projeto revoga a credencial', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s, PROJECT, 1);
    const order = await offered(s);
    const claimKey = key();
    await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey });
    await s.orders.revokeBridgeCredential('admin', PROJECT, cred.credential.id, await s.g.confirm());
    // Revogada: nem a repetição do recebimento devolve o pacote.
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }))).toBe('bridge_unauthorized');
    expect(await codeOf(Promise.resolve().then(() => bridge.status(cred.digest, order.orderId)))).toBe('bridge_unauthorized');

    const fresh = await credential(s, PROJECT, 1);
    s.g.s.advance(DAY + MIN);
    expect(await codeOf(Promise.resolve().then(() => bridge.list(fresh.digest)))).toBe('bridge_unauthorized');
    expect(s.g.gateway.bridgeCredentials('admin', PROJECT).at(-1)!.state).toBe('expired');

    const third = await credential(s);
    await s.orders.disable('admin', PROJECT, await s.g.confirm());
    expect(s.g.gateway.bridgeCredentials('admin', PROJECT).at(-1)).toMatchObject({ id: third.credential.id, state: 'revoked', revokedReason: 'project_disabled' });
  });

  it('revogação enfileirada antes do recebimento: o pacote nunca é entregue', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const confirm = await s.g.confirm();
    const [revoked, claimed] = await Promise.allSettled([s.orders.revokeBridgeCredential('admin', PROJECT, cred.credential.id, confirm), bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() })]);
    expect(revoked.status).toBe('fulfilled');
    expect(claimed).toMatchObject({ status: 'rejected', reason: { code: 'bridge_unauthorized' } });
    expect(s.orders.get('admin', PROJECT, order.orderId).bridge!.claim).toBeNull();
  });
});

describe('exclusividade de canal e concorrência', () => {
  it('disponibilizada à ponte não sai pelo canal manual; liberada manualmente não vai para a ponte', async () => {
    const { s } = await stack();
    await credential(s);
    const viaBridge = await offered(s);
    expect(await codeOf(s.orders.release('admin', PROJECT, viaBridge.orderId, await s.g.confirm()))).toBe('delivery_channel_bridge');
    // Repetir a disponibilização não muda nada.
    expect((await s.orders.offer('admin', PROJECT, viaBridge.orderId, await s.g.confirm())).bridge!.offeredAt).toBe(viaBridge.bridge!.offeredAt);
    const { order: manual } = await s.released({ taskId: TASK });
    expect(await codeOf(s.orders.offer('admin', PROJECT, manual.orderId, await s.g.confirm()))).toBe('delivery_channel_manual');
    expect(s.orders.get('admin', PROJECT, manual.orderId).bridge).toBeNull();
  });

  it('manual × ponte ao mesmo tempo: exatamente um canal vence e o pacote sai uma única vez', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await s.create();
    await s.g.approveAll();
    const [a, b] = await Promise.allSettled([s.orders.offer('admin', PROJECT, order.orderId, await s.g.confirm()), s.orders.release('admin', PROJECT, order.orderId, await s.g.confirm())]);
    expect([a.status, b.status].filter((x) => x === 'fulfilled')).toHaveLength(1);
    const view = s.orders.get('admin', PROJECT, order.orderId);
    if (a.status === 'fulfilled') {
      expect(b).toMatchObject({ reason: { code: 'delivery_channel_bridge' } });
      expect(view.bridge).not.toBeNull();
    } else {
      expect(a).toMatchObject({ reason: { code: 'delivery_channel_manual' } });
      expect(view.bridge).toBeNull();
      expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() }))).toBe('not_found');
    }
  });

  it('recebimentos simultâneos com chaves diferentes: um recebe, o outro é recusado', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const results = await Promise.allSettled([bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() }), bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'already_claimed' } });
  });

  it('idempotência presa à credencial, à ordem e ao conteúdo: mesma chave com outro pedido → conflito', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const a = await offered(s);
    const b = await offered(s, { taskId: TASK });
    const shared = key();
    await bridge.claim(cred.digest, { orderId: a.orderId, idempotencyKey: shared });
    expect(await codeOf(bridge.claim(cred.digest, { orderId: b.orderId, idempotencyKey: shared }))).toBe('idempotency_conflict');
    const { result } = await bridge.claim(cred.digest, { orderId: b.orderId, idempotencyKey: key() });
    const reportKey = key('report');
    await bridge.report(cred.digest, { orderId: b.orderId, claimId: result.claimId, pullRequest: `${REPO}#3`, idempotencyKey: reportKey });
    expect((await bridge.report(cred.digest, { orderId: b.orderId, claimId: result.claimId, pullRequest: `${REPO}#3`, idempotencyKey: reportKey })).result.replay).toBe(true);
    expect(await codeOf(bridge.report(cred.digest, { orderId: b.orderId, claimId: result.claimId, pullRequest: `${REPO}#4`, idempotencyKey: reportKey }))).toBe('idempotency_conflict');
  });
});

describe('recuperação, prazos e gates em toda repetição', () => {
  it('falha de persistência ANTES do recebimento: nada gravado e nenhum pacote; depois do reinício, falha fechada (nova ordem)', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    s.g.faults.failWrite = () => true;
    const claimKey = key();
    const failed = await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }));
    expect(failed).not.toBe('ok');
    s.g.faults.failWrite = null;
    if (s.g.store.status().state === 'available') {
      // Armazenamento íntegro: a próxima tentativa recebe normalmente (nada foi gravado antes).
      expect((await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey })).result.replay).toBe(false);
      return;
    }
    // Armazenamento degradado → reinício: a nova época encerra a validade do escopo (nenhuma
    // autorização é renovada). Nada foi recebido, nenhum pacote sai, e a ordem pede nova aprovação.
    await s.g.restartGateway();
    const reopened = createBridgeOrders({ gateway: s.g.gateway, orders: s.orders });
    expect(s.g.gateway.orders('admin', PROJECT).find((r) => r.scope.code.orderId === order.orderId)!.deliveries.filter((d) => d.kind === 'claimed')).toEqual([]);
    expect(await codeOf(reopened.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }))).toBe('scope_expired');
  });

  it('perda da resposta DEPOIS do recebimento: a mesma chave devolve o mesmo recebimento; vencida a janela ou após reinício, nada sai', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const claimKey = key();
    const first = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey });
    s.g.s.advance(5 * MIN);
    const again = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey });
    expect(again.result).toMatchObject({ claimId: first.result.claimId, replay: true, package: first.result.package });
    // O recebimento é persistente (sobrevive ao reinício); a repetição não, porque a validade acabou.
    await s.g.restartGateway();
    const reopened = createBridgeOrders({ gateway: s.g.gateway, orders: s.orders });
    expect(s.g.gateway.orders('admin', PROJECT).find((r) => r.scope.code.orderId === order.orderId)!.deliveries.find((d) => d.kind === 'claimed')!.id).toBe(first.result.claimId);
    expect(await codeOf(reopened.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }))).toBe('scope_expired');
    s.g.s.advance(BRIDGE_LIMITS.claimReplayMs);
    expect(await codeOf(reopened.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }))).toBe('claim_replay_expired');
    // O PR ainda pode ser proposto pelo recebimento gravado (a janela do PR é de 24 h).
    expect((await reopened.report(cred.digest, { orderId: order.orderId, claimId: first.result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') })).result.status).toBe('awaiting_owner_confirmation');
  });

  it('sem recebimento dentro da validade do escopo (15 min) → janela encerrada; janela do PR (24 h) vencida → recusado', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const late = await offered(s);
    s.g.s.advance(16 * MIN);
    expect(await codeOf(bridge.claim(cred.digest, { orderId: late.orderId, idempotencyKey: key() }))).toBe('scope_expired');
    const order = await offered(s, { taskId: TASK });
    const { result } = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() });
    s.g.s.advance(DAY + MIN);
    const renewed = await credential(s);
    expect(await codeOf(bridge.report(renewed.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') }))).toBe('claim_invalid');
    expect(await codeOf(bridge.report(cred.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') }))).toBe('bridge_unauthorized');
  });

  it('cancelamento, barreira e kill switch: nenhum pacote devolvido, nem na repetição', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const claimKey = key();
    await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey });
    await s.g.s.gate.engage({ kind: 'project', projectId: PROJECT }, 'emergency_stop');
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }))).toBe('project_barrier');
    expect(bridge.list(cred.digest).orders[0].blocked).toBe('project_barrier');
    const { result } = { result: { claimId: s.orders.get('admin', PROJECT, order.orderId).bridge!.claim!.id } };
    expect(await codeOf(bridge.report(cred.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') }))).toBe('project_barrier');
    await s.orders.cancel('admin', PROJECT, order.orderId, await s.g.confirm());
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: claimKey }))).not.toBe('ok');
  });

  it('cancelada antes do recebimento: o agente não recebe nada e a ordem some da lista', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    await s.orders.cancel('admin', PROJECT, order.orderId, await s.g.confirm());
    expect(bridge.list(cred.digest).orders).toEqual([]);
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() }))).toBe('order_closed');
  });
});

describe('isolamento e validação do que vem do agente', () => {
  it('ordens de outro projeto, não disponibilizadas ou recebidas por outra credencial → invisíveis (not_found)', async () => {
    const { s, bridge } = await stack();
    await s.enable(PROJECT_B);
    const credA = await credential(s);
    const credB = await credential(s, PROJECT_B);
    const order = await offered(s);
    const notOffered = await s.create({ taskId: TASK });
    expect(bridge.list(credB.digest).orders).toEqual([]);
    expect(await codeOf(bridge.claim(credB.digest, { orderId: order.orderId, idempotencyKey: key() }))).toBe('not_found');
    expect(await codeOf(Promise.resolve().then(() => bridge.status(credB.digest, order.orderId)))).toBe('not_found');
    expect(await codeOf(bridge.claim(credA.digest, { orderId: notOffered.orderId, idempotencyKey: key() }))).toBe('not_found');
    const { result } = await bridge.claim(credA.digest, { orderId: order.orderId, idempotencyKey: key() });
    // Credencial nova (rotação) do MESMO projeto não vê a ordem recebida pela anterior.
    const rotated = await credential(s);
    expect(bridge.list(rotated.digest).orders).toEqual([]);
    expect(await codeOf(bridge.report(rotated.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') }))).toBe('claim_invalid');
    expect(await codeOf(Promise.resolve().then(() => bridge.status(rotated.digest, order.orderId)))).toBe('not_found');
    expect(await codeOf(Promise.resolve().then(() => bridge.list('0'.repeat(64))))).toBe('bridge_unauthorized');
    expect(await codeOf(Promise.resolve().then(() => bridge.list('não-é-resumo')))).toBe('bridge_unauthorized');
  });

  it('tarefa reatribuída a outro agente → recusado (política #020) em toda operação', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const taskKey = `${PROJECT}|${TASK}`;
    const task = s.g.s.fixtures.allTasks.get(taskKey)!;
    s.g.s.fixtures.allTasks.set(taskKey, { ...task, assignee: { kind: 'agent', agentId: 'chatgpt' } });
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() }))).toBe('agent_not_assigned');
    expect(bridge.list(cred.digest).orders[0].blocked).toBe('agent_not_assigned');
  });

  it('PR proposto: formato, repositório da ordem, recebimento da própria credencial, segredo e limite de propostas', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const { result } = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() });
    const report = (pullRequest: string, claimId = result.claimId) => bridge.report(cred.digest, { orderId: order.orderId, claimId, pullRequest, idempotencyKey: key('report') });
    expect(await codeOf(report('outro/repo#7'))).toBe('repository_not_allowed');
    // Referência de outro repositório só é recusada: a ordem continua aberta (o agente não decide o destino dela).
    expect(s.orders.get('admin', PROJECT, order.orderId).state).toBe('awaiting_pr');
    expect(await codeOf(report(`${REPO}#0`))).toBe('pr_reference_invalid');
    expect(await codeOf(report('https://github.com/x/y/pull/1'))).toBe('pr_reference_invalid');
    expect(await codeOf(report(`${REPO}#7`, '00000000-0000-4000-8000-000000000000'))).toBe('claim_invalid');
    expect(await codeOf(bridge.report(cred.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report'), extra: 1 }))).toBe('invalid_request');
    for (let n = 1; n <= BRIDGE_LIMITS.maxProposals; n += 1) await report(`${REPO}#${n}`);
    expect(await codeOf(report(`${REPO}#99`))).toBe('proposal_limit');
    // Repetir o MESMO número da proposta mais recente não gasta o limite.
    expect((await report(`${REPO}#${BRIDGE_LIMITS.maxProposals}`)).result.replay).toBe(true);
  });

  it('entrada do recebimento: campos extras, chave inválida ou id malformado → recusados sem gravar', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key(), projectId: PROJECT }))).toBe('invalid_request');
    expect(await codeOf(bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: 'curta' }))).toBe('invalid_request');
    expect(await codeOf(bridge.claim(cred.digest, { orderId: 'x', idempotencyKey: key() }))).toBe('not_found');
    expect(s.orders.get('admin', PROJECT, order.orderId).bridge!.claim).toBeNull();
  });
});

describe('ledger: validação estrita e somente de acréscimo', () => {
  it('recebimento sem disponibilização, proposta sem recebimento, validade > 30 dias e reescrita → recusados', async () => {
    const { s, bridge } = await stack();
    const cred = await credential(s);
    const order = await offered(s);
    const { result } = await bridge.claim(cred.digest, { orderId: order.orderId, idempotencyKey: key() });
    await bridge.report(cred.digest, { orderId: order.orderId, claimId: result.claimId, pullRequest: `${REPO}#7`, idempotencyKey: key('report') });
    const body = structuredClone(s.g.store.body()) as Required<GatewayBody>;
    expect(() => checkGatewayBody(structuredClone(body))).not.toThrow();
    const without = (mutate: (b: Required<GatewayBody>) => void) => {
      const copy = structuredClone(body);
      mutate(copy);
      return () => checkGatewayBody(copy);
    };
    expect(without((b) => b.orderDeliveries.splice(0, 1))).toThrow();
    expect(without((b) => b.orderDeliveries.splice(1, 1))).toThrow();
    expect(without((b) => (b.bridgeCredentials[0].expiresAt = new Date(Date.parse(b.bridgeCredentials[0].createdAt) + 31 * DAY).toISOString()))).toThrow();
    expect(without((b) => (b.bridgeCredentials[0].agentId = 'chatgpt' as 'claude-code'))).toThrow();
    expect(without((b) => b.bridgeRevocations.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownerId: 'admin', credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', at: b.bridgeCredentials[0].createdAt, by: 'admin', reason: 'x' }))).toThrow();
    // Somente de acréscimo: reescrever ou remover uma entrega/proposta é recusado.
    const rewritten = structuredClone(body);
    rewritten.prProposals[0].prNumber = 8;
    expect(() => checkGatewayChange(body, rewritten)).toThrow();
    const removed = structuredClone(body);
    removed.orderDeliveries.pop();
    expect(() => checkGatewayChange(body, removed)).toThrow();
  });
});
