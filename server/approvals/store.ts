import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, type WriteFile } from '../storage/jsonFile.ts';
import { canonicalJson, equalHex, macHex, without } from './canonical.ts';
import { ApprovalError, HISTORY_RETENTION_DAYS, type ApprovalEvent, type RecoveryReason } from './contracts.ts';
import {
  ANCHOR_FORMAT,
  checkAnchorDocument,
  checkHistoryDocument,
  checkInstallDocument,
  checkLedgerDocument,
  DOCUMENT_VERSION,
  DocumentError,
  entryHash,
  HISTORY_FORMAT,
  historyTip,
  INSTALL_FORMAT,
  LEDGER_FORMAT,
  ledgerHead,
  type AnchorDocument,
  type HistoryBody,
  type HistoryDocument,
  type HistoryEntry,
  type InstallDocument,
  type LedgerBody,
  type LedgerDocument,
} from './documents.ts';
import type { ApprovalKeyProvider } from './keyProvider.ts';
import { acquireStoreLock, LOCK_FILE, TAKEOVER_FILE, type LockFileOps, type StoreLock } from './lock.ts';
import { assertSeparate, checkRegularFile, secureDirectory, type PathEnvironment } from './paths.ts';

/**
 * Armazenamento durável do núcleo de aprovações (R2/R6).
 *
 * Documentos, cada um com HMAC-SHA256 (chave da `ApprovalKeyProvider`, `keyId` gravado):
 * - `approvals-install.json` — marcador de instalação, nos DOIS diretórios (R2 da revisão);
 * - `approvals-ledger.json` — estado mínimo (aprovações, tentativas, barreiras), com `generation`
 *   monotônica e `prevHead` (hash da versão anterior);
 * - `approvals-history.json` — histórico consultável, encadeado por hash, somente acréscimo;
 * - `approvals-anchor.json` — EM OUTRO DIRETÓRIO: `{generation, head}` do ledger e `{seq, head}` do
 *   histórico, mais a época e a linhagem.
 *
 * Uma alteração (`commit`) grava histórico → ledger → anchor, nessa ordem, cada um por escrita
 * atômica (tmp + fsync + rename). O estado em memória — e todo efeito que CONCEDE autoridade
 * (`afterCommit`) — só muda depois das três gravações. Qualquer falha deixa o armazenamento
 * DEGRADADO até reiniciar: nada mais é gravado nem consumido.
 *
 * Abertura: valida caminhos, adquire o bloqueio de escritor único, verifica marcadores, MAC,
 * formato, invariantes, linhagem e a coerência com o anchor (tolerando apenas a queda entre a
 * gravação do ledger/histórico e a do anchor). Inicia uma ÉPOCA nova (N1) e só então aceita
 * operações. Qualquer divergência → INDISPONÍVEL (nega tudo); os arquivos nunca são reescritos.
 *
 * Primeira instalação × perda (R2 da revisão): sem documentos, sem marcadores e sem vestígios
 * (quarentena, temporários) só se inicializa com `initialize: 'if_absent'` explícito; havendo
 * qualquer vestígio → `store_missing`. TODA instalação nova começa com BARREIRA GLOBAL ativa:
 * apagar o armazenamento nunca libera um bloqueio de emergência. Sem referência externa confiável,
 * a remoção COMPLETA dos dois diretórios é indistinguível de uma primeira instalação — por isso a
 * barreira inicial, que exige liberação humana com aprovação de configuração.
 *
 * Recuperação administrativa (`recover`): copia e VERIFICA (SHA-256 byte a byte) cada evidência na
 * quarentena, grava um manifesto verificado e só então inicia a nova linhagem. Falha em qualquer
 * etapa da quarentena → nada é alterado; falha ao gravar o novo estado → os arquivos originais são
 * restaurados (e verificados). Em ambos os casos o armazenamento continua INDISPONÍVEL.
 */

export const LEDGER_FILE = 'approvals-ledger.json';
export const HISTORY_FILE = 'approvals-history.json';
export const ANCHOR_FILE = 'approvals-anchor.json';
export const INSTALL_FILE = 'approvals-install.json';
export const QUARANTINE_DIR = 'quarantine';
export const MANIFEST_FILE = 'manifest.json';
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/** Vestígios de uma instalação anterior (além dos documentos). */
const TRACE = /^approvals-(ledger|history|anchor|install)\.json(\..+\.tmp)?$/;

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
  /**
   * Efeito em memória que só pode acontecer se a gravação der certo (R3 da revisão): tudo o que
   * CONCEDE ou RESTAURA autoridade (prazo de uso, liberação de barreira volátil). Efeitos que só
   * restringem (invalidar recibo, apagar prazo, acionar barreira) podem ser imediatos.
   */
  afterCommit(effect: () => void): void;
}

