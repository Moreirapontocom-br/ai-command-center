import type { AgentStatus, TaskStatus } from '../../types';

type BadgeStatus = AgentStatus | TaskStatus;

const STYLES: Record<BadgeStatus, string> = {
  disponivel: 'bg-emerald-100 text-emerald-800',
  ocupado: 'bg-amber-100 text-amber-800',
  offline: 'bg-slate-200 text-slate-700',
  pendente: 'bg-slate-200 text-slate-700',
  'em-andamento': 'bg-blue-100 text-blue-800',
  'em-revisao': 'bg-violet-100 text-violet-800',
  concluida: 'bg-emerald-100 text-emerald-800',
};

interface StatusBadgeProps {
  status: BadgeStatus;
  label: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${STYLES[status]}`}
    >
      {label}
    </span>
  );
}
