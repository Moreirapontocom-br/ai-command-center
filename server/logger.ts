/** Padrões de credenciais do GitHub e chaves privadas que nunca podem aparecer em logs. */
const SECRET_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]+/g,
  /\bgh[pousr]_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text);
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, meta?: Record<string, string | number | boolean | null>): void;
}

export function createConsoleLogger(write: (line: string) => void = (line) => console.log(line)): Logger {
  return {
    log(level, message, meta) {
      const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...meta });
      write(redact(line));
    },
  };
}

export const silentLogger: Logger = { log: () => {} };