/** Gravação de bytes (quarentena e restauração), injetável para testes de falha. */
export type WriteBytes = (path: string, content: Buffer) => Promise<void>;

export interface OpenStoreOptions {
  approvalsDir: string;
  anchorDir: string;
  keyProvider: ApprovalKeyProvider;
  environment: PathEnvironment;
  /** `never` (padrão): sem documentos, indisponível. `if_absent`: primeira instalação explícita. */
  initialize?: 'never' | 'if_absent';
  now?: () => number;
  writeFile?: WriteFile;
  writeBytes?: WriteBytes;
  lockOps?: LockFileOps;
}

export interface ApprovalStore {
  status(): { state: StoreState; reason: string | null };
  epoch(): number;
  ledger(): Readonly<LedgerBody>;
  history(): Readonly<HistoryBody>;
  /** Aplica uma alteração atômica. `change` é síncrona; se lançar, nada é gravado. */
  commit<R>(change: (tx: StoreTransaction) => R): Promise<R>;
  /**
   * Recuperação ADMINISTRATIVA (só quando indisponível por integridade/ausência). A autorização
   * humana é verificada pelo serviço antes de chamar isto.
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
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
/** Recuperação não se aplica a estes motivos (não são de integridade/ausência). */
const NOT_RECOVERABLE = ['store_locked', 'lock_recovery_stale', 'lock_recovery_failed', 'lock_unavailable', 'store_not_initialized', 'closed', 'opening'];

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

/** Escrita atômica de bytes (tmp exclusivo + fsync + rename), sem conversão de codificação. */
export async function writeBytesAtomic(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function openApprovalStore(options: OpenStoreOptions): Promise<ApprovalStore> {
  const now = options.now ?? Date.now;
  const write = options.writeFile ?? writeFileAtomic;
  const writeBytes = options.writeBytes ?? writeBytesAtomic;
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

  const paths = () => ({
    ledger: join(approvalsDir, LEDGER_FILE),
    history: join(approvalsDir, HISTORY_FILE),
    anchor: join(anchorDir, ANCHOR_FILE),
    installA: join(approvalsDir, INSTALL_FILE),
    installB: join(anchorDir, INSTALL_FILE),
  });
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

  async function writeInstallMarkers(lineage: string) {
    const marker = canonicalJson(sign<InstallDocument>('install', { format: INSTALL_FORMAT, version: DOCUMENT_VERSION, lineage, keyId, createdAt: iso() }));
    const p = paths();
    await write(p.installA, marker);
    await write(p.installB, marker);
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
   * Executa `change` sobre rascunhos e devolve os rascunhos, o resultado e os efeitos pós-gravação
   * (sem gravar). As entradas do histórico são montadas DEPOIS, quando se sabe a geração.
   */
  function draft<R>(base: Loaded, epoch: number, change: (tx: StoreTransaction) => R, forceLedger = false) {
    const ledger = structuredClone(base.ledger);
    const history = structuredClone(base.history);
    const pending: HistoryInput[] = [];
    const effects: Array<() => void> = [];
    const result = change({ ledger, history, epoch, append: (input) => pending.push(input), afterCommit: (effect) => effects.push(effect) });
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
    return { ledger, history, result, effects };
  }

  const runEffects = (effects: Array<() => void>) => {
    for (const effect of effects) {
      try {
        effect();
      } catch {
        // Efeitos são operações simples em memória; uma falha não pode desfazer a gravação.
      }
    }
  };

  /** Há vestígio de instalação anterior em algum dos diretórios? */
  async function hasTraces(): Promise<boolean> {
    for (const dir of [approvalsDir, anchorDir]) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return true; // Na dúvida, não é uma primeira instalação.
      }
      if (entries.some((name) => name === QUARANTINE_DIR || name === TAKEOVER_FILE || TRACE.test(name))) return true;
    }
    return false;
  }

  async function load(): Promise<Loaded | 'fresh'> {
    const p = paths();
    const [ledgerFile, historyFile, anchorFile, installA, installB] = [
      await readOptional(p.ledger),
      await readOptional(p.history),
      await readOptional(p.anchor),
      await readOptional(p.installA),
      await readOptional(p.installB),
    ];
    if (!ledgerFile && !historyFile && !anchorFile) {
      if (installA || installB || (await hasTraces())) throw new ApprovalError('store_missing');
      if (options.initialize !== 'if_absent') throw new ApprovalError('store_not_initialized');
      return 'fresh';
    }
    if (!installA || !installB) throw new ApprovalError('install_marker_missing');
    if (!anchorFile) throw new ApprovalError('anchor_missing');
    if (!ledgerFile) throw new ApprovalError('ledger_missing');
    if (!historyFile) throw new ApprovalError('history_missing');
    let anchor: AnchorDocument;
    let ledger: LedgerDocument;
    let history: HistoryDocument;
    let markers: InstallDocument[];
    try {
      anchor = checkAnchorDocument(anchorFile.raw);
      ledger = checkLedgerDocument(ledgerFile.raw);
      history = checkHistoryDocument(historyFile.raw);
      markers = [checkInstallDocument(installA.raw), checkInstallDocument(installB.raw)];
    } catch (error) {
      if (error instanceof DocumentError) throw new ApprovalError('document_invalid');
      throw error;
    }
    if ([anchor, ledger, history, ...markers].some((doc) => doc.keyId !== keyId)) throw new ApprovalError('key_mismatch');
    verifyMac('anchor', anchor);
    verifyMac('ledger', ledger);
    verifyMac('history', history);
    for (const marker of markers) verifyMac('install', marker);
    if ([ledger, history, ...markers].some((doc) => doc.lineage !== anchor.lineage)) throw new ApprovalError('lineage_mismatch');
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

  /** Nova linhagem vazia, SEMPRE com barreira global (instalação nova ou recuperação). */
  async function startLineage(epoch: number, barrierReason: 'initial_install' | 'recovery', events: (tx: StoreTransaction) => void): Promise<Loaded> {
    const lineage = randomUUID();
    const base: Loaded = { lineage, keyId, generation: 0, head: '', epoch, ledger: emptyLedger(), history: { retentionDays: HISTORY_RETENTION_DAYS.default, items: [], holds: [] } };
    const d = draft(base, epoch, (tx) => {
      events(tx);
      tx.ledger.barriers.global = { engagedAt: iso(), epoch, reason: barrierReason };
      tx.append({ event: 'approval.barrier_engaged', actor: { kind: 'system', id: 'acc-approvals' }, reason: barrierReason, detail: 'scope global' });
    }, true);
    await writeInstallMarkers(lineage);
    return persist(base, { ledger: d.ledger, history: d.history, epoch }, true);
  }

  async function initialize() {
    try {
      approvalsDir = await secureDirectory(options.approvalsDir, options.environment);
      anchorDir = await secureDirectory(options.anchorDir, options.environment);
      assertSeparate(approvalsDir, anchorDir, options.environment.platform);
      lock = await acquireStoreLock(approvalsDir, { now, ops: options.lockOps });
      const loadedKey = await options.keyProvider.load();
      key = loadedKey.key;
      keyId = loadedKey.keyId;
      const loaded = await load();
      if (loaded === 'fresh') {
        current = await startLineage(1, 'initial_install', (tx) => tx.append({ event: 'approval.store_initialized', actor: { kind: 'system', id: 'acc-approvals' }, reason: 'fresh_store', detail: 'epoch 1' }));
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
        if (canonicalJson(d.ledger) === canonicalJson(base.ledger) && canonicalJson(d.history) === canonicalJson(base.history)) {
          runEffects(d.effects);
          return d.result;
        }
        try {
          current = await persist(base, { ledger: d.ledger, history: d.history, epoch: base.epoch });
        } catch (error) {
          if (error instanceof ApprovalError && (error.code === 'history_full' || error.code === 'ledger_full')) throw error;
          state = 'degraded';
          reason = 'write_failed';
          throw new ApprovalError('store_write_failed');
        }
        runEffects(d.effects);
        return d.result;
      });
      queue = run.catch(() => undefined);
      return run;
    },
    recover(input) {
      const run = queue.then(async () => {
        if (state !== 'unavailable') throw new ApprovalError('recovery_not_needed');
        if (!key || !lock || NOT_RECOVERABLE.includes(reason ?? '')) throw new ApprovalError(reason && NOT_RECOVERABLE.includes(reason) ? `recovery_refused_${reason}`.slice(0, 64) : 'store_unavailable');
        const p = paths();
        const quarantineId = `${iso().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const target = join(approvalsDir, QUARANTINE_DIR, quarantineId);
        const evidence = [
          { name: LEDGER_FILE, path: p.ledger },
          { name: HISTORY_FILE, path: p.history },
          { name: ANCHOR_FILE, path: p.anchor },
          { name: `approvals-dir-${INSTALL_FILE}`, path: p.installA },
          { name: `anchor-dir-${INSTALL_FILE}`, path: p.installB },
        ];
        const originals = new Map<string, Buffer | null>();

        // 1) Quarentena verificada. Qualquer falha aqui: nada foi alterado fora da quarentena.
        try {
          await mkdir(join(approvalsDir, QUARANTINE_DIR), { recursive: true, mode: 0o700 });
          await mkdir(target, { mode: 0o700 });
        } catch {
          throw new ApprovalError('quarantine_failed');
        }
        const manifest: Array<{ name: string; present: boolean; sha256: string | null; bytes: number }> = [];
        for (const item of evidence) {
          let present: boolean;
          try {
            present = await checkRegularFile(item.path);
          } catch {
            throw new ApprovalError('quarantine_unsupported_file');
          }
          if (!present) {
            originals.set(item.path, null);
            manifest.push({ name: item.name, present: false, sha256: null, bytes: 0 });
            continue;
          }
          let data: Buffer;
          try {
            data = await readFile(item.path);
          } catch {
            throw new ApprovalError('quarantine_read_failed');
          }
          try {
            await writeBytes(join(target, item.name), data);
          } catch {
            throw new ApprovalError('quarantine_write_failed');
          }
          let copy: Buffer;
          try {
            copy = await readFile(join(target, item.name));
          } catch {
            throw new ApprovalError('quarantine_verification_failed');
          }
          if (sha(copy) !== sha(data) || copy.length !== data.length) throw new ApprovalError('quarantine_verification_failed');
          originals.set(item.path, data);
          manifest.push({ name: item.name, present: true, sha256: sha(data), bytes: data.length });
        }
        const manifestBytes = Buffer.from(canonicalJson({ format: 'acc-approvals-quarantine', version: 1, quarantineId, createdAt: iso(), reason: input.reason, actor: input.actorId, files: manifest }), 'utf8');
        try {
          await writeBytes(join(target, MANIFEST_FILE), manifestBytes);
          if (sha(await readFile(join(target, MANIFEST_FILE))) !== sha(manifestBytes)) throw new Error('mismatch');
        } catch {
          throw new ApprovalError('quarantine_verification_failed');
        }

        // 2) Época anterior (melhor esforço; só serve para continuar crescendo).
        let previousEpoch = 0;
        let previousLineage: string | null = null;
        for (const path of [p.ledger, p.anchor]) {
          const data = originals.get(path);
          if (!data) continue;
          try {
            const parsed = JSON.parse(data.toString('utf8')) as { epoch?: unknown; lineage?: unknown };
            if (typeof parsed.epoch === 'number' && Number.isSafeInteger(parsed.epoch) && parsed.epoch > previousEpoch) previousEpoch = parsed.epoch;
            if (typeof parsed.lineage === 'string' && /^[0-9a-f-]{36}$/.test(parsed.lineage)) previousLineage = parsed.lineage;
          } catch {
            // Ilegível: a evidência já está preservada e verificada.
          }
        }

        // 3) Nova linhagem. Falha → restaura os originais (verificados) e continua indisponível.
        try {
          const manifestSha = sha(manifestBytes);
          current = await startLineage(previousEpoch + 1, 'recovery', (tx) =>
            tx.append({
              event: 'approval.store_recovered',
              actor: { kind: 'human', id: input.actorId },
              reason: input.reason,
              detail: `quarantine ${quarantineId} manifest ${manifestSha.slice(0, 16)}${previousLineage ? ` lineage ${previousLineage}` : ''}`,
            }),
          );
        } catch {
          current = null;
          let restored = true;
          for (const item of evidence) {
            const data = originals.get(item.path);
            try {
              if (data) {
                await writeBytes(item.path, data);
                if (sha(await readFile(item.path)) !== sha(data)) restored = false;
              } else {
                await rm(item.path, { force: true });
              }
            } catch {
              restored = false;
            }
          }
          unavailable(restored ? 'recovery_failed' : 'recovery_restore_failed');
          throw new ApprovalError(restored ? 'recovery_failed' : 'recovery_restore_failed');
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

export { LOCK_FILE, TAKEOVER_FILE };
