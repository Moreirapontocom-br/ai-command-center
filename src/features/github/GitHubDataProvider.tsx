import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiClientError, fetchSnapshot, fetchStatus } from '../../services/githubApi';
import { GitHubDataContext, type GitHubDataState } from './githubDataContext';

function toClientError(error: unknown): ApiClientError {
  return error instanceof ApiClientError ? error : new ApiClientError('internal');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Carrega o snapshot do primeiro repositório autorizado pelo servidor e o compartilha entre as
 * páginas. Atualização apenas manual (sem polling nem tempo real nesta versão).
 */
export function GitHubDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GitHubDataState>({ phase: 'loading' });
  const stateRef = useRef(state);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const status = await fetchStatus(signal);
      if (!status.configured) {
        setState({ phase: 'demo', reason: 'missing_credentials' });
        return;
      }
      const repository = status.repositories[0];
      if (repository === undefined) {
        setState({ phase: 'demo', reason: 'no_repositories' });
        return;
      }
      try {
        const { snapshot, freshness } = await fetchSnapshot(repository, { signal });
        setState({
          phase: 'ready',
          repository,
          snapshot,
          stale: freshness.stale,
          staleReason: freshness.staleReason,
          refreshing: false,
        });
      } catch (error) {
        if (isAbort(error)) return;
        setState({ phase: 'error', repository, error: toClientError(error) });
      }
    } catch (error) {
      if (isAbort(error)) return;
      const clientError = toClientError(error);
      setState(
        clientError.code === 'server_unreachable'
          ? { phase: 'demo', reason: 'server_unreachable' }
          : { phase: 'error', repository: null, error: clientError },
      );
    }
  }, []);

  const start = useCallback(
    (run: (signal: AbortSignal) => Promise<void>) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      void run(controller.signal);
    },
    [],
  );

  useEffect(() => {
    start(load);
    return () => controllerRef.current?.abort();
  }, [load, start]);

  const refresh = useCallback(() => {
    const current = stateRef.current;
    if (current.phase !== 'ready') {
      setState({ phase: 'loading' });
      start(load);
      return;
    }
    if (current.refreshing) return;
    const { repository } = current;
    setState({ ...current, refreshing: true });
    start(async (signal) => {
      try {
        const { snapshot, freshness } = await fetchSnapshot(repository, { refresh: true, signal });
        setState({
          phase: 'ready',
          repository,
          snapshot,
          stale: freshness.stale,
          staleReason: freshness.staleReason,
          refreshing: false,
        });
      } catch (error) {
        if (isAbort(error)) return;
        const clientError = toClientError(error);
        // Mantém os dados anteriores, sinalizando que estão desatualizados e por quê.
        setState((previous) =>
          previous.phase === 'ready'
            ? { ...previous, refreshing: false, stale: true, staleReason: clientError.code }
            : { phase: 'error', repository, error: clientError },
        );
      }
    });
  }, [load, start]);

  const value = useMemo(() => ({ state, refresh }), [state, refresh]);
  return <GitHubDataContext.Provider value={value}>{children}</GitHubDataContext.Provider>;
}
