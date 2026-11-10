export type AgentId = 'chatgpt' | 'claude-code' | 'gemini';

export type AgentStatus = 'disponivel' | 'ocupado' | 'offline';

export interface Agent {
  id: AgentId;
  name: string;
  provider: string;
  role: string;
  status: AgentStatus;
}

export type TaskStatus = 'pendente' | 'em-andamento' | 'em-revisao' | 'concluida';

export type TaskPriority = 'baixa' | 'media' | 'alta';

export interface Task {
  id: string;
  title: string;
  agentId: AgentId;
  status: TaskStatus;
  priority: TaskPriority;
  updatedAt: string;
}

export type ViewId = 'dashboard' | 'agentes' | 'tarefas';
