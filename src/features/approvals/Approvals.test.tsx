import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { approvalBindingDigest } from '../../../shared/approvalDigest.ts';
import type { ApprovalDetail, ApprovalListResponse, ApprovalSummary } from '../../../shared/contracts.ts';
import App from '../../App';
import { apiError, configuredStatus, json, mockApi, PROJECT_ID, snapshotReply } from '../../test/githubFixtures';

const APPROVAL_ID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SHA = 'a'.repeat(40);

const summary = (overrides: Partial<ApprovalSummary> = {}): ApprovalSummary => ({
  id: APPROVAL_ID,
  class: 'execution',
  method: 'approval',
  action: 'sandbox.execute',
  projectId: PROJECT_ID,
  projectName: 'AI Command Center',
  subject: { kind: 'agent', id: 'claude-code' },
  requestedBy: { kind: 'system', id: 'sandbox' },
  state: 'pending',
  requestedAt: '2026-11-15T12:00:00.000Z',
  pendingUntil: '2026-11-16T12:00:00.000Z',
  validUntil: null,
  decidedAt: null,
  closedReason: null,
  ...overrides,
});

const binding = {
  action: 'sandbox.execute',
  projectId: PROJECT_ID,
  resource: { type: 'task', id: '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' },
  target: { sha: SHA, ref: 'agent/claude-code/6f1e8b2a' },
  subject: { kind: 'agent' as const, id: 'claude-code' as const },
  paramsDigest: 'sandbox:4f5e6d',
  policyVersion: '2026-11-14.1',
};

const detail = (overrides: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  ...summary(),
  binding,
  bindingDigest: approvalBindingDigest(binding),
  presentable: true,
  decidedBy: null,
  confirmationMethod: null,
  attempts: [],
  holds: [],
  ...overrides,
});

const list = (approvals: ApprovalSummary[], subsystem: Partial<ApprovalListResponse['subsystem']> = {}): ApprovalListResponse => ({
  subsystem: { state: 'available', reason: null, barriers: { global: false, projects: [] }, realExecutionEnabled: false, ...subsystem },
  approvals,
});

const base = { status: [json(configuredStatus)], snapshot: [snapshotReply()] };

async function openApprovals() {
  const navigation = await screen.findByRole('navigation', { name: 'Navegação principal' });
  await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Aprovações' }));
}

