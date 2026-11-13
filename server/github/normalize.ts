import type {
  BranchItem,
  CiState,
  GitHubUserRef,
  IssueItem,
  LabelRef,
  PullRequestItem,
  RepoSnapshot,
  ReviewState,
} from '../../shared/contracts.ts';
import { IntegrationError } from './errors.ts';
import type {
  RawCommit,
  RawGraphQLError,
  RawIssue,
  RawPullRequest,
  RawRef,
  RawSnapshotData,
  RawUser,
} from './raw-types.ts';

/**
 * Funções puras de transformação: resposta crua do GitHub → contrato interno.
 * Regra geral: nunca inventar valores. Campo obrigatório ausente descarta o item (com aviso);
 * campo opcional ausente vira `null`/`unknown`.
 */

const GITHUB_WEB_PREFIX = 'https://github.com/';
const MAX_WARNINGS = 10;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Aceita apenas links https para github.com — impede `javascript:` ou domínios externos na UI. */
function githubUrl(value: unknown): string | null {
  const url = str(value);
  return url !== null && url.startsWith(GITHUB_WEB_PREFIX) ? url : null;
}

function isoDate(value: unknown): string | null {
  const text = str(value);
  return text !== null && !Number.isNaN(Date.parse(text)) ? text : null;
}

function nodes<T>(connection: { nodes?: (T | null)[] | null } | null | undefined): T[] {
  const list = connection?.nodes;
  return Array.isArray(list) ? list.filter((node): node is T => node !== null && typeof node === 'object') : [];
}

export function mapCiState(rollup: { state?: string | null } | null | undefined): CiState {
  switch (rollup?.state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'unknown';
  }
}

export function mapReviewState(pr: {
  state: PullRequestItem['state'];
  isDraft: boolean;
  reviewDecision: string | null | undefined;
  requestedReviewers: number | null;
}): ReviewState {
  if (pr.state !== 'open' || pr.isDraft) return 'not_applicable';
  // Revisor solicitado que ainda não respondeu: o GitHub remove o pedido quando a revisão é enviada.
  if (pr.requestedReviewers !== null && pr.requestedReviewers > 0) return 'pending';
  switch (pr.reviewDecision) {
    case 'REVIEW_REQUIRED':
      return 'pending';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'APPROVED':
      return 'approved';
    default:
      // `reviewDecision` é null quando o repositório não exige revisão: não é possível afirmar nada.
      return 'unknown';
  }
}

function mapUsers(connection: { nodes?: (RawUser | null)[] | null } | null | undefined): GitHubUserRef[] {
  return nodes(connection).flatMap((user) => {
    const login = str(user.login);
    return login === null ? [] : [{ login, url: githubUrl(user.url) }];
  });
}

