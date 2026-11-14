import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskCreateRequest,
  type TaskListResponse,
  type TaskUpdateRequest,
} from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

/**
 * Cliente das rotas de tarefas (Issue #005). A fonte da verdade é o servidor; o navegador não
 * guarda tarefas. Status, conclusão e origem vêm sempre da resposta do servidor.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTask(value: unknown): value is Task {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    (TASK_STATUSES as readonly unknown[]).includes(value.status) &&
    (TASK_PRIORITIES as readonly unknown[]).includes(value.priority) &&
    (value.assignee === null || isObject(value.assignee)) &&
    Array.isArray(value.dependsOn) &&
    Array.isArray(value.references) &&
    Array.isArray(value.history) &&
    typeof value.blockedReason === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function asTask(body: unknown): Task {
  if (!isTask(body)) throw new ApiClientError('upstream_invalid');
  return body;
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/tasks`;

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<TaskListResponse> {
  const body = await requestJson(base(projectId), { signal });
  if (!isObject(body) || !Array.isArray(body.tasks) || !body.tasks.every(isTask) || !Array.isArray(body.assignableUsers) || !Array.isArray(body.agents)) {
    throw new ApiClientError('upstream_invalid');
  }
  return body as unknown as TaskListResponse;
}

export async function createTask(projectId: string, input: TaskCreateRequest): Promise<Task> {
  return asTask(await requestJson(`/api/projects/${encodeURIComponent(projectId)}/tasks`, { post: input }));
}

export async function updateTask(projectId: string, taskId: string, patch: TaskUpdateRequest): Promise<Task> {
  return asTask(
    await requestJson(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { post: patch }),
  );
}
