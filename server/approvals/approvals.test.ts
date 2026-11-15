// @vitest-environment node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, link as hardLink, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { POLICY_ACTIONS, type PolicyAction } from '../../shared/contracts.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { DEFAULT_LIMITS } from '../limits/contracts.ts';
import { createLimitsController } from '../limits/controller.ts';
import { limitsFingerprint } from '../limits/validation.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { evaluatePolicy } from '../policy/engine.ts';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import { writeFileAtomic, type WriteFile } from '../storage/jsonFile.ts';
import { TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { bindingDigest, paramsDigestOf } from './binding.ts';
import { canonicalJson, macHex, without } from './canonical.ts';
import { APPROVAL_TRANSITIONS, ApprovalError, ATTEMPT_TRANSITIONS, classOf, type ApprovalBinding } from './contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from './identity.ts';
import { createEnvKeyProvider, createFileKeyProvider } from './keyProvider.ts';
import { acquireStoreLock, LOCK_FILE, processAlive, TAKEOVER_FILE } from './lock.ts';
import { createApprovalService } from './service.ts';
import { ANCHOR_FILE, HISTORY_FILE, INSTALL_FILE, LEDGER_FILE, listQuarantine, MANIFEST_FILE, openApprovalStore, writeBytesAtomic, type ApprovalStore, type WriteBytes } from './store.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P2 = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const START = Date.parse('2026-11-15T12:00:00Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const VERSION = DEFAULT_POLICY.version;
const sessionKey = (name: string) => createHash('sha256').update(name).digest('hex');
const CTX: IdentityContext = { userId: 'admin', sessionKey: sessionKey('session-a') };

const roots: string[] = [];
const stores: ApprovalStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const agentBinding = (overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
  action: 'sandbox.execute',
  projectId: P1,
  resource: { type: 'sandbox', id: 'sb-1' },
  target: { sha: null, ref: null },
  subject: { kind: 'agent', id: 'claude-code' },
  paramsDigest: 'spec:abc',
  policyVersion: VERSION,
  ...overrides,
});
const mergeBinding = (sha = SHA_A): ApprovalBinding =>
  agentBinding({ action: 'repo.merge', resource: { type: 'pull_request', id: 'acc#99' }, target: { sha, ref: 'feature/x' } });
const ownerBinding = (action: ApprovalBinding['action'], paramsDigest: string, resource = { type: 'limits', id: 'controller' }, projectId: string | null = null): ApprovalBinding => ({
  action,
  projectId,
  resource,
  target: { sha: null, ref: null },
  subject: { kind: 'human', id: 'admin' },
  paramsDigest,
  policyVersion: VERSION,
});
const releaseBinding = (scope: string = 'global') =>
  ownerBinding('killswitch.release', paramsDigestOf('killswitch.release', { scope }), { type: 'killswitch', id: scope }, scope === 'global' ? null : scope);

async function setup(opts: { key?: string; writeFile?: WriteFile; writeBytes?: WriteBytes; env?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acc-approvals-'));
  roots.push(root);
  const clock = { wall: START, mono: 1_000 };
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  const key = opts.key ?? randomBytes(32).toString('hex');
  const dirs = { approvalsDir: join(root, 'ledger'), anchorDir: join(root, 'anchor') };
  const open = (o: { key?: string; writeFile?: WriteFile; initialize?: 'never' | 'if_absent' } = {}) =>
    openApprovalStore({
      ...dirs,
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: o.key ?? key }),
      environment: { env: opts.env ?? {} },
      initialize: o.initialize ?? 'never',
      now: () => clock.wall,
      writeFile: o.writeFile ?? opts.writeFile,
      writeBytes: opts.writeBytes,
    }).then((store) => {
      stores.push(store);
      return store;
    });
  const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now: () => clock.wall });
  const service = (store: ApprovalStore, extra: { policyVersion?: string; controllerKillSwitch?: (p: string | null) => boolean } = {}) =>
    createApprovalService({ store, identity, policyVersion: extra.policyVersion ?? VERSION, controllerKillSwitch: extra.controllerKillSwitch, now: () => clock.wall, monotonicNow: () => clock.mono });
  const proof = async (ctx: IdentityContext = CTX) => (await identity.confirm(ctx, 'password', TEST_ADMIN_PASSWORD)).proofId;
  const store = await open({ initialize: 'if_absent' });
  const svc = service(store);
  /** Libera uma barreira global com confirmação do PO (componente interno). */
  const releaseGlobal = async (s = svc) => {
    const binding = releaseBinding('global');
    const release = await s.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await proof(), identity: CTX });
    const r = await s.reserve({ ownerId: 'admin', approvalId: release.id, component: 'approvals', binding });
    await s.releaseBarrier({ attemptId: r.attemptId });
  };
  // Toda instalação nova começa com barreira global (R2 da revisão): liberada aqui para os testes.
  expect(svc.barriers().durable.global).toMatchObject({ reason: 'initial_install' });
  await releaseGlobal();
  /** Pedido + aprovação pelo PO. */
  const approved = async (binding: ApprovalBinding = agentBinding(), s = svc) => {
    const request = await s.request({ ownerId: 'admin', requestedBy: 'sandbox', binding });
    return s.decide({ ownerId: 'admin', approvalId: request.id, decision: 'approve', bindingDigest: request.bindingDigest, proofId: await proof(), identity: CTX });
  };
  const close = async (s: ApprovalStore) => {
    await s.close();
    stores.splice(stores.indexOf(s), 1);
  };
  return { root, dirs, key, clock, advance, open, close, identity, service, proof, store, svc, approved, releaseGlobal };
}

const events = (store: ApprovalStore) => store.history().items.flatMap((i) => (i.kind === 'entry' ? [i.event] : []));
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ApprovalError ? error.code : `unexpected:${(error as Error).message}`;
  }
};
/** Catálogo de TESTE da #020: sandbox e merge "existem". No real continuam indisponíveis. */
const testCatalog = {
  ...POLICY_ACTIONS,
  'sandbox.execute': { ...POLICY_ACTIONS['sandbox.execute'], available: true },
  'repo.merge': { ...POLICY_ACTIONS['repo.merge'], available: true },
};

describe('contratos e máquina de estados', () => {
  it('classes, TTLs e ações nunca aprováveis', () => {
    expect(classOf('sandbox.execute')).toBe('execution');
    expect(classOf('tool.use')).toBe('execution');
    expect(classOf('repo.merge')).toBe('merge');
    expect(classOf('deploy.publish')).toBe('publication');
    expect(classOf('spend.create')).toBe('cost');
    expect(classOf('limits.change')).toBe('configuration');
    expect(classOf('killswitch.release')).toBe('configuration');
    expect(classOf('repo.push_main')).toBeNull();
    expect(classOf('anything.else')).toBeNull();
  });

  it('estados terminais não têm saída; tentativa só se encerra uma vez', () => {
    for (const state of ['rejected', 'withdrawn', 'expired', 'superseded', 'consumed', 'revoked'] as const) expect(APPROVAL_TRANSITIONS[state]).toEqual([]);
    expect(APPROVAL_TRANSITIONS.approved).not.toContain('pending');
    expect(ATTEMPT_TRANSITIONS.indeterminate).toEqual(['acknowledged_by_owner']);
    expect(ATTEMPT_TRANSITIONS.failed).toEqual([]);
  });

  it('binding canônico: determinístico e sensível a qualquer campo', () => {
    const a = agentBinding();
    const reordered = { policyVersion: a.policyVersion, paramsDigest: a.paramsDigest, subject: a.subject, target: a.target, resource: a.resource, projectId: a.projectId, action: a.action };
    expect(bindingDigest(reordered as ApprovalBinding)).toBe(bindingDigest(a));
    expect(bindingDigest(agentBinding({ paramsDigest: 'spec:abd' }))).not.toBe(bindingDigest(a));
    expect(bindingDigest(mergeBinding(SHA_B))).not.toBe(bindingDigest(mergeBinding(SHA_A)));
  });

  it('execução real continua desligada e as capacidades críticas indisponíveis', () => {
    expect(REAL_EXECUTION_ENABLED).toBe(false);
    for (const action of Object.keys(POLICY_ACTIONS) as PolicyAction[]) if (POLICY_ACTIONS[action].critical) expect(POLICY_ACTIONS[action].available).toBe(false);
  });
});

