import type { AgentRef, TaskAssignee, TaskOrigin, TaskPriority, TaskReference, TaskStatus } from '../../../shared/contracts.ts';
import type { BadgeTone } from '../../components/ui/Badge';
import type { AssigneeChoices } from './AssigneeOptions';

/** Rótulos das tarefas reais (Issue #005). As tarefas fictícias do dashboard usam `taskUtils.ts`. */
export const WORK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pendente',
  planned: 'Planejada',
  in_progress: 'Em andamento',
  blocked: 'Bloqueada',
  in_review: 'Em revisão',
  done: 'Concluída',
  cancelled: 'Cancelada',
};

export const WORK_STATUS_TONES: Record<TaskStatus, BadgeTone> = {
  pending: 'neutral',
  planned: 'info',
  in_progress: 'violet',
  blocked: 'danger',
  in_review: 'warning',
  done: 'success',
  cancelled: 'neutral',
};

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Baixa',
  medium: 'Média',
  high: 'Alta',
  critical: 'Crítica',
};

export const PRIORITY_TONES: Record<TaskPriority, BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

export const AGENT_LABELS: Record<AgentRef, string> = {
  chatgpt: 'ChatGPT',
  'claude-code': 'Claude Code',
  gemini: 'Gemini',
  nemotron: 'Nemotron',
};

export const ORIGIN_LABELS: Record<TaskOrigin, string> = {
  manual: 'Manual',
  integration: 'Integração',
  agent: 'Agente',
};

/** Valor serializado do responsável para `<select>` (`''` = sem responsável). */
export function assigneeKey(assignee: TaskAssignee | null): string {
  if (assignee === null) return '';
  return assignee.kind === 'agent' ? `agent:${assignee.agentId}` : `human:${assignee.userId}`;
}

export function assigneeFromKey(key: string): TaskAssignee | null {
  if (key.startsWith('agent:')) return { kind: 'agent', agentId: key.slice(6) as AgentRef };
  if (key.startsWith('human:')) return { kind: 'human', userId: key.slice(6) };
  return null;
}

export function referenceLabel(reference: TaskReference): string {
  if (reference.kind === 'branch') return `branch ${reference.name}`;
  return `${reference.kind === 'issue' ? 'issue' : 'PR'} #${reference.number}`;
}

/** Link somente para leitura no GitHub. Nada é consultado para inferir status. */
export function referenceUrl(reference: TaskReference): string {
  const repo = reference.repository.split('/').map(encodeURIComponent).join('/');
  if (reference.kind === 'branch') return `https://github.com/${repo}/tree/${reference.name.split('/').map(encodeURIComponent).join('/')}`;
  return `https://github.com/${repo}/${reference.kind === 'issue' ? 'issues' : 'pull'}/${reference.number}`;
}

export function assigneeName(assignee: TaskAssignee | null, choices: AssigneeChoices): string {
  if (assignee === null) return 'Sem responsável';
  if (assignee.kind === 'agent') return `${AGENT_LABELS[assignee.agentId]} (agente)`;
  return choices.users.find((u) => u.userId === assignee.userId)?.label ?? assignee.userId;
}
