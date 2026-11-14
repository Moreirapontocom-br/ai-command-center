import { isAbsolute } from 'node:path';
import { createFineGrainedTokenProvider, type CredentialProvider } from './auth/credentials.ts';
import { createGhCliCredentialProvider, type GhCliProviderOptions } from './auth/ghCli.ts';

/**
 * Lista EXPLÍCITA de repositórios que o servidor aceita consultar. Qualquer outro `owner/repo`
 * é recusado com 404, mesmo que o token tenha acesso a ele. Alterações aqui passam por revisão de PR.
 */
export const ALLOWED_REPOSITORIES: readonly string[] = ['Moreirapontocom-br/ai-command-center'];

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const;

/**
 * Ambiente de implantação declarado em `ACC_DEPLOYMENT`. Sem detecção automática:
 * - `local`: máquina do desenvolvedor — único ambiente em que `GITHUB_AUTH=gh-cli` é aceito;
 * - `production`: qualquer ambiente que não seja a máquina do desenvolvedor;
 * - ausente: não declarado — `gh-cli` é recusado (é preciso optar explicitamente por `local`).
 */
export const DEPLOYMENT_MODES = ['local', 'production'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export interface ServerConfig {
  /** `null` quando `ACC_DEPLOYMENT` não foi definido. */
  deployment: DeploymentMode | null;
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

export const AUTH_MODES = ['fine-grained', 'gh-cli'] as const;

/**
 * Seleciona o provedor de credencial. Regras:
 * - `GITHUB_AUTH` ausente/vazio ou `fine-grained` → token fine-grained em `GITHUB_TOKEN` (ou demonstração);
 * - `GITHUB_AUTH=gh-cli` → sessão local do GitHub CLI (somente desenvolvimento local). Exige
 *   `ACC_DEPLOYMENT=local` explícito e `GITHUB_TOKEN` vazio (configuração ambígua é recusada), e é
 *   recusado com `NODE_ENV=production`. O `gh-cli` identifica o DESENVOLVEDOR perante o GitHub; ele
 *   não autentica usuários desta aplicação (o servidor não tem login nesta versão);
 * - qualquer outro valor → erro. Nunca há detecção automática.
 */
function parseDeployment(value: string | undefined): DeploymentMode | null {
  const mode = value?.trim() ?? '';
  if (mode === '') return null;
  if (!(DEPLOYMENT_MODES as readonly string[]).includes(mode)) {
    // O valor não é repetido na mensagem.
    throw new ConfigError(`ACC_DEPLOYMENT inválido. Valores aceitos: ${DEPLOYMENT_MODES.join(', ')}.`);
  }
  return mode as DeploymentMode;
}

function resolveCredentials(
  env: Record<string, string | undefined>,
  deployment: DeploymentMode | null,
  ghCliOverrides: Pick<GhCliProviderOptions, 'exec' | 'now'>,
): CredentialProvider | null {
  const mode = env.GITHUB_AUTH?.trim() || 'fine-grained';
  const token = env.GITHUB_TOKEN?.trim() ?? '';

  if (!(AUTH_MODES as readonly string[]).includes(mode)) {
    // O valor não é repetido na mensagem (pode ter sido um segredo colado no lugar errado).
    throw new ConfigError(`GITHUB_AUTH inválido. Valores aceitos: ${AUTH_MODES.join(', ')}.`);
  }

  if (mode === 'fine-grained') {
    if (env.GH_PATH?.trim()) throw new ConfigError('GH_PATH só pode ser usado com GITHUB_AUTH=gh-cli.');
    return token === '' ? null : createFineGrainedTokenProvider(token);
  }

  if (token !== '') {
    throw new ConfigError(
      'Configuração ambígua: GITHUB_AUTH=gh-cli não pode ser usado junto com GITHUB_TOKEN. Remova um dos dois.',
    );
  }
  if (deployment !== 'local') {
    throw new ConfigError(
      'GITHUB_AUTH=gh-cli é exclusivo para desenvolvimento local e exige ACC_DEPLOYMENT=local declarado explicitamente.',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new ConfigError('GITHUB_AUTH=gh-cli é exclusivo para desenvolvimento local e não pode ser usado em produção.');
  }
  const ghPath = env.GH_PATH?.trim() || undefined;
  if (ghPath !== undefined && !isAbsolute(ghPath)) {
    throw new ConfigError('GH_PATH deve ser o caminho absoluto do executável do GitHub CLI.');
  }
  return createGhCliCredentialProvider({ ...ghCliOverrides, ghPath, env });
}

/**
 * Lê a configuração do ambiente. Falha de forma explícita em configurações inseguras.
 * As mensagens de erro nunca incluem o valor do token.
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  /** Apenas para testes: substitui a execução do `gh` (o caminho e o ambiente vêm de `env`). */
  ghCliOverrides: Pick<GhCliProviderOptions, 'exec' | 'now'> = {},
): ServerConfig {
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
  const deployment = parseDeployment(env.ACC_DEPLOYMENT);
  const credentials = resolveCredentials(env, deployment, ghCliOverrides);

  return {
    deployment,
    host,
    port,
    allowedRepositories: ALLOWED_REPOSITORIES,
    allowedOrigins: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://127.0.0.1:4173',
    ],
    credentials,
    requestTimeoutMs: 10_000,
    cacheTtlMs: 60_000,
    minRefreshIntervalMs: 15_000,
    rateLimitPerMinute: 60,
  };
}
