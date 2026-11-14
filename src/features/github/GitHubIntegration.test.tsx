import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../../App';
import {
  apiError,
  configuredStatus,
  json,
  mockApi,
  snapshotFixture,
  snapshotReply,
} from '../../test/githubFixtures';

async function goTo(name: string) {
  const navigation = await screen.findByRole('navigation', { name: 'Navegação principal' });
  await userEvent.setup().click(within(navigation).getByRole('button', { name }));
}

describe('integração GitHub na interface', () => {
  it('mostra carregamento e depois os indicadores reais', async () => {
    mockApi({ status: [json(configuredStatus)], snapshot: [snapshotReply()] });
    render(<App />);

    // Primeiro a sessão é verificada; nada do GitHub é pedido antes disso.
    expect(screen.getByRole('status')).toHaveTextContent('Verificando sessão');
    expect(await screen.findByText('Dados reais do GitHub')).toBeInTheDocument();
    expect(screen.getByText('GitHub conectado')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Moreirapontocom-br/ai-command-center' })).toHaveAttribute(
      'href',
      'https://github.com/Moreirapontocom-br/ai-command-center',
    );

    const card = (label: string) => within(screen.getByRole('main')).getByText(label).closest('div')!;
    expect(card('Issues abertas')).toHaveTextContent('3');
    expect(card('Pull Requests abertos')).toHaveTextContent('2');
    expect(card('PRs aguardando revisão')).toHaveTextContent('1');
    expect(card('PRs incorporados (merge)')).toHaveTextContent('5');
    expect(card('Branches')).toHaveTextContent('4');
    expect(card('CI na branch padrão (main)')).toHaveTextContent('Sucesso');
    expect(screen.getByText(/Última sincronização bem-sucedida/)).toBeInTheDocument();

    // Os dados demonstrativos continuam identificados.
    expect(screen.getByRole('note')).toHaveTextContent(/Dados fictícios/);
  });

  it('credencial ausente: mantém o modo demonstração sem dados do GitHub', async () => {
    mockApi({ status: [json({ ...configuredStatus, configured: false, authMode: 'none' })] });
    render(<App />);
    expect(await screen.findByText('Credencial ausente')).toBeInTheDocument();
    expect(screen.getByText('Modo demonstração')).toBeInTheDocument();
    expect(screen.queryByText('Issues abertas')).not.toBeInTheDocument();
  });

  it('servidor indisponível: erro de rede com nova tentativa', async () => {
    const fetchMock = mockApi({
      status: [new TypeError('Failed to fetch'), json(configuredStatus)],
      snapshot: [snapshotReply()],
    });
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Erro de rede');

    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Dados reais do GitHub')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4); // sessão + status (falha) + status + snapshot
  });

  it.each([
    ['unauthorized', 502, 'Acesso negado'],
    ['forbidden', 502, 'Acesso negado'],
    ['rate_limited', 429, 'Limite de requisições'],
    ['network', 502, 'Erro de rede'],
    ['upstream_invalid', 502, 'Dados inesperados'],
  ] as const)('erro "%s" exibe "%s"', async (code, status, title) => {
    mockApi({ status: [json(configuredStatus)], snapshot: [apiError(code, status)] });
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(title);
    expect(within(alert).getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
    expect(screen.getByText('Modo demonstração')).toBeInTheDocument();
  });

  it('limite de requisições informa quando a cota volta', async () => {
    mockApi({
      status: [json(configuredStatus)],
      snapshot: [apiError('rate_limited', 429, { resetAt: '2026-11-10T21:00:00Z' })],
    });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/A cota será restaurada/);
  });

  it('dados desatualizados vindos do cache do servidor', async () => {
    mockApi({ status: [json(configuredStatus)], snapshot: [snapshotReply(snapshotFixture(), true)] });
    render(<App />);
    expect(await screen.findByText(/Dados desatualizados:/)).toBeInTheDocument();
    expect(screen.getByText('GitHub: dados desatualizados')).toBeInTheDocument();
  });

  it('atualização manual que falha mantém os dados e os marca como desatualizados', async () => {
    mockApi({ status: [json(configuredStatus)], snapshot: [snapshotReply(), apiError('network', 502)] });
    render(<App />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Atualizar' }));

    const banner = (await screen.findByText(/Dados desatualizados:/)).closest('[role="status"]');
    expect(banner).toHaveTextContent('falhou (erro de rede)');
    expect(screen.getByText('Issues abertas')).toBeInTheDocument();
  });

  it('atualização manual bem-sucedida pede dados novos ao servidor', async () => {
    const fetchMock = mockApi({
      status: [json(configuredStatus)],
      snapshot: [snapshotReply(), snapshotReply(snapshotFixture({ fetchedAt: '2026-11-10T21:45:00.000Z' }))],
    });
    render(<App />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Atualizar' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        '/api/repos/Moreirapontocom-br/ai-command-center/snapshot?refresh=1',
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(screen.getByText(/Última sincronização/).querySelector('time')).toHaveAttribute(
        'datetime',
        '2026-11-10T21:45:00.000Z',
      ),
    );
  });

  it('lista issues com número, título, repositório, estado, responsável, labels, data e link', async () => {
    mockApi({ status: [json(configuredStatus)], snapshot: [snapshotReply()] });
    render(<App />);
    await screen.findByText('Dados reais do GitHub');
    await goTo('Issues');

    const link = screen.getByRole('link', { name: /#42 Issue real simulada/ });
    expect(link).toHaveAttribute('href', 'https://github.com/Moreirapontocom-br/ai-command-center/issues/42');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const item = link.closest('li')!;
    expect(item).toHaveTextContent('Moreirapontocom-br/ai-command-center');
    expect(item).toHaveTextContent('Responsável: dev-a');
    expect(within(item).getByRole('list', { name: 'Labels' })).toHaveTextContent('enhancement');
    expect(within(item).getByText('Aberta')).toBeInTheDocument();
    expect(item.querySelector('time')).toHaveAttribute('datetime', '2026-11-10T18:00:00Z');

    const closed = screen.getByRole('link', { name: /#41/ }).closest('li')!;
    expect(closed).toHaveTextContent('Sem responsável');
    expect(closed).toHaveTextContent('Fechada (não planejada)');

    // Nenhuma issue é atribuída automaticamente a um agente de IA.
    const main = screen.getByRole('main');
    for (const agent of ['ChatGPT', 'Claude Code', 'Gemini']) {
      expect(main).not.toHaveTextContent(agent);
    }
  });

  it('repositório sem issues mostra estado vazio', async () => {
    mockApi({
      status: [json(configuredStatus)],
      snapshot: [snapshotReply(snapshotFixture({ issues: [], metrics: { ...snapshotFixture().metrics, openIssues: 0 } }))],
    });
    render(<App />);
    await screen.findByText('Dados reais do GitHub');
    await goTo('Issues');
    expect(screen.getByText('Nenhuma issue aberta neste repositório.')).toBeInTheDocument();
  });

  it('diferencia PR draft, pronto, incorporado e fechado sem merge', async () => {
    mockApi({ status: [json(configuredStatus)], snapshot: [snapshotReply()] });
    render(<App />);
    await screen.findByText('Dados reais do GitHub');
    await goTo('Pull Requests');

    const item = (n: number) => screen.getByRole('link', { name: new RegExp(`^#${n} `) }).closest('li')!;
    expect(item(3)).toHaveTextContent('Draft');
    expect(item(3)).not.toHaveTextContent('Aguardando revisão');
    expect(item(2)).toHaveTextContent('Pronto para revisão');
    expect(item(2)).toHaveTextContent('Aguardando revisão');
    expect(item(2)).toHaveTextContent('feature/002-github-integration → main');
    expect(item(2)).toHaveTextContent('CI: sucesso');
    expect(item(1)).toHaveTextContent('Incorporado');
    expect(item(4)).toHaveTextContent('Fechado sem merge');
    expect(item(4)).toHaveTextContent('CI: sem informação');
  });

  it('lista branches com commit HEAD', async () => {
    mockApi({ status: [json(configuredStatus)], snapshot: [snapshotReply()] });
    render(<App />);
    await screen.findByText('Dados reais do GitHub');
    await goTo('Branches');
    expect(screen.getByRole('heading', { name: 'Branches (4)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'bbbbbbb' })).toHaveAttribute(
      'href',
      `https://github.com/Moreirapontocom-br/ai-command-center/commit/${'b'.repeat(40)}`,
    );
    expect(screen.getByText('Padrão')).toBeInTheDocument();
  });

  it('páginas do GitHub não mostram dados fictícios quando a integração está fora do ar', async () => {
    render(<App />); // fetch padrão dos testes: rede indisponível
    await goTo('Pull Requests');
    expect(await screen.findByRole('alert')).toHaveTextContent('Erro de rede');
    expect(within(screen.getByRole('main')).queryByRole('list')).not.toBeInTheDocument();
  });
});
