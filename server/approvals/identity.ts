import { randomBytes } from 'node:crypto';
import { createLoginThrottle } from '../auth/loginThrottle.ts';
import { verifyPassword, type PasswordHash } from '../auth/password.ts';
import { HUMAN_ID, isAgentId } from './binding.ts';
import {
  ApprovalError,
  STEP_UP_LOCK_MS,
  STEP_UP_MAX_FAILURES,
  STEP_UP_TTL_MS,
  type ConfirmationMethod,
} from './contracts.ts';

/**
 * Confirmação de identidade (D8/N5/R4).
 *
 * - A identidade vem SEMPRE da sessão autenticada (`userId` e `sessionKey`, que é o SHA-256 do
 *   token da sessão, calculado pela camada HTTP no PR 2). Nada no corpo de uma requisição, nenhum
 *   agente e nenhum componente do servidor consegue declarar uma identidade humana.
 * - Uma prova de *step-up* só nasce de uma confirmação bem-sucedida (senha, nesta fase), vale no
 *   máximo 5 minutos, fica presa à sessão que a obteve e é de USO ÚNICO.
 * - Cinco falhas bloqueiam novas confirmações por 15 minutos (limitador da #003 reutilizado).
 * - Provas ficam só em memória: reiniciar o servidor invalida todas.
 */

export interface IdentityContext {
  userId: string;
  /** SHA-256 (hex) do token da sessão autenticada. */
  sessionKey: string;
}

export interface IdentityConfirmer {
  readonly method: ConfirmationMethod;
  /** `true` só se o segredo confirma ESTE usuário. Nunca lança por segredo errado. */
  confirm(ctx: IdentityContext, secret: string): Promise<boolean>;
}

/** Confirmação por senha do administrador (reutiliza `verifyPassword`/scrypt da #003). */
export function createPasswordConfirmer(admin: { userId: string; passwordHash: PasswordHash } | null): IdentityConfirmer {
  return {
    method: 'password',
    async confirm(ctx, secret) {
      if (!admin || ctx.userId !== admin.userId || typeof secret !== 'string') return false;
      return verifyPassword(secret, admin.passwordHash);
    },
  };
}

export interface StepUpConfirmation {
  method: ConfirmationMethod;
  at: string;
}

export interface StepUpRegistry {
  /** Confirma a identidade e emite uma prova de uso único (≤ 5 min) presa à sessão. */
  confirm(ctx: IdentityContext, method: ConfirmationMethod, secret: string): Promise<{ proofId: string; expiresAt: string }>;
  /** Consome a prova (uso único). Lança se ausente, vencida, de outra sessão ou outro usuário. */
  consume(proofId: string, ctx: IdentityContext): StepUpConfirmation;
  /** Invalida as provas de uma sessão (ex.: logout). */
  revokeSession(sessionKey: string): void;
}

const SESSION_KEY = /^[0-9a-f]{64}$/;
const PROOF_ID = /^[A-Za-z0-9_-]{43}$/;
const MAX_PROOFS = 64;

interface Proof {
  userId: string;
  sessionKey: string;
  method: ConfirmationMethod;
  issuedAt: number;
  expiresAt: number;
}

export function assertHumanContext(ctx: IdentityContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.userId !== 'string' ||
    !HUMAN_ID.test(ctx.userId) ||
    isAgentId(ctx.userId) ||
    typeof ctx.sessionKey !== 'string' ||
    !SESSION_KEY.test(ctx.sessionKey)
  ) {
    throw new ApprovalError('identity_invalid');
  }
}

export function createStepUpRegistry(options: { confirmers: IdentityConfirmer[]; now?: () => number }): StepUpRegistry {
  const now = options.now ?? Date.now;
  const confirmers = new Map(options.confirmers.map((c) => [c.method, c]));
  const proofs = new Map<string, Proof>();
  const throttle = createLoginThrottle({
    windowMs: STEP_UP_LOCK_MS,
    lockMs: STEP_UP_LOCK_MS,
    perClientLimit: STEP_UP_MAX_FAILURES,
    globalLimit: STEP_UP_MAX_FAILURES,
    now,
  });

  const sweep = () => {
    const at = now();
    for (const [id, proof] of proofs) if (proof.expiresAt <= at) proofs.delete(id);
  };

  return {
    async confirm(ctx, method, secret) {
      assertHumanContext(ctx);
      const confirmer = confirmers.get(method);
      if (!confirmer) throw new ApprovalError('confirmation_method_unavailable');
      const gate = throttle.check(ctx.userId);
      if (!gate.allowed) throw new ApprovalError('step_up_locked');
      let ok: boolean;
      try {
        ok = await confirmer.confirm(ctx, secret);
      } catch {
        ok = false;
      }
      if (!ok) {
        throttle.recordFailure(ctx.userId);
        throw new ApprovalError('step_up_failed');
      }
      throttle.recordSuccess(ctx.userId);
      sweep();
      // Uma prova pendente por sessão: confirmar de novo substitui a anterior.
      for (const [id, proof] of proofs) if (proof.sessionKey === ctx.sessionKey) proofs.delete(id);
      if (proofs.size >= MAX_PROOFS) throw new ApprovalError('step_up_capacity');
      const proofId = randomBytes(32).toString('base64url');
      const issuedAt = now();
      proofs.set(proofId, { userId: ctx.userId, sessionKey: ctx.sessionKey, method, issuedAt, expiresAt: issuedAt + STEP_UP_TTL_MS });
      return { proofId, expiresAt: new Date(issuedAt + STEP_UP_TTL_MS).toISOString() };
    },
    consume(proofId, ctx) {
      assertHumanContext(ctx);
      if (typeof proofId !== 'string' || !PROOF_ID.test(proofId)) throw new ApprovalError('step_up_required');
      const proof = proofs.get(proofId);
      // Removida já na primeira tentativa, válida ou não: uma prova nunca é aceita duas vezes.
      proofs.delete(proofId);
      if (!proof) throw new ApprovalError('step_up_required');
      if (proof.userId !== ctx.userId || proof.sessionKey !== ctx.sessionKey) throw new ApprovalError('step_up_session_mismatch');
      if (now() >= proof.expiresAt) throw new ApprovalError('step_up_expired');
      return { method: proof.method, at: new Date(proof.issuedAt).toISOString() };
    },
    revokeSession(sessionKey) {
      for (const [id, proof] of proofs) if (proof.sessionKey === sessionKey) proofs.delete(id);
    },
  };
}