describe('fluxo de aprovação', () => {
  it('aprovação legítima: pedido → decisão → reserva → recibo → resultado', async () => {
    const t = await setup();
    const approval = await t.approved();
    expect(approval.state).toBe('approved');
    expect(approval.decidedBy).toEqual({ kind: 'human', id: 'admin' });
    expect(approval.confirmation?.method).toBe('password');
    expect(Date.parse(approval.validUntil!) - START).toBe(60 * MIN);
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding() });
    expect(r.grant).not.toBeNull();
    const evaluation = evaluatePolicy(
      DEFAULT_POLICY,
      { subject: { kind: 'agent', id: 'claude-code' }, action: 'sandbox.execute', projectId: P1, resource: { type: 'sandbox', id: 'sb-1' }, target: { sha: null, ref: null }, approval: r.grant },
      { projectAccessible: true, agentAssigned: true, now: START, usedApprovals: t.svc.consumedApprovalIds(r.approvalId) },
      testCatalog,
    );
    expect(evaluation).toMatchObject({ decision: 'ALLOW', approvalId: approval.id });
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!)).toEqual({ authentic: true, approverId: 'admin' });
    const done = await t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' });
    expect(done.state).toBe('succeeded');
    expect(events(t.store)).toEqual(expect.arrayContaining(['approval.requested', 'approval.approved', 'approval.consumed', 'approval.attempt_succeeded']));
  });

  it('rejeição explícita bloqueia; decisão é única', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    const rejected = await t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'reject', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX });
    expect(rejected.state).toBe('rejected');
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('already_decided');
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: req.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_rejected');
  });

  it('aprova-se exatamente o que foi exibido (bindingDigest divergente é recusado)', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: bindingDigest(agentBinding({ paramsDigest: 'spec:other' })), proofId: await t.proof(), identity: CTX }))).toBe('binding_mismatch');
    expect(events(t.store)).toContain('approval.decision_denied');
  });

  it('pedido idêntico é idempotente; pedido da mesma operação com outro SHA substitui o anterior', async () => {
    const t = await setup();
    const a = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: mergeBinding(SHA_A) });
    const again = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: mergeBinding(SHA_A) });
    expect(again.id).toBe(a.id);
    const b = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: mergeBinding(SHA_B) });
    expect(b.id).not.toBe(a.id);
    expect(t.svc.list('admin').find((x) => x.id === a.id)!.state).toBe('superseded');
  });

  it('vínculo inválido: SHA obrigatório no merge, push na main nunca aprovável, campos extras recusados', async () => {
    const t = await setup();
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: { ...mergeBinding(), target: { sha: null, ref: 'feature/x' } } }))).toBe('missing_sha');
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding({ action: 'repo.push_main' }) }))).toBe('action_not_approvable');
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: { ...agentBinding(), approvedBy: { kind: 'human', id: 'admin' } } }))).toBe('invalid_binding');
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding({ projectId: null }) }))).toBe('invalid_binding');
  });
});

describe('autenticidade, identidade e autoaprovação', () => {
  it('aprovação forjada pelo chamador (sem recibo) não é autêntica', async () => {
    const t = await setup();
    const forged = { id: '9f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', action: 'sandbox.execute' as const, projectId: P1, resource: { type: 'sandbox', id: 'sb-1' }, target: { sha: null, ref: null }, subject: { kind: 'agent' as const, id: 'claude-code' as const }, approvedBy: { kind: 'human' as const, id: 'admin' }, approvedAt: new Date(START).toISOString(), expiresAt: new Date(START + MIN).toISOString() };
    expect(t.svc.verifierFor('sandbox').verifyGrant(forged)).toEqual({ authentic: false, reason: 'receipt_missing' });
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: forged.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_not_issued');
  });

  it('objeto adulterado após a reserva é recusado e invalida o recibo', async () => {
    const t = await setup();
    const approval = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding() });
    const tampered = { ...r.grant!, resource: { type: 'sandbox', id: 'sb-2' } };
    expect(t.svc.verifierFor('sandbox').verifyGrant(tampered)).toEqual({ authentic: false, reason: 'receipt_operation_mismatch' });
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!)).toEqual({ authentic: false, reason: 'receipt_missing' });
  });

  it('prova de step-up: senha errada, bloqueio após 5 falhas, uso único, outra sessão, validade de 5 min', async () => {
    const t = await setup();
    expect(await code(t.identity.confirm(CTX, 'password', 'senha-errada-123'))).toBe('step_up_failed');
    const other: IdentityContext = { userId: 'admin', sessionKey: sessionKey('session-b') };
    const p = await t.proof();
    expect(() => t.identity.consume(p, other)).toThrow('step_up_session_mismatch');
    expect(() => t.identity.consume(p, CTX)).toThrow('step_up_required'); // já consumida na tentativa anterior
    const late = await t.proof();
    t.advance(5 * MIN);
    expect(() => t.identity.consume(late, CTX)).toThrow('step_up_expired');
    for (let i = 0; i < 4; i += 1) await code(t.identity.confirm(CTX, 'password', 'senha-errada-123'));
    expect(await code(t.identity.confirm(CTX, 'password', TEST_ADMIN_PASSWORD))).toBe('step_up_locked');
    t.advance(15 * MIN);
    expect(await code(t.identity.confirm(CTX, 'password', TEST_ADMIN_PASSWORD))).toBe('resolved');
  });

  it('identidade divergente e agentes: nunca decidem, nunca confirmam como PO', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    const otherUser: IdentityContext = { userId: 'someone', sessionKey: sessionKey('x') };
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: otherUser }))).toBe('identity_mismatch');
    const agent: IdentityContext = { userId: 'claude-code', sessionKey: sessionKey('agent') };
    expect(await code(t.identity.confirm(agent, 'password', TEST_ADMIN_PASSWORD))).toBe('identity_invalid');
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: 'x'.repeat(43), identity: agent }))).toBe('identity_invalid');
    // Pedido com sujeito humano não existe pela via de componentes: só `confirmOwner`.
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: ownerBinding('limits.change', limitsFingerprint(DEFAULT_LIMITS)) }))).toBe('use_owner_confirmation');
    // Operação de configuração do ACC com sujeito agente: recusada.
    const agentLimits = { ...ownerBinding('limits.change', limitsFingerprint(DEFAULT_LIMITS)), subject: { kind: 'agent' as const, id: 'claude-code' as const }, projectId: P1 };
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentLimits }))).toBe('use_owner_confirmation');
    // Sem prova, nada é decidido.
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: 'x'.repeat(43), identity: CTX }))).toBe('step_up_required');
  });

  it('confirmação do PO (D2): só para operação dele, não-execução, com prova; agente não usa', async () => {
    const t = await setup();
    const limits = { ...DEFAULT_LIMITS, maxConcurrent: 2 };
    const binding = ownerBinding('limits.change', limitsFingerprint(limits));
    const ok = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    expect(ok).toMatchObject({ state: 'approved', method: 'owner_confirmation', class: 'configuration' });
    expect(Date.parse(ok.validUntil!) - START).toBe(15 * MIN);
    expect(await code(t.svc.confirmOwner({ ownerId: 'admin', binding: { ...agentBinding(), subject: { kind: 'human', id: 'admin' }, projectId: P1 }, bindingDigest: 'x', proofId: await t.proof(), identity: CTX }))).toBe('invalid_owner_confirmation');
    const agentSubject = mergeBinding();
    expect(await code(t.svc.confirmOwner({ ownerId: 'admin', binding: agentSubject, bindingDigest: bindingDigest(agentSubject), proofId: await t.proof(), identity: CTX }))).toBe('invalid_owner_confirmation');
  });

  it('#020: owner_confirmation só vale com o id atestado pelo servidor; sujeito agente nunca', () => {
    const grant = { id: '5f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', method: 'owner_confirmation' as const, action: 'repo.merge' as const, projectId: P1, resource: { type: 'pull_request', id: 'acc#1' }, target: { sha: SHA_A, ref: 'f' }, subject: { kind: 'human' as const, id: 'admin' }, approvedBy: { kind: 'human' as const, id: 'admin' }, approvedAt: new Date(START).toISOString(), expiresAt: new Date(START + MIN).toISOString() };
    const request = { subject: grant.subject, action: 'repo.merge', projectId: P1, resource: grant.resource, target: grant.target, approval: grant };
    const facts = { projectAccessible: true, agentAssigned: false, now: START, usedApprovals: new Set<string>() };
    expect(evaluatePolicy(DEFAULT_POLICY, request, facts, testCatalog).reason).toBe('approval_invalid');
    expect(evaluatePolicy(DEFAULT_POLICY, request, { ...facts, verifiedOwnerConfirmationId: 'other' }, testCatalog).reason).toBe('approval_invalid');
    expect(evaluatePolicy(DEFAULT_POLICY, request, { ...facts, verifiedOwnerConfirmationId: grant.id }, testCatalog).decision).toBe('ALLOW');
    // Sem catálogo de teste, merge continua INDISPONÍVEL mesmo aprovado.
    expect(evaluatePolicy(DEFAULT_POLICY, request, { ...facts, verifiedOwnerConfirmationId: grant.id }).decision).toBe('UNAVAILABLE');
    const agentRequest = { ...request, subject: { kind: 'agent' as const, id: 'claude-code' as const }, approval: { ...grant, subject: { kind: 'agent' as const, id: 'claude-code' as const } } };
    expect(evaluatePolicy(DEFAULT_POLICY, agentRequest, { ...facts, agentAssigned: true, verifiedOwnerConfirmationId: grant.id }, testCatalog).reason).toBe('approval_invalid');
    // Grant sem `method` (formato antigo) continua com a regra de não autoaprovação.
    const legacy = { ...grant, method: undefined };
    expect(evaluatePolicy(DEFAULT_POLICY, { ...request, approval: legacy }, { ...facts, verifiedOwnerConfirmationId: grant.id }, testCatalog).reason).toBe('approval_invalid');
  });
});

