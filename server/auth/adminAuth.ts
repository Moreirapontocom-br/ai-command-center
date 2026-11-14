import { randomBytes } from 'node:crypto';
import { createLoginThrottle, type LoginThrottle, type LoginThrottleOptions } from './loginThrottle.ts';
import { verifyPassword, type PasswordHash } from './password.ts';
import { createSessionStore, type Session, type SessionStore, type SessionStoreOptions } from './sessions.ts';

/**
 * Autenticação do ACC: um único administrador (e-mail + hash scrypt da senha, configurados no
 * servidor), sessões no servidor e cookie `HttpOnly; SameSite=Strict`.
 *
 * Política de sessão: **uma única sessão administrativa ativa**. Todo login bem-sucedido revoga
 * qualquer sessão anterior, inclusive de outro navegador ou dispositivo. Login malsucedido não
 * afeta a sessão existente.
 *
 * Isto autentica PESSOAS perante o ACC. Não tem relação com a credencial do GitHub (token
 * fine-grained ou gh-cli), que continua exclusiva do servidor.
 */

/**
 * Identificador do administrador único. É o dono de todos os projetos no MVP; não deriva do e-mail
 * para que trocar `ACC_ADMIN_EMAIL` não desvincule os dados já gravados.
 */
export const ADMIN_USER_ID = 'admin';

export interface AdminAccount {
  email: string;
  passwordHash: PasswordHash;
}

export interface AuthOptions {
  admin: AdminAccount | null;
  /** Escopo concedido à sessão do administrador. */
  scope: readonly string[];
  /** `true` em produção (HTTPS): cookie `Secure` com prefixo `__Host-`. */
  secureCookie: boolean;
  sessions: Omit<SessionStoreOptions, 'now'>;
  throttle: Omit<LoginThrottleOptions, 'now'>;
  /** Verificações scrypt simultâneas (cada uma usa ~128 MiB). Acima disso, o login responde 429. */
  maxConcurrentVerifications: number;
  now?: () => number;
}

export type LoginResult =
  | { ok: true; token: string; session: Session }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'locked' | 'busy'; retryAfterSeconds: number };

export interface AuthService {
  readonly configured: boolean;
  readonly cookieName: string;
  login(input: { email: string; password: string; client: string }): Promise<LoginResult>;
  /** Sessão válida associada ao cabeçalho `Cookie`, ou `null`. Renova a janela de inatividade. */
  authenticate(cookieHeader: string | undefined): { token: string; session: Session } | null;
  logout(cookieHeader: string | undefined): void;
  sessionCookie(token: string): string;
  clearedCookie(): string;
}

export const DEFAULT_AUTH_LIMITS = {
  // `maxSessions: 1` é defesa em profundidade: o login já revoga todas as sessões anteriores.
  sessions: { idleTimeoutMs: 30 * 60_000, absoluteTimeoutMs: 8 * 60 * 60_000, maxSessions: 1 },
  throttle: { windowMs: 15 * 60_000, lockMs: 15 * 60_000, perClientLimit: 5, globalLimit: 20 },
  maxConcurrentVerifications: 2,
} as const;

export function normalizeEmail(email: string): string {
  return email.trim().normalize('NFC').toLowerCase();
}

/** Lê um cookie pelo nome, sem depender de bibliotecas. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function createAuthService(options: AuthOptions): AuthService {
  const now = options.now ?? Date.now;
  const store: SessionStore = createSessionStore({ ...options.sessions, now });
  const throttle: LoginThrottle = createLoginThrottle({ ...options.throttle, now });
  const cookieName = options.secureCookie ? '__Host-acc_session' : 'acc_session';
  const maxAgeSeconds = Math.floor(options.sessions.absoluteTimeoutMs / 1000);
  const adminEmail = options.admin ? normalizeEmail(options.admin.email) : null;
  let inFlight = 0;

  // Hash fictício com os mesmos parâmetros do real: e-mail desconhecido custa o mesmo tempo que
  // senha errada, sem revelar qual dos dois falhou.
  const decoy: PasswordHash | null = options.admin
    ? { params: options.admin.passwordHash.params, salt: randomBytes(16), hash: randomBytes(32) }
    : null;

  const attributes = () =>
    `Path=/; HttpOnly; SameSite=Strict${options.secureCookie ? '; Secure' : ''}`;

  return {
    configured: options.admin !== null,
    cookieName,

    async login({ email, password, client }) {
      if (!options.admin || !decoy || adminEmail === null) return { ok: false, reason: 'not_configured' };

      const verdict = throttle.check(client);
      if (!verdict.allowed) return { ok: false, reason: 'locked', retryAfterSeconds: verdict.retryAfterSeconds };
      if (inFlight >= options.maxConcurrentVerifications) return { ok: false, reason: 'busy', retryAfterSeconds: 1 };

      inFlight += 1;
      let valid: boolean;
      try {
        const emailMatches = normalizeEmail(email) === adminEmail;
        const passwordMatches = await verifyPassword(password, emailMatches ? options.admin.passwordHash : decoy);
        valid = emailMatches && passwordMatches;
      } finally {
        inFlight -= 1;
      }

      if (!valid) {
        throttle.recordFailure(client);
        return { ok: false, reason: 'invalid_credentials' };
      }
      throttle.recordSuccess(client);
      // Sessão administrativa única: o novo login encerra todas as anteriores (qualquer navegador).
      store.revokeAll();
      const { token, session } = store.create({ userId: ADMIN_USER_ID, email: options.admin.email, scope: options.scope });
      return { ok: true, token, session };
    },

    authenticate(cookieHeader) {
      const token = readCookie(cookieHeader, cookieName);
      if (token === null) return null;
      const session = store.touch(token);
      return session ? { token, session } : null;
    },

    logout(cookieHeader) {
      const token = readCookie(cookieHeader, cookieName);
      if (token !== null) store.revoke(token);
    },

    sessionCookie(token) {
      return `${cookieName}=${token}; ${attributes()}; Max-Age=${maxAgeSeconds}`;
    },

    clearedCookie() {
      return `${cookieName}=; ${attributes()}; Max-Age=0`;
    },
  };
}
