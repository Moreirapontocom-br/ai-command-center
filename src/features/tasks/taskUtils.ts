import type { AgentId, Task, TaskPriority, TaskStatus } from '../../types';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pendente: 'Pendente',
  'em-andamento': 'Em andamento',
  'em-revisao': 'Em revisão',
  concluida: 'Concluída',
};

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  baixa: 'baixa',
  media: 'média',
  alta: 'alta',
};

export const TASK_STATUS_ORDER: TaskStatus[] = ['pendente', 'em-andamento', 'em-revisao', 'concluida'];

export function countTasksByStatus(tasks: Task[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    pendente: 0,
    'em-andamento': 0,
    'em-revisao': 0,
    concluida: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

export function countOpenTasksForAgent(tasks: Task[], agentId: AgentId): number {
  return tasks.filter((task) => task.agentId === agentId && task.status !== 'concluida').length;
}
