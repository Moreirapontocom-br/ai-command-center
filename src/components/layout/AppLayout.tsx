import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ViewId } from '../../types';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { NAV_ITEMS } from './navigation';

interface AppLayoutProps {
  currentView: ViewId;
  onNavigate: (view: ViewId) => void;
  children: ReactNode;
}

// Mesmo breakpoint `lg` do Tailwind, a partir do qual a sidebar é fixa e não modal.
const DESKTOP_QUERY = '(min-width: 1024px)';

export function AppLayout({ currentView, onNavigate, children }: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasMenuOpen = useRef(false);
  const title = NAV_ITEMS.find((item) => item.id === currentView)?.label ?? '';

  const closeMenu = () => setMenuOpen(false);

  const handleNavigate = (view: ViewId) => {
    onNavigate(view);
    closeMenu();
  };

  // Devolve o foco ao botão do menu sempre que a gaveta é fechada.
  useEffect(() => {
    if (wasMenuOpen.current && !menuOpen) {
      menuButtonRef.current?.focus();
    }
    wasMenuOpen.current = menuOpen;
  }, [menuOpen]);

  // Fecha a gaveta com Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen]);

  // Fecha a gaveta se a janela passar para o layout desktop, evitando um estado modal invisível.
  useEffect(() => {
    if (!menuOpen || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const handleChange = () => {
      if (query.matches) setMenuOpen(false);
    };
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, [menuOpen]);

  return (
    <div className="flex h-full">
      <Sidebar
        currentView={currentView}
        onNavigate={handleNavigate}
        isOpen={menuOpen}
        onClose={closeMenu}
      />
      {/* Com a gaveta aberta, o conteúdo de fundo fica inerte (sem foco nem interação). */}
      <div className="flex min-w-0 flex-1 flex-col" inert={menuOpen}>
        <Header
          title={title}
          isMenuOpen={menuOpen}
          onMenuToggle={() => setMenuOpen((open) => !open)}
          menuButtonRef={menuButtonRef}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
