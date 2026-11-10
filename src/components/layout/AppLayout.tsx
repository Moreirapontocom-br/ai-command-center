import { useState, type ReactNode } from 'react';
import type { ViewId } from '../../types';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { NAV_ITEMS } from './navigation';

interface AppLayoutProps {
  currentView: ViewId;
  onNavigate: (view: ViewId) => void;
  children: ReactNode;
}

export function AppLayout({ currentView, onNavigate, children }: AppLayoutProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = NAV_ITEMS.find((item) => item.id === currentView)?.label ?? '';

  const handleNavigate = (view: ViewId) => {
    onNavigate(view);
    setMenuOpen(false);
  };

  return (
    <div className="flex h-full">
      <Sidebar
        currentView={currentView}
        onNavigate={handleNavigate}
        isOpen={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          title={title}
          isMenuOpen={menuOpen}
          onMenuToggle={() => setMenuOpen((open) => !open)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
