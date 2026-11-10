import type { ViewId } from '../../types';
import { NAV_ITEMS } from './navigation';

interface SidebarProps {
  currentView: ViewId;
  onNavigate: (view: ViewId) => void;
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ currentView, onNavigate, isOpen, onClose }: SidebarProps) {
  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          aria-hidden="true"
          onClick={onClose}
        />
      )}
      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-slate-900 text-slate-100 transition-transform lg:static lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between px-6">
          <span className="text-lg font-semibold">AI Command Center</span>
          <button
            type="button"
            className="rounded p-1 text-slate-300 hover:bg-slate-800 lg:hidden"
            onClick={onClose}
            aria-label="Fechar menu"
          >
            ✕
          </button>
        </div>
        <nav aria-label="Navegação principal" className="flex-1 px-3 py-4">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = item.id === currentView;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm font-medium transition-colors ${
                      active ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <p className="px-6 py-4 text-xs text-slate-400">Versão de demonstração</p>
      </aside>
    </>
  );
}
