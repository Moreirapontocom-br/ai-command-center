import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { approvalBindingDigest } from '../../../shared/approvalDigest.ts';
import { approvalPresentationDigest, presentationParamsDigest, type ApprovalPresentation } from '../../../shared/approvalPresentation.ts';
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

/** Parâmetros exatos entregues pelo componente do servidor (correção R1). */
const presentation: ApprovalPresentation = {
  kind: 'sandbox',
  params: {
    requestId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    repository: 'Moreirapontocom-br/ai-command-center',
    network: { default: 'deny', allow: ['registry.npmjs.org'] },
    credentials: { scopes: ['repo.read'], ttlSeconds: 600, productionSecrets: 'denied', productionDatabase: 'denied' },
    limits: { timeoutSeconds: 600, cpu: 1, memoryMb: 512, diskMb: 1024 },
    inputs: [{ kind: 'issue', ref: 'acc#11', trust: 'untrusted' }],
  },
};
const PARAMS_DIGEST = presentationParamsDigest(presentation);

const binding = {
  action: 'sandbox.execute',
  projectId: PROJECT_ID,
  resource: { type: 'task', id: '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' },
  target: { sha: SHA, ref: 'agent/claude-code/6f1e8b2a' },
  subject: { kind: 'agent' as const, id: 'claude-code' as const },
  paramsDigest: PARAMS_DIGEST,
  policyVersion: '2026-11-14.1',
};
const PRESENTATION_DIGEST = approvalPresentationDigest(approvalBindingDigest(binding), presentation);

