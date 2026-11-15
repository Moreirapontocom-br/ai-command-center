import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, type WriteFile } from '../storage/jsonFile.ts';
import { canonicalJson, equalHex, macHex, without } from './canonical.ts';
import { ApprovalError, HISTORY_RETENTION_DAYS, type ApprovalEvent, type RecoveryReason } from './contracts.ts';
import {
  ANCHOR_FORMAT,
  checkAnchorDocument,
  checkHistoryDocument,
  checkLedgerDocument,
  DOCUMENT_VERSION,
  DocumentError,
  entryHash,
  HISTORY_FORMAT,
  historyTip,
  LEDGER_FORMAT,
  ledgerHead,
  type AnchorDocument,
  type HistoryBody,
  type HistoryDocument,
  type HistoryEntry,
  type LedgerBody,
  type LedgerDocument,
} from './documents.ts';
import type { ApprovalKeyProvider } from './keyProvider.ts';
import { acquireStoreLock, LOCK_FILE, type StoreLock } from './lock.ts';
import { assertSeparate, checkRegularFile, secureDirectory, type PathEnvironment } from './paths.ts';

/**
 * Armazenamento durável do núcleo de aprovações (R2/R6).
 *
 * Três documentos, cada um com HMAC-SHA256 (chave da `ApprovalKeyProvider`, `keyId` gravado):
 * - `approvals-ledger.json` — estado mínimo (aprovações, tentativas, barreiras), com `generation`
 *   monotônica e `prevHead` (hash da versão anterior);
 * - `approvals-history.json` — histórico consultável, encadeado por hash, somente acréscimo;
 * - `approvals-anchor.json` — EM OUTRO DIRETÓRIO: `{generation, head}` do ledger e `{seq, head}` do
 *   histórico, mais a época e a linhagem.
 *
 * Uma alteração (`commit`) grava histórico → ledger → anchor, nessa ordem, cada um por escrita
 * atômica (tmp + fsync + rename). O estado em memória só muda depois das três gravações. Qualquer
 * falha deixa o armazenamento DEGRADADO até reiniciar: nada mais é gravado nem consumido.
 *
 * Abertura: valida caminhos, adquire o bloqueio de escritor único, verifica MAC, formato,
 * invariantes, linhagem e a coerência com o anchor (tolerando apenas a queda entre a gravação do
 * ledger/histórico e a do anchor). Inicia uma ÉPOCA nova (N1) e só então aceita operações.
 * Qualquer divergência → INDISPONÍVEL (nega tudo); os arquivos nunca são reescritos nem apagados.
 * A saída é a recuperação administrativa (`recover`), que preserva as evidências em quarentena.
 */

export const LEDGER_FILE = 'approvals-ledger.json';
export const HISTORY_FILE = 'approvals-history.json';
export const ANCHOR_FILE = 'approvals-anchor.json';
export const QUARANTINE_DIR = 'quarantine';
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

export type StoreState = 'available' | 'degraded' | 'unavailable';

export interface HistoryInput {
  event: ApprovalEvent;
  actor: { kind: 'human' | 'system'; id: string };
  approvalId?: string | null;
  attemptId?: string | null;
  projectId?: string | null;
  class?: HistoryEntry['class'];
  action?: string | null;
  bindingDigest?: string | null;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
  detail?: string | null;
}

export interface StoreTransaction {
  /** Rascunho do estado mínimo (cópia). */
  ledger: LedgerBody;
  /** Rascunho de retenção/preservação. `items` só muda por `append` ou pela retenção do núcleo. */
  history: HistoryBody;
  epoch: number;
  append(input: HistoryInput): void;
}

export interface OpenStoreOptions {
  approvalsDir: string;
  anchorDir: string;
  keyProvider: ApprovalKeyProvider;
  environment: PathEnvironment;
  now?: () => number;
  writeFile?: WriteFile;
}

export interface ApprovalStore {
  status(): { state: StoreState; reason: string | null };
  epoch(): number;
  ledger(): Readonly<LedgerBody>;
  history(): Readonly<HistoryBody>;
  /** Aplica uma alteração atômica. `change` é síncrona; se lançar, nada é gravado. */
  commit<R>(change: (tx: StoreTransaction) => R): Promise<R>;
  /**
   * Recuperação ADMINISTRATIVA (só quando indisponível). A autorização humana é verificada pelo
   * serviço antes de chamar isto. Move os arquivos atuais para a quarentena (nunca apaga), inicia
   * linhagem e época novas, sem nenhuma aprovação antiga, com BARREIRA GLOBAL ativa.
   */
  recover(input: { actorId: string; reason: RecoveryReason }): Promise<{ quarantineId: string }>;
  close(): Promise<void>;
}

