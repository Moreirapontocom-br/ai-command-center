// @vitest-environment node
/**
 * Issue #008, P1: comando local de liberação da barreira global inicial (matriz F, itens 1–21).
 * Armazenamentos reais em diretórios temporários; nenhum servidor, rede, agente ou provedor.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindingDigest } from '../approvals/binding.ts';
import { APPROVAL_TTL_MS, ApprovalError, RECEIPT_TTL_MS, STEP_UP_TTL_MS } from '../approvals/contracts.ts';
import type { HistoryEntry } from '../approvals/documents.ts';
import { createPasswordConfirmer, createStepUpRegistry } from '../approvals/identity.ts';
import { createEnvKeyProvider } from '../approvals/keyProvider.ts';
import { createApprovalService } from '../approvals/service.ts';
import { ANCHOR_FILE, INSTALL_FILE, LEDGER_FILE, openApprovalStore, type ApprovalStore } from '../approvals/store.ts';
import { parsePasswordHash } from '../auth/password.ts';
import { loadConfig, type ServerConfig } from '../config.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { createBarrierGate } from '../queue/barrierGate.ts';
import { openQueueStore } from '../queue/store.ts';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import { deriveSubkey, QUEUE_KEY_DOMAIN } from '../storage/subkeys.ts';
import { TEST_ADMIN_PASSWORD, testPasswordHash } from '../test/authFixtures.ts';
import { checkReleaseAudit } from './consistency.ts';
import { acquireInstanceLock, adminReleasePending, INSTANCE_LOCK_FILES } from './instance.ts';
import { JOURNAL_FILE, readJournal } from './journal.ts';
import { defaultJournalOps } from './journal.ts';
import { PromptCancelled } from './releaseBarrierCli.ts';
import { writeFileAtomic } from '../storage/jsonFile.ts';
import { assessState, globalReleaseBinding, openedWithUnapplied, phraseFor, runBarrierRelease, type Checkpoint, type ReleaseDeps, type ReleasePrompt } from './releaseBarrier.ts';
import { HARD_LOCK_FAILURES, THROTTLE_FILE } from './throttle.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const MIN = 60_000;
const OP = 'barrier_release_global';

class Crash extends Error {}

interface Answers {
  password?: string;
  phrase?: string;
}

async function setup(opts: { queue?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'acc-p1-'));
  roots.push(root);
  const dirs = { data: join(root, 'data'), ledger: join(root, 'ledger'), anchor: join(root, 'anchor'), queue: join(root, 'queue') };
  const key = randomBytes(32).toString('hex');
  const env: Record<string, string> = {
    ACC_DEPLOYMENT: 'local',
    ACC_DATA_DIR: dirs.data,
    ACC_APPROVALS_DIR: dirs.ledger,
    ACC_APPROVALS_ANCHOR_DIR: dirs.anchor,
    ACC_APPROVAL_KEY: key,
    ...(opts.queue ? { ACC_QUEUE_DIR: dirs.queue } : {}),
  };
  const clock = { wall: Date.now(), mono: 1_000 };
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  const hash = await testPasswordHash();
  const config: ServerConfig = { ...loadConfig(env), admin: { email: 'admin@example.test', passwordHash: parsePasswordHash(hash) } };
  const keyProvider = createEnvKeyProvider({ ACC_APPROVAL_KEY: key });
  const openStore = (initialize: 'never' | 'if_absent' = 'never') =>
    openApprovalStore({ approvalsDir: dirs.ledger, anchorDir: dirs.anchor, keyProvider, environment: { env: {} }, initialize, now: () => clock.wall });
  const openQueue = (authority: Parameters<typeof openQueueStore>[0]['authority'], initialize: 'never' | 'if_absent' = 'never') =>
    openQueueStore({
      authority,
      queueDir: dirs.queue,
      anchorDir: dirs.anchor,
      approvalsDir: dirs.ledger,
      environment: { env: {} },
      initialize,
      now: () => clock.wall,
      loadKey: async () => deriveSubkey((await keyProvider.load()).key, QUEUE_KEY_DOMAIN),
    });
  const identity = () => createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: 'admin', passwordHash: parsePasswordHash(hash) })], now: () => clock.wall });
  const serviceOf = (store: ApprovalStore) => createApprovalService({ store, identity: identity(), policyVersion: DEFAULT_POLICY.version, now: () => clock.wall, monotonicNow: () => clock.mono });

  // Instalação nova, como na primeira subida do servidor (inclusive a reconciliação da fila).
  const first = await openStore('if_absent');
  if (opts.queue) {
    const svc = serviceOf(first);
    const authority = { status: () => svc.status(), barriers: () => svc.barriers(), engage: (i: Parameters<typeof svc.engageBarrier>[0]) => svc.engageBarrier(i) };
    const queue = await openQueue(authority, 'if_absent');
    await createBarrierGate({ authority, store: queue }).reconcile();
    await queue.close();
  }
  await first.close();
  const lineage = (JSON.parse(await readFile(join(dirs.ledger, INSTALL_FILE), 'utf8')) as { lineage: string }).lineage;

  const calls = { password: 0, phrase: 0, shown: [] as string[] };
  const promptOf = (answers: Answers = {}): ReleasePrompt => ({
    show: (lines) => {
      calls.shown.push(...lines);
    },
    password: async () => {
      calls.password += 1;
      return answers.password ?? TEST_ADMIN_PASSWORD;
    },
    line: async () => {
      calls.phrase += 1;
      return answers.phrase ?? phraseFor(lineage);
    },
  });
  const run = (answers: Answers = {}, extra: Partial<ReleaseDeps> = {}) =>
    runBarrierRelease({ config, env, prompt: promptOf(answers), now: () => clock.wall, monotonicNow: () => clock.mono, ...extra });
  const crashAt = (point: Checkpoint, effect?: () => void) => ({
    checkpoint: (p: Checkpoint) => {
      if (p === point) {
        effect?.();
        throw new Crash(p);
      }
    },
  });

  /** Lê o estado da #011 (abre e fecha; abrir inicia uma nova época, como faria o servidor). */
  const inspect = async () => {
    const store = await openStore();
    const out = {
      status: store.status(),
      global: store.status().state === 'available' ? store.ledger().barriers.global : 'unavailable',
      events: store.status().state === 'available' ? store.history().items.filter((i): i is HistoryEntry => i.kind === 'entry') : [],
      attempts: store.status().state === 'available' ? structuredClone(store.ledger().attempts) : [],
      approvals: store.status().state === 'available' ? structuredClone(store.ledger().approvals) : [],
    };
    await store.close();
    return out;
  };
  const audit = async () => {
    try {
      return (JSON.parse(await readFile(join(dirs.data, 'audit.json'), 'utf8')) as { events: Array<{ action: string; outcome: string; actor: { kind: string; id: string }; resource: { type: string; id: string | null }; context: Record<string, unknown>; at: string; seq: number }> }).events;
    } catch {
      return [];
    }
  };
  const journalExists = async () => (await readJournal(dirs.data)).kind !== 'absent';
  return { root, dirs, env, config, clock, advance, lineage, openStore, openQueue, serviceOf, identity, run, crashAt, inspect, audit, calls, journalExists };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const releaseEvents = (events: HistoryEntry[]) => events.filter((e) => e.event === 'approval.barrier_released');

