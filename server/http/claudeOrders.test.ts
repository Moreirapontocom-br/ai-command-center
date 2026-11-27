// @vitest-environment node
/**
 * Issue #008 (PR 2): rotas HTTP das ordens do Claude Code, de ponta a ponta no servidor real —
 * sessão, CSRF, política, confirmação de identidade (uso único), isolamento por projeto, pacote só na
 * liberação, verificação somente leitura, espelho na auditoria (#006) e ausência de vazamentos.
 * O GitHub é FALSO (memória); nenhuma chamada a provedor de IA. Pilha em `server/test/claudeHttpFixtures.ts`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bindingDigest, paramsDigestOf } from '../approvals/binding.ts';
import type { ApprovalBinding } from '../approvals/contracts.ts';
import type { IdentityContext } from '../approvals/identity.ts';
import { TEST_ADMIN_PASSWORD } from '../test/authFixtures.ts';
import { conformingPr } from '../test/claudeOrderFixtures.ts';
import { createBody, createPath, enable, ordersPath, REPO, startApp, VERSION } from '../test/claudeHttpFixtures.ts';

describe('rotas das ordens do Claude Code', () => {
  it('fluxo completo pela API: habilitar → criar → aprovar → pacote → encaminhado → PR → verificar', async () => {
    const app = await startApp();
    const cookie = await app.login();
    const empty = await app.get(ordersPath(app), cookie);
    expect(empty.status).toBe(200);
    expect(empty.json()).toMatchObject({ gateway: { state: 'available' }, enablement: { enabled: false }, linkableRepositories: [REPO], orders: [] });
    expect((await app.post(createPath(app), createBody(), cookie)).json().error.code).toBe('project_not_enabled');
    await enable(app, cookie);
    const created = await app.post(createPath(app), createBody(), cookie);
    expect(created.status).toBe(201);
    const order = created.json().order;
    expect(order).toMatchObject({ state: 'awaiting_approval', repository: REPO, agentId: 'claude-code' });
    await app.approveAll(cookie);
    // Liberação: `/package` (a rota `/release` não existe: teste estrutural proíbe `release` em POST).
    expect((await app.post(`/api/claude-orders/${order.orderId}/release`, { proofId: 'x' }, cookie)).status).toBe(405);
    const released = await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: await app.proofId(cookie) }, cookie);
    expect(released.status).toBe(200);
    expect(released.json().package).toContain(order.workBranch);
    // A listagem nunca devolve o pacote nem o objetivo.
    const listed = await app.get(ordersPath(app), cookie);
    expect(listed.body).not.toContain('Trabalhe SOMENTE');
    expect(listed.body).not.toContain('Implementar X.');
    expect((await app.post(`/api/claude-orders/${order.orderId}/forwarded`, {}, cookie)).json().order.state).toBe('awaiting_pr');
    app.github.pr = conformingPr(order);
    const linked = await app.post(`/api/claude-orders/${order.orderId}/pr`, { pullRequest: `${REPO}#7`, proofId: await app.proofId(cookie) }, cookie);
    expect(linked.status).toBe(200);
    const verified = await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie);
    expect(verified.status).toBe(200);
    expect(verified.json()).toMatchObject({ order: { state: 'verified' }, outcome: { verdict: 'conforming', created: true } });
    // Espelho na auditoria da #006 (sem conteúdo).
    const events = (await app.get('/api/audit?limit=200', cookie)).json().events as Array<{ action: string; outcome: string; context: Record<string, unknown> }>;
    const actions = events.map((e) => e.action);
    for (const action of ['claude_project.enablement', 'claude_order.requested', 'claude_order.package_released', 'claude_order.forwarded', 'claude_order.pr_linked', 'claude_order.verified']) expect(actions).toContain(action);
    expect(events.find((e) => e.action === 'claude_order.verified')!.context).toMatchObject({ verdict: 'conforming', seq: 1 });
    expect(JSON.stringify(events)).not.toMatch(/Implementar X|Trabalhe SOMENTE|SENHACANARIA/);
    expect(app.logLines.join('\n')).not.toMatch(/Implementar X|Trabalhe SOMENTE|SENHACANARIA/);
    // Verificação muito próxima → 429 com Retry-After.
    const soon = await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie);
    expect(soon.status).toBe(429);
    expect(soon.headers['retry-after']).toBe('30');
  });

  it('CSRF, sessão e método: recusados antes de qualquer efeito', async () => {
    const app = await startApp();
    const cookie = await app.login();
    expect((await app.post(createPath(app), createBody(), cookie, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await app.post(createPath(app), createBody(), cookie, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await app.post(createPath(app), createBody(), cookie, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await app.post(createPath(app), createBody(), null)).status).toBe(401);
    expect((await app.get(ordersPath(app), null)).status).toBe(401);
    expect((await app.get(createPath(app), cookie)).status).toBe(405);
    expect(app.service.list('admin').filter((a) => a.binding.resource.type === 'gateway_scope')).toHaveLength(0);
  });

  it('corpos fechados: dono, repositório, branch, SHA, capacidade ou agente vindos do cliente → 400', async () => {
    const app = await startApp();
    const cookie = await app.login();
    await enable(app, cookie);
    for (const extra of [{ ownerId: 'x' }, { repository: 'outro/repo' }, { workBranch: 'main' }, { baseSha: 'a'.repeat(40) }, { capability: 'code.change' }, { agentId: 'chatgpt' }, { scopeId: app.task.id }]) {
      expect((await app.post(createPath(app), createBody(extra), cookie)).status).toBe(400);
    }
    // Referência a tarefa de outro projeto ou de outro tipo → 400.
    expect((await app.post(createPath(app), createBody({ dataRefs: [{ kind: 'issue', ref: '#1' }] }), cookie)).status).toBe(400);
    expect((await app.post(createPath(app), createBody({ dataRefs: [{ kind: 'task', ref: '00000000-0000-4000-8000-000000000000' }] }), cookie)).status).toBe(400);
    // Tarefa de outro agente → política (403).
    expect((await app.post(createPath(app, app.gptTask.id), createBody(), cookie)).json().error.code).toBe('policy_denied');
    // Segredo no objetivo → 422 sem gravar.
    const token = ['ghp', 'Z'.repeat(36)].join('_');
    expect((await app.post(createPath(app), createBody({ objective: `token ${token}` }), cookie)).json().error.code).toBe('secret_detected');
  });

  it('step-up obrigatório para pacote, PR, cancelamento e habilitação; prova reutilizada é recusada', async () => {
    const app = await startApp();
    const cookie = await app.login();
    expect((await app.post(`/api/projects/${app.project.id}/claude-enablement`, { enabled: true, repository: REPO, proofId: 'invalida' }, cookie)).json().error.code).toBe('confirmation_required');
    await enable(app, cookie);
    const order = (await app.post(createPath(app), createBody(), cookie)).json().order;
    await app.approveAll(cookie);
    expect((await app.post(`/api/claude-orders/${order.orderId}/package`, {}, cookie)).status).toBe(400);
    expect((await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: 'nao-existe' }, cookie)).json().error.code).toBe('confirmation_required');
    const proof = await app.proofId(cookie);
    expect((await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: proof }, cookie)).status).toBe(200);
    expect((await app.post(`/api/claude-orders/${order.orderId}/pr`, { pullRequest: `${REPO}#7`, proofId: proof }, cookie)).json().error.code).toBe('confirmation_required');
    expect((await app.post(`/api/claude-orders/${order.orderId}/cancel`, {}, cookie)).status).toBe(400);
    expect((await app.post(`/api/claude-orders/${order.orderId}/cancel`, { proofId: await app.proofId(cookie) }, cookie)).json().order.state).toBe('cancelled');
  });

  it('isolamento: habilitar um projeto não habilita outro; ordem inexistente/alheia → 404', async () => {
    const app = await startApp();
    const cookie = await app.login();
    await enable(app, cookie);
    const otherTask = await (async () => (await app.post(`/api/projects/${app.other.id}/tasks`, { title: 'T', description: '', priority: 'medium', assignee: { kind: 'agent', agentId: 'claude-code' } }, cookie)).json())();
    expect((await app.post(createPath(app, otherTask.id, app.other.id), createBody(), cookie)).json().error.code).toBe('project_not_enabled');
    expect((await app.get(ordersPath(app, app.other.id), cookie)).json().enablement.enabled).toBe(false);
    expect((await app.post(`/api/claude-orders/00000000-0000-4000-8000-000000000000/verify`, {}, cookie)).status).toBe(404);
    expect((await app.post(`/api/claude-orders/nao-uuid/verify`, {}, cookie)).status).toBe(404);
    // Repositório fora do projeto/allowlist na habilitação → 422.
    expect((await app.post(`/api/projects/${app.project.id}/claude-enablement`, { enabled: true, repository: 'outro/repo', proofId: await app.proofId(cookie) }, cookie)).json().error.code).toBe('repository_not_allowed');
  });

  it('barreira global ativa (instalação nova, #011 N9): nada é criado — 423, com o restante do ACC funcionando', async () => {
    const app = await startApp({ barrier: true });
    const cookie = await app.login();
    // Habilitar é configuração (não barrada pela barreira).
    await enable(app, cookie);
    const reply = await app.post(createPath(app), createBody(), cookie);
    expect(reply.status).toBe(423);
    expect(reply.json().error.code).toBe('approval_blocked');
    expect((await app.get('/api/projects', cookie)).status).toBe(200);
  });

  it('revisão P1: a barreira só sai pelo mecanismo da #011 (killswitch.release confirmada pelo PO); não há rota de liberação', async () => {
    const app = await startApp({ barrier: true });
    const cookie = await app.login();
    await enable(app, cookie);
    expect((await app.post(createPath(app), createBody(), cookie)).status).toBe(423);
    // Nenhuma rota libera a barreira (N9): caminhos plausíveis não existem ou não aceitam POST.
    for (const path of ['/api/approvals/barrier/release', '/api/approvals/killswitch/release', '/api/killswitch/release', '/api/claude-orders/barrier', `/api/projects/${app.project.id}/claude-enablement/release`]) {
      expect([404, 405]).toContain((await app.post(path, { proofId: await app.proofId(cookie) }, cookie)).status);
    }
    expect(app.service.barriers().durable.global).not.toBeNull();
    // Mecanismo interno sem aprovação válida → recusado; a barreira continua.
    await expect(app.service.releaseBarrier({ attemptId: '00000000-0000-4000-8000-000000000000' })).rejects.toBeTruthy();
    const ctx: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('p1-release').digest('hex') };
    const binding: ApprovalBinding = { action: 'killswitch.release', projectId: null, resource: { type: 'killswitch', id: 'global' }, target: { sha: null, ref: null }, subject: { kind: 'human', id: 'admin' }, paramsDigest: paramsDigestOf('killswitch.release', { scope: 'global' }), policyVersion: VERSION };
    // Agente como sujeito, ou prova de identidade inválida → recusado.
    const agentBinding = { ...binding, subject: { kind: 'agent', id: 'claude-code' } } as unknown as ApprovalBinding;
    await expect(app.service.confirmOwner({ ownerId: 'admin', binding: agentBinding, bindingDigest: bindingDigest(agentBinding), proofId: (await app.identity.confirm(ctx, 'password', TEST_ADMIN_PASSWORD)).proofId, identity: ctx })).rejects.toBeTruthy();
    await expect(app.service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: 'prova-forjada', identity: ctx })).rejects.toBeTruthy();
    expect(app.service.barriers().durable.global).not.toBeNull();
    expect((await app.post(createPath(app), createBody(), cookie)).status).toBe(423);
    // Desbloqueio supervisionado (proposta, docs §P1): confirmação de identidade + aprovação de
    // configuração exata, de uso único, reservada pelo núcleo e auditada.
    const release = await app.service.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: (await app.identity.confirm(ctx, 'password', TEST_ADMIN_PASSWORD)).proofId, identity: ctx });
    const reservation = await app.service.reserve({ ownerId: 'admin', approvalId: release.id, component: 'approvals', binding });
    await app.service.releaseBarrier({ attemptId: reservation.attemptId });
    await expect(app.service.releaseBarrier({ attemptId: reservation.attemptId })).rejects.toBeTruthy(); // uso único
    expect(app.service.barriers().durable.global).toBeNull();
    const released = app.service.history().items.filter((e) => 'event' in e && e.event === 'approval.barrier_released');
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ actor: { kind: 'human', id: 'admin' }, reason: 'human_approved' });
    // Liberada a barreira, a criação segue exigindo as duas aprovações por ordem (nada é aprovado junto).
    const created = await app.post(createPath(app), createBody(), cookie);
    expect(created.status).toBe(201);
    expect(created.json().order.state).toBe('awaiting_approval');
    expect(app.service.list('admin').filter((a) => a.state === 'pending').map((a) => a.binding.action).sort()).toEqual(['agent.invoke', 'data.send_external']);
    // Barreira acionada de novo → bloqueia outra vez (fail-closed).
    await app.service.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'human', id: 'admin' }, reason: 'manual' });
    expect((await app.post(createPath(app), createBody(), cookie)).status).toBe(423);
  });

  it('sem gateway configurado: listagem informa indisponível; escritas → 503', async () => {
    const app = await startApp({ gateway: false });
    const cookie = await app.login();
    expect((await app.get(ordersPath(app), cookie)).json()).toMatchObject({ gateway: { state: 'unavailable', reason: 'not_configured' }, orders: [] });
    expect((await app.post(createPath(app), createBody(), cookie)).json().error.code).toBe('gateway_unavailable');
  });

  it('GitHub indisponível ou HEAD alterado: erro explícito, nada gravado', async () => {
    const app = await startApp();
    const cookie = await app.login();
    await enable(app, cookie);
    const order = (await app.post(createPath(app), createBody(), cookie)).json().order;
    await app.approveAll(cookie);
    await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: await app.proofId(cookie) }, cookie);
    app.github.pr = conformingPr(order);
    await app.post(`/api/claude-orders/${order.orderId}/pr`, { pullRequest: `${REPO}#7`, proofId: await app.proofId(cookie) }, cookie);
    app.github.faults.push('unavailable');
    const down = await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie);
    expect(down.status).toBe(503);
    expect(down.json().error.code).toBe('github_unavailable');
    app.advance(31_000);
    app.github.onPullRequest = (call) => {
      if (call === 2) app.github.pr = { ...app.github.pr!, headRefOid: 'c'.repeat(40), lastCommit: { ...app.github.pr!.lastCommit!, oid: 'c'.repeat(40) } };
    };
    expect((await app.post(`/api/claude-orders/${order.orderId}/verify`, {}, cookie)).json().error.code).toBe('head_changed');
    expect((await app.get(ordersPath(app), cookie)).json().orders[0].history).toEqual([]);
  });
});