interface Loaded {
  lineage: string;
  keyId: string;
  generation: number;
  head: string;
  epoch: number;
  ledger: LedgerBody;
  history: HistoryBody;
}

const emptyLedger = (): LedgerBody => ({ approvals: [], attempts: [], barriers: { global: null, projects: {} }, compaction: { lastAt: null, removed: 0 } });

async function readOptional(path: string): Promise<{ raw: unknown; text: string } | null> {
  if (!(await checkRegularFile(path))) return null;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new ApprovalError('file_unreadable');
  }
  try {
    return { raw: JSON.parse(text), text };
  } catch {
    return { raw: undefined, text };
  }
}

export async function openApprovalStore(options: OpenStoreOptions): Promise<ApprovalStore> {
  const now = options.now ?? Date.now;
  const write = options.writeFile ?? writeFileAtomic;
  const iso = () => new Date(now()).toISOString();
  let state: StoreState = 'unavailable';
  let reason: string | null = 'opening';
  let key: Buffer | null = null;
  let keyId = '';
  let lock: StoreLock | null = null;
  let approvalsDir = '';
  let anchorDir = '';
  let current: Loaded | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const paths = () => ({ ledger: join(approvalsDir, LEDGER_FILE), history: join(approvalsDir, HISTORY_FILE), anchor: join(anchorDir, ANCHOR_FILE) });
  const unavailable = (code: string) => {
    state = 'unavailable';
    reason = code;
  };

  function sign<T extends { mac: string }>(domain: string, doc: Omit<T, 'mac'>): T {
    return { ...doc, mac: macHex(key!, domain, doc) } as T;
  }
  function verifyMac(domain: string, doc: { mac: string }) {
    if (!equalHex(doc.mac, macHex(key!, domain, without(doc, 'mac')))) throw new ApprovalError('mac_invalid');
  }

  /** Monta os novos documentos e grava histórico → ledger → anchor. Lança em qualquer falha. */
  async function persist(base: Loaded, next: { ledger: LedgerBody; history: HistoryBody; epoch: number; lineage?: string }, force = false): Promise<Loaded> {
    const lineage = next.lineage ?? base.lineage;
    const ledgerChanged = force || canonicalJson(next.ledger) !== canonicalJson(base.ledger) || next.epoch !== base.epoch;
    const historyChanged = force || canonicalJson(next.history) !== canonicalJson(base.history);
    let generation = base.generation;
    let head = base.head;
    const at = iso();
    const writes: Array<() => Promise<void>> = [];
    if (historyChanged) {
      const doc = sign<HistoryDocument>('history', { format: HISTORY_FORMAT, version: DOCUMENT_VERSION, lineage, keyId, ...structuredClone(next.history) });
      const content = canonicalJson(doc);
      if (Buffer.byteLength(content) > MAX_HISTORY_BYTES) throw new ApprovalError('history_full');
      writes.push(() => write(paths().history, content));
    }
    if (ledgerChanged) {
      generation = base.generation + 1;
      const unsigned: Omit<LedgerDocument, 'mac'> = {
        format: LEDGER_FORMAT,
        version: DOCUMENT_VERSION,
        lineage,
        keyId,
        generation,
        prevHead: base.generation === 0 ? null : base.head,
        epoch: next.epoch,
        updatedAt: at,
        ...structuredClone(next.ledger),
      };
      const doc = sign<LedgerDocument>('ledger', unsigned);
      head = ledgerHead(doc);
      const content = canonicalJson(doc);
      if (Buffer.byteLength(content) > MAX_LEDGER_BYTES) throw new ApprovalError('ledger_full');
      writes.push(() => write(paths().ledger, content));
    }
    const tip = historyTip(next.history.items);
    const anchor = sign<AnchorDocument>('anchor', { format: ANCHOR_FORMAT, version: DOCUMENT_VERSION, lineage, keyId, epoch: next.epoch, ledger: { generation, head }, history: tip, updatedAt: at });
    writes.push(() => write(paths().anchor, canonicalJson(anchor)));
    for (const step of writes) await step();
    return { lineage, keyId, generation, head, epoch: next.epoch, ledger: structuredClone(next.ledger), history: structuredClone(next.history) };
  }

  /**
   * Executa `change` sobre rascunhos e devolve os rascunhos + resultado (sem gravar). As entradas
   * do histórico são montadas DEPOIS, quando se sabe se o ledger muda (e para qual geração).
   */
  function draft<R>(base: Loaded, epoch: number, change: (tx: StoreTransaction) => R, forceLedger = false) {
    const ledger = structuredClone(base.ledger);
    const history = structuredClone(base.history);
    const pending: HistoryInput[] = [];
    const result = change({ ledger, history, epoch, append: (input) => pending.push(input) });
    const ledgerChanged = forceLedger || canonicalJson(ledger) !== canonicalJson(base.ledger);
    const generation = ledgerChanged ? base.generation + 1 : base.generation;
    const at = iso();
    for (const input of pending) {
      const tip = history.items.length > 0 ? historyTip(history.items) : { seq: 0, head: null };
      const entry: Omit<HistoryEntry, 'hash'> = {
        kind: 'entry',
        seq: tip.seq + 1,
        at,
        prevHash: tip.head,
        ledgerGeneration: generation,
        event: input.event,
        actor: { kind: input.actor.kind, id: input.actor.id },
        approvalId: input.approvalId ?? null,
        attemptId: input.attemptId ?? null,
        projectId: input.projectId ?? null,
        class: input.class ?? null,
        action: input.action ?? null,
        bindingDigest: input.bindingDigest ?? null,
        from: input.from ?? null,
        to: input.to ?? null,
        reason: input.reason ?? null,
        detail: input.detail ?? null,
      };
      history.items.push({ ...entry, hash: entryHash(entry) });
    }
    return { ledger, history, result };
  }

  async function load(): Promise<Loaded | 'fresh'> {
    const p = paths();
    const [ledgerFile, historyFile, anchorFile] = [await readOptional(p.ledger), await readOptional(p.history), await readOptional(p.anchor)];
    if (!ledgerFile && !historyFile && !anchorFile) return 'fresh';
    if (!anchorFile) throw new ApprovalError('anchor_missing');
    if (!ledgerFile) throw new ApprovalError('ledger_missing');
    if (!historyFile) throw new ApprovalError('history_missing');
    let anchor: AnchorDocument;
    let ledger: LedgerDocument;
    let history: HistoryDocument;
    try {
      anchor = checkAnchorDocument(anchorFile.raw);
      ledger = checkLedgerDocument(ledgerFile.raw);
      history = checkHistoryDocument(historyFile.raw);
    } catch (error) {
      if (error instanceof DocumentError) throw new ApprovalError('document_invalid');
      throw error;
    }
    if (anchor.keyId !== keyId || ledger.keyId !== keyId || history.keyId !== keyId) throw new ApprovalError('key_mismatch');
    verifyMac('anchor', anchor);
    verifyMac('ledger', ledger);
    verifyMac('history', history);
    if (ledger.lineage !== anchor.lineage || history.lineage !== anchor.lineage) throw new ApprovalError('lineage_mismatch');
    // Ledger × anchor: igual, ou exatamente uma geração à frente encadeada (queda antes do anchor).
    const head = ledgerHead(ledger);
    const ledgerOk =
      (ledger.generation === anchor.ledger.generation && head === anchor.ledger.head) ||
      (ledger.generation === anchor.ledger.generation + 1 && ledger.prevHead === anchor.ledger.head);
    if (!ledgerOk) throw new ApprovalError(ledger.generation < anchor.ledger.generation ? 'ledger_rollback' : 'ledger_anchor_mismatch');
    // Histórico × anchor: igual, ou à frente contendo o item registrado no anchor.
    const tip = historyTip(history.items);
    const historyOk =
      (tip.seq === anchor.history.seq && tip.head === anchor.history.head) ||
      (tip.seq > anchor.history.seq && history.items.some((item) => item.seq === anchor.history.seq && item.hash === anchor.history.head));
    if (!historyOk) throw new ApprovalError(tip.seq < anchor.history.seq ? 'history_rollback' : 'history_anchor_mismatch');
    if (ledger.epoch < anchor.epoch) throw new ApprovalError('epoch_rollback');
    return {
      lineage: ledger.lineage,
      keyId,
      generation: ledger.generation,
      head,
      epoch: Math.max(ledger.epoch, anchor.epoch),
      ledger: { approvals: ledger.approvals, attempts: ledger.attempts, barriers: ledger.barriers, compaction: ledger.compaction },
      history: { retentionDays: history.retentionDays, items: history.items, holds: history.holds },
    };
  }

  /**
   * Abertura de época (N1): aprovações concedidas em épocas anteriores e não consumidas expiram;
   * tentativas reservadas sem resultado viram `indeterminate` (sem repetição automática); entradas
   * do histórico que descrevem gerações não gravadas do ledger são marcadas como não aplicadas.
   */
  function openEpoch(tx: StoreTransaction, loadedGeneration: number, lockRecovered: boolean) {
    const system = { kind: 'system' as const, id: 'acc-approvals' };
    if (lockRecovered) tx.append({ event: 'approval.lock_recovered', actor: system, reason: 'stale_lock' });
    const unapplied = tx.history.items.filter((item) => item.kind === 'entry' && item.ledgerGeneration > loadedGeneration);
    if (unapplied.length > 0) tx.append({ event: 'approval.history_unapplied', actor: system, reason: 'ledger_write_lost', detail: `seq ${unapplied[0].seq}-${unapplied[unapplied.length - 1].seq}` });
    const at = iso();
    for (const approval of tx.ledger.approvals) {
      if (approval.state === 'approved' && approval.epoch !== tx.epoch) {
        approval.state = 'expired';
        approval.closedAt = at;
        approval.closedReason = 'instance_restart';
        tx.append({ event: 'approval.expired', actor: system, approvalId: approval.id, projectId: approval.binding.projectId, class: approval.class, action: approval.binding.action, bindingDigest: approval.bindingDigest, from: 'approved', to: 'expired', reason: 'instance_restart' });
      }
    }
    for (const attempt of tx.ledger.attempts) {
      if (attempt.state === 'reserved') {
        attempt.state = 'indeterminate';
        attempt.outcomeAt = at;
        attempt.reason = 'instance_restart';
        tx.append({ event: 'approval.attempt_indeterminate', actor: system, approvalId: attempt.approvalId, attemptId: attempt.id, from: 'reserved', to: 'indeterminate', reason: 'instance_restart' });
      }
    }
    tx.append({ event: 'approval.store_opened', actor: system, reason: 'epoch_started', detail: `epoch ${tx.epoch}` });
  }

  async function initialize() {
    try {
      approvalsDir = await secureDirectory(options.approvalsDir, options.environment);
      anchorDir = await secureDirectory(options.anchorDir, options.environment);
      assertSeparate(approvalsDir, anchorDir, options.environment.platform);
      lock = await acquireStoreLock(approvalsDir, now);
      const loadedKey = await options.keyProvider.load();
      key = loadedKey.key;
      keyId = loadedKey.keyId;
      const loaded = await load();
      if (loaded === 'fresh') {
        const lineage = randomUUID();
        const base: Loaded = { lineage, keyId, generation: 0, head: '', epoch: 1, ledger: emptyLedger(), history: { retentionDays: HISTORY_RETENTION_DAYS.default, items: [], holds: [] } };
        const d = draft(base, 1, (tx) => tx.append({ event: 'approval.store_initialized', actor: { kind: 'system', id: 'acc-approvals' }, reason: 'fresh_store', detail: 'epoch 1' }), true);
        current = await persist(base, { ledger: d.ledger, history: d.history, epoch: 1 }, true);
      } else {
        const epoch = loaded.epoch + 1;
        const d = draft(loaded, epoch, (tx) => openEpoch(tx, loaded.generation, lock!.recovered), true);
        current = await persist(loaded, { ledger: d.ledger, history: d.history, epoch }, true);
      }
      state = 'available';
      reason = null;
    } catch (error) {
      current = null;
      unavailable(error instanceof ApprovalError ? error.code : 'store_open_failed');
    }
  }

  await initialize();

  return {
    status: () => ({ state, reason }),
    epoch() {
      if (!current) throw new ApprovalError('store_unavailable');
      return current.epoch;
    },
    ledger() {
      if (!current) throw new ApprovalError('store_unavailable');
      return current.ledger;
    },
    history() {
      if (!current) throw new ApprovalError('store_unavailable');
      return current.history;
    },
    commit(change) {
      const run = queue.then(async () => {
        if (state !== 'available' || !current) throw new ApprovalError(state === 'degraded' ? 'store_degraded' : 'store_unavailable');
        const base = current;
        const d = draft(base, base.epoch, change);
        if (canonicalJson(d.ledger) === canonicalJson(base.ledger) && canonicalJson(d.history) === canonicalJson(base.history)) return d.result;
        try {
          current = await persist(base, { ledger: d.ledger, history: d.history, epoch: base.epoch });
        } catch (error) {
          if (error instanceof ApprovalError && (error.code === 'history_full' || error.code === 'ledger_full')) throw error;
          state = 'degraded';
          reason = 'write_failed';
          throw new ApprovalError('store_write_failed');
        }
        return d.result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    recover(input) {
      const run = queue.then(async () => {
        if (state !== 'unavailable') throw new ApprovalError('recovery_not_needed');
        if (!key || !lock) throw new ApprovalError(reason ?? 'store_unavailable');
        const quarantineId = `${iso().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const target = join(approvalsDir, QUARANTINE_DIR, quarantineId);
        await mkdir(target, { recursive: true, mode: 0o700 });
        const p = paths();
        // Evidências: ledger e histórico são MOVIDOS (nunca apagados); o anchor é copiado e depois
        // substituído pela gravação atômica do novo estado.
        let previousEpoch = 0;
        let previousLineage: string | null = null;
        for (const file of [p.ledger, p.anchor]) {
          try {
            const parsed = JSON.parse(await readFile(file, 'utf8')) as { epoch?: unknown; lineage?: unknown };
            if (typeof parsed.epoch === 'number' && Number.isSafeInteger(parsed.epoch) && parsed.epoch > previousEpoch) previousEpoch = parsed.epoch;
            if (typeof parsed.lineage === 'string' && /^[0-9a-f-]{36}$/.test(parsed.lineage)) previousLineage = parsed.lineage;
          } catch {
            // Ilegível: a evidência é preservada mesmo assim.
          }
        }
        for (const [file, name] of [[p.ledger, LEDGER_FILE], [p.history, HISTORY_FILE]] as const) {
          if (await checkRegularFile(file).catch(() => true)) await rename(file, join(target, name)).catch(() => undefined);
        }
        if (await checkRegularFile(p.anchor).catch(() => true)) await copyFile(p.anchor, join(target, ANCHOR_FILE)).catch(() => undefined);
        const lineage = randomUUID();
        const epoch = previousEpoch + 1;
        const base: Loaded = { lineage, keyId, generation: 0, head: '', epoch, ledger: emptyLedger(), history: { retentionDays: HISTORY_RETENTION_DAYS.default, items: [], holds: [] } };
        const d = draft(base, epoch, (tx) => {
          tx.ledger.barriers.global = { engagedAt: iso(), epoch, reason: 'recovery' };
          tx.append({ event: 'approval.store_recovered', actor: { kind: 'human', id: input.actorId }, reason: input.reason, detail: `quarantine ${quarantineId}${previousLineage ? ` lineage ${previousLineage}` : ''}`.slice(0, 300) });
          tx.append({ event: 'approval.barrier_engaged', actor: { kind: 'system', id: 'acc-approvals' }, reason: 'recovery', detail: 'scope global' });
        }, true);
        try {
          current = await persist(base, { ledger: d.ledger, history: d.history, epoch }, true);
        } catch {
          unavailable('recovery_write_failed');
          throw new ApprovalError('recovery_write_failed');
        }
        state = 'available';
        reason = null;
        return { quarantineId };
      });
      queue = run.catch(() => undefined);
      return run;
    },
    async close() {
      await queue.catch(() => undefined);
      state = 'unavailable';
      reason = 'closed';
      current = null;
      await lock?.release();
    },
  };
}

/** Lista as quarentenas existentes (evidências preservadas). */
export async function listQuarantine(approvalsDir: string): Promise<string[]> {
  try {
    return (await readdir(join(approvalsDir, QUARANTINE_DIR))).sort();
  } catch {
    return [];
  }
}

export { LOCK_FILE };
