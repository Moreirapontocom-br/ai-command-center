// @vitest-environment node
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPresentation, claudeWorkBranchFor, parsePresentation, presentationParamsDigest } from '../../shared/approvalPresentation.ts';
import { approvalBindingDigest } from '../../shared/approvalDigest.ts';
import { classOf, CONFIGURATION_OPERATIONS } from '../approvals/contracts.ts';
import { resolveGatewayConfig } from '../config.ts';
import { GATEWAY_CAPABILITIES } from './contracts.ts';
import { checkGatewayBody } from './documents.ts';

/** Issue #008 — contratos: apresentação `code`, habilitação por projeto, ledger aditivo e configuração. */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '33333333-3333-4333-8333-333333333333';
const ORDER = '55555555-5555-4555-8555-555555555555';
const SCOPE = '66666666-6666-4666-8666-666666666666';
const params = (overrides: Record<string, unknown> = {}, code: Record<string, unknown> | null = {}) => ({
  scopeId: SCOPE,
  projectId: PROJECT,
  taskId: TASK,
  agentIds: ['claude-code'],
  capabilities: ['code.change'],
  dataRefs: [{ kind: 'task', ref: TASK }],
  channel: 'assisted',
  mode: 'subscription_assisted',
  externalSharing: true,
  maxInvocations: 1,
  budgetMinor: 0,
  validitySeconds: 3600,
  maxOutputBytes: 256,
  ...overrides,
  ...(code === null
    ? {}
    : { code: { orderId: ORDER, repository: 'owner/repo', repositoryId: 'R_1', baseSha: 'b'.repeat(40), workBranch: claudeWorkBranchFor(TASK, ORDER), inputDigest: 'd'.repeat(64), ...code } }),
});
const parse = (p: unknown) => {
  try {
    parsePresentation({ kind: 'gateway.scope', params: p });
    return 'ok';
  } catch (error) {
    return (error as { code: string }).code;
  }
};

describe('apresentação gateway.scope com a ordem (code.change)', () => {
  it('formato fechado: só Claude Code, canal assistido, modo de assinatura, sozinho, uma invocação, branch derivada', () => {
    expect(parse(params())).toBe('ok');
    expect(GATEWAY_CAPABILITIES).toContain('code.change');
    for (const bad of [
      params({ agentIds: ['chatgpt'] }),
      params({ channel: 'simulated', externalSharing: false }),
      params({ mode: 'official_integration' }),
      params({ mode: 'metered_api' }),
      params({ capabilities: ['code.change', 'text.review'] }),
      params({ maxInvocations: 2 }),
      params({}, { workBranch: 'main' }),
      params({}, { workBranch: claudeWorkBranchFor(TASK, SCOPE) }),
      params({}, { baseSha: 'abc' }),
      params({}, { repository: 'sem-barra' }),
      params({}, { extra: 1 }),
      params({}, null), // code.change sem o bloco `code`
      { ...params({ capabilities: ['text.review'] }) }, // bloco `code` sem code.change
    ]) {
      expect(parse(bad)).not.toBe('ok');
    }
    // Escopos sem `code.change` continuam aceitos sem o bloco (compatível com a #028).
    expect(parse(params({ agentIds: ['chatgpt'], capabilities: ['text.review'], channel: 'simulated', externalSharing: false, maxInvocations: 3 }, null))).toBe('ok');
  });

  it('o resumo prende repositório, SHA base, branch e objetivo: qualquer mudança → outro paramsDigest', () => {
    const base = presentationParamsDigest({ kind: 'gateway.scope', params: params() as never });
    for (const changed of [{ baseSha: 'c'.repeat(40) }, { repository: 'owner/other' }, { inputDigest: 'e'.repeat(64) }, { repositoryId: 'R_2' }]) {
      expect(presentationParamsDigest({ kind: 'gateway.scope', params: params({}, changed) as never })).not.toBe(base);
    }
  });
});

describe('habilitação por projeto (gateway.claude_project_enable)', () => {
  it('é operação de configuração (15 min), pedida pela própria pessoa e presa ao projeto', () => {
    expect(CONFIGURATION_OPERATIONS).toContain('gateway.claude_project_enable');
    expect(classOf('gateway.claude_project_enable')).toBe('configuration');
    const presentation = { kind: 'gateway.claude_project_enable' as const, params: { projectId: PROJECT, repository: 'owner/repo' } };
    const binding = { action: 'gateway.claude_project_enable', projectId: PROJECT, resource: { type: 'project', id: PROJECT }, target: { sha: null, ref: null }, subject: { kind: 'human' as const, id: 'admin' }, paramsDigest: presentationParamsDigest(presentation), policyVersion: 'v' };
    expect(checkPresentation({ binding, bindingDigest: approvalBindingDigest(binding), requestedBy: { kind: 'human', id: 'admin' }, presentation }).ok).toBe(true);
    // Outro projeto no vínculo, pedido por componente, ou sujeito agente → recusado.
    expect(checkPresentation({ binding: { ...binding, projectId: '22222222-2222-4222-8222-222222222222' }, bindingDigest: 'x', requestedBy: { kind: 'human', id: 'admin' }, presentation }).ok).toBe(false);
    expect(checkPresentation({ binding, bindingDigest: 'x', requestedBy: { kind: 'system', id: 'gateway' }, presentation }).ok).toBe(false);
    expect(checkPresentation({ binding: { ...binding, subject: { kind: 'agent', id: 'claude-code' } }, bindingDigest: 'x', requestedBy: { kind: 'human', id: 'admin' }, presentation }).ok).toBe(false);
  });
});

