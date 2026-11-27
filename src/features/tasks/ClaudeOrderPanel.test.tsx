import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeOrderListResponse, ClaudeOrderView } from '../../../shared/contracts.ts';
import { ClaudeOrderPanel, MERGE_NOTICE, OUTSIDE_NOTICE } from './ClaudeOrderPanel';

/** Issue #008 — interface mínima das ordens do Claude Code (fluxo assistido). */

const PROJECT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const TASK = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ORDER = '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c';
const REPO = 'Moreirapontocom-br/ai-command-center';

function order(overrides: Partial<ClaudeOrderView> = {}): ClaudeOrderView {
  return {
    orderId: ORDER,
    projectId: PROJECT,
    taskId: TASK,
    agentId: 'claude-code',
    repository: REPO,
    baseSha: 'b'.repeat(40),
    workBranch: `agent/claude-code/${TASK.slice(0, 8)}-${ORDER.slice(0, 8)}`,
    inputDigest: 'd'.repeat(64),
    criteriaCount: 1,
    dataRefs: [{ kind: 'task', ref: TASK }],
    createdAt: '2026-11-19T12:00:00Z',
    state: 'awaiting_approval',
    stateReason: null,
    scope: { id: ORDER, state: 'awaiting_approval', validUntil: null, approvalDeadline: '2026-11-20T12:00:00Z', policyVersion: '2026-11-19.2' },
    approvals: [
      { action: 'agent.invoke', approvalId: 'a1', state: 'approved' },
      { action: 'data.send_external', approvalId: 'a2', state: 'approved' },
    ],
    package: null,
    forwardedAt: null,
    pullRequest: null,
    verification: { latest: null, current: false, staleReason: null, observedHeadSha: null, observedAt: null, used: 0, max: 50, nextAllowedAt: null },
    history: [],
    closed: false,
    bridge: null,
    ...overrides,
  };
}
const NO_BRIDGE = { enabled: false, endpoint: null, credential: null };
const list = (orders: ClaudeOrderView[], enabled = true, bridge: ClaudeOrderListResponse['bridge'] = NO_BRIDGE): ClaudeOrderListResponse => ({
  gateway: { state: 'available', reason: null },
  enablement: { enabled, repository: enabled ? REPO : null, at: null },
  linkableRepositories: [REPO],
  orders,
  bridge,
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function mockFetch(routes: Record<string, Array<() => Response>>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    const next = routes[key]?.shift();
    if (!next) throw new Error(`sem resposta para ${key}`);
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

async function openPanel() {
  render(<ClaudeOrderPanel projectId={PROJECT} taskId={TASK} />);
  await userEvent.setup().click(screen.getByText('Ordens para Claude Code (fluxo assistido)'));
}

describe('painel de ordens do Claude Code', () => {
  it('mostra os avisos fixos e nunca afirma execução dentro do ACC', async () => {
    mockFetch({ [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([]))] });
    await openPanel();
    expect(await screen.findByText(new RegExp(OUTSIDE_NOTICE.replace(/[.;]/g, '.')))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(MERGE_NOTICE.replace('.', '\\.')))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Claude Code est[aá] (trabalhando|executando)|executando no ACC/i);
    expect(screen.getByRole('button', { name: 'Preparar ordem para Claude Code' })).toBeDisabled();
  });

  it('projeto não habilitado: oferece habilitar com confirmação de senha (sem criar ordem)', async () => {
    mockFetch({ [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([], false))] });
    await openPanel();
    expect(await screen.findByRole('form', { name: 'Habilitar o Claude Code neste projeto' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Preparar ordem para Claude Code' })).not.toBeInTheDocument();
  });

  it('prepara a ordem enviando só objetivo, critérios e uma chave de idempotência', async () => {
    const fetchMock = mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([])), () => reply(list([order()]))],
      [`POST /api/projects/${PROJECT}/tasks/${TASK}/claude-orders`]: [() => reply({ order: order() }, 201)],
    });
    await openPanel();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Objetivo/), 'Implementar X');
    await user.type(screen.getByLabelText(/Critérios de aceite/), 'Testes passam{enter}Lint limpo');
    await user.click(screen.getByRole('button', { name: 'Preparar ordem para Claude Code' }));
    await screen.findByText('Aguardando aprovações');
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const body = JSON.parse(String(post[1]!.body));
    expect(Object.keys(body).sort()).toEqual(['acceptanceCriteria', 'idempotencyKey', 'objective']);
    expect(body).toMatchObject({ objective: 'Implementar X', acceptanceCriteria: ['Testes passam', 'Lint limpo'] });
  });

  it('libera e mostra o pacote após confirmar a identidade; depois permite informar o PR', async () => {
    const delivered = order({ state: 'delivered', package: { digest: 'e'.repeat(64), releasedAt: '2026-11-19T12:05:00Z', relayDeadline: '2026-11-20T12:05:00Z' } });
    const fetchMock = mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([order()])), () => reply(list([delivered]))],
      ['POST /api/approvals/step-up']: [() => reply({ proofId: 'p1', expiresAt: '2026-11-19T12:10:00Z' })],
      [`POST /api/claude-orders/${ORDER}/package`]: [() => reply({ order: delivered, package: 'ACC — Ordem de trabalho para o Claude Code' })],
    });
    await openPanel();
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: 'Liberar e copiar o pacote' });
    await user.type(within(form).getByLabelText(/Confirme sua senha/), 'senha');
    await user.click(within(form).getByRole('button', { name: 'Liberar pacote' }));
    expect(await screen.findByLabelText('Pacote da ordem')).toHaveValue('ACC — Ordem de trabalho para o Claude Code');
    expect(JSON.parse(String(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/package'))![1]!.body))).toEqual({ proofId: 'p1' });
    await waitFor(() => expect(screen.getByRole('form', { name: 'Informar o PR' })).toBeInTheDocument());
  });

  it('verifica o PR e mostra regras, checks e a cabeça a que o resultado se refere', async () => {
    const linked = order({ state: 'pr_linked', pullRequest: { number: 7, reference: `${REPO}#7`, url: `https://github.com/${REPO}/pull/7`, linkedAt: '2026-11-19T12:06:00Z' } });
    const entry = { id: 'v-1', seq: 1, headSha: 'a1'.repeat(20), baseSha: 'b'.repeat(40), verdict: 'conforming' as const, rules: [], supersedes: null, checkedAt: '2026-11-19T12:07:00Z', closes: false, reason: null };
    const verified = { ...linked, state: 'verified' as const, verification: { ...linked.verification, latest: entry, current: true, observedHeadSha: entry.headSha, observedAt: entry.checkedAt, used: 1 }, history: [entry] };
    mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([linked])), () => reply(list([verified]))],
      [`POST /api/claude-orders/${ORDER}/verify`]: [
        () =>
          reply({
            order: verified,
            outcome: {
              headSha: 'a1'.repeat(20),
              verdict: 'conforming',
              created: true,
              rules: [{ rule: 'V6', result: 'ok', reason: null }],
              alerts: [],
              checks: { state: 'SUCCESS', failing: [], pending: [], total: 3 },
              commits: { total: 2, listed: 2, truncated: false, authors: [{ author: 'po', committer: 'po', signatureValid: null }] },
              files: { total: 2, complete: true, forbidden: [] },
              state: { isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, prState: 'OPEN' },
              compare: { status: 'ahead', aheadBy: 2, behindBy: 0 },
            },
          }),
      ],
    });
    await openPanel();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verificar PR (somente leitura)' }));
    expect(await screen.findByText(/V6 — Ancestralidade do SHA base comprovada/)).toBeInTheDocument();
    expect(screen.getAllByText(/a1a1a1a1a1a1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Checks: SUCCESS/)).toBeInTheDocument();
    // A conformidade nunca aparece como permanente: vale para este HEAD e por pouco tempo.
    expect(await screen.findByText(/vale só para este HEAD, lido há menos de 5 min/)).toBeInTheDocument();
  });

  it('erro do servidor aparece com a mensagem pública (sem detalhes internos)', async () => {
    mockFetch({ [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply({ error: { code: 'gateway_unavailable', message: 'x' } }, 503)] });
    await openPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Gateway indisponível');
  });
});