describe('vínculo: SHA, parâmetros, política e validade', () => {
  it('SHA alterado após a aprovação → superseded, sem consumo', async () => {
    const t = await setup();
    const approval = await t.approved(mergeBinding(SHA_A));
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'policy', binding: mergeBinding(SHA_B) }))).toBe('binding_changed');
    expect(t.svc.list('admin').at(-1)!.state).toBe('superseded');
  });

  it('parâmetros alterados → superseded', async () => {
    const t = await setup();
    const approval = await t.approved();
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding({ paramsDigest: 'spec:changed' }) }))).toBe('binding_changed');
  });

  it('política alterada → versão recusada e aprovação antiga deixa de valer', async () => {
    const t = await setup();
    const approval = await t.approved();
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding({ policyVersion: 'other' }) }))).toBe('policy_version_mismatch');
    // Política nova = código novo = outra instância do serviço: a aprovação antiga não tem prazo
    // monotônico nesta instância e expira (mais restritivo que `binding_changed`).
    const newer = t.service(t.store, { policyVersion: '2099-01-01.1' });
    expect(await code(newer.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding({ policyVersion: '2099-01-01.1' }) }))).toBe('approval_expired');
    // Na mesma instância, o vínculo com outra versão difere do aprovado.
    expect(bindingDigest(agentBinding({ policyVersion: '2099-01-01.1' }))).not.toBe(approval.bindingDigest);
  });

  it('expirada (1 h) e pendente (24 h)', async () => {
    const t = await setup();
    const approval = await t.approved();
    t.advance(60 * MIN);
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_expired');
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-9' } }) });
    t.advance(24 * 60 * MIN);
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('approval_expired');
  });

  it('voltar o relógio do sistema não estende a validade (prazo monotônico)', async () => {
    const t = await setup();
    const approval = await t.approved();
    t.clock.mono += 61 * MIN; // tempo real passou…
    t.clock.wall -= 2 * 60 * MIN; // …mas o relógio de parede foi atrasado.
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_expired');
  });

  it('revogada não pode ser consumida; revogar o que já foi consumido é transição inválida e auditada', async () => {
    const t = await setup();
    const a = await t.approved();
    await t.svc.revoke({ ownerId: 'admin', approvalId: a.id, proofId: await t.proof(), identity: CTX });
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_revoked');
    const b = await t.approved(agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }));
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: b.id, component: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }) });
    t.svc.verifierFor('sandbox').verifyGrant(r.grant!);
    await t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' });
    expect(await code(t.svc.revoke({ ownerId: 'admin', approvalId: b.id, proofId: await t.proof(), identity: CTX }))).toBe('invalid_transition');
    expect(events(t.store)).toContain('approval.transition_denied');
  });
});

describe('consumo único, recibos e concorrência (R1)', () => {
  it('reutilização é recusada, inclusive após reinício', async () => {
    const t = await setup();
    const a = await t.approved();
    await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_already_used');
    await t.close(t.store);
    const store = await t.open();
    expect(await code(t.service(store).reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_already_used');
  });

  it('dez consumos concorrentes: exatamente um vence', async () => {
    const t = await setup();
    const a = await t.approved();
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('decisões concorrentes: uma vence, a outra é recusada', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    const ctxB: IdentityContext = { userId: 'admin', sessionKey: sessionKey('session-b') };
    const [pa, pb] = [await t.proof(CTX), await t.proof(ctxB)];
    const results = await Promise.allSettled([
      t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: pa, identity: CTX }),
      t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'reject', bindingDigest: req.bindingDigest, proofId: pb, identity: ctxB }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('recibo expira em 30 s; a tentativa vira failed e a aprovação continua consumida', async () => {
    const t = await setup();
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    t.advance(31 * 1000);
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!)).toEqual({ authentic: false, reason: 'receipt_expired' });
    await t.svc.sweep();
    expect(t.store.ledger().attempts.at(-1)!).toMatchObject({ state: 'failed', reason: 'receipt_expired' });
    expect(await code(t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' }))).toBe('receipt_not_validated');
    expect(await code(t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'failed' }))).toBe('invalid_transition');
  });

  it('recibo usado por outro componente é recusado e inutilizado', async () => {
    const t = await setup();
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    expect(t.svc.verifierFor('policy').verifyGrant(r.grant!)).toEqual({ authentic: false, reason: 'receipt_wrong_component' });
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!)).toEqual({ authentic: false, reason: 'receipt_missing' });
    expect(() => t.svc.verifierFor('approvals')).toThrow('invalid_component');
  });

  it('succeeded exige recibo validado; o recibo vale uma única vez', async () => {
    const t = await setup();
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    expect(await code(t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' }))).toBe('receipt_not_validated');
    const v = t.svc.verifierFor('sandbox');
    expect(v.verifyGrant(r.grant!).authentic).toBe(true);
    expect(v.verifyGrant(r.grant!)).toEqual({ authentic: false, reason: 'receipt_missing' });
  });

  it('revogação durante a tentativa invalida o recibo', async () => {
    const t = await setup();
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    await t.svc.revoke({ ownerId: 'admin', approvalId: a.id, proofId: await t.proof(), identity: CTX });
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!).authentic).toBe(false);
    expect(t.store.ledger().attempts.at(-1)!).toMatchObject({ state: 'failed', reason: 'revoked' });
  });

  it('falha antes da reserva não consome (pré-checagem recusada mantém approved)', async () => {
    const t = await setup();
    const a = await t.approved();
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: { bogus: true } }))).toBe('invalid_binding');
    expect(t.svc.list('admin').at(-1)!.state).toBe('approved');
  });
});

