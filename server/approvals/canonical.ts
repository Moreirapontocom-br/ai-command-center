import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApprovalError } from './contracts.ts';

/**
 * Serialização canônica (determinística) para resumos e MACs: chaves ordenadas, sem espaços,
 * somente tipos JSON simples. `undefined`, números não finitos, funções e objetos não planos são
 * recusados (nunca "somem" silenciosamente do resumo).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new ApprovalError('canonical_invalid_number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new ApprovalError('canonical_invalid_object');
      const entries = Object.keys(value as object)
        .sort()
        .map((key) => {
          const item = (value as Record<string, unknown>)[key];
          if (item === undefined) throw new ApprovalError('canonical_undefined');
          return `${JSON.stringify(key)}:${canonicalJson(item)}`;
        });
      return `{${entries.join(',')}}`;
    }
    default:
      throw new ApprovalError('canonical_invalid_type');
  }
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** HMAC-SHA256 com separação de domínio (o mesmo conteúdo em documentos diferentes não colide). */
export function macHex(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(`acc-approvals:v1:${domain}\n`, 'utf8').update(canonicalJson(value), 'utf8').digest('hex');
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
