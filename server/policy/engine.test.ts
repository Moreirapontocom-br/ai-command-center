// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { AGENT_IDS, POLICY_ACTIONS, type ApprovalGrant, type PolicyAction, type PolicySubject } from '../../shared/contracts.ts';
import { DEFAULT_POLICY } from './defaultPolicy.ts';
import { evaluatePolicy, validatePolicy, type Policy, type PolicyFacts, type PolicyRequest } from './engine.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P2 = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-11-14T12:00:00Z');
const human: PolicySubject = { kind: 'human', id: 'admin' };
const claude: PolicySubject = { kind: 'agent', id: 'claude-code' };
const facts = (overrides: Partial<PolicyFacts> = {}): PolicyFacts => ({
  projectAccessible: true,
  agentAssigned: true,
  now: NOW,
  usedApprovals: new Set(),
  ...overrides,
});
const ask = (subject: PolicySubject, action: string, extra: Partial<PolicyRequest> = {}, f: Partial<PolicyFacts> = {}) =>
  evaluatePolicy(DEFAULT_POLICY, { subject, action, projectId: P1, ...extra }, facts(f));

const grant = (overrides: Partial<ApprovalGrant> = {}): ApprovalGrant => ({
  id: 'g1',
  action: 'repo.merge',
  projectId: P1,
  resource: { type: 'pull_request', id: 'Moreirapontocom-br/ai-command-center#40' },
  target: { sha: SHA, ref: null },
  subject: human,
  approvedBy: { kind: 'human', id: 'product-owner' },
  approvedAt: '2026-11-14T11:00:00Z',
  expiresAt: '2026-11-14T13:00:00Z',
  ...overrides,
});

describe('negação por padrão e entradas malformadas', () => {
  it('política vazia nega tudo, inclusive leitura', () => {
    const empty: Policy = { version: 'vazia', rules: [] };
    for (const action of Object.keys(POLICY_ACTIONS)) {
      const result = evaluatePolicy(empty, { subject: human, action, projectId: P1 }, facts());
      expect(result.decision).toBe('DENY');
    }
  });

  it('ação desconhecida é negada', () => {
    expect(ask(human, 'repo.force_push')).toMatchObject({ decision: 'DENY', reason: 'unknown_action' });
    expect(ask(human, '__proto__')).toMatchObject({ decision: 'DENY', reason: 'unknown_action' });
    expect(ask(human, 'toString')).toMatchObject({ decision: 'DENY', reason: 'unknown_action' });
  });

  it.each([
    ['sujeito ausente', { subject: undefined }],
    ['tipo de sujeito inventado', { subject: { kind: 'root', id: 'x' } }],
    ['agente desconhecido', { subject: { kind: 'agent', id: 'skynet' } }],
    ['sujeito com campo extra (tentando escolher papel)', { subject: { kind: 'human', id: 'admin', role: 'owner' } }],
    ['projeto malformado', { projectId: '../x' }],
    ['SHA malformado', { target: { sha: 'abc', ref: null } }],
    ['campo extra tentando injetar política', { policy: { rules: [] } }],
    ['campo extra com fatos', { facts: { projectAccessible: true } }],
  ])('malformada (%s): DENY', (_case, overrides) => {
    const request = { subject: human, action: 'project.read', projectId: P1, ...overrides } as unknown as PolicyRequest;
    expect(evaluatePolicy(DEFAULT_POLICY, request, facts())).toMatchObject({ decision: 'DENY', reason: 'malformed_request' });
  });
});