describe('persistência, reinício e recuperação (R2)', () => {
  it('reinício: nova época, concedidas expiram (N1), pendentes sobrevivem, reservadas viram indeterminate', async () => {
    const t = await setup();
    const epoch = t.store.epoch();
    const a = await t.approved();
    const b = await t.approved(agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }));
    await t.svc.reserve({ ownerId: 'admin', approvalId: b.id, component: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }) });
    const pending = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-3' } }) });
    await t.close(t.store);
    const store = await t.open();
    const svc = t.service(store);
    expect(store.epoch()).toBe(epoch + 1);
    const byId = new Map(svc.list('admin').map((x) => [x.id, x]));
    expect(byId.get(a.id)).toMatchObject({ state: 'expired', closedReason: 'instance_restart' });
    expect(byId.get(pending.id)!.state).toBe('pending');
    const attempt = store.ledger().attempts.at(-1)!;
    expect(attempt.state).toBe('indeterminate');
    // Sem repetição automática: só o PO reconhece, e nada é reexecutado.
    await svc.acknowledgeAttempt({ ownerId: 'admin', attemptId: attempt.id, proofId: await t.proof(), identity: CTX });
    expect(store.ledger().attempts.at(-1)!.state).toBe('acknowledged_by_owner');
    expect(await code(svc.reserve({ ownerId: 'admin', approvalId: b.id, component: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }) }))).toBe('approval_already_used');
    const decided = await svc.decide({ ownerId: 'admin', approvalId: pending.id, decision: 'approve', bindingDigest: pending.bindingDigest, proofId: await t.proof(), identity: CTX });
    expect(decided.epoch).toBe(epoch + 1);
  });

  it('falha de escrita: nada muda em memória, armazenamento degradado, tudo negado até reiniciar', async () => {
    let failLedger = false;
    const t = await setup({ writeFile: (path, content) => (failLedger && path.endsWith(LEDGER_FILE) ? Promise.reject(new Error('disk')) : writeFileAtomic(path, content)) });
    const a = await t.approved();
    failLedger = true;
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('store_write_failed');
    expect(t.svc.status()).toEqual({ state: 'degraded', reason: 'write_failed' });
    expect(t.svc.list('admin').at(-1)!.state).toBe('approved');
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('store_degraded');
    failLedger = false;
    await t.close(t.store);
    const store = await t.open();
    // Histórico gravado à frente do ledger (queda entre os dois): marcado como não aplicado.
    expect(events(store)).toContain('approval.history_unapplied');
    expect(t.service(store).list('admin').at(-1)!).toMatchObject({ state: 'expired', closedReason: 'instance_restart' });
  });

  it('queda entre ledger e anchor: o ledger uma geração à frente e encadeado é aceito', async () => {
    let failAnchor = false;
    const t = await setup({ writeFile: (path, content) => (failAnchor && path.endsWith(ANCHOR_FILE) ? Promise.reject(new Error('disk')) : writeFileAtomic(path, content)) });
    const a = await t.approved();
    failAnchor = true;
    await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }));
    failAnchor = false;
    await t.close(t.store);
    const store = await t.open();
    expect(store.status().state).toBe('available');
    // A reserva gravada no ledger prevalece: a aprovação está consumida (tentativa indeterminada).
    expect(t.service(store).list('admin').at(-1)!.state).toBe('consumed');
    expect(store.ledger().attempts.at(-1)!.state).toBe('indeterminate');
  });

  it('ledger corrompido, estado desconhecido ou MAC inválido → indisponível; arquivos preservados', async () => {
    const t = await setup();
    await t.approved();
    await t.close(t.store);
    const path = join(t.dirs.approvalsDir, LEDGER_FILE);
    const original = await readFile(path, 'utf8');
    const doc = JSON.parse(original);
    // 1) adulterado sem a chave → MAC inválido
    await writeFile(path, JSON.stringify({ ...doc, approvals: [{ ...doc.approvals[0], state: 'pending' }] }));
    let store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'document_invalid' });
    await t.close(store);
    await writeFile(path, JSON.stringify({ ...doc, approvals: [{ ...doc.approvals[0], ownerId: 'other' }] }));
    store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'mac_invalid' });
    await t.close(store);
    // 2) estado desconhecido, mesmo re-assinado com a chave → formato inválido
    const unknown = { ...doc, approvals: [{ ...doc.approvals[0], state: 'zombie' }] };
    await writeFile(path, JSON.stringify({ ...unknown, mac: macHex(Buffer.from(t.key, 'hex'), 'ledger', without(unknown, 'mac')) }));
    store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'document_invalid' });
    expect(await code(t.service(store).reserve({ ownerId: 'admin', approvalId: doc.approvals[0].id, component: 'sandbox', binding: agentBinding() }))).toBe('store_unavailable');
    await t.close(store);
    // 3) JSON ilegível
    await writeFile(path, '{"truncad');
    store = await t.open();
    expect(store.status().state).toBe('unavailable');
    expect(await readFile(path, 'utf8')).toBe('{"truncad');
  });

  it('anchor ausente ou divergente → indisponível', async () => {
    const t = await setup();
    await t.approved();
    await t.close(t.store);
    const anchor = join(t.dirs.anchorDir, ANCHOR_FILE);
    const saved = await readFile(anchor, 'utf8');
    await rm(anchor);
    let store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'anchor_missing' });
    await t.close(store);
    const doc = JSON.parse(saved);
    const diverged = { ...doc, ledger: { ...doc.ledger, head: 'f'.repeat(64) } };
    await writeFile(anchor, canonicalJson({ ...diverged, mac: macHex(Buffer.from(t.key, 'hex'), 'anchor', without(diverged, 'mac')) }));
    store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'ledger_anchor_mismatch' });
  });

  it('rollback (R6): ledger antigo → bloqueado; histórico antigo → bloqueado; os três restaurados → aprovações antigas inutilizáveis', async () => {
    const t = await setup();
    const a = await t.approved();
    const snap = join(t.root, 'snapshot');
    await mkdir(snap);
    const files = { ledger: join(t.dirs.approvalsDir, LEDGER_FILE), history: join(t.dirs.approvalsDir, HISTORY_FILE), anchor: join(t.dirs.anchorDir, ANCHOR_FILE) };
    // Snapshot com a aprovação ainda "approved" (HMAC válido).
    for (const [name, file] of Object.entries(files)) await copyFile(file, join(snap, name));
    await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    await t.close(t.store);
    const current = { ledger: await readFile(files.ledger), history: await readFile(files.history), anchor: await readFile(files.anchor) };

    await copyFile(join(snap, 'ledger'), files.ledger);
    let store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'ledger_rollback' });
    await t.close(store);
    await writeFile(files.ledger, current.ledger);

    await copyFile(join(snap, 'history'), files.history);
    store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'history_rollback' });
    await t.close(store);
    await writeFile(files.history, current.history);

    // Os três restaurados juntos (indetectável localmente): a época nova invalida o que estava aprovado.
    for (const [name, file] of Object.entries(files)) await copyFile(join(snap, name), file);
    store = await t.open();
    expect(store.status().state).toBe('available');
    expect(await code(t.service(store).reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_expired');
  });

  it('chave indisponível, inválida ou diferente → indisponível (nega tudo)', async () => {
    const t = await setup();
    await t.close(t.store);
    let store = await t.open({ key: '' });
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'key_unavailable' });
    await t.close(store);
    store = await t.open({ key: 'abcd' });
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'key_invalid' });
    await t.close(store);
    store = await t.open({ key: randomBytes(32).toString('hex') });
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'key_mismatch' });
    const svc = t.service(store);
    expect(svc.verifierFor('limits').verify({ id: 'x', operation: 'limits.change', target: 't', approvedBy: { kind: 'human', id: 'admin' }, approvedAt: '', expiresAt: '' })).toEqual({ authentic: false, reason: 'store_unavailable' });
  });

  it('chave em arquivo: link simbólico recusado', async () => {
    const t = await setup();
    const keyDir = join(t.root, 'keys');
    await mkdir(keyDir);
    const real = join(keyDir, 'key.txt');
    await writeFile(real, randomBytes(32).toString('hex'), { mode: 0o600 });
    expect((await createFileKeyProvider(real, { env: {} }).load()).keyId).toMatch(/^[0-9a-f]{16}$/);
    const link = join(keyDir, 'link.txt');
    try {
      await symlink(real, link, 'file');
    } catch {
      return; // Sem permissão para criar links simbólicos de arquivo neste sistema.
    }
    expect(await code(createFileKeyProvider(link, { env: {} }).load())).toBe('file_is_link');
  });

  it('escritor único: segunda instância recusada; bloqueio abandonado é retomado e registrado', async () => {
    const t = await setup();
    const second = await t.open();
    expect(second.status()).toEqual({ state: 'unavailable', reason: 'store_locked' });
    await t.close(second);
    await t.close(t.store);
    await writeFile(join(t.dirs.approvalsDir, LOCK_FILE), JSON.stringify({ pid: 2 ** 31 - 2, host: hostname(), nonce: 'f'.repeat(32), at: new Date().toISOString() }));
    const store = await t.open();
    expect(store.status().state).toBe('available');
    expect(events(store)).toContain('approval.lock_recovered');
  });

  it('recuperação administrativa: exige prova, preserva evidências, não reativa nada e deixa barreira global', async () => {
    const t = await setup();
    const a = await t.approved();
    await t.close(t.store);
    const ledgerPath = join(t.dirs.approvalsDir, LEDGER_FILE);
    await writeFile(ledgerPath, 'corrompido');
    const store = await t.open();
    const svc = t.service(store);
    expect(store.status().state).toBe('unavailable');
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: 'x'.repeat(43), identity: CTX }))).toBe('step_up_required');
    const { quarantineId } = await svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX });
    expect(await listQuarantine(t.dirs.approvalsDir)).toEqual([quarantineId]);
    const kept = await readdir(join(t.dirs.approvalsDir, 'quarantine', quarantineId));
    expect(kept.sort()).toEqual([ANCHOR_FILE, HISTORY_FILE, LEDGER_FILE, MANIFEST_FILE, `anchor-dir-${INSTALL_FILE}`, `approvals-dir-${INSTALL_FILE}`].sort());
    expect(await readFile(join(t.dirs.approvalsDir, 'quarantine', quarantineId, LEDGER_FILE), 'utf8')).toBe('corrompido');
    expect(store.status().state).toBe('available');
    expect(events(store)).toEqual(expect.arrayContaining(['approval.store_recovered', 'approval.barrier_engaged']));
    expect(svc.barriers().durable.global).toMatchObject({ reason: 'recovery' });
    expect(await code(svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('approval_not_issued');
    // Novos pedidos de execução não podem ser aprovados até a liberação humana.
    const req = await svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    expect(await code(svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('killswitch_engaged');
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX }))).toBe('recovery_not_needed');
  });
});

