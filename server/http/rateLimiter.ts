/** Limite simples de requisições por cliente em janela fixa (memória do processo). */
export interface RateLimiter {
  hit(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number };
}

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { startedAt: number; count: number }>();

  return {
    hit(key) {
      const current = now();
      const window = windows.get(key);
      if (!window || current - window.startedAt >= options.windowMs) {
        // Evita crescimento ilimitado do mapa descartando janelas vencidas.
        if (windows.size > 1000) {
          for (const [entryKey, entry] of windows) {
            if (current - entry.startedAt >= options.windowMs) windows.delete(entryKey);
          }
        }
        windows.set(key, { startedAt: current, count: 1 });
        return { allowed: true };
      }
      if (window.count >= options.limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + options.windowMs - current) / 1000)),
        };
      }
      window.count += 1;
      return { allowed: true };
    },
  };
}