/** Reaciona a barreira global com um motivo qualquer (caminho existente da #011). */
async function engage(t: Setup, reason: string) {
  const store = await t.openStore();
  await t.serviceOf(store).engageBarrier({ scope: { kind: 'global' }, actor: { kind: 'human', id: 'admin' }, reason });
  await store.close();
}

describe('F1 — aprovação autenticada de uso único', () => {
  it('libera UMA vez; histórico completo; releitura com global null; #006 com os dois registros correlacionados', async () => {
    const t = await setup();
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
    const result = await t.run();
    expect(result).toEqual({ exitCode: 0, outcome: 'released', reason: 'released' });
    const state = await t.inspect();
    expect(state.global).toBeNull();
    // Sequência requested → approved → owner_confirmed → consumed → barrier_released → attempt_succeeded.
    const own = state.events.filter((e) => e.action === 'killswitch.release' || e.event === 'approval.barrier_released' || e.event === 'approval.attempt_succeeded').map((e) => e.event);
    expect(own).toEqual(['approval.requested', 'approval.approved', 'approval.owner_confirmed', 'approval.consumed', 'approval.barrier_released', 'approval.attempt_succeeded']);
    const released = releaseEvents(state.events);
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ actor: { kind: 'human', id: 'admin' }, reason: 'human_approved', projectId: null });
    expect(state.approvals.filter((a) => a.binding.action === 'killswitch.release').map((a) => a.state)).toEqual(['consumed']);
    expect(state.attempts.map((a) => a.state)).toEqual(['succeeded']);
    // #006: confirmação + configuração, correlacionadas por approvalId e seq da #011.
    const events = await t.audit();
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['approval.confirmation', 'success'],
      ['approval.configuration', 'success'],
    ]);
    const approvalId = state.approvals.find((a) => a.binding.action === 'killswitch.release')!.id;
    expect(events[1]).toMatchObject({ actor: { kind: 'human', id: 'admin' }, resource: { type: 'approval', id: approvalId }, context: { operation: OP, seq: released[0].seq } });
    // Sem pendências: diário apagado, lock de instância liberado.
    expect(await t.journalExists()).toBe(false);
    expect(await adminReleasePending(t.dirs.data)).toBe(false);
    await expect(readFile(join(t.dirs.data, INSTANCE_LOCK_FILES.lock))).rejects.toThrow();
    // A senha nunca vai para o disco nem para a auditoria.
    for (const file of [JOURNAL_FILE, THROTTLE_FILE, 'audit.json']) {
      const text = await readFile(join(t.dirs.data, file), 'utf8').catch(() => '');
      expect(text).not.toContain(TEST_ADMIN_PASSWORD);
    }
  });

  it('a aprovação não é reutilizável: uma nova execução não encontra o que liberar e a reserva repetida é recusada', async () => {
    const t = await setup();
    await t.run();
    expect(await t.run()).toMatchObject({ exitCode: 1, outcome: 'refused', reason: 'no_global_barrier' });
    const store = await t.openStore();
    const svc = t.serviceOf(store);
    const approval = store.ledger().approvals.find((a) => a.binding.action === 'killswitch.release')!;
    const binding = globalReleaseBinding(DEFAULT_POLICY.version);
    await expect(svc.reserve({ ownerId: 'admin', approvalId: approval.id, component: 'approvals', binding })).rejects.toMatchObject({ code: 'approval_already_used' });
    await store.close();
  });
});

describe('F2 — TTLs da #011 preservados', () => {
  it('valores fixos', () => {
    expect(STEP_UP_TTL_MS).toBe(5 * MIN);
    expect(APPROVAL_TTL_MS.configuration).toBe(15 * MIN);
    expect(RECEIPT_TTL_MS).toBe(30_000);
  });

  it.each([
    ['prova vencida', 'P4' as Checkpoint, STEP_UP_TTL_MS + 1, 'step_up_expired'],
    ['aprovação vencida', 'P6' as Checkpoint, APPROVAL_TTL_MS.configuration + 1, 'approval_expired'],
    ['recibo vencido', 'P7' as Checkpoint, RECEIPT_TTL_MS + 1, 'receipt_expired'],
  ])('%s → nada liberado, diário pendente, depois reconciliado como interrompido', async (_name, point, ms, reason) => {
    const t = await setup();
    const result = await t.run({}, { checkpoint: (p) => (p === point ? t.advance(ms) : undefined) });
    expect(result).toMatchObject({ exitCode: 1, outcome: 'pending', reason });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason: 'interrupted' });
    expect(await t.journalExists()).toBe(false);
    expect((await t.audit()).at(-1)).toMatchObject({ action: 'approval.configuration', outcome: 'failure', context: { operation: OP, reason: 'interrupted' } });
    // Depois da reconciliação, uma nova execução libera normalmente.
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'released' });
  });
});

