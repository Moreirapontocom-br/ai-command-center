import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Project, ProjectCreateRequest, ProjectUpdateRequest } from '../../../shared/contracts.ts';
import { ApiClientError } from '../../services/apiClient';
import { createProject, listProjects, selectProject, updateProject } from '../../services/projectsApi';
import { useAuth } from '../auth/authContext';
import { ProjectsContext, type ProjectsState } from './projectsContext';

const UNAVAILABLE: ProjectsState = { phase: 'unavailable' };

function toClientError(error: unknown): ApiClientError {
  return error instanceof ApiClientError ? error : new ApiClientError('internal');
}

/**
 * Projetos do usuário autenticado e projeto ativo. A fonte da verdade é o servidor: cada alteração
 * é enviada e o estado local só muda com a resposta confirmada. Sem sessão (servidor fora do ar),
 * não há projetos.
 */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { state: auth, sessionLost, retry: retryAuth } = useAuth();
  const authenticated = auth.phase === 'authenticated';
  const [fetched, setFetched] = useState<ProjectsState>({ phase: 'loading' });
  const controllerRef = useRef<AbortController | null>(null);

  const handleError = useCallback(
    (error: unknown) => {
      const clientError = toClientError(error);
      if (clientError.code === 'unauthenticated') sessionLost();
      return clientError;
    },
    [sessionLost],
  );

  const load = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    listProjects(controller.signal)
      .then((body) => setFetched({ phase: 'ready', ...body }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        const clientError = handleError(error);
        setFetched(clientError.code === 'server_unreachable' ? { phase: 'unavailable' } : { phase: 'error', error: clientError });
      });
  }, [handleError]);

  useEffect(() => {
    if (!authenticated) return;
    load();
    return () => controllerRef.current?.abort();
  }, [authenticated, load]);

  const state: ProjectsState = authenticated ? fetched : UNAVAILABLE;

  const replace = (project: Project) =>
    setFetched((previous) =>
      previous.phase === 'ready'
        ? {
            ...previous,
            projects: previous.projects.some((p) => p.id === project.id)
              ? previous.projects.map((p) => (p.id === project.id ? project : p))
              : [...previous.projects, project],
          }
        : previous,
    );

  const create = useCallback(
    async (input: ProjectCreateRequest) => {
      try {
        const project = await createProject(input);
        replace(project);
        return { project };
      } catch (error) {
        return { error: handleError(error) };
      }
    },
    [handleError],
  );

  const update = useCallback(
    async (projectId: string, patch: ProjectUpdateRequest) => {
      try {
        const project = await updateProject(projectId, patch);
        replace(project);
        return { project };
      } catch (error) {
        return { error: handleError(error) };
      }
    },
    [handleError],
  );

  const select = useCallback(
    async (projectId: string | null) => {
      try {
        const { activeProjectId } = await selectProject(projectId);
        setFetched((previous) => (previous.phase === 'ready' ? { ...previous, activeProjectId } : previous));
        return null;
      } catch (error) {
        return handleError(error);
      }
    },
    [handleError],
  );

  const reload = useCallback(() => {
    // Sem sessão confirmada (servidor fora do ar), a nova tentativa começa pela sessão.
    if (!authenticated) {
      retryAuth();
      return;
    }
    setFetched({ phase: 'loading' });
    load();
  }, [authenticated, load, retryAuth]);

  const activeProject =
    state.phase === 'ready' ? (state.projects.find((p) => p.id === state.activeProjectId) ?? null) : null;

  const value = useMemo(
    () => ({ state, activeProject, create, update, select, reload }),
    [state, activeProject, create, update, select, reload],
  );
  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}
