import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MOCK_AGENTS } from '../../data/mockData';
import type { Task } from '../../types';
import { TaskList } from './TaskList';

describe('TaskList', () => {
  it('exibe título, agente responsável e status de cada tarefa', () => {
    const tasks: Task[] = [
      {
        id: 'T-9',
        title: 'Tarefa de teste',
        agentId: 'gemini',
        status: 'em-revisao',
        priority: 'media',
        updatedAt: '2026-11-01',
      },
    ];
    render(<TaskList tasks={tasks} agents={MOCK_AGENTS} />);

    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Tarefa de teste')).toBeInTheDocument();
    expect(within(item).getByText(/Gemini/)).toBeInTheDocument();
    expect(within(item).getByText(/Prioridade média/)).toBeInTheDocument();
    expect(within(item).getByText('Em revisão')).toBeInTheDocument();
  });

  it('exibe estado vazio quando não há tarefas', () => {
    render(<TaskList tasks={[]} agents={MOCK_AGENTS} />);
    expect(screen.getByText('Nenhuma tarefa encontrada.')).toBeInTheDocument();
  });
});
