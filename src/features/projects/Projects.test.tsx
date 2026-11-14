import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../../App';
import {
  apiError,
  configuredStatus,
  json,
  mockApi,
  PROJECT_ID,
  projectFixture,
  projectList,
  snapshotReply,
} from '../../test/githubFixtures';

const REPO = 'Moreirapontocom-br/ai-command-center';
const SECOND_ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const noGitHub = projectFixture({ id: SECOND_ID, name: 'Livro de receitas', repositories: [], status: 'planning' });

async function goTo(name: string) {
  const navigation = await screen.findByRole('navigation', { name: 'Navegação principal' });
  await userEvent.setup().click(within(navigation).getByRole('button', { name }));
}

function bodiesOf(fetchMock: ReturnType<typeof mockApi>, path: string) {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === path && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)));
}

describe('gerenciamento de projetos na interface', () => {
  it('lista projetos com estado, ativo e vínculo GitHub opcional', async () => {
    mockApi({
      projects: [json(projectList({ projects: [projectFixture(), noGitHub] }))],
      status: [json(configuredStatus)],
      snapshot: [snapshotReply()],
    });
    render(<App />);
    await goTo('Projetos');

    const active = await screen.findByRole('article', { name: 'AI Command Center' });
    expect(active).toHaveTextContent('Em andamento');
    expect(active).toHaveTextContent('Ativo');
    expect(active).toHaveTextContent(`GitHub: ${REPO}`);
    const other = screen.getByRole('article', { name: 'Livro de receitas' });
    expect(other).toHaveTextContent('Planejamento');
    expect(other).toHaveTextContent('Sem repositório GitHub');
    expect(within(other).getByRole('button', { name: 'Tornar ativo' })).toBeInTheDocument();
  });

  it('cria projeto sem GitHub; o primeiro criado vira o ativo', async () => {
    const created = projectFixture({ id: SECOND_ID, name: 'Pesquisa', objective: 'Validar', repositories: [], status: 'planning' });
    const fetchMock = mockApi({
      projects: [json(projectList({ projects: [], activeProjectId: null }))],
      createProject: [json(created, 201)],
      selectProject: [json({ activeProjectId: SECOND_ID })],
    });
    render(<App />);
    expect(await screen.findByText('Nenhum projeto selecionado')).toBeInTheDocument();
    await goTo('Projetos');
    const user = userEvent.setup();
    expect(await screen.findByText(/Nenhum projeto ainda/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Novo projeto' }));
    const form = screen.getByRole('region', { name: 'Novo projeto' });
    await user.type(within(form).getByLabelText(/Nome/), 'Pesquisa');
    await user.type(within(form).getByLabelText('Objetivo'), 'Validar');
    await user.click(within(form).getByRole('button', { name: 'Criar projeto' }));

    const card = await screen.findByRole('article', { name: 'Pesquisa' });
    await waitFor(() => expect(card).toHaveTextContent('Ativo'));
    expect(bodiesOf(fetchMock, '/api/projects')).toEqual([
      { name: 'Pesquisa', description: '', objective: 'Validar', status: 'planning', repositories: [] },
    ]);
    expect(bodiesOf(fetchMock, '/api/projects/active')).toEqual([{ projectId: SECOND_ID }]);
    // Projeto sem GitHub: nenhuma consulta de snapshot.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/snapshot'))).toBe(false);
  });

  it('nome em branco não é enviado', async () => {
    const fetchMock = mockApi({ projects: [json(projectList({ projects: [], activeProjectId: null }))] });
    render(<App />);
    await goTo('Projetos');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Novo projeto' }));
    await user.click(screen.getByRole('button', { name: 'Criar projeto' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Informe o nome do projeto.');
    expect(bodiesOf(fetchMock, '/api/projects')).toEqual([]);
  });

  it('edita estado e vincula repositório autorizado', async () => {
    const updated = { ...noGitHub, status: 'active' as const, repositories: [REPO] };
    const fetchMock = mockApi({
      projects: [json(projectList({ projects: [noGitHub], activeProjectId: null }))],
      updateProject: [json(updated)],
    });
    render(<App />);
    await goTo('Projetos');
    const user = userEvent.setup();
    const card = await screen.findByRole('article', { name: 'Livro de receitas' });
    await user.click(within(card).getByRole('button', { name: 'Editar' }));

    const form = screen.getByRole('region', { name: 'Editar Livro de receitas' });
    await user.selectOptions(within(form).getByLabelText('Estado'), 'active');
    await user.click(within(form).getByRole('checkbox', { name: REPO }));
    await user.click(within(form).getByRole('button', { name: 'Salvar alterações' }));

    expect(await screen.findByRole('article', { name: 'Livro de receitas' })).toHaveTextContent(`GitHub: ${REPO}`);
    expect(bodiesOf(fetchMock, `/api/projects/${SECOND_ID}`)).toEqual([
      { name: 'Livro de receitas', description: 'Painel de projetos', objective: 'MVP', status: 'active', repositories: [REPO] },
    ]);
  });

  it('erro do servidor ao salvar é exibido e o formulário continua aberto', async () => {
    mockApi({
      projects: [json(projectList({ projects: [], activeProjectId: null }))],
      createProject: [apiError('repository_not_allowed', 422)],
    });
    render(<App />);
    await goTo('Projetos');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Novo projeto' }));
    await user.type(screen.getByLabelText(/Nome/), 'X');
    await user.click(screen.getByRole('button', { name: 'Criar projeto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Só é possível vincular repositórios da lista autorizada');
    expect(screen.getByRole('region', { name: 'Novo projeto' })).toBeInTheDocument();
  });

  it('trocar o projeto ativo no cabeçalho isola os painéis: dados do anterior somem', async () => {
    const fetchMock = mockApi({
      projects: [json(projectList({ projects: [projectFixture(), noGitHub] }))],
      status: [json(configuredStatus)],
      snapshot: [snapshotReply()],
      selectProject: [json({ activeProjectId: SECOND_ID })],
    });
    render(<App />);
    expect(await screen.findByText('Dados reais do GitHub')).toBeInTheDocument();

    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Projeto ativo' }), SECOND_ID);

    expect(await screen.findByText('Projeto sem repositório GitHub')).toBeInTheDocument();
    expect(screen.queryByText('Dados reais do GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Issues abertas')).not.toBeInTheDocument();
    expect(screen.getByText('Sem GitHub')).toBeInTheDocument();
    expect(bodiesOf(fetchMock, '/api/projects/active')).toEqual([{ projectId: SECOND_ID }]);
    // O snapshot foi pedido uma única vez, pelo projeto que tinha repositório.
    const snapshotCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/snapshot'));
    expect(snapshotCalls.map(([input]) => String(input))).toEqual([
      `/api/projects/${PROJECT_ID}/repositories/${REPO}/snapshot`,
    ]);
  });

  it('sessão expirada ao listar projetos volta para o login', async () => {
    mockApi({
      session: [json({ authenticated: true, user: { email: 'admin@example.test' }, expiresAt: '2026-11-14T00:00:00Z' }), json({ authenticated: false, authConfigured: true })],
      projects: [apiError('unauthenticated', 401)],
    });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
  });

  it('servidor fora do ar: projetos indisponíveis, sem dados inventados', async () => {
    render(<App />); // fetch padrão dos testes: rede indisponível
    await goTo('Projetos');
    expect(await screen.findByRole('alert')).toHaveTextContent('Projetos indisponíveis');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
