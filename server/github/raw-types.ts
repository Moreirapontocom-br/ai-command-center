/**
 * Formato CRU esperado da resposta GraphQL do GitHub para `REPO_SNAPSHOT_QUERY`.
 * Todos os campos são tratados como possivelmente ausentes/nulos: a API pode omitir dados por
 * falta de permissão (erros parciais) e a normalização não deve presumir nada.
 * Estes tipos não saem do servidor — o frontend só conhece `shared/contracts.ts`.
 */

export interface RawCount {
  totalCount?: number | null;
}

export interface RawStatusRollup {
  state?: string | null;
}

export interface RawCommit {
  oid?: string | null;
  abbreviatedOid?: string | null;
  committedDate?: string | null;
  url?: string | null;
  statusCheckRollup?: RawStatusRollup | null;
}

export interface RawUser {
  login?: string | null;
  url?: string | null;
}

export interface RawLabel {
  name?: string | null;
  color?: string | null;
}

export interface RawIssue {
  number?: number | null;
  title?: string | null;
  state?: string | null;
  stateReason?: string | null;
  url?: string | null;
  updatedAt?: string | null;
  assignees?: { nodes?: (RawUser | null)[] | null } | null;
  labels?: { nodes?: (RawLabel | null)[] | null } | null;
}

export interface RawPullRequest {
  number?: number | null;
  title?: string | null;
  state?: string | null;
  isDraft?: boolean | null;
  url?: string | null;
  updatedAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  reviewDecision?: string | null;
  author?: RawUser | null;
  reviewRequests?: RawCount | null;
  assignees?: { nodes?: (RawUser | null)[] | null } | null;
  commits?: { nodes?: ({ commit?: RawCommit | null } | null)[] | null } | null;
}

export interface RawRef {
  name?: string | null;
  target?: RawCommit | null;
}

export interface RawRepository {
  nameWithOwner?: string | null;
  description?: string | null;
  url?: string | null;
  isPrivate?: boolean | null;
  isArchived?: boolean | null;
  updatedAt?: string | null;
  pushedAt?: string | null;
  defaultBranchRef?: RawRef | null;
  openIssueCount?: RawCount | null;
  closedIssueCount?: RawCount | null;
  openPullRequestCount?: RawCount | null;
  closedPullRequestCount?: RawCount | null;
  mergedPullRequestCount?: RawCount | null;
  openIssues?: { nodes?: (RawIssue | null)[] | null } | null;
  recentClosedIssues?: { nodes?: (RawIssue | null)[] | null } | null;
  openPullRequests?: { nodes?: (RawPullRequest | null)[] | null } | null;
  recentClosedPullRequests?: { nodes?: (RawPullRequest | null)[] | null } | null;
  refs?: (RawCount & { nodes?: (RawRef | null)[] | null }) | null;
}

export interface RawRateLimit {
  cost?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
}

export interface RawSnapshotData {
  rateLimit?: RawRateLimit | null;
  repository?: RawRepository | null;
}

export interface RawGraphQLError {
  type?: string;
  message?: string;
  path?: (string | number)[];
}

export interface RawGraphQLResponse<T> {
  data?: T | null;
  errors?: RawGraphQLError[];
}
