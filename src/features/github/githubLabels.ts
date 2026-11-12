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
  internal: { title: 'Erro inesperado', description: 'Ocorreu um erro interno no servidor.' },
};

const DATE_TIME = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(iso: string | null): string {
  if (iso === null) return 'data indisponível';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'data indisponível' : DATE_TIME.format(date);
}