describe('F3 — apenas initial_install', () => {
  it.each(['recovery', 'queue_integrity', 'manual', 'emergency', 'audit_mirror_failed', 'desconhecido_x'])('motivo %s → recusa sem pedir senha', async (reason) => {
    const t = await setup();
    await t.run();
    await engage(t, reason);
    expect(await t.run()).toMatchObject({ exitCode: 1, outcome: 'refused', reason: 'barrier_reason_not_releasable' });
    expect(t.calls.password).toBe(1);
    expect((await t.inspect()).global).toMatchObject({ reason });
  });

  it('assessState: regras de R4 isoladas', () => {
    const base = { status: { state: 'available', reason: null }, global: { reason: 'initial_install', engagedAt: 'x' }, volatile: [], historyUnapplied: false, lineageA: '11111111-1111-4111-8111-111111111111', lineageB: '11111111-1111-4111-8111-111111111111' };
    expect(assessState(base)).toEqual({ ok: true });
    expect(assessState({ ...base, global: { reason: 'recovery', engagedAt: 'x' } })).toMatchObject({ ok: false, reason: 'barrier_reason_not_releasable' });
    expect(assessState({ ...base, global: null })).toMatchObject({ ok: false, reason: 'no_global_barrier' });
    expect(assessState({ ...base, volatile: ['global'] })).toMatchObject({ ok: false, reason: 'volatile_barrier' });
    expect(assessState({ ...base, volatile: ['project:x'] })).toMatchObject({ ok: false, reason: 'volatile_barrier' });
    expect(assessState({ ...base, historyUnapplied: true })).toMatchObject({ ok: false, reason: 'history_unapplied' });
    expect(assessState({ ...base, status: { state: 'degraded', reason: 'x' } })).toMatchObject({ ok: false, reason: 'approvals_degraded' });
    expect(assessState({ ...base, lineageB: '22222222-2222-4222-8222-222222222222' })).toMatchObject({ ok: false, reason: 'lineage_unverified' });
    expect(assessState({ ...base, lineageA: null })).toMatchObject({ ok: false, reason: 'lineage_unverified' });
  });
});

describe('F4/F5 — identidade incorreta e agentes (núcleo da #011)', () => {
  it('sessão/usuário diferentes, sujeito forjado e id de agente são recusados pelo núcleo', async () => {
    const t = await setup();
    const store = await t.openStore();
    const identity = t.identity();
    const svc = createApprovalService({ store, identity, policyVersion: DEFAULT_POLICY.version });
    const binding = globalReleaseBinding(DEFAULT_POLICY.version);
    const ctx = { userId: 'admin', sessionKey: createHash('sha256').update('a').digest('hex') };
    const other = { userId: 'admin', sessionKey: createHash('sha256').update('b').digest('hex') };
    const proof = async () => (await identity.confirm(ctx, 'password', TEST_ADMIN_PASSWORD)).proofId;
    const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof ApprovalError ? e.code : 'unexpected'));
    expect(await code(svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await proof(), identity: other }))).toBe('step_up_session_mismatch');
    expect(await code(svc.confirmOwner({ ownerId: 'admin', binding, bindingDigest: bindingDigest(binding), proofId: await proof(), identity: { ...ctx, userId: 'outro' } }))).toBe('identity_mismatch');
    const forged = { ...binding, subject: { kind: 'human' as const, id: 'outro' } };
    expect(await code(svc.confirmOwner({ ownerId: 'admin', binding: forged, bindingDigest: bindingDigest(forged), proofId: await proof(), identity: ctx }))).toBe('invalid_owner_confirmation');
    expect(await code(svc.confirmOwner({ ownerId: 'claude-code', binding, bindingDigest: bindingDigest(binding), proofId: 'x'.repeat(43), identity: { ...ctx, userId: 'claude-code' } }))).toBe('identity_invalid');
    await expect(identity.confirm({ ...ctx, userId: 'claude-code' }, 'password', TEST_ADMIN_PASSWORD)).rejects.toMatchObject({ code: 'identity_invalid' });
    expect(store.ledger().barriers.global).toMatchObject({ reason: 'initial_install' });
    await store.close();
  });
});

describe('F6 — senha incorreta', () => {
  it('recusa, conta no limite e na #006, e a barreira continua', async () => {
    const t = await setup();
    expect(await t.run({ password: 'senha-errada' })).toMatchObject({ exitCode: 1, outcome: 'refused', reason: 'step_up_failed' });
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
    const throttle = JSON.parse(await readFile(join(t.dirs.data, THROTTLE_FILE), 'utf8')) as { consecutive: number };
    expect(throttle.consecutive).toBe(1);
    expect((await t.audit()).map((e) => [e.action, e.outcome, e.context.reason])).toEqual([['approval.confirmation', 'blocked', 'step_up_failed']]);
    expect(await t.journalExists()).toBe(false);
  });

  it('cancelar no prompt (Ctrl+C) → recusa "cancelled", conta como tentativa e nada muda', async () => {
    const t = await setup();
    const prompt = { show: () => undefined, password: async () => Promise.reject(new PromptCancelled('cancelled')), line: async () => '' };
    expect(await runBarrierRelease({ config: t.config, env: t.env, prompt, now: () => t.clock.wall })).toMatchObject({ exitCode: 1, outcome: 'refused', reason: 'cancelled' });
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
    expect(JSON.parse(await readFile(join(t.dirs.data, THROTTLE_FILE), 'utf8'))).toMatchObject({ consecutive: 1 });
  });

  it('nenhum argumento ou entrada informa a senha: o prompt é a única fonte', async () => {
    const t = await setup();
    await t.run();
    expect(t.calls.password).toBe(1);
  });
});

