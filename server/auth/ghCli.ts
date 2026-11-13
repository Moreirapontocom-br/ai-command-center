import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
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

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export interface ResolveExecutableOptions {
  platform?: NodeJS.Platform;
  isFile?: (path: string) => boolean;
}

/**
 * Localiza o `gh` no PATH sem delegar a busca ao sistema operacional. No Windows, a busca padrão
 * de executáveis consulta o DIRETÓRIO ATUAL antes do PATH, então um `gh.exe` plantado na pasta do
 * projeto seria executado. Aqui só entram entradas ABSOLUTAS do PATH (`.`, vazias e relativas são
 * ignoradas) e, no Windows, apenas `gh.exe` (`.cmd`/`.bat` exigiriam shell). Devolve o caminho
 * absoluto ou `null`.
 */
export function resolveGhExecutable(env: NodeJS.ProcessEnv, options: ResolveExecutableOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const path = platform === 'win32' ? win32 : posix;
  // No Windows a variável costuma se chamar `Path`; numa cópia do ambiente a chave diferencia caixa.
  const key = platform === 'win32' ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') : 'PATH';
  const value = key ? env[key] : undefined;
  if (!value) return null;
  const name = platform === 'win32' ? 'gh.exe' : 'gh';
  for (const rawEntry of value.split(path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    if (!entry || !path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

const defaultExec: ExecFileLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    // Nunca deixa o sistema operacional resolver um nome relativo (ver `resolveGhExecutable`).
    const executable = win32.isAbsolute(file) || posix.isAbsolute(file) ? file : resolveGhExecutable(options.env);
    if (!executable) {
      reject(new Error('gh não encontrado'));
      return;
    }
    execFile(executable, [...args], options, (error, stdout) => {
      // O erro original (que pode conter stderr) nunca é propagado: só o fato de ter falhado.
      if (error) reject(new Error('gh falhou'));
      else resolve(String(stdout));
    });
  });

export interface GhCliProviderOptions {
  /**
   * Caminho absoluto opcional do executável (validado em `config.ts`). Padrão: `gh` resolvido
   * apenas em entradas absolutas do PATH (`resolveGhExecutable`).
   */
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