describe('pessoa (dono do projeto)', () => {
  it.each(['project.read', 'task.read', 'github.read', 'audit.read', 'policy.read', 'project.create', 'project.update', 'project.select', 'task.create', 'task.update', 'task.assign', 'task.status_change', 'task.complete'])(
    '%s: ALLOW',
    (action) => {
      expect(ask(human, action)).toMatchObject({ decision: 'ALLOW', reason: 'allowed_by_rule' });
    },
  );

  it('capacidades que ainda não existem: UNAVAILABLE', () => {
    for (const action of ['task.propose', 'tool.use', 'change.prepare', 'approval.request']) {
      expect(ask(human, action)).toMatchObject({ decision: 'UNAVAILABLE', reason: 'capability_unavailable', requiresApproval: false });
    }
    expect(ask(human, 'sandbox.execute')).toMatchObject({ decision: 'UNAVAILABLE', requiresApproval: true, ruleId: 'H3-sandbox' });
  });

  it('push direto na main: sempre DENY, mesmo com aprovação', () => {
    expect(ask(human, 'repo.push_main')).toMatchObject({ decision: 'DENY', reason: 'main_is_protected' });
    expect(ask(human, 'repo.push_main', { approval: grant({ action: 'repo.push_main' }) })).toMatchObject({ decision: 'DENY' });
    expect(ask(claude, 'repo.push_main')).toMatchObject({ decision: 'DENY', reason: 'main_is_protected' });
  });

  it('ações críticas: exigem aprovação e hoje estão indisponíveis', () => {
    for (const action of ['repo.merge', 'deploy.publish', 'permissions.change', 'secrets.access', 'data.send_external', 'spend.create']) {
      expect(ask(human, action)).toMatchObject({ decision: 'UNAVAILABLE', requiresApproval: true, ruleId: 'H4-criticas' });
    }
  });

  it('projeto de outro dono: DENY antes de qualquer regra', () => {
    expect(ask(human, 'project.read', {}, { projectAccessible: false })).toMatchObject({ decision: 'DENY', reason: 'project_out_of_scope' });
  });
});

describe('agentes (semiautomático)', () => {
  it('sem tarefa atribuída no projeto: nem leitura', () => {
    expect(ask(claude, 'project.read', {}, { agentAssigned: false })).toMatchObject({ decision: 'DENY', reason: 'agent_not_assigned' });
  });

  it('com tarefa atribuída: observa; mudanças exigem aprovação', () => {
    expect(ask(claude, 'task.read')).toMatchObject({ decision: 'ALLOW' });
    expect(ask(claude, 'task.status_change')).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'approval_required' });
    expect(ask(claude, 'task.update')).toMatchObject({ decision: 'REQUIRE_APPROVAL' });
    expect(ask(claude, 'sandbox.execute')).toMatchObject({ decision: 'UNAVAILABLE', requiresApproval: true });
  });

  it.each(['project.create', 'project.update', 'project.select', 'task.create', 'task.assign', 'task.complete', 'audit.read', 'policy.read'])(
    'sem regra para agente: %s negado por padrão',
    (action) => {
      expect(ask(claude, action)).toMatchObject({ decision: 'DENY', reason: 'no_matching_rule' });
    },
  );

  it('agente nunca altera permissões (regra fixa), mesmo com "aprovação"', () => {
    expect(ask(claude, 'permissions.change')).toMatchObject({ decision: 'DENY', reason: 'agent_cannot_change_permissions' });
    const approval = grant({ action: 'permissions.change', subject: claude, target: { sha: null, ref: null } });
    expect(ask(claude, 'permissions.change', { approval, resource: approval.resource })).toMatchObject({ decision: 'DENY' });
  });

  it('ações críticas de agente: nunca ALLOW sem aprovação, para todos os agentes', () => {
    for (const id of AGENT_IDS) {
      for (const action of Object.keys(POLICY_ACTIONS) as PolicyAction[]) {
        if (!POLICY_ACTIONS[action].critical) continue;
        expect(ask({ kind: 'agent', id }, action).decision).not.toBe('ALLOW');
      }
    }
  });

  it('regra específica de agente só restringe; não amplia', () => {
    const restricted: Policy = validatePolicy({
      version: 't',
      rules: [...DEFAULT_POLICY.rules, { id: 'X-gemini-sem-leitura', subject: 'agent:gemini', actions: ['task.read'], effect: 'deny', maxRisk: 'low' }],
    });
    const f = facts();
    expect(evaluatePolicy(restricted, { subject: { kind: 'agent', id: 'gemini' }, action: 'task.read', projectId: P1 }, f)).toMatchObject({ decision: 'DENY', reason: 'restricted_by_rule' });
    expect(evaluatePolicy(restricted, { subject: claude, action: 'task.read', projectId: P1 }, f).decision).toBe('ALLOW');
    expect(() =>
      validatePolicy({ version: 't', rules: [{ id: 'X', subject: 'agent:gemini', actions: ['project.create'], effect: 'allow', maxRisk: 'medium' }] }),
    ).toThrow(/só pode restringir/);
  });
});

