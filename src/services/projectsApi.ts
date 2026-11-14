import {
  PROJECT_STATUSES,
  type ActiveProjectResponse,
  type Project,
  type ProjectCreateRequest,
  type ProjectListResponse,
  type ProjectUpdateRequest,
  type SnapshotResponse,
} from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';
import { isSnapshotResponse } from './githubApi';

/**
 * Cliente das rotas de projetos (Issue #004). Os dados ficam no servidor (arquivo local, por
 * usuário); o navegador não guarda projetos nem a seleção ativa em armazenamento próprio.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function isProject(value: unknown): value is Project {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.objective === 'string' &&
    (PROJECT_STATUSES as readonly unknown[]).includes(value.status) &&
    isStringArray(value.repositories) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function asProject(body: unknown): Project {
  if (!isProject(body)) throw new ApiClientError('upstream_invalid');
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<ProjectListResponse> {
  const body = await requestJson('/api/projects', { signal });
  if (
    !isObject(body) ||
    !Array.isArray(body.projects) ||
    !body.projects.every(isProject) ||
    !(body.activeProjectId === null || typeof body.activeProjectId === 'string') ||
    !isStringArray(body.linkableRepositories)
  ) {
    throw new ApiClientError('upstream_invalid');
  }
  return body as unknown as ProjectListResponse;
}

export async function createProject(input: ProjectCreateRequest): Promise<Project> {
  return asProject(await requestJson('/api/projects', { post: input }));
}

export async function updateProject(projectId: string, patch: ProjectUpdateRequest): Promise<Project> {
  return asProject(await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, { post: patch }));
}

export async function selectProject(projectId: string | null): Promise<ActiveProjectResponse> {
  const body = await requestJson('/api/projects/active', { post: { projectId } });
  if (!isObject(body) || !(body.activeProjectId === null || typeof body.activeProjectId === 'string')) {
    throw new ApiClientError('upstream_invalid');
  }
  return { activeProjectId: body.activeProjectId };
}

/** Snapshot de um repositório pelo projeto: o servidor confere dono, vínculo e allowlist. */
export async function fetchProjectSnapshot(
  projectId: string,
  fullName: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<SnapshotResponse> {
  const [owner, repo] = fullName.split('/').map(encodeURIComponent);
  const query = options.refresh ? '?refresh=1' : '';
  const path = `/api/projects/${encodeURIComponent(projectId)}/repositories/${owner}/${repo}/snapshot${query}`;
  const body = await requestJson(path, { signal: options.signal });
  if (!isSnapshotResponse(body)) throw new ApiClientError('upstream_invalid');
  return body;
}
