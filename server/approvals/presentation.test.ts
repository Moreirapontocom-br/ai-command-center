// @vitest-environment node
/**
 * Issue #011 (PR 2), correção R1: apresentação verificável dos parâmetros da operação aprovada.
 * Divergência, ausência, representação incompleta e tentativa de aprovação com apresentação
 * inválida — sempre falha fechada; rejeição continua possível.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex as localSha256 } from '../../shared/approvalDigest.ts';
import {
  approvalPresentationDigest,
  checkPresentation,
  PRESENTATION_CREDENTIAL_SCOPES,
  PRESENTATION_SANDBOX_MAX,
  PRESENTATION_USAGE_MODES,
  presentationParamsDigest,
  sandboxWorkBranchFor,
  sandboxWorkspaceIdFor,
  type ApprovalPresentation,
} from '../../shared/approvalPresentation.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { USAGE_MODES } from '../limits/contracts.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { CREDENTIAL_SCOPES, SANDBOX_LIMITS } from '../sandbox/contracts.ts';
import { assertWorkspaceId, workBranchFor } from '../sandbox/validation.ts';
import { TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { bindingDigest, paramsDigestOf } from './binding.ts';
import { sha256Hex } from './canonical.ts';
import { ApprovalError, type ApprovalBinding, type LedgerApproval } from './contracts.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from './identity.ts';
import { createEnvKeyProvider } from './keyProvider.ts';
import { verifyApprovalPresentation } from './presentation.ts';
import { createApprovalService } from './service.ts';
import { openApprovalStore, type ApprovalStore } from './store.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TASK = '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const OTHER_TASK = '7a2f9c3b-2d4e-4f60-9b0c-1d2e3f4a5b6c';
const SHA = 'c'.repeat(40);
const START = Date.parse('2026-11-15T12:00:00Z');
const VERSION = DEFAULT_POLICY.version;
const CTX: IdentityContext = { userId: 'admin', sessionKey: createHash('sha256').update('session-r1').digest('hex') };

const REQ = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const OTHER_REQ = '8b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e';
const P2 = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const REPO = 'Moreirapontocom-br/ai-command-center';
const BRANCH = sandboxWorkBranchFor('claude-code', TASK, REQ);
/** Especificação COMPLETA (correção R3): tudo do `SandboxSpec`, exceto `ownerId`. */
const sandboxParams = () => ({
  requestId: REQ,
  projectId: P1,
  taskId: TASK,
  agentId: 'claude-code',
  workspace: { id: sandboxWorkspaceIdFor(REQ), exclusive: true, hostPathAccess: 'none' },
  git: { repository: REPO, baseSha: SHA, workBranch: BRANCH, mainWritable: false } as { repository: string; baseSha: string; workBranch: string; mainWritable: boolean } | null,
  network: { default: 'deny', allow: ['registry.npmjs.org'] },
  credentials: { scopes: ['repo.read'], ttlSeconds: 600, productionSecrets: 'denied', productionDatabase: 'denied' },
  limits: { timeoutSeconds: 600, cpu: 1, memoryMb: 512, diskMb: 1024 },
  inputs: [{ kind: 'issue', ref: 'acc#11', trust: 'untrusted' }],
});
const admissionParams = (overrides: Record<string, unknown> = {}) => ({
  projectId: P1,
  taskId: TASK,
  agentId: 'claude-code',
  action: 'tool.use',
  mode: 'metered_api',
  durationSeconds: 120,
  estimatedCostMinor: 250,
  maxTokens: 4000,
  ...overrides,
});
const sandboxBinding = (params: unknown = sandboxParams(), overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
  action: 'sandbox.execute',
  projectId: P1,
  resource: { type: 'task', id: TASK },
  target: { sha: SHA, ref: BRANCH },
  subject: { kind: 'agent', id: 'claude-code' },
  paramsDigest: paramsDigestOf('sandbox', params),
  policyVersion: VERSION,
  ...overrides,
});
const admissionBinding = (params: Record<string, unknown> = admissionParams(), overrides: Partial<ApprovalBinding> = {}): ApprovalBinding => ({
  action: 'tool.use',
  projectId: P1,
  resource: { type: 'task', id: TASK },
  target: { sha: null, ref: null },
  subject: { kind: 'agent', id: 'claude-code' },
  paramsDigest: paramsDigestOf('admission', params),
  policyVersion: VERSION,
  ...overrides,
});

