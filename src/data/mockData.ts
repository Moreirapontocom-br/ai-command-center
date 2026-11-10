/**
 * DADOS FICTÍCIOS — apenas para demonstração da interface.
 * Nenhum valor aqui reflete agentes, tarefas ou integrações reais.
 * Não há chamadas a provedores de IA nem credenciais neste projeto.
 */
import type { Agent, Task } from '../types';

export const MOCK_AGENTS: Agent[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    provider: 'OpenAI',
    role: 'Coordenação de arquitetura e revisão técnica',
    status: 'disponivel',
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    provider: 'Anthropic',
    role: 'Desenvolvimento e implementação',
    status: 'ocupado',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    provider: 'Google',
    role: 'Pesquisa e análise de apoio',
    status: 'offline',
  },
];

export const MOCK_TASKS: Task[] = [
  {
    id: 'T-001',
    title: '[Fictício] Configurar estrutura inicial do projeto',
    agentId: 'claude-code',
    status: 'em-andamento',
    priority: 'alta',
    updatedAt: '2026-11-10',
  },
  {
    id: 'T-002',
    title: '[Fictício] Definir critérios de aceite da Issue #002',
    agentId: 'chatgpt',
    status: 'pendente',
    priority: 'media',
    updatedAt: '2026-11-09',
  },
  {
    id: 'T-003',
    title: '[Fictício] Revisar pull request de exemplo',
    agentId: 'chatgpt',
    status: 'em-revisao',
    priority: 'alta',
    updatedAt: '2026-11-08',
  },
  {
    id: 'T-004',
    title: '[Fictício] Levantar referências de UX para dashboards',
    agentId: 'gemini',
    status: 'concluida',
    priority: 'baixa',
    updatedAt: '2026-11-05',
  },
  {
    id: 'T-005',
    title: '[Fictício] Escrever testes de componentes',
    agentId: 'claude-code',
    status: 'pendente',
    priority: 'media',
    updatedAt: '2026-11-04',
  },
];
