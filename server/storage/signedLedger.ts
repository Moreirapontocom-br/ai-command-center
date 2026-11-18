import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, equalHex, namespacedMacHex, sha256Hex, without } from './canonical.ts';
import { StorageError } from './errors.ts';
import { isIsoDate, writeFileAtomic, type WriteFile } from './jsonFile.ts';
import { acquireLock, type LockFileOps, type StoreLock } from './lock.ts';
import { assertSeparate, checkRegularFile, secureDirectory, type PathEnvironment } from './paths.ts';

/**
 * Motor genérico de ledger assinado (Issue #012, D2). Segue o MESMO desenho do armazenamento de
 * aprovações (#011, módulo `store` das aprovações), que continua com a implementação própria (sem
 * migração nesta etapa):
 *
 * Documentos, cada um com HMAC-SHA256 (subchave do domínio, `keyId` gravado):
 * - `<prefixo>-install.json` — marcador de instalação, nos DOIS diretórios;
 * - `<prefixo>-ledger.json` — estado (corpo definido pelo chamador), com `generation` monotônica e
 *   `prevHead` (hash da versão anterior);
 * - `<prefixo>-history.json` — histórico lógico SOMENTE ACRÉSCIMO, encadeado por hash (`seq`
 *   contínuo desde 1, `prevHash`); itens nunca são alterados nem removidos;
 * - `<prefixo>-anchor.json` — NO DIRETÓRIO DE ANCHOR: `{generation, head}` do ledger, `{seq, head}`
 *   do histórico, época e linhagem.
 *
 * Gravação (`commit`): histórico → ledger → anchor, cada um atômico (tmp + fsync + rename). O estado
 * em memória só muda depois das três. Qualquer falha deixa o armazenamento DEGRADADO até reiniciar
 * (nada mais é gravado). A alteração é validada ANTES de gravar (`checkChange` + `checkBody`): uma
 * alteração inválida é recusada sem degradar e sem tocar no disco.
 *
 * Abertura: valida caminhos (fora do Git e de pastas sincronizadas), adquire o bloqueio de escritor
 * único, verifica marcadores, MAC, formato, encadeamento, linhagem e a coerência com o anchor
 * (tolerando APENAS a queda entre a gravação do ledger/histórico e a do anchor). Abre uma ÉPOCA nova
 * e só então aceita operações. Qualquer divergência → INDISPONÍVEL; os arquivos nunca são reescritos.
 *
 * Primeira instalação × perda: sem documentos, sem marcadores e sem vestígios só se inicializa com
 * `initialize: 'if_absent'` explícito; havendo vestígio → `store_missing`. A remoção COMPLETA dos
 * arquivos (inclusive os do diretório de anchor) é indistinguível de uma primeira instalação — por
 * isso o chamador é avisado de toda linhagem nova (`onLineage`) para reagir de forma conservadora.
 *
 * Recuperação administrativa (`recover`): copia e VERIFICA (SHA-256) cada evidência na quarentena,
 * grava um manifesto verificado e só então inicia a nova linhagem. Falha na quarentena → nada muda;
 * falha ao gravar o novo estado → os originais são restaurados (e verificados). Em ambos os casos o
 * armazenamento continua INDISPONÍVEL.
 *
 * Exclusão mútua: processos na mesma máquina, disco local (ver `lock.ts`); dentro do processo, todas
 * as operações passam por uma fila única.
 */

export type LedgerState = 'available' | 'degraded' | 'unavailable';
/** Como a instância atual foi aberta. */
export type OpenedAs = 'initial_install' | 'restart' | 'recovery';