const roots: string[] = [];
const stores: ApprovalStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'acc-approvals-r1-'));
  roots.push(root);
  const clock = { wall: START, mono: 1_000 };
  const key = randomBytes(32).toString('hex');
  const open = (initialize: 'never' | 'if_absent') =>
    openApprovalStore({
      approvalsDir: join(root, 'ledger'),
      anchorDir: join(root, 'anchor'),
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: key }),
      environment: { env: {} },
      initialize,
      now: () => clock.wall,
    }).then((store) => {
      stores.push(store);
      return store;
    });
  const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(await testPasswordHash()) })], now: () => clock.wall });
  const serviceFor = (store: ApprovalStore) => createApprovalService({ store, identity, policyVersion: VERSION, now: () => clock.wall, monotonicNow: () => clock.mono });
  const proof = async () => (await identity.confirm(CTX, 'password', TEST_ADMIN_PASSWORD)).proofId;
  const store = await open('if_absent');
  const svc = serviceFor(store);
  // Instalação nova começa com barreira global (R2): liberada aqui só para exercitar as decisões.
  const release: ApprovalBinding = {
    action: 'killswitch.release',
    projectId: null,
    resource: { type: 'killswitch', id: 'global' },
    target: { sha: null, ref: null },
    subject: { kind: 'human', id: 'admin' },
    paramsDigest: paramsDigestOf('killswitch.release', { scope: 'global' }),
    policyVersion: VERSION,
  };
  const confirmed = await svc.confirmOwner({ ownerId: 'admin', binding: release, bindingDigest: bindingDigest(release), proofId: await proof(), identity: CTX });
  const reservation = await svc.reserve({ ownerId: 'admin', approvalId: confirmed.id, component: 'approvals', binding: release });
  await svc.releaseBarrier({ attemptId: reservation.attemptId });
  return { root, store, svc, proof, open, serviceFor };
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ApprovalError ? error.code : `unexpected:${(error as Error).message}`;
  }
};
const pd = (a: LedgerApproval) => approvalPresentationDigest(a.bindingDigest, a.presentation as ApprovalPresentation);
const events = (store: ApprovalStore) => store.history().items.flatMap((i) => (i.kind === 'entry' ? [{ event: i.event, reason: i.reason }] : []));

