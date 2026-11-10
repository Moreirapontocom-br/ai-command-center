import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { ViewId } from '../../types';
import { NAV_ITEMS } from './navigation';

interface SidebarProps {
  currentView: ViewId;
  onNavigate: (view: ViewId) => void;
  isOpen: boolean;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function Sidebar({ currentView, onNavigate, isOpen, onClose }: SidebarProps) {
  const asideRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Ao abrir a gaveta, move o foco para dentro dela.
  useEffect(() => {
    if (isOpen) {
      closeButtonRef.current?.focus();
    }
  }, [isOpen]);

  // Mantém o foco do Tab circulando dentro da gaveta enquanto ela está aberta.
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isOpen || event.key !== 'Tab' || !asideRef.current) return;

    const focusable = Array.from(
      asideRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          aria-hidden="true"
          data-testid="sidebar-overlay"
          onClick={onClose}
        />
      )}
      <aside
        id="app-sidebar"
        ref={asideRef}
        onKeyDown={handleKeyDown}
        role={isOpen ? 'dialog' : undefined}
        aria-modal={isOpen ? true : undefined}
        aria-label={isOpen ? 'Menu de navegação' : undefined}
        // Fechada, a gaveta fica `invisible` para sair da ordem de foco no mobile. A visibilidade só é
        // animada ao fechar: ao abrir ela precisa ser imediata, senão o foco inicial é ignorado.
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-slate-900 text-slate-100 lg:visible lg:static lg:translate-x-0 ${
          isOpen
            ? 'visible translate-x-0 transition-transform'
            : 'invisible -translate-x-full transition-[transform,visibility]'
        }`}
      >
        <div className="flex h-16 items-center justify-between px-6">
          <span className="text-lg font-semibold">AI Command Center</span>
          <button
            ref={closeButtonRef}
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
