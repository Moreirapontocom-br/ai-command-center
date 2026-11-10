import { StatusBadge } from '../../components/ui/StatusBadge';
import type { Agent } from '../../types';
import { AGENT_STATUS_LABELS } from './agentUtils';

interface AgentCardProps {
  agent: Agent;
  openTasks: number;
}

export function AgentCard({ agent, openTasks }: AgentCardProps) {
  return (
    <article
      aria-label={agent.name}
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{agent.name}</h3>
          <p className="text-xs text-slate-500">{agent.provider}</p>
        </div>
        <StatusBadge status={agent.status} label={AGENT_STATUS_LABELS[agent.status]} />
      </div>
      <p className="text-sm text-slate-600">{agent.role}</p>
      <p className="text-sm text-slate-500">
        Tarefas abertas: <span className="font-semibold text-slate-800">{openTasks}</span>
      </p>
    </article>
  );
}
