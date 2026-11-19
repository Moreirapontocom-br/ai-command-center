import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StorageError } from './errors.ts';
import { assertSeparate, checkRegularFile, secureDirectory, type PathEnvironment } from './paths.ts';
import { writeBytesAtomic } from './signedLedger.ts';

/**
 * Armazenamento genérico de conteúdos CIFRADOS (Issue #028, P3). Primitiva de armazenamento: não
 * conhece o dono, aprovações nem fila; o dono (o gerenciador de conteúdos do Agent Gateway) guarda no ledger
 * assinado a referência, o resumo e o controle de acesso.
 *
 * - Confidencialidade e integridade: AES-256-GCM com chave própria (subchave HKDF injetada já
 *   derivada, nunca a chave principal), IV aleatório por gravação e dados associados (AAD) que
 *   prendem o conteúdo ao seu id e ao contexto informado pelo dono (dono/projeto/tipo). Um arquivo
 *   copiado para outro id ou contexto não decifra. Um resumo SHA-256 (no ledger do dono) não é
 *   criptografia: é só a conferência adicional.
 * - Ids opacos (UUID v4) gerados pelo dono; nomes de arquivo derivados só do id.
 * - Gravação atômica (tmp + fsync + rename); nada é registrado em log; erros só por token.
 * - Diretório exclusivo, validado como os demais (fora do Git e de pastas sincronizadas) e separado
 *   dos diretórios informados.
 */

export interface SealedBlobKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export interface SealedBlobStore {
  put(id: string, aad: string, content: Buffer): Promise<void>;
  /** Decifra; lança `blob_missing` (sem arquivo) ou `blob_corrupted` (formato, chave, AAD ou tag). */
  get(id: string, aad: string): Promise<Buffer>;
  /** Remove (idempotente). */
  delete(id: string): Promise<void>;
  /** Ids presentes no diretório (para a varredura de órfãos do dono). */
  list(): Promise<string[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORMAT = 'acc-sealed-blob';
const VERSION = 1;
const SUFFIX = '.blob.json';
export const SEALED_BLOB_MAX_BYTES = 1024 * 1024;

const fileOf = (dir: string, id: string) => {
  if (!UUID.test(id)) throw new StorageError('blob_id_invalid');
  return join(dir, `${id}${SUFFIX}`);
};

export async function openSealedBlobStore(options: {
  dir: string;
  environment: PathEnvironment;
  loadKey: () => Promise<SealedBlobKey> | SealedBlobKey;
  separateFrom?: readonly string[];
  maxBytes?: number;
}): Promise<SealedBlobStore> {
  const dir = await secureDirectory(options.dir, options.environment);
  for (const other of options.separateFrom ?? []) assertSeparate(dir, resolve(other), options.environment.platform);
  const key = await options.loadKey();
  if (!Buffer.isBuffer(key.key) || key.key.length !== 32 || !/^[0-9a-f]{16}$/.test(key.keyId)) throw new StorageError('key_invalid');
  const maxBytes = options.maxBytes ?? SEALED_BLOB_MAX_BYTES;
  const associated = (id: string, aad: string) => Buffer.from(`${FORMAT}:v${VERSION}\n${key.keyId}\n${id}\n${aad}`, 'utf8');

  return {
    async put(id, aad, content) {
      const path = fileOf(dir, id);
      if (!Buffer.isBuffer(content) || content.length > maxBytes) throw new StorageError('blob_too_large');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key.key, iv);
      cipher.setAAD(associated(id, aad));
      const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
      const document = { format: FORMAT, version: VERSION, keyId: key.keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
      try {
        await writeBytesAtomic(path, Buffer.from(JSON.stringify(document), 'utf8'));
      } catch {
        throw new StorageError('blob_write_failed');
      }
    },

    async get(id, aad) {
      const path = fileOf(dir, id);
      let raw: string;
      try {
        if (!(await checkRegularFile(path))) throw new StorageError('blob_missing');
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if (error instanceof StorageError && error.code === 'blob_missing') throw error;
        throw new StorageError('blob_missing');
      }
      try {
        const doc = JSON.parse(raw) as Record<string, unknown>;
        const keys = ['format', 'version', 'keyId', 'iv', 'tag', 'data'];
        if (typeof doc !== 'object' || doc === null || Object.keys(doc).length !== keys.length || !keys.every((k) => Object.hasOwn(doc, k))) throw new Error('format');
        if (doc.format !== FORMAT || doc.version !== VERSION || doc.keyId !== key.keyId) throw new Error('format');
        if (typeof doc.iv !== 'string' || typeof doc.tag !== 'string' || typeof doc.data !== 'string') throw new Error('format');
        const iv = Buffer.from(doc.iv, 'base64');
        const tag = Buffer.from(doc.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error('format');
        const decipher = createDecipheriv('aes-256-gcm', key.key, iv);
        decipher.setAAD(associated(id, aad));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, 'base64')), decipher.final()]);
        if (plain.length > maxBytes) throw new Error('size');
        return plain;
      } catch {
        throw new StorageError('blob_corrupted');
      }
    },

    async delete(id) {
      try {
        await rm(fileOf(dir, id), { force: true });
      } catch {
        throw new StorageError('blob_delete_failed');
      }
    },

    async list() {
      const names = await readdir(dir).catch(() => [] as string[]);
      return names.filter((n) => n.endsWith(SUFFIX)).map((n) => n.slice(0, -SUFFIX.length)).filter((id) => UUID.test(id));
    },
  };
}
