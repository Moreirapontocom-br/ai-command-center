import { realpath as realpathCallback } from 'node:fs';
import { lstat, mkdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { ApprovalError } from './contracts.ts';

/**
 * Validação dos caminhos EFETIVOS do armazenamento de aprovações (N2).
 *
 * - O caminho precisa ser absoluto; é criado (0700) se não existir.
 * - É resolvido com `realpath.native`, que segue links simbólicos e junções do Windows: a
 *   validação vale para o destino real, não para o nome informado.
 * - Recusado se o caminho informado OU o resolvido estiver dentro de um repositório Git (qualquer
 *   ancestral com `.git`) ou de uma pasta sincronizada (variáveis do OneDrive e nomes conhecidos
 *   de clientes de sincronização). Um arquivo antigo devolvido pela sincronização seria um rollback.
 * - Arquivos: nunca link simbólico e nunca com mais de um link físico (um hard link poderia expor o
 *   mesmo conteúdo dentro de uma pasta sincronizada).
 */

/** `realpath.native`: resolve links simbólicos E junções do Windows (via `GetFinalPathNameByHandle`). */
const realpathNative = promisify(realpathCallback.native);

const SYNC_ENV_VARS = ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial'] as const;
/** Segmentos de caminho de clientes de sincronização conhecidos (comparação sem maiúsculas). */
const SYNC_SEGMENTS = [/^onedrive(\s-\s.+)?$/i, /^dropbox$/i, /^google drive$/i, /^my drive$/i, /^icloud ?drive$/i, /^box( sync)?$/i, /^pcloud drive$/i, /^nextcloud$/i, /^owncloud$/i, /^mega$/i];

export interface PathEnvironment {
  /** Variáveis de ambiente relevantes (injetadas pelo chamador; o núcleo nunca lê o ambiente do processo). */
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
}

const norm = (path: string, platform: NodeJS.Platform) => {
  const resolved = resolve(path);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function isInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const c = norm(child, platform);
  const p = norm(parent, platform).replace(/[\\/]+$/, '');
  return c === p || c.startsWith(p + sep) || c.startsWith(`${p}/`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function insideGitRepository(path: string): Promise<boolean> {
  let current = resolve(path);
  for (;;) {
    if (await exists(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) return false;
    current = parent;
  }
}

async function resolvedSyncRoots(env: PathEnvironment['env']): Promise<string[]> {
  const roots: string[] = [];
  for (const name of SYNC_ENV_VARS) {
    const value = env[name]?.trim();
    if (!value || !isAbsolute(value)) continue;
    roots.push(value);
    try {
      roots.push(await realpathNative(value));
    } catch {
      // Raiz inexistente: o nome informado continua valendo para a comparação.
    }
  }
  return roots;
}

function hasSyncSegment(path: string): boolean {
  return resolve(path)
    .split(/[\\/]+/)
    .some((segment) => SYNC_SEGMENTS.some((pattern) => pattern.test(segment)));
}

/** Valida (e cria, se preciso) um diretório protegido. Devolve o caminho REAL. */
export async function secureDirectory(path: string, environment: PathEnvironment): Promise<string> {
  const platform = environment.platform ?? process.platform;
  if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) throw new ApprovalError('path_not_absolute');
  await mkdir(path, { recursive: true, mode: 0o700 });
  let real: string;
  try {
    real = await realpathNative(path);
  } catch {
    throw new ApprovalError('path_unresolvable');
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw new ApprovalError('path_not_directory');
  const roots = await resolvedSyncRoots(environment.env);
  for (const candidate of [path, real]) {
    if (hasSyncSegment(candidate) || roots.some((root) => isInside(candidate, root, platform))) throw new ApprovalError('path_in_synced_folder');
    if (await insideGitRepository(candidate)) throw new ApprovalError('path_in_git_repository');
  }
  return real;
}

/** Os dois diretórios precisam ser distintos e não aninhados (o anchor fica fora do ledger). */
export function assertSeparate(a: string, b: string, platform: NodeJS.Platform = process.platform) {
  if (isInside(a, b, platform) || isInside(b, a, platform)) throw new ApprovalError('paths_not_separate');
}

/** Arquivo existente: nunca link simbólico nem com links físicos extras. `false` se não existe. */
export async function checkRegularFile(path: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ApprovalError('file_unreadable');
  }
  if (info.isSymbolicLink()) throw new ApprovalError('file_is_link');
  if (!info.isFile()) throw new ApprovalError('file_not_regular');
  if (info.nlink > 1) throw new ApprovalError('file_has_hard_links');
  return true;
}
