import type { ApprovalPresentation, PresentationIssue } from './approvalPresentation.ts';

/**
 * Contrato entre o servidor intermediário (`server/`) e o frontend (`src/`).
 *
 * Estes tipos são internos da aplicação e NÃO espelham a API do GitHub: o servidor converte as
 * respostas cruas (ver `server/github/raw-types.ts`) para estas estruturas. Nada aqui representa
 * estado de execução de agentes de IA.
 *
 * Este arquivo só pode conter tipos e constantes sem dependências (é importado pelo Node e pelo Vite).
 */

/** Estado agregado dos checks de CI de um commit. `unknown` = sem checks ou sem permissão para lê-los. */
export type CiState = 'success' | 'failure' | 'pending' | 'unknown';

/**
 * Situação de revisão de um PR, derivada apenas do que o GitHub confirma.
 * - `pending`: revisão exigida (`REVIEW_REQUIRED`) ou revisor solicitado e ainda não respondido.
 * - `unknown`: PR aberto sem informação suficiente para afirmar se aguarda revisão.
 * - `not_applicable`: PR em draft, fechado ou incorporado.
 */
export type ReviewState = 'pending' | 'approved' | 'changes_requested' | 'unknown' | 'not_applicable';

export interface GitHubUserRef {
  login: string;
  url: string | null;
}

export interface LabelRef {
  name: string;
  /** Cor hexadecimal sem `#`, validada pelo servidor; `null` se ausente ou inválida. */
  color: string | null;
}

export interface IssueItem {
  number: number;
  title: string;
  repository: string;
  state: 'open' | 'closed';
  /** Motivo do fechamento informado pelo GitHub, quando houver. */
  stateReason: 'completed' | 'not_planned' | 'duplicate' | 'reopened' | null;
  assignees: GitHubUserRef[];
  labels: LabelRef[];
  updatedAt: string;
  url: string;
}

export interface PullRequestItem {
  number: number;
  title: string;
  repository: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  author: string | null;
  assignees: GitHubUserRef[];
  review: ReviewState;
  ci: CiState;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
}

export interface BranchItem {
  name: string;
  isDefault: boolean;
  headSha: string | null;
  headShortSha: string | null;
  headUrl: string | null;
  committedAt: string | null;
  ci: CiState;
}

export interface RepositoryInfo {
  fullName: string;
  description: string | null;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
  pushedAt: string | null;
}

export interface RepoMetrics {
  openIssues: number;
  closedIssues: number;
  openPullRequests: number;
  mergedPullRequests: number;
  closedUnmergedPullRequests: number;
  /**
   * PRs abertos aguardando revisão confirmada pelos dados.
   * `complete` é falso quando nem todos os PRs abertos foram carregados (lista truncada).
   * `undetermined` conta PRs abertos (não draft) sem informação suficiente.
   */
  awaitingReview: { count: number; undetermined: number; complete: boolean };
  branches: number;
  ci: {
    defaultBranch: CiState;
    openPullRequests: Record<CiState, number>;
  };
}

export interface RepoSnapshot {
  repository: RepositoryInfo;
  metrics: RepoMetrics;
  /** Issues abertas mais recentes seguidas das fechadas recentemente. Não inclui PRs. */
  issues: IssueItem[];
  /** PRs abertos seguidos dos fechados/incorporados recentemente. */
  pullRequests: PullRequestItem[];
  branches: BranchItem[];
  truncated: { openIssues: boolean; openPullRequests: boolean; branches: boolean };
  /** Avisos sobre dados parciais (ex.: campo que o token não pode ler). Nunca contém segredos. */
  warnings: string[];
  /** Momento (ISO 8601) da última consulta bem-sucedida ao GitHub. */
  fetchedAt: string;
}

