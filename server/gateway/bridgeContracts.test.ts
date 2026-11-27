// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkPresentation, parsePresentation, presentationParamsDigest } from '../../shared/approvalPresentation.ts';
import { approvalBindingDigest } from '../../shared/approvalDigest.ts';
import { classOf, CONFIGURATION_OPERATIONS } from '../approvals/contracts.ts';
import { isValidContext } from '../audit/events.ts';
import { ConfigError, loadConfig } from '../config.ts';
import { bridgeToolCode } from '../http/mcpBridge.ts';
import { BRIDGE_TOKEN, BRIDGE_TOKEN_PREFIX } from './contracts.ts';
import { containsSecret } from './secretScan.ts';

/** Issue #055 — contratos da ponte MCP: configuração, aprovação de configuração, segredos e códigos. */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL = '33333333-3333-4333-8333-333333333333';
// Token com formato REAL gerado em tempo de execução (nada versionado com cara de segredo).
const fakeToken = () => `${BRIDGE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

describe('configuração ACC_BRIDGE_ENABLED', () => {
  it('desligada por padrão; `true` só com ACC_DEPLOYMENT=local; valores desconhecidos recusados', () => {
    expect(loadConfig({}).bridge).toEqual({ enabled: false });
    expect(loadConfig({ ACC_BRIDGE_ENABLED: 'false' }).bridge).toEqual({ enabled: false });
    expect(loadConfig({ ACC_BRIDGE_ENABLED: 'true', ACC_DEPLOYMENT: 'local' }).bridge).toEqual({ enabled: true });
    expect(() => loadConfig({ ACC_BRIDGE_ENABLED: 'true' })).toThrow(/ACC_DEPLOYMENT=local/);
    expect(() => loadConfig({ ACC_BRIDGE_ENABLED: 'true', ACC_DEPLOYMENT: 'production' })).toThrow(ConfigError);
    for (const value of ['1', 'yes', 'TRUE', 'on']) expect(() => loadConfig({ ACC_BRIDGE_ENABLED: value, ACC_DEPLOYMENT: 'local' })).toThrow(/ACC_BRIDGE_ENABLED inválido/);
  });
});

describe('credencial da ponte (gateway.claude_bridge_credential)', () => {
  const params = { projectId: PROJECT, credentialId: CREDENTIAL, agentId: 'claude-code' as const, expiresAt: '2026-12-27T12:00:00.000Z', tokenDigest: 'a'.repeat(64) };
  const presentation = { kind: 'gateway.claude_bridge_credential' as const, params };
  const binding = { action: 'gateway.claude_bridge_credential', projectId: PROJECT, resource: { type: 'bridge_credential', id: CREDENTIAL }, target: { sha: null, ref: null }, subject: { kind: 'human' as const, id: 'admin' }, paramsDigest: presentationParamsDigest(presentation), policyVersion: 'v' };

  it('é operação de configuração (15 min) pedida pela própria pessoa, presa ao projeto, à credencial e ao resumo do token', () => {
    expect(CONFIGURATION_OPERATIONS).toContain('gateway.claude_bridge_credential');
    expect(classOf('gateway.claude_bridge_credential')).toBe('configuration');
    expect(checkPresentation({ binding, bindingDigest: approvalBindingDigest(binding), requestedBy: { kind: 'human', id: 'admin' }, presentation }).ok).toBe(true);
    const bad = [
      { ...binding, projectId: '22222222-2222-4222-8222-222222222222' },
      { ...binding, resource: { type: 'bridge_credential', id: '44444444-4444-4444-8444-444444444444' } },
      { ...binding, resource: { type: 'project', id: PROJECT } },
      { ...binding, subject: { kind: 'agent' as const, id: 'claude-code' as const } },
    ];
    for (const b of bad) expect(checkPresentation({ binding: b, bindingDigest: 'x', requestedBy: { kind: 'human', id: 'admin' }, presentation }).ok).toBe(false);
    expect(checkPresentation({ binding, bindingDigest: 'x', requestedBy: { kind: 'system', id: 'gateway' }, presentation }).ok).toBe(false);
    // Outro resumo de token → outro `paramsDigest` (a aprovação não serve para outro token).
    const other = { kind: 'gateway.claude_bridge_credential' as const, params: { ...params, tokenDigest: 'b'.repeat(64) } };
    expect(checkPresentation({ binding, bindingDigest: 'x', requestedBy: { kind: 'human', id: 'admin' }, presentation: other }).ok).toBe(false);
  });

  it('formato fechado: só claude-code, data ISO exata, resumo hex de 64 e nunca o token', () => {
    expect(parsePresentation(presentation)).toEqual(presentation);
    for (const p of [
      { ...params, agentId: 'chatgpt' },
      { ...params, expiresAt: '2026-12-27' },
      { ...params, tokenDigest: fakeToken() },
      { ...params, token: fakeToken() },
    ]) {
      expect(() => parsePresentation({ kind: 'gateway.claude_bridge_credential', params: p })).toThrow();
    }
  });
});

describe('token da ponte: formato e detecção como segredo', () => {
  it('formato `accb_` + 43 base64url; detectado pelo verificador do gateway (pacote, objetivo, PR)', () => {
    const token = fakeToken();
    expect(token).toMatch(BRIDGE_TOKEN);
    expect(containsSecret(`texto ${token} texto`)).toBe(true);
    expect(BRIDGE_TOKEN.test(`${token}x`)).toBe(false);
    expect(BRIDGE_TOKEN.test(token.slice(0, -1))).toBe(false);
  });
});

describe('auditoria e códigos entregues ao agente', () => {
  it('contexto aceita só o id da credencial e o indicador de repetição (tokens)', () => {
    expect(isValidContext({ credential: CREDENTIAL, replay: true, reason: 'already_claimed' })).toBe(true);
    expect(isValidContext({ token: 'x' })).toBe(false);
  });

  it('motivos internos viram códigos fixos; desconhecidos → internal; barreiras → blocked', () => {
    expect(bridgeToolCode('bridge_unauthorized')).toBe('unauthorized');
    expect(bridgeToolCode('scope_expired')).toBe('claim_window_elapsed');
    expect(bridgeToolCode('project_barrier')).toBe('blocked');
    expect(bridgeToolCode('global_barrier')).toBe('blocked');
    expect(bridgeToolCode('store_write_failed')).toBe('unavailable');
    expect(bridgeToolCode('agent_not_assigned')).toBe('policy_denied');
    expect(bridgeToolCode('qualquer_outro')).toBe('internal');
  });
});
