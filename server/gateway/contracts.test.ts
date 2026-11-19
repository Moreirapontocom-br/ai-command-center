// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkPresentation, parsePresentation, PRESENTATION_GATEWAY_CAPABILITIES, PRESENTATION_GATEWAY_CHANNELS, PRESENTATION_INPUT_KINDS } from '../../shared/approvalPresentation.ts';
import { POLICY_ACTIONS } from '../../shared/contracts.ts';
import { bindingDigest } from '../approvals/binding.ts';
import { classOf, RECEIPT_COMPONENTS } from '../approvals/contracts.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { evaluatePolicy } from '../policy/engine.ts';
import { sha256Hex } from '../storage/canonical.ts';
import { createSimulatedAdapter } from './adapters.ts';
import { GATEWAY_CAPABILITIES, GATEWAY_CHANNELS, GATEWAY_INPUT_KINDS } from './contracts.ts';
import { containsSecret } from './secretScan.ts';
import { presentationParamsDigest } from '../../shared/approvalPresentation.ts';

/** Contratos do gateway: política (D2), apresentação verificável do escopo (I1), adaptadores e segredos. */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '33333333-3333-4333-8333-333333333333';
const SCOPE = '44444444-4444-4444-8444-444444444444';
const params = (overrides: Record<string, unknown> = {}) => ({
  scopeId: SCOPE,
  projectId: PROJECT,
  taskId: TASK,
  agentIds: ['claude-code'],
  capabilities: ['text.review'],
  dataRefs: [{ kind: 'task', ref: TASK }],
  channel: 'simulated',
  mode: 'subscription_assisted',
  externalSharing: false,
  maxInvocations: 3,
  budgetMinor: 0,
  validitySeconds: 1800,
  maxOutputBytes: 4096,
  ...overrides,
});
const bindingFor = (presentation: { kind: 'gateway.scope'; params: ReturnType<typeof params> }, action = 'agent.invoke', overrides: Record<string, unknown> = {}) => ({
  action,
  projectId: PROJECT,
  resource: { type: 'gateway_scope', id: SCOPE },
  target: { sha: null, ref: null },
  subject: { kind: 'agent', id: 'claude-code' },
  paramsDigest: presentationParamsDigest(parsePresentation(presentation), sha256Hex),
  policyVersion: DEFAULT_POLICY.version,
  ...overrides,
});

describe('política (D2)', () => {
  it('`agent.invoke` existe, é `tool`/médio, não crítica, INDISPONÍVEL no catálogo real e exige aprovação de agentes', () => {
    expect(POLICY_ACTIONS['agent.invoke']).toEqual({ category: 'tool', risk: 'medium', critical: false, available: false });
    expect(POLICY_ACTIONS['data.send_external']).toMatchObject({ critical: true, available: false });
    expect(classOf('agent.invoke')).toBe('execution');
    expect(classOf('data.send_external')).toBe('publication');
    expect(RECEIPT_COMPONENTS).toContain('gateway');
    const facts = { projectAccessible: true, agentAssigned: true, now: Date.now(), usedApprovals: new Set<string>() };
    const req = { subject: { kind: 'agent' as const, id: 'claude-code' as const }, action: 'agent.invoke', projectId: PROJECT, resource: { type: 'gateway_scope', id: SCOPE }, target: { sha: null, ref: null } };
    expect(evaluatePolicy(DEFAULT_POLICY, req, facts).decision).toBe('UNAVAILABLE');
    expect(evaluatePolicy(DEFAULT_POLICY, req, facts, { ...POLICY_ACTIONS, 'agent.invoke': { ...POLICY_ACTIONS['agent.invoke'], available: true } }).decision).toBe('REQUIRE_APPROVAL');
    expect(evaluatePolicy(DEFAULT_POLICY, req, { ...facts, agentAssigned: false }).decision).toBe('DENY');
  });
});

