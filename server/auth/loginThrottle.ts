/**
 * Proteção contra tentativas repetidas de login (memória do processo).
 *
 * Duas camadas, verificadas ANTES de calcular o hash da senha:
 * - por cliente (endereço do socket): `perClientLimit` falhas na janela → bloqueio de `lockMs`;
 * - global (qualquer origem): `globalLimit` falhas na janela → bloqueio de `lockMs` para todos.
 *   Limita ataques distribuídos contra a conta única de administrador, ao custo de permitir que
 *   um atacante bloqueie o login temporariamente (aceito no MVP; ver limitações).
 *
 * `X-Forwarded-For` não é considerado: sem proxy confiável configurado ele é controlado pelo cliente.
 */

export interface LoginThrottleOptions {
  windowMs: number;
  lockMs: number;
  perClientLimit: number;
  globalLimit: number;
  now?: () => number;
}

export interface LoginThrottle {
  /** `retryAfterSeconds` > 0 se o login está bloqueado para este cliente. */
  check(client: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
  recordFailure(client: string): void;
  recordSuccess(client: string): void;
}

interface Counter {
  failures: number[];
  lockedUntil: number;
}

const GLOBAL_KEY = '\u0000global';

export function createLoginThrottle(options: LoginThrottleOptions): LoginThrottle {
  const now = options.now ?? Date.now;
  const counters = new Map<string, Counter>();

  function counter(key: string): Counter {
    let entry = counters.get(key);
    if (!entry) {
      if (counters.size > 1000) {
        const at = now();
        for (const [k, c] of counters) {
          if (c.lockedUntil <= at && c.failures.every((t) => at - t >= options.windowMs)) counters.delete(k);
        }
      }
      entry = { failures: [], lockedUntil: 0 };
      counters.set(key, entry);
    }
    return entry;
  }

  function lockedFor(key: string, at: number): number {
    const entry = counters.get(key);
    return entry && entry.lockedUntil > at ? entry.lockedUntil - at : 0;
  }

  function fail(key: string, limit: number, at: number) {
    const entry = counter(key);
    entry.failures = entry.failures.filter((t) => at - t < options.windowMs);
    entry.failures.push(at);
    if (entry.failures.length >= limit) {
      entry.lockedUntil = at + options.lockMs;
      entry.failures = [];
    }
  }

  return {
    check(client) {
      const at = now();
      const wait = Math.max(lockedFor(client, at), lockedFor(GLOBAL_KEY, at));
      return wait > 0 ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) } : { allowed: true };
    },
    recordFailure(client) {
      const at = now();
      fail(client, options.perClientLimit, at);
      fail(GLOBAL_KEY, options.globalLimit, at);
    },
    recordSuccess(client) {
      counters.delete(client);
    },
  };
}
