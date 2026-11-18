import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { storageErrors, type ErrorFactory } from './errors.ts';

/**
 * Serialização canônica e MAC compartilhados (Issue #012, U4). Extraídos do
 * módulo `canonical` das aprovações sem mudança de bytes: o núcleo de aprovações continua produzindo
 * exatamente os mesmos resumos e MACs (vetores fixos em `storage/compat.test.ts`).
 *
 * Serialização canônica (determinística): chaves ordenadas, sem espaços, somente tipos JSON
 * simples. `undefined`, números não finitos, funções e objetos não planos são recusados (nunca
 * "somem" silenciosamente do resumo).
 */
export function canonicalJson(value: unknown, errors: ErrorFactory = storageErrors): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw errors.create('canonical_invalid_number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, errors)).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw errors.create('canonical_invalid_object');
      const entries = Object.keys(value as object)
        .sort()
        .map((key) => {
          const item = (value as Record<string, unknown>)[key];
          if (item === undefined) throw errors.create('canonical_undefined');
          return `${JSON.stringify(key)}:${canonicalJson(item, errors)}`;
        });
      return `{${entries.join(',')}}`;
    }
    default:
      throw errors.create('canonical_invalid_type');
  }
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * HMAC-SHA256 com separação de domínio: `${namespace}:${domain}\n` + JSON canônico. O mesmo conteúdo
 * em documentos (ou núcleos) diferentes não colide. O núcleo de aprovações usa o namespace
 * `acc-approvals:v1` (formato histórico, inalterado); a fila usa `acc-queue:v1` com subchave própria.
 */
export function namespacedMacHex(key: Buffer, namespace: string, domain: string, value: unknown, errors: ErrorFactory = storageErrors): string {
  return createHmac('sha256', key).update(`${namespace}:${domain}\n`, 'utf8').update(canonicalJson(value, errors), 'utf8').digest('hex');
}

export function equalHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Cópia sem a chave indicada (ex.: o documento sem o próprio `mac`). */
export function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}