describe('F7 — limite persistente de tentativas (R3, H2)', () => {
  it('5 falhas em execuções separadas bloqueiam por 15 min, ANTES de pedir a senha', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) {
      expect(await t.run({ password: `errada-${i}` })).toMatchObject({ reason: 'step_up_failed' });
      t.advance(MIN);
    }
    const before = t.calls.password;
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'temporarily_locked' });
    expect(t.calls.password).toBe(before);
    t.advance(15 * MIN);
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'released' });
  });

  it('matar o processo depois do registro da tentativa conta como falha', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) await t.run({}, t.crashAt('P3'));
    expect(await t.run()).toMatchObject({ reason: 'temporarily_locked' });
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
  });

  it('frase errada também conta (a senha nem é verificada)', async () => {
    const t = await setup();
    expect(await t.run({ phrase: 'LIBERAR GLOBAL 00000000' })).toMatchObject({ reason: 'phrase_mismatch' });
    expect((await t.audit()).at(-1)).toMatchObject({ action: 'approval.confirmation', outcome: 'blocked', context: { reason: 'phrase_mismatch' } });
  });

  it(`H2: ${HARD_LOCK_FAILURES} falhas seguidas → trava dura que nenhuma espera libera`, async () => {
    const t = await setup();
    await mkdir(t.dirs.data, { recursive: true });
    const old = new Date(t.clock.wall - 60 * MIN).toISOString();
    await writeFile(join(t.dirs.data, THROTTLE_FILE), JSON.stringify({ format: 'acc-admin-release-throttle', version: 1, consecutive: HARD_LOCK_FAILURES, recent: [old] }));
    expect(await t.run()).toMatchObject({ reason: 'hard_locked' });
    t.advance(24 * 60 * MIN);
    expect(await t.run()).toMatchObject({ reason: 'hard_locked' });
    expect(t.calls.password).toBe(0);
    // 19 falhas antigas ainda não travam.
    await writeFile(join(t.dirs.data, THROTTLE_FILE), JSON.stringify({ format: 'acc-admin-release-throttle', version: 1, consecutive: HARD_LOCK_FAILURES - 1, recent: [old] }));
    expect(await t.run()).toMatchObject({ outcome: 'released' });
  });

  it.each([
    ['corrompido', '{não é json'],
    ['formato desconhecido', JSON.stringify({ format: 'x', version: 1, consecutive: 0, recent: [] })],
    ['contagem negativa', JSON.stringify({ format: 'acc-admin-release-throttle', version: 1, consecutive: -1, recent: [] })],
  ])('arquivo de limite %s → recusa', async (_name, content) => {
    const t = await setup();
    await mkdir(t.dirs.data, { recursive: true });
    await writeFile(join(t.dirs.data, THROTTLE_FILE), content);
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'throttle_unreadable' });
  });

  it('relógio voltou (registro mais de 1 min no futuro) → recusa', async () => {
    const t = await setup();
    await mkdir(t.dirs.data, { recursive: true });
    await writeFile(join(t.dirs.data, THROTTLE_FILE), JSON.stringify({ format: 'acc-admin-release-throttle', version: 1, consecutive: 1, recent: [new Date(t.clock.wall + 10 * MIN).toISOString()] }));
    expect(await t.run()).toMatchObject({ reason: 'clock_moved_back' });
  });

  it('conferência cruzada: apagar o arquivo de limite não zera as falhas registradas na #006', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) await t.run({ password: `errada-${i}` });
    await rm(join(t.dirs.data, THROTTLE_FILE));
    expect(await t.run()).toMatchObject({ reason: 'temporarily_locked' });
  });

  it('falha ao gravar o limite → recusa antes de pedir a senha', async () => {
    const t = await setup();
    const ops = { ...defaultJournalOps, write: async () => Promise.reject(new Error('disk')) };
    expect(await t.run({}, { throttleOps: ops })).toMatchObject({ reason: 'throttle_write_failed' });
    expect(t.calls.password).toBe(0);
  });
});

describe('F8 — reinício (queda injetada) e reconciliação determinística (R2)', () => {
  it.each([
    ['P5', 'interrupted'],
    ['P6', 'interrupted'],
    ['P7', 'interrupted'],
    ['P8', 'interrupted'],
  ])('queda depois de %s → nada liberado; reconciliação registra %s', async (point, reason) => {
    const t = await setup();
    expect(await t.run({}, t.crashAt(point as Checkpoint))).toMatchObject({ exitCode: 1, outcome: 'pending' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    const mid = await t.inspect();
    expect(mid.global).toMatchObject({ reason: 'initial_install' });
    expect(mid.approvals.filter((a) => a.state === 'approved')).toEqual([]);
    expect(mid.attempts.filter((a) => a.state === 'reserved' || a.state === 'succeeded')).toEqual([]);
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason });
    expect(await adminReleasePending(t.dirs.data)).toBe(false);
    expect(await t.run()).toMatchObject({ outcome: 'released' });
  });

  it.each(['P9', 'P10', 'P11', 'P12'])('queda depois de %s → liberação vale na #011; código 3; reconciliação completa a #006', async (point) => {
    const t = await setup();
    expect(await t.run({}, t.crashAt(point as Checkpoint))).toMatchObject({ exitCode: 3, outcome: 'audit_pending' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    expect((await t.inspect()).global).toBeNull();
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason: 'reconciled' });
    // Exatamente UM registro final na #006 (idempotente: depois do P12 o original já existia).
    const finals = (await t.audit()).filter((e) => e.action === 'approval.configuration');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ outcome: 'success', context: { operation: OP, seq: releaseEvents((await t.inspect()).events)[0].seq } });
    expect(finals[0].context.reason).toBe(point === 'P12' ? undefined : 'reconciled');
    expect(await t.journalExists()).toBe(false);
  });

  it('falha ao apagar o diário na reconciliação → recusa; a próxima não duplica o registro', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P6'));
    const stuck = { ...defaultJournalOps, remove: async () => Promise.reject(new Error('EBUSY')) };
    expect(await t.run({}, { journalOps: stuck })).toMatchObject({ exitCode: 1, reason: 'reconcile_journal_remove_failed' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason: 'interrupted' });
    expect((await t.audit()).filter((e) => e.action === 'approval.configuration' && e.context.reason === 'interrupted')).toHaveLength(1);
  });

  it('diário ilegível → recusa e o servidor continua vendo pendência', async () => {
    const t = await setup();
    await mkdir(t.dirs.data, { recursive: true });
    await writeFile(join(t.dirs.data, JOURNAL_FILE), '{lixo');
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'journal_unreadable' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
  });

  it('divergência (diário committed, barreira ainda ativa) → recusa e mantém o diário', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P10'));
    await engage(t, 'manual');
    // O diário diz "committed", mas agora a barreira global existe de novo: não há reconciliação automática.
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'reconcile_divergence' });
    expect(await t.journalExists()).toBe(true);
  });

  it('diário de outra linhagem → recusa', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P5'));
    const path = join(t.dirs.data, JOURNAL_FILE);
    const doc = JSON.parse(await readFile(path, 'utf8')) as { lineage: string };
    doc.lineage = '99999999-9999-4999-8999-999999999999';
    await writeFile(path, JSON.stringify(doc));
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'reconcile_lineage_mismatch' });
  });
});