export const DOCUMENT_VERSION = 1;
export const QUARANTINE_DIR = 'quarantine';
export const MANIFEST_FILE = 'manifest.json';
const DEFAULT_MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_HISTORY_BYTES = 32 * 1024 * 1024;
/** Motivos de indisponibilidade que NÃO são de integridade/ausência (recuperação não se aplica). */
export const NOT_RECOVERABLE = ['store_locked', 'lock_recovery_stale', 'lock_recovery_failed', 'lock_unavailable', 'store_not_initialized', 'closed', 'opening', 'key_unavailable', 'key_invalid'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const PREFIX = /^[a-z][a-z0-9-]{0,31}$/;
const NAMESPACE = /^acc-[a-z0-9-]+:v[1-9][0-9]*$/;
const REASON = /^[a-z0-9_]{1,64}$/;
const ACTOR_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

export interface SignedLedgerKey {
  readonly keyId: string;
  readonly key: Buffer;
}

export interface HistoryEntry<D> {
  seq: number;
  at: string;
  prevHash: string | null;
  hash: string;
  /** Geração do ledger que esta entrada descreve (permite detectar entradas não aplicadas). */
  ledgerGeneration: number;
  data: D;
}

export interface LedgerTransaction<B, D> {
  /** Rascunho (cópia) do corpo. */
  body: B;
  epoch: number;
  /** Acrescenta uma entrada ao histórico (aplicada só se a gravação der certo). */
  append(data: D): void;
}

export interface EpochInfo {
  lockRecovered: boolean;
  /** Geração do ledger carregada do disco. */
  loadedGeneration: number;
  /** Entradas do histórico que descrevem gerações do ledger que não chegaram ao disco. */
  unapplied: { first: number; last: number } | null;
}

/** Contrato do conteúdo: o motor não conhece o corpo nem os eventos, só os valida pelo chamador. */
export interface SignedLedgerSpec<B, D> {
  /** Prefixo dos MACs e hashes, ex.: `acc-queue:v1`. */
  namespace: string;
  /** Prefixo dos formatos, ex.: `acc-queue` → `acc-queue-ledger`. */
  format: string;
  /** Prefixo dos arquivos, ex.: `queue` → `queue-ledger.json`, `queue.lock`. */
  filePrefix: string;
  emptyBody(): B;
  /** Validação ESTRITA do corpo (lança em qualquer problema). Devolve o corpo validado. */
  checkBody(raw: unknown): B;
  /** Validação ESTRITA dos dados de uma entrada do histórico (lança em qualquer problema). */
  checkEntry(raw: unknown): D;
  /**
   * Regras entre versões (ex.: transições permitidas). Lança para recusar a alteração. `context`
   * traz a época da gravação e a permissão opaca que o DONO do motor (nunca um chamador público)
   * passou a `commit` — ex.: a remoção de um pedido de barreira já confirmado (R2).
   */
  checkChange?(before: Readonly<B>, after: Readonly<B>, context: ChangeContext): void;
  /** Abertura de cada época (reinício normal): ajustes conservadores no estado. */
  onEpoch(tx: LedgerTransaction<B, D>, info: EpochInfo): void;
  /** Linhagem nova (primeira instalação ou recuperação). */
  onLineage(tx: LedgerTransaction<B, D>, cause: 'initial_install' | 'recovery', detail: string | null): void;
}

export type WriteBytes = (path: string, content: Buffer) => Promise<void>;

export interface ChangeContext {
  /** Época da gravação. */
  epoch: number;
  /** Permissão opaca concedida pelo dono do motor para ESTA gravação (padrão `null`). */
  allow: unknown;
}

export interface OpenSignedLedgerOptions<B, D> {
  spec: SignedLedgerSpec<B, D>;
  dataDir: string;
  anchorDir: string;
  environment: PathEnvironment;
  /** Chave do domínio (já derivada). Lida DEPOIS de adquirir o bloqueio. */
  loadKey: () => Promise<SignedLedgerKey> | SignedLedgerKey;
  /** Outros diretórios dos quais `dataDir` precisa ser separado (ex.: o do ledger de aprovações). */
  separateFrom?: readonly string[];
  /** `never` (padrão): sem documentos, indisponível. `if_absent`: primeira instalação explícita. */
  initialize?: 'never' | 'if_absent';
  now?: () => number;
  writeFile?: WriteFile;
  writeBytes?: WriteBytes;
  lockOps?: LockFileOps;
  alive?: (pid: number) => boolean;
  maxLedgerBytes?: number;
  maxHistoryBytes?: number;
}

export interface SignedLedger<B, D> {
  status(): { state: LedgerState; reason: string | null };
  openedAs(): OpenedAs | null;
  lineage(): string;
  epoch(): number;
  /**
   * Leituras (R1): o estado devolvido é CONGELADO em profundidade, em tempo de execução. Qualquer
   * tentativa de modificação lança `TypeError` (módulos ES são estritos) e o estado interno não
   * muda; só `commit` altera o estado.
   */
  body(): Readonly<B>;
  history(): ReadonlyArray<Readonly<HistoryEntry<D>>>;
  /**
   * Aplica uma alteração atômica. `change` é síncrona e recebe CÓPIAS; se lançar, nada é gravado.
   * `allow` é repassado a `checkChange`: só o dono do motor o fornece (nunca exponha o parâmetro).
   */
  commit<R>(change: (tx: LedgerTransaction<B, D>) => R, allow?: unknown): Promise<R>;
  /** Recuperação ADMINISTRATIVA (só quando indisponível por integridade/ausência). */
  recover(input: { actorId: string; reason: string }): Promise<{ quarantineId: string }>;
  close(): Promise<void>;
}

interface LedgerDocument<B> {
  format: string;
  version: number;
  lineage: string;
  keyId: string;
  generation: number;
  prevHead: string | null;
  epoch: number;
  updatedAt: string;
  body: B;
  mac: string;
}

interface HistoryDocument<D> {
  format: string;
  version: number;
  lineage: string;
  keyId: string;
  items: HistoryEntry<D>[];
  mac: string;
}

interface AnchorDocument {
  format: string;
  version: number;
  lineage: string;
  keyId: string;
  epoch: number;
  ledger: { generation: number; head: string };
  history: { seq: number; head: string };
  updatedAt: string;
  mac: string;
}

interface InstallDocument {
  format: string;
  version: number;
  lineage: string;
  keyId: string;
  createdAt: string;
  mac: string;
}

interface Loaded<B, D> {
  lineage: string;
  generation: number;
  head: string;
  epoch: number;
  body: B;
  items: HistoryEntry<D>[];
}

class DocumentError extends Error {
  name = 'DocumentError';
}

const fail = (what: string): never => {
  throw new DocumentError(what);
};
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exactKeys(value: unknown, expected: readonly string[], what: string): Record<string, unknown> {
  if (!isPlain(value)) fail(what);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== expected.length || !expected.every((key) => Object.hasOwn(record, key))) fail(what);
  return record;
}
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPositive = (v: unknown): v is number => isCount(v) && v > 0;
const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isKeyId = (v: unknown): v is string => typeof v === 'string' && KEY_ID.test(v);
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Congela objetos e arrays em profundidade (valores JSON) e devolve o próprio valor. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

