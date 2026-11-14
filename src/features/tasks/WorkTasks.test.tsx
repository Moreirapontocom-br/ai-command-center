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
  taskFixture,
  taskList,
} from '../../test/githubFixtures';

const REPO = 'Moreirapontocom-br/ai-command-center';
const T1 = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const T2 = '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c';
const OTHER_PROJECT = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';

async function openTasks() {
  const navigation = await screen.findByRole('navigation', { name: 'Navegação principal' });
  await userEvent.setup().click(within(navigation).getByRole('button', { name: 'Tarefas' }));
}

function posts(fetchMock: ReturnType<typeof mockApi>, path: string) {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === path && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init!.body)));
}

const base = { status: [json(configuredStatus)], snapshot: [snapshotReply()] };

describe('tarefas do projeto ativo', () => {
  it('lista tarefas com status, prioridade, responsável, dependências, referências e conclusão confirmada', async () => {
    mockApi({
      ...base,
      tasks: [
        json(
          taskList({
            tasks: [
              taskFixture({ id: T1, title: 'Modelar dados', status: 'done', priority: 'high', completion: { confirmedBy: 'admin', confirmedAt: '2026-11-13T13:00:00Z' } }),
              taskFixture({
                id: T2,
                title: 'Implementar API',
                priority: 'critical',
                dependsOn: [T1],
                assignee: { kind: 'agent', agentId: 'claude-code' },
                references: [{ kind: 'pull_request', repository: REPO, number: 38 }],
              }),
            ],
          }),
        ),
      ],
    });
    render(<App />);
    await openTasks();

    const done = await screen.findByRole('article', { name: 'Modelar dados' });
    expect(done).toHaveTextContent('Concluída');
    expect(done).toHaveTextContent('Conclusão confirmada por admin@example.test');
    const api = screen.getByRole('article', { name: 'Implementar API' });
    expect(api).toHaveTextContent('Prioridade crítica');
    expect(api).toHaveTextContent('Claude Code (agente)');
    expect(api).toHaveTextContent('nenhuma execução foi iniciada');
    expect(api).toHaveTextContent('Depende de:Modelar dados — Concluída');
    expect(within(api).getByRole('link', { name: 'PR #38' })).toHaveAttribute('href', `https://github.com/${REPO}/pull/38`);
  });

  it('cria tarefa atribuída a agente com dependência; status inicial pendente', async () => {
    const created = taskFixture({ id: T2, title: 'Nova', assignee: { kind: 'agent', agentId: 'gemini' }, dependsOn: [T1] });
    const fetchMock = mockApi({
      ...base,
      tasks: [json(taskList({ tasks: [taskFixture({ id: T1, title: 'Base' })] }))],
      createTask: [json(created, 201)],
    });
    render(<App />);
    await openTasks();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Nova tarefa' }));
    const form = screen.getByRole('region', { name: 'Nova tarefa' });
    await user.type(within(form).getByLabelText(/Título/), 'Nova');
    await user.selectOptions(within(form).getByLabelText('Responsável'), 'agent:gemini');
    expect(form).toHaveTextContent('Atribuir a um agente não inicia nenhuma execução');
    await user.click(within(form).getByRole('checkbox', { name: 'Base' }));
    await user.click(within(form).getByRole('button', { name: 'Criar tarefa' }));

    expect(await screen.findByRole('article', { name: 'Nova' })).toBeInTheDocument();
    expect(posts(fetchMock, `/api/projects/${PROJECT_ID}/tasks`)).toEqual([
      {
        title: 'Nova',
        description: '',
        priority: 'medium',
        assignee: { kind: 'agent', agentId: 'gemini' },
        dependsOn: [T1],
        references: [],
        status: 'pending',
      },
    ]);
  });

  it('o formulário de criação só oferece status inicial pendente ou planejada', async () => {
    mockApi({ ...base });
    render(<App />);
    await openTasks();
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Nova tarefa' }));
    const options = within(screen.getByLabelText('Status inicial')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Pendente', 'Planejada']);
  });

  it('mudança de status oferece só transições permitidas e mostra o erro do servidor', async () => {
    const fetchMock = mockApi({
      ...base,
      tasks: [json(taskList({ tasks: [taskFixture({ id: T1, title: 'Base' }), taskFixture({ id: T2, title: 'Depende', dependsOn: [T1] })] }))],
      updateTask: [apiError('dependencies_unresolved', 409)],
    });
    render(<App />);
    await openTasks();
    const card = await screen.findByRole('article', { name: 'Depende' });
    expect(card).toHaveTextContent('Aguardando 1 dependência(s)');
    const select = within(card).getByLabelText('Mudar status de Depende');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Selecione…', 'Planejada', 'Em andamento', 'Bloqueada', 'Cancelada',
    ]);
    await userEvent.setup().selectOptions(select, 'in_progress');
    expect(await within(card).findByRole('alert')).toHaveTextContent('Conclua ou cancele as tarefas das quais esta depende');
    expect(posts(fetchMock, `/api/projects/${PROJECT_ID}/tasks/${T2}`)).toEqual([{ status: 'in_progress' }]);
    expect(card).toHaveTextContent('Pendente'); // nada muda sem confirmação do servidor
  });

  it('bloquear pede motivo antes de enviar', async () => {
    const fetchMock = mockApi({
      ...base,
      tasks: [json(taskList({ tasks: [taskFixture({ id: T1, title: 'Base' })] }))],
      updateTask: [json(taskFixture({ id: T1, title: 'Base', status: 'blocked', blockedReason: 'Aguardando credencial' }))],
    });
    render(<App />);
    await openTasks();
    const user = userEvent.setup();
    const card = await screen.findByRole('article', { name: 'Base' });
    await user.selectOptions(within(card).getByLabelText('Mudar status de Base'), 'blocked');
    await user.click(within(card).getByRole('button', { name: 'Bloquear' }));
    expect(within(card).getByRole('alert')).toHaveTextContent('Informe o motivo do bloqueio.');
    await user.type(within(card).getByLabelText('Motivo do bloqueio'), 'Aguardando credencial');
    await user.click(within(card).getByRole('button', { name: 'Bloquear' }));
    expect(await within(card).findByText('Aguardando credencial')).toBeInTheDocument();
    expect(posts(fetchMock, `/api/projects/${PROJECT_ID}/tasks/${T1}`)).toEqual([
      { status: 'blocked', blockedReason: 'Aguardando credencial' },
    ]);
  });

  it('concluir tarefa de agente sem evidência mostra o bloqueio do servidor', async () => {
    mockApi({
      ...base,
      tasks: [json(taskList({ tasks: [taskFixture({ id: T1, title: 'Agente', status: 'in_progress', assignee: { kind: 'agent', agentId: 'claude-code' } })] }))],
      updateTask: [apiError('evidence_required', 422)],
    });
    render(<App />);
    await openTasks();
    const card = await screen.findByRole('article', { name: 'Agente' });
    await userEvent.setup().selectOptions(within(card).getByLabelText('Mudar status de Agente'), 'done');
    expect(await within(card).findByRole('alert')).toHaveTextContent('referência a PR ou branch como evidência');
    expect(card).toHaveTextContent('Em andamento');
  });

  it('filtra por status, prioridade e responsável', async () => {
    mockApi({
      ...base,
      tasks: [
        json(
          taskList({
            tasks: [
              taskFixture({ id: T1, title: 'Alta humana', priority: 'high', assignee: { kind: 'human', userId: 'admin' } }),
              taskFixture({ id: T2, title: 'Baixa agente', priority: 'low', status: 'planned', assignee: { kind: 'agent', agentId: 'chatgpt' } }),
            ],
          }),
        ),
      ],
    });
    render(<App />);
    await openTasks();
    const user = userEvent.setup();
    await screen.findByRole('article', { name: 'Alta humana' });
    const filters = screen.getByRole('region', { name: 'Filtros' });

    await user.selectOptions(within(filters).getByLabelText('Prioridade'), 'low');
    expect(screen.queryByRole('article', { name: 'Alta humana' })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Baixa agente' })).toBeInTheDocument();

    await user.selectOptions(within(filters).getByLabelText('Prioridade'), '');
    await user.selectOptions(within(filters).getByLabelText('Responsável'), 'human:admin');
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'))).toEqual(['Alta humana']);

    await user.selectOptions(within(filters).getByLabelText('Responsável'), '');
    await user.selectOptions(within(filters).getByLabelText('Status'), 'done');
    expect(screen.getByText('Nenhuma tarefa corresponde aos filtros.')).toBeInTheDocument();
  });

  it('edita tarefa e adiciona referência ao repositório do projeto', async () => {
    const fetchMock = mockApi({
      ...base,
      tasks: [json(taskList({ tasks: [taskFixture({ id: T1, title: 'Base' })] }))],
      updateTask: [json(taskFixture({ id: T1, title: 'Base', references: [{ kind: 'pull_request', repository: REPO, number: 40 }] }))],
    });
    render(<App />);
    await openTasks();
    const user = userEvent.setup();
    await user.click(within(await screen.findByRole('article', { name: 'Base' })).getByRole('button', { name: 'Editar' }));
    const form = screen.getByRole('region', { name: 'Editar Base' });
    expect(within(form).queryByLabelText('Status inicial')).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText('Número'), '40');
    await user.click(within(form).getByRole('button', { name: 'Adicionar referência' }));
    await user.click(within(form).getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('link', { name: 'PR #40' })).toBeInTheDocument();
    expect(posts(fetchMock, `/api/projects/${PROJECT_ID}/tasks/${T1}`)[0].references).toEqual([
      { kind: 'pull_request', repository: REPO, number: 40 },
    ]);
  });

  it('trocar de projeto troca a lista (sem misturar tarefas)', async () => {
    const fetchMock = mockApi({
      ...base,
      projects: [json(projectList({ projects: [projectFixture(), projectFixture({ id: OTHER_PROJECT, name: 'Outro', repositories: [] })] }))],
      tasks: [json(taskList({ tasks: [taskFixture({ title: 'Do primeiro' })] })), json(taskList({ tasks: [] }))],
      selectProject: [json({ activeProjectId: OTHER_PROJECT })],
    });
    render(<App />);
    await openTasks();
    expect(await screen.findByRole('article', { name: 'Do primeiro' })).toBeInTheDocument();
    await userEvent.setup().selectOptions(screen.getByRole('combobox', { name: 'Projeto ativo' }), OTHER_PROJECT);
    expect(await screen.findByText('Nenhuma tarefa neste projeto ainda.')).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Do primeiro' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(`/api/projects/${OTHER_PROJECT}/tasks`),
    );
  });

  it('sem projeto ativo: orienta a escolher um projeto, sem consultar tarefas', async () => {
    const fetchMock = mockApi({ ...base, projects: [json(projectList({ activeProjectId: null }))] });
    render(<App />);
    await openTasks();
    expect(await screen.findByText(/Selecione ou crie um projeto/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/tasks'))).toBe(false);
  });

  it('sessão expirada ao listar tarefas volta para o login', async () => {
    mockApi({
      ...base,
      session: [json({ authenticated: true, user: { email: 'admin@example.test' }, expiresAt: '2026-11-14T00:00:00Z' }), json({ authenticated: false, authConfigured: true })],
      tasks: [apiError('unauthenticated', 401)],
    });
    render(<App />);
    await openTasks();
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
  });
});
