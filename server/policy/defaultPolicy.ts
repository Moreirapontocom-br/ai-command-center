import { validatePolicy, type Policy } from './engine.ts';

/**
 * Política padrão do ACC (Issue #020) — autonomia SEMIAUTOMÁTICA (B). É código revisado: mudar
 * qualquer regra exige PR aprovado pelo Product Owner, nunca uma chamada de API ou de agente.
 *
 * Pessoas (dono do projeto): observam e gerenciam projetos e tarefas; capacidades futuras de risco
 * alto e ações críticas exigem aprovação específica.
 *
 * Agentes: só no projeto em que têm tarefa atribuída; observam e (no futuro) propõem; qualquer
 * mudança, ferramenta, preparação de alteração ou execução em sandbox exige aprovação; ações
 * críticas exigem aprovação e nunca são liberadas de forma autônoma. Sem regra = negado
 * (ex.: agente criar projeto, atribuir tarefas, concluir tarefa, ler auditoria ou políticas).
 * Regras fixas do motor: push na main sempre negado; agente nunca altera permissões.
 */
export const DEFAULT_POLICY: Policy = validatePolicy({
  version: '2026-11-14.1',
  rules: [
    { id: 'H1-observar-e-gerenciar', subject: 'human:owner', categories: ['observe', 'project', 'task'], effect: 'allow', maxRisk: 'medium' },
    { id: 'H2-planejar-preparar', subject: 'human:owner', categories: ['plan', 'tool', 'change', 'approval'], effect: 'allow', maxRisk: 'medium' },
    { id: 'H3-sandbox', subject: 'human:owner', categories: ['sandbox'], effect: 'require_approval', maxRisk: 'high' },
    { id: 'H4-criticas', subject: 'human:owner', categories: ['critical'], effect: 'require_approval', maxRisk: 'high' },
    {
      id: 'A1-observar',
      subject: 'agent:*',
      actions: ['project.read', 'task.read', 'github.read'],
      effect: 'allow',
      maxRisk: 'low',
      requiresAssignment: true,
    },
    { id: 'A2-propor', subject: 'agent:*', actions: ['task.propose', 'approval.request'], effect: 'allow', maxRisk: 'low', requiresAssignment: true },
    {
      id: 'A3-alterar-tarefa',
      subject: 'agent:*',
      actions: ['task.update', 'task.status_change'],
      effect: 'require_approval',
      maxRisk: 'medium',
      requiresAssignment: true,
    },
    {
      id: 'A4-ferramentas-e-alteracoes',
      subject: 'agent:*',
      categories: ['tool', 'change'],
      effect: 'require_approval',
      maxRisk: 'medium',
      requiresAssignment: true,
    },
    { id: 'A5-sandbox', subject: 'agent:*', categories: ['sandbox'], effect: 'require_approval', maxRisk: 'high', requiresAssignment: true },
    { id: 'A6-criticas', subject: 'agent:*', categories: ['critical'], effect: 'require_approval', maxRisk: 'high', requiresAssignment: true },
  ],
});
