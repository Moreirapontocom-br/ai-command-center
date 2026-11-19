// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AGENT_IDS, POLICY_ACTIONS, type PolicyAction, type PolicySubject } from '../../shared/contracts.ts';
import { GATEWAY_CAPABILITIES } from '../gateway/contracts.ts';
import { USAGE_MODES } from '../limits/contracts.ts';
import { DEFAULT_POLICY } from './defaultPolicy.ts';
import { ASSISTED_AVAILABILITY, assistedAvailable, evaluatePolicy, type AssistedFacts, type PolicyFacts } from './engine.ts';

/**
 * Issue #008 (D-08.3, §10.7): matriz COMPLETA da exceção assistida. As flags globais de
 * `agent.invoke` e `data.send_external` continuam `false`; só as duas combinações exatas, com o
 * projeto habilitado e fatos do servidor, deixam de ser `UNAVAILABLE` — e mesmo assim exigem aprovação.
 */

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SCOPE = '33333333-3333-4333-8333-333333333333';
const facts = (assisted: AssistedFacts | null | undefined, extra: Partial<PolicyFacts> = {}): PolicyFacts => ({ projectAccessible: true, agentAssigned: true, now: Date.parse('2026-11-19T12:00:00Z'), usedApprovals: new Set(), assisted, ...extra });
const good: AssistedFacts = { channel: 'assisted', mode: 'subscription_assisted', capability: 'code.change', component: 'gateway', projectId: PROJECT, projectEnabled: true };
const evaluate = (action: string, subject: PolicySubject, f: PolicyFacts, resourceType = 'gateway_scope', projectId: string | null = PROJECT) =>
  evaluatePolicy(DEFAULT_POLICY, { subject, action, projectId, resource: { type: resourceType, id: SCOPE }, target: { sha: null, ref: null }, approval: null }, f);

