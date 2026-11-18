import { canonicalJson as sharedCanonicalJson, equalHex, namespacedMacHex, sha256Hex, without } from '../storage/canonical.ts';
import type { ErrorFactory } from '../storage/errors.ts';
import { ApprovalError } from './contracts.ts';

/**
 * Serialização canônica e MAC do núcleo de aprovações. Desde a Issue #012 (U4) a implementação
 * fica em `server/storage/canonical.ts`; este módulo mantém a API e o comportamento de antes:
 * mesmos bytes, mesmos MACs e erros `ApprovalError` com os mesmos códigos.
 */
export const approvalErrors: ErrorFactory = {
  create: (code) => new ApprovalError(code),
  is: (error) => error instanceof ApprovalError,
};

/** JSON canônico; recusa com `ApprovalError` (`canonical_*`). */
export function canonicalJson(value: unknown): string {
  return sharedCanonicalJson(value, approvalErrors);
}

export { sha256Hex, equalHex, without };

/** HMAC-SHA256 com separação de domínio (o mesmo conteúdo em documentos diferentes não colide). */
export function macHex(key: Buffer, domain: string, value: unknown): string {
  return namespacedMacHex(key, 'acc-approvals:v1', domain, value, approvalErrors);
}
