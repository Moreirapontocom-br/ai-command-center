interface HeaderProps {
  title: string;
  isMenuOpen: boolean;
  onMenuToggle: () => void;
}

export function Header({ title, isMenuOpen, onMenuToggle }: HeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-6">
      <button
        type="button"
        className="rounded-md p-2 text-slate-700 hover:bg-slate-100 lg:hidden"
        onClick={onMenuToggle}
        aria-label="Abrir menu"
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
      <span className="shrink-0 rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-900">
        Modo demonstração
      </span>
    </header>
  );
}
