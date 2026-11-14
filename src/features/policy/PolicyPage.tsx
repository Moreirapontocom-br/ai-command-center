import { useEffect, useState } from 'react';
import {
  POLICY_ACTIONS,
  POLICY_CATEGORIES,
  type PolicyAction,
  type PolicyCategory,
  type PolicyDecision,
  type PolicyMatrixResponse,
  type PolicyReason,
  type RiskLevel,
} from '../../../shared/contracts.ts';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { ApiClientError } from '../../services/apiClient';
import { fetchPolicyMatrix } from '../../services/policyApi';
import { useAuth } from '../auth/authContext';
import { ERROR_COPY } from '../github/githubLabels';
import { useProjects } from '../projects/projectsContext';
import { AGENT_LABELS } from '../tasks/workLabels';

const ACTION_LABELS: Record<PolicyAction, string> = {
  'project.read': 'Ler projeto',
  'task.read': 'Ler tarefas',
  'github.read': 'Ler dados do GitHub',
  'audit.read': 'Ler auditoria',
  'policy.read': 'Ler políticas',
  'task.propose': 'Propor tarefas/planos',
  'project.create': 'Criar projeto',
  'project.update': 'Alterar projeto',
  'project.select': 'Selecionar projeto ativo',
  'task.create': 'Criar tarefa',
  'task.update': 'Alterar tarefa',
  'task.assign': 'Atribuir tarefa',
  'task.status_change': 'Mudar status de tarefa',
  'task.complete': 'Concluir tarefa',
  'tool.use': 'Usar ferramentas',
  'change.prepare': 'Preparar alterações',
  'sandbox.execute': 'Executar em ambiente isolado',
  'approval.request': 'Solicitar aprovação',
  'repo.merge': 'Merge',
  'repo.push_main': 'Push direto na main',
  'deploy.publish': 'Deploy / publicação',
  'permissions.change': 'Mudar permissões',
  'secrets.access': 'Acessar segredos',
  'data.send_external': 'Enviar dados privados a provedores externos',
  'spend.create': 'Criar despesas / consumo pago',
};

const CATEGORY_LABELS: Record<PolicyCategory, string> = {
  observe: 'Observação e consultas',
  plan: 'Planejamento e propostas',
  project: 'Projetos',
  task: 'Tarefas',
  tool: 'Ferramentas',
  change: 'Preparação de alterações',
  sandbox: 'Execução isolada (futura)',
  approval: 'Aprovações',
  critical: 'Ações críticas',
};

const DECISION_LABELS: Record<PolicyDecision, string> = {
  ALLOW: 'Permitido',
  DENY: 'Negado',
  REQUIRE_APPROVAL: 'Exige aprovação',
  UNAVAILABLE: 'Indisponível',
};
const DECISION_TONES: Record<PolicyDecision, BadgeTone> = { ALLOW: 'success', DENY: 'danger', REQUIRE_APPROVAL: 'warning', UNAVAILABLE: 'neutral' };
const RISK_LABELS: Record<RiskLevel, string> = { low: 'baixo', medium: 'médio', high: 'alto' };

const REASON_TEXT: Record<PolicyReason, string> = {
  allowed_by_rule: 'Permitido por uma regra aprovada.',
  no_matching_rule: 'Nenhuma regra permite: negado por padrão.',
  unknown_action: 'Ação desconhecida.',
  malformed_request: 'Pedido malformado.',
  project_out_of_scope: 'Projeto fora do escopo.',
  agent_not_assigned: 'O agente não tem tarefa atribuída neste projeto.',
  agent_cannot_change_permissions: 'Agentes nunca alteram permissões.',
  main_is_protected: 'A main é protegida: push direto é sempre proibido.',
  restricted_by_rule: 'Restringido por uma regra específica.',
  approval_required: 'Exige aprovação específica do Product Owner.',
  approval_invalid: 'A aprovação apresentada não corresponde a esta operação.',
  approved: 'Aprovado para esta operação exata.',
  capability_unavailable: 'O ACC ainda não oferece esta capacidade.',
};

type Load =
  | { phase: 'loading'; projectId: string }
  | { phase: 'error'; projectId: string; error: ApiClientError }
  | { phase: 'ready'; projectId: string; matrix: PolicyMatrixResponse };

