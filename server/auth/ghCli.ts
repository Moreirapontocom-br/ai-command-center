import { execFile } from 'node:child_process';
import { CredentialError, sealProvider, type CredentialProvider } from './credentials.ts';

/**
 * Provedor de credencial baseado na sessão local do GitHub CLI — SOMENTE DESENVOLVIMENTO LOCAL.
 *
 * ATENÇÃO (risco residual): o token OAuth do `gh` costuma ter escopos amplos (`repo`, `workflow`),
 * com ESCRITA em todos os repositórios da conta. Este provedor não reduz essas permissões: a
 * garantia de somente leitura vem do próprio servidor (só GET/HEAD, allowlist de repositórios e
 * allowlist de documentos GraphQL em `client.ts`). Nunca use este modo em servidor compartilhado.
 *
 * O `gh` é executado com `execFile` (sem shell), argumentos FIXOS, timeout e limite de saída.
 * Nenhum dado de requisição chega a este módulo.
 */

/** Único comando executado. Congelado: não há como acrescentar argumentos. */
export const GH_AUTH_TOKEN_ARGS: readonly string[] = Object.freeze(['auth', 'token', '--hostname', 'github.com']);

export const GH_DEFAULTS = {
  timeoutMs: 5_000,
  /** O token tem dezenas de bytes; qualquer coisa muito maior é tratada como saída inválida. */
  maxOutputBytes: 1_024,
  cacheTtlMs: 10 * 60_000,
} as const;

/**
 * Variáveis removidas do ambiente do `gh`, para que o token venha SEMPRE da sessão do CLI
 * (keyring/config) e nunca de um token definido no ambiente.
 */
const STRIPPED_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'];

/** Formatos de token que o `gh` pode guardar (OAuth, user-to-server, clássico, fine-grained). */
const GH_TOKEN_PATTERN = /^(?:gho_|ghu_|ghp_)[A-Za-z0-9]{20,255}$|^github_pat_[A-Za-z0-9_]{20,255}$/;

export interface ExecFileOptions {
  shell: false;
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  encoding: 'utf8';
  env: NodeJS.ProcessEnv;
}

export type ExecFileLike = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<string>;

const defaultExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout) => {
      // O erro original (que pode conter stderr) nunca é propagado: só o fato de ter falhado.
      if (error) reject(new Error('gh falhou'));
      else resolve(String(stdout));
    });
  });

export interface GhCliProviderOptions {
  /** Caminho absoluto opcional do executável (validado em `config.ts`). Padrão: `gh` no PATH. */
  ghPath?: string;
  exec?: ExecFileLike;
  env?: NodeJS.ProcessEnv;
  cacheTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export const GH_CLI_ERROR_MESSAGE =
  'Não foi possível obter a credencial do GitHub CLI. Verifique se o `gh` está instalado e autenticado ' +
  '(`gh auth status`).';

function sanitizedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of STRIPPED_ENV) delete copy[key];
  return copy;
}

/** Valida a saída do `gh auth token`: uma única linha com formato de token. */
function parseToken(stdout: string): string {
  const withoutTrailingNewline = stdout.replace(/\r?\n$/, '');
  if (/[\r\n]/.test(withoutTrailingNewline)) throw new CredentialError(GH_CLI_ERROR_MESSAGE);
  const token = withoutTrailingNewline.trim();
  if (!GH_TOKEN_PATTERN.test(token)) throw new CredentialError(GH_CLI_ERROR_MESSAGE);
  return token;
}

export function createGhCliCredentialProvider(options: GhCliProviderOptions = {}): CredentialProvider {
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? GH_DEFAULTS.cacheTtlMs;
  const file = options.ghPath ?? 'gh';
  const execOptions: ExecFileOptions = {
    shell: false,
    timeout: options.timeoutMs ?? GH_DEFAULTS.timeoutMs,
    maxBuffer: GH_DEFAULTS.maxOutputBytes,
    windowsHide: true,
    encoding: 'utf8',
    env: sanitizedEnv(options.env ?? process.env),
  };

  let cached: { token: string; expiresAtMs: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    let stdout: string;
    try {
      stdout = await exec(file, GH_AUTH_TOKEN_ARGS, execOptions);
    } catch {
      throw new CredentialError(GH_CLI_ERROR_MESSAGE);
    }
    const token = parseToken(stdout);
    cached = { token, expiresAtMs: now() + cacheTtlMs };
    return token;
  }

  return sealProvider<CredentialProvider>({
    kind: 'gh-cli',
    async getAuthorizationHeader() {
      if (cached && now() < cached.expiresAtMs) return `Bearer ${cached.token}`;
      cached = null;
      // Requisições simultâneas compartilham uma única execução do `gh`.
      pending ??= fetchToken().finally(() => {
        pending = null;
      });
      return `Bearer ${await pending}`;
    },
    invalidate() {
      cached = null;
    },
  });
}
