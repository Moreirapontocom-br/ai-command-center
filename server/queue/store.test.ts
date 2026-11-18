// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REAL_EXECUTION_ENABLED } from '../sandbox/contracts.ts';
import { canonicalJson } from '../storage/canonical.ts';
import { writeFileAtomic, type WriteFile } from '../storage/jsonFile.ts';
import { deriveSubkey, QUEUE_KEY_DOMAIN } from '../storage/subkeys.ts';
import { listQuarantine, MANIFEST_FILE } from '../storage/signedLedger.ts';
import { addItem, createQueueHarness, moveTo, newItem, PROJECT, queueCode, spawnQueueWorker, transition, type QueueHarness } from '../test/queueFixtures.ts';
import type { QueueStore } from './store.ts';

const harnesses: QueueHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup();
});
async function setup() {
  const h = await createQueueHarness();
  harnesses.push(h);
  return h;
}
const fresh = (h: QueueHarness, extra = {}) => h.open({ initialize: 'if_absent', ...extra });
/** Abre, lê o estado e fecha (uma instância indisponível também segura o bloqueio, para `recover`). */
async function probe(h: QueueHarness, extra = {}) {
  const store = await h.open(extra);
  const status = store.status();
  await store.close();
  return status;
}
const events = (store: QueueStore) => store.history().map((e) => e.data.event);
const file = (h: QueueHarness, name: string) => (name.startsWith('queue-anchor') ? join(h.anchorDir, name) : join(h.queueDir, name));

/** `WriteFile` que falha (uma vez) na gravação do arquivo indicado, a partir do momento em que `armed`. */
function failingWrite(target: string) {
  const ctl = { armed: false, failed: 0 };
  const write: WriteFile = async (path, content) => {
    if (ctl.armed && path.endsWith(target)) {
      ctl.armed = false;
      ctl.failed += 1;
      throw new Error('EIO simulado');
    }
    await writeFileAtomic(path, content);
  };
  return { ctl, write };
}