describe('F9 — falha de armazenamento da #011', () => {
  it.each([
    ['histórico', 'approvals-history.json', 'interrupted', null],
    ['ledger', LEDGER_FILE, 'interrupted', null],
    ['anchor', ANCHOR_FILE, 'reconciled', 'released_on_disk'],
  ])('falha ao gravar o %s na liberação → INDETERMINADO (código 4); reconciliação determinística', async (_name, file, reason, disk) => {
    const t = await setup();
    let armed = false;
    const approvalsWriteFile = async (path: string, content: string) => {
      if (armed && path.endsWith(file)) throw new Error('disk_full');
      return writeFileAtomic(path, content);
    };
    const result = await t.run({}, { approvalsWriteFile, checkpoint: (p) => void (p === 'P8' ? (armed = true) : undefined) });
    // L1: a gravação começou e falhou; o comando não afirma "não liberada" (no anchor, ela foi).
    expect(result).toEqual({ exitCode: 4, outcome: 'indeterminate', reason: 'store_write_failed' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    const state = await t.inspect();
    if (disk) expect(state.global).toBeNull(); // ledger gravado, anchor não: a abertura aceita a geração seguinte.
    else expect(state.global).toMatchObject({ reason: 'initial_install' });
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason });
    // Recuperação idempotente: o cruzamento fica consistente e a reconciliação repetida não grava nada.
    expect((await facts(t)).check.state).toBe('consistent');
    const before = (await t.audit()).length;
    const again = await t.run();
    expect(again.reason).toBe(disk ? 'no_global_barrier' : 'released');
    if (disk) expect((await t.audit()).length).toBe(before);
  });
});

describe('L1 — falha comprovada × resultado incerto', () => {
  it('recusa do núcleo ANTES de gravar (recibo vencido) → NÃO LIBERADA (código 1), nunca indeterminado', async () => {
    const t = await setup();
    const result = await t.run({}, { checkpoint: (p) => void (p === 'P8' ? t.advance(RECEIPT_TTL_MS + 1_000) : undefined) });
    expect(result.exitCode).toBe(1);
    expect(result.outcome).toBe('pending');
    expect(result.reason).not.toBe('store_write_failed');
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason: 'interrupted' });
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'released' });
  });

  it('releitura contradiz o commit (store ilegível na reabertura) → INDETERMINADO; nada é afirmado nem reconciliado sozinho', async () => {
    const t = await setup();
    const result = await t.run({}, { checkpoint: async (p) => { if (p === 'P10') await writeFile(join(t.dirs.ledger, LEDGER_FILE), '{adulterado'); } });
    expect(result).toEqual({ exitCode: 4, outcome: 'indeterminate', reason: 'release_not_durable' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    expect(await t.run()).toMatchObject({ exitCode: 1 });
    expect(await t.journalExists()).toBe(true);
    expect((await t.audit()).filter((e) => e.action === 'approval.configuration')).toEqual([]);
  });

  it('queda depois do commit continua código 3 (a liberação foi confirmada pelo núcleo)', async () => {
    const t = await setup();
    expect(await t.run({}, t.crashAt('P9'))).toMatchObject({ exitCode: 3, outcome: 'audit_pending' });
  });
});

describe('F10 — falha de auditoria', () => {
  const failingAudit = (when: () => boolean) => async (path: string, content: string) => {
    if (when()) throw new Error('audit_disk');
    return writeFileAtomic(path, content);
  };

  it('auditoria não grava no P4 → aborta antes da #011', async () => {
    const t = await setup();
    expect(await t.run({}, { auditWriteFile: failingAudit(() => true) })).toMatchObject({ exitCode: 1, outcome: 'refused', reason: 'audit_unavailable' });
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
    expect(await t.journalExists()).toBe(false);
  });

  it('auditoria não grava no P12 → código 3, servidor vê pendência, reconciliação depois completa', async () => {
    const t = await setup();
    let armed = false;
    const result = await t.run({}, { auditWriteFile: failingAudit(() => armed), checkpoint: (p) => void (p === 'P11' ? (armed = true) : undefined) });
    expect(result).toMatchObject({ exitCode: 3, outcome: 'audit_pending' });
    expect(await adminReleasePending(t.dirs.data)).toBe(true);
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'reconciled', reason: 'reconciled' });
  });

  it('auditoria ilegível na abertura → recusa', async () => {
    const t = await setup();
    await mkdir(t.dirs.data, { recursive: true });
    await writeFile(join(t.dirs.data, 'audit.json'), '{corrompido');
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'data_files_unavailable' });
  });
});

describe('F11/F12 — concorrência e lock de instância', () => {
  it('com outra instância ativa (servidor ou comando) → recusa antes de abrir qualquer arquivo', async () => {
    const t = await setup();
    const lock = await acquireInstanceLock(t.dirs.data);
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'instance_locked' });
    expect(t.calls.password).toBe(0);
    await expect(readFile(join(t.dirs.data, 'audit.json'))).rejects.toThrow();
    await lock.release();
    expect(await t.run()).toMatchObject({ outcome: 'released' });
  });

  it('duas execuções simultâneas: só uma prossegue', async () => {
    const t = await setup();
    const results = await Promise.all([t.run(), t.run()]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['refused', 'released']);
    expect(results.find((r) => r.outcome === 'refused')!.reason).toMatch(/instance_locked|approvals_store_locked/);
    expect(releaseEvents((await t.inspect()).events)).toHaveLength(1);
  });

  const writeLock = async (t: Setup, content: string) => {
    await mkdir(t.dirs.data, { recursive: true });
    await writeFile(join(t.dirs.data, INSTANCE_LOCK_FILES.lock), content);
  };
  const lockOf = (pid: number, host = hostname()) => JSON.stringify({ pid, host, nonce: randomBytes(16).toString('hex'), at: new Date().toISOString() });

  it('lock órfão (processo morto, mesma máquina) → retomada automática', async () => {
    const t = await setup();
    await writeLock(t, lockOf(process.pid + 100_000));
    expect(await t.run({}, { alive: () => false })).toMatchObject({ outcome: 'released' });
  });

  it.each([
    ['processo vivo', lockOf(process.pid + 100_000), () => true],
    ['outra máquina', lockOf(process.pid + 100_000, 'outra-maquina'), () => false],
    ['conteúdo ilegível', 'lixo', () => false],
    ['mesmo pid (reutilizado)', lockOf(process.pid), () => false],
  ])('lock ambíguo (%s) → recusa e o lock NÃO é removido', async (_name, content, alive) => {
    const t = await setup();
    await writeLock(t, content);
    expect(await t.run({}, { alive })).toMatchObject({ exitCode: 1, reason: 'instance_locked' });
    expect(await readFile(join(t.dirs.data, INSTANCE_LOCK_FILES.lock), 'utf8')).toBe(content);
  });
});

