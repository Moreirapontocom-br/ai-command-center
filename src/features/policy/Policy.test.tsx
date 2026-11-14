import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { POLICY_ACTIONS, type PolicyAction, type PolicyEvaluation, type PolicyMatrixResponse } from '../../../shared/contracts.ts';
import App from '../../App';
import { apiError, configuredStatus, json, mockApi, PROJECT_ID, snapshotReply } from '../../test/githubFixtures';

function evaluations(overrides: Partial<Record<PolicyAction, Partial<PolicyEvaluation>>>): PolicyEvaluation[] {
  return (Object.keys(POLICY_ACTIONS) as PolicyAction[]).map((action) => ({
    decision: 'DENY',
    action,
    risk: POLICY_ACTIONS[action].risk,
    reason: 'no_matching_rule',
    ruleId: null,
    requiresApproval: false,
    approvalId: null,
    ...overrides[action],
  }));
}

const matrix: PolicyMatrixResponse = {
  policyVersion: '2026-11-14.1',
  projectId: PROJECT_ID,
  subjects: [
    {
      subject: { kind: 'human', id: 'admin' },
      assigned: false,
      evaluations: evaluations({
        'task.assign': { decision: 'ALLOW', reason: 'allowed_by_rule' },
        'repo.push_main': { decision: 'DENY', reason: 'main_is_protected' },
        'repo.merge': { decision: 'UNAVAILABLE', reason: 'capability_unavailable', requiresApproval: true },
      }),
    },
    {
      subject: { kind: 'agent', id: 'claude-code' },
      assigned: true,
      evaluations: evaluations({
        'task.read': { decision: 'ALLOW', reason: 'allowed_by_rule' },
        'task.status_change': { decision: 'REQUIRE_APPROVAL', reason: 'approval_required', requiresApproval: true },
        'permissions.change': { decision: 'DENY', reason: 'agent_cannot_change_permissions' },
      }),
    },
  ],
};

async function openPolicies() {
  const navigation = await screen.findByRole('navigation', { name: 'Navegação principal' });
  await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Políticas' }));
}

const base = { status: [json(configuredStatus)], snapshot: [snapshotReply()] };

describe('página de políticas (somente leitura)', () => {
  it('mostra decisão, risco e motivo para a pessoa e para cada agente', async () => {
    mockApi({ ...base, policy: [json(matrix)] });
    render(<App />);
    await openPolicies();

    expect(await screen.findByText(/Autonomia/)).toHaveTextContent('semiautomática');
    const merge = screen.getByRole('listitem', { name: 'Merge' });
    expect(merge).toHaveTextContent('Indisponível');
    expect(merge).toHaveTextContent('Quando existir, exigirá aprovação.');
    expect(screen.getByRole('listitem', { name: 'Push direto na main' })).toHaveTextContent('A main é protegida');
    expect(screen.getByRole('listitem', { name: 'Atribuir tarefa' })).toHaveTextContent('Permitido');

    await userEvent.setup().selectOptions(screen.getByLabelText('Ver decisões para'), 'agent:claude-code');
    expect(screen.getByRole('option', { name: 'Claude Code (agente) — com tarefa neste projeto' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Mudar status de tarefa' })).toHaveTextContent('Exige aprovação');
    expect(screen.getByRole('listitem', { name: 'Mudar permissões' })).toHaveTextContent('Agentes nunca alteram permissões.');
    expect(screen.getByRole('listitem', { name: 'Criar projeto' })).toHaveTextContent('negado por padrão');
  });

  it('não oferece edição de políticas', async () => {
    const fetchMock = mockApi({ ...base, policy: [json(matrix)] });
    render(<App />);
    await openPolicies();
    await screen.findByText(/Autonomia/);
    const main = screen.getByRole('main');
    expect(within(main).queryByRole('button')).not.toBeInTheDocument();
    expect(within(main).queryByRole('textbox')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/policy') && init?.method === 'POST')).toBe(false);
  });

  it('erro ao carregar: mensagem clara', async () => {
    mockApi({ ...base, policy: [apiError('not_found', 404)] });
    render(<App />);
    await openPolicies();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as políticas');
  });

  it('servidor fora do ar: políticas indisponíveis', async () => {
    render(<App />);
    await openPolicies();
    expect(await screen.findByRole('alert')).toHaveTextContent('Políticas indisponíveis');
  });
});