describe('barreiras e kill switch (R3)', () => {
  it('acionar revoga execuções não usadas do escopo, bloqueia novas aprovações (N6) e sobrevive ao reinício', async () => {
    const t = await setup();
    const inP1 = await t.approved();
    const inP2 = await t.approved(agentBinding({ projectId: P2 }));
    await t.svc.engageBarrier({ scope: { kind: 'project', projectId: P1 }, actor: { kind: 'human', id: 'admin' }, reason: 'manual_stop' });
    const byId = new Map(t.svc.list('admin').map((x) => [x.id, x]));
    expect(byId.get(inP1.id)).toMatchObject({ state: 'revoked', closedReason: 'killswitch' });
    expect(byId.get(inP2.id)!.state).toBe('approved');
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-7' } }) });
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('killswitch_engaged');
    await t.close(t.store);
    const store = await t.open();
    const svc = t.service(store);
    expect(svc.barriers().durable.projects[P1]).toMatchObject({ reason: 'manual_stop' });
    expect(svc.barriers().volatile).toEqual([]);
    expect(await code(svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('killswitch_engaged');
  });

  it('kill switch durante o consumo: reserva enfileirada é negada; recibo emitido é recusado', async () => {
    const t = await setup();
    const a = await t.approved();
    const pending = t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    const engaging = t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'system', id: 'acc' }, reason: 'emergency' });
    expect(await code(pending)).toBe('killswitch_engaged');
    await engaging;
    expect(t.svc.list('admin').at(-1)!.state).toBe('revoked');
  });

  it('recibo emitido antes do acionamento é recusado na validação', async () => {
    const t = await setup();
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    await t.svc.engageBarrier({ scope: { kind: 'project', projectId: P1 }, actor: { kind: 'system', id: 'acc' }, reason: 'emergency' });
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!).authentic).toBe(false);
    expect(t.store.ledger().attempts.at(-1)!).toMatchObject({ state: 'failed', reason: 'killswitch_engaged' });
  });

  it('o acionamento vale de imediato em memória, antes da gravação', async () => {
    const t = await setup();
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    const engaging = t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'system', id: 'acc' }, reason: 'emergency' });
    // Ainda não gravado, mas a validação síncrona já nega.
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!)).toEqual({ authentic: false, reason: 'killswitch_engaged' });
    await engaging;
  });

  it('kill switch do controlador (#022) e falha ao consultá-lo bloqueiam (fail-closed)', async () => {
    const t = await setup();
    let engaged = false;
    const svc = t.service(t.store, { controllerKillSwitch: () => engaged });
    const a = await t.approved(agentBinding(), svc);
    engaged = true;
    const req = await svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-5' } }) });
    expect(await code(svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('killswitch_engaged');
    expect(await code(svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('killswitch_engaged');
    engaged = false;
    const throwing = t.service(t.store, {
      controllerKillSwitch: () => {
        throw new Error('down');
      },
    });
    // Outra instância não conhece o prazo monotônico: usa a mesma instância com o gancho que falha.
    expect(await code(throwing.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('killswitch_engaged');
    expect(await code(svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('resolved');
  });

  it('liberação exige nova aprovação de configuração; revogadas continuam revogadas', async () => {
    const t = await setup();
    const a = await t.approved();
    await t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'human', id: 'admin' }, reason: 'manual_stop' });
    const binding = releaseBinding('global');
    const release = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: release.id, component: 'approvals', binding });
    await t.svc.releaseBarrier({ attemptId: r.attemptId });
    expect(t.svc.barriers()).toEqual({ durable: { global: null, projects: {} }, volatile: [] });
    expect(t.svc.list('admin').find((x) => x.id === a.id)!.state).toBe('revoked');
    expect(await code(t.svc.releaseBarrier({ attemptId: r.attemptId }))).toBe('receipt_missing');
  });

  it('#022: liberação pelo controlador com o verificador confiável libera também a barreira', async () => {
    const t = await setup();
    const controller = createLimitsController({ projects: { get: () => null } as never, tasks: { get: () => null } as never, approvalVerifier: t.svc.verifierFor('limits'), now: () => t.clock.wall });
    await controller.engageKillSwitch({ kind: 'human', id: 'admin' }, { kind: 'global' }, 'manual');
    await t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'human', id: 'admin' }, reason: 'manual' });
    const binding = releaseBinding('global');
    const release = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: release.id, component: 'limits', binding });
    expect(controller.releaseKillSwitch({ kind: 'human', id: 'admin' }, { kind: 'global' }, r.humanApproval).engaged).toBe(false);
    await t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' });
    expect(t.svc.barriers().durable.global).toBeNull();
  });

  it('#022: alteração de limites com confirmação do PO, uso único', async () => {
    const t = await setup();
    const controller = createLimitsController({ projects: { get: () => null } as never, tasks: { get: () => null } as never, approvalVerifier: t.svc.verifierFor('limits'), now: () => t.clock.wall });
    const next = { ...DEFAULT_LIMITS, maxConcurrent: 2 };
    const binding = ownerBinding('limits.change', limitsFingerprint(next));
    const approval = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'limits', binding });
    expect(controller.updateLimits({ kind: 'human', id: 'admin' }, next, r.humanApproval).maxConcurrent).toBe(2);
    await t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' });
    expect(() => controller.updateLimits({ kind: 'human', id: 'admin' }, { ...next, maxConcurrent: 3 }, r.humanApproval)).toThrow();
    // Aprovação de limites não serve para outros limites (alvo diferente) nem pelo verificador de outro componente.
    expect(t.svc.verifierFor('sandbox').verify(r.humanApproval!).authentic).toBe(false);
  });
});