export type ApiErrorCode =
  | 'missing_credentials'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'too_many_requests'
  | 'network'
  | 'timeout'
  | 'upstream_invalid'
  | 'upstream_error'
  | 'bad_request'
  | 'method_not_allowed'
  | 'forbidden_origin'
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'auth_not_configured'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'repository_not_allowed'
  | 'project_limit_reached'
  | 'task_limit_reached'
  | 'invalid_status_transition'
  | 'dependencies_unresolved'
  | 'dependency_cycle'
  | 'evidence_required'
  | 'audit_unavailable'
  | 'policy_denied'
  | 'approval_required'
  | 'capability_unavailable'
  | 'approvals_unavailable'
  | 'confirmation_failed'
  | 'confirmation_required'
  | 'confirmation_locked'
  | 'approval_conflict'
  | 'approval_expired'
  | 'approval_binding_mismatch'
  | 'approval_presentation_invalid'
  | 'approval_blocked'
  // Issue #008 — ordens do Claude Code (fluxo assistido) e verificação do PR.
  | 'order_conflict'
  | 'order_closed'
  | 'order_expired'
  | 'project_not_enabled'
  | 'secret_detected'
  | 'pr_reference_invalid'
  | 'verification_limit'
  | 'head_changed'
  | 'github_unavailable'
  | 'github_unauthorized'
  | 'gateway_unavailable'
  // Issue #055 — ponte MCP local desligada nesta instância ou sem credencial ativa no projeto.
  | 'bridge_unavailable'
  | 'internal';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Para limites de requisição: momento ISO em que a cota é restaurada, se conhecido. */
    resetAt?: string;
    retryAfterSeconds?: number;
  };
}

export interface StatusResponse {
  /** `true` quando há credencial válida configurada no servidor. Nunca inclui a credencial. */
  configured: boolean;
  /** `gh-cli`: sessão local do GitHub CLI, apenas para desenvolvimento local. */
  authMode: 'fine-grained-token' | 'gh-cli' | 'none';
  repositories: string[];
}

export interface SnapshotResponse {
  snapshot: RepoSnapshot;
  freshness: {
    /** `true` quando o servidor devolveu o último snapshot em cache porque a atualização falhou. */
    stale: boolean;
    staleReason: ApiErrorCode | null;
  };
}

/** Resposta de `GET /api/auth/session` e do login. Nunca contém senha, hash ou valor do cookie. */
export type SessionResponse =
  | {
      authenticated: true;
      user: { email: string };
      /** Expiração absoluta da sessão (ISO 8601). A sessão também expira por inatividade. */
      expiresAt: string;
    }
  | {
      authenticated: false;
      /** `false` quando o servidor ainda não tem administrador configurado. */
      authConfigured: boolean;
    };