describe('fila — inicialização (Condição A)', () => {
  it('primeira instalação legítima: só com if_absent; nasce com barreira global pendente', async () => {
    const h = await setup();
    const refused = await h.open();
    expect(refused.status()).toEqual({ state: 'unavailable', reason: 'store_not_initialized' });
    await refused.close();
    const store = await fresh(h);
    expect(store.status()).toEqual({ state: 'available', reason: null });
    expect(store.openedAs()).toBe('initial_install');
    expect(store.epoch()).toBe(1);
    expect(store.pendingBarriers()).toMatchObject([{ scope: { kind: 'global' }, reason: 'queue_initial_install', epoch: 1 }]);
    expect(events(store)).toEqual(['queue.store_initialized', 'queue.barrier_requested']);
    expect((await readdir(h.queueDir)).sort()).toEqual(['queue-history.json', 'queue-install.json', 'queue-ledger.json', 'queue.lock']);
    expect((await readdir(h.anchorDir)).sort()).toEqual(['queue-anchor.json', 'queue-install.json']);
    expect(REAL_EXECUTION_ENABLED).toBe(false);
  });

  it('reinício íntegro: época nova, estado e pedidos preservados, histórico encadeado', async () => {
    const h = await setup();
    const store = await fresh(h);
    const id = await addItem(store);
    await store.close();
    const again = await h.open();
    expect(again.status().state).toBe('available');
    expect(again.openedAs()).toBe('restart');
    expect(again.epoch()).toBe(2);
    expect(again.items().map((i) => [i.id, i.state])).toEqual([[id, 'queued']]);
    expect(again.pendingBarriers()).toHaveLength(1);
    expect(events(again).at(-1)).toBe('queue.store_opened');
    const seqs = again.history().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('estado de execução incerto: dispatching/running → interrupted; admitted → expired; nada é retomado', async () => {
    const h = await setup();
    const store = await fresh(h);
    const queued = await addItem(store);
    const admitted = await addItem(store);
    const dispatching = await addItem(store);
    const running = await addItem(store);
    await moveTo(store, admitted, ['admitted']);
    await moveTo(store, dispatching, ['admitted', 'dispatching']);
    await moveTo(store, running, ['admitted', 'dispatching', 'running']);
    await store.close();

    const again = await h.open();
    const state = Object.fromEntries(again.items().map((i) => [i.id, i]));
    expect(state[queued].state).toBe('queued');
    expect(state[admitted]).toMatchObject({ state: 'expired', reason: 'instance_restart', stateEpoch: 2 });
    expect(state[admitted].closedAt).not.toBeNull();
    expect(state[dispatching]).toMatchObject({ state: 'interrupted', reason: 'instance_restart', attempt: 1, closedAt: null });
    expect(state[running]).toMatchObject({ state: 'interrupted', reason: 'instance_restart', attempt: 1 });
    expect(events(again).filter((e) => e === 'queue.item_interrupted')).toHaveLength(2);
    expect(events(again)).toContain('queue.item_expired');
    // Interrompido nunca volta a despachar nem à fila; só desfecho humano (falha/cancelamento/revogação).
    for (const to of ['dispatching', 'running', 'queued', 'admitted', 'succeeded'] as const) {
      expect(await queueCode(again.commit((tx) => transition(tx, dispatching, to)))).toBe('change_rejected');
    }
    expect(again.status().state).toBe('available');
    await again.commit((tx) => transition(tx, dispatching, 'failed', 'human_reconciled'));
    // Reinícios seguintes não mexem em terminais nem nos interrompidos.
    await again.close();
    const third = await h.open();
    expect(third.items().find((i) => i.id === dispatching)!.state).toBe('failed');
    expect(third.items().find((i) => i.id === running)!.state).toBe('interrupted');
  });

  it('revogado nunca é reativado; terminais nunca mudam; itens nunca são removidos', async () => {
    const h = await setup();
    const store = await fresh(h);
    const id = await addItem(store);
    await moveTo(store, id, ['revoked']);
    for (const to of ['queued', 'admitted', 'dispatching'] as const) expect(await queueCode(store.commit((tx) => transition(tx, id, to)))).toBe('change_rejected');
    expect(await queueCode(store.commit((tx) => void (tx.body.items.find((i) => i.id === id)!.reason = 'edited')))).toBe('change_rejected');
    expect(await queueCode(store.commit((tx) => void tx.body.items.splice(0, 1)))).toBe('change_rejected');
    // Item novo que já nasce fora de `queued`, campo extra ou duplicado → recusado sem degradar.
    expect(await queueCode(store.commit((tx) => void tx.body.items.push(newItem({ state: 'running', attempt: 1, approvalId: '44444444-4444-4444-8444-444444444444', reason: 'x' }))))).toBe('change_rejected');
    expect(await queueCode(store.commit((tx) => void tx.body.items.push({ ...newItem(), extra: 1 } as never)))).toBe('change_invalid');
    const dup = store.items()[0];
    expect(await queueCode(store.commit((tx) => void tx.body.items.push(newItem({ idempotencyKey: dup.idempotencyKey }))))).toBe('change_invalid');
    expect(store.status()).toEqual({ state: 'available', reason: null });
  });

  it('falha entre gravações: ledger não gravado → degradado; reabre com entradas marcadas como não aplicadas', async () => {
    const h = await setup();
    const { ctl, write } = failingWrite('queue-ledger.json');
    const store = await fresh(h, { writeFile: write });
    ctl.armed = true;
    expect(await queueCode(addItem(store))).toBe('store_write_failed');
    expect(store.status()).toEqual({ state: 'degraded', reason: 'write_failed' });
    expect(await queueCode(addItem(store))).toBe('store_degraded');
    await store.close();
    const again = await h.open();
    expect(again.status().state).toBe('available');
    expect(again.items()).toHaveLength(0); // o ledger antigo vale; o item não existe
    expect(events(again)).toContain('queue.history_unapplied');
  });

  it('falha entre gravações: anchor não gravado → aceita o ledger uma geração à frente', async () => {
    const h = await setup();
    const { ctl, write } = failingWrite('queue-anchor.json');
    const store = await fresh(h, { writeFile: write });
    ctl.armed = true;
    expect(await queueCode(addItem(store))).toBe('store_write_failed');
    await store.close();
    const again = await h.open();
    expect(again.status().state).toBe('available');
    expect(again.items()).toHaveLength(1);
  });

  it('anchor ausente, marcador ausente, documentos ausentes com vestígios → indisponível', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    await rm(join(h.anchorDir, 'queue-anchor.json'));
    expect((await probe(h))).toEqual({ state: 'unavailable', reason: 'anchor_missing' });

    const h2 = await setup();
    await (await fresh(h2)).close();
    await rm(join(h2.anchorDir, 'queue-install.json'));
    expect((await probe(h2)).reason).toBe('install_marker_missing');

    const h3 = await setup();
    await (await fresh(h3)).close();
    for (const name of ['queue-ledger.json', 'queue-history.json']) await rm(join(h3.queueDir, name));
    await rm(join(h3.anchorDir, 'queue-anchor.json'));
    // Marcadores sobraram: é perda, não primeira instalação — mesmo com if_absent.
    expect((await probe(h3, { initialize: 'if_absent' })).reason).toBe('store_missing');
  });

  it('ledger adulterado (MAC), substituído por cópia antiga (rollback) ou de outra linhagem → indisponível', async () => {
    const h = await setup();
    const store = await fresh(h);
    await addItem(store);
    await store.close();
    const ledgerPath = file(h, 'queue-ledger.json');
    const original = await readFile(ledgerPath, 'utf8');
    const doc = JSON.parse(original);
    doc.body.items[0].priority = 'critical';
    await writeFile(ledgerPath, canonicalJson(doc));
    expect((await probe(h)).reason).toBe('mac_invalid');

    // Rollback: cópia antiga, íntegra e assinada, do ledger.
    const h2 = await setup();
    const s2 = await fresh(h2);
    await s2.close();
    const old = await readFile(file(h2, 'queue-ledger.json'));
    const s2b = await h2.open();
    await addItem(s2b);
    await s2b.close();
    await writeFile(file(h2, 'queue-ledger.json'), old);
    expect((await probe(h2)).reason).toBe('ledger_rollback');

    // Substituição por documentos de OUTRA linhagem (mesma chave).
    const h3 = await setup();
    const other = await setup();
    const h3Store = await fresh(h3);
    await h3Store.close();
    const otherStore = await other.open({ initialize: 'if_absent', loadKey: () => h3.key });
    await otherStore.close();
    await copyFile(file(other, 'queue-ledger.json'), file(h3, 'queue-ledger.json'));
    expect((await probe(h3)).reason).toBe('lineage_mismatch');
  });

  it('chave diferente → key_mismatch; documento malformado → document_invalid', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    const wrong = deriveSubkey(randomBytes(32), QUEUE_KEY_DOMAIN);
    expect((await probe(h, { loadKey: () => wrong })).reason).toBe('key_mismatch');
    await writeFile(file(h, 'queue-history.json'), '{"lixo":');
    expect((await probe(h)).reason).toBe('document_invalid');
  });

  it('histórico inconsistente: cópia antiga (rollback) ou entrada alterada (hash) → indisponível', async () => {
    const h = await setup();
    const store = await fresh(h);
    await store.close();
    const oldHistory = await readFile(file(h, 'queue-history.json'));
    const again = await h.open();
    await addItem(again);
    await again.close();
    const current = await readFile(file(h, 'queue-history.json'), 'utf8');
    await writeFile(file(h, 'queue-history.json'), oldHistory);
    expect((await probe(h)).reason).toBe('history_rollback');
    const doc = JSON.parse(current);
    doc.items[0].data.reason = 'tampered';
    await writeFile(file(h, 'queue-history.json'), canonicalJson(doc));
    expect((await probe(h)).reason).toBe('document_invalid');
  });

  it('nova linhagem por recuperação: quarentena verificada, época maior, barreira global pendente', async () => {
    const h = await setup();
    const store = await fresh(h);
    await addItem(store);
    await store.close();
    const ledgerPath = file(h, 'queue-ledger.json');
    const tampered = (await readFile(ledgerPath, 'utf8')).replace('"medium"', '"high"');
    await writeFile(ledgerPath, tampered);
    const broken = await h.open();
    expect(broken.status().reason).toBe('mac_invalid');
    expect(await queueCode(broken.commit(() => undefined))).toBe('store_unavailable');
    const { quarantineId } = await broken.recover({ actorId: 'admin', reason: 'integrity_failure' });
    expect(broken.status()).toEqual({ state: 'available', reason: null });
    expect(broken.openedAs()).toBe('recovery');
    expect(broken.epoch()).toBeGreaterThan(1);
    expect(broken.items()).toHaveLength(0); // nada antigo é reativado
    expect(broken.pendingBarriers()).toMatchObject([{ scope: { kind: 'global' }, reason: 'queue_recovery' }]);
    expect(events(broken)).toEqual(['queue.store_recovered', 'queue.barrier_requested']);
    expect(await listQuarantine(h.queueDir)).toEqual([quarantineId]);
    const qdir = join(h.queueDir, 'quarantine', quarantineId);
    expect(await readFile(join(qdir, 'queue-ledger.json'), 'utf8')).toBe(tampered);
    const manifest = JSON.parse(await readFile(join(qdir, MANIFEST_FILE), 'utf8'));
    expect(manifest).toMatchObject({ format: 'acc-queue-quarantine', reason: 'integrity_failure', actor: 'admin' });
    expect(manifest.files.map((f: { name: string; present: boolean }) => [f.name, f.present])).toEqual([
      ['queue-ledger.json', true],
      ['queue-history.json', true],
      ['queue-anchor.json', true],
      ['data-dir-queue-install.json', true],
      ['anchor-dir-queue-install.json', true],
    ]);
    // Recuperação só quando indisponível por integridade.
    expect(await queueCode(broken.recover({ actorId: 'admin', reason: 'integrity_failure' }))).toBe('recovery_not_needed');
    await broken.close();
    const reopened = await h.open();
    expect(reopened.openedAs()).toBe('restart');
    expect(reopened.pendingBarriers()).toHaveLength(1);
  });

  it('recuperação interrompida: falha ao gravar a nova linhagem restaura os originais e continua indisponível', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    const ledgerPath = file(h, 'queue-ledger.json');
    await writeFile(ledgerPath, (await readFile(ledgerPath, 'utf8')).replace('"epoch":1', '"epoch":9'));
    const before = await Promise.all(['queue-ledger.json', 'queue-history.json', 'queue-install.json'].map((n) => readFile(join(h.queueDir, n))));
    const { ctl, write } = failingWrite('queue-ledger.json');
    const broken = await h.open({ writeFile: write });
    expect(broken.status().reason).toBe('mac_invalid');
    ctl.armed = true;
    expect(await queueCode(broken.recover({ actorId: 'admin', reason: 'integrity_failure' }))).toBe('recovery_failed');
    expect(broken.status()).toEqual({ state: 'unavailable', reason: 'recovery_failed' });
    const after = await Promise.all(['queue-ledger.json', 'queue-history.json', 'queue-install.json'].map((n) => readFile(join(h.queueDir, n))));
    expect(after.map((b) => b.toString('hex'))).toEqual(before.map((b) => b.toString('hex')));
    await broken.close();
    // O estado em disco é o original (ainda adulterado): continua indisponível pelo mesmo motivo.
    const again = await h.open();
    expect(again.status().reason).toBe('mac_invalid');
    // Nova tentativa (sem falha injetada) conclui a recuperação.
    expect(await queueCode(again.recover({ actorId: 'admin', reason: 'integrity_failure' }))).toBe('resolved');
    expect(again.openedAs()).toBe('recovery');
  });

  it('quarentena com falha de cópia: nada é alterado e a fila continua indisponível', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    await writeFile(file(h, 'queue-anchor.json'), '{}');
    const broken = await h.open({ writeBytes: async () => Promise.reject(new Error('EIO')) });
    expect(broken.status().reason).toBe('document_invalid');
    expect(await queueCode(broken.recover({ actorId: 'admin', reason: 'integrity_failure' }))).toBe('quarantine_write_failed');
    expect(broken.status().state).toBe('unavailable');
    expect(await readFile(file(h, 'queue-anchor.json'), 'utf8')).toBe('{}');
  });

  it('perda total (inclusive os arquivos do diretório de anchor): sem if_absent indisponível; com if_absent, linhagem nova BLOQUEADA', async () => {
    const h = await setup();
    const store = await fresh(h);
    await addItem(store);
    await store.close();
    await rm(h.queueDir, { recursive: true, force: true });
    for (const name of ['queue-anchor.json', 'queue-install.json']) await rm(join(h.anchorDir, name));
    expect((await probe(h)).reason).toBe('store_not_initialized');
    const reborn = await fresh(h);
    expect(reborn.openedAs()).toBe('initial_install');
    expect(reborn.items()).toHaveLength(0);
    expect(reborn.pendingBarriers()).toMatchObject([{ scope: { kind: 'global' } }]);
  });

  it('separação de diretórios: anchor = dados, dados dentro das aprovações, dentro de repositório Git → recusado', async () => {
    const h = await setup();
    expect((await probe(h, { initialize: 'if_absent', anchorDir: h.queueDir })).reason).toBe('paths_not_separate');
    expect((await probe(h, { initialize: 'if_absent', queueDir: join(h.approvalsDir, 'q') })).reason).toBe('paths_not_separate');
    await mkdir(join(h.root, 'repo', '.git'), { recursive: true });
    expect((await probe(h, { initialize: 'if_absent', queueDir: join(h.root, 'repo', 'q') })).reason).toBe('path_in_git_repository');
  });

  it('vestígio isolado (temporário ou quarentena) impede a "primeira instalação"', async () => {
    const h = await setup();
    await mkdir(h.queueDir, { recursive: true });
    await writeFile(join(h.queueDir, 'queue-ledger.json.abc123.tmp'), 'x');
    expect((await probe(h, { initialize: 'if_absent' })).reason).toBe('store_missing');
    const h2 = await setup();
    await mkdir(h2.anchorDir, { recursive: true });
    await writeFile(join(h2.anchorDir, 'queue-install.json'), 'x');
    expect((await probe(h2, { initialize: 'if_absent' })).reason).toBe('store_missing');
    // Arquivos das APROVAÇÕES no diretório de anchor compartilhado não são vestígio da fila.
    const h3 = await setup();
    await mkdir(h3.anchorDir, { recursive: true });
    await writeFile(join(h3.anchorDir, 'approvals-anchor.json'), '{}');
    await writeFile(join(h3.anchorDir, 'approvals-install.json'), '{}');
    expect((await probe(h3, { initialize: 'if_absent' })).state).toBe('available');
  });
});