describe('histórico, retenção e compactação (R5)', () => {
  it('histórico encadeado: somente acréscimo, verificado ao reabrir', async () => {
    const t = await setup();
    await t.approved();
    const items = t.store.history().items;
    for (let i = 1; i < items.length; i += 1) expect(items[i].prevHash).toBe(items[i - 1].hash);
    await t.close(t.store);
    const path = join(t.dirs.approvalsDir, HISTORY_FILE);
    const doc = JSON.parse(await readFile(path, 'utf8'));
    // Alteração retroativa (mesmo re-assinada): o hash da entrada não confere.
    const edited = { ...doc, items: doc.items.map((item: { seq: number }, i: number) => (i === 1 ? { ...item, reason: 'edited' } : item)) };
    await writeFile(path, canonicalJson({ ...edited, mac: macHex(Buffer.from(t.key, 'hex'), 'history', without(edited, 'mac')) }));
    const store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'document_invalid' });
  });

  it('retenção: descarta o vencido como lápide, preserva o que tem preservação e o encadeamento continua válido', async () => {
    const t = await setup();
    const kept = await t.approved();
    await t.svc.revoke({ ownerId: 'admin', approvalId: kept.id, proofId: await t.proof(), identity: CTX });
    const gone = await t.approved(agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }));
    await t.svc.revoke({ ownerId: 'admin', approvalId: gone.id, proofId: await t.proof(), identity: CTX });
    await t.svc.addHold({ ownerId: 'admin', approvalId: kept.id, reason: 'incident', note: '  Investigação\u0007 do incidente  ', proofId: await t.proof(), identity: CTX });
    expect(t.store.history().holds[0].note).toBe('Investigação do incidente');
    t.advance(400 * DAY);
    await t.svc.sweep();
    const entries = t.store.history().items;
    expect(entries.some((i) => i.kind === 'tombstone')).toBe(true);
    expect(entries.some((i) => i.kind === 'entry' && i.approvalId === kept.id)).toBe(true);
    expect(entries.some((i) => i.kind === 'entry' && i.approvalId === gone.id)).toBe(false);
    expect(events(t.store)).toEqual(expect.arrayContaining(['approval.compacted', 'approval.history_purged']));
    // Compactada: o id não existe mais → negado (nunca reativado).
    expect(t.svc.list('admin').map((x) => x.id)).toEqual([kept.id]);
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: gone.id, component: 'sandbox', binding: agentBinding({ resource: { type: 'sandbox', id: 'sb-2' } }) }))).toBe('approval_not_issued');
    await t.close(t.store);
    const store = await t.open();
    expect(store.status().state).toBe('available');
  });

  it('preservação: motivo da lista fechada e texto de até 200 caracteres', async () => {
    const t = await setup();
    const a = await t.approved();
    expect(await code(t.svc.addHold({ ownerId: 'admin', approvalId: a.id, reason: 'whatever' as never, proofId: await t.proof(), identity: CTX }))).toBe('invalid_hold_reason');
    expect(await code(t.svc.addHold({ ownerId: 'admin', approvalId: a.id, reason: 'legal', note: 'x'.repeat(201), proofId: await t.proof(), identity: CTX }))).toBe('hold_note_too_long');
    expect(await code(t.svc.addHold({ ownerId: 'admin', approvalId: a.id, reason: 'legal', proofId: 'x'.repeat(43), identity: CTX }))).toBe('step_up_required');
  });

  it('retenção configurável (30 dias a 5 anos) e descarte administrativo exigem aprovação de configuração', async () => {
    const t = await setup();
    const binding = ownerBinding('approvals.retention_change', paramsDigestOf('approvals.retention_change', { days: 90 }), { type: 'approvals', id: 'retention' });
    const approval = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'approvals', binding });
    expect(await code(t.svc.changeRetention({ attemptId: r.attemptId, days: 120 }))).toBe('receipt_operation_mismatch');
    await t.svc.changeRetention({ attemptId: r.attemptId, days: 90 });
    expect(t.store.history().retentionDays).toBe(90);
    expect(await code(t.svc.changeRetention({ attemptId: r.attemptId, days: 29 }))).toBe('invalid_retention');
    expect(await code(t.svc.changeRetention({ attemptId: r.attemptId, days: 90 }))).toBe('receipt_missing');
    const recent = new Date(START - 10 * DAY).toISOString();
    expect(await code(t.svc.purgeHistory({ attemptId: r.attemptId, before: recent }))).toBe('invalid_purge_window');
  });
});

describe('caminhos protegidos (N2)', () => {
  it('recusa diretório dentro do Git, de pasta sincronizada (variável ou nome) e junção/link para lá', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acc-approvals-paths-'));
    roots.push(root);
    const keyProvider = createEnvKeyProvider({ ACC_APPROVAL_KEY: randomBytes(32).toString('hex') });
    const openAt = (approvalsDir: string, anchorDir: string, env: Record<string, string> = {}) =>
      openApprovalStore({ approvalsDir, anchorDir, keyProvider, environment: { env } }).then((s) => {
        stores.push(s);
        return s.status();
      });
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    expect(await openAt(join(repo, 'data'), join(root, 'a1'))).toEqual({ state: 'unavailable', reason: 'path_in_git_repository' });
    const synced = join(root, 'MyCloud');
    expect(await openAt(join(synced, 'ledger'), join(root, 'a2'), { OneDrive: synced })).toEqual({ state: 'unavailable', reason: 'path_in_synced_folder' });
    expect(await openAt(join(root, 'Dropbox', 'ledger'), join(root, 'a3'))).toEqual({ state: 'unavailable', reason: 'path_in_synced_folder' });
    const target = join(root, 'OneDrive', 'real');
    await mkdir(target, { recursive: true });
    const link = join(root, 'innocent');
    await symlink(target, link, 'junction');
    expect(await openAt(link, join(root, 'a4'))).toEqual({ state: 'unavailable', reason: 'path_in_synced_folder' });
    expect(await openAt(join(root, 'same'), join(root, 'same', 'anchor'))).toEqual({ state: 'unavailable', reason: 'paths_not_separate' });
    expect(await openAt('relative/dir', join(root, 'a5'))).toEqual({ state: 'unavailable', reason: 'path_not_absolute' });
  });
});

describe('revisão R1 — recuperação e quarentena verificada', () => {
  async function corrupted(opts: Parameters<typeof setup>[0] = {}) {
    const t = await setup(opts);
    await t.approved();
    await t.close(t.store);
    const files = { ledger: join(t.dirs.approvalsDir, LEDGER_FILE), history: join(t.dirs.approvalsDir, HISTORY_FILE), anchor: join(t.dirs.anchorDir, ANCHOR_FILE) };
    await writeFile(files.ledger, 'corrompido');
    const before = { ledger: await readFile(files.ledger), history: await readFile(files.history), anchor: await readFile(files.anchor) };
    const store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'document_invalid' });
    return { t, store, svc: t.service(store), files, before };
  }
  const unchanged = async (files: Record<string, string>, before: Record<string, Buffer>) => {
    for (const name of Object.keys(files)) expect((await readFile(files[name])).equals(before[name])).toBe(true);
  };

  it('manifesto lista cada evidência com SHA-256 que confere com a cópia', async () => {
    const { t, svc, before } = await corrupted();
    const { quarantineId } = await svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX });
    const dir = join(t.dirs.approvalsDir, 'quarantine', quarantineId);
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
    const ledger = manifest.files.find((f: { name: string }) => f.name === LEDGER_FILE);
    expect(ledger).toMatchObject({ present: true, bytes: before.ledger.length, sha256: createHash('sha256').update(before.ledger).digest('hex') });
    expect(manifest.files).toHaveLength(5);
    expect((await readFile(join(dir, LEDGER_FILE))).equals(before.ledger)).toBe(true);
  });

  it('falha ao copiar para a quarentena: nada muda, continua indisponível, sem nova linhagem', async () => {
    let fail = false;
    const { t, store, svc, files, before } = await corrupted({ writeBytes: (path, data) => (fail && path.includes('quarantine') ? Promise.reject(new Error('EACCES')) : writeBytesAtomic(path, data)) });
    fail = true;
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX }))).toBe('quarantine_write_failed');
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'document_invalid' });
    await unchanged(files, before);
  });

  it('cópia divergente na quarentena é detectada (verificação byte a byte)', async () => {
    let tamper = false;
    const { t, store, svc, files, before } = await corrupted({ writeBytes: (path, data) => writeBytesAtomic(path, tamper && path.endsWith(HISTORY_FILE) ? Buffer.concat([data, Buffer.from('x')]) : data) });
    tamper = true;
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX }))).toBe('quarantine_verification_failed');
    expect(store.status().state).toBe('unavailable');
    await unchanged(files, before);
  });

  it('falha ao gravar a nova linhagem: originais restaurados e verificados; continua indisponível', async () => {
    let failAnchor = false;
    const { t, store, svc, files, before } = await corrupted({ writeFile: (path, content) => (failAnchor && path.endsWith(ANCHOR_FILE) ? Promise.reject(new Error('disk')) : writeFileAtomic(path, content)) });
    failAnchor = true;
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX }))).toBe('recovery_failed');
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'recovery_failed' });
    await unchanged(files, before);
    failAnchor = false;
    await t.close(store);
    const reopened = await t.open();
    expect(reopened.status()).toEqual({ state: 'unavailable', reason: 'document_invalid' });
  });

  it('falha também na restauração → recovery_restore_failed (fail-closed, exige intervenção)', async () => {
    let fail = false;
    const { t, store, svc } = await corrupted({
      writeFile: (path, content) => (fail && path.endsWith(ANCHOR_FILE) ? Promise.reject(new Error('disk')) : writeFileAtomic(path, content)),
      writeBytes: (path, data) => (fail && !path.includes('quarantine') ? Promise.reject(new Error('disk')) : writeBytesAtomic(path, data)),
    });
    fail = true;
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX }))).toBe('recovery_restore_failed');
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'recovery_restore_failed' });
  });

  it('arquivo não regular (hard link) bloqueia a quarentena', async () => {
    const { t, store, svc, files } = await corrupted();
    await hardLink(files.history, join(t.root, 'extra-link'));
    expect(await code(svc.recover({ ownerId: 'admin', reason: 'corrupted_files', proofId: await t.proof(), identity: CTX }))).toBe('quarantine_unsupported_file');
    expect(store.status().state).toBe('unavailable');
  });

  it('recuperação recusada com o armazenamento bloqueado por outra instância', async () => {
    const t = await setup();
    const second = await t.open();
    expect(second.status().reason).toBe('store_locked');
    expect(await code(t.service(second).recover({ ownerId: 'admin', reason: 'integrity_failure', proofId: await t.proof(), identity: CTX }))).toBe('recovery_refused_store_locked');
  });
});