function mapLabels(raw: RawIssue['labels']): LabelRef[] {
  return nodes(raw).flatMap((label) => {
    const name = str(label.name);
    if (name === null) return [];
    const color = str(label.color);
    return [{ name, color: color !== null && /^[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null }];
  });
}

const ISSUE_STATE_REASONS = ['completed', 'not_planned', 'duplicate', 'reopened'] as const;

export function normalizeIssue(raw: RawIssue, repository: string): IssueItem | null {
  const number = int(raw.number);
  const title = str(raw.title);
  const url = githubUrl(raw.url);
  const updatedAt = isoDate(raw.updatedAt);
  const state = raw.state === 'OPEN' ? 'open' : raw.state === 'CLOSED' ? 'closed' : null;
  if (number === null || title === null || url === null || updatedAt === null || state === null) {
    return null;
  }
  const reason = str(raw.stateReason)?.toLowerCase();
  return {
    number,
    title,
    repository,
    state,
    stateReason: ISSUE_STATE_REASONS.find((value) => value === reason) ?? null,
    assignees: mapUsers(raw.assignees),
    labels: mapLabels(raw.labels),
    updatedAt,
    url,
  };
}

function headCommit(raw: RawPullRequest): RawCommit | null {
  const last = nodes(raw.commits).at(-1);
  return last?.commit ?? null;
}

export function normalizePullRequest(raw: RawPullRequest, repository: string): PullRequestItem | null {
  const number = int(raw.number);
  const title = str(raw.title);
  const url = githubUrl(raw.url);
  const updatedAt = isoDate(raw.updatedAt);
  const headRef = str(raw.headRefName);
  const baseRef = str(raw.baseRefName);
  const state =
    raw.state === 'OPEN' ? 'open' : raw.state === 'CLOSED' ? 'closed' : raw.state === 'MERGED' ? 'merged' : null;
  if (
    number === null ||
    title === null ||
    url === null ||
    updatedAt === null ||
    headRef === null ||
    baseRef === null ||
    state === null
  ) {
    return null;
  }
  const isDraft = raw.isDraft === true;
  return {
    number,
    title,
    repository,
    state,
    isDraft,
    headRef,
    baseRef,
    author: str(raw.author?.login),
    assignees: mapUsers(raw.assignees),
    review: mapReviewState({
      state,
      isDraft,
      reviewDecision: raw.reviewDecision,
      requestedReviewers: int(raw.reviewRequests?.totalCount),
    }),
    ci: mapCiState(headCommit(raw)?.statusCheckRollup),
    updatedAt,
    mergedAt: isoDate(raw.mergedAt),
    closedAt: isoDate(raw.closedAt),
    url,
  };
}

export function normalizeBranch(raw: RawRef, defaultBranch: string | null): BranchItem | null {
  const name = str(raw.name);
  if (name === null) return null;
  const target = raw.target ?? null;
  return {
    name,
    isDefault: name === defaultBranch,
    headSha: str(target?.oid),
    headShortSha: str(target?.abbreviatedOid),
    headUrl: githubUrl(target?.url),
    committedAt: isoDate(target?.committedDate),
    ci: mapCiState(target?.statusCheckRollup),
  };
}

function sanitizePath(path: RawGraphQLError['path']): string {
  if (!Array.isArray(path) || path.length === 0) return 'consulta';
  return path
    .map((segment) => String(segment).replace(/[^A-Za-z0-9_]/g, ''))
    .filter(Boolean)
    .join('.');
}

function warningsFromErrors(errors: RawGraphQLError[]): string[] {
  return errors.map((error) => {
    const type = typeof error.type === 'string' ? error.type.replace(/[^A-Z_]/g, '') : 'ERRO';
    return `Dados parciais: o campo "${sanitizePath(error.path)}" não pôde ser lido (${type || 'ERRO'}).`;
  });
}

function requiredCount(value: { totalCount?: number | null } | null | undefined): number {
  const count = int(value?.totalCount);
  if (count === null) throw new IntegrationError('upstream_invalid');
  return count;
}

function dropped<T, R>(items: T[], map: (item: T) => R | null): { kept: R[]; droppedCount: number } {
  const kept: R[] = [];
  for (const item of items) {
    const result = map(item);
    if (result !== null) kept.push(result);
  }
  return { kept, droppedCount: items.length - kept.length };
}

/**
 * Converte a resposta de `REPO_SNAPSHOT_QUERY`. Lança `IntegrationError` quando a resposta não
 * permite montar um snapshot confiável (repositório ausente ou contagens inválidas).
 */
export function normalizeSnapshot(
  data: RawSnapshotData,
  partialErrors: RawGraphQLError[],
  fetchedAt: Date,
): RepoSnapshot {
  const repo = data.repository;
  if (repo === null || repo === undefined || typeof repo !== 'object') {
    const types = new Set(partialErrors.map((error) => error.type));
    throw new IntegrationError(types.has('NOT_FOUND') || types.has('FORBIDDEN') ? 'forbidden' : 'upstream_invalid');
  }

  const fullName = str(repo.nameWithOwner);
  const url = githubUrl(repo.url);
  if (fullName === null || url === null) throw new IntegrationError('upstream_invalid');

  const defaultBranch = str(repo.defaultBranchRef?.name);
  const warnings = warningsFromErrors(partialErrors);

  const openIssuesRaw = nodes(repo.openIssues);
  const issues = dropped([...openIssuesRaw, ...nodes(repo.recentClosedIssues)], (raw) =>
    normalizeIssue(raw, fullName),
  );
  const openPrsRaw = nodes(repo.openPullRequests);
  const pullRequests = dropped([...openPrsRaw, ...nodes(repo.recentClosedPullRequests)], (raw) =>
    normalizePullRequest(raw, fullName),
  );
  const refsRaw = nodes(repo.refs);
  const branches = dropped(refsRaw, (raw) => normalizeBranch(raw, defaultBranch));

  for (const [label, count] of [
    ['issues', issues.droppedCount],
    ['pull requests', pullRequests.droppedCount],
    ['branches', branches.droppedCount],
  ] as const) {
    if (count > 0) warnings.push(`${count} ${label} ignorado(s) por dados incompletos.`);
  }

  const openIssues = requiredCount(repo.openIssueCount);
  const openPullRequests = requiredCount(repo.openPullRequestCount);
  const branchCount = requiredCount(repo.refs);

  const openPrItems = pullRequests.kept.filter((pr) => pr.state === 'open');
  const ciCounts: Record<CiState, number> = { success: 0, failure: 0, pending: 0, unknown: 0 };
  for (const pr of openPrItems) ciCounts[pr.ci] += 1;

  return {
    repository: {
      fullName,
      description: str(repo.description),
      url,
      isPrivate: repo.isPrivate === true,
      isArchived: repo.isArchived === true,
      defaultBranch,
      updatedAt: isoDate(repo.updatedAt),
      pushedAt: isoDate(repo.pushedAt),
    },
    metrics: {
      openIssues,
      closedIssues: requiredCount(repo.closedIssueCount),
      openPullRequests,
      mergedPullRequests: requiredCount(repo.mergedPullRequestCount),
      closedUnmergedPullRequests: requiredCount(repo.closedPullRequestCount),
      awaitingReview: {
        count: openPrItems.filter((pr) => pr.review === 'pending').length,
        undetermined: openPrItems.filter((pr) => pr.review === 'unknown').length,
        complete: openPrItems.length >= openPullRequests,
      },
      branches: branchCount,
      ci: {
        defaultBranch: mapCiState(repo.defaultBranchRef?.target?.statusCheckRollup),
        openPullRequests: ciCounts,
      },
    },
    issues: issues.kept,
    pullRequests: pullRequests.kept,
    branches: branches.kept,
    truncated: {
      openIssues: openIssuesRaw.length < openIssues,
      openPullRequests: openPrsRaw.length < openPullRequests,
      branches: refsRaw.length < branchCount,
    },
    warnings: [...new Set(warnings)].slice(0, MAX_WARNINGS),
    fetchedAt: fetchedAt.toISOString(),
  };
}
