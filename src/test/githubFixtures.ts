import { vi } from 'vitest';
import type {
  ApiErrorBody,
  ApiErrorCode,
  Project,
  ProjectListResponse,
  RepoSnapshot,
  SessionResponse,
  SnapshotResponse,
  StatusResponse,
} from '../../shared/contracts.ts';

const REPO = 'Moreirapontocom-br/ai-command-center';
const WEB = `https://github.com/${REPO}`;

/** Snapshot normalizado simulado (como o servidor devolveria). */
export function snapshotFixture(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    repository: {
      fullName: REPO,
      description: null,
      url: WEB,
      isPrivate: true,
      isArchived: false,
      defaultBranch: 'main',
      updatedAt: '2026-11-10T20:00:00Z',
      pushedAt: '2026-11-10T20:00:00Z',
    },
    metrics: {
      openIssues: 3,
      closedIssues: 1,
      openPullRequests: 2,
      mergedPullRequests: 5,
      closedUnmergedPullRequests: 1,
      awaitingReview: { count: 1, undetermined: 0, complete: true },
      branches: 4,
      ci: { defaultBranch: 'success', openPullRequests: { success: 1, failure: 0, pending: 1, unknown: 0 } },
    },
    issues: [
      {
        number: 42,
        title: 'Issue real simulada',
        repository: REPO,
        state: 'open',
        stateReason: null,
        assignees: [{ login: 'dev-a', url: 'https://github.com/dev-a' }],
        labels: [{ name: 'enhancement', color: 'a2eeef' }],
        updatedAt: '2026-11-10T18:00:00Z',
        url: `${WEB}/issues/42`,
      },
      {
        number: 41,
        title: 'Issue sem responsável',
        repository: REPO,
        state: 'closed',
        stateReason: 'not_planned',
        assignees: [],
        labels: [],
        updatedAt: '2026-11-09T18:00:00Z',
        url: `${WEB}/issues/41`,
      },
    ],
    pullRequests: [
      {
        number: 3,
        title: 'PR em draft',
        repository: REPO,
        state: 'open',
        isDraft: true,
        headRef: 'feature/draft',
        baseRef: 'main',
        author: 'dev-a',
        assignees: [],
        review: 'not_applicable',
        ci: 'pending',
        updatedAt: '2026-11-10T19:00:00Z',
        mergedAt: null,
        closedAt: null,
        url: `${WEB}/pull/3`,
      },
      {
        number: 2,
        title: 'PR pronto',
        repository: REPO,
        state: 'open',
        isDraft: false,
        headRef: 'feature/002-github-integration',
        baseRef: 'main',
        author: 'dev-a',
        assignees: [],
        review: 'pending',
        ci: 'success',
        updatedAt: '2026-11-10T19:30:00Z',
        mergedAt: null,
        closedAt: null,
        url: `${WEB}/pull/2`,
      },
      {
        number: 1,
        title: 'PR incorporado',
        repository: REPO,
        state: 'merged',
        isDraft: false,
        headRef: 'feature/001-project-setup',
        baseRef: 'main',
        author: 'dev-a',
        assignees: [],
        review: 'not_applicable',
        ci: 'success',
        updatedAt: '2026-11-10T20:03:05Z',
        mergedAt: '2026-11-10T20:03:05Z',
        closedAt: '2026-11-10T20:03:05Z',
        url: `${WEB}/pull/1`,
      },
      {
        number: 4,
        title: 'PR fechado',
        repository: REPO,
        state: 'closed',
        isDraft: false,
        headRef: 'feature/abandonada',
        baseRef: 'main',
        author: null,
        assignees: [],
        review: 'not_applicable',
        ci: 'unknown',
        updatedAt: '2026-11-08T20:00:00Z',
        mergedAt: null,
        closedAt: '2026-11-08T20:00:00Z',
        url: `${WEB}/pull/4`,
      },
    ],
    branches: [
      {
        name: 'main',
        isDefault: true,
        headSha: 'b'.repeat(40),
        headShortSha: 'bbbbbbb',
        headUrl: `${WEB}/commit/${'b'.repeat(40)}`,
        committedAt: '2026-11-10T20:03:05Z',
        ci: 'success',
      },
    ],
    truncated: { openIssues: false, openPullRequests: false, branches: false },
    warnings: [],
    fetchedAt: '2026-11-10T20:30:00.000Z',
    ...overrides,
  };
}

type Reply = Response | Error;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function apiError(code: ApiErrorCode, status: number, extra: Partial<ApiErrorBody['error']> = {}): Response {
  return json({ error: { code, message: 'mensagem do servidor', ...extra } } satisfies ApiErrorBody, status);
}

export const configuredStatus: StatusResponse = {
  configured: true,
  authMode: 'fine-grained-token',
  repositories: [REPO],
};

export function snapshotReply(snapshot = snapshotFixture(), stale = false): Response {
  const body: SnapshotResponse = {
    snapshot,
    freshness: { stale, staleReason: stale ? 'rate_limited' : null },
  };
  return json(body);
}

export const authenticatedSession: SessionResponse = {
  authenticated: true,
  user: { email: 'admin@example.test' },
  expiresAt: '2026-11-14T08:00:00.000Z',
};

/**
 * Substitui `fetch` por respostas em sequência para a sessão, `/api/status` e o snapshot.
 * Por padrão a sessão do administrador é válida.
 */
export const PROJECT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

export function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'AI Command Center',
    description: 'Painel de projetos',
    objective: 'MVP',
    status: 'active',
    repositories: [REPO],
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    ...overrides,
  };
}

export function projectList(overrides: Partial<ProjectListResponse> = {}): ProjectListResponse {
  return { projects: [projectFixture()], activeProjectId: PROJECT_ID, linkableRepositories: [REPO], ...overrides };
}

export function mockApi(routes: {
  status?: Reply[];
  snapshot?: Reply[];
  session?: Reply[];
  login?: Reply[];
  logout?: Reply[];
  /** `GET /api/projects` (padrão: um projeto ativo vinculado ao repositório). */
  projects?: Reply[];
  createProject?: Reply[];
  updateProject?: Reply[];
  selectProject?: Reply[];
}) {
  const queues = {
    projects: [...(routes.projects ?? [json(projectList())])],
    createProject: [...(routes.createProject ?? [])],
    updateProject: [...(routes.updateProject ?? [])],
    selectProject: [...(routes.selectProject ?? [])],
    session: [...(routes.session ?? [json(authenticatedSession)])],
    login: [...(routes.login ?? [])],
    logout: [...(routes.logout ?? [])],
    status: [...(routes.status ?? [])],
    snapshot: [...(routes.snapshot ?? [])],
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init; // registrado em `mock.calls` para as asserções
    const url = String(input);
    const queue = url.startsWith('/api/auth/session')
      ? queues.session
      : url.startsWith('/api/auth/login')
        ? queues.login
        : url.startsWith('/api/auth/logout')
          ? queues.logout
          : url.startsWith('/api/status')
            ? queues.status
            : url.includes('/snapshot')
              ? queues.snapshot
              : url === '/api/projects/active'
                ? queues.selectProject
                : url === '/api/projects'
                  ? init?.method === 'POST'
                    ? queues.createProject
                    : queues.projects
                  : url.startsWith('/api/projects/')
                    ? queues.updateProject
                    : [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new TypeError(`rota não simulada: ${url}`);
    if (next instanceof Error) throw next;
    return next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
