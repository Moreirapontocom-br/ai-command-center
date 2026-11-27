// @vitest-environment node
/**
 * Issue #055 — endpoint MCP local (`POST /mcp`) de ponta a ponta no servidor REAL: pipeline próprio
 * (método, Host, Origin, tipo, autenticação pela credencial da ponte, limites), SDK oficial do MCP
 * em modo sem estado, ferramentas e prompt, espelho na auditoria (#006) e ausência de vazamentos.
 * O GitHub é FALSO (memória); nenhuma chamada a provedor de IA.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRIDGE_LIMITS } from '../gateway/contracts.ts';
import { conformingPr } from '../test/claudeOrderFixtures.ts';
import { createBody, createPath, enable, ordersPath, REPO, startApp, type App } from '../test/claudeHttpFixtures.ts';

const PROTOCOL = '2025-06-18';
let rpcId = 0;

async function bridgeApp(options: { bridge?: boolean } = {}) {
  const app = await startApp({ bridge: options.bridge ?? true });
  const cookie = await app.login();
  await enable(app, cookie);
  return { app, cookie };
}
async function newCredential(app: App, cookie: string, validityDays = 30) {
  const reply = await app.post(`/api/projects/${app.project.id}/claude-bridge/credentials`, { validityDays, proofId: await app.proofId(cookie) }, cookie);
  expect(reply.status).toBe(201);
  return reply.json() as { credential: { id: string; state: string }; token: string; command: string };
}
async function offeredOrder(app: App, cookie: string) {
  const created = await app.post(createPath(app), createBody(), cookie);
  expect(created.status).toBe(201);
  const order = created.json().order;
  await app.approveAll(cookie);
  const offered = await app.post(`/api/claude-orders/${order.orderId}/offer`, { proofId: await app.proofId(cookie) }, cookie);
  expect(offered.status).toBe(200);
  return offered.json().order as { orderId: string; workBranch: string; state: string; bridge: unknown };
}
const mcpHeaders = (token: string | null, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': PROTOCOL,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});
function rpc(app: App, token: string | null, method: string, params: unknown = {}, extra: Record<string, string> = {}) {
  return app.call('/mcp', { method: 'POST', headers: mcpHeaders(token, extra), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
}
async function tool(app: App, token: string, name: string, args: Record<string, unknown> = {}) {
  const reply = await rpc(app, token, 'tools/call', { name, arguments: args });
  expect(reply.status).toBe(200);
  const result = reply.json().result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: result.isError === true, data: JSON.parse(result.content[0].text), extra: result.content.slice(1).map((c) => c.text), raw: reply.body };
}

describe('ponte MCP: fluxo completo pelo cliente MCP', () => {
  it('initialize → tools/list → prompt next → listar → receber → propor PR → PO confirma (step-up) → situação verificada', async () => {
    const { app, cookie } = await bridgeApp();
    const { token, command, credential } = await newCredential(app, cookie);
    expect(command).toBe(`claude mcp add --transport http --scope local acc http://127.0.0.1:${app.port}/mcp --header "Authorization: Bearer ${token}"`);
    const order = await offeredOrder(app, cookie);

    const init = await rpc(app, token, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
    expect(init.status).toBe(200);
    expect(init.json().result).toMatchObject({ protocolVersion: PROTOCOL, serverInfo: { name: 'acc-bridge' } });
    expect(init.headers['mcp-session-id']).toBeUndefined();
    const notified = await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(notified.status).toBe(202);
    expect(notified.body).toBe('');
    const tools = (await rpc(app, token, 'tools/list')).json().result.tools as Array<{ name: string; inputSchema: { additionalProperties: boolean } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(['acc_claim_order', 'acc_get_order_status', 'acc_list_orders', 'acc_report_pr']);
    expect(tools.every((t) => t.inputSchema.additionalProperties === false)).toBe(true);
    const prompts = (await rpc(app, token, 'prompts/list')).json().result.prompts as Array<{ name: string }>;
    expect(prompts.map((p) => p.name)).toEqual(['next']);
    expect((await rpc(app, token, 'prompts/get', { name: 'next' })).json().result.messages[0].content.text).toContain('acc_list_orders');
    // Nada além do necessário: sem recursos, sem SSE, sem sessão.
    expect((await rpc(app, token, 'resources/list')).json().error.code).toBe(-32601);

    const listed = await tool(app, token, 'acc_list_orders');
    expect(listed.data.orders).toEqual([expect.objectContaining({ orderId: order.orderId, claimed: false, repository: REPO })]);
    expect(listed.raw).not.toContain('INSTRUÇÕES FIXAS');
    const claimed = await tool(app, token, 'acc_claim_order', { orderId: order.orderId, idempotencyKey: 'claim-http-000001' });
    expect(claimed.isError).toBe(false);
    expect(claimed.data).toMatchObject({ replay: false, order: { orderId: order.orderId, workBranch: order.workBranch } });
    expect(claimed.extra[0]).toContain('INSTRUÇÕES FIXAS DO ACC');
    expect(claimed.data.package).toBeUndefined();

    const reported = await tool(app, token, 'acc_report_pr', { orderId: order.orderId, claimId: claimed.data.claimId, pullRequest: `${REPO}#7`, idempotencyKey: 'report-http-00001' });
    expect(reported.data).toMatchObject({ status: 'awaiting_owner_confirmation', pullRequest: `${REPO}#7` });
    const beforeConfirm = (await app.get(ordersPath(app), cookie)).json().orders[0];
    expect(beforeConfirm).toMatchObject({ pullRequest: null, bridge: { proposal: { number: 7, status: 'pending' }, claim: { id: claimed.data.claimId } } });

    // O PO confirma com step-up: vínculo + verificação somente leitura na mesma ação.
    app.github.pr = conformingPr(order);
    expect((await app.post(`/api/claude-orders/${order.orderId}/confirm-pr`, { proposalId: reported.data.proposalId, proofId: 'reutilizada' }, cookie)).status).not.toBe(200);
    const confirmed = await app.post(`/api/claude-orders/${order.orderId}/confirm-pr`, { proposalId: reported.data.proposalId, proofId: await app.proofId(cookie) }, cookie);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json()).toMatchObject({ verificationError: null, outcome: { verdict: 'conforming' }, order: { state: 'verified', pullRequest: { number: 7 } } });
    const status = await tool(app, token, 'acc_get_order_status', { orderId: order.orderId });
    expect(status.data).toMatchObject({ state: 'verified', pullRequest: `${REPO}#7`, verification: { verdict: 'conforming', current: true } });

    // Auditoria (#006): o agente aparece como agente; credencial só pelo id; nunca token nem pacote.
    const auditText = await readFile(join(app.root, 'data', 'audit.json'), 'utf8');
    const events = JSON.parse(auditText).events as Array<{ action: string; actor: { kind: string; id: string }; context: Record<string, unknown> }>;
    expect(events.find((e) => e.action === 'claude_order.claimed')).toMatchObject({ actor: { kind: 'agent', id: 'claude-code' }, context: { credential: credential.id, replay: false } });
    expect(events.find((e) => e.action === 'claude_order.pr_proposed')).toMatchObject({ actor: { kind: 'agent', id: 'claude-code' } });
    expect(events.find((e) => e.action === 'claude_order.offered')).toMatchObject({ actor: { kind: 'human', id: 'admin' } });
    expect(events.find((e) => e.action === 'claude_bridge.credential')).toMatchObject({ context: { to: 'created' } });
    for (const text of [auditText, app.logLines.join('\n')]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain('accb_');
      expect(text).not.toContain('INSTRUÇÕES FIXAS');
    }
    // A listagem do PO nunca devolve o token.
    const list = await app.get(ordersPath(app), cookie);
    expect(list.json().bridge).toMatchObject({ enabled: true, endpoint: `http://127.0.0.1:${app.port}/mcp`, credential: { id: credential.id, state: 'active' } });
    expect(list.body).not.toContain(token);
  });

  it('erros de ferramenta: códigos fixos, sem detalhes internos; argumentos extras recusados pelo esquema', async () => {
    const { app, cookie } = await bridgeApp();
    const { token } = await newCredential(app, cookie);
    const order = await offeredOrder(app, cookie);
    const missing = await tool(app, token, 'acc_claim_order', { orderId: '00000000-0000-4000-8000-000000000000', idempotencyKey: 'claim-http-000002' });
    expect(missing).toMatchObject({ isError: true, data: { error: 'not_found' } });
    const extra = await rpc(app, token, 'tools/call', { name: 'acc_claim_order', arguments: { orderId: order.orderId, idempotencyKey: 'claim-http-000003', projectId: app.project.id } });
    expect(extra.json().result.isError).toBe(true);
    const claimed = await tool(app, token, 'acc_claim_order', { orderId: order.orderId, idempotencyKey: 'claim-http-000004' });
    const other = await tool(app, token, 'acc_report_pr', { orderId: order.orderId, claimId: claimed.data.claimId, pullRequest: 'outro/repo#1', idempotencyKey: 'report-http-00002' });
    expect(other).toMatchObject({ isError: true, data: { error: 'repository_not_allowed' } });
    expect((await rpc(app, token, 'tools/call', { name: 'acc_merge', arguments: {} })).body).not.toContain('"isError":false');
  });
});

describe('ponte MCP: pipeline próprio e restrito', () => {
  it('desligada por padrão: /mcp responde 404 e nada mais muda', async () => {
    const app = await startApp();
    const cookie = await app.login();
    expect((await rpc(app, 'x', 'initialize')).status).toBe(404);
    expect((await app.get(ordersPath(app), cookie)).json().bridge).toEqual({ enabled: false, endpoint: null, credential: null });
    await enable(app, cookie);
    const reply = await app.post(`/api/projects/${app.project.id}/claude-bridge/credentials`, { validityDays: 30, proofId: await app.proofId(cookie) }, cookie);
    expect(reply.json().error.code).toBe('bridge_unavailable');
  });

  it('método, Host, Origin, Sec-Fetch, tipo, protocolo, lote, tamanho e query: recusados antes de qualquer ferramenta', async () => {
    const { app, cookie } = await bridgeApp();
    const { token } = await newCredential(app, cookie);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const body = JSON.stringify(init);
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const reply = await app.call('/mcp', { method, headers: mcpHeaders(token) });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe('POST');
    }
    expect((await app.call('/mcp', { method: 'POST', headers: { ...mcpHeaders(token), host: 'evil.example' }, body })).status).toBe(403);
    expect((await app.call('/mcp', { method: 'POST', headers: { ...mcpHeaders(token), host: `127.0.0.1:${app.port + 1}` }, body })).status).toBe(403);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token, { origin: 'http://localhost:5173' }), body })).status).toBe(403);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token, { origin: 'null' }), body })).status).toBe(403);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token, { 'sec-fetch-site': 'same-origin' }), body })).status).toBe(403);
    expect((await app.call('/mcp', { method: 'POST', headers: { ...mcpHeaders(token), 'content-type': 'text/plain' }, body })).status).toBe(415);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token, { 'mcp-protocol-version': 'v1' }), body })).status).toBe(400);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token, { 'mcp-protocol-version': '1999-01-01' }), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).status).toBe(400);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token), body: JSON.stringify([init]) })).status).toBe(400);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token), body: '{nao-json' })).status).toBe(400);
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token), body: JSON.stringify({ ...init, pad: 'x'.repeat(BRIDGE_LIMITS.maxRequestBytes) }) })).status).toBe(413);
    expect((await app.call('/mcp?x=1', { method: 'POST', headers: mcpHeaders(token), body })).status).toBe(400);
    // Com tudo certo, o mesmo pedido passa.
    expect((await app.call('/mcp', { method: 'POST', headers: mcpHeaders(token), body })).status).toBe(200);
  });

  it('autenticação separada: cookie do administrador não autentica no /mcp; token da ponte não autentica nas rotas do admin', async () => {
    const { app, cookie } = await bridgeApp();
    const { token } = await newCredential(app, cookie);
    expect((await rpc(app, null, 'tools/list', {}, { cookie })).status).toBe(401);
    expect((await rpc(app, `accb_${'A'.repeat(43)}`, 'tools/list')).status).toBe(401);
    expect((await rpc(app, 'ghp_qualquercoisa', 'tools/list')).status).toBe(401);
    expect((await app.call('/mcp', { method: 'POST', headers: { ...mcpHeaders(null), authorization: `Basic ${token}` }, body: '{}' })).status).toBe(401);
    // Token da ponte numa rota administrativa (sem cookie) → não autenticado.
    expect((await app.call(ordersPath(app), { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await app.post(`/api/projects/${app.project.id}/claude-bridge/credentials`, { validityDays: 1, proofId: 'x' }, null, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it('revogação pela rota do PO vale na requisição seguinte; expiração também', async () => {
    const { app, cookie } = await bridgeApp();
    const { token, credential } = await newCredential(app, cookie, 1);
    expect((await rpc(app, token, 'tools/list')).status).toBe(200);
    const revoked = await app.post(`/api/projects/${app.project.id}/claude-bridge/credentials/${credential.id}/revoke`, { proofId: await app.proofId(cookie) }, cookie);
    expect(revoked.status).toBe(200);
    expect(revoked.json().credential.state).toBe('revoked');
    expect((await rpc(app, token, 'tools/list')).status).toBe(401);
    const second = await newCredential(app, cookie, 1);
    expect((await rpc(app, second.token, 'tools/list')).status).toBe(200);
    app.advance(24 * 60 * 60 * 1000 + 1000);
    expect((await rpc(app, second.token, 'tools/list')).status).toBe(401);
  });

  it('bloqueio temporário após falhas de autenticação (até para um token válido) e limite por credencial', async () => {
    const { app, cookie } = await bridgeApp();
    const { token } = await newCredential(app, cookie);
    for (let i = 0; i < BRIDGE_LIMITS.authFailuresBeforeLock; i += 1) expect((await rpc(app, null, 'tools/list')).status).toBe(401);
    const locked = await rpc(app, token, 'tools/list');
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    app.advance(BRIDGE_LIMITS.authFailureWindowMs + 1000);
    for (let i = 0; i < BRIDGE_LIMITS.requestsPerMinute; i += 1) expect((await rpc(app, token, 'tools/list')).status).toBe(200);
    expect((await rpc(app, token, 'tools/list')).status).toBe(429);
    app.advance(61_000);
    expect((await rpc(app, token, 'tools/list')).status).toBe(200);
  });

  it('a recusa de acesso vai para a auditoria sem o token apresentado', async () => {
    const { app, cookie } = await bridgeApp();
    await newCredential(app, cookie);
    const fake = `accb_${'B'.repeat(43)}`;
    expect((await rpc(app, fake, 'tools/list')).status).toBe(401);
    const auditText = await readFile(join(app.root, 'data', 'audit.json'), 'utf8');
    const denied = (JSON.parse(auditText).events as Array<{ action: string; outcome: string; resource: { type: string; id: string } }>).filter((e) => e.action === 'claude_bridge.access');
    expect(denied).toEqual([expect.objectContaining({ outcome: 'blocked', resource: { type: 'route', id: 'mcp' } })]);
    expect(auditText).not.toContain(fake);
    expect(app.logLines.join('\n')).not.toContain(fake);
  });
});

describe('ponte × fluxo manual pela API', () => {
  it('ordem disponibilizada não libera pacote manual; liberada manualmente não é disponibilizada', async () => {
    const { app, cookie } = await bridgeApp();
    await newCredential(app, cookie);
    const order = await offeredOrder(app, cookie);
    const manual = await app.post(`/api/claude-orders/${order.orderId}/package`, { proofId: await app.proofId(cookie) }, cookie);
    expect(manual.status).toBe(409);
    expect(manual.json().error.code).toBe('order_conflict');
    expect(manual.body).not.toContain('INSTRUÇÕES FIXAS');
    const created = await app.post(createPath(app), createBody(), cookie);
    await app.approveAll(cookie);
    const released = await app.post(`/api/claude-orders/${created.json().order.orderId}/package`, { proofId: await app.proofId(cookie) }, cookie);
    expect(released.status).toBe(200);
    const offer = await app.post(`/api/claude-orders/${created.json().order.orderId}/offer`, { proofId: await app.proofId(cookie) }, cookie);
    expect(offer.json().error.code).toBe('order_conflict');
  });

  it('sem credencial ativa, disponibilizar é recusado (bridge_unavailable)', async () => {
    const { app, cookie } = await bridgeApp();
    const created = await app.post(createPath(app), createBody(), cookie);
    await app.approveAll(cookie);
    const offer = await app.post(`/api/claude-orders/${created.json().order.orderId}/offer`, { proofId: await app.proofId(cookie) }, cookie);
    expect(offer.json().error.code).toBe('bridge_unavailable');
  });
});
