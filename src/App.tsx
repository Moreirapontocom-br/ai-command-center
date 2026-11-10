import { useState, type ComponentType } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { AgentsPage } from './features/agents/AgentsPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { TasksPage } from './features/tasks/TasksPage';
import type { ViewId } from './types';

// Navegação simples por estado local — sem biblioteca de roteamento (fora do escopo da Issue #001).
const VIEWS: Record<ViewId, ComponentType> = {
  dashboard: DashboardPage,
  agentes: AgentsPage,
  tarefas: TasksPage,
};

export default function App() {
  const [view, setView] = useState<ViewId>('dashboard');
  const CurrentView = VIEWS[view];

  return (
    <AppLayout currentView={view} onNavigate={setView}>
      <CurrentView />
    </AppLayout>
  );
}