describe('fila — concorrência (Condição B)', () => {
  it('commits simultâneos no mesmo processo: serializados, nenhum perdido, histórico contínuo', async () => {
    const h = await setup();
    const store = await fresh(h);
    const ids = await Promise.all(Array.from({ length: 40 }, () => addItem(store)));
    expect(new Set(store.items().map((i) => i.id))).toEqual(new Set(ids));
    await store.close();
    const again = await h.open();
    expect(again.items()).toHaveLength(40);
    const seqs = again.history().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('segunda instância no mesmo processo → store_locked (nunca dois escritores)', async () => {
    const h = await setup();
    const first = await fresh(h);
    const second = await h.open();
    expect(second.status()).toEqual({ state: 'unavailable', reason: 'store_locked' });
    expect(await queueCode(second.recover({ actorId: 'admin', reason: 'integrity_failure' }))).toBe('recovery_refused_store_locked');
    expect(first.status().state).toBe('available');
  });

  it('recuperações concorrentes: exatamente uma executa', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    await writeFile(file(h, 'queue-anchor.json'), '{}');
    const broken = await h.open();
    const results = await Promise.all([1, 2, 3].map(() => queueCode(broken.recover({ actorId: 'admin', reason: 'integrity_failure' }))));
    expect(results.filter((r) => r === 'resolved')).toHaveLength(1);
    expect(results.filter((r) => r === 'recovery_not_needed')).toHaveLength(2);
    expect(await listQuarantine(h.queueDir)).toHaveLength(1);
  });

  it('processos reais: escritores concorrentes se alternam pelo bloqueio; nada se perde nem corrompe', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    const workers = [1, 2, 3, 4].map(() => spawnQueueWorker(h, 'commit', 5));
    const statuses = await Promise.all(workers.map((w) => w.exited));
    expect(statuses).toEqual([0, 0, 0, 0]);
    for (const w of workers) expect(w.lines.at(-1)).toMatch(/^done \d+$/);
    const store = await h.open();
    expect(store.status().state).toBe('available');
    expect(store.items()).toHaveLength(20);
    expect(new Set(store.items().map((i) => i.idempotencyKey)).size).toBe(20);
    expect(store.epoch()).toBe(6); // 1 (instalação) + 4 processos + esta abertura
    const seqs = store.history().map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  }, 90_000);

  it('processo real segurando o bloqueio: outra instância recusada; processo morto → retomada registrada', async () => {
    const h = await setup();
    await (await fresh(h)).close();
    const holder = spawnQueueWorker(h, 'hold');
    try {
      expect(await holder.firstLine()).toBe('ready available none');
      const blocked = await h.open();
      expect(blocked.status().reason).toBe('store_locked');
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
    const store = await h.open();
    expect(store.status().state).toBe('available');
    expect(events(store)).toContain('queue.lock_recovered');
    // O processo morto estava "segurando" a fila, mas não havia item em curso: nada a interromper.
    expect(store.items()).toHaveLength(0);
  }, 60_000);

  it('processo morto com item em curso: reabertura marca interrupted (sem retomada)', async () => {
    const h = await setup();
    const store = await fresh(h);
    const id = await addItem(store, { projectId: PROJECT });
    await moveTo(store, id, ['admitted', 'dispatching', 'running']);
    await store.close();
    const holder = spawnQueueWorker(h, 'hold');
    try {
      expect(await holder.firstLine()).toBe('ready available none');
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
    const again = await h.open();
    expect(again.items()[0]).toMatchObject({ state: 'interrupted', reason: 'instance_restart' });
  }, 60_000);
});
