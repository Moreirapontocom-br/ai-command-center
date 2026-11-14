import type { Ref } from 'react';
import { useState } from 'react';
import { useAuth } from '../../features/auth/authContext';
import { useGitHubData } from '../../features/github/githubDataContext';
import { useProjects } from '../../features/projects/projectsContext';

interface HeaderProps {
  title: string;
  isMenuOpen: boolean;
  onMenuToggle: () => void;
  menuButtonRef?: Ref<HTMLButtonElement>;
}

/** Seletor do projeto ativo. A escolha é gravada no servidor (não no navegador). */
function ProjectSwitcher() {
  const { state, select } = useProjects();
  const [saving, setSaving] = useState(false);
  if (state.phase !== 'ready' || state.projects.length === 0) return null;
  return (
    <label className="flex min-w-0 shrink items-center gap-2 text-sm text-slate-600">
      <span className="hidden md:inline">Projeto</span>
      <select
        aria-label="Projeto ativo"
        value={state.activeProjectId ?? ''}
        disabled={saving}
        onChange={async (event) => {
          setSaving(true);
          await select(event.target.value === '' ? null : event.target.value);
          setSaving(false);
        }}
        className="max-w-40 min-w-0 truncate rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-800 sm:max-w-56"
      >
        <option value="">Nenhum</option>
        {state.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function DataSourceBadge() {
  const { state } = useGitHubData();
  if (state.phase === 'demo' && (state.reason === 'project_without_repository' || state.reason === 'no_active_project')) {
    return (
      <span className="hidden shrink-0 rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700 sm:inline">
        Sem GitHub
      </span>
    );
  }
  // Só indica dados reais quando um snapshot do GitHub foi de fato carregado.
  if (state.phase === 'ready') {
    return state.stale ? (
      <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
        GitHub: dados desatualizados
      </span>
    ) : (
      <span className="shrink-0 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800">
        GitHub conectado
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
      Modo demonstração
    </span>
  );
}

function UserMenu() {
  const { state, signOut } = useAuth();
  const [leaving, setLeaving] = useState(false);
  if (state.phase !== 'authenticated') return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="hidden max-w-48 truncate text-sm text-slate-600 sm:inline" title={state.email}>
        {state.email}
      </span>
      <button
        type="button"
        disabled={leaving}
        onClick={() => {
          setLeaving(true);
          void signOut();
        }}
        className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-60"
      >
        Sair
      </button>
    </div>
  );
}

export function Header({ title, isMenuOpen, onMenuToggle, menuButtonRef }: HeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
      <button
        ref={menuButtonRef}
        type="button"
        className="rounded-md p-2 text-slate-700 hover:bg-slate-100 lg:hidden"
        onClick={onMenuToggle}
        aria-label={isMenuOpen ? 'Fechar menu' : 'Abrir menu'}
        aria-controls="app-sidebar"
        aria-expanded={isMenuOpen}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M3 5h14M3 10h14M3 15h14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      <ProjectSwitcher />
      <DataSourceBadge />
      <UserMenu />
    </header>
  );
}
