import { createFineGrainedTokenProvider, type CredentialProvider } from './auth/credentials.ts';

/**
 * Lista EXPLÍCITA de repositórios que o servidor aceita consultar. Qualquer outro `owner/repo`
 * é recusado com 404, mesmo que o token tenha acesso a ele. Alterações aqui passam por revisão de PR.
 */
export const ALLOWED_REPOSITORIES: readonly string[] = ['Moreirapontocom-br/ai-command-center'];

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

export interface ServerConfig {
  host: string;
  port: number;
  allowedRepositories: readonly string[];
  /** Origens de navegador aceitas no cabeçalho `Origin` (dev server e preview do Vite). */
  allowedOrigins: readonly string[];
  credentials: CredentialProvider | null;
  requestTimeoutMs: number;
  /** Tempo em que um snapshot é servido do cache sem nova consulta ao GitHub. */
  cacheTtlMs: number;
  /** Intervalo mínimo entre consultas ao GitHub por repositório, mesmo com `?refresh=1`. */
  minRefreshIntervalMs: number;
  /** Limite de requisições por cliente a cada minuto. */
  rateLimitPerMinute: number;
}

export class ConfigError extends Error {
  name = 'ConfigError';
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('API_PORT deve ser um número entre 1 e 65535.');
  }
  return port;
}

/**
 * Lê a configuração do ambiente. Falha de forma explícita em configurações inseguras.
 * As mensagens de erro nunca incluem o valor do token.
 */
export function loadConfig(env: Record<string, string | undefined>): ServerConfig {
  // Uma credencial com prefixo VITE_ seria embutida no bundle do navegador pelo Vite.
  const leakedKeys = Object.keys(env).filter(
    (key) => key.startsWith('VITE_') && /TOKEN|SECRET|GITHUB|KEY|PAT/i.test(key),
  );
  if (leakedKeys.length > 0) {
    throw new ConfigError(
      `Variáveis com prefixo VITE_ seriam expostas ao navegador e não podem conter credenciais: ${leakedKeys.join(', ')}.`,
    );
  }

  const host = env.API_HOST?.trim() || '127.0.0.1';
  if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
    throw new ConfigError(
      'API_HOST deve ser um endereço de loopback (127.0.0.1, localhost ou ::1). O servidor não possui ' +
        'autenticação de usuários e não pode ser exposto à rede nesta versão.',
    );
  }

  const port = parsePort(env.API_PORT, 8787);
  const token = env.GITHUB_TOKEN?.trim() ?? '';

  return {
    host,
    port,
    allowedRepositories: ALLOWED_REPOSITORIES,
    allowedOrigins: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ],
    credentials: token === '' ? null : createFineGrainedTokenProvider(token),
    requestTimeoutMs: 10_000,
    cacheTtlMs: 60_000,
    minRefreshIntervalMs: 15_000,
    rateLimitPerMinute: 60,
  };
}
