import { createHash } from 'node:crypto';
import type { ApprovalVerifier, HumanApproval } from './contracts.ts';

/**
 * Verificador de aprovações SIMULADO (Issue #022), exclusivo para testes.
 *
 * NÃO É UM VERIFICADOR CONFIÁVEL: guarda em memória as aprovações que o próprio teste "emitiu"
 * (`issue`) e reconhece só essas, byte a byte. Serve para exercitar o contrato que o fluxo
 * persistente de aprovações da Issue #011 implementará. Nunca deve ser configurado em produção:
 * nenhum código fora de `server/limits` o importa (teste estrutural).
 */
export interface SimulatedApprovalVerifier extends ApprovalVerifier {
  readonly kind: 'simulated';
  /**
   * Registra a aprovação como emitida. `authenticatedApproverId` é quem de fato aprovou (por
   * padrão, o próprio `approvedBy.id`); um valor diferente simula identidade divergente.
   */
  issue(approval: HumanApproval, authenticatedApproverId?: string): HumanApproval;
}

const digest = (a: HumanApproval) =>
  createHash('sha256')
    .update(JSON.stringify([a.id, a.operation, a.target, a.approvedBy.kind, a.approvedBy.id, a.approvedAt, a.expiresAt]))
    .digest('hex');

export function createSimulatedApprovalVerifier(): SimulatedApprovalVerifier {
  const issued = new Map<string, { digest: string; approverId: string }>();
  return {
    id: 'simulated-approval-verifier',
    kind: 'simulated',
    issue(approval, authenticatedApproverId = approval.approvedBy.id) {
      issued.set(approval.id, { digest: digest(approval), approverId: authenticatedApproverId });
      return approval;
    },
    verify(approval) {
      const record = issued.get(approval.id);
      if (!record) return { authentic: false, reason: 'approval_not_issued' };
      if (record.digest !== digest(approval)) return { authentic: false, reason: 'approval_tampered' };
      return { authentic: true, approverId: record.approverId };
    },
  };
}