describe('F13 — fila divergente', () => {
  it('fila saudável → libera', async () => {
    const t = await setup({ queue: true });
    expect(await t.run()).toMatchObject({ outcome: 'released' });
  });

  it('fila configurada mas ausente → recusa', async () => {
    const t = await setup({ queue: true });
    await rm(t.dirs.queue, { recursive: true, force: true });
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: expect.stringMatching(/^queue_/) });
  });

  it('pedido de barreira pendente na fila → a reconciliação o aplica e o comando recusa', async () => {
    const t = await setup({ queue: true });
    const queue = await t.openQueue(null);
    await queue.recordBarrierRequest({ kind: 'global' }, 'queue_integrity');
    await queue.close();
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'queue_barrier_applied' });
  });

  it('configuração da fila inválida → recusa', async () => {
    const t = await setup();
    const config = { ...t.config, queue: { state: 'invalid' as const, reason: 'x' } };
    expect(await runBarrierRelease({ config, env: t.env, prompt: { show: () => undefined, password: async () => '', line: async () => '' } })).toMatchObject({ reason: 'queue_config_invalid' });
  });
});

describe('F15/F16 — linhagem e anchor', () => {
  it('frase com a linhagem errada → recusa', async () => {
    const t = await setup();
    expect(await t.run({ phrase: phraseFor('00000000-0000-4000-8000-000000000000') })).toMatchObject({ reason: 'phrase_mismatch' });
    expect(await t.run({ phrase: 'liberar global' })).toMatchObject({ reason: 'phrase_mismatch' });
  });

  it.each([
    ['anchor ausente', async (t: Setup) => rm(join(t.dirs.anchor, ANCHOR_FILE))],
    ['anchor adulterado', async (t: Setup) => {
      const path = join(t.dirs.anchor, ANCHOR_FILE);
      const doc = JSON.parse(await readFile(path, 'utf8')) as { epoch: number };
      doc.epoch += 5;
      await writeFile(path, JSON.stringify(doc));
    }],
    ['marcador de outra linhagem', async (t: Setup) => {
      const path = join(t.dirs.anchor, INSTALL_FILE);
      const doc = JSON.parse(await readFile(path, 'utf8')) as { lineage: string };
      doc.lineage = '99999999-9999-4999-8999-999999999999';
      await writeFile(path, JSON.stringify(doc));
    }],
    ['armazenamento ausente (não é criado)', async (t: Setup) => {
      await rm(t.dirs.ledger, { recursive: true, force: true });
      await rm(t.dirs.anchor, { recursive: true, force: true });
      await mkdir(t.dirs.ledger, { recursive: true });
      await mkdir(t.dirs.anchor, { recursive: true });
    }],
  ])('%s → store indisponível e recusa', async (_name, tamper) => {
    const t = await setup();
    await tamper(t);
    const result = await t.run();
    expect(result).toMatchObject({ exitCode: 1, outcome: 'refused', reason: expect.stringMatching(/^approvals_/) });
    expect(t.calls.password).toBe(0);
  });

  it('F21: o comando nunca cria um armazenamento ausente', async () => {
    const t = await setup();
    await rm(t.dirs.ledger, { recursive: true, force: true });
    await rm(t.dirs.anchor, { recursive: true, force: true });
    await mkdir(t.dirs.ledger, { recursive: true });
    await mkdir(t.dirs.anchor, { recursive: true });
    expect(await t.run()).toMatchObject({ reason: 'approvals_store_not_initialized' });
    await expect(readFile(join(t.dirs.ledger, LEDGER_FILE))).rejects.toThrow();
  });

  it('openedWithUnapplied detecta só a abertura atual', () => {
    const e = (event: string) => ({ event }) as HistoryEntry;
    expect(openedWithUnapplied([e('approval.store_initialized'), e('approval.store_opened')])).toBe(false);
    expect(openedWithUnapplied([e('approval.store_opened'), e('approval.history_unapplied'), e('approval.store_opened')])).toBe(true);
    expect(openedWithUnapplied([e('approval.history_unapplied'), e('approval.store_opened'), e('approval.store_opened')])).toBe(false);
  });
});

describe('F17/F19/F20 — reacionamento, nenhuma execução e as aprovações da #008', () => {
  it('depois da liberação, a barreira pode ser reacionada pelos caminhos existentes e volta a bloquear', async () => {
    const t = await setup();
    await t.run();
    await engage(t, 'manual');
    const store = await t.openStore();
    const svc = t.serviceOf(store);
    expect(svc.barriers().durable.global).toMatchObject({ reason: 'manual' });
    await store.close();
    expect(await t.run()).toMatchObject({ reason: 'barrier_reason_not_releasable' });
  });

  it('execução real continua desligada; a liberação não cria aprovações de execução', async () => {
    const t = await setup();
    await t.run();
    expect(REAL_EXECUTION_ENABLED).toBe(false);
    const state = await t.inspect();
    expect(state.approvals.map((a) => a.binding.action)).toEqual(['killswitch.release']);
    expect(state.approvals.every((a) => a.class === 'configuration')).toBe(true);
  });

  it('ambiente: exige ACC_DEPLOYMENT=local, recusa NODE_ENV=production e exige administrador e aprovações', async () => {
    const t = await setup();
    const prompt = { show: () => undefined, password: async () => TEST_ADMIN_PASSWORD, line: async () => phraseFor(t.lineage) };
    expect(await runBarrierRelease({ config: { ...t.config, deployment: 'production' }, env: t.env, prompt })).toMatchObject({ reason: 'deployment_not_local' });
    expect(await runBarrierRelease({ config: { ...t.config, deployment: null }, env: t.env, prompt })).toMatchObject({ reason: 'deployment_not_local' });
    expect(await runBarrierRelease({ config: t.config, env: { ...t.env, NODE_ENV: 'production' }, prompt })).toMatchObject({ reason: 'node_env_production' });
    expect(await runBarrierRelease({ config: { ...t.config, admin: null }, env: t.env, prompt })).toMatchObject({ reason: 'admin_not_configured' });
    expect(await runBarrierRelease({ config: { ...t.config, approvals: { state: 'disabled' } }, env: t.env, prompt })).toMatchObject({ reason: 'approvals_disabled' });
    expect((await t.inspect()).global).toMatchObject({ reason: 'initial_install' });
  });
});

// ── L3: cruzamento #011 × #006 ─────────────────────────────────────────────────────────────────

type AuditDoc = { format: string; version: number; events: Array<Record<string, unknown> & { seq: number; at: string; context: Record<string, unknown>; resource: { type: string; id: string | null }; actor: { kind: string; id: string } }>; droppedEvents: number };

