import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Motor comum de persistência local (Issues #004 e #005): um documento JSON por arquivo, fora do Git.
 *
 * - escrita atômica: arquivo temporário (`wx`, 0600) + `fsync` + `rename`;
 * - escritas serializadas: uma alteração por vez, em fila;
 * - a alteração é aplicada numa CÓPIA; o estado em memória só é trocado depois que o arquivo foi
 *   gravado com sucesso (falha de disco ou regra de negócio violada não deixa nada pela metade);
 * - na abertura, o documento é validado por completo; inválido → `DataFileError`, e o arquivo
 *   nunca é sobrescrito. As mensagens descrevem o problema, nunca o conteúdo.
 */

export class DataFileError extends Error {
  name = 'DataFileError';
}

export type WriteFile = (filePath: string, content: string) => Promise<void>;

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Grava de forma atômica: o arquivo final só é substituído por um conteúdo completo e sincronizado
 * em disco. No Windows, antivírus/sincronização podem segurar o arquivo por instantes; o `rename`
 * é repetido algumas vezes antes de falhar.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt < 5 && RETRYABLE_RENAME.has(code)) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

export interface JsonFileOptions<T> {
  filePath: string;
  /** Nome legível do arquivo nas mensagens de erro (ex.: "projetos"). */
  label: string;
  format: string;
  version: number;
  maxBytes: number;
  /** Estado inicial quando o arquivo ainda não existe (criado na primeira escrita). */
  empty: () => T;
  /** Valida o documento (sem `format`/`version`). Chama `corrupt(detalhe)` se inválido. */
  validate: (raw: Record<string, unknown>, corrupt: (detail: string) => never) => T;
  writeFile?: WriteFile;
}

export interface JsonFileState<T> {
  /** Estado confirmado em disco. Somente leitura para quem chama. */
  readonly data: T;
  /** Aplica `change` numa cópia, grava e só então publica. Exceções em `change` cancelam tudo. */
  mutate<R>(change: (draft: T) => R): Promise<R>;
}

export async function openJsonFile<T extends object>(options: JsonFileOptions<T>): Promise<JsonFileState<T>> {
  const corrupt = (detail: string): never => {
    throw new DataFileError(
      `Arquivo de ${options.label} inválido (${detail}). Corrija ou restaure um backup; ele não será sobrescrito.`,
    );
  };
  const write = options.writeFile ?? writeFileAtomic;

  async function load(): Promise<T> {
    let size: number;
    try {
      size = (await stat(options.filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return options.empty();
      throw new DataFileError(`Não foi possível ler o arquivo de ${options.label}.`);
    }
    if (size > options.maxBytes) corrupt('tamanho acima do limite');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(options.filePath, 'utf8'));
    } catch {
      return corrupt('JSON ilegível');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return corrupt('estrutura');
    const { format, version, ...rest } = parsed as Record<string, unknown>;
    if (format !== options.format) corrupt('formato');
    if (version !== options.version) corrupt('versão não suportada');
    return options.validate(rest, corrupt);
  }

  let data = await load();
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = (value: T) =>
    `${JSON.stringify({ format: options.format, version: options.version, ...value }, null, 2)}\n`;

  return {
    get data() {
      return data;
    },
    mutate(change) {
      const run = queue.then(async () => {
        const draft = structuredClone(data);
        const result = change(draft);
        const content = serialize(draft);
        if (Buffer.byteLength(content) > options.maxBytes) corrupt('tamanho acima do limite após a alteração');
        await write(options.filePath, content);
        data = draft;
        return result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
