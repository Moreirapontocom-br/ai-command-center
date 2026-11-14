import { createContext, useContext } from 'react';
import type { Project, ProjectCreateRequest, ProjectUpdateRequest } from '../../../shared/contracts.ts';
import type { ApiClientError } from '../../services/apiClient';

export type ProjectsState =
  | { phase: 'loading' }
  /** Servidor inalcançável (modo demonstração): não há projetos reais para exibir. */
  | { phase: 'unavailable' }
  | { phase: 'error'; error: ApiClientError }
  | { phase: 'ready'; projects: Project[]; activeProjectId: string | null; linkableRepositories: string[] };

export interface ProjectsValue {
  state: ProjectsState;
  /** Projeto ativo resolvido (`null` se nenhum selecionado ou se ele não existe mais). */
  activeProject: Project | null;
  create: (input: ProjectCreateRequest) => Promise<{ project: Project } | { error: ApiClientError }>;
  update: (projectId: string, patch: ProjectUpdateRequest) => Promise<{ project: Project } | { error: ApiClientError }>;
  select: (projectId: string | null) => Promise<ApiClientError | null>;
  reload: () => void;
}

const DEFAULT_VALUE: ProjectsValue = {
  state: { phase: 'unavailable' },
  activeProject: null,
  create: async () => ({ error: { code: 'server_unreachable' } as ApiClientError }),
  update: async () => ({ error: { code: 'server_unreachable' } as ApiClientError }),
  select: async () => null,
  reload: () => {},
};

export const ProjectsContext = createContext<ProjectsValue>(DEFAULT_VALUE);

export function useProjects(): ProjectsValue {
  return useContext(ProjectsContext);
}
