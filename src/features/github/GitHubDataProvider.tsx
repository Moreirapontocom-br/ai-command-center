import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClientError, fetchStatus } from '../../services/githubApi';
import { fetchProjectSnapshot } from '../../services/projectsApi';
import { useAuth } from '../auth/authContext';
import { useProjects } from '../projects/projectsContext';
import { GitHubDataContext, type GitHubDataState } from './githubDataContext';

function toClientError(error: unknown): ApiClientError {
  return error instanceof ApiClientError ? error : new ApiClientError('internal');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

interface Target {
  /** Muda quando o projeto ativo ou o repositório principal muda: descarta dados de outro projeto. */
  key: string;
  projectId: string;
  repository: string;
}

/**
 * Carrega o snapshot do repositório principal (o primeiro vinculado) do PROJETO ATIVO e o
 * compartilha entre as páginas. Trocar de projeto descarta os dados anteriores: um painel nunca
 * mostra dados de outro projeto. Atualização apenas manual (sem polling).
 */
export function GitHubDataProvider({ children }: { children: ReactNode }) {
  const { sessionLost } = useAuth();
  const { state: projects, activeProject, reload: reloadProjects } = useProjects();
  const [fetched, setFetched] = useState<{ key: string; state: GitHubDataState } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const primaryRepository = activeProject?.repositories[0];
  const target: Target | null = useMemo(
    () =>
      activeProject && primaryRepository
        ? { key: `${activeProject.id}|${primaryRepository}`, projectId: activeProject.id, repository: primaryRepository }
        : null,
    [activeProject, primaryRepository],
  );

  const state = useMemo((): GitHubDataState => {
    // Estados que dependem só dos projetos (sem consulta ao GitHub).
    if (projects.phase === 'loading') return { phase: 'loading' };
    if (projects.phase === 'unavailable') return { phase: 'demo', reason: 'server_unreachable' };
    if (projects.phase === 'error') return { phase: 'error', repository: null, error: projects.error };
    if (target === null) {
      return { phase: 'demo', reason: activeProject ? 'project_without_repository' : 'no_active_project' };
    }
    // Dados de outro projeto (ou ainda não carregados) nunca são exibidos.
    return fetched !== null && fetched.key === target.key ? fetched.state : { phase: 'loading' };
  }, [projects, activeProject, target, fetched]);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const toClientErrorOrLogout = useCallback(
    (error: unknown) => {
      const clientError = toClientError(error);
      // Rota privada respondeu 401: a sessão expirou ou foi revogada; volta para o login.
      if (clientError.code === 'unauthenticated') sessionLost();
      return clientError;
    },
    [sessionLost],
  );

  const start = useCallback((run: (signal: AbortSignal) => Promise<void>) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    void run(controller.signal);
  }, []);

  const load = useCallback(
    async ({ key, projectId, repository }: Target, signal: AbortSignal, refresh = false) => {
      const settle = (next: GitHubDataState) => setFetched({ key, state: next });
      try {
        if (!refresh) {
          const status = await fetchStatus(signal);
          if (!status.configured) return settle({ phase: 'demo', reason: 'missing_credentials' });
          if (!status.repositories.includes(repository)) return settle({ phase: 'demo', reason: 'no_repositories' });
        }
        const { snapshot, freshness } = await fetchProjectSnapshot(projectId, repository, { refresh, signal });
        settle({
          phase: 'ready',
          repository,
          snapshot,
          stale: freshness.stale,
          staleReason: freshness.staleReason,
          refreshing: false,
        });
      } catch (error) {
        if (isAbort(error)) return;
        const clientError = toClientErrorOrLogout(error);
        setFetched((previous) => {
          // Atualização manual que falha mantém os dados anteriores, marcados como desatualizados.
          if (refresh && previous?.key === key && previous.state.phase === 'ready') {
            return { key, state: { ...previous.state, refreshing: false, stale: true, staleReason: clientError.code } };
          }
          if (clientError.code === 'server_unreachable') return { key, state: { phase: 'demo', reason: 'server_unreachable' } };
          return { key, state: { phase: 'error', repository, error: clientError } };
        });
      }
    },
    [toClientErrorOrLogout],
  );

  useEffect(() => {
    if (target === null) return;
    start((signal) => load(target, signal));
    return () => controllerRef.current?.abort();
  }, [target, load, start]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    if (target === null) {
      reloadProjects();
      return;
    }
    if (current.phase === 'ready') {
      if (current.refreshing) return;
      setFetched({ key: target.key, state: { ...current, refreshing: true } });
      start((signal) => load(target, signal, true));
      return;
    }
    setFetched(null);
    start((signal) => load(target, signal));
  }, [target, load, start, reloadProjects]);

  const value = useMemo(() => ({ state, refresh }), [state, refresh]);
  return <GitHubDataContext.Provider value={value}>{children}</GitHubDataContext.Provider>;
}