const detail = (overrides: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  ...summary(),
  binding,
  bindingDigest: approvalBindingDigest(binding),
  presentable: true,
  presentation,
  presentationDigest: PRESENTATION_DIGEST,
  presentationIssue: null,
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
    for (const text of [SHA, 'agent/claude-code/6f1e8b2a', PARAMS_DIGEST, '2026-11-14.1', 'task:6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', 'Claude Code (agente)']) {
      expect(panel).toHaveTextContent(text);
    }
    // Correção R1: os parâmetros REAIS aparecem, legíveis e somente leitura.
    const params = within(panel).getByRole('region', { name: 'Parâmetros da operação' });
    for (const text of [
      'Moreirapontocom-br/ai-command-center',
      'registry.npmjs.org',
      'repo.read',
      '600 s',
      'CPU 1',
      'memória 512 MB',
      'disco 1024 MB',
      'acc#11',
      '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
    ]) {
      expect(params).toHaveTextContent(text);
    }
    expect(params).toHaveTextContent(/Segredos de produção\s*Negado/);
    expect(within(params).getByText(/Parâmetros conferidos/)).toBeInTheDocument();
    expect(within(params).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(within(panel).getByRole('form', { name: 'Aprovar' })).getByLabelText(/Confirme sua senha/)).not.toBeDisabled();
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
      { url: `/api/approvals/${APPROVAL_ID}/approve`, body: { bindingDigest: approvalBindingDigest(binding), presentationDigest: PRESENTATION_DIGEST, proofId: 'P'.repeat(43) } },
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
    expect(await screen.findByText(/A aprovação está bloqueada; você pode rejeitá-la/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Aprovar' });
    expect(within(form).getByRole('button', { name: 'Aprovar esta operação' })).toBeDisabled();
    expect(within(form).getByLabelText(/Confirme sua senha/)).toBeDisabled();
  });

  /** Abre o detalhe e confere: parâmetros não exibidos, aprovar bloqueado, rejeitar habilitado. */
  async function expectBlocked(approval: ApprovalDetail, reason: RegExp) {
    mockApi({ ...base, approvals: [json(list([summary()]))], approvalDetail: [json({ approval })] });
    render(<App />);
    await openApprovals();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    const params = await screen.findByRole('region', { name: 'Parâmetros da operação' });
    const alert = within(params).getByRole('alert');
    expect(alert).toHaveTextContent(reason);
    expect(alert).toHaveTextContent('A aprovação está bloqueada; você pode rejeitá-la.');
    expect(within(params).queryByText(/Parâmetros conferidos/)).toBeNull();
    // Nenhum valor não conferido é exibido como parâmetro.
    expect(within(params).queryByRole('list', { name: 'Parâmetros exatos' })).toBeNull();
    expect(params).not.toHaveTextContent('registry.npmjs.org');
    const approve = screen.getByRole('form', { name: 'Aprovar' });
    expect(within(approve).getByRole('button', { name: 'Aprovar esta operação' })).toBeDisabled();
    const reject = screen.getByRole('form', { name: 'Rejeitar' });
    expect(within(reject).getByLabelText(/Confirme sua senha/)).not.toBeDisabled();
  }

  it('R1 — parâmetros ausentes: aprovar bloqueado, rejeitar disponível', async () => {
    await expectBlocked(detail({ presentable: false, presentation: null, presentationDigest: null, presentationIssue: 'presentation_missing' }), /não entregou os parâmetros exatos/);
  });

  it('R1 — divergência: parâmetros exibidos não reproduzem o resumo do vínculo (mesmo que o servidor diga "conferido")', async () => {
    const tampered: ApprovalPresentation = { kind: 'sandbox', params: { ...presentation.params, network: { default: 'deny', allow: ['evil.example.com'] } } } as ApprovalPresentation;
    await expectBlocked(detail({ presentation: tampered, presentationDigest: approvalPresentationDigest(approvalBindingDigest(binding), tampered) }), /não correspondem ao resumo registrado/);
  });

  it('R1 — representação incompleta (campo ausente) ou com campo desconhecido: bloqueia', async () => {
    const { inputs: _inputs, ...partial } = (presentation as Extract<ApprovalPresentation, { kind: 'sandbox' }>).params; // eslint-disable-line @typescript-eslint/no-unused-vars
    await expectBlocked(detail({ presentation: { kind: 'sandbox', params: partial } as unknown as ApprovalPresentation }), /incompletos ou em formato desconhecido/);
  });

  it('R1 — campo extra na apresentação: bloqueia', async () => {
    const extra = { kind: 'sandbox', params: { ...presentation.params, command: 'rm -rf /' } } as unknown as ApprovalPresentation;
    await expectBlocked(detail({ presentation: extra }), /incompletos ou em formato desconhecido/);
  });

  it('R1 — resumo da apresentação do servidor diferente do recalculado: bloqueia (digest coincidente do vínculo não basta)', async () => {
    await expectBlocked(detail({ presentationDigest: 'e'.repeat(64) }), /não correspondem ao resumo registrado/);
  });

  it('R1 — tipo de apresentação incompatível com o solicitante: bloqueia', async () => {
    await expectBlocked(detail({ requestedBy: { kind: 'system', id: 'limits' } }), /não correspondem ao resumo registrado/);
  });

  it('R1 — valor com aparência de credencial nos parâmetros: não é exibido e bloqueia', async () => {
    // Valor montado em tempo de execução: nenhum literal com formato de token fica no código.
    const fakeToken = ['gh', 'p_', 'A'.repeat(24)].join('');
    const leaked = { kind: 'sandbox', params: { ...presentation.params, inputs: [{ kind: 'issue', ref: fakeToken, trust: 'untrusted' }] } } as ApprovalPresentation;
    await expectBlocked(detail({ presentation: leaked }), /aparência de credencial/);
    expect(document.body.innerHTML).not.toContain(fakeToken);
  });

  it('R1 — rejeição de solicitação com apresentação incompleta envia só o vínculo registrado', async () => {
    const fetchMock = mockApi({
      ...base,
      approvals: [json(list([summary()]))],
      approvalDetail: [json({ approval: detail({ presentable: false, presentation: null, presentationDigest: null, presentationIssue: 'presentation_missing' }) })],
      stepUp: [json({ proofId: 'R'.repeat(43), expiresAt: '2026-11-15T12:05:00.000Z' })],
      approvalAction: [json({ approval: detail({ state: 'rejected', presentable: false, presentation: null, presentationDigest: null, presentationIssue: 'presentation_missing' }) })],
    });
    render(<App />);
    await openApprovals();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }));
    const form = await screen.findByRole('form', { name: 'Rejeitar' });
    await user.type(within(form).getByLabelText(/Confirme sua senha/), 'senha');
    await user.click(within(form).getByRole('button', { name: 'Rejeitar' }));
    expect(await screen.findByText('Solicitação rejeitada.')).toBeInTheDocument();
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init!.body)) }));
    expect(posts.at(-1)).toEqual({ url: `/api/approvals/${APPROVAL_ID}/reject`, body: { bindingDigest: approvalBindingDigest(binding), proofId: 'R'.repeat(43) } });
    expect(posts.some((p) => p.url.endsWith('/approve'))).toBe(false);
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