/** Lê os fatos (#011 e #006) e o veredito do cruzamento, como o servidor faz na subida. */
async function facts(t: Setup, dataDir = t.dirs.data) {
  const store = await t.openStore();
  const history = structuredClone(store.history());
  await store.close();
  const audit = JSON.parse(await readFile(join(dataDir, 'audit.json'), 'utf8')) as AuditDoc;
  const check = checkReleaseAudit(history, { events: audit.events as never, droppedEvents: audit.droppedEvents });
  return { history, audit, check, releases: releaseEvents(history.items.filter((i): i is HistoryEntry => i.kind === 'entry')) };
}

async function editAudit(t: Setup, edit: (doc: AuditDoc) => void, dataDir = t.dirs.data) {
  const path = join(dataDir, 'audit.json');
  const doc = JSON.parse(await readFile(path, 'utf8')) as AuditDoc;
  edit(doc);
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}

const finalRecord = (doc: AuditDoc) => doc.events.find((e) => e.action === 'approval.configuration' && e.outcome === 'success')!;
/** Cópia de um evento com novo id e próximo seq (o arquivo exige ids únicos e seq crescente). */
const cloneEvent = (doc: AuditDoc, base: AuditDoc['events'][number], change: (e: AuditDoc['events'][number]) => void) => {
  const copy = structuredClone(base);
  copy.id = randomUUID();
  copy.seq = doc.events[doc.events.length - 1].seq + 1;
  change(copy);
  doc.events.push(copy);
};

describe('L3 — cruzamento #011 × #006 (identidade, escopo e correlação)', () => {
  it('instalação nova e histórico legítimo sem liberação → consistente (compatibilidade)', async () => {
    const t = await setup();
    await mkdir(t.dirs.data, { recursive: true });
    // Primeira execução recusada (frase errada) grava só eventos de confirmação: nada a cruzar.
    await t.run({ phrase: 'errada' });
    await engage(t, 'manual');
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 0 });
  });

  it('liberação completa → consistente; reinicializações sucessivas não mudam o veredito', async () => {
    const t = await setup();
    await t.run();
    for (let i = 0; i < 3; i += 1) expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
  });

  it('registro final ausente (diário apagado) → missing; o comando reconcilia pelos fatos; a repetição não duplica nem libera', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P11'));
    await rm(join(t.dirs.data, JOURNAL_FILE));
    expect(await adminReleasePending(t.dirs.data)).toBe(false); // o diário sumiu...
    const gap = await facts(t);
    expect(gap.check).toMatchObject({ state: 'missing', missing: [{ seq: gap.releases[0].seq }] }); // ...mas o cruzamento vê
    for (let i = 0; i < 2; i += 1) expect((await facts(t)).check.state).toBe('missing'); // reinícios: continua pendente
    expect(await t.run()).toEqual({ exitCode: 0, outcome: 'reconciled', reason: 'reconciled_from_facts' });
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
    const finals = (await t.audit()).filter((e) => e.action === 'approval.configuration');
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ outcome: 'success', context: { operation: OP, reason: 'reconciled_from_facts', seq: gap.releases[0].seq } });
    // Reconciliação repetida: nada mais a fazer; nenhum registro novo; nenhuma aprovação criada.
    const before = await t.inspect();
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'no_global_barrier' });
    expect((await t.audit()).filter((e) => e.action === 'approval.configuration')).toHaveLength(1);
    expect((await t.inspect()).approvals.length).toBe(before.approvals.length);
  });

  it('diário apagado numa operação INTERROMPIDA antes da liberação → consistente; a próxima execução libera normalmente', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P7'));
    await rm(join(t.dirs.data, JOURNAL_FILE));
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 0 });
    expect(await t.run()).toMatchObject({ exitCode: 0, outcome: 'released' });
  });

  it.each([
    ['seq trocado com a mesma aprovação', (e: AuditDoc['events'][number]) => void (e.context.seq = (e.context.seq as number) + 1)],
    ['ator agente', (e: AuditDoc['events'][number]) => void (e.actor = { kind: 'agent', id: 'admin' })],
    ['outro dono', (e: AuditDoc['events'][number]) => void (e.ownerId = 'outro')],
    ['tipo de recurso trocado', (e: AuditDoc['events'][number]) => void (e.resource.type = 'project')],
    ['com projeto', (e: AuditDoc['events'][number]) => void (e.projectId = randomUUID())],
    ['resultado de falha', (e: AuditDoc['events'][number]) => void (e.outcome = 'failure')],
  ])('registro da MESMA aprovação adulterado (%s) → inconsistente; o comando recusa sem gravar e sem liberar', async (_name, tamper) => {
    const t = await setup();
    await t.run();
    await editAudit(t, (doc) => tamper(finalRecord(doc)));
    expect((await facts(t)).check).toEqual({ state: 'inconsistent', reason: 'audit_record_mismatch' });
    await engage(t, 'manual');
    const count = (await t.audit()).length;
    expect(await t.run()).toMatchObject({ exitCode: 1, outcome: 'refused', reason: 'consistency_audit_record_mismatch' });
    expect((await t.audit()).length).toBe(count);
    expect((await t.inspect()).global).toMatchObject({ reason: 'manual' });
  });

  it('registro de OUTRA aprovação com seq coincidente → ignorado: não valida (missing); o comando grava o correto e o outro continua sem validar', async () => {
    const t = await setup();
    await t.run();
    await editAudit(t, (doc) => void (finalRecord(doc).resource.id = randomUUID()));
    expect((await facts(t)).check.state).toBe('missing');
    expect(await t.run()).toEqual({ exitCode: 0, outcome: 'reconciled', reason: 'reconciled_from_facts' });
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
    expect((await t.audit()).filter((e) => e.action === 'approval.configuration')).toHaveLength(2);
  });

  it('registro duplicado → inconsistente (nunca gravado pela reconciliação idempotente)', async () => {
    const t = await setup();
    await t.run();
    await editAudit(t, (doc) => cloneEvent(doc, finalRecord(doc), () => undefined));
    expect((await facts(t)).check).toEqual({ state: 'inconsistent', reason: 'audit_record_duplicate' });
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'consistency_audit_record_duplicate' });
  });

  it.each([
    ['anterior', -86_400_000],
    ['posterior (relógio adiantado na linhagem antiga)', 3_600_000],
  ])('registro de outra linhagem com seq coincidente, %s à liberação → não conta e não bloqueia', async (_name, offset) => {
    const t = await setup();
    await t.run({}, t.crashAt('P11'));
    await rm(join(t.dirs.data, JOURNAL_FILE));
    const { releases } = await facts(t);
    await editAudit(t, (doc) => {
      const base = doc.events.find((e) => e.action === 'approval.confirmation')!;
      cloneEvent(doc, base, (e) => {
        e.action = 'approval.configuration';
        e.resource = { type: 'approval', id: randomUUID() };
        e.context = { operation: OP, seq: releases[0].seq };
        e.at = new Date(Date.parse(releases[0].at) + offset).toISOString();
      });
    });
    expect((await facts(t)).check.state).toBe('missing');
    expect(await t.run()).toMatchObject({ outcome: 'reconciled', reason: 'reconciled_from_facts' });
    expect((await facts(t)).check.state).toBe('consistent');
  });

  it('C1: registro final ausente continua missing mesmo com descarte e só eventos posteriores (sem tolerância à retenção)', async () => {
    const t = await setup();
    await t.run();
    const { releases } = await facts(t);
    await editAudit(t, (doc) => {
      doc.events = doc.events.filter((e) => e.action !== 'approval.configuration');
      for (const e of doc.events) e.at = new Date(Date.parse(releases[0].at) + 60_000).toISOString();
      doc.droppedEvents = 45_000;
    });
    expect((await facts(t)).check.state).toBe('missing');
    expect(await t.run()).toMatchObject({ outcome: 'reconciled', reason: 'reconciled_from_facts' });
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
  });

  it('C2: relógio atrasado e depois adiantado → registro conta pela aprovação; reconciliações sucessivas não duplicam', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P11'));
    await rm(join(t.dirs.data, JOURNAL_FILE));
    const { releases } = await facts(t);
    t.clock.wall -= 3_600_000; // relógio volta 1 h: o registro fica "anterior" à liberação
    expect(await t.run()).toEqual({ exitCode: 0, outcome: 'reconciled', reason: 'reconciled_from_facts' });
    const finals = () => t.audit().then((events) => events.filter((e) => e.action === 'approval.configuration'));
    expect(Date.parse((await finals())[0].at)).toBeLessThan(Date.parse(releases[0].at));
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
    for (const jump of [0, 7_200_000, 86_400_000]) {
      t.clock.wall += jump; // relógio corrigido e adiantado
      expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'no_global_barrier' });
      expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
    }
    expect(await finals()).toHaveLength(1);
  });

  it('falha de leitura (auditoria malformada em memória) → inconsistente; auditoria ilegível no disco → o comando recusa', async () => {
    const t = await setup();
    await t.run();
    const { history } = await facts(t);
    expect(checkReleaseAudit(history, { events: null as never, droppedEvents: 0 })).toEqual({ state: 'inconsistent', reason: 'check_failed' });
    expect(checkReleaseAudit({ items: null as never }, { events: [], droppedEvents: 0 })).toEqual({ state: 'inconsistent', reason: 'check_failed' });
    await writeFile(join(t.dirs.data, 'audit.json'), '{ilegível');
    expect(await t.run()).toMatchObject({ exitCode: 1, reason: 'data_files_unavailable' });
  });

  it('divergência entre diretórios: outro ACC_DATA_DIR sobre as MESMAS aprovações vê a lacuna e reconcilia na própria #006', async () => {
    const t = await setup();
    await t.run();
    const otherData = join(t.root, 'data-b');
    const configB: ServerConfig = { ...loadConfig({ ...t.env, ACC_DATA_DIR: otherData }), admin: t.config.admin };
    const prompt: ReleasePrompt = { show: () => undefined, password: async () => TEST_ADMIN_PASSWORD, line: async () => phraseFor(t.lineage) };
    const runB = () => runBarrierRelease({ config: configB, env: { ...t.env, ACC_DATA_DIR: otherData }, prompt, now: () => t.clock.wall, monotonicNow: () => t.clock.mono });
    expect(await adminReleasePending(otherData)).toBe(false);
    expect(await runB()).toEqual({ exitCode: 0, outcome: 'reconciled', reason: 'reconciled_from_facts' });
    expect((await facts(t, otherData)).check).toEqual({ state: 'consistent', releases: 1 });
    expect((await facts(t)).check).toEqual({ state: 'consistent', releases: 1 });
    expect(await runB()).toMatchObject({ exitCode: 1, reason: 'no_global_barrier' });
  });
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

