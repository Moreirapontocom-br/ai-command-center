import type { AgentStatus, TaskStatus } from '../../types';
import { Badge, type BadgeTone } from './Badge';

type BadgeStatus = AgentStatus | TaskStatus;

const TONES: Record<BadgeStatus, BadgeTone> = {
  disponivel: 'success',
  ocupado: 'warning',
  offline: 'neutral',
  pendente: 'neutral',
  'em-andamento': 'info',
  'em-revisao': 'violet',
  concluida: 'success',
};

interface StatusBadgeProps {
  status: BadgeStatus;
  label: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
  return <Badge tone={TONES[status]}>{label}</Badge>;
}