describe('ledger do gateway (aditivo)', () => {
  it('corpo da #028 (sem os conjuntos da #008) continua válido; conjuntos parciais são recusados', () => {
    expect(() => checkGatewayBody({ scopes: [], invocations: [], handoffs: [], contents: [] })).not.toThrow();
    expect(() => checkGatewayBody({ scopes: [], invocations: [], handoffs: [], contents: [], verifications: [], orderMarks: [], projectSettings: [] })).not.toThrow();
    expect(() => checkGatewayBody({ scopes: [], invocations: [], handoffs: [], contents: [], verifications: [] })).toThrow();
    // Verificação de uma ordem inexistente → recusado (nada solto no histórico).
    expect(() =>
      checkGatewayBody({
        scopes: [],
        invocations: [],
        handoffs: [],
        contents: [],
        verifications: [{ id: ORDER, ownerId: 'admin', projectId: PROJECT, orderId: ORDER, seq: 1, headSha: null, baseSha: 'b'.repeat(40), verdict: 'cancelled', rules: [], evidence: { pullRequest: null, compare: null, confirm: null }, supersedes: null, checkedAt: '2026-11-19T12:00:00.000Z', checkedBy: { kind: 'system', id: 'acc-gateway' }, closes: true, reason: 'cancelled' }],
        orderMarks: [],
        projectSettings: [],
      }),
    ).toThrow();
    // Habilitação sem aprovação consumida → recusado.
    expect(() =>
      checkGatewayBody({ scopes: [], invocations: [], handoffs: [], contents: [], verifications: [], orderMarks: [], projectSettings: [{ id: ORDER, ownerId: 'admin', projectId: PROJECT, enabled: true, repository: 'owner/repo', at: '2026-11-19T12:00:00.000Z', by: 'admin', approvalId: null, reason: 'x' }] }),
    ).toThrow();
  });
});

describe('configuração do gateway (ACC_GATEWAY_*)', () => {
  const abs = (p: string) => resolve('/tmp/acc-test', p);
  const approvals = { state: 'configured' as const, approvalsDir: abs('approvals'), anchorDir: abs('anchor'), key: { kind: 'env' as const }, initialize: 'never' as const };
  it('desligado por padrão; diretórios absolutos, distintos e separados; exige aprovações', () => {
    expect(resolveGatewayConfig({}, approvals, { state: 'disabled' })).toEqual({ state: 'disabled' });
    expect(resolveGatewayConfig({ ACC_GATEWAY_DIR: abs('g'), ACC_GATEWAY_CONTENT_DIR: abs('c') }, approvals, { state: 'disabled' })).toEqual({ state: 'configured', gatewayDir: abs('g'), contentDir: abs('c'), initialize: 'never' });
    expect(resolveGatewayConfig({ ACC_GATEWAY_DIR: abs('g'), ACC_GATEWAY_CONTENT_DIR: abs('c'), ACC_GATEWAY_INITIALIZE: 'if_absent' }, approvals, { state: 'disabled' })).toMatchObject({ initialize: 'if_absent' });
    for (const [env, reason] of [
      [{ ACC_GATEWAY_DIR: abs('g') }, 'gateway_dirs_required'],
      [{ ACC_GATEWAY_DIR: 'relativo', ACC_GATEWAY_CONTENT_DIR: abs('c') }, 'gateway_dirs_must_be_absolute'],
      [{ ACC_GATEWAY_DIR: abs('g'), ACC_GATEWAY_CONTENT_DIR: abs('g/c') }, 'gateway_dirs_must_be_separate'],
      [{ ACC_GATEWAY_DIR: abs('anchor/g'), ACC_GATEWAY_CONTENT_DIR: abs('c') }, 'gateway_dirs_must_be_separate'],
      [{ ACC_GATEWAY_DIR: abs('g'), ACC_GATEWAY_CONTENT_DIR: abs('c'), ACC_GATEWAY_INITIALIZE: 'sempre' }, 'gateway_initialize_invalid'],
    ] as const) {
      expect(resolveGatewayConfig(env, approvals, { state: 'disabled' })).toEqual({ state: 'invalid', reason });
    }
    expect(resolveGatewayConfig({ ACC_GATEWAY_DIR: abs('g'), ACC_GATEWAY_CONTENT_DIR: abs('c') }, { state: 'disabled' }, { state: 'disabled' })).toEqual({ state: 'invalid', reason: 'approvals_required' });
    expect(resolveGatewayConfig({ ACC_GATEWAY_DIR: abs('q/g'), ACC_GATEWAY_CONTENT_DIR: abs('c') }, approvals, { state: 'configured', queueDir: abs('q'), initialize: 'never' })).toEqual({ state: 'invalid', reason: 'gateway_dirs_must_be_separate' });
    expect(isAbsolute(abs('g'))).toBe(true);
  });
});
