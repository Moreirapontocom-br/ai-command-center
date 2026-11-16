import { createHash } from 'node:crypto';
import type { ApprovalGrant } from '../../shared/contracts.ts';
import type { ApprovalVerifier, HumanApproval } from './contracts.ts';

/**
 * Verificador de aprovações SIMULADO (Issue #022), exclusivo para testes.
 *
 * NÃO É UM VERIFICADOR CONFIÁVEL: guarda em memória as aprovações que o próprio teste "emitiu"
 * (`issue`/`issueGrant`) e reconhece só essas, byte a byte. O verificador real é o da Issue #011
 * (núcleo de aprovações, recibo de uso único). Nunca deve ser configurado em produção:
 * nenhum código fora de `server/limits` o importa (teste estrutural), e os testes do sandbox o usam
 * só como dublê.
 */
export interface SimulatedApprovalVerifier extends ApprovalVerifier {
  readonly kind: 'simulated';
  /**
   * Registra a aprovação como emitida. `authenticatedApproverId` é quem de fato aprovou (por
   * padrão, o próprio `approvedBy.id`); um valor diferente simula identidade divergente.
   */
  issue(approval: HumanApproval, authenticatedApproverId?: string): HumanApproval;
  /** Registra um `ApprovalGrant` da #020 como emitido (mesma semântica de `issue`). */
  issueGrant(grant: ApprovalGrant, authenticatedApproverId?: string): ApprovalGrant;
  verifyGrant(grant: ApprovalGrant): ReturnType<ApprovalVerifier['verify']>;
}

const digest = (a: HumanApproval) =>
  createHash('sha256')
    .update(JSON.stringify([a.id, a.operation, a.target, a.approvedBy.kind, a.approvedBy.id, a.approvedAt, a.expiresAt]))
    .digest('hex');

const grantDigest = (g: ApprovalGrant) =>
  createHash('sha256')
    .update(
      JSON.stringify([g.id, g.method ?? 'approval', g.action, g.projectId, g.resource.type, g.resource.id, g.target.sha, g.target.ref, g.subject.kind, g.subject.id, g.approvedBy.kind, g.approvedBy.id, g.approvedAt, g.expiresAt]),
    )
    .digest('hex');

export function createSimulatedApprovalVerifier(): SimulatedApprovalVerifier {
  const issued = new Map<string, { digest: string; approverId: string }>();
  const grants = new Map<string, { digest: string; approverId: string }>();
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
    issueGrant(grant, authenticatedApproverId = grant.approvedBy.id) {
      grants.set(grant.id, { digest: grantDigest(grant), approverId: authenticatedApproverId });
      return grant;
    },
    verifyGrant(grant) {
      const record = grants.get(grant.id);
      if (!record) return { authentic: false, reason: 'approval_not_issued' };
      if (record.digest !== grantDigest(grant)) return { authentic: false, reason: 'approval_tampered' };
      return { authentic: true, approverId: record.approverId };
    },
  };
}