async function readOptional(path: string): Promise<{ raw: unknown } | null> {
  if (!(await checkRegularFile(path))) return null;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new StorageError('file_unreadable');
  }
  try {
    return { raw: JSON.parse(text) };
  } catch {
    return { raw: undefined };
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

export function fileNames(prefix: string) {
  return {
    ledger: `${prefix}-ledger.json`,
    history: `${prefix}-history.json`,
    anchor: `${prefix}-anchor.json`,
    install: `${prefix}-install.json`,
    lock: `${prefix}.lock`,
    takeover: `${prefix}.lock.takeover`,
  };
}

export async function openSignedLedger<B, D>(options: OpenSignedLedgerOptions<B, D>): Promise<SignedLedger<B, D>> {
  const { spec } = options;
  if (!PREFIX.test(spec.filePrefix) || !NAMESPACE.test(spec.namespace) || !/^acc-[a-z0-9-]+$/.test(spec.format)) throw new StorageError('spec_invalid');
  const now = options.now ?? Date.now;
  const write = options.writeFile ?? writeFileAtomic;
  const writeBytes = options.writeBytes ?? writeBytesAtomic;
  const maxLedger = options.maxLedgerBytes ?? DEFAULT_MAX_LEDGER_BYTES;
  const maxHistory = options.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  const names = fileNames(spec.filePrefix);
  const formats = { ledger: `${spec.format}-ledger`, history: `${spec.format}-history`, anchor: `${spec.format}-anchor`, install: `${spec.format}-install`, quarantine: `${spec.format}-quarantine` };
  const escaped = spec.filePrefix.replace(/[-]/g, '\\-');
  const dataTrace = new RegExp(`^${escaped}-(ledger|history|anchor|install)\\.json(\\..+\\.tmp)?$`);
  const anchorTrace = new RegExp(`^${escaped}-(anchor|install)\\.json(\\..+\\.tmp)?$`);
  const iso = () => new Date(now()).toISOString();

  let state: LedgerState = 'unavailable';
  let reason: string | null = 'opening';
  let openedAs: OpenedAs | null = null;
  let key: Buffer | null = null;
  let keyId = '';
  let lock: StoreLock | null = null;
  let dataDir = '';
  let anchorDir = '';
  let current: Loaded<B, D> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const paths = () => ({
    ledger: join(dataDir, names.ledger),
    history: join(dataDir, names.history),
    anchor: join(anchorDir, names.anchor),
    installA: join(dataDir, names.install),
    installB: join(anchorDir, names.install),
  });
  const unavailable = (code: string) => {
    state = 'unavailable';
    reason = code;
  };
  const mac = (domain: string, doc: object) => namespacedMacHex(key!, spec.namespace, domain, doc);
  function sign<T extends { mac: string }>(domain: string, doc: Omit<T, 'mac'>): T {
    return { ...doc, mac: mac(domain, doc) } as T;
  }
  function verifyMac(domain: string, doc: { mac: string }) {
    if (!equalHex(doc.mac, mac(domain, without(doc, 'mac')))) throw new StorageError('mac_invalid');
  }
  const entryHash = (entry: Omit<HistoryEntry<D>, 'hash'>) => sha256Hex(`${spec.namespace}:history-entry\n${canonicalJson(entry)}`);
  const ledgerHead = (doc: LedgerDocument<B>) => sha256Hex(`${spec.namespace}:ledger-head\n${canonicalJson(without(doc, 'mac'))}`);
  const tipOf = (items: HistoryEntry<D>[]) => (items.length === 0 ? { seq: 0, head: null } : { seq: items[items.length - 1].seq, head: items[items.length - 1].hash });

  // --- Validação estrita dos documentos -------------------------------------------------------
  function header(d: Record<string, unknown>, format: string, what: string) {
    if (d.format !== format || d.version !== DOCUMENT_VERSION) fail(what);
    if (!isUuid(d.lineage) || !isKeyId(d.keyId) || !isHex64(d.mac)) fail(what);
  }
  function checkLedgerDocument(raw: unknown): LedgerDocument<B> {
    const d = exactKeys(raw, ['format', 'version', 'lineage', 'keyId', 'generation', 'prevHead', 'epoch', 'updatedAt', 'body', 'mac'], 'ledger');
    header(d, formats.ledger, 'ledger');
    if (!isPositive(d.generation) || !(d.prevHead === null || isHex64(d.prevHead)) || !isPositive(d.epoch) || !isIsoDate(d.updatedAt)) fail('ledger');
    if ((d.generation === 1) !== (d.prevHead === null)) fail('ledger');
    let body: B;
    try {
      body = spec.checkBody(d.body);
    } catch {
      return fail('corpo do ledger');
    }
    return { ...(d as unknown as LedgerDocument<B>), body };
  }
  function checkItems(raw: unknown): HistoryEntry<D>[] {
    if (!Array.isArray(raw)) fail('histórico');
    const items: HistoryEntry<D>[] = [];
    for (const [index, value] of (raw as unknown[]).entries()) {
      const what = `histórico ${index}`;
      const e = exactKeys(value, ['seq', 'at', 'prevHash', 'hash', 'ledgerGeneration', 'data'], what);
      if (e.seq !== index + 1 || !isIsoDate(e.at) || !isHex64(e.hash) || !isCount(e.ledgerGeneration)) fail(what);
      const expectedPrev = index === 0 ? null : items[index - 1].hash;
      if (e.prevHash !== expectedPrev) fail(`${what} (encadeamento)`);
      let data: D;
      try {
        data = spec.checkEntry(e.data);
      } catch {
        return fail(what);
      }
      const entry = { ...(e as unknown as HistoryEntry<D>), data };
      if (e.hash !== entryHash(without(entry, 'hash'))) fail(`${what} (hash)`);
      items.push(entry);
    }
    return items;
  }
  function checkHistoryDocument(raw: unknown): HistoryDocument<D> {
    const d = exactKeys(raw, ['format', 'version', 'lineage', 'keyId', 'items', 'mac'], 'histórico');
    header(d, formats.history, 'histórico');
    const items = checkItems(d.items);
    if (items.length === 0) fail('histórico vazio');
    return { ...(d as unknown as HistoryDocument<D>), items };
  }
  function checkAnchorDocument(raw: unknown): AnchorDocument {
    const d = exactKeys(raw, ['format', 'version', 'lineage', 'keyId', 'epoch', 'ledger', 'history', 'updatedAt', 'mac'], 'anchor');
    header(d, formats.anchor, 'anchor');
    if (!isPositive(d.epoch) || !isIsoDate(d.updatedAt)) fail('anchor');
    const l = exactKeys(d.ledger, ['generation', 'head'], 'anchor');
    const h = exactKeys(d.history, ['seq', 'head'], 'anchor');
    if (!isPositive(l.generation) || !isHex64(l.head) || !isPositive(h.seq) || !isHex64(h.head)) fail('anchor');
    return d as unknown as AnchorDocument;
  }
  function checkInstallDocument(raw: unknown): InstallDocument {
    const d = exactKeys(raw, ['format', 'version', 'lineage', 'keyId', 'createdAt', 'mac'], 'marcador');
    header(d, formats.install, 'marcador');
    if (!isIsoDate(d.createdAt)) fail('marcador');
    return d as unknown as InstallDocument;
  }

  // --- Gravação ---------------------------------------------------------------------------------
  async function writeInstallMarkers(lineage: string) {
    const marker = canonicalJson(sign<InstallDocument>('install', { format: formats.install, version: DOCUMENT_VERSION, lineage, keyId, createdAt: iso() }));
    const p = paths();
    await write(p.installA, marker);
    await write(p.installB, marker);
  }

  /** Monta os documentos e grava histórico → ledger → anchor. Tamanhos verificados ANTES de gravar. */
  async function persist(base: Loaded<B, D>, next: { body: B; items: HistoryEntry<D>[]; epoch: number; lineage?: string }, force = false): Promise<Loaded<B, D>> {
    const lineage = next.lineage ?? base.lineage;
    const ledgerChanged = force || canonicalJson(next.body) !== canonicalJson(base.body) || next.epoch !== base.epoch;
    const historyChanged = force || next.items.length !== base.items.length;
    let generation = base.generation;
    let head = base.head;
    const at = iso();
    const writes: Array<() => Promise<void>> = [];
    if (historyChanged) {
      const content = canonicalJson(sign<HistoryDocument<D>>('history', { format: formats.history, version: DOCUMENT_VERSION, lineage, keyId, items: structuredClone(next.items) }));
      if (Buffer.byteLength(content) > maxHistory) throw new StorageError('history_full');
      writes.push(() => write(paths().history, content));
    }
    if (ledgerChanged) {
      generation = base.generation + 1;
      const doc = sign<LedgerDocument<B>>('ledger', {
        format: formats.ledger,
        version: DOCUMENT_VERSION,
        lineage,
        keyId,
        generation,
        prevHead: base.generation === 0 ? null : base.head,
        epoch: next.epoch,
        updatedAt: at,
        body: structuredClone(next.body),
      });
      head = ledgerHead(doc);
      const content = canonicalJson(doc);
      if (Buffer.byteLength(content) > maxLedger) throw new StorageError('ledger_full');
      writes.push(() => write(paths().ledger, content));
    }
    const tip = tipOf(next.items);
    if (tip.head === null) throw new StorageError('history_empty');
    const anchor = sign<AnchorDocument>('anchor', { format: formats.anchor, version: DOCUMENT_VERSION, lineage, keyId, epoch: next.epoch, ledger: { generation, head }, history: { seq: tip.seq, head: tip.head }, updatedAt: at });
    writes.push(() => write(paths().anchor, canonicalJson(anchor)));
    for (const step of writes) await step();
    // R1: o estado em memória é congelado em profundidade; nenhuma leitura permite alterá-lo.
    return { lineage, generation, head, epoch: next.epoch, body: deepFreeze(structuredClone(next.body)), items: deepFreeze(structuredClone(next.items)) };
  }

  /** Executa `change` sobre rascunhos e valida o resultado (sem gravar). */
  function draft<R>(base: Loaded<B, D>, epoch: number, change: (tx: LedgerTransaction<B, D>) => R, forceLedger = false, allow: unknown = null) {
    const body = structuredClone(base.body);
    const pending: D[] = [];
    const result = change({ body, epoch, append: (data) => pending.push(structuredClone(data)) });
    if (spec.checkChange) {
      try {
        spec.checkChange(base.body, body, { epoch, allow });
      } catch {
        throw new StorageError('change_rejected');
      }
    }
    let checked: B;
    try {
      checked = spec.checkBody(structuredClone(body));
      for (const data of pending) spec.checkEntry(data);
    } catch {
      throw new StorageError('change_invalid');
    }
    const ledgerChanged = forceLedger || canonicalJson(checked) !== canonicalJson(base.body);
    const generation = ledgerChanged ? base.generation + 1 : base.generation;
    const at = iso();
    const items = [...base.items];
    for (const data of pending) {
      const tip = tipOf(items);
      const entry: Omit<HistoryEntry<D>, 'hash'> = { seq: tip.seq + 1, at, prevHash: tip.head, ledgerGeneration: generation, data };
      items.push({ ...entry, hash: entryHash(entry) });
    }
    return { body: checked, items, result, changed: ledgerChanged || pending.length > 0 };
  }

  /** Há vestígio de instalação anterior em algum dos diretórios? */
  async function hasTraces(): Promise<boolean> {
    for (const [dir, pattern, extra] of [
      [dataDir, dataTrace, [QUARANTINE_DIR, names.takeover]],
      [anchorDir, anchorTrace, []],
    ] as const) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return true; // Na dúvida, não é uma primeira instalação.
      }
      if (entries.some((name) => (extra as readonly string[]).includes(name) || pattern.test(name))) return true;
    }
    return false;
  }

  async function load(): Promise<Loaded<B, D> | 'fresh'> {
    const p = paths();
    const ledgerFile = await readOptional(p.ledger);
    const historyFile = await readOptional(p.history);
    const anchorFile = await readOptional(p.anchor);
    const installA = await readOptional(p.installA);
    const installB = await readOptional(p.installB);
    if (!ledgerFile && !historyFile && !anchorFile) {
      if (installA || installB || (await hasTraces())) throw new StorageError('store_missing');
      if (options.initialize !== 'if_absent') throw new StorageError('store_not_initialized');
      return 'fresh';
    }
    if (!installA || !installB) throw new StorageError('install_marker_missing');
    if (!anchorFile) throw new StorageError('anchor_missing');
    if (!ledgerFile) throw new StorageError('ledger_missing');
    if (!historyFile) throw new StorageError('history_missing');
    let anchor: AnchorDocument;
    let ledger: LedgerDocument<B>;
    let history: HistoryDocument<D>;
    let markers: InstallDocument[];
    try {
      anchor = checkAnchorDocument(anchorFile.raw);
      ledger = checkLedgerDocument(ledgerFile.raw);
      history = checkHistoryDocument(historyFile.raw);
      markers = [checkInstallDocument(installA.raw), checkInstallDocument(installB.raw)];
    } catch (error) {
      if (error instanceof DocumentError) throw new StorageError('document_invalid');
      throw error;
    }
    if ([anchor, ledger, history, ...markers].some((doc) => doc.keyId !== keyId)) throw new StorageError('key_mismatch');
    verifyMac('anchor', anchor);
    verifyMac('ledger', ledger);
    verifyMac('history', history);
    for (const marker of markers) verifyMac('install', marker);
    if ([ledger, history, ...markers].some((doc) => doc.lineage !== anchor.lineage)) throw new StorageError('lineage_mismatch');
    // Ledger × anchor: igual, ou exatamente uma geração à frente encadeada (queda antes do anchor).
    const head = ledgerHead(ledger);
    const ledgerOk =
      (ledger.generation === anchor.ledger.generation && head === anchor.ledger.head) ||
      (ledger.generation === anchor.ledger.generation + 1 && ledger.prevHead === anchor.ledger.head);
    if (!ledgerOk) throw new StorageError(ledger.generation < anchor.ledger.generation ? 'ledger_rollback' : 'ledger_anchor_mismatch');
    // Histórico × anchor: igual, ou à frente contendo o item registrado no anchor.
    const tip = tipOf(history.items);
    const historyOk =
      (tip.seq === anchor.history.seq && tip.head === anchor.history.head) ||
      (tip.seq > anchor.history.seq && history.items[anchor.history.seq - 1]?.hash === anchor.history.head);
    if (!historyOk) throw new StorageError(tip.seq < anchor.history.seq ? 'history_rollback' : 'history_anchor_mismatch');
    if (ledger.epoch < anchor.epoch) throw new StorageError('epoch_rollback');
    // O ledger nunca descreve uma geração que o histórico não conhece (histórico é gravado antes).
    if (history.items.some((item) => item.ledgerGeneration > ledger.generation + 1)) throw new StorageError('history_ahead_of_ledger');
    return { lineage: ledger.lineage, generation: ledger.generation, head, epoch: Math.max(ledger.epoch, anchor.epoch), body: ledger.body, items: history.items };
  }

  /** Nova linhagem (primeira instalação ou recuperação), com marcadores novos. */
  async function startLineage(epoch: number, cause: 'initial_install' | 'recovery', detail: string | null): Promise<Loaded<B, D>> {
    const lineage = randomUUID();
    const base: Loaded<B, D> = { lineage, generation: 0, head: '', epoch, body: spec.emptyBody(), items: [] };
    const d = draft(base, epoch, (tx) => spec.onLineage(tx, cause, detail), true);
    await writeInstallMarkers(lineage);
    return persist(base, { body: d.body, items: d.items, epoch, lineage }, true);
  }

  async function initialize() {
    try {
      dataDir = await secureDirectory(options.dataDir, options.environment);
      anchorDir = await secureDirectory(options.anchorDir, options.environment);
      assertSeparate(dataDir, anchorDir, options.environment.platform);
      for (const other of options.separateFrom ?? []) assertSeparate(dataDir, resolve(other), options.environment.platform);
      lock = await acquireLock(dataDir, { lock: names.lock, takeover: names.takeover }, { now, ops: options.lockOps, alive: options.alive });
      let loadedKey: SignedLedgerKey;
      try {
        loadedKey = await options.loadKey();
      } catch {
        throw new StorageError('key_unavailable');
      }
      if (!Buffer.isBuffer(loadedKey?.key) || loadedKey.key.length < 32 || !isKeyId(loadedKey.keyId)) throw new StorageError('key_invalid');
      key = loadedKey.key;
      keyId = loadedKey.keyId;
      const loaded = await load();
      if (loaded === 'fresh') {
        current = await startLineage(1, 'initial_install', null);
        openedAs = 'initial_install';
      } else {
        const epoch = loaded.epoch + 1;
        const unappliedItems = loaded.items.filter((item) => item.ledgerGeneration > loaded.generation);
        const info: EpochInfo = {
          lockRecovered: lock.recovered,
          loadedGeneration: loaded.generation,
          unapplied: unappliedItems.length > 0 ? { first: unappliedItems[0].seq, last: unappliedItems[unappliedItems.length - 1].seq } : null,
        };
        const d = draft(loaded, epoch, (tx) => spec.onEpoch(tx, info), true);
        current = await persist(loaded, { body: d.body, items: d.items, epoch }, true);
        openedAs = 'restart';
      }
      state = 'available';
      reason = null;
    } catch (error) {
      current = null;
      openedAs = null;
      unavailable(error instanceof StorageError ? error.code : 'store_open_failed');
    }
  }

  await initialize();

  const enqueue = <R>(task: () => Promise<R>): Promise<R> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const opened = () => {
    if (!current) throw new StorageError('store_unavailable');
    return current;
  };

  return {
    status: () => ({ state, reason }),
    openedAs: () => openedAs,
    lineage: () => opened().lineage,
    epoch: () => opened().epoch,
    body: () => opened().body,
    history: () => opened().items,
    commit(change, allow = null) {
      return enqueue(async () => {
        if (state !== 'available' || !current) throw new StorageError(state === 'degraded' ? 'store_degraded' : 'store_unavailable');
        const base = current;
        const d = draft(base, base.epoch, change, false, allow);
        if (!d.changed) return d.result;
        try {
          current = await persist(base, { body: d.body, items: d.items, epoch: base.epoch });
        } catch (error) {
          if (error instanceof StorageError && (error.code === 'history_full' || error.code === 'ledger_full')) throw error;
          state = 'degraded';
          reason = 'write_failed';
          throw new StorageError('store_write_failed');
        }
        return d.result;
      });
    },
    recover(input) {
      return enqueue(async () => {
        if (state !== 'unavailable') throw new StorageError('recovery_not_needed');
        if (!REASON.test(input?.reason ?? '') || !ACTOR_ID.test(input?.actorId ?? '')) throw new StorageError('invalid_recovery_input');
        if (!key || !lock || NOT_RECOVERABLE.includes(reason ?? '')) throw new StorageError(reason && NOT_RECOVERABLE.includes(reason) ? `recovery_refused_${reason}`.slice(0, 64) : 'store_unavailable');
        const p = paths();
        const quarantineId = `${iso().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
        const target = join(dataDir, QUARANTINE_DIR, quarantineId);
        const evidence = [
          { name: names.ledger, path: p.ledger },
          { name: names.history, path: p.history },
          { name: names.anchor, path: p.anchor },
          { name: `data-dir-${names.install}`, path: p.installA },
          { name: `anchor-dir-${names.install}`, path: p.installB },
        ];
        const originals = new Map<string, Buffer | null>();

        // 1) Quarentena verificada. Qualquer falha aqui: nada foi alterado fora da quarentena.
        try {
          await mkdir(join(dataDir, QUARANTINE_DIR), { recursive: true, mode: 0o700 });
          await mkdir(target, { mode: 0o700 });
        } catch {
          throw new StorageError('quarantine_failed');
        }
        const manifest: Array<{ name: string; present: boolean; sha256: string | null; bytes: number }> = [];
        for (const item of evidence) {
          let present: boolean;
          try {
            present = await checkRegularFile(item.path);
          } catch {
            throw new StorageError('quarantine_unsupported_file');
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
            throw new StorageError('quarantine_read_failed');
          }
          try {
            await writeBytes(join(target, item.name), data);
          } catch {
            throw new StorageError('quarantine_write_failed');
          }
          let copy: Buffer;
          try {
            copy = await readFile(join(target, item.name));
          } catch {
            throw new StorageError('quarantine_verification_failed');
          }
          if (sha(copy) !== sha(data) || copy.length !== data.length) throw new StorageError('quarantine_verification_failed');
          originals.set(item.path, data);
          manifest.push({ name: item.name, present: true, sha256: sha(data), bytes: data.length });
        }
        const manifestBytes = Buffer.from(canonicalJson({ format: formats.quarantine, version: 1, quarantineId, createdAt: iso(), reason: input.reason, actor: input.actorId, files: manifest }), 'utf8');
        try {
          await writeBytes(join(target, MANIFEST_FILE), manifestBytes);
          if (sha(await readFile(join(target, MANIFEST_FILE))) !== sha(manifestBytes)) throw new Error('mismatch');
        } catch {
          throw new StorageError('quarantine_verification_failed');
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
            if (isUuid(parsed.lineage)) previousLineage = parsed.lineage;
          } catch {
            // Ilegível: a evidência já está preservada e verificada.
          }
        }

        // 3) Nova linhagem. Falha → restaura os originais (verificados) e continua indisponível.
        try {
          const detail = `quarantine ${quarantineId} manifest ${sha(manifestBytes).slice(0, 16)}${previousLineage ? ` lineage ${previousLineage}` : ''}`;
          current = await startLineage(previousEpoch + 1, 'recovery', detail);
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
          throw new StorageError(restored ? 'recovery_failed' : 'recovery_restore_failed');
        }
        state = 'available';
        reason = null;
        openedAs = 'recovery';
        return { quarantineId };
      });
    },
    async close() {
      await queue.catch(() => undefined);
      state = 'unavailable';
      reason = 'closed';
      current = null;
      key = null;
      await lock?.release();
    },
  };
}

/** Lista as quarentenas existentes (evidências preservadas). */
export async function listQuarantine(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, QUARANTINE_DIR))).sort();
  } catch {
    return [];
  }
}