/** Servidor real (processo filho, loopback, sem credenciais) sobre os diretórios do teste. */
async function startServer(t: Setup, dataDir = t.dirs.data) {
  const cwd = await mkdtemp(join(tmpdir(), 'acc-l3-cwd-'));
  roots.push(cwd);
  const env: Record<string, string> = { ...t.env, ACC_DATA_DIR: dataDir, API_PORT: String(await freePort()) };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name]!;
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', resolve('server/index.ts')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', (c) => (output += c));
  child.stderr!.on('data', (c) => (output += c));
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const started = await new Promise<boolean>((r) => {
    const timer = setInterval(() => {
      if (output.includes('Servidor iniciado')) {
        clearInterval(timer);
        r(true);
      }
    }, 25);
    void exited.then(() => {
      clearInterval(timer);
      r(false);
    });
  });
  child.kill('SIGKILL');
  await exited;
  return { started, output };
}

describe('L3 — servidor real: aprovações indisponíveis enquanto houver lacuna', { timeout: 90_000 }, () => {
  it('lacuna (diário apagado) → admin_reconcile_pending; adulteração → admin_audit_inconsistent; conciliado → aprovações abertas', async () => {
    const t = await setup();
    await t.run({}, t.crashAt('P11'));
    await rm(join(t.dirs.data, JOURNAL_FILE));

    const gap = await startServer(t);
    expect(gap.started).toBe(true);
    expect(gap.output).toContain('admin_reconcile_pending');
    expect(gap.output).not.toContain('approvals_opened');

    // Outro ACC_DATA_DIR sobre as mesmas aprovações: a lacuna também aparece (não depende do diário).
    const other = await startServer(t, join(t.root, 'data-b'));
    expect(other.output).toContain('admin_reconcile_pending');

    expect(await t.run()).toMatchObject({ outcome: 'reconciled', reason: 'reconciled_from_facts' });
    const ok = await startServer(t);
    expect(ok.output).toContain('approvals_opened');
    expect(ok.output).not.toContain('admin_reconcile_pending');

    await editAudit(t, (doc) => void (finalRecord(doc).context.seq = 999_999));
    const bad = await startServer(t);
    expect(bad.output).toContain('admin_audit_inconsistent');
    expect(bad.output).not.toContain('approvals_opened');
  });
});
