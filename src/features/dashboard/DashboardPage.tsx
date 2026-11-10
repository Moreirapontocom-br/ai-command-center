import { MockDataNotice } from '../../components/ui/MockDataNotice';
import { MOCK_AGENTS, MOCK_TASKS } from '../../data/mockData';
import { AgentList } from '../agents/AgentList';
import { GitHubOverview } from '../github/GitHubOverview';
import { TaskList } from '../tasks/TaskList';
import { TASK_STATUS_LABELS, TASK_STATUS_ORDER, countTasksByStatus } from '../tasks/taskUtils';
import { StatCard } from './StatCard';

const RECENT_TASKS_LIMIT = 3;

export function DashboardPage() {
  const counts = countTasksByStatus(MOCK_TASKS);
  const recentTasks = [...MOCK_TASKS]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RECENT_TASKS_LIMIT);

  return (
    <div className="space-y-8">
      <GitHubOverview />

      <div className="space-y-8 border-t border-slate-200 pt-8">
        <MockDataNotice />

        <section aria-labelledby="resumo-titulo">
          <h2 id="resumo-titulo" className="mb-3 text-base font-semibold">
            Resumo de tarefas (demonstração)
          </h2>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {TASK_STATUS_ORDER.map((status) => (
              <StatCard key={status} label={TASK_STATUS_LABELS[status]} value={counts[status]} />
            ))}
          </div>
        </section>

        <section aria-labelledby="agentes-titulo">
          <h2 id="agentes-titulo" className="mb-3 text-base font-semibold">
            Agentes (demonstração)
          </h2>
          <AgentList agents={MOCK_AGENTS} tasks={MOCK_TASKS} />
        </section>

        <section aria-labelledby="recentes-titulo">
          <h2 id="recentes-titulo" className="mb-3 text-base font-semibold">
            Tarefas recentes (demonstração)
          </h2>
          <TaskList tasks={recentTasks} agents={MOCK_AGENTS} />
        </section>
      </div>
    </div>
  );
}