describe('revisão R2 — documentos ausentes nunca liberam bloqueio', () => {
  type T = Awaited<ReturnType<typeof setup>>;
  const docFiles = (t: T) => [join(t.dirs.approvalsDir, LEDGER_FILE), join(t.dirs.approvalsDir, HISTORY_FILE), join(t.dirs.anchorDir, ANCHOR_FILE)];
  const markerFiles = (t: T) => [join(t.dirs.approvalsDir, INSTALL_FILE), join(t.dirs.anchorDir, INSTALL_FILE)];

  it('primeira instalação só com inicialização explícita, e sempre com barreira global', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acc-approvals-init-'));
    roots.push(root);
    const keyProvider = createEnvKeyProvider({ ACC_APPROVAL_KEY: randomBytes(32).toString('hex') });
    const dirs = { approvalsDir: join(root, 'l'), anchorDir: join(root, 'a') };
    const implicit = await openApprovalStore({ ...dirs, keyProvider, environment: { env: {} } });
    stores.push(implicit);
    expect(implicit.status()).toEqual({ state: 'unavailable', reason: 'store_not_initialized' });
    await implicit.close();
    const explicit = await openApprovalStore({ ...dirs, keyProvider, environment: { env: {} }, initialize: 'if_absent' });
    stores.push(explicit);
    expect(explicit.status().state).toBe('available');
    expect(explicit.ledger().barriers.global).toMatchObject({ reason: 'initial_install' });
  });

  it('documentos apagados com marcadores presentes → store_missing (mesmo com inicialização explícita)', async () => {
    const t = await setup();
    await t.svc.engageBarrier({ scope: { kind: 'project', projectId: P1 }, actor: { kind: 'human', id: 'admin' }, reason: 'manual_stop' });
    await t.close(t.store);
    for (const file of docFiles(t)) await rm(file);
    const store = await t.open({ initialize: 'if_absent' });
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'store_missing' });
  });

  it('tudo apagado mas com vestígios (temporários) → store_missing', async () => {
    const t = await setup();
    await t.close(t.store);
    for (const file of [...docFiles(t), ...markerFiles(t)]) await rm(file);
    await writeFile(join(t.dirs.approvalsDir, `${LEDGER_FILE}.abcdef123456.tmp`), 'parcial');
    const store = await t.open({ initialize: 'if_absent' });
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'store_missing' });
  });

  it('remoção completa (indistinguível da primeira instalação): reinicia COM barreira global — nunca libera', async () => {
    const t = await setup();
    expect(t.svc.barriers().durable.global).toBeNull();
    await t.close(t.store);
    for (const file of [...docFiles(t), ...markerFiles(t)]) await rm(file);
    const store = await t.open({ initialize: 'if_absent' });
    const svc = t.service(store);
    expect(svc.barriers().durable.global).toMatchObject({ reason: 'initial_install' });
    const req = await svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    expect(await code(svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX }))).toBe('killswitch_engaged');
  });

  it('marcador ausente ou de outra linhagem → indisponível', async () => {
    const t = await setup();
    await t.close(t.store);
    const markerB = markerFiles(t)[1];
    const saved = await readFile(markerB);
    await rm(markerB);
    let store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'install_marker_missing' });
    await t.close(store);
    const doc = JSON.parse(saved.toString('utf8'));
    const other = { ...doc, lineage: '3f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b' };
    await writeFile(markerB, canonicalJson({ ...other, mac: macHex(Buffer.from(t.key, 'hex'), 'install', without(other, 'mac')) }));
    store = await t.open();
    expect(store.status()).toEqual({ state: 'unavailable', reason: 'lineage_mismatch' });
  });

  it('store_missing é recuperável: manifesto registra os ausentes e a barreira global volta', async () => {
    const t = await setup();
    await t.close(t.store);
    for (const file of docFiles(t)) await rm(file);
    const store = await t.open();
    const svc = t.service(store);
    expect(store.status().reason).toBe('store_missing');
    const { quarantineId } = await svc.recover({ ownerId: 'admin', reason: 'integrity_failure', proofId: await t.proof(), identity: CTX });
    const manifest = JSON.parse(await readFile(join(t.dirs.approvalsDir, 'quarantine', quarantineId, MANIFEST_FILE), 'utf8'));
    expect(manifest.files.filter((f: { present: boolean }) => !f.present).map((f: { name: string }) => f.name).sort()).toEqual([ANCHOR_FILE, HISTORY_FILE, LEDGER_FILE].sort());
    expect(svc.barriers().durable.global).toMatchObject({ reason: 'recovery' });
  });
});