describe('R1 — formato e resumo compartilhados', () => {
  it('as listas espelhadas no navegador são as mesmas do servidor', () => {
    expect([...PRESENTATION_CREDENTIAL_SCOPES]).toEqual([...CREDENTIAL_SCOPES]);
    expect([...PRESENTATION_USAGE_MODES]).toEqual([...USAGE_MODES]);
    expect(PRESENTATION_SANDBOX_MAX).toMatchObject({
      timeoutSeconds: SANDBOX_LIMITS.maxTimeoutSeconds,
      cpu: SANDBOX_LIMITS.maxCpu,
      memoryMb: SANDBOX_LIMITS.maxMemoryMb,
      diskMb: SANDBOX_LIMITS.maxDiskMb,
      networkHosts: SANDBOX_LIMITS.maxNetworkHosts,
    });
  });

  it('resumo dos parâmetros e da apresentação: navegador = servidor (node:crypto)', () => {
    const presentations: ApprovalPresentation[] = [
      { kind: 'sandbox', params: sandboxParams() } as ApprovalPresentation,
      { kind: 'admission', params: admissionParams() } as ApprovalPresentation,
      { kind: 'approvals.retention_change', params: { days: 90 } },
      { kind: 'approvals.history_purge', params: { before: '2026-01-01T00:00:00.000Z' } },
    ];
    for (const p of presentations) {
      expect(presentationParamsDigest(p)).toBe(paramsDigestOf(p.kind, p.params));
      expect(presentationParamsDigest(p, sha256Hex)).toBe(presentationParamsDigest(p, localSha256));
      const digest = 'a'.repeat(64);
      expect(approvalPresentationDigest(digest, p)).toBe(approvalPresentationDigest(digest, p, sha256Hex));
    }
  });

  it('o resumo da apresentação muda com QUALQUER parâmetro e com o vínculo', () => {
    const base = { kind: 'sandbox', params: sandboxParams() } as ApprovalPresentation;
    const digest = approvalPresentationDigest('a'.repeat(64), base);
    expect(approvalPresentationDigest('b'.repeat(64), base)).not.toBe(digest);
    const changed = structuredClone(base) as Extract<ApprovalPresentation, { kind: 'sandbox' }>;
    changed.params.limits.cpu = 2;
    expect(approvalPresentationDigest('a'.repeat(64), changed)).not.toBe(digest);
  });

  it('coerência com o vínculo: tipo pelo SOLICITANTE, tarefa/agente/projeto/ação da admissão, SHA × repositório', () => {
    const ok = (binding: ApprovalBinding, requestedBy: { kind: 'system' | 'human'; id: string }, presentation: unknown) =>
      checkPresentation({ binding, bindingDigest: bindingDigest(binding), requestedBy, presentation }, sha256Hex);
    const sandbox = { kind: 'sandbox', params: sandboxParams() };
    expect(ok(sandboxBinding(), { kind: 'system', id: 'sandbox' }, sandbox)).toMatchObject({ ok: true });
    // Mesmo resumo, solicitante errado: o servidor decide o tipo esperado, nunca o chamador.
    expect(ok(sandboxBinding(), { kind: 'system', id: 'limits' }, sandbox)).toEqual({ ok: false, reason: 'presentation_mismatch' });
    expect(ok(sandboxBinding(), { kind: 'system', id: 'policy' }, sandbox)).toEqual({ ok: false, reason: 'presentation_unsupported' });
    // Repositório sem SHA no vínculo (ou vice-versa) é incoerente.
    expect(ok(sandboxBinding(sandboxParams(), { target: { sha: null, ref: null } }), { kind: 'system', id: 'sandbox' }, sandbox)).toEqual({ ok: false, reason: 'presentation_mismatch' });
    // Admissão: o resumo confere, mas a tarefa exibida não é a do vínculo → bloqueado.
    const otherTask = admissionParams({ taskId: OTHER_TASK });
    expect(ok(admissionBinding(otherTask), { kind: 'system', id: 'limits' }, { kind: 'admission', params: otherTask })).toEqual({ ok: false, reason: 'presentation_mismatch' });
    const otherAction = admissionParams({ action: 'repo.merge' });
    expect(ok(admissionBinding(otherAction), { kind: 'system', id: 'limits' }, { kind: 'admission', params: otherAction })).toEqual({ ok: false, reason: 'presentation_mismatch' });
    // Gasto (`spend.create`) só com modo cobrado.
    const spend = admissionParams();
    expect(ok(admissionBinding(spend, { action: 'spend.create' }), { kind: 'system', id: 'limits' }, { kind: 'admission', params: spend })).toMatchObject({ ok: true });
    const free = admissionParams({ mode: 'subscription_assisted', estimatedCostMinor: null, maxTokens: null });
    expect(ok(admissionBinding(free, { action: 'spend.create' }), { kind: 'system', id: 'limits' }, { kind: 'admission', params: free })).toEqual({ ok: false, reason: 'presentation_mismatch' });
  });

  it('representação incompleta, campo extra, tipo errado ou valor fora da lista → inválida', () => {
    const check = (params: unknown) =>
      checkPresentation({ binding: sandboxBinding(params), bindingDigest: bindingDigest(sandboxBinding(params)), requestedBy: { kind: 'system', id: 'sandbox' }, presentation: { kind: 'sandbox', params } }, sandbox256);
    const sandbox256 = sha256Hex;
    const { inputs: _drop, ...missing } = sandboxParams(); // eslint-disable-line @typescript-eslint/no-unused-vars
    expect(check(missing)).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), command: 'rm -rf /' })).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), network: { default: 'allow', allow: [] } })).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), credentials: { ...sandboxParams().credentials, productionSecrets: 'allowed' } })).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), credentials: { ...sandboxParams().credentials, scopes: ['admin:org'] } })).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), limits: { ...sandboxParams().limits, cpu: 64 } })).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), inputs: [{ kind: 'issue', ref: '../etc/passwd', trust: 'untrusted' }] })).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(check({ ...sandboxParams(), inputs: [{ kind: 'issue', ref: 'acc#1', trust: 'trusted' }] })).toEqual({ ok: false, reason: 'presentation_invalid' });
    // Sem apresentação e apresentação de outro tipo.
    expect(checkPresentation({ binding: sandboxBinding(), bindingDigest: bindingDigest(sandboxBinding()), requestedBy: { kind: 'system', id: 'sandbox' }, presentation: null })).toEqual({
      ok: false,
      reason: 'presentation_missing',
    });
    expect(checkPresentation({ binding: sandboxBinding(), bindingDigest: bindingDigest(sandboxBinding()), requestedBy: { kind: 'system', id: 'sandbox' }, presentation: { kind: 'shell', params: {} } })).toEqual({
      ok: false,
      reason: 'presentation_invalid',
    });
  });

  it('valores com aparência de credencial nunca são aceitos para exibição', () => {
    // Valores montados em tempo de execução: nenhum literal com formato de credencial no código.
    const fakes = [['gh', 'p_', 'A'.repeat(24)], ['github', '_pat_', '11ABCDEFG'], ['sk', '-', 'B'.repeat(16)], ['AK', 'IA', 'C'.repeat(16)], ['xo', 'xb-', '1234']].map((parts) => parts.join(''));
    for (const secret of fakes) {
      const params = { ...sandboxParams(), inputs: [{ kind: 'issue', ref: secret, trust: 'untrusted' }] };
      const result = checkPresentation({ binding: sandboxBinding(params), bindingDigest: bindingDigest(sandboxBinding(params)), requestedBy: { kind: 'system', id: 'sandbox' }, presentation: { kind: 'sandbox', params } });
      expect(result).toEqual({ ok: false, reason: 'presentation_secret_like' });
    }
  });
});

