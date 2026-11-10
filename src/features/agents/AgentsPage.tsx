import { MockDataNotice } from '../../components/ui/MockDataNotice';
import { MOCK_AGENTS, MOCK_TASKS } from '../../data/mockData';
import { AgentList } from './AgentList';

export function AgentsPage() {
  return (
    <div className="space-y-6">
      <MockDataNotice />
      <AgentList agents={MOCK_AGENTS} tasks={MOCK_TASKS} />
    </div>
  );
}
