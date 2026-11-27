/**
 * Detecção de segredos no conteúdo que entra ou sai do gateway (Issue #028). Conservadora: na dúvida,
 * recusa. Nunca devolve nem registra o trecho encontrado — só `true`/`false`.
 *
 * Cobre os formatos já recusados pelas apresentações da #011 (tokens do GitHub, chaves `sk-`, AWS,
 * Slack, PEM, JWT) e chaves de provedores de IA (Google `AIza…`, NVIDIA `nvapi-…`, Anthropic
 * `sk-ant-…`), além de atribuições explícitas de senha/token/chave.
 */
const PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/,
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bnvapi-[A-Za-z0-9_-]{20,}/,
  // Issue #055: token local da ponte MCP do ACC.
  /\baccb_[A-Za-z0-9_-]{43}/,
  /\b(?:password|passwd|senha|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];

export function containsSecret(text: string): boolean {
  if (typeof text !== 'string') return true;
  return PATTERNS.some((pattern) => pattern.test(text));
}