describe('página de aprovações', () => {
  it('lista solicitações com projeto, operação, solicitante, estado, data e prazo', async () => {
    mockApi({ ...base, approvals: [json(list([summary(), summary({ id: '4a3b2c1d-0000-4000-8000-000000000001', state: 'consumed', action: 'tool.use' })]))] });
    render(<App />);
    await openApprovals();
    const items = await screen.findAllByRole('listitem', { name: /Solicitação/ });
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('sandbox.execute');
    expect(items[0]).toHaveTextContent('AI Command Center');
    expect(items[0]).toHaveTextContent('Componente do servidor: sandbox');
    expect(items[0]).toHaveTextContent('Pendente (pending)');
    expect(items[0]).toHaveTextContent(/expira em/);
    expect(items[1]).toHaveTextContent('Consumida — uso reservado (consumed)');
    expect(screen.getByText(/Aprovar não executa nada/)).toBeInTheDocument();
  });

  it('detalhes exatos do vínculo, com o resumo conferido no navegador', async () => {
    mockApi({ ...base, approvals: [json(list([summary()]))], approvalDetail: [json({ approval: detail() })] });
    render(<App />);
    await openApprovals();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    const panel = await screen.findByRole('region', { name: 'Detalhes da solicitação' });
    for (const text of [SHA, 'agent/claude-code/6f1e8b2a', 'sandbox:4f5e6d', '2026-11-14.1', 'task:6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', 'Claude Code (agente)']) {
      expect(panel).toHaveTextContent(text);
    }
    expect(panel).toHaveTextContent('representados apenas por este resumo');
    expect(within(panel).getByText(/Apresentação conferida/)).toBeInTheDocument();
  });

  it('aprovação com senha: confirma a identidade, envia o resumo calculado e atualiza o estado', async () => {
    const fetchMock = mockApi({
      ...base,
      approvals: [json(list([summary()])), json(list([summary({ state: 'approved', validUntil: '2026-11-15T13:00:00.000Z' })]))],
      approvalDetail: [json({ approval: detail() })],
      stepUp: [json({ proofId: 'P'.repeat(43), expiresAt: '2026-11-15T12:05:00.000Z' })],
      approvalAction: [json({ approval: detail({ state: 'approved', validUntil: '2026-11-15T13:00:00.000Z', decidedBy: { kind: 'human', id: 'admin' } }) })],
    });
    render(<App />);
    await openApprovals();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    const form = await screen.findByRole('form', { name: 'Aprovar' });
    await user.type(within(form).getByLabelText(/Confirme sua senha/), 'minha-senha-canaria');
    await user.click(within(form).getByRole('button', { name: 'Aprovar esta operação' }));
    expect(await screen.findByText('Solicitação aprovada. Nada foi executado.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Detalhes da solicitação' })).toHaveTextContent('Aprovada, não utilizada (approved)');

    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init!.body)) }));
    expect(posts).toEqual([
      { url: '/api/approvals/step-up', body: { password: 'minha-senha-canaria' } },
      { url: `/api/approvals/${APPROVAL_ID}/approve`, body: { bindingDigest: approvalBindingDigest(binding), proofId: 'P'.repeat(43) } },
    ]);
    // A senha não fica no formulário depois do envio, nem em nenhum outro lugar da página.
    expect(document.body.innerHTML).not.toContain('minha-senha-canaria');
    await waitFor(() => expect(screen.getAllByRole('listitem', { name: /Solicitação/ })[0]).toHaveTextContent('Aprovada, não utilizada'));
  });

  it('rejeição com senha', async () => {
    const fetchMock = mockApi({
      ...base,
      approvals: [json(list([summary()]))],
      approvalDetail: [json({ approval: detail() })],
      stepUp: [json({ proofId: 'Q'.repeat(43), expiresAt: '2026-11-15T12:05:00.000Z' })],
      approvalAction: [json({ approval: detail({ state: 'rejected' }) })],
    });
    render(<App />);
    await openApprovals();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    const form = await screen.findByRole('form', { name: 'Rejeitar' });
    await user.type(within(form).getByLabelText(/Confirme sua senha/), 'senha');
    await user.click(within(form).getByRole('button', { name: 'Rejeitar' }));
    expect(await screen.findByText('Solicitação rejeitada.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === `/api/approvals/${APPROVAL_ID}/reject`)).toBe(true);
  });

  it('apresentação não validada (resumo divergente): aprovar fica bloqueado', async () => {
    mockApi({ ...base, approvals: [json(list([summary()]))], approvalDetail: [json({ approval: detail({ bindingDigest: 'f'.repeat(64) }) })] });
    render(<App />);
    await openApprovals();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    expect(await screen.findByText(/A aprovação está bloqueada até que os detalhes possam ser conferidos/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Aprovar' });
    expect(within(form).getByRole('button', { name: 'Aprovar esta operação' })).toBeDisabled();
    expect(within(form).getByLabelText(/Confirme sua senha/)).toBeDisabled();
  });

  it('mensagens de erro seguras: senha recusada, sem detalhes internos', async () => {
    mockApi({
      ...base,
      approvals: [json(list([summary()]))],
      approvalDetail: [json({ approval: detail() })],
      stepUp: [apiError('confirmation_failed', 403)],
    });
    render(<App />);
    await openApprovals();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    const form = await screen.findByRole('form', { name: 'Aprovar' });
    await user.type(within(form).getByLabelText(/Confirme sua senha/), 'errada');
    await user.click(within(form).getByRole('button', { name: 'Aprovar esta operação' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('Confirmação recusada');
    expect(alert).not.toHaveTextContent(/step_up|stack|Error/);
    expect(within(form).getByLabelText(/Confirme sua senha/)).toHaveValue('');
  });

  it('subsistema indisponível e bloqueio de emergência são exibidos; aprovada nunca aparece como executada', async () => {
    mockApi({ ...base, approvals: [json(list([summary({ state: 'approved' })], { state: 'unavailable', reason: 'not_configured', barriers: { global: true, projects: [] } }))] });
    render(<App />);
    await openApprovals();
    expect(await screen.findByText(/Subsistema de aprovações indisponível/)).toBeInTheDocument();
    expect(screen.getByText(/not_configured/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/executad[ao] com sucesso|Executada/);
  });

  it('bloqueio global ativo em instalação nova é informado', async () => {
    mockApi({ ...base, approvals: [json(list([], { barriers: { global: true, projects: [] } }))] });
    render(<App />);
    await openApprovals();
    expect(await screen.findByText(/Bloqueio de emergência global ativo/)).toBeInTheDocument();
    expect(screen.getByText('Nenhuma solicitação de aprovação.')).toBeInTheDocument();
  });
});
