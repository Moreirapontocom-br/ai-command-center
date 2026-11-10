import type { RawIssue, RawPullRequest, RawRef, RawRepository, RawSnapshotData } from '../github/raw-types.ts';

/** Token fictício usado como "canário": nenhum teste pode encontrá-lo em respostas ou logs. */
export const CANARY_TOKEN = 'github_pat_TESTCANARY0000000000000000000000000000000000000000';

const REPO = 'Moreirapontocom-br/ai-command-center';
const WEB = `https://github.com/${REPO}`;

export function rawIssue(overrides: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 7,
    title: 'Issue simulada',
    state: 'OPEN',
    stateReason: null,
    url: `${WEB}/issues/7`,
    updatedAt: '2026-11-09T12:00:00Z',
    assignees: { nodes: [{ login: 'dev-a', url: 'https://github.com/dev-a' }] },
    labels: { nodes: [{ name: 'bug', color: 'D73A4A' }] },
    ...overrides,
  };
}

export function rawPullRequest(overrides: Partial<RawPullRequest> = {}): RawPullRequest {
  return {
    number: 2,
    title: 'PR simulado',
    state: 'OPEN',
    isDraft: false,
    url: `${WEB}/pull/2`,
    updatedAt: '2026-11-10T10:00:00Z',
    mergedAt: null,
    closedAt: null,
    headRefName: 'feature/002-github-integration',
    baseRefName: 'main',
    reviewDecision: null,
    author: { login: 'dev-a' },
    reviewRequests: { totalCount: 0 },
    assignees: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...overrides,
  };
}

export function rawRef(name: string, overrides: Partial<RawRef['target']> = {}): RawRef {
  return {
    name,
    target: {
      oid: 'a'.repeat(40),
      abbreviatedOid: 'aaaaaaa',
      committedDate: '2026-11-10T09:00:00Z',
      url: `${WEB}/commit/${'a'.repeat(40)}`,
      statusCheckRollup: { state: 'SUCCESS' },
      ...overrides,
    },
  };
}

export function rawRepository(overrides: Partial<RawRepository> = {}): RawRepository {
  return {
    nameWithOwner: REPO,
    description: 'Repositório simulado',
    url: WEB,
    isPrivate: true,
    isArchived: false,
    updatedAt: '2026-11-10T10:00:00Z',
    pushedAt: '2026-11-10T10:00:00Z',
    defaultBranchRef: rawRef('main'),
    openIssueCount: { totalCount: 1 },
    closedIssueCount: { totalCount: 0 },
    openPullRequestCount: { totalCount: 1 },
    closedPullRequestCount: { totalCount: 0 },
    mergedPullRequestCount: { totalCount: 1 },
    openIssues: { nodes: [rawIssue()] },
    recentClosedIssues: { nodes: [] },
    openPullRequests: { nodes: [rawPullRequest()] },
    recentClosedPullRequests: {
      nodes: [
        rawPullRequest({
          number: 1,
          state: 'MERGED',
          url: `${WEB}/pull/1`,
          headRefName: 'feature/001-project-setup',
          mergedAt: '2026-11-10T20:03:05Z',
          closedAt: '2026-11-10T20:03:05Z',
          reviewDecision: 'APPROVED',
        }),
      ],
    },
    refs: { totalCount: 2, nodes: [rawRef('main'), rawRef('feature/002-github-integration')] },
    ...overrides,
  };
}

export function rawSnapshot(repository: Partial<RawRepository> = {}): RawSnapshotData {
  return {
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-11-10T21:00:00Z' },
    repository: rawRepository(repository),
  };
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}