/** Visualização somente leitura das políticas do projeto ativo (Issue #020). */
export function PolicyPage() {
  const { activeProject, state: projects } = useProjects();
  const { sessionLost } = useAuth();
  const projectId = activeProject?.id ?? null;
  const [load, setLoad] = useState<Load | null>(null);
  const [subjectKey, setSubjectKey] = useState('');

  useEffect(() => {
    if (projectId === null) return;
    const controller = new AbortController();
    fetchPolicyMatrix(projectId, controller.signal)
      .then((matrix) => setLoad({ phase: 'ready', projectId, matrix }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const clientError = error instanceof ApiClientError ? error : new ApiClientError('internal');
        if (clientError.code === 'unauthenticated') sessionLost();
        setLoad({ phase: 'error', projectId, error: clientError });
      });
    return () => controller.abort();
  }, [projectId, sessionLost]);

  if (projects.phase === 'unavailable' || projects.phase === 'error') {
    return (
      <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p className="font-semibold">Políticas indisponíveis</p>
        <p className="mt-1">As políticas são avaliadas no servidor local, que não está acessível.</p>
      </div>
    );
  }
  if (activeProject === null && projects.phase === 'ready') {
    return <p role="status" className="text-sm text-slate-600">Selecione um projeto para ver as políticas aplicadas a ele.</p>;
  }
  const current = load && load.projectId === projectId ? load : null;
  if (current === null || current.phase === 'loading') {
    return <p role="status" className="text-sm text-slate-600">Carregando políticas…</p>;
  }
  if (current.phase === 'error') {
    return (
      <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-4 text-sm text-rose-900">
        <p className="font-semibold">Não foi possível carregar as políticas</p>
        <p className="mt-1">{ERROR_COPY[current.error.code].description}</p>
      </div>
    );
  }

  const { matrix } = current;
  const key = (s: PolicyMatrixResponse['subjects'][number]) => `${s.subject.kind}:${s.subject.id}`;
  const selected = matrix.subjects.find((s) => key(s) === subjectKey) ?? matrix.subjects[0];
  const byAction = new Map(selected.evaluations.map((e) => [e.action, e]));

  return (
    <div className="space-y-6">
      <div className="space-y-1 text-sm text-slate-600">
        <p>
          Autonomia <strong>semiautomática</strong>. O Product Owner é a autoridade final. Política <code>{matrix.policyVersion}</code>,
          somente leitura: alterações exigem PR aprovado.
        </p>
        <p>Sem regra explícita, a ação é negada. Atribuir uma tarefa a um agente não autoriza execução.</p>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        Ver decisões para
        <select className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm" value={key(selected)} onChange={(e) => setSubjectKey(e.target.value)}>
          {matrix.subjects.map((s) => (
            <option key={key(s)} value={key(s)}>
              {s.subject.kind === 'human' ? 'Você' : `${AGENT_LABELS[s.subject.id]} (agente)${s.assigned ? ' — com tarefa neste projeto' : ''}`}
            </option>
          ))}
        </select>
      </label>

      {POLICY_CATEGORIES.map((category) => {
        const actions = (Object.keys(POLICY_ACTIONS) as PolicyAction[]).filter((a) => POLICY_ACTIONS[a].category === category);
        return (
          <section key={category} aria-label={CATEGORY_LABELS[category]} className="rounded-xl border border-slate-200 bg-white">
            <h2 className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-900">{CATEGORY_LABELS[category]}</h2>
            <ul className="divide-y divide-slate-100">
              {actions.map((action) => {
                const evaluation = byAction.get(action)!;
                return (
                  <li key={action} aria-label={ACTION_LABELS[action]} className="flex flex-col gap-1 px-4 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <span className="font-medium text-slate-800">{ACTION_LABELS[action]}</span>{' '}
                      <span className="text-xs text-slate-500">risco {RISK_LABELS[POLICY_ACTIONS[action].risk]}</span>
                      <p className="text-xs text-slate-600">
                        {REASON_TEXT[evaluation.reason]}
                        {evaluation.decision === 'UNAVAILABLE' && evaluation.requiresApproval && ' Quando existir, exigirá aprovação.'}
                      </p>
                    </div>
                    <Badge tone={DECISION_TONES[evaluation.decision]}>{DECISION_LABELS[evaluation.decision]}</Badge>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
