import { createContext, useContext } from 'react';
import type { ApiClientError } from '../../services/apiClient';

export type AuthState =
  | { phase: 'loading' }
  /** Servidor inalcançável: a aplicação segue só com dados fictícios (nenhum dado privado). */
  | { phase: 'unavailable' }
  | { phase: 'anonymous'; authConfigured: boolean; sessionExpired: boolean }
  | { phase: 'authenticated'; email: string; expiresAt: string };

export interface AuthValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<ApiClientError | null>;
  signOut: () => Promise<void>;
  /** Chamado quando uma rota privada responde 401 (sessão expirada ou revogada). */
  sessionLost: () => void;
  retry: () => void;
}

const DEFAULT_VALUE: AuthValue = {
  state: { phase: 'unavailable' },
  signIn: async () => null,
  signOut: async () => {},
  sessionLost: () => {},
  retry: () => {},
};

export const AuthContext = createContext<AuthValue>(DEFAULT_VALUE);

export function useAuth(): AuthValue {
  return useContext(AuthContext);
}
