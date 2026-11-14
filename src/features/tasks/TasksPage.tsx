import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type Task,
  type TaskCreateRequest,
  type TaskListResponse,
  type TaskUpdateRequest,
} from '../../../shared/contracts.ts';
import { ApiClientError } from '../../services/apiClient';
import { createTask, listTasks, updateTask } from '../../services/tasksApi';
import { useAuth } from '../auth/authContext';
import { ERROR_COPY } from '../github/githubLabels';
import { useProjects } from '../projects/projectsContext';
import { AssigneeOptions, type AssigneeChoices } from './AssigneeOptions';
import { TaskForm } from './TaskForm';
import { assigneeKey, PRIORITY_LABELS, WORK_STATUS_LABELS } from './workLabels';
import { WorkTaskCard } from './WorkTaskCard';

type LoadState =
  | { phase: 'loading'; projectId: string }
  | { phase: 'error'; projectId: string; error: ApiClientError }
  | ({ phase: 'ready'; projectId: string } & TaskListResponse);

const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm';

/**
 * Tarefas do PROJETO ATIVO (Issue #005). Os dados vêm só do servidor; trocar de projeto descarta a
 * lista anterior. Status internos do ACC, independentes do GitHub.
 */
export function TasksPage() {
  const { activeProject, state: projects } = useProjects();
  const { sessionLost } = useAuth();
  const projectId = activeProject?.id ?? null;
  const [loaded, setLoaded] = useState<LoadState | null>(null);
  const [mode, setMode] = useState<{ kind: 'idle' } | { kind: 'create' } | { kind: 'edit'; id: string }>({ kind: 'idle' });
  const [filters, setFilters] = useState({ status: '', priority: '', assignee: '' });

  const handleError = useCallback(
    (error: unknown) => {
      const clientError = error instanceof ApiClientError ? error : new ApiClientError('internal');
      if (clientError.code === 'unauthenticated') sessionLost();
      return clientError;
    },
    [sessionLost],
  );

  const load = useCallback(
    (id: string, signal?: AbortSignal) => {
      listTasks(id, signal)
        .then((body) => setLoaded({ phase: 'ready', projectId: id, ...body }))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setLoaded({ phase: 'error', projectId: id, error: handleError(error) });
        });
    },
    [handleError],
  );

  useEffect(() => {
    if (projectId === null) return;
    const controller = new AbortController();
    load(projectId, controller.signal);
    return () => controller.abort();
  }, [projectId, load]);

  // Dados de outro projeto nunca são exibidos (troca de projeto = carregando).
  const state = useMemo(
    (): LoadState | null =>
      projectId === null ? null : loaded?.projectId === projectId ? loaded : { phase: 'loading', projectId },
    [projectId, loaded],
  );

  const tasks = useMemo(() => (state?.phase === 'ready' ? state.tasks : []), [state]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const replace = (task: Task) =>
    setLoaded((previous) =>
      previous?.phase === 'ready' && previous.projectId === task.projectId
        ? {
            ...previous,
            tasks: previous.tasks.some((t) => t.id === task.id)
              ? previous.tasks.map((t) => (t.id === task.id ? task : t))
              : [...previous.tasks, task],
          }
        : previous,
    );

  if (projects.phase === 'unavailable' || projects.phase === 'error') {
    return (
      <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p className="font-semibold">Tarefas indisponíveis</p>
        <p className="mt-1">As tarefas ficam no servidor local, que não está acessível. Agentes e dashboard continuam em modo demonstração.</p>
      </div>
    );
  }
  if (projects.phase === 'loading' || (state !== null && state.phase === 'loading')) {
    return (
      <p role="status" className="text-sm text-slate-600">
        Carregando tarefas…
      </p>
    );
  }
  if (activeProject === null || state === null) {
    return (
      <p role="status" className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-600">
        Selecione ou crie um projeto na página Projetos para gerenciar as tarefas dele.
      </p>
    );
  }
  if (state.phase === 'error') {
    return (
      <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-4 text-sm text-rose-900">
        <p className="font-semibold">Não foi possível carregar as tarefas</p>
        <p className="mt-1">{ERROR_COPY[state.error.code].description}</p>
        <button type="button" onClick={() => load(activeProject.id)} className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white">
          Tentar novamente
        </button>
      </div>
    );
  }

  const choices: AssigneeChoices = { users: state.assignableUsers, agents: state.agents };
  const project = activeProject;
  const visible = tasks.filter(
    (t) =>
      (filters.status === '' || t.status === filters.status) &&
      (filters.priority === '' || t.priority === filters.priority) &&
      (filters.assignee === '' || (filters.assignee === 'none' ? t.assignee === null : assigneeKey(t.assignee) === filters.assignee)),
  );

  async function submitCreate(values: TaskCreateRequest) {
    try {
      replace(await createTask(project.id, values));
      setMode({ kind: 'idle' });
      return null;
    } catch (error) {
      return handleError(error);
    }
  }
  async function submitUpdate(taskId: string, patch: TaskUpdateRequest) {
    try {
      replace(await updateTask(project.id, taskId, patch));
      return null;
    } catch (error) {
      return handleError(error);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">
          Tarefas de {project.name} ({tasks.length})
        </h2>
        {mode.kind !== 'create' && (
          <button type="button" onClick={() => setMode({ kind: 'create' })} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">
            Nova tarefa
          </button>
        )}
      </div>

      {mode.kind === 'create' && (
        <section aria-label="Nova tarefa">
          <TaskForm
            otherTasks={tasks}
            repositories={project.repositories}
            choices={choices}
            submitLabel="Criar tarefa"
            onCancel={() => setMode({ kind: 'idle' })}
            onSubmit={submitCreate}
          />
        </section>
      )}

      <section aria-label="Filtros" className="flex flex-wrap gap-3 text-sm text-slate-700">
        <label className="flex items-center gap-2">
          Status
          <select className={selectClass} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">Todos</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WORK_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Prioridade
          <select className={selectClass} value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
            <option value="">Todas</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Responsável
          <select className={selectClass} value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
            <option value="">Todos</option>
            <option value="none">Sem responsável</option>
            <AssigneeOptions choices={choices} />
          </select>
        </label>
      </section>

      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-600">Nenhuma tarefa neste projeto ainda.</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-slate-600">Nenhuma tarefa corresponde aos filtros.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visible.map((task) =>
            mode.kind === 'edit' && mode.id === task.id ? (
              <section key={task.id} aria-label={`Editar ${task.title}`}>
                <TaskForm
                  initial={task}
                  otherTasks={tasks.filter((t) => t.id !== task.id)}
                  repositories={project.repositories}
                  choices={choices}
                  submitLabel="Salvar alterações"
                  onCancel={() => setMode({ kind: 'idle' })}
                  onSubmit={async (values) => {
                    const failure = await submitUpdate(task.id, values);
                    if (!failure) setMode({ kind: 'idle' });
                    return failure;
                  }}
                />
              </section>
            ) : (
              <WorkTaskCard
                key={task.id}
                task={task}
                byId={byId}
                choices={choices}
                onEdit={() => setMode({ kind: 'edit', id: task.id })}
                onUpdate={(patch) => submitUpdate(task.id, patch)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
