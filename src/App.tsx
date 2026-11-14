import { useState, type ComponentType } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { AgentsPage } from './features/agents/AgentsPage';
import { AuthProvider } from './features/auth/AuthProvider';
import { useAuth } from './features/auth/authContext';
import { LoginPage } from './features/auth/LoginPage';
import { DashboardPage } from './features/dashboard/DashboardPage';
import { GitHubDataProvider } from './features/github/GitHubDataProvider';
import { BranchesPage, IssuesPage, PullRequestsPage } from './features/github/GitHubPages';
import { ProjectsPage } from './features/projects/ProjectsPage';
import { ProjectsProvider } from './features/projects/ProjectsProvider';
import { TasksPage } from './features/tasks/TasksPage';
import type { ViewId } from './types';

// Navegação simples por estado local — sem biblioteca de roteamento (fora do escopo da Issue #001).
const VIEWS: Record<ViewId, ComponentType> = {
  dashboard: DashboardPage,
  projetos: ProjectsPage,
  issues: IssuesPage,
  'pull-requests': PullRequestsPage,
  branches: BranchesPage,
  agentes: AgentsPage,
  tarefas: TasksPage,
};

function Dashboard() {
  const [view, setView] = useState<ViewId>('dashboard');
  const CurrentView = VIEWS[view];

  return (
    // Os dados do GitHub dependem do projeto ativo: ProjectsProvider fica por fora.
    <ProjectsProvider>
      <GitHubDataProvider>
        <AppLayout currentView={view} onNavigate={setView}>
          <CurrentView />
        </AppLayout>
      </GitHubDataProvider>
    </ProjectsProvider>
  );
}

/**
 * Controle de acesso no navegador (a proteção efetiva é a do servidor, que recusa rotas privadas
 * sem sessão): sem sessão válida, nenhum dado do servidor é solicitado nem exibido. Só quando o
 * servidor está inalcançável a aplicação segue em modo demonstração, com dados fictícios.
 */
function AuthGate() {
  const { state } = useAuth();
  if (state.phase === 'loading') {
    return (
      <main className="flex min-h-full items-center justify-center p-6">
        <p role="status" className="text-sm text-slate-600">
          Verificando sessão…
        </p>
      </main>
    );
  }
  if (state.phase === 'anonymous') {
    return <LoginPage authConfigured={state.authConfigured} sessionExpired={state.sessionExpired} />;
  }
  return <Dashboard />;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
