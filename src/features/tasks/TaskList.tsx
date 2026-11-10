import { StatusBadge } from '../../components/ui/StatusBadge';
import type { Agent, Task } from '../../types';
import { getAgentName } from '../agents/agentUtils';
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from './taskUtils';

interface TaskListProps {
  tasks: Task[];
  agents: Agent[];
}

export function TaskList({ tasks, agents }: TaskListProps) {
  if (tasks.length === 0) {
    return <p className="text-sm text-slate-500">Nenhuma tarefa encontrada.</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {tasks.map((task) => (
        <li
          key={task.id}
          className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="font-medium break-words">{task.title}</p>
            <p className="text-xs text-slate-500">
              {task.id} · {getAgentName(agents, task.agentId)} · Prioridade{' '}
              {TASK_PRIORITY_LABELS[task.priority]} ·{' '}
              <span className="whitespace-nowrap">Atualizada em {task.updatedAt}</span>
            </p>
          </div>
          <div className="self-start sm:self-auto">
            <StatusBadge status={task.status} label={TASK_STATUS_LABELS[task.status]} />
          </div>
        </li>
      ))}
    </ul>
  );
}
