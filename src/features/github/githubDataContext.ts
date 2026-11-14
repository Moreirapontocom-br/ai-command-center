import { createContext, useContext } from 'react';
import type { RepoSnapshot } from '../../../shared/contracts.ts';
import type { ApiClientError, ClientErrorCode } from '../../services/githubApi';

/**
 * Situações em que não há dados reais do GitHub. `no_active_project` e `project_without_repository`
 * não são falhas: projetos existem sem GitHub (Issue #004).
 */
export type DemoReason =
  | 'server_unreachable'
  | 'missing_credentials'
  | 'no_repositories'
  | 'no_active_project'
  | 'project_without_repository';

export type GitHubDataState =
  | { phase: 'loading' }
  | { phase: 'demo'; reason: DemoReason }
  | { phase: 'error'; repository: string | null; error: ApiClientError }
  | {
      phase: 'ready';
      repository: string;
      snapshot: RepoSnapshot;
      /** Dados exibidos são de uma sincronização anterior (atualização mais recente falhou). */
      stale: boolean;
      staleReason: ClientErrorCode | null;
      refreshing: boolean;
    };

export interface GitHubDataValue {
  state: GitHubDataState;
  refresh: () => void;
}

const DEFAULT_VALUE: GitHubDataValue = {
  state: { phase: 'demo', reason: 'server_unreachable' },
  refresh: () => {},
};

export const GitHubDataContext = createContext<GitHubDataValue>(DEFAULT_VALUE);

export function useGitHubData(): GitHubDataValue {
  return useContext(GitHubDataContext);
}