/** Issue #055 — ponte MCP local na interface mínima. */
describe('ponte MCP local no painel', () => {
  const CREDENTIAL = { id: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f', projectId: PROJECT, agentId: 'claude-code' as const, createdAt: '2026-11-19T12:00:00Z', expiresAt: '2026-12-19T12:00:00Z', state: 'active' as const, revokedAt: null, revokedReason: null };
  const ENDPOINT = 'http://127.0.0.1:8787/mcp';
  const bridgeOn = (credential: typeof CREDENTIAL | null = CREDENTIAL) => ({ enabled: true, endpoint: ENDPOINT, credential });
  const stepUp = () => reply({ proofId: 'p1', expiresAt: '2026-11-19T12:10:00Z' });
  async function confirmIn(formName: string, button: string) {
    const user = userEvent.setup();
    const form = await screen.findByRole('form', { name: formName });
    await user.type(within(form).getByLabelText(/Confirme sua senha/), 'senha');
    await user.click(within(form).getByRole('button', { name: button }));
  }

  it('ponte desligada no servidor: avisa e mantém o fluxo manual (sem botão de disponibilizar)', async () => {
    mockFetch({ [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([order()]))] });
    await openPanel();
    expect(await screen.findByText(/Ponte MCP local desligada neste servidor/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Disponibilizar ao Claude Code (ponte MCP)' })).not.toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Liberar e copiar o pacote' })).toBeInTheDocument();
  });

  it('cria a credencial (step-up) e mostra o comando UMA vez; o token não fica na listagem', async () => {
    const fetchMock = mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([], true, bridgeOn(null))), () => reply(list([], true, bridgeOn()))],
      ['POST /api/approvals/step-up']: [stepUp],
      [`POST /api/projects/${PROJECT}/claude-bridge/credentials`]: [() => reply({ credential: CREDENTIAL, token: 'TOKEN-DE-TESTE', command: 'claude mcp add --transport http --scope local acc ENDERECO TOKEN-DE-TESTE' }, 201)],
    });
    await openPanel();
    expect(await screen.findByText('nenhuma')).toBeInTheDocument();
    await confirmIn('Criar a credencial da ponte', 'Criar credencial');
    expect(await screen.findByLabelText('Comando do Claude Code')).toHaveValue('claude mcp add --transport http --scope local acc ENDERECO TOKEN-DE-TESTE');
    expect(screen.getByText(/o token não será mostrado de novo/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/claude-bridge/credentials'))!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ validityDays: 30, proofId: 'p1' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Ocultar' }));
    expect(screen.queryByLabelText('Comando do Claude Code')).not.toBeInTheDocument();
    expect(await screen.findByRole('form', { name: 'Revogar a credencial da ponte' })).toBeInTheDocument();
  });

  it('disponibiliza a ordem ao Claude Code (step-up), sem mostrar pacote; o fluxo manual fica como contingência', async () => {
    const offered = order({ state: 'delivered', package: { digest: 'e'.repeat(64), releasedAt: '2026-11-19T12:05:00Z', relayDeadline: '2026-11-20T12:05:00Z' }, bridge: { offeredAt: '2026-11-19T12:05:00Z', claim: null, proposal: null, proposals: 0, maxProposals: 5 } });
    const fetchMock = mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([order()], true, bridgeOn())), () => reply(list([offered], true, bridgeOn()))],
      ['POST /api/approvals/step-up']: [stepUp],
      [`POST /api/claude-orders/${ORDER}/offer`]: [() => reply({ order: offered })],
    });
    await openPanel();
    expect(await screen.findByText('Contingência: fluxo manual')).toBeInTheDocument();
    await confirmIn('Disponibilizar ao Claude Code (ponte MCP)', 'Disponibilizar ao Claude Code');
    expect(await screen.findByText(/aguardando o recebimento pelo Claude Code/)).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/offer'))![1]!.body))).toEqual({ proofId: 'p1' });
    expect(screen.queryByLabelText('Pacote da ordem')).not.toBeInTheDocument();
    // Disponibilizada à ponte: o pacote manual deixa de ser oferecido.
    expect(screen.queryByRole('form', { name: 'Liberar e copiar o pacote' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Marcar como encaminhado ao Claude Code' })).not.toBeInTheDocument();
  });

  it('mostra o PR proposto e o confirma com step-up; o resultado da verificação aparece para o HEAD lido', async () => {
    const proposal = { id: '0b1c2d3e-4f50-4a61-8b72-c3d4e5f60718', number: 7, reference: `${REPO}#7`, url: `https://github.com/${REPO}/pull/7`, proposedAt: '2026-11-19T12:20:00Z', status: 'pending' as const };
    const claimed = order({ state: 'awaiting_pr', package: { digest: 'e'.repeat(64), releasedAt: '2026-11-19T12:05:00Z', relayDeadline: '2026-11-20T12:05:00Z' }, bridge: { offeredAt: '2026-11-19T12:05:00Z', claim: { id: 'c1', at: '2026-11-19T12:06:00Z', credentialId: CREDENTIAL.id }, proposal, proposals: 1, maxProposals: 5 } });
    const linked = { ...claimed, state: 'verified' as const, pullRequest: { number: 7, reference: `${REPO}#7`, url: proposal.url, linkedAt: '2026-11-19T12:21:00Z' }, bridge: { ...claimed.bridge!, proposal: { ...proposal, status: 'confirmed' as const } } };
    const fetchMock = mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([claimed], true, bridgeOn())), () => reply(list([linked], true, bridgeOn()))],
      ['POST /api/approvals/step-up']: [stepUp],
      [`POST /api/claude-orders/${ORDER}/confirm-pr`]: [
        () =>
          reply({
            order: linked,
            verificationError: null,
            outcome: {
              headSha: 'a1'.repeat(20),
              verdict: 'conforming',
              created: true,
              rules: [{ rule: 'V3', result: 'ok', reason: null }],
              alerts: [],
              checks: { state: 'SUCCESS', failing: [], pending: [], total: 3 },
              commits: { total: 1, listed: 1, truncated: false, authors: [] },
              files: { total: 1, complete: true, forbidden: [] },
              state: { isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null, prState: 'OPEN' },
              compare: { status: 'ahead', aheadBy: 1, behindBy: 0 },
            },
          }),
      ],
    });
    await openPanel();
    expect(await screen.findByText(/recebida em/)).toBeInTheDocument();
    expect(screen.getByText(/aguardando sua confirmação/)).toBeInTheDocument();
    await confirmIn('Confirmar o PR proposto e verificar', 'Confirmar PR e verificar');
    expect(await screen.findByText(/V3 — Branch de origem = branch designada/)).toBeInTheDocument();
    expect(screen.getAllByText(/a1a1a1a1a1a1/).length).toBeGreaterThan(0);
    expect(JSON.parse(String(fetchMock.mock.calls.find(([input]) => String(input).endsWith('/confirm-pr'))![1]!.body))).toEqual({ proposalId: proposal.id, proofId: 'p1' });
  });

  it('verificação indisponível na confirmação: o vínculo é informado e o erro aparece com mensagem pública', async () => {
    const proposal = { id: '0b1c2d3e-4f50-4a61-8b72-c3d4e5f60718', number: 7, reference: `${REPO}#7`, url: `https://github.com/${REPO}/pull/7`, proposedAt: '2026-11-19T12:20:00Z', status: 'pending' as const };
    const claimed = order({ state: 'awaiting_pr', package: { digest: 'e'.repeat(64), releasedAt: '2026-11-19T12:05:00Z', relayDeadline: '2026-11-20T12:05:00Z' }, bridge: { offeredAt: '2026-11-19T12:05:00Z', claim: { id: 'c1', at: '2026-11-19T12:06:00Z', credentialId: CREDENTIAL.id }, proposal, proposals: 1, maxProposals: 5 } });
    const linked = { ...claimed, state: 'pr_linked' as const, pullRequest: { number: 7, reference: `${REPO}#7`, url: proposal.url, linkedAt: '2026-11-19T12:21:00Z' } };
    mockFetch({
      [`GET /api/projects/${PROJECT}/claude-orders`]: [() => reply(list([claimed], true, bridgeOn())), () => reply(list([linked], true, bridgeOn()))],
      ['POST /api/approvals/step-up']: [stepUp],
      [`POST /api/claude-orders/${ORDER}/confirm-pr`]: [() => reply({ order: linked, verificationError: 'github_unavailable', outcome: null })],
    });
    await openPanel();
    await confirmIn('Confirmar o PR proposto e verificar', 'Confirmar PR e verificar');
    expect(await screen.findByText(/PR vinculado; a verificação não foi concluída agora/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('GitHub');
  });
});
