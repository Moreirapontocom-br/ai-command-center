import type { CiState, IssueItem, PullRequestItem, ReviewState } from '../../../shared/contracts.ts';
import type { BadgeTone } from '../../components/ui/Badge';
import type { ClientErrorCode } from '../../services/githubApi';

export const CI_LABELS: Record<CiState, { label: string; tone: BadgeTone }> = {
  success: { label: 'CI: sucesso', tone: 'success' },
  failure: { label: 'CI: falha', tone: 'danger' },
  pending: { label: 'CI: em execução', tone: 'warning' },
  unknown: { label: 'CI: sem informação', tone: 'neutral' },
};

export const CI_SHORT_LABELS: Record<CiState, string> = {
  success: 'Sucesso',
  failure: 'Falha',
  pending: 'Em execução',
  unknown: 'Sem informação',
};

export const REVIEW_LABELS: Record<ReviewState, { label: string; tone: BadgeTone } | null> = {
  pending: { label: 'Aguardando revisão', tone: 'violet' },
  approved: { label: 'Aprovado', tone: 'success' },
  changes_requested: { label: 'Alterações solicitadas', tone: 'danger' },
  unknown: { label: 'Revisão: sem informação', tone: 'neutral' },
  not_applicable: null,
};

export const PR_STATE_LABELS: Record<PullRequestItem['state'], { label: string; tone: BadgeTone }> = {
  open: { label: 'Aberto', tone: 'info' },
  closed: { label: 'Fechado sem merge', tone: 'neutral' },
  merged: { label: 'Incorporado', tone: 'violet' },
};

export function issueStateLabel(issue: IssueItem): { label: string; tone: BadgeTone } {
  if (issue.state === 'open') return { label: 'Aberta', tone: 'info' };
  if (issue.stateReason === 'not_planned') return { label: 'Fechada (não planejada)', tone: 'neutral' };
  if (issue.stateReason === 'duplicate') return { label: 'Fechada (duplicada)', tone: 'neutral' };
  return { label: 'Fechada', tone: 'success' };
}

/** Título e descrição de cada situação de erro, em linguagem do usuário. */
export const ERROR_COPY: Record<ClientErrorCode, { title: string; description: string }> = {
  server_unreachable: {
    title: 'Erro de rede',
    description: 'Não foi possível contatar o servidor de integração local.',
  },
  missing_credentials: {
    title: 'Credencial ausente',
    description: 'Nenhum token do GitHub está configurado no servidor.',
  },
  unauthorized: {
    title: 'Acesso negado',
    description: 'O GitHub recusou o token configurado: ele pode estar inválido, expirado ou revogado.',
  },
  forbidden: {
    title: 'Acesso negado',
    description: 'O token não tem permissão de leitura para este repositório.',
  },
  not_found: {
    title: 'Repositório não autorizado',
    description: 'O repositório não está na lista de repositórios autorizados do servidor.',
  },
  rate_limited: {
    title: 'Limite de requisições',
    description: 'A cota da API do GitHub foi atingida.',
  },
  too_many_requests: {
    title: 'Limite de requisições',
    description: 'Muitas atualizações em pouco tempo. Aguarde um instante.',
  },
  network: { title: 'Erro de rede', description: 'O servidor não conseguiu conectar à API do GitHub.' },
  timeout: { title: 'Erro de rede', description: 'A API do GitHub não respondeu a tempo.' },
  upstream_error: { title: 'GitHub indisponível', description: 'A API do GitHub está com instabilidade.' },
  upstream_invalid: {
    title: 'Dados inesperados',
    description: 'A resposta recebida não está no formato esperado.',
  },
  bad_request: { title: 'Requisição inválida', description: 'Os parâmetros enviados são inválidos.' },
  method_not_allowed: { title: 'Operação não permitida', description: 'O servidor aceita apenas leitura.' },
  forbidden_origin: { title: 'Origem não autorizada', description: 'Acesse o painel pelo endereço local.' },
  unauthenticated: { title: 'Sessão encerrada', description: 'Sua sessão expirou ou foi encerrada. Entre novamente.' },
  invalid_credentials: { title: 'Acesso negado', description: 'E-mail ou senha inválidos.' },
  auth_not_configured: { title: 'Administrador não configurado', description: 'Configure o administrador no servidor.' },
  unsupported_media_type: { title: 'Requisição inválida', description: 'Formato de dados não suportado.' },
  payload_too_large: { title: 'Requisição inválida', description: 'Dados enviados muito grandes.' },
  repository_not_allowed: {
    title: 'Repositório não autorizado',
    description: 'Só é possível vincular repositórios da lista autorizada do servidor.',
  },
  project_limit_reached: { title: 'Limite de projetos', description: 'O número máximo de projetos foi atingido.' },
  task_limit_reached: { title: 'Limite de tarefas', description: 'O número máximo de tarefas deste projeto foi atingido.' },
  invalid_status_transition: {
    title: 'Mudança de status não permitida',
    description: 'Essa mudança de status não é permitida a partir do status atual.',
  },
  dependencies_unresolved: {
    title: 'Dependências pendentes',
    description: 'Conclua ou cancele as tarefas das quais esta depende antes de iniciar, revisar ou concluir.',
  },
  policy_denied: { title: 'Negado pela política', description: 'A política de autonomia não permite esta ação.' },
  approval_required: { title: 'Aprovação necessária', description: 'Esta ação exige aprovação específica do Product Owner.' },
  capability_unavailable: { title: 'Indisponível', description: 'Esta operação ainda não existe nesta versão do ACC.' },
  audit_unavailable: {
    title: 'Auditoria indisponível',
    description: 'Não foi possível registrar a auditoria no servidor; a operação não foi concluída.',
  },
  dependency_cycle: { title: 'Dependência circular', description: 'Essas dependências formariam um ciclo entre tarefas.' },
  evidence_required: {
    title: 'Evidência obrigatória',
    description: 'Tarefa atribuída a agente só pode ser concluída com uma referência a PR ou branch como evidência.',
  },
  internal: { title: 'Erro inesperado', description: 'Ocorreu um erro interno no servidor.' },
};

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(iso: string | null): string {
  if (iso === null) return 'data indisponível';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'data indisponível' : DATE_TIME.format(date);
}
