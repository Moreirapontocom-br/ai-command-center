// @vitest-environment node
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPasswordConfirmer, createStepUpRegistry } from '../approvals/identity.ts';
import { createEnvKeyProvider } from '../approvals/keyProvider.ts';
import { createApprovalService } from '../approvals/service.ts';
import { openApprovalStore, type ApprovalStore } from '../approvals/store.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { writeFileAtomic, type WriteFile } from '../storage/jsonFile.ts';
import { deriveSubkey } from '../storage/subkeys.ts';
import { createQueueHarness, PROJECT, PROJECT_B, queueCode, type QueueHarness } from '../test/queueFixtures.ts';
import { createBarrierGate, type BarrierAuthority } from './barrierGate.ts';
import type { BarrierScope } from './contracts.ts';

const harnesses: QueueHarness[] = [];
const approvalStores: ApprovalStore[] = [];
afterEach(async () => {
  for (const store of approvalStores.splice(0)) await store.close();
  for (const h of harnesses.splice(0)) await h.cleanup();
});
async function setup() {
  const h = await createQueueHarness('acc-gate-');
  harnesses.push(h);
  return h;
}

/** Autoridade simulada, com cada fonte de bloqueio controlável. */
function fakeAuthority() {
  const state = {
    status: { state: 'available' as 'available' | 'degraded' | 'unavailable', reason: null as string | null },
    global: null as object | null,
    projects: {} as Record<string, object>,
    volatile: [] as string[],
    engageFails: false,
    engageIgnored: false,
    barriersThrow: false,
    calls: [] as Array<{ scope: BarrierScope; actor: { kind: string; id: string }; reason: string }>,
  };
  const authority: BarrierAuthority = {
    status: () => state.status,
    barriers: () => {
      if (state.barriersThrow) throw new Error('consulta falhou');
      return { durable: { global: state.global, projects: state.projects }, volatile: state.volatile };
    },
    async engage(input) {
      state.calls.push(structuredClone(input));
      if (state.engageFails) throw new Error('gravação falhou');
      if (state.engageIgnored) return;
      const barrier = { engagedAt: 'x', epoch: 1, reason: input.reason };
      if (input.scope.kind === 'global') state.global = barrier;
      else state.projects[input.scope.projectId] = barrier;
    },
  };
  /** Liberação HUMANA na autoridade (simulada): o único caminho que abre. */
  const release = () => {
    state.global = null;
    state.projects = {};
  };
  return { state, authority, release };
}

