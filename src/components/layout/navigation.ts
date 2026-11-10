import type { ViewId } from '../../types';

export interface NavItem {
  id: ViewId;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'agentes', label: 'Agentes' },
  { id: 'tarefas', label: 'Tarefas' },
];
