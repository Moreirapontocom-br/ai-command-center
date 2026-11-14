import type { LoginRequest, SessionResponse } from '../../shared/contracts.ts';
import { ApiClientError, requestJson } from './apiClient';

/**
 * Login do administrador do ACC. A senha só trafega no corpo do POST para a própria origem; a
 * sessão fica num cookie HttpOnly que o JavaScript não lê. Nada é guardado no armazenamento do navegador.
 */

function isSessionResponse(value: unknown): value is SessionResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  if (body.authenticated === true) {
    const user = body.user as Record<string, unknown> | undefined;
    return typeof user?.email === 'string' && typeof body.expiresAt === 'string';
  }
  return body.authenticated === false && typeof body.authConfigured === 'boolean';
}

function asSession(body: unknown): SessionResponse {
  if (!isSessionResponse(body)) throw new ApiClientError('upstream_invalid');
  return body;
}

export async function fetchSession(signal?: AbortSignal): Promise<SessionResponse> {
  return asSession(await requestJson('/api/auth/session', { signal }));
}

export async function login(credentials: LoginRequest): Promise<SessionResponse> {
  return asSession(await requestJson('/api/auth/login', { post: credentials }));
}

export async function logout(): Promise<SessionResponse> {
  return asSession(await requestJson('/api/auth/logout', { post: {} }));
}