describe('portão de barreira — decisões (D3)', () => {
  it('linhagem nova nasce bloqueada; reconcile aciona a barreira global e só a liberação na autoridade abre', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const { state, authority, release } = fakeAuthority();
    const gate = createBarrierGate({ authority, store });
    expect(gate.check(null)).toEqual({ open: false, reason: 'queue_barrier_pending' });
    expect(await gate.reconcile()).toEqual({ confirmed: 1, failed: 0 });
    expect(state.calls).toEqual([{ scope: { kind: 'global' }, actor: { kind: 'system', id: 'acc-queue' }, reason: 'queue_initial_install' }]);
    expect(store.pendingBarriers()).toEqual([]);
    expect(store.history().map((e) => e.data.event)).toContain('queue.barrier_confirmed');
    // O pedido foi confirmado, mas a autoridade continua bloqueando.
    expect(gate.check(null)).toEqual({ open: false, reason: 'global_barrier' });
    expect(() => gate.assertOpen(null)).toThrow('execution_blocked');
    release();
    expect(gate.check(PROJECT)).toEqual({ open: true });
    expect(() => gate.assertOpen(PROJECT)).not.toThrow();
  });

  it('cada fonte bloqueia sozinha (fail-closed)', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const { state, authority } = fakeAuthority();
    await createBarrierGate({ authority, store }).reconcile();
    state.global = null;
    let kill: boolean | 'throw' = false;
    const gate = createBarrierGate({
      authority,
      store,
      controllerKillSwitch: () => {
        if (kill === 'throw') throw new Error('x');
        return kill;
      },
    });
    expect(gate.check(PROJECT)).toEqual({ open: true });
    const cases: Array<[() => void, () => void, string]> = [
      [() => (state.status = { state: 'degraded', reason: 'write_failed' }), () => (state.status = { state: 'available', reason: null }), 'authority_degraded'],
      [() => (state.status = { state: 'unavailable', reason: 'mac_invalid' }), () => (state.status = { state: 'available', reason: null }), 'authority_unavailable'],
      [() => (state.global = {}), () => (state.global = null), 'global_barrier'],
      [() => (state.projects = { [PROJECT]: {} }), () => (state.projects = {}), 'project_barrier'],
      [() => (state.volatile = ['global']), () => (state.volatile = []), 'volatile_barrier'],
      [() => (state.volatile = [`project:${PROJECT}`]), () => (state.volatile = []), 'volatile_barrier'],
      [() => (kill = true), () => (kill = false), 'controller_kill_switch'],
      [() => (kill = 'throw'), () => (kill = false), 'query_failed'],
      [() => (state.barriersThrow = true), () => (state.barriersThrow = false), 'query_failed'],
    ];
    for (const [engage, undo, reason] of cases) {
      engage();
      expect(gate.check(PROJECT)).toEqual({ open: false, reason });
      undo();
    }
    // Barreira de OUTRO projeto não bloqueia este; global bloqueia todos.
    state.projects = { [PROJECT_B]: {} };
    expect(gate.check(PROJECT)).toEqual({ open: true });
    expect(gate.check(PROJECT_B)).toEqual({ open: false, reason: 'project_barrier' });
    // Sem autoridade ou sem fila: bloqueado.
    expect(createBarrierGate({ authority: null, store }).check(null)).toEqual({ open: false, reason: 'authority_missing' });
    expect(createBarrierGate({ authority, store: null }).check(null)).toEqual({ open: false, reason: 'queue_store_missing' });
    // Resposta com formato inesperado → bloqueado.
    const odd = { ...authority, barriers: () => ({ durable: null }) as never };
    expect(createBarrierGate({ authority: odd, store }).check(null)).toEqual({ open: false, reason: 'authority_unexpected' });
    // Fila indisponível ou degradada → bloqueado.
    await store.close();
    expect(gate.check(PROJECT)).toEqual({ open: false, reason: 'queue_store_unavailable' });
  });

  it('acionamento: grava o pedido ANTES; falha da autoridade mantém bloqueado e o pedido sobrevive ao reinício', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const { state, authority, release } = fakeAuthority();
    await createBarrierGate({ authority, store }).reconcile();
    release();
    const gate = createBarrierGate({ authority, store });
    expect(gate.check(PROJECT)).toEqual({ open: true });
    state.engageFails = true;
    expect(await gate.engage({ kind: 'project', projectId: PROJECT }, 'manual_stop')).toEqual({ durable: false, recorded: true });
    expect(gate.check(PROJECT)).toEqual({ open: false, reason: 'queue_barrier_pending' });
    expect(gate.check(PROJECT_B)).toEqual({ open: true }); // escopo de projeto
    await store.close();

    // Reinício: o pedido continua gravado; ao reconciliar, é reenviado à autoridade.
    const again = await h.open();
    const gate2 = createBarrierGate({ authority, store: again });
    expect(gate2.check(PROJECT)).toEqual({ open: false, reason: 'queue_barrier_pending' });
    expect(await gate2.reconcile()).toEqual({ confirmed: 0, failed: 1 });
    expect(again.pendingBarriers()).toHaveLength(1);
    state.engageFails = false;
    expect(await gate2.reconcile()).toEqual({ confirmed: 1, failed: 0 });
    expect(again.pendingBarriers()).toHaveLength(0);
    expect(gate2.check(PROJECT)).toEqual({ open: false, reason: 'project_barrier' });
  });

  it('autoridade que "aceita" mas não confirma a barreira durável → pedido mantido, bloqueado', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const { state, authority } = fakeAuthority();
    state.engageIgnored = true;
    const gate = createBarrierGate({ authority, store });
    expect(await gate.reconcile()).toEqual({ confirmed: 0, failed: 1 });
    expect(store.pendingBarriers()).toHaveLength(1);
    expect(gate.check(null)).toEqual({ open: false, reason: 'queue_barrier_pending' });
  });

  it('falha ao gravar o pedido na fila: fila degradada (bloqueada) e a autoridade é acionada mesmo assim', async () => {
    const h = await setup();
    const ctl = { fail: false };
    const write: WriteFile = async (path, content) => {
      if (ctl.fail) throw new Error('EIO');
      await writeFileAtomic(path, content);
    };
    const store = await h.open({ initialize: 'if_absent', writeFile: write });
    const { state, authority, release } = fakeAuthority();
    await createBarrierGate({ authority, store }).reconcile();
    release();
    const gate = createBarrierGate({ authority, store });
    ctl.fail = true;
    expect(await gate.engage({ kind: 'global' }, 'manual_stop')).toEqual({ durable: true, recorded: false });
    expect(state.global).not.toBeNull();
    expect(store.status().state).toBe('degraded');
    expect(gate.check(null)).toEqual({ open: false, reason: 'queue_store_degraded' });
  });

  it('integridade da fila em dúvida → reconcile aciona a barreira global (queue_integrity)', async () => {
    const h = await setup();
    await (await h.open({ initialize: 'if_absent' })).close();
    await writeFile(join(h.anchorDir, 'queue-anchor.json'), '{}');
    const broken = await h.open();
    const { state, authority } = fakeAuthority();
    const gate = createBarrierGate({ authority, store: broken });
    expect(await gate.reconcile()).toEqual({ confirmed: 1, failed: 0 });
    expect(state.calls.map((c) => c.reason)).toEqual(['queue_integrity']);
    expect(gate.check(null)).toEqual({ open: false, reason: 'queue_store_unavailable' });
    // Não configurado/bloqueado por outra instância NÃO é integridade: não aciona nada.
    const h2 = await setup();
    const notInit = await h2.open();
    const other = fakeAuthority();
    expect(await createBarrierGate({ authority: other.authority, store: notInit }).reconcile()).toEqual({ confirmed: 0, failed: 0 });
    expect(other.state.calls).toEqual([]);
  });

  it('entradas inválidas são recusadas; acionamentos concorrentes são serializados', async () => {
    const h = await setup();
    const store = await h.open({ initialize: 'if_absent' });
    const { state, authority } = fakeAuthority();
    const gate = createBarrierGate({ authority, store });
    expect(await queueCode(gate.engage({ kind: 'project', projectId: 'x' } as never, 'ok'))).toBe('invalid_scope');
    expect(await queueCode(gate.engage({ kind: 'global' }, 'Inválido!'))).toBe('invalid_reason');
    const results = await Promise.all([gate.engage({ kind: 'global' }, 'a_stop'), gate.engage({ kind: 'project', projectId: PROJECT }, 'b_stop'), gate.reconcile()]);
    expect(results[0]).toEqual({ durable: true, recorded: true });
    expect(results[1]).toEqual({ durable: true, recorded: true });
    expect(store.pendingBarriers()).toEqual([]);
    // A barreira global confirmada (a_stop) satisfaz também o pedido global da instalação: o
    // escopo é o que importa; o reconcile serializado depois não tem mais nada a reenviar.
    expect(state.calls.map((c) => c.reason)).toEqual(['a_stop', 'b_stop']);
    expect(store.history().filter((e) => e.data.event === 'queue.barrier_confirmed').map((e) => e.data.reason)).toEqual(['queue_initial_install', 'b_stop']);
  });
});

