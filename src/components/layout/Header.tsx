import type { Ref } from 'react';
import { useGitHubData } from '../../features/github/githubDataContext';

interface HeaderProps {
  title: string;
  isMenuOpen: boolean;
  onMenuToggle: () => void;
  menuButtonRef?: Ref<HTMLButtonElement>;
}

function DataSourceBadge() {
  const { state } = useGitHubData();
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
      <DataSourceBadge />
    </header>
  );
}
