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
    ...overrides,
  };
}
const list = (orders: ClaudeOrderView[], enabled = true): ClaudeOrderListResponse => ({ gateway: { state: 'available', reason: null }, enablement: { enabled, repository: enabled ? REPO : null, at: null }, linkableRepositories: [REPO], orders });
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
