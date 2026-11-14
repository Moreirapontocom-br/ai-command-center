/**
 * Cabeçalhos de segurança HTTP — fonte única para o servidor da API e para o Vite (dev e preview).
 * Qualquer hospedagem futura do frontend precisa reproduzir `appSecurityHeaders('production')`.
 *
 * Diferenças entre modos (necessárias, documentadas em docs/IMPLEMENTATION_REPORT_003_PR1.md):
 * - `production` (build servido por `vite preview` ou hospedagem): nenhum script/estilo inline;
 *   o build do Vite gera apenas `<script src>` e `<link rel="stylesheet">` na própria origem.
 * - `development` (`vite` dev server): o Vite injeta o preâmbulo do React Refresh como script inline,
 *   aplica CSS via `<style>` inline e usa WebSocket para HMR. Por isso este modo — e só ele — permite
 *   `'unsafe-inline'` e `ws:` em loopback. O dev server só escuta em localhost.
 */

export type AppMode = 'production' | 'development';

type Directives = Record<string, readonly string[]>;

function serialize(directives: Directives): string {
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(' '))
    .join('; ');
}

const PRODUCTION_DIRECTIVES: Directives = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // Estilos só de arquivos da origem. Estilo dinâmico via React (`style={{…}}`) usa CSSOM e não é
  // afetado por esta diretiva; atributos `style="…"` em HTML seriam bloqueados.
  'style-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'"],
  // O navegador só fala com `/api` na própria origem (proxy). Nunca diretamente com o GitHub.
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
  'frame-ancestors': ["'none'"],
};

const DEVELOPMENT_DIRECTIVES: Directives = {
  ...PRODUCTION_DIRECTIVES,
  'script-src': ["'self'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  // `ws://[::1]:*` não é uma fonte CSP válida no Chrome (é ignorada com aviso); o dev server
  // escuta em localhost/127.0.0.1.
  'connect-src': ["'self'", 'ws://localhost:*', 'ws://127.0.0.1:*'],
};

export function appContentSecurityPolicy(mode: AppMode): string {
  return serialize(mode === 'production' ? PRODUCTION_DIRECTIVES : DEVELOPMENT_DIRECTIVES);
}

/** Cabeçalhos comuns a qualquer resposta (API e frontend). */
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
} as const;

/** Cabeçalhos do frontend (HTML, JS, CSS e assets servidos pelo Vite). */
export function appSecurityHeaders(mode: AppMode): Record<string, string> {
  return {
    ...BASE_HEADERS,
    'Content-Security-Policy': appContentSecurityPolicy(mode),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

/**
 * Cabeçalhos das respostas JSON da API: o conteúdo nunca é documento, então a CSP nega tudo.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  ...BASE_HEADERS,
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
});