describe('exceção assistida (§10.7)', () => {
  it('flags globais continuam false; sem fatos assistidos, as duas ações são UNAVAILABLE para qualquer agente', () => {
    expect(POLICY_ACTIONS['agent.invoke'].available).toBe(false);
    expect(POLICY_ACTIONS['data.send_external'].available).toBe(false);
    for (const id of AGENT_IDS) {
      for (const action of ['agent.invoke', 'data.send_external']) {
        expect(evaluate(action, { kind: 'agent', id }, facts(undefined)).decision).toBe('UNAVAILABLE');
        expect(evaluate(action, { kind: 'agent', id }, facts(null)).decision).toBe('UNAVAILABLE');
      }
    }
  });

  it('matriz ação × agente × canal × modo × capacidade × componente × projeto: só as 2 combinações liberadas, sempre com aprovação', () => {
    const channels = ['assisted', 'simulated', 'other'];
    const components = ['gateway', 'limits', 'sandbox', 'policy'];
    const capabilities = [...GATEWAY_CAPABILITIES, 'code.other'];
    const projects: Array<{ id: string; enabled: boolean; requestProject: string }> = [
      { id: PROJECT, enabled: true, requestProject: PROJECT },
      { id: PROJECT, enabled: false, requestProject: PROJECT },
      { id: OTHER, enabled: true, requestProject: PROJECT },
    ];
    const subjects: PolicySubject[] = [...AGENT_IDS.map((id) => ({ kind: 'agent' as const, id })), { kind: 'human', id: 'admin' }];
    const unlocked: string[] = [];
    let combos = 0;
    for (const action of Object.keys(POLICY_ACTIONS) as PolicyAction[]) {
      for (const subject of subjects) {
        for (const channel of channels) {
          for (const mode of USAGE_MODES) {
            for (const capability of capabilities) {
              for (const component of components) {
                for (const p of projects) {
                  combos += 1;
                  const assisted: AssistedFacts = { channel, mode, capability, component, projectId: p.id, projectEnabled: p.enabled };
                  const result = evaluate(action, subject, facts(assisted), 'gateway_scope', p.requestProject);
                  const baseline = evaluate(action, subject, facts(null), 'gateway_scope', p.requestProject);
                  if (result.decision !== baseline.decision) {
                    unlocked.push(`${action}|${subject.kind}:${subject.id}|${channel}|${mode}|${capability}|${component}|${p.id === PROJECT}|${p.enabled}`);
                    // A exceção troca SÓ `UNAVAILABLE` por exigir aprovação; nunca libera sozinha.
                    expect(baseline.decision).toBe('UNAVAILABLE');
                    expect(result).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'approval_required', requiresApproval: true });
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(combos).toBeGreaterThan(10_000);
    expect(unlocked.sort()).toEqual([
      'agent.invoke|agent:claude-code|assisted|subscription_assisted|code.change|gateway|true|true',
      'data.send_external|agent:claude-code|assisted|subscription_assisted|code.change|gateway|true|true',
    ]);
  });

  it('fatos ausentes, inconsistentes ou forjados → UNAVAILABLE (falha fechada)', () => {
    const agent: PolicySubject = { kind: 'agent', id: 'claude-code' };
    const forged: unknown[] = [
      { ...good, projectEnabled: 'true' },
      { ...good, projectEnabled: 1 },
      { ...good, projectId: OTHER },
      { ...good, projectId: null },
      { ...good, extra: true },
      { channel: 'assisted', mode: 'subscription_assisted', capability: 'code.change', component: 'gateway', projectId: PROJECT },
      { ...good, capability: 'multiple' },
      { ...good, channel: 'Assisted' },
      [good],
      'assisted',
      42,
    ];
    for (const assisted of forged) {
      for (const action of ['agent.invoke', 'data.send_external']) {
        expect(evaluate(action, agent, facts(assisted as AssistedFacts)).decision).toBe('UNAVAILABLE');
      }
    }
    // Outro recurso (rota, tarefa) ou sem projeto: a exceção não se aplica.
    expect(evaluate('agent.invoke', agent, facts(good), 'task').decision).toBe('UNAVAILABLE');
    expect(evaluate('agent.invoke', agent, facts(good), 'route').decision).toBe('UNAVAILABLE');
    expect(evaluate('agent.invoke', agent, facts({ ...good }), 'gateway_scope', null).decision).toBe('DENY');
    // Sem tarefa atribuída ou projeto fora do escopo: as regras fixas continuam valendo (DENY).
    expect(evaluate('agent.invoke', agent, facts(good, { agentAssigned: false })).decision).toBe('DENY');
    expect(evaluate('agent.invoke', agent, facts(good, { projectAccessible: false })).decision).toBe('DENY');
    expect(assistedAvailable({ subject: agent, action: 'agent.invoke', projectId: PROJECT, resource: { type: 'gateway_scope', id: SCOPE } }, facts(good))).toBe(true);
  });

  it('a exceção não dispensa a aprovação: só um grant válido para a operação exata leva a ALLOW', () => {
    const agent: PolicySubject = { kind: 'agent', id: 'claude-code' };
    const grant = {
      id: '44444444-4444-4444-8444-444444444444',
      method: 'approval' as const,
      action: 'agent.invoke' as const,
      projectId: PROJECT,
      resource: { type: 'gateway_scope', id: SCOPE },
      target: { sha: null, ref: null },
      subject: agent,
      approvedBy: { kind: 'human' as const, id: 'admin' },
      approvedAt: '2026-11-19T11:59:00Z',
      expiresAt: '2026-11-19T12:59:00Z',
    };
    const request = { subject: agent, action: 'agent.invoke', projectId: PROJECT, resource: { type: 'gateway_scope', id: SCOPE }, target: { sha: null, ref: null } };
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: grant }, facts(good)).decision).toBe('ALLOW');
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: grant }, facts(null)).decision).toBe('UNAVAILABLE');
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: { ...grant, resource: { type: 'gateway_scope', id: PROJECT } } }, facts(good)).decision).toBe('REQUIRE_APPROVAL');
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: grant }, facts(good, { usedApprovals: new Set([grant.id]) })).decision).toBe('REQUIRE_APPROVAL');
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: { ...grant, approvedBy: { kind: 'human', id: 'claude-code' } } }, facts(good)).decision).toBe('REQUIRE_APPROVAL');
  });

  it('a lista é congelada, tem exatamente duas entradas e a versão da política mudou', () => {
    expect(ASSISTED_AVAILABILITY).toHaveLength(2);
    expect(Object.isFrozen(ASSISTED_AVAILABILITY)).toBe(true);
    expect(ASSISTED_AVAILABILITY.every((e) => Object.isFrozen(e))).toBe(true);
    expect(DEFAULT_POLICY.version).toBe('2026-11-19.2');
  });
});
