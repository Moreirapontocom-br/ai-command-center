import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QueueItem, QueueItemState } from '../queue/contracts.ts';
import { openQueueStore, type OpenQueueStoreOptions, type QueueStore, type QueueTransaction } from '../queue/store.ts';
import { deriveSubkey, QUEUE_KEY_DOMAIN, type DerivedKey } from '../storage/subkeys.ts';

/** Utilitários de teste da fila (Issue #012, PR 1). Fora do código do servidor (pasta `test`). */

export const PROJECT = '11111111-1111-4111-8111-111111111111';
export const PROJECT_B = '22222222-2222-4222-8222-222222222222';
export const TASK = '33333333-3333-4333-8333-333333333333';
export const APPROVAL = '44444444-4444-4444-8444-444444444444';
export const START = Date.parse('2026-11-17T12:00:00.000Z');

export interface QueueHarness {
  root: string;
  queueDir: string;
  anchorDir: string;
  approvalsDir: string;
  master: Buffer;
  key: DerivedKey;
  clock: { now: number };
  open(extra?: Partial<OpenQueueStoreOptions>): Promise<QueueStore>;
  cleanup(): Promise<void>;
}

export async function createQueueHarness(prefix = 'acc-queue-'): Promise<QueueHarness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const master = randomBytes(32);
  const key = deriveSubkey(master, QUEUE_KEY_DOMAIN);
  const clock = { now: START };
  const opened: QueueStore[] = [];
  const harness: QueueHarness = {
    root,
    queueDir: join(root, 'queue'),
    anchorDir: join(root, 'anchor'),
    approvalsDir: join(root, 'approvals'),
    master,
    key,
    clock,
    async open(extra = {}) {
      const store = await openQueueStore({
        queueDir: harness.queueDir,
        anchorDir: harness.anchorDir,
        approvalsDir: harness.approvalsDir,
        environment: { env: {} },
        loadKey: () => key,
        now: () => clock.now,
        ...extra,
      });
      opened.push(store);
      return store;
    },
    async cleanup() {
      for (const store of opened.splice(0)) await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return harness;
}

export function newItem(overrides: Partial<QueueItem> = {}, at = new Date(START).toISOString()): QueueItem {
  return {
    id: randomUUID(),
    idempotencyKey: `req-${randomUUID()}`,
    ownerId: 'admin',
    projectId: PROJECT,
    taskId: TASK,
    agentId: 'claude-code',
    priority: 'medium',
    state: 'queued',
    attempt: 0,
    approvalId: null,
    createdAt: at,
    updatedAt: at,
    stateEpoch: 1,
    reason: null,
    closedAt: null,
    ...overrides,
  };
}

/** Grava um item novo (`queued`) e devolve o id. */
export async function addItem(store: QueueStore, overrides: Partial<QueueItem> = {}): Promise<string> {
  const item = newItem({ stateEpoch: store.epoch(), ...overrides });
  await store.commit((tx) => {
    tx.body.items.push(item);
    tx.append({ event: 'queue.item_recorded', actor: { kind: 'system', id: 'acc-queue' }, itemId: item.id, projectId: item.projectId, from: null, to: 'queued', reason: 'test', detail: null });
  });
  return item.id;
}

const TERMINAL: readonly QueueItemState[] = ['succeeded', 'failed', 'cancelled', 'expired', 'revoked'];

/** Aplica uma transição como o PR 2 fará (só para testes de persistência). */
export function transition(tx: QueueTransaction, id: string, to: QueueItemState, reason = 'test') {
  const item = tx.body.items.find((i) => i.id === id)!;
  const from = item.state;
  item.state = to;
  item.reason = reason;
  item.stateEpoch = tx.epoch;
  if (to === 'admitted' && item.approvalId === null) item.approvalId = APPROVAL;
  if (to === 'dispatching') item.attempt += 1;
  if (TERMINAL.includes(to)) item.closedAt = item.updatedAt;
  tx.append({ event: 'queue.item_transition', actor: { kind: 'system', id: 'acc-queue' }, itemId: id, projectId: item.projectId, from, to, reason, detail: null });
}

export async function moveTo(store: QueueStore, id: string, path: QueueItemState[]) {
  for (const to of path) await store.commit((tx) => transition(tx, id, to));
}

export const queueCode = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected:${(error as Error).message}`;
  }
};

/**
 * Processo Node REAL que abre a fila nos mesmos diretórios. Modos:
 * - `hold`: abre, imprime `ready <estado> <motivo>` e fica parado (segura o bloqueio);
 * - `commit`: tenta abrir até conseguir (repete em `store_locked`), grava `count` itens, fecha e
 *   imprime `done`.
 * A chave vai por variável de ambiente (nunca na linha de comando).
 */
export function spawnQueueWorker(h: QueueHarness, mode: 'hold' | 'commit', count = 0) {
  const storeUrl = pathToFileURL(join(process.cwd(), 'server', 'queue', 'store.ts')).href;
  const keysUrl = pathToFileURL(join(process.cwd(), 'server', 'storage', 'subkeys.ts')).href;
  const script = `
const { openQueueStore } = await import(${JSON.stringify(storeUrl)});
const { deriveSubkey, QUEUE_KEY_DOMAIN } = await import(${JSON.stringify(keysUrl)});
const { randomUUID } = await import('node:crypto');
const cfg = JSON.parse(process.env.QW_CFG);
const key = deriveSubkey(Buffer.from(process.env.QW_KEY, 'hex'), QUEUE_KEY_DOMAIN);
const open = () => openQueueStore({ queueDir: cfg.queueDir, anchorDir: cfg.anchorDir, approvalsDir: cfg.approvalsDir, environment: { env: {} }, loadKey: () => key });
if (cfg.mode === 'hold') {
  const store = await open();
  const s = store.status();
  process.stdout.write('ready ' + s.state + ' ' + (s.reason ?? 'none') + '\\n');
  setInterval(() => {}, 1000);
} else {
  for (let tries = 0; tries < 2000; tries += 1) {
    const store = await open();
    const s = store.status();
    if (s.state === 'available') {
      for (let i = 0; i < cfg.count; i += 1) {
        const at = new Date().toISOString();
        const id = randomUUID();
        await store.commit((tx) => {
          tx.body.items.push({ id, idempotencyKey: 'proc-' + process.pid + '-' + i + '-' + randomUUID(), ownerId: 'admin', projectId: cfg.project, taskId: cfg.task, agentId: 'gemini', priority: 'low', state: 'queued', attempt: 0, approvalId: null, createdAt: at, updatedAt: at, stateEpoch: store.epoch(), reason: null, closedAt: null });
          tx.append({ event: 'queue.item_recorded', actor: { kind: 'system', id: 'acc-queue' }, itemId: id, projectId: cfg.project, from: null, to: 'queued', reason: 'process_test', detail: null });
        });
      }
      await store.close();
      process.stdout.write('done ' + tries + '\\n');
      process.exit(0);
    }
    await store.close();
    if (s.reason !== 'store_locked') { process.stdout.write('error ' + s.reason + '\\n'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 30)));
  }
  process.stdout.write('error gave_up\\n');
  process.exit(1);
}
`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      QW_KEY: h.master.toString('hex'),
      QW_CFG: JSON.stringify({ mode, count, queueDir: h.queueDir, anchorDir: h.anchorDir, approvalsDir: h.approvalsDir, project: PROJECT, task: TASK }),
    },
  });
  let output = '';
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const parts = output.split('\n');
    output = parts.pop() ?? '';
    lines.push(...parts.map((l) => l.trim()).filter(Boolean));
    for (const w of waiters.splice(0)) w();
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (status) => resolve(status)));
  return {
    child,
    exited,
    lines,
    /** Primeira linha impressa (ou erro se o processo terminar antes). */
    firstLine: () =>
      new Promise<string>((resolve, reject) => {
        const check = () => (lines.length > 0 ? resolve(lines[0]) : waiters.push(check));
        check();
        void exited.then(() => (lines.length > 0 ? resolve(lines[0]) : reject(new Error('worker exited without output'))));
      }),
  };
}