describe('portão de barreira — com o núcleo de aprovações REAL (#011)', () => {
  async function approvalsFor(h: QueueHarness, writeFileOverride?: WriteFile) {
    const store = await openApprovalStore({
      approvalsDir: h.approvalsDir,
      anchorDir: h.anchorDir,
      keyProvider: createEnvKeyProvider({ ACC_APPROVAL_KEY: h.master.toString('hex') }),
      environment: { env: {} },
      initialize: 'if_absent',
      writeFile: writeFileOverride,
    });
    approvalStores.push(store);
    const service = createApprovalService({ store, identity: createStepUpRegistry({ confirmers: [createPasswordConfirmer(null)] }), policyVersion: DEFAULT_POLICY.version });
    const authority: BarrierAuthority = { status: () => service.status(), barriers: () => service.barriers(), engage: (input) => service.engageBarrier(input) };
    return { store, service, authority };
  }

  it('mesmo diretório de anchors, arquivos e domínios independentes; barreira acionada pela fila é durável na #011', async () => {
    const h = await setup();
    const approvals = await approvalsFor(h);
    const queue = await h.open({ initialize: 'if_absent' });
    expect(approvals.store.status().state).toBe('available');
    const gate = createBarrierGate({ authority: approvals.authority, store: queue });
    // Instalação nova das aprovações já tem barreira global: a fila está bloqueada de qualquer jeito.
    expect(await gate.reconcile()).toEqual({ confirmed: 1, failed: 0 });
    expect(gate.check(PROJECT)).toEqual({ open: false, reason: 'global_barrier' });
    expect(await gate.engage({ kind: 'project', projectId: PROJECT }, 'manual_stop')).toEqual({ durable: true, recorded: true });
    const history = approvals.store.history().items.filter((i) => i.kind === 'entry');
    expect(history.filter((e) => e.kind === 'entry' && e.event === 'approval.barrier_engaged' && e.actor.id === 'acc-queue').map((e) => e.kind === 'entry' && e.reason)).toEqual(['queue_initial_install', 'manual_stop']);
    // Persistência: reabre as aprovações; a barreira do projeto continua.
    await approvals.store.close();
    approvalStores.splice(0);
    const reopened = await approvalsFor(h);
    expect(reopened.service.barriers().durable.projects[PROJECT]).toMatchObject({ reason: 'manual_stop' });
    expect(reopened.service.barriers().durable.global).not.toBeNull();
    // As aprovações continuam íntegras com os arquivos da fila no mesmo diretório de anchors.
    expect(reopened.store.status().state).toBe('available');
  });

  it('arquivos da fila no diretório de anchors não são vestígio para as aprovações (instalação em qualquer ordem)', async () => {
    const h = await setup();
    const queue = await h.open({ initialize: 'if_absent' });
    expect(queue.status().state).toBe('available');
    // Fila instalada ANTES: a primeira instalação das aprovações continua possível e íntegra.
    const approvals = await approvalsFor(h);
    expect(approvals.store.status()).toEqual({ state: 'available', reason: null });
    expect(approvals.service.barriers().durable.global).not.toBeNull();
    // E uma perda das aprovações continua detectada mesmo com os arquivos da fila presentes.
    await approvals.store.close();
    approvalStores.splice(0);
    await rm(join(h.anchorDir, 'approvals-anchor.json'));
    const lost = await approvalsFor(h);
    expect(lost.store.status()).toEqual({ state: 'unavailable', reason: 'anchor_missing' });
  });

  it('aprovações com gravação falhando: barreira só volátil → fila bloqueada e pedido mantido', async () => {
    const h = await setup();
    const ctl = { fail: false };
    const approvals = await approvalsFor(h, async (path, content) => {
      if (ctl.fail) throw new Error('EIO');
      await writeFileAtomic(path, content);
    });
    const queue = await h.open({ initialize: 'if_absent' });
    const gate = createBarrierGate({ authority: approvals.authority, store: queue });
    ctl.fail = true;
    expect(await gate.reconcile()).toEqual({ confirmed: 0, failed: 1 });
    expect(approvals.service.status().state).toBe('degraded');
    expect(queue.pendingBarriers()).toHaveLength(1);
    expect(gate.check(null)).toEqual({ open: false, reason: 'queue_barrier_pending' });
  });

  it('a chave da fila (HKDF) é independente da chave das aprovações', async () => {
    const h = await setup();
    const approvals = await approvalsFor(h);
    const queue = await h.open({ initialize: 'if_absent' });
    const ledger = JSON.parse(await readFile(join(h.queueDir, 'queue-ledger.json'), 'utf8'));
    const approvalsLedger = JSON.parse(await readFile(join(h.approvalsDir, 'approvals-ledger.json'), 'utf8'));
    expect(ledger.keyId).toBe(h.key.keyId);
    expect(ledger.keyId).not.toBe(approvalsLedger.keyId);
    expect(queue.status().state).toBe('available');
    expect(approvals.store.status().state).toBe('available');
    // Fila aberta com a chave principal (sem derivação) → key_mismatch: os domínios não se confundem.
    await queue.close();
    const raw = { keyId: approvalsLedger.keyId, key: h.master };
    const wrongDomain = await h.open({ loadKey: () => raw });
    expect(wrongDomain.status().reason).toBe('key_mismatch');
    await wrongDomain.close();
    const otherDomain = deriveSubkey(h.master, 'acc:other:mac:v1');
    expect((await h.open({ loadKey: () => otherDomain })).status().reason).toBe('key_mismatch');
  });
});