describe('invariante: agente só com tarefa atribuída (R1)', () => {
  /** Política personalizada permissiva para agentes, SEM `requiresAssignment`. */
  const permissive: Policy = validatePolicy({
    version: 'personalizada',
    rules: [
      { id: 'H', subject: 'human:owner', categories: ['observe', 'project', 'task'], effect: 'allow', maxRisk: 'medium' },
      { id: 'P1-agente-observa', subject: 'agent:*', categories: ['observe'], effect: 'allow', maxRisk: 'low', requiresAssignment: false },
      { id: 'P2-agente-altera', subject: 'agent:*', categories: ['task', 'project'], effect: 'allow', maxRisk: 'medium' },
    ],
  });
  const run = (subject: PolicySubject, action: string, projectId: string | null, f: Partial<PolicyFacts>) =>
    evaluatePolicy(permissive, { subject, action, projectId }, facts(f));

  it.each(['project.read', 'task.read', 'github.read', 'audit.read', 'task.update', 'task.status_change', 'task.complete', 'project.update'])(
    'requiresAssignment:false não libera %s a agente sem tarefa no projeto',
    (action) => {
      expect(run(claude, action, P1, { agentAssigned: false })).toMatchObject({ decision: 'DENY', reason: 'agent_not_assigned', ruleId: null });
    },
  );

  it('agente sem projeto (ex.: criar projeto) é sempre negado, mesmo com regra que permitiria', () => {
    expect(run(claude, 'project.create', null, { agentAssigned: true })).toMatchObject({ decision: 'DENY', reason: 'agent_not_assigned' });
    expect(run(claude, 'project.read', null, { agentAssigned: true })).toMatchObject({ decision: 'DENY', reason: 'agent_not_assigned' });
  });

  it('todos os agentes, todas as ações: sem atribuição nunca há ALLOW', () => {
    for (const id of AGENT_IDS) {
      for (const action of Object.keys(POLICY_ACTIONS)) {
        expect(run({ kind: 'agent', id }, action, P1, { agentAssigned: false }).decision).toBe('DENY');
        expect(evaluatePolicy(DEFAULT_POLICY, { subject: { kind: 'agent', id }, action, projectId: P1 }, facts({ agentAssigned: false })).decision).toBe('DENY');
      }
    }
  });

  it('com tarefa atribuída, a política personalizada vale normalmente', () => {
    expect(run(claude, 'task.read', P1, { agentAssigned: true }).decision).toBe('ALLOW');
  });

  it('pessoas não são afetadas pela invariante', () => {
    expect(run(human, 'project.create', null, { agentAssigned: false }).decision).toBe('ALLOW');
    expect(run(human, 'task.read', P1, { agentAssigned: false }).decision).toBe('ALLOW');
  });
});

describe('validação da política (PO)', () => {
  it.each([
    ['liberar ação crítica sem aprovação', { id: 'X', subject: 'human:owner', categories: ['critical'], effect: 'allow', maxRisk: 'high' }, /crítica/],
    ['liberar merge para agentes', { id: 'X', subject: 'agent:*', actions: ['repo.merge'], effect: 'allow', maxRisk: 'high' }, /crítica/],
    ['ação desconhecida', { id: 'X', subject: 'agent:*', actions: ['repo.force_push'], effect: 'allow', maxRisk: 'low' }, /desconhecida/],
    ['sujeito desconhecido', { id: 'X', subject: 'agent:skynet', actions: ['task.read'], effect: 'deny', maxRisk: 'low' }, /sujeito/],
    ['regra sem ações', { id: 'X', subject: 'agent:*', effect: 'deny', maxRisk: 'low' }, /sem ações/],
  ])('recusa %s', (_case, rule, message) => {
    expect(() => validatePolicy({ version: 't', rules: [rule as never] })).toThrow(message);
  });

  it('risco acima do limite da regra não é coberto (negação por padrão)', () => {
    const lowOnly: Policy = validatePolicy({ version: 't', rules: [{ id: 'L', subject: 'human:owner', categories: ['task'], effect: 'allow', maxRisk: 'low' }] });
    expect(evaluatePolicy(lowOnly, { subject: human, action: 'task.create', projectId: P1 }, facts())).toMatchObject({ decision: 'DENY', reason: 'no_matching_rule' });
  });

  it('decisão é determinística', () => {
    const a = ask(claude, 'task.status_change');
    const b = ask(claude, 'task.status_change');
    expect(a).toEqual(b);
  });
});

