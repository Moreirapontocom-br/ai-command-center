import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import { countOpenTasksForAgent, countTasksByStatus } from './taskUtils';

const tasks: Task[] = [
  { id: '1', title: 'a', agentId: 'chatgpt', status: 'pendente', priority: 'alta', updatedAt: '2026-01-01' },
  { id: '2', title: 'b', agentId: 'chatgpt', status: 'concluida', priority: 'baixa', updatedAt: '2026-01-02' },
  { id: '3', title: 'c', agentId: 'gemini', status: 'em-revisao', priority: 'media', updatedAt: '2026-01-03' },
  { id: '4', title: 'd', agentId: 'chatgpt', status: 'em-andamento', priority: 'media', updatedAt: '2026-01-04' },
];

describe('countTasksByStatus', () => {
  it('conta tarefas por status, incluindo status sem tarefas', () => {
    expect(countTasksByStatus(tasks)).toEqual({
      pendente: 1,
      'em-andamento': 1,
      'em-revisao': 1,
      concluida: 1,
    });
  });

  it('retorna zeros para lista vazia', () => {
    expect(countTasksByStatus([])).toEqual({
      pendente: 0,
      'em-andamento': 0,
      'em-revisao': 0,
      concluida: 0,
    });
  });
});

describe('countOpenTasksForAgent', () => {
  it('ignora tarefas concluídas e de outros agentes', () => {
    expect(countOpenTasksForAgent(tasks, 'chatgpt')).toBe(2);
    expect(countOpenTasksForAgent(tasks, 'gemini')).toBe(1);
    expect(countOpenTasksForAgent(tasks, 'claude-code')).toBe(0);
  });
});
