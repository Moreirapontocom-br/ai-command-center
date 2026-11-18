import { createHmac, hkdfSync } from 'node:crypto';
import { inspect } from 'node:util';
import { StorageError } from './errors.ts';

/**
 * Subchaves por domínio (Issue #012, U5): HKDF-SHA256 sobre a chave principal do ACC
 * (`ACC_APPROVAL_KEY`/`ACC_APPROVAL_KEY_FILE`), com `info` = domínio explícito. Cada domínio novo
 * (a fila usa `acc:queue:mac:v1`) recebe uma chave independente e um `keyId` próprio.
 *
 * - O núcleo de aprovações (#011) continua usando a chave principal diretamente, com o prefixo
 *   `acc-approvals:v1:` — sem migração (U5). No HKDF a chave principal entra só como material de
 *   entrada (mensagem do HMAC de extração), nunca como chave de um MAC de documento.
 * - A subchave nunca é registrada nem serializada: `toJSON` e `inspect` mostram só domínio e `keyId`.
 *   O `keyId` (HMAC da subchave sobre um rótulo fixo, 16 hex) não permite recuperar a chave.
 */
export const QUEUE_KEY_DOMAIN = 'acc:queue:mac:v1';
export const MIN_MASTER_KEY_BYTES = 32;
export const SUBKEY_BYTES = 32;
/** Sal fixo e público: separa este uso do HKDF de qualquer outro com a mesma chave principal. */
const SUBKEY_SALT = Buffer.from('acc-storage-subkey-salt:v1', 'utf8');
const DOMAIN = /^acc:[a-z0-9_-]+(?::[a-z0-9_-]+)*:v[1-9][0-9]*$/;

export interface DerivedKey {
  readonly domain: string;
  readonly keyId: string;
  readonly key: Buffer;
}

export function subkeyIdOf(subkey: Buffer, domain: string): string {
  return createHmac('sha256', subkey).update(`acc-subkey-id:v1:${domain}`, 'utf8').digest('hex').slice(0, 16);
}

export function deriveSubkey(master: Buffer, domain: string): DerivedKey {
  if (!Buffer.isBuffer(master) || master.length < MIN_MASTER_KEY_BYTES) throw new StorageError('key_invalid');
  if (typeof domain !== 'string' || !DOMAIN.test(domain)) throw new StorageError('key_domain_invalid');
  const key = Buffer.from(hkdfSync('sha256', master, SUBKEY_SALT, Buffer.from(domain, 'utf8'), SUBKEY_BYTES));
  const keyId = subkeyIdOf(key, domain);
  const derived = { domain, keyId } as DerivedKey;
  Object.defineProperty(derived, 'key', { value: key, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(derived, 'toJSON', { value: () => ({ domain, keyId }), enumerable: false });
  Object.defineProperty(derived, inspect.custom, { value: () => `DerivedKey(${domain}, ${keyId})`, enumerable: false });
  return Object.freeze(derived);
}
