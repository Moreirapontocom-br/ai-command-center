import { createHash, randomBytes } from 'node:crypto';

/**
 * Sessões no servidor, em memória do processo. O cookie carrega apenas um identificador aleatório
 * de 256 bits; o mapa guarda o SHA-256 dele, nunca o valor do cookie. Reiniciar o servidor encerra
 * todas as sessões (comportamento aceito no MVP de administrador único).
 */

export interface Session {
  email: string;
  /** Repositórios que esta sessão pode consultar (escopo autorizado). */
  scope: readonly string[];
  createdAt: number;
  lastSeenAt: number;
  /** Expiração absoluta, independente de atividade. */
  expiresAt: number;
}

export interface SessionStore {
  create(input: { email: string; scope: readonly string[] }): { token: string; session: Session };
  /** Valida o token e renova a janela de inatividade. `null` se ausente, expirado ou revogado. */
  touch(token: string): Session | null;
  revoke(token: string): void;
  /** Revoga todas as sessões (usado no login: sessão administrativa única). */
  revokeAll(): void;
  size(): number;
}

export interface SessionStoreOptions {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxSessions: number;
  now?: () => number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function keyOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();

  const isExpired = (session: Session, at: number) =>
    at >= session.expiresAt || at - session.lastSeenAt >= options.idleTimeoutMs;

  function sweep(at: number) {
    for (const [key, session] of sessions) if (isExpired(session, at)) sessions.delete(key);
  }

  return {
    create({ email, scope }) {
      const at = now();
      sweep(at);
      // Limite de sessões simultâneas: descarta as mais antigas (ordem de inserção do Map).
      while (sessions.size >= options.maxSessions) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const token = randomBytes(32).toString('base64url');
      const session: Session = {
        email,
        scope: Object.freeze([...scope]),
        createdAt: at,
        lastSeenAt: at,
        expiresAt: at + options.absoluteTimeoutMs,
      };
      sessions.set(keyOf(token), session);
      return { token, session };
    },

    touch(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const key = keyOf(token);
      const session = sessions.get(key);
      if (!session) return null;
      const at = now();
      if (isExpired(session, at)) {
        sessions.delete(key);
        return null;
      }
      session.lastSeenAt = at;
      return session;
    },

    revoke(token) {
      if (TOKEN_PATTERN.test(token)) sessions.delete(keyOf(token));
    },

    revokeAll() {
      sessions.clear();
    },

    size() {
      return sessions.size;
    },
  };
}