describe('R1 — pedido e decisão no núcleo', () => {
  it('pedido com parâmetros divergentes do resumo é recusado e nada é criado', async () => {
    const t = await setup();
    const shown = { ...sandboxParams(), network: { default: 'deny', allow: ['evil.example.com'] } };
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: sandboxBinding(), presentation: { kind: 'sandbox', params: shown } }))).toBe('presentation_mismatch');
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: sandboxBinding(), presentation: { kind: 'admission', params: admissionParams() } }))).toBe('presentation_mismatch');
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: sandboxBinding(), presentation: { kind: 'sandbox', params: { ...sandboxParams(), extra: 1 } } }))).toBe('presentation_invalid');
    expect(t.svc.list('admin').filter((a) => a.state === 'pending')).toEqual([]);
  });

  it('aprovação legítima: parâmetros apresentados + resumo da apresentação → approved; persistem após reinício', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: sandboxBinding(), presentation: { kind: 'sandbox', params: sandboxParams() } });
    expect(req.presentation).toEqual({ kind: 'sandbox', params: sandboxParams() });
    expect(verifyApprovalPresentation(req)).toMatchObject({ ok: true, digest: pd(req) });
    const approved = await t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, presentationDigest: pd(req), proofId: await t.proof(), identity: CTX });
    expect(approved.state).toBe('approved');
    await t.store.close();
    stores.splice(stores.indexOf(t.store), 1);
    const reopened = await t.open('never');
    const again = t.serviceFor(reopened).get('admin', req.id)!;
    expect(again.presentation).toEqual(req.presentation);
    expect(verifyApprovalPresentation(again)).toMatchObject({ ok: true });
  });

  it('ausência de parâmetros: o pedido existe, mas aprovar é recusado (mesmo com bindingDigest correto); rejeitar funciona', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: sandboxBinding() });
    expect(req.presentation).toBeUndefined();
    expect(verifyApprovalPresentation(req)).toEqual({ ok: false, reason: 'presentation_missing' });
    // Um digest coincidente (vínculo e parâmetros) não prova que os parâmetros foram apresentados.
    const fakeDigest = approvalPresentationDigest(req.bindingDigest, { kind: 'sandbox', params: sandboxParams() } as ApprovalPresentation);
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, presentationDigest: fakeDigest, proofId: await t.proof(), identity: CTX }))).toBe(
      'presentation_missing',
    );
    expect(t.svc.get('admin', req.id)!.state).toBe('pending');
    expect(events(t.store)).toContainEqual({ event: 'approval.decision_denied', reason: 'presentation_missing' });
    const rejected = await t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'reject', bindingDigest: req.bindingDigest, proofId: await t.proof(), identity: CTX });
    expect(rejected.state).toBe('rejected');
  });

  it('tentativa de aprovação com apresentação inválida: sem resumo, resumo de outros parâmetros ou só o do vínculo → recusada', async () => {
    const t = await setup();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding: sandboxBinding(), presentation: { kind: 'sandbox', params: sandboxParams() } });
    const other = { kind: 'sandbox', params: { ...sandboxParams(), limits: { ...sandboxParams().limits, cpu: 2 } } } as ApprovalPresentation;
    for (const presentationDigest of [undefined, null, '', req.bindingDigest, approvalPresentationDigest(req.bindingDigest, other), approvalPresentationDigest('0'.repeat(64), req.presentation as ApprovalPresentation)]) {
      expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, presentationDigest, proofId: await t.proof(), identity: CTX }))).toBe('presentation_mismatch');
      expect(t.svc.get('admin', req.id)!.state).toBe('pending');
    }
    // Controles existentes preservados: vínculo divergente continua `binding_mismatch`.
    expect(await code(t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: 'f'.repeat(64), presentationDigest: pd(req), proofId: await t.proof(), identity: CTX }))).toBe('binding_mismatch');
    expect((await t.svc.decide({ ownerId: 'admin', approvalId: req.id, decision: 'approve', bindingDigest: req.bindingDigest, presentationDigest: pd(req), proofId: await t.proof(), identity: CTX })).state).toBe('approved');
  });

  it('admissão (#022): parâmetros completos (custo, tokens, modo) apresentados e conferidos', async () => {
    const t = await setup();
    const params = admissionParams();
    const req = await t.svc.request({ ownerId: 'admin', requestedBy: 'limits', binding: admissionBinding(params), presentation: { kind: 'admission', params } });
    expect(verifyApprovalPresentation(req)).toMatchObject({ ok: true });
    expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'limits', binding: admissionBinding(params), presentation: { kind: 'admission', params: { ...params, estimatedCostMinor: 1 } } }))).toBe(
      'presentation_mismatch',
    );
  });

  it('configuração do PO guarda os parâmetros digitados (retenção), conferidos contra o vínculo', async () => {
    const t = await setup();
    const approval = await t.svc.configure({ ownerId: 'admin', operation: 'approvals.retention_change', params: { days: 90 }, proofId: await t.proof(), identity: CTX });
    expect(approval.presentation).toEqual({ kind: 'approvals.retention_change', params: { days: 90 } });
    expect(verifyApprovalPresentation(approval)).toMatchObject({ ok: true });
  });
});

