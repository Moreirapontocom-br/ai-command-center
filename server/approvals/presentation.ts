import { checkPresentation, type PresentationCheck } from '../../shared/approvalPresentation.ts';
import { sha256Hex } from './canonical.ts';
import type { LedgerApproval } from './contracts.ts';

/**
 * Verificação da apresentação (Issue #011, PR 2, correção R1) feita pelo SERVIDOR, com
 * `node:crypto`. É a mesma regra do navegador (`shared/approvalPresentation.ts`); a autoridade é
 * esta. Pedido sem apresentação (ou de um componente sem formato conhecido) → `ok: false`:
 * pode ser rejeitado, nunca aprovado.
 */
export function verifyApprovalPresentation(approval: Pick<LedgerApproval, 'binding' | 'bindingDigest' | 'requestedBy' | 'presentation'>): PresentationCheck {
  return checkPresentation(
    { binding: approval.binding, bindingDigest: approval.bindingDigest, requestedBy: approval.requestedBy, presentation: approval.presentation ?? null },
    sha256Hex,
  );
}
