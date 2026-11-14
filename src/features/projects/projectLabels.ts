import type { ProjectStatus } from '../../../shared/contracts.ts';
import type { BadgeTone } from '../../components/ui/Badge';

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  planning: 'Planejamento',
  active: 'Em andamento',
  paused: 'Pausado',
  completed: 'Concluído',
  archived: 'Arquivado',
};

export const STATUS_TONES: Record<ProjectStatus, BadgeTone> = {
  planning: 'info',
  active: 'success',
  paused: 'warning',
  completed: 'violet',
  archived: 'neutral',
};
