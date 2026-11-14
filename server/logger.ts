/**
 * Logger estruturado (JSON por linha) com mascaramento em duas camadas:
 * 1. por NOME do campo: valores de campos sensíveis (Authorization, Cookie, Set-Cookie, token,
 *    senha, segredo, sessão…) nunca são escritos, qualquer que seja o conteúdo;
 * 2. por PADRÃO de valor, na linha final: tokens do GitHub, `Bearer`/`Basic`, chaves privadas,
 *    cabeçalhos sensíveis em texto livre e parâmetros de query com credenciais.
 * Nenhuma camada substitui a regra principal: não registrar cabeçalhos nem corpos de requisição.
 */

const MASK = '[REDACTED]';

/** Padrões de credenciais que nunca podem aparecer em logs. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/github_pat_[A-Za-z0-9_]+/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]+/g, MASK],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  // Cabeçalho sensível em texto livre (`Cookie: a=1`, `"set-cookie":"…"`, `authorization=…`).
  [
    /\b(set-cookie|cookie|proxy-authorization|authorization|x-api-key)(\\?["']?\s*[:=]\s*\\?["']?)[^"'\\\r\n]+/gi,
    `$1$2${MASK}`,
  ],
  // Parâmetro de query/formulário com credencial (`?access_token=…`, `&password=…`).
  [
    /\b(access_token|refresh_token|id_token|token|password|passwd|secret|client_secret|api_key|apikey|session|sid)=[^&\s"'\\]+/gi,
    `$1=${MASK}`,
  ],
];

/** Campos cujo valor nunca é registrado (comparação sem diferenciar maiúsculas). */
const SENSITIVE_KEY =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|token|secret|passw(?:or)?d|credential|session|api[-_]?key|private[-_]?key/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

export type LogLevel = 'info' | 'warn' | 'error';
export type LogMeta = Record<string, string | number | boolean | null>;

export interface Logger {
  log(level: LogLevel, message: string, meta?: LogMeta): void;
}

const RESERVED_KEYS = new Set(['time', 'level', 'message']);

function redactMeta(meta: LogMeta | undefined): LogMeta {
  const safe: LogMeta = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (RESERVED_KEYS.has(key)) continue; // `meta` não sobrescreve os campos do próprio logger
    safe[key] = isSensitiveKey(key) ? MASK : value;
  }
  return safe;
}

export function createConsoleLogger(write: (line: string) => void = (line) => console.log(line)): Logger {
  return {
    log(level, message, meta) {
      const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...redactMeta(meta) });
      write(redact(line));
    },
  };
}

export const silentLogger: Logger = { log: () => {} };
