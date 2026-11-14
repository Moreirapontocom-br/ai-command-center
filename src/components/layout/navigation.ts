import type { ViewId } from '../../types';

export interface NavItem {
  id: ViewId;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'projetos', label: 'Projetos' },
  { id: 'issues', label: 'Issues' },
  { id: 'pull-requests', label: 'Pull Requests' },
  { id: 'branches', label: 'Branches' },
  { id: 'agentes', label: 'Agentes' },
  { id: 'tarefas', label: 'Tarefas' },
];
