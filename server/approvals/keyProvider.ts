import { createHmac } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApprovalError } from './contracts.ts';
import { checkRegularFile, secureDirectory, type PathEnvironment } from './paths.ts';

/**
 * Fonte da chave HMAC do núcleo de aprovações (D3). A chave nunca é registrada, exibida,
 * serializada ou incluída em erros; só o `keyId` (derivado por HMAC, não reversível) aparece nos
 * documentos. Implementações: variável de ambiente e arquivo protegido; um cofre de segredos
 * pode implementar a mesma interface no futuro.
 */
export interface ApprovalKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export interface ApprovalKeyProvider {
  readonly source: 'env' | 'file' | 'vault';
  load(): Promise<ApprovalKey>;
}

export const MIN_KEY_BYTES = 32;
const MAX_KEY_FILE_BYTES = 1024;

function decodeKey(text: string): Buffer {
  const value = text.trim();
  let key: Buffer | null = null;
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) key = Buffer.from(value, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) key = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (!key || key.length < MIN_KEY_BYTES) throw new ApprovalError('key_invalid');
  return key;
}

export function keyIdOf(key: Buffer): string {
  return createHmac('sha256', key).update('acc-approvals-key-id:v1').digest('hex').slice(0, 16);
}

/** `ACC_APPROVAL_KEY`: hexadecimal ou base64/base64url, com pelo menos 32 bytes. */
export function createEnvKeyProvider(env: Readonly<Record<string, string | undefined>>, name = 'ACC_APPROVAL_KEY'): ApprovalKeyProvider {
  return {
    source: 'env',
    async load() {
      const raw = env[name];
      if (!raw || raw.trim() === '') throw new ApprovalError('key_unavailable');
      const key = decodeKey(raw);
      return { keyId: keyIdOf(key), key };
    },
  };
}

/**
 * Arquivo de chave (`ACC_APPROVAL_KEY_FILE`): diretório validado como o do anchor (fora do Git e
 * de pastas sincronizadas), arquivo regular sem links e, fora do Windows, sem permissão para
 * grupo/outros (0600). No Windows as ACLs não são verificadas aqui (limitação documentada).
 */
export function createFileKeyProvider(path: string, environment: PathEnvironment): ApprovalKeyProvider {
  return {
    source: 'file',
    async load() {
      await secureDirectory(dirname(path), environment);
      if (!(await checkRegularFile(path))) throw new ApprovalError('key_unavailable');
      const info = await stat(path);
      if (info.size > MAX_KEY_FILE_BYTES) throw new ApprovalError('key_invalid');
      if ((environment.platform ?? process.platform) !== 'win32' && (info.mode & 0o077) !== 0) throw new ApprovalError('key_file_permissions');
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch {
        throw new ApprovalError('key_unavailable');
      }
      const key = decodeKey(text);
      return { keyId: keyIdOf(key), key };
    },
  };
}