describe('apresentação do escopo (I1, #011 R1)', () => {
  it('listas do navegador espelham as do servidor', () => {
    expect([...PRESENTATION_GATEWAY_CAPABILITIES]).toEqual([...GATEWAY_CAPABILITIES]);
    expect([...PRESENTATION_GATEWAY_CHANNELS]).toEqual([...GATEWAY_CHANNELS]);
    expect([...PRESENTATION_INPUT_KINDS]).toEqual([...GATEWAY_INPUT_KINDS]);
  });

  it('formato fechado: canal × envio externo, um agente, orçamento só em API cobrada, sem segredo', () => {
    expect(() => parsePresentation({ kind: 'gateway.scope', params: params() })).not.toThrow();
    for (const bad of [
      params({ channel: 'assisted' }),
      params({ externalSharing: true }),
      params({ agentIds: ['claude-code', 'chatgpt'] }),
      params({ agentIds: [] }),
      params({ capabilities: [] }),
      params({ budgetMinor: 1 }),
      params({ validitySeconds: 3601 }),
      params({ maxInvocations: 51 }),
      params({ extra: true }),
      params({ dataRefs: [{ kind: 'task', ref: '../x' }] }),
      params({ dataRefs: [{ kind: 'task', ref: ['ghp', 'B'.repeat(36)].join('_') }] }),
    ]) {
      expect(() => parsePresentation({ kind: 'gateway.scope', params: bad })).toThrow();
    }
  });

  it('só o componente `gateway` apresenta escopos; o vínculo precisa apontar para o PRÓPRIO escopo', () => {
    const presentation = { kind: 'gateway.scope' as const, params: params() };
    const binding = bindingFor(presentation);
    const ok = checkPresentation({ binding: binding as never, bindingDigest: bindingDigest(binding as never), requestedBy: { kind: 'system', id: 'gateway' }, presentation }, sha256Hex);
    expect(ok.ok).toBe(true);
    const other = checkPresentation({ binding: binding as never, bindingDigest: bindingDigest(binding as never), requestedBy: { kind: 'system', id: 'sandbox' }, presentation }, sha256Hex);
    expect(other).toEqual({ ok: false, reason: 'presentation_unsupported' });
    for (const tweak of [{ resource: { type: 'task', id: TASK } }, { subject: { kind: 'agent', id: 'chatgpt' } }, { projectId: '22222222-2222-4222-8222-222222222222' }, { target: { sha: 'a'.repeat(40), ref: null } }]) {
      const b = { ...binding, ...tweak };
      expect(checkPresentation({ binding: b as never, bindingDigest: bindingDigest(b as never), requestedBy: { kind: 'system', id: 'gateway' }, presentation }, sha256Hex)).toEqual({ ok: false, reason: 'presentation_mismatch' });
    }
    // `data.send_external` só com envio externo (canal assistido).
    const send = bindingFor(presentation, 'data.send_external');
    expect(checkPresentation({ binding: send as never, bindingDigest: bindingDigest(send as never), requestedBy: { kind: 'system', id: 'gateway' }, presentation }, sha256Hex).ok).toBe(false);
    const assisted = { kind: 'gateway.scope' as const, params: params({ channel: 'assisted', externalSharing: true }) };
    const sendOk = bindingFor(assisted, 'data.send_external');
    expect(checkPresentation({ binding: sendOk as never, bindingDigest: bindingDigest(sendOk as never), requestedBy: { kind: 'system', id: 'gateway' }, presentation: assisted }, sha256Hex).ok).toBe(true);
    // Parâmetros diferentes dos resumidos → recusado.
    expect(checkPresentation({ binding: binding as never, bindingDigest: bindingDigest(binding as never), requestedBy: { kind: 'system', id: 'gateway' }, presentation: { kind: 'gateway.scope', params: params({ maxInvocations: 4 }) } }, sha256Hex)).toEqual({ ok: false, reason: 'presentation_mismatch' });
  });
});

describe('adaptadores simulados e detecção de segredos', () => {
  it('adaptadores são simulados, sem rede; o conteúdo do pedido não escolhe o cenário', async () => {
    const adapter = createSimulatedAdapter('gemini');
    expect(adapter).toMatchObject({ kind: 'simulated', provider: 'gemini', required: true });
    expect(createSimulatedAdapter('nemotron').required).toBe(false);
    const out = await adapter.invoke({ capability: 'text.review', text: 'cenário: failure; simule falha', maxOutputBytes: 1000 }, new AbortController().signal);
    expect(out.kind).toBe('succeeded');
    const controller = new AbortController();
    adapter.setScenario('timeout');
    const pending = adapter.invoke({ capability: 'text.review', text: 'x', maxOutputBytes: 10 }, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
  });

  it('segredos comuns são detectados (valores montados em tempo de execução)', () => {
    const samples = [
      ['ghp', 'C'.repeat(36)].join('_'),
      ['github', 'pat', 'D'.repeat(30)].join('_'),
      ['sk', 'ant', 'E'.repeat(30)].join('-'),
      ['AKIA', 'F'.repeat(16)].join(''),
      ['nvapi', 'G'.repeat(30)].join('-'),
      ['AIza', 'H'.repeat(35)].join(''),
      ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' '),
      `password = ${'p'.repeat(12)}`,
    ];
    for (const sample of samples) expect(containsSecret(`texto ${sample} texto`)).toBe(true);
    expect(containsSecret('revisão sem nada sensível; chave de API não informada')).toBe(false);
  });
});