describe('aprovações: escopo, versão, validade e uso único', () => {
  // Política de teste com uma ação crítica "disponível" para exercitar a aprovação.
  const policy = DEFAULT_POLICY;
  // Catálogo de teste em que o merge "existe", para exercitar a aprovação (o real continua indisponível).
  const catalog = { ...POLICY_ACTIONS, 'repo.merge': { ...POLICY_ACTIONS['repo.merge'], available: true } };
  const evaluateAvailable = (request: Partial<PolicyRequest>, f: Partial<PolicyFacts> = {}) =>
    evaluatePolicy(
      policy,
      { subject: human, action: 'repo.merge', projectId: P1, resource: grant().resource, target: { sha: SHA, ref: null }, ...request },
      facts(f),
      catalog,
    );

  it('sem aprovação: REQUIRE_APPROVAL', () => {
    expect(evaluateAvailable({})).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'approval_required' });
  });

  it('aprovação exata: ALLOW com o id a consumir', () => {
    expect(evaluateAvailable({ approval: grant() })).toMatchObject({ decision: 'ALLOW', reason: 'approved', approvalId: 'g1' });
  });

  it.each([
    ['outra ação', grant({ action: 'deploy.publish' })],
    ['outro projeto', grant({ projectId: P2 })],
    ['outro recurso', grant({ resource: { type: 'pull_request', id: 'Moreirapontocom-br/ai-command-center#41' } })],
    ['outro SHA', grant({ target: { sha: 'b'.repeat(40), ref: null } })],
    ['sem SHA', grant({ target: { sha: null, ref: null } })],
    ['outro sujeito', grant({ subject: claude })],
    ['aprovada pelo próprio sujeito', grant({ approvedBy: { kind: 'human', id: 'admin' } })],
    ['aprovada por agente', grant({ approvedBy: { kind: 'agent', id: 'claude-code' } as never })],
    ['id de agente rotulado como pessoa', grant({ approvedBy: { kind: 'human', id: 'claude-code' } })],
    ['expirada', grant({ expiresAt: '2026-11-14T11:30:00Z' })],
    ['ainda não válida', grant({ approvedAt: '2026-11-14T12:30:00Z', expiresAt: '2026-11-14T13:00:00Z' })],
    ['validade longa demais', grant({ approvedAt: '2026-11-13T00:00:00Z', expiresAt: '2026-11-15T00:00:00Z' })],
  ])('aprovação inválida (%s): continua REQUIRE_APPROVAL', (_case, approval) => {
    expect(evaluateAvailable({ approval })).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'approval_invalid' });
  });

  it('MVP de administrador único: o PO aprova a ação de um AGENTE; o agente nunca aprova a própria', () => {
    const agentRequest = { subject: claude, resource: grant().resource, target: { sha: SHA, ref: null } };
    const byPo = grant({ subject: claude, approvedBy: { kind: 'human', id: 'admin' } });
    expect(evaluateAvailable({ ...agentRequest, approval: byPo })).toMatchObject({ decision: 'ALLOW', reason: 'approved' });
    const bySelf = grant({ subject: claude, approvedBy: { kind: 'human', id: 'claude-code' } });
    expect(evaluateAvailable({ ...agentRequest, approval: bySelf })).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'approval_invalid' });
    // A ação crítica da própria pessoa continua sem autoaprovação (validação não enfraquecida).
    expect(evaluateAvailable({ approval: grant({ approvedBy: { kind: 'human', id: 'admin' } }) })).toMatchObject({ reason: 'approval_invalid' });
  });

  it('aprovação já usada não pode ser reutilizada', () => {
    expect(evaluateAvailable({ approval: grant() }, { usedApprovals: new Set(['g1']) })).toMatchObject({ decision: 'REQUIRE_APPROVAL', reason: 'approval_invalid' });
  });

  it('aprovação não libera o que está indisponível (hoje, merge não existe no ACC)', () => {
    expect(ask(human, 'repo.merge', { approval: grant(), resource: grant().resource, target: { sha: SHA, ref: null } })).toMatchObject({ decision: 'UNAVAILABLE' });
  });
});
