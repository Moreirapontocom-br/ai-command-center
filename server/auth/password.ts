import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Hash de senha com scrypt (`node:crypto`, sem dependências externas).
 *
 * Formato armazenado (sem `$`, para não sofrer expansão em arquivos `.env`):
 *   `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`
 *
 * Parâmetros padrão conforme a recomendação da OWASP para scrypt: N=2^17, r=8, p=1 (128 MiB por
 * verificação). A verificação usa os parâmetros gravados no próprio hash.
 */

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** Custo mínimo aceito na configuração do servidor (hashes mais fracos são recusados). */
export const MIN_CONFIG_SCRYPT_N = 2 ** 17;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const HASH_PATTERN = /^scrypt:(\d{1,8}):(\d{1,2}):(\d{1,2}):([A-Za-z0-9_-]{16,128}):([A-Za-z0-9_-]{40,128})$/;

export interface PasswordHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

export class PasswordHashFormatError extends Error {
  name = 'PasswordHashFormatError';
}

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // Memória necessária ≈ 128 · N · r · p; folga para o restante do algoritmo.
    maxmem: 256 * params.N * params.r * params.p,
  };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function isPowerOfTwo(value: number): boolean {
  return value > 1 && (value & (value - 1)) === 0;
}

/** Interpreta um hash armazenado. A mensagem de erro nunca repete o valor recebido. */
export function parsePasswordHash(encoded: string): PasswordHash {
  const match = HASH_PATTERN.exec(encoded.trim());
  if (!match) throw new PasswordHashFormatError('Hash de senha em formato inválido.');
  const params = { N: Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (!isPowerOfTwo(params.N) || params.N > 2 ** 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 4) {
    throw new PasswordHashFormatError('Hash de senha com parâmetros scrypt inválidos.');
  }
  const salt = Buffer.from(match[4], 'base64url');
  const hash = Buffer.from(match[5], 'base64url');
  if (salt.length < SALT_LENGTH || hash.length !== KEY_LENGTH) {
    throw new PasswordHashFormatError('Hash de senha em formato inválido.');
  }
  return { params, salt, hash };
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, params);
  return `scrypt:${params.N}:${params.r}:${params.p}:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

/** Comparação em tempo constante. Senhas acima do limite são recusadas sem calcular o hash. */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const candidate = await scryptAsync(password, stored.salt, stored.params);
  return timingSafeEqual(candidate, stored.hash);
}
