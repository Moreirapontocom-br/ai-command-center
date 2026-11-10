import type { Agent, AgentId, AgentStatus } from '../../types';

export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  disponivel: 'Disponível',
  ocupado: 'Ocupado',
  offline: 'Offline',
};

export function getAgentName(agents: Agent[], agentId: AgentId): string {
  return agents.find((agent) => agent.id === agentId)?.name ?? agentId;
}
