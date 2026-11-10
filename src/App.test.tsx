import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from './App';
import { MOCK_TASKS } from './data/mockData';

function getNav() {
  return screen.getByRole('navigation', { name: 'Navegação principal' });
}

describe('App', () => {
  it('abre no dashboard com aviso de dados fictícios', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/Dados fictícios/);
    expect(screen.getByText('Modo demonstração')).toBeInTheDocument();
  });

  it('exibe os agentes ChatGPT, Claude Code e Gemini', () => {
    render(<App />);
    for (const name of ['ChatGPT', 'Claude Code', 'Gemini']) {
      expect(screen.getByRole('article', { name })).toBeInTheDocument();
    }
  });

  it('navega entre as seções pela sidebar', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(within(getNav()).getByRole('button', { name: 'Tarefas' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Tarefas' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').filter((li) => li.closest('main'))).toHaveLength(
      MOCK_TASKS.length,
    );
    expect(within(getNav()).getByRole('button', { name: 'Tarefas' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(within(getNav()).getByRole('button', { name: 'Agentes' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Agentes' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });

  it('identifica todas as tarefas demonstrativas como fictícias', () => {
    for (const task of MOCK_TASKS) {
      expect(task.title).toMatch(/^\[Fictício\]/);
    }
  });

  it('abre e fecha o menu mobile', async () => {
    const user = userEvent.setup();
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Abrir menu' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(within(getNav()).getByRole('button', { name: 'Agentes' }));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
