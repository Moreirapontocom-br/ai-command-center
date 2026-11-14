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