export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Projetos (Issue #004). Um projeto existe sem GitHub: os repositórios são vínculos opcionais,
 * escolhidos apenas entre os autorizados no servidor (`linkableRepositories`).
 */
export const PROJECT_STATUSES = ['planning', 'active', 'paused', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Limites validados no servidor (o formulário usa os mesmos valores). Tamanhos em caracteres. */
export const PROJECT_LIMITS = {
  nameMax: 100,
  descriptionMax: 2000,
  objectiveMax: 1000,
  repositoriesMax: 10,
  projectsPerOwnerMax: 100,
} as const;

export interface Project {
  /** UUID v4 gerado pelo servidor. */
  id: string;
  name: string;
  description: string;
  objective: string;
  status: ProjectStatus;
  /** `owner/repo` vinculados, sempre contidos na allowlist do servidor. O primeiro é o principal. */
  repositories: string[];
  createdAt: string;
  updatedAt: string;
}

/** Corpo de `POST /api/projects`. Só `name` é obrigatório. */
export interface ProjectCreateRequest {
  name: string;
  description?: string;
  objective?: string;
  status?: ProjectStatus;
  repositories?: string[];
}

/** Corpo de `POST /api/projects/:id` (atualização parcial; ao menos um campo). */
export type ProjectUpdateRequest = Partial<ProjectCreateRequest>;

export interface ProjectListResponse {
  projects: Project[];
  /** Projeto ativo do usuário, persistido no servidor; `null` se nenhum foi selecionado. */
  activeProjectId: string | null;
  /** Repositórios que podem ser vinculados (allowlist do servidor ∩ escopo da sessão). */
  linkableRepositories: string[];
}

/** Corpo de `POST /api/projects/active` e sua resposta. */
export interface ActiveProjectRequest {
  projectId: string | null;
}
export interface ActiveProjectResponse {
  activeProjectId: string | null;
}

/**
 * Tarefas (Issue #005). O status é INTERNO ao ACC: não é copiado nem inferido do GitHub. Uma
 * referência a issue/PR/branch é só um vínculo informativo; nada é concluído automaticamente.
 */
export const TASK_STATUSES = ['pending', 'planned', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Status permitidos na criação: trabalho não nasce "em andamento" nem "concluído". */
export const TASK_INITIAL_STATUSES: readonly TaskStatus[] = ['pending', 'planned'];

/** Transições permitidas (origem → destinos). Reabrir é explícito: concluída → em andamento. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['planned', 'in_progress', 'blocked', 'cancelled'],
  planned: ['pending', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['planned', 'blocked', 'in_review', 'done', 'cancelled'],
  blocked: ['pending', 'planned', 'in_progress', 'cancelled'],
  in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['pending'],
};

/** Status que exigem todas as dependências resolvidas (concluídas ou canceladas). */
export const TASK_WORK_STATUSES: readonly TaskStatus[] = ['in_progress', 'in_review', 'done'];

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Agentes previstos (Issue #026). Atribuir uma tarefa a um agente NÃO autoriza nem inicia execução. */
export const AGENT_IDS = ['chatgpt', 'claude-code', 'gemini', 'nemotron'] as const;
export type AgentRef = (typeof AGENT_IDS)[number];

export type TaskAssignee = { kind: 'human'; userId: string } | { kind: 'agent'; agentId: AgentRef };

/** Origem: só o servidor define. Pelo navegador, toda tarefa é `manual`. */
export const TASK_ORIGINS = ['manual', 'integration', 'agent'] as const;
export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/** Vínculo externo informativo, sempre a um repositório vinculado ao projeto. Nunca consultado para inferir status. */
export type TaskReference =
  | { kind: 'issue' | 'pull_request'; repository: string; number: number }
  | { kind: 'branch'; repository: string; name: string };

export interface TaskHistoryEntry {
  at: string;
  /** `userId` de quem fez a alteração (sempre uma pessoa autenticada nesta versão). */
  actor: string;
  action: 'created' | 'updated' | 'status_changed' | 'assignee_changed';
  /** Campos alterados (em `updated`). */
  fields?: string[];
  from?: string | null;
  to?: string | null;
}

export const TASK_LIMITS = {
  titleMax: 200,
  descriptionMax: 4000,
  blockedReasonMax: 500,
  dependenciesMax: 20,
  referencesMax: 10,
  tasksPerProjectMax: 300,
  historyMax: 50,
} as const;

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: TaskAssignee | null;
  /** Ids de tarefas do MESMO projeto das quais esta depende. Sem ciclos. */
  dependsOn: string[];
  references: TaskReference[];
  origin: TaskOrigin;
  /** Obrigatório (não vazio) quando `status` é `blocked`; vazio nos demais. */
  blockedReason: string;
  /**
   * Conclusão confirmada por uma pessoa autenticada. Uma tarefa atribuída a agente só pode ser
   * concluída com evidência (referência a PR ou branch) e a confirmação é sempre humana.
   */
  completion: { confirmedBy: string; confirmedAt: string } | null;
  history: TaskHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Corpo de `POST /api/projects/:id/tasks`. Só `title` é obrigatório. */
export interface TaskCreateRequest {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: TaskAssignee | null;
  dependsOn?: string[];
  references?: TaskReference[];
}

/** Corpo de `POST /api/projects/:id/tasks/:taskId` (parcial; ao menos um campo). */
export type TaskUpdateRequest = Partial<TaskCreateRequest> & { blockedReason?: string };

export interface TaskListResponse {
  tasks: Task[];
  /** Pessoas que podem receber tarefas (nesta versão, apenas o usuário da sessão). */
  assignableUsers: Array<{ userId: string; label: string }>;
  agents: AgentRef[];
}

/**
 * Auditoria (Issue #006). Eventos somente de adição: a API não oferece edição nem exclusão.
 * O autor vem sempre da sessão ou do próprio servidor, nunca do navegador. `context` só aceita
 * valores do tipo "token" (ids, enums, nomes de campos), nunca texto livre (títulos, descrições,
 * e-mails, senhas, cookies ou tokens).
 */
export const AUDIT_ACTIONS = [
  'project.created',
  'project.updated',
  'project.activated',
  'task.created',
  'task.updated',
  'task.status_changed',
  'task.assignee_changed',
  'task.completion_confirmed',
  'auth.login',
  'auth.logout',
  'auth.login_rejected',
  'access.denied',
  'policy.decision',
  // Issue #011 (PR 2): espelho, na auditoria da #006, do histórico oficial de aprovações.
  'approval.confirmation',
  'approval.decision',
  'approval.attempt_acknowledged',
  'approval.configuration',
  'approval.hold',
  // Issue #008: espelho dos eventos das ordens do Claude Code (histórico oficial = ledger do gateway).
  'claude_order.requested',
  'claude_order.package_released',
  'claude_order.forwarded',
  'claude_order.pr_linked',
  'claude_order.verified',
  'claude_order.cancelled',
  'claude_project.enablement',
  // Issue #055: ponte MCP local (o agente age pela credencial da ponte; o PO confirma com step-up).
  'claude_order.offered',
  'claude_order.claimed',
  'claude_order.pr_proposed',
  'claude_order.pr_confirmed',
  'claude_bridge.credential',
  'claude_bridge.access',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_OUTCOMES = ['success', 'failure', 'blocked'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/**
 * `human`: pessoa autenticada (`id` = userId). `system`: o próprio servidor, inclusive em nome de
 * um cliente NÃO autenticado (`id` = `anonymous`). `agent`: reservado para execuções futuras de
 * agentes; nenhum evento desta versão usa esse tipo.
 */
export type AuditActor = { kind: 'human' | 'agent' | 'system'; id: string };

export type AuditContextValue = string | number | boolean | null | string[];

export interface AuditEvent {
  id: string;
  /** Sequência global crescente: define a ordem determinística (pode ter lacunas). */
  seq: number;
  at: string;
  action: AuditAction;
  actor: AuditActor;
  projectId: string | null;
  resource: { type: 'project' | 'task' | 'session' | 'route' | 'approval' | 'claude_order' | 'bridge_credential'; id: string | null };
  outcome: AuditOutcome;
  context: Record<string, AuditContextValue>;
}

export const AUDIT_QUERY_LIMITS = { defaultLimit: 50, maxLimit: 200 } as const;

export interface AuditListResponse {
  /** Mais recentes primeiro (ordem decrescente de `seq`). */
  events: AuditEvent[];
  /** Passe como `before` para a próxima página; `null` quando não há mais eventos. */
  nextBefore: number | null;
  /** Eventos antigos já descartados pela política de retenção (por arquivo de origem). */
  retention: { droppedEvents: number };
}

/**
 * Políticas de autonomia (Issue #020). Avaliação determinística, NEGADA POR PADRÃO: nenhuma ação é
 * permitida só por falta de regra. Autonomia oficial: semiautomática (B). O Product Owner é a
 * autoridade final; a política é código revisado (alterá-la exige PR aprovado).
 */
export const POLICY_DECISIONS = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'UNAVAILABLE'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const POLICY_CATEGORIES = ['observe', 'plan', 'project', 'task', 'tool', 'change', 'sandbox', 'approval', 'critical'] as const;
export type PolicyCategory = (typeof POLICY_CATEGORIES)[number];

export interface PolicyActionInfo {
  category: PolicyCategory;
  risk: RiskLevel;
  /** Ação crítica: nunca liberada de forma autônoma; exige aprovação específica do PO. */
  critical: boolean;
  /** `false` quando o ACC ainda não tem a capacidade/infraestrutura (resulta em UNAVAILABLE). */
  available: boolean;
}

/** Catálogo fechado de ações avaliáveis. Ação fora do catálogo é negada. */
export const POLICY_ACTIONS = {
  'project.read': { category: 'observe', risk: 'low', critical: false, available: true },
  'task.read': { category: 'observe', risk: 'low', critical: false, available: true },
  'github.read': { category: 'observe', risk: 'low', critical: false, available: true },
  'audit.read': { category: 'observe', risk: 'low', critical: false, available: true },
  'policy.read': { category: 'observe', risk: 'low', critical: false, available: true },
  'task.propose': { category: 'plan', risk: 'low', critical: false, available: false },
  'project.create': { category: 'project', risk: 'medium', critical: false, available: true },
  'project.update': { category: 'project', risk: 'medium', critical: false, available: true },
  'project.select': { category: 'project', risk: 'low', critical: false, available: true },
  'task.create': { category: 'task', risk: 'medium', critical: false, available: true },
  'task.update': { category: 'task', risk: 'medium', critical: false, available: true },
  'task.assign': { category: 'task', risk: 'medium', critical: false, available: true },
  'task.status_change': { category: 'task', risk: 'medium', critical: false, available: true },
  'task.complete': { category: 'task', risk: 'medium', critical: false, available: true },
  'tool.use': { category: 'tool', risk: 'medium', critical: false, available: false },
  // Issue #028 (D2): invocação de um agente pelo Agent Gateway. Indisponível até haver adaptador aprovado.
  'agent.invoke': { category: 'tool', risk: 'medium', critical: false, available: false },
  'change.prepare': { category: 'change', risk: 'medium', critical: false, available: false },
  'sandbox.execute': { category: 'sandbox', risk: 'high', critical: false, available: false },
  'approval.request': { category: 'approval', risk: 'low', critical: false, available: false },
  'repo.merge': { category: 'critical', risk: 'high', critical: true, available: false },
  'repo.push_main': { category: 'critical', risk: 'high', critical: true, available: false },
  'deploy.publish': { category: 'critical', risk: 'high', critical: true, available: false },
  'permissions.change': { category: 'critical', risk: 'high', critical: true, available: false },
  'secrets.access': { category: 'critical', risk: 'high', critical: true, available: false },
  'data.send_external': { category: 'critical', risk: 'high', critical: true, available: false },
  'spend.create': { category: 'critical', risk: 'high', critical: true, available: false },
} as const satisfies Record<string, PolicyActionInfo>;
export type PolicyAction = keyof typeof POLICY_ACTIONS;

export type PolicySubject = { kind: 'human'; id: string } | { kind: 'agent'; id: AgentRef };

export const POLICY_REASONS = [
  'allowed_by_rule',
  'no_matching_rule',
  'unknown_action',
  'malformed_request',
  'project_out_of_scope',
  'agent_not_assigned',
  'agent_cannot_change_permissions',
  'main_is_protected',
  'restricted_by_rule',
  'approval_required',
  'approval_invalid',
  'approved',
  'capability_unavailable',
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export interface PolicyEvaluation {
  decision: PolicyDecision;
  action: string;
  risk: RiskLevel | null;
  reason: PolicyReason;
  /** Regra que decidiu (`null` em negação por padrão e nas regras fixas). */
  ruleId: string | null;
  /** A ação exigiria aprovação específica do PO, mesmo que hoje esteja indisponível. */
  requiresApproval: boolean;
  /** Aprovação aceita (quem chama deve consumi-la: uso único). */
  approvalId: string | null;
}

/**
 * Forma da aprovação (Issue #011, N4):
 * - `approval`: o PO aprova a ação de OUTRO sujeito (ex.: um agente). Regra padrão.
 * - `owner_confirmation`: o próprio PO confirma uma operação crítica que ele mesmo iniciou, com
 *   reautenticação recente (D2). Só vale quando o servidor atestou o grant pelo núcleo de
 *   aprovações (`PolicyFacts.verifiedOwnerConfirmationId`); nunca para sujeitos agentes.
 */
export const APPROVAL_METHODS = ['approval', 'owner_confirmation'] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

/**
 * Contrato de aprovação (o fluxo completo é da Issue #011). Vale para UMA operação exata:
 * ação, projeto, recurso, alvo (SHA/ref), sujeito, validade e uso único.
 */
export interface ApprovalGrant {
  id: string;
  /** Ausente = `approval` (compatível com os grants da #020/#021/#022). */
  method?: ApprovalMethod;
  action: PolicyAction;
  projectId: string | null;
  resource: { type: string; id: string };
  target: { sha: string | null; ref: string | null };
  subject: PolicySubject;
  approvedBy: { kind: 'human'; id: string };
  approvedAt: string;
  expiresAt: string;
}

export interface PolicyMatrixResponse {
  policyVersion: string;
  projectId: string;
  subjects: Array<{ subject: PolicySubject; assigned: boolean; evaluations: PolicyEvaluation[] }>;
}

/**
 * Aprovações humanas (Issue #011, PR 2) — formato das respostas da API. A autoridade é sempre o
 * servidor: o navegador só exibe o vínculo, confere o resumo e envia a decisão com a prova de
 * confirmação de identidade. Aprovar NUNCA executa nada nem torna disponível uma capacidade
 * indisponível; a execução real continua desligada.
 */
export const APPROVAL_STATE_NAMES = ['pending', 'approved', 'rejected', 'withdrawn', 'expired', 'superseded', 'consumed', 'revoked'] as const;
export type ApprovalStateName = (typeof APPROVAL_STATE_NAMES)[number];
export const APPROVAL_CLASS_NAMES = ['execution', 'configuration', 'merge', 'publication', 'cost'] as const;
export type ApprovalClassName = (typeof APPROVAL_CLASS_NAMES)[number];
export const APPROVAL_ATTEMPT_STATE_NAMES = ['reserved', 'succeeded', 'failed', 'indeterminate', 'acknowledged_by_owner'] as const;
export type ApprovalAttemptStateName = (typeof APPROVAL_ATTEMPT_STATE_NAMES)[number];
export const APPROVAL_HOLD_REASONS = ['incident', 'security_review', 'dispute', 'legal'] as const;
export type ApprovalHoldReason = (typeof APPROVAL_HOLD_REASONS)[number];

/**
 * Vínculo exato (o que o administrador confere). Os parâmetros entram pelo `paramsDigest`; os
 * valores legíveis vêm em `ApprovalDetail.presentation` (correção R1), conferidos contra ele.
 */
export interface ApprovalBindingView {
  action: string;
  projectId: string | null;
  resource: { type: string; id: string };
  target: { sha: string | null; ref: string | null };
  subject: PolicySubject;
  paramsDigest: string;
  policyVersion: string;
}

export interface ApprovalSummary {
  id: string;
  class: ApprovalClassName;
  method: ApprovalMethod;
  action: string;
  projectId: string | null;
  /** Nome do projeto do próprio dono (exibição); `null` sem projeto ou se ele não existe mais. */
  projectName: string | null;
  subject: PolicySubject;
  requestedBy: { kind: 'system' | 'human'; id: string };
  state: ApprovalStateName;
  requestedAt: string;
  pendingUntil: string;
  validUntil: string | null;
  decidedAt: string | null;
  closedReason: string | null;
}

export interface ApprovalAttemptView {
  id: string;
  component: string;
  state: ApprovalAttemptStateName;
  reservedAt: string;
  outcomeAt: string | null;
  reason: string | null;
}

export interface ApprovalHoldView {
  id: string;
  approvalId: string;
  reason: ApprovalHoldReason;
  note: string | null;
  createdAt: string;
}

export interface ApprovalDetail extends ApprovalSummary {
  binding: ApprovalBindingView;
  /** Resumo canônico do vínculo; o navegador recalcula e só permite decidir se for igual. */
  bindingDigest: string;
  /**
   * `true` só se o vínculo estiver íntegro E os parâmetros exatos estiverem presentes, no formato
   * esperado e coerentes com o `paramsDigest` (verificado pelo servidor). `false` → aprovar é
   * recusado; rejeitar continua possível.
   */
  presentable: boolean;
  /**
   * Parâmetros exatos (formato fechado, somente leitura; nunca segredos), entregues pelo
   * componente do servidor que pediu. `null` se ausentes ou inválidos.
   */
  presentation: ApprovalPresentation | null;
  /** Resumo vínculo + parâmetros calculado pelo servidor; o navegador recalcula e envia ao aprovar. */
  presentationDigest: string | null;
  /** Motivo (token) quando a apresentação não pôde ser verificada; `null` se válida. */
  presentationIssue: PresentationIssue | 'binding_mismatch' | null;
  decidedBy: { kind: 'human'; id: string } | null;
  confirmationMethod: string | null;
  attempts: ApprovalAttemptView[];
  holds: ApprovalHoldView[];
}

export interface ApprovalSubsystemStatus {
  state: 'available' | 'degraded' | 'unavailable';
  /** Motivo como token (ex.: `not_configured`, `store_not_initialized`); nunca caminhos ou segredos. */
  reason: string | null;
  barriers: { global: boolean; projects: string[] };
  /** Sempre `false` nesta versão: aprovar não executa nada. */
  realExecutionEnabled: false;
}

export interface ApprovalListResponse {
  subsystem: ApprovalSubsystemStatus;
  approvals: ApprovalSummary[];
}

export interface ApprovalDetailResponse {
  approval: ApprovalDetail;
}

export type ApprovalHistoryItemView =
  | {
      kind: 'entry';
      seq: number;
      at: string;
      event: string;
      actor: { kind: 'human' | 'system'; id: string };
      approvalId: string | null;
      attemptId: string | null;
      projectId: string | null;
      class: ApprovalClassName | null;
      action: string | null;
      from: string | null;
      to: string | null;
      reason: string | null;
    }
  | { kind: 'tombstone'; firstSeq: number; seq: number; purged: number };

export interface ApprovalHistoryResponse {
  retentionDays: number;
  retentionLimits: { min: number; max: number };
  /** Mais recentes primeiro. */
  items: ApprovalHistoryItemView[];
  nextBefore: number | null;
  holds: ApprovalHoldView[];
}

/** Prova de confirmação de identidade: uso único, presa à sessão, válida por no máximo 5 minutos. */
export interface StepUpResponse {
  proofId: string;
  expiresAt: string;
}

// ---------- Issue #008: ordens de trabalho do Claude Code (fluxo assistido) ----------

/**
 * Estado PROJETADO da ordem (§5.1). `awaiting_approval` antecede `prepared` (escopo pedido, à espera
 * das duas aprovações). `verified` só vale para o `headSha` confirmado numa leitura recente.
 */
export const CLAUDE_ORDER_STATES = ['awaiting_approval', 'prepared', 'delivered', 'awaiting_pr', 'pr_linked', 'verified', 'rejected', 'expired', 'cancelled'] as const;
export type ClaudeOrderState = (typeof CLAUDE_ORDER_STATES)[number];

export interface ClaudeOrderRuleView {
  rule: string;
  result: 'ok' | 'pending' | 'fail' | 'info';
  reason: string | null;
}

export interface ClaudeOrderVerificationView {
  id: string;
  seq: number;
  headSha: string | null;
  baseSha: string;
  verdict: 'conforming' | 'needs_review' | 'nonconforming' | 'cancelled';
  rules: ClaudeOrderRuleView[];
  supersedes: string | null;
  checkedAt: string;
  closes: boolean;
  reason: string | null;
}

export interface ClaudeOrderView {
  orderId: string;
  projectId: string;
  taskId: string;
  agentId: 'claude-code';
  repository: string;
  baseSha: string;
  workBranch: string;
  /** Resumo do objetivo e dos critérios (o texto não é devolvido na listagem). */
  inputDigest: string;
  criteriaCount: number;
  dataRefs: Array<{ kind: string; ref: string }>;
  createdAt: string;
  state: ClaudeOrderState;
  stateReason: string | null;
  scope: { id: string; state: string; validUntil: string | null; approvalDeadline: string; policyVersion: string };
  approvals: Array<{ action: 'agent.invoke' | 'data.send_external'; approvalId: string | null; state: string }>;
  package: { digest: string; releasedAt: string | null; relayDeadline: string | null } | null;
  forwardedAt: string | null;
  pullRequest: { number: number; reference: string; url: string; linkedAt: string } | null;
  verification: {
    latest: ClaudeOrderVerificationView | null;
    /** A conformidade da última entrada vale para a cabeça lida há pouco (leitura atual)? */
    current: boolean;
    staleReason: 'not_rechecked' | 'head_changed' | null;
    observedHeadSha: string | null;
    observedAt: string | null;
    used: number;
    max: number;
    nextAllowedAt: string | null;
  };
  history: ClaudeOrderVerificationView[];
  closed: boolean;
  /** Issue #055: entrega pela ponte MCP (`null`: a ordem não foi disponibilizada à ponte). */
  bridge: ClaudeOrderBridgeView | null;
}

/** Issue #055 — situação da ordem na ponte MCP. O pacote e a credencial nunca aparecem aqui. */
export interface ClaudeOrderBridgeView {
  offeredAt: string;
  /** Recebimento atômico pelo agente (uma vez por ordem). */
  claim: { id: string; at: string; credentialId: string | null } | null;
  /** PR PROPOSTO mais recente (nunca é vínculo: só a confirmação do PO, com step-up, vincula). */
  proposal: { id: string; number: number; reference: string; url: string; proposedAt: string; status: 'pending' | 'confirmed' | 'closed' } | null;
  proposals: number;
  maxProposals: number;
}

/** Issue #055 — credencial LOCAL da ponte (nunca o token nem o resumo dele). */
export interface ClaudeBridgeCredentialView {
  id: string;
  projectId: string;
  agentId: 'claude-code';
  createdAt: string;
  expiresAt: string;
  state: 'active' | 'revoked' | 'expired';
  revokedAt: string | null;
  revokedReason: string | null;
}

/** Issue #055 — ponte no projeto: ligada nesta instância? Endereço local e credencial vigente. */
export interface ClaudeBridgeStatusView {
  enabled: boolean;
  endpoint: string | null;
  credential: ClaudeBridgeCredentialView | null;
}

/** Criação da credencial: o token aparece SÓ nesta resposta (o servidor guarda apenas o resumo). */
export interface ClaudeBridgeCredentialResponse {
  credential: ClaudeBridgeCredentialView;
  token: string;
  /** Comando do Claude Code (montado pelo SERVIDOR) que registra a ponte no escopo local do PO. */
  command: string;
}

/** Confirmação do PR proposto: o vínculo e, na mesma ação, a verificação somente leitura. */
export interface ClaudeOrderConfirmResponse {
  order: ClaudeOrderView;
  outcome: ClaudeOrderVerifyResponse['outcome'] | null;
  /** Código público da falha da verificação (o vínculo já foi gravado; verifique de novo depois). */
  verificationError: ApiErrorCode | null;
}

export interface ClaudeOrderListResponse {
  gateway: { state: 'available' | 'unavailable'; reason: string | null };
  enablement: { enabled: boolean; repository: string | null; at: string | null };
  /** Repositórios vinculados ao projeto que podem ser habilitados. */
  linkableRepositories: string[];
  orders: ClaudeOrderView[];
  /** Issue #055: ponte MCP local. */
  bridge: ClaudeBridgeStatusView;
}

export interface ClaudeOrderResponse {
  order: ClaudeOrderView;
}

/** Liberação: o pacote em texto, só nesta resposta (nunca na listagem). */
export interface ClaudeOrderPackageResponse {
  order: ClaudeOrderView;
  package: string;
}

export interface ClaudeOrderVerifyResponse {
  order: ClaudeOrderView;
  outcome: {
    headSha: string | null;
    verdict: 'conforming' | 'needs_review' | 'nonconforming';
    /** `false`: mesma cabeça e mesmo resultado da última entrada (nada novo gravado). */
    created: boolean;
    rules: ClaudeOrderRuleView[];
    alerts: string[];
    checks: { state: string | null; failing: string[]; pending: string[]; total: number };
    commits: { total: number; listed: number; truncated: boolean; authors: Array<{ author: string | null; committer: string | null; signatureValid: boolean | null }> };
    files: { total: number; complete: boolean; forbidden: string[] };
    state: { isDraft: boolean | null; mergeable: string | null; reviewDecision: string | null; prState: string | null };
    compare: { status: string | null; aheadBy: number | null; behindBy: number | null };
  };
}

export interface ClaudeEnablementResponse {
  enablement: { enabled: boolean; repository: string | null; at: string | null };
}
