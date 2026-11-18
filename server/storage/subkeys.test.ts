// @vitest-environment node
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { macHex } from '../approvals/canonical.ts';
import { keyIdOf } from '../approvals/keyProvider.ts';
import { equalHex, namespacedMacHex } from './canonical.ts';
import { deriveSubkey, QUEUE_KEY_DOMAIN, subkeyIdOf } from './subkeys.ts';

/** Subchaves HKDF-SHA256 por domínio (Issue #012, U5). */
describe('derivação de subchaves (HKDF)', () => {
  const master = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');

  it('é HKDF-SHA256 com sal fixo e info = domínio; determinística', () => {
    const expected = Buffer.from(hkdfSync('sha256', master, Buffer.from('acc-storage-subkey-salt:v1'), Buffer.from(QUEUE_KEY_DOMAIN), 32));
    const derived = deriveSubkey(master, QUEUE_KEY_DOMAIN);
    expect(QUEUE_KEY_DOMAIN).toBe('acc:queue:mac:v1');
    expect(derived.key.equals(expected)).toBe(true);
    expect(derived.key.length).toBe(32);
    expect(deriveSubkey(master, QUEUE_KEY_DOMAIN).key.equals(derived.key)).toBe(true);
    expect(derived.keyId).toBe(createHmac('sha256', expected).update('acc-subkey-id:v1:acc:queue:mac:v1').digest('hex').slice(0, 16));
    expect(subkeyIdOf(derived.key, QUEUE_KEY_DOMAIN)).toBe(derived.keyId);
  });

  it('domínios diferentes → chaves e keyIds independentes; nenhum coincide com a chave principal', () => {
    const queue = deriveSubkey(master, QUEUE_KEY_DOMAIN);
    const other = deriveSubkey(master, 'acc:other:mac:v1');
    const v2 = deriveSubkey(master, 'acc:queue:mac:v2');
    expect(queue.key.equals(other.key)).toBe(false);
    expect(queue.key.equals(v2.key)).toBe(false);
    expect(queue.key.equals(master)).toBe(false);
    expect(new Set([queue.keyId, other.keyId, v2.keyId, keyIdOf(master)]).size).toBe(4);
    // Chave principal diferente → subchave diferente.
    expect(deriveSubkey(randomBytes(32), QUEUE_KEY_DOMAIN).key.equals(queue.key)).toBe(false);
  });

  it('separação de domínio criptográfico: MAC da fila nunca valida como MAC das aprovações (e vice-versa)', () => {
    const queue = deriveSubkey(master, QUEUE_KEY_DOMAIN);
    const doc = { format: 'x', body: { items: [] } };
    const approvalsMac = macHex(master, 'ledger', doc);
    const queueMac = namespacedMacHex(queue.key, 'acc-queue:v1', 'ledger', doc);
    expect(equalHex(approvalsMac, queueMac)).toBe(false);
    // Mesmo namespace com a chave errada, ou chave certa com o namespace errado: não valida.
    expect(equalHex(namespacedMacHex(master, 'acc-queue:v1', 'ledger', doc), queueMac)).toBe(false);
    expect(equalHex(namespacedMacHex(queue.key, 'acc-approvals:v1', 'ledger', doc), approvalsMac)).toBe(false);
    // Domínios de documento diferentes também não colidem.
    expect(equalHex(namespacedMacHex(queue.key, 'acc-queue:v1', 'anchor', doc), queueMac)).toBe(false);
  });

  it('material secreto nunca é serializado nem exibido', () => {
    const derived = deriveSubkey(master, QUEUE_KEY_DOMAIN);
    const hex = derived.key.toString('hex');
    expect(JSON.stringify(derived)).toBe(JSON.stringify({ domain: QUEUE_KEY_DOMAIN, keyId: derived.keyId }));
    expect(inspect(derived)).toBe(`DerivedKey(${QUEUE_KEY_DOMAIN}, ${derived.keyId})`);
    expect(Object.keys(derived).sort()).toEqual(['domain', 'keyId']);
    expect(JSON.stringify({ ...derived })).not.toContain(hex);
    expect(String(inspect({ wrapper: derived }))).not.toContain(hex);
    expect(Object.isFrozen(derived)).toBe(true);
  });

  it('entradas inválidas são recusadas', () => {
    expect(() => deriveSubkey(Buffer.alloc(31), QUEUE_KEY_DOMAIN)).toThrow('key_invalid');
    expect(() => deriveSubkey('x'.repeat(64) as never, QUEUE_KEY_DOMAIN)).toThrow('key_invalid');
    for (const domain of ['', 'queue', 'acc:queue', 'ACC:QUEUE:MAC:V1', 'acc:queue:mac:v0', 'acc:queue mac:v1']) {
      expect(() => deriveSubkey(master, domain)).toThrow('key_domain_invalid');
    }
  });
});
