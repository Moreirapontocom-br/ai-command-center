import { MockDataNotice } from '../../components/ui/MockDataNotice';
import { MOCK_AGENTS, MOCK_TASKS } from '../../data/mockData';
import { TaskList } from './TaskList';

export function TasksPage() {
  return (
    <div className="space-y-6">
      <MockDataNotice />
      <TaskList tasks={MOCK_TASKS} agents={MOCK_AGENTS} />
    </div>
  );
}