describe('revisão R3 — falha de gravação nunca concede autoridade', () => {
  const failing = () => {
    const control = { fail: false };
    const writeFileFn: WriteFile = (path, content) => (control.fail ? Promise.reject(new Error('disk')) : writeFileAtomic(path, content));
    return { control, writeFileFn };
  };

  it('afterCommit: efeito só roda se a gravação der certo', async () => {
    const { control, writeFileFn } = failing();
    const t = await setup({ writeFile: writeFileFn });
    let ran = 0;
    const probe = (tx: Parameters<Parameters<ApprovalStore['commit']>[0]>[0]) => {
      tx.append({ event: 'approval.compacted', actor: { kind: 'system', id: 'test' }, reason: 'probe' });
      tx.afterCommit(() => (ran += 1));
    };
    await t.store.commit(probe);
    expect(ran).toBe(1);
    control.fail = true;
    expect(await code(t.store.commit(probe))).toBe('store_write_failed');
    expect(ran).toBe(1);
  });

  it('decisão não gravada: continua pendente, sem prazo de uso; após reinício continua pendente', async () => {
    const { control, writeFileFn } = failing();
    const t = await setup({ writeFile: writeFileFn });
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: agentBinding() });
    const p = await t.proof();
    control.fail = true;
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, proofId: p, identity: CTX }))).toBe('store_write_failed');
    expect(t.svc.list('admin').find((a) => a.id === req.id)!.state).toBe('pending');
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: req.id, component: 'sandbox', binding: agentBinding() }))).toBe('store_degraded');
    control.fail = false;
    await t.close(t.store);
    const store = await t.open();
    expect(t.service(store).list('admin').find((a) => a.id === req.id)!.state).toBe('pending');
  });

  it('reserva não gravada: nenhum recibo é emitido', async () => {
    const { control, writeFileFn } = failing();
    const t = await setup({ writeFile: writeFileFn });
    const a = await t.approved();
    control.fail = true;
    expect(await code(t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() }))).toBe('store_write_failed');
    const grant = { id: a.id, method: 'approval' as const, action: 'sandbox.execute' as const, projectId: P1, resource: { type: 'sandbox', id: 'sb-1' }, target: { sha: null, ref: null }, subject: { kind: 'agent' as const, id: 'claude-code' as const }, approvedBy: { kind: 'human' as const, id: 'admin' }, approvedAt: a.decidedAt!, expiresAt: a.validUntil! };
    expect(t.svc.verifierFor('sandbox').verifyGrant(grant).authentic).toBe(false);
  });

  it('liberação de barreira não gravada: barreiras durável e volátil continuam bloqueando', async () => {
    const { control, writeFileFn } = failing();
    const t = await setup({ writeFile: writeFileFn });
    await t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'human', id: 'admin' }, reason: 'manual_stop' });
    const binding = releaseBinding('global');
    const release = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: release.id, component: 'approvals', binding });
    control.fail = true;
    expect(await code(t.svc.releaseBarrier({ attemptId: r.attemptId }))).toBe('store_write_failed');
    expect(t.svc.barriers().durable.global).toMatchObject({ reason: 'manual_stop' });
    expect(t.svc.barriers().volatile).toContain('global');
    control.fail = false;
    await t.close(t.store);
    const store = await t.open();
    expect(t.service(store).barriers().durable.global).toMatchObject({ reason: 'manual_stop' });
  });

  it('liberação pelo controlador com resultado não gravado: barreira permanece', async () => {
    const { control, writeFileFn } = failing();
    const t = await setup({ writeFile: writeFileFn });
    await t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'human', id: 'admin' }, reason: 'manual' });
    const binding = releaseBinding('global');
    const release = await t.svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await t.proof(), identity: CTX });
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: release.id, component: 'limits', binding });
    expect(t.svc.verifierFor('limits').verify(r.humanApproval!).authentic).toBe(true);
    control.fail = true;
    expect(await code(t.svc.recordOutcome({ attemptId: r.attemptId, outcome: 'succeeded' }))).toBe('store_write_failed');
    expect(t.svc.barriers()).toMatchObject({ durable: { global: { reason: 'manual' } }, volatile: ['global'] });
  });

  it('acionamento não gravado: barreira volátil vale e o armazenamento degrada', async () => {
    const { control, writeFileFn } = failing();
    const t = await setup({ writeFile: writeFileFn });
    const a = await t.approved();
    const r = await t.svc.reserve({ ownerId: 'admin', approvalId: a.id, component: 'sandbox', binding: agentBinding() });
    control.fail = true;
    expect(await code(t.svc.engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'system', id: 'acc' }, reason: 'emergency' }))).toBe('store_write_failed');
    expect(t.svc.barriers().volatile).toEqual(['global']);
    expect(t.svc.verifierFor('sandbox').verifyGrant(r.grant!).authentic).toBe(false);
  });
});

describe('revisão R4 — bloqueio de escritor único', () => {
  const lockDir = async () => {
    const root = await mkdtemp(join(tmpdir(), 'acc-approvals-lock-'));
    roots.push(root);
    return root;
  };
  const stale = (nonce = 'a'.repeat(32)) => JSON.stringify({ pid: 2 ** 31 - 2, host: hostname(), nonce, at: new Date().toISOString() });
  const plainOps = (hook?: (path: string) => Promise<void>) => ({
    create: async (path: string, content: string) => {
      await hook?.(path);
      try {
        await writeFile(path, content, { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    },
    read: (path: string) => readFile(path, 'utf8'),
    remove: (path: string) => rm(path),
    isRegularFile: async () => true,
  });

  it('dois processos: o segundo é recusado; após encerramento abrupto do primeiro, o bloqueio é retomado', async () => {
    const dir = await lockDir();
    const lockModule = pathToFileURL(join(process.cwd(), 'server', 'approvals', 'lock.ts')).href;
    const script = `import(${JSON.stringify(lockModule)}).then((m) => m.acquireStoreLock(${JSON.stringify(dir)})).then(() => { process.stdout.write('locked\\n'); setInterval(() => {}, 1000); }, (e) => { process.stdout.write('error ' + e.code + '\\n'); process.exit(1); });`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: Buffer) => (chunk.toString().includes('locked') ? resolve() : reject(new Error(chunk.toString()))));
        child.on('exit', (status) => reject(new Error(`child exited ${status}`)));
      });
      expect(await code(acquireStoreLock(dir))).toBe('store_locked');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    const lock = await acquireStoreLock(dir);
    expect(lock.recovered).toBe(true);
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  }, 30_000);

  it('mesmo processo: segunda aquisição recusada; conteúdo ilegível → recusado', async () => {
    const dir = await lockDir();
    const first = await acquireStoreLock(dir);
    expect(await code(acquireStoreLock(dir))).toBe('store_locked');
    await first.release();
    await writeFile(join(dir, LOCK_FILE), 'lixo');
    expect(await code(acquireStoreLock(dir))).toBe('store_locked');
  });

  it('falha ao remover o bloqueio abandonado → lock_recovery_failed; arquivo de retomada removido', async () => {
    const dir = await lockDir();
    await writeFile(join(dir, LOCK_FILE), stale());
    const ops = {
      ...plainOps(),
      remove: async (path: string) => {
        if (path.endsWith(LOCK_FILE)) throw new Error('EBUSY');
        await rm(path);
      },
    };
    expect(await code(acquireStoreLock(dir, { ops }))).toBe('lock_recovery_failed');
    expect((await readdir(dir)).sort()).toEqual([LOCK_FILE]);
  });

  it('retomadas concorrentes: exatamente uma vence; a atrasada nunca apaga o bloqueio da outra', async () => {
    const dir = await lockDir();
    await writeFile(join(dir, LOCK_FILE), stale());
    const results = await Promise.allSettled([acquireStoreLock(dir), acquireStoreLock(dir), acquireStoreLock(dir)]);
    const winners = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    expect(winners).toHaveLength(1);
    await winners[0].release();
    // Corrida determinística: B conclui a retomada inteira entre a leitura de A e a retomada de A.
    await writeFile(join(dir, LOCK_FILE), stale());
    let b: Awaited<ReturnType<typeof acquireStoreLock>> | null = null;
    const opsA = plainOps(async (path) => {
      if (path.endsWith(TAKEOVER_FILE) && !b) b = await acquireStoreLock(dir);
    });
    expect(await code(acquireStoreLock(dir, { ops: opsA }))).toBe('store_locked');
    expect(b).not.toBeNull();
    const content = JSON.parse(await readFile(join(dir, LOCK_FILE), 'utf8'));
    expect(content.pid).toBe(process.pid);
    expect(await code(acquireStoreLock(dir))).toBe('store_locked');
    await b!.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it('arquivo de retomada abandonado → lock_recovery_stale (intervenção humana)', async () => {
    const dir = await lockDir();
    await writeFile(join(dir, LOCK_FILE), stale());
    await writeFile(join(dir, TAKEOVER_FILE), stale('b'.repeat(32)));
    expect(await code(acquireStoreLock(dir))).toBe('lock_recovery_stale');
  });

  it('pid vivo (ou reutilizado) nunca é retomado; liberação não remove bloqueio de outra instância', async () => {
    const dir = await lockDir();
    await writeFile(join(dir, LOCK_FILE), stale());
    expect(await code(acquireStoreLock(dir, { alive: () => true }))).toBe('store_locked');
    await rm(join(dir, LOCK_FILE));
    const mine = await acquireStoreLock(dir);
    const foreign = stale('c'.repeat(32));
    await writeFile(join(dir, LOCK_FILE), foreign);
    await mine.release();
    expect(await readFile(join(dir, LOCK_FILE), 'utf8')).toBe(foreign);
    expect(processAlive(process.pid)).toBe(true);
  });
});