/**
 * Correção R3: coerência semântica COMPLETA do sandbox. Cada caso abaixo é "criptograficamente
 * válido" — o `paramsDigest` do vínculo é calculado a partir dos próprios parâmetros apresentados —
 * mas semanticamente incompatível com o vínculo ou com a especificação derivada. Todos bloqueiam.
 */
describe('R3 — coerência semântica completa do sandbox', () => {
  type Params = ReturnType<typeof sandboxParams>;
  /** Vínculo legítimo (o de `sandboxBinding`), mas com `paramsDigest` dos parâmetros dados. */
  const consistentDigest = (params: unknown, overrides: Partial<ApprovalBinding> = {}) => sandboxBinding(params, overrides);
  const verdict = (params: unknown, overrides: Partial<ApprovalBinding> = {}) => {
    const binding = consistentDigest(params, overrides);
    return checkPresentation({ binding, bindingDigest: bindingDigest(binding), requestedBy: { kind: 'system', id: 'sandbox' }, presentation: { kind: 'sandbox', params } }, sha256Hex);
  };
  const withParams = (change: (p: Params) => void) => {
    const p = sandboxParams();
    change(p);
    return p;
  };
  const MISMATCH = { ok: false, reason: 'presentation_mismatch' };

  it('derivações compartilhadas são as mesmas do sandbox do servidor', () => {
    expect(sandboxWorkBranchFor('claude-code', TASK, REQ)).toBe(workBranchFor('claude-code', TASK, REQ));
    expect(sandboxWorkspaceIdFor(REQ)).toBe(assertWorkspaceId(`ws-${REQ.replaceAll('-', '')}`));
  });

  it('fluxo legítimo completo: especificação coerente é aceita (com e sem repositório)', () => {
    expect(verdict(sandboxParams())).toMatchObject({ ok: true });
    const noGit = withParams((p) => {
      p.git = null;
    });
    expect(verdict(noGit, { target: { sha: null, ref: null } })).toMatchObject({ ok: true });
  });

  it('projeto divergente', () => {
    expect(verdict(withParams((p) => (p.projectId = P2)))).toEqual(MISMATCH);
    expect(verdict(sandboxParams(), { projectId: P2 })).toEqual(MISMATCH);
  });

  it('tarefa divergente (inclusive recurso que não é tarefa)', () => {
    expect(verdict(withParams((p) => (p.taskId = OTHER_TASK)))).toEqual(MISMATCH);
    expect(verdict(sandboxParams(), { resource: { type: 'task', id: OTHER_TASK } })).toEqual(MISMATCH);
    expect(verdict(sandboxParams(), { resource: { type: 'sandbox', id: TASK } })).toEqual(MISMATCH);
  });

  it('agente divergente', () => {
    expect(verdict(withParams((p) => (p.agentId = 'gemini')))).toEqual(MISMATCH);
    expect(verdict(sandboxParams(), { subject: { kind: 'agent', id: 'gemini' } })).toEqual(MISMATCH);
  });

  it('ação diferente de sandbox.execute', () => {
    // O tipo `sandbox` só serve para `sandbox.execute`; para outra ação, o pedido não é apresentável.
    expect(verdict(sandboxParams(), { action: 'tool.use' })).toEqual({ ok: false, reason: 'presentation_unsupported' });
  });

  it('identificador da solicitação divergente: workspace e branch precisam derivar do MESMO id', () => {
    // Troca só o id: workspace e branch continuam do id antigo.
    expect(verdict(withParams((p) => (p.requestId = OTHER_REQ)))).toEqual(MISMATCH);
    // Troca id e workspace, mas não a branch (e o vínculo aponta para a branch antiga).
    expect(
      verdict(
        withParams((p) => {
          p.requestId = OTHER_REQ;
          p.workspace.id = sandboxWorkspaceIdFor(OTHER_REQ);
        }),
      ),
    ).toEqual(MISMATCH);
    // Workspace de outra solicitação.
    expect(verdict(withParams((p) => (p.workspace.id = sandboxWorkspaceIdFor(OTHER_REQ))))).toEqual(MISMATCH);
  });

  it('SHA divergente (no vínculo ou na especificação)', () => {
    expect(verdict(sandboxParams(), { target: { sha: 'd'.repeat(40), ref: BRANCH } })).toEqual(MISMATCH);
    expect(verdict(withParams((p) => (p.git!.baseSha = 'd'.repeat(40))))).toEqual(MISMATCH);
  });

  it('referência divergente: branch do vínculo ≠ especificação, ou branch que não é a derivada', () => {
    expect(verdict(sandboxParams(), { target: { sha: SHA, ref: 'feature/x' } })).toEqual(MISMATCH);
    const otherBranch = sandboxWorkBranchFor('claude-code', OTHER_TASK, REQ);
    expect(verdict(withParams((p) => (p.git!.workBranch = otherBranch)), { target: { sha: SHA, ref: otherBranch } })).toEqual(MISMATCH);
    // Formato fora do contrato (ex.: main) é recusado já no parse.
    expect(verdict(withParams((p) => (p.git!.workBranch = 'main')), { target: { sha: SHA, ref: 'main' } })).toEqual({ ok: false, reason: 'presentation_invalid' });
  });

  it('repositório incompatível: sem git com SHA no vínculo, git sem SHA, main gravável, repositório inválido', () => {
    expect(
      verdict(
        withParams((p) => {
          p.git = null;
        }),
      ),
    ).toEqual(MISMATCH);
    expect(verdict(sandboxParams(), { target: { sha: null, ref: null } })).toEqual(MISMATCH);
    expect(verdict(withParams((p) => (p.git!.mainWritable = true)))).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(verdict(withParams((p) => (p.git!.repository = '../../etc')))).toEqual({ ok: false, reason: 'presentation_invalid' });
    // Escrita na branch de trabalho sem repositório.
    expect(
      verdict(
        withParams((p) => {
          p.git = null;
          p.credentials.scopes = ['repo.write_work_branch'];
        }),
        { target: { sha: null, ref: null } },
      ),
    ).toEqual(MISMATCH);
  });

  it('campos substituídos ou omitidos: workspace, credencial além da execução, campos obrigatórios', () => {
    expect(verdict(withParams((p) => ((p.workspace as { exclusive: boolean }).exclusive = false)))).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(verdict(withParams((p) => ((p.workspace as { hostPathAccess: string }).hostPathAccess = 'read')))).toEqual({ ok: false, reason: 'presentation_invalid' });
    expect(verdict(withParams((p) => (p.credentials.ttlSeconds = 1200)))).toEqual(MISMATCH);
    for (const key of ['requestId', 'projectId', 'taskId', 'agentId', 'workspace', 'git', 'network', 'credentials', 'limits', 'inputs'] as const) {
      const partial: Record<string, unknown> = sandboxParams();
      delete partial[key];
      expect(verdict(partial)).toEqual({ ok: false, reason: 'presentation_invalid' });
    }
  });

  it('no núcleo: pedido criptograficamente válido mas semanticamente incompatível é recusado e nada é criado', async () => {
    const t = await setup();
    const cases: Array<[Params, Partial<ApprovalBinding>]> = [
      [withParams((p) => (p.projectId = P2)), {}],
      [withParams((p) => (p.taskId = OTHER_TASK)), {}],
      [withParams((p) => (p.agentId = 'gemini')), {}],
      [withParams((p) => (p.requestId = OTHER_REQ)), {}],
      [withParams((p) => (p.git!.baseSha = 'd'.repeat(40))), {}],
      [sandboxParams(), { target: { sha: SHA, ref: 'feature/x' } }],
    ];
    for (const [params, overrides] of cases) {
      const binding = consistentDigest(params, overrides);
      expect(await code(t.svc.request({ ownerId: 'admin', requestedBy: 'sandbox', binding, presentation: { kind: 'sandbox', params } }))).toBe('presentation_mismatch');
    }
    expect(t.svc.list('admin').filter((a) => a.state === 'pending')).toEqual([]);
  });

  it('admissão e configuração também exigem coerência completa (alvo vazio; recurso fixo)', () => {
    const params = admissionParams();
    const withTarget = admissionBinding(params, { target: { sha: SHA, ref: 'feature/x' } });
    expect(checkPresentation({ binding: withTarget, bindingDigest: bindingDigest(withTarget), requestedBy: { kind: 'system', id: 'limits' }, presentation: { kind: 'admission', params } })).toEqual(MISMATCH);
    const retention: ApprovalBinding = {
      action: 'approvals.retention_change',
      projectId: null,
      resource: { type: 'limits', id: 'controller' },
      target: { sha: null, ref: null },
      subject: { kind: 'human', id: 'admin' },
      paramsDigest: paramsDigestOf('approvals.retention_change', { days: 90 }),
      policyVersion: VERSION,
    };
    expect(
      checkPresentation({ binding: retention, bindingDigest: bindingDigest(retention), requestedBy: { kind: 'human', id: 'admin' }, presentation: { kind: 'approvals.retention_change', params: { days: 90 } } }),
    ).toEqual(MISMATCH);
  });
});
