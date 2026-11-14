import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../../App';
import {
  apiError,
  authenticatedSession,
  configuredStatus,
  json,
  mockApi,
  snapshotReply,
} from '../../test/githubFixtures';

const anonymous = json({ authenticated: false, authConfigured: true });
const PASSWORD = 'SENHACANARIA-ui-123';

function calledPaths(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

async function fillAndSubmit(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail'), email);
  await user.type(screen.getByLabelText('Senha'), password);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

describe('login na interface', () => {
  it('visitante sem sessão vê apenas o login; nenhum dado do servidor é solicitado', async () => {
    const fetchMock = mockApi({ session: [anonymous] });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeDisabled();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByText(/Dados fictícios/)).not.toBeInTheDocument();
    expect(calledPaths(fetchMock)).toEqual(['/api/auth/session']);
  });

  it('login válido envia JSON para a própria origem e abre o painel com dados reais', async () => {
    const fetchMock = mockApi({
      session: [anonymous],
      login: [json(authenticatedSession)],
      status: [json(configuredStatus)],
      snapshot: [snapshotReply()],
    });
    render(<App />);
    await fillAndSubmit('admin@example.test', PASSWORD);

    expect(await screen.findByText('Dados reais do GitHub')).toBeInTheDocument();
    expect(screen.getByText('admin@example.test')).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input) === '/api/auth/login')!;
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init!.body))).toEqual({ email: 'admin@example.test', password: PASSWORD });
    expect(init).not.toHaveProperty('credentials');
    // Nada de credencial no armazenamento do navegador.
    expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain(PASSWORD);
    expect(document.cookie).toBe('');
  });

  it('login inválido mostra erro genérico, limpa a senha e continua no login', async () => {
    mockApi({ session: [anonymous], login: [apiError('invalid_credentials', 401)] });
    render(<App />);
    await fillAndSubmit('admin@example.test', 'errada-123456');
    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha inválidos.');
    expect(screen.getByLabelText('Senha')).toHaveValue('');
    expect(screen.getByLabelText('E-mail')).toHaveValue('admin@example.test');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('tentativas excessivas informam quando tentar de novo', async () => {
    mockApi({ session: [anonymous], login: [apiError('too_many_requests', 429, { retryAfterSeconds: 900 })] });
    render(<App />);
    await fillAndSubmit('admin@example.test', 'qualquer-123456');
    expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas. Tente novamente em 15 min.');
  });

  it('sem administrador configurado, explica a configuração e desabilita o formulário', async () => {
    mockApi({ session: [json({ authenticated: false, authConfigured: false })] });
    render(<App />);
    expect(await screen.findByText('Administrador não configurado.')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toBeDisabled();
    expect(screen.getByLabelText('Senha')).toBeDisabled();
  });
});

describe('sessão e logout', () => {
  it('sessão expirada no meio do uso (401) volta para o login com aviso', async () => {
    mockApi({
      session: [json(authenticatedSession), anonymous],
      status: [json(configuredStatus)],
      snapshot: [apiError('unauthenticated', 401)],
    });
    render(<App />);
    expect(await screen.findByText('Sua sessão expirou ou foi encerrada (por exemplo, por um login em outro navegador). Entre novamente.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('logout chama o servidor e remove o painel', async () => {
    const fetchMock = mockApi({
      session: [json(authenticatedSession)],
      status: [json(configuredStatus)],
      snapshot: [snapshotReply()],
      logout: [anonymous],
    });
    render(<App />);
    await screen.findByText('Dados reais do GitHub');
    const header = screen.getByRole('banner');
    await userEvent.setup().click(within(header).getByRole('button', { name: 'Sair' }));

    expect(await screen.findByRole('button', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.queryByText('Dados reais do GitHub')).not.toBeInTheDocument();
    expect(calledPaths(fetchMock)).toContain('/api/auth/logout');
  });

  it('servidor inalcançável: segue em modo demonstração, só com dados fictícios', async () => {
    render(<App />); // fetch padrão dos testes: rede indisponível
    expect(await screen.findByText('Modo demonstração')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Dados fictícios/);
    expect(screen.queryByRole('button', { name: 'Sair' })).not.toBeInTheDocument();
  });
});
