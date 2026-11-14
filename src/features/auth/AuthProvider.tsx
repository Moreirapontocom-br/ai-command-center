import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionResponse } from '../../../shared/contracts.ts';
import { ApiClientError } from '../../services/apiClient';
import { fetchSession, login, logout } from '../../services/authApi';
import { AuthContext, type AuthState } from './authContext';

function fromSession(session: SessionResponse, sessionExpired = false): AuthState {
  return session.authenticated
    ? { phase: 'authenticated', email: session.user.email, expiresAt: session.expiresAt }
    : { phase: 'anonymous', authConfigured: session.authConfigured, sessionExpired };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ phase: 'loading' });
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback((sessionExpired = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    fetchSession(controller.signal)
      .then((session) => setState(fromSession(session, sessionExpired)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ phase: 'unavailable' });
      });
  }, []);

  useEffect(() => {
    load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      setState(fromSession(await login({ email, password })));
      return null;
    } catch (error) {
      return error instanceof ApiClientError ? error : new ApiClientError('internal');
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      setState(fromSession(await logout()));
    } catch {
      // Mesmo se a chamada falhar, a interface deixa de exibir dados; a próxima consulta revalida.
      load();
    }
  }, [load]);

  const sessionLost = useCallback(() => load(true), [load]);
  const retry = useCallback(() => {
    setState({ phase: 'loading' });
    load();
  }, [load]);

  const value = useMemo(() => ({ state, signIn, signOut, sessionLost, retry }), [state, signIn, signOut, sessionLost, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
