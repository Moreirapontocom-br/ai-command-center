import type { Agent, Task } from '../../types';
import { countOpenTasksForAgent } from '../tasks/taskUtils';
import { AgentCard } from './AgentCard';

interface AgentListProps {
  agents: Agent[];
  tasks: Task[];
}

export function AgentList({ agents, tasks }: AgentListProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {agents.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          openTasks={countOpenTasksForAgent(tasks, agent.id)}
        />
      ))}
    </div>
  );
}
