/**
 * Proteção contra tentativas repetidas de login (memória do processo). **Válida apenas para o MVP
 * local** (servidor restrito a loopback); deve ser revista antes de qualquer exposição à rede.
 *
 * Duas camadas, verificadas ANTES de calcular o hash da senha:
 * - por cliente (endereço do socket): `perClientLimit` falhas na janela → bloqueio de `lockMs`;
 * - global (qualquer origem): `globalLimit` falhas na janela → bloqueio de `lockMs` para todos.
 *
 * RISCO DE NEGAÇÃO DE SERVIÇO (aceito no MVP local): quem alcança a porta pode provocar falhas de
 * propósito e bloquear o login do administrador por `lockMs`, inclusive pelo limite global. A
 * sessão já ativa NÃO é afetada (falhas não revogam sessões). O bloqueio não é persistido:
 * reiniciar o servidor o encerra.
 *
 * ATRÁS DE PROXY: o "cliente" é o endereço do socket. Pelo proxy do Vite (dev/preview), todo
 * tráfego chega de 127.0.0.1, então o limite por cliente passa a valer para todos os navegadores
 * locais juntos. `X-Forwarded-For` não é considerado: sem proxy confiável configurado, ele é
 * controlado pelo cliente e permitiria contornar o limite.
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
