import { lstat, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic, type WriteFile } from '../storage/jsonFile.ts';

/**
 * Diário da operação de liberação da barreira global (Issue #008, P1 — R2 da revisão final).
 *
 * O diário NÃO é fonte de verdade: o histórico da #011 (gravado no mesmo commit atômico da
 * liberação) é. O diário só registra que existe uma operação administrativa em andamento, para que:
 * - o servidor abra as aprovações como INDISPONÍVEIS enquanto ele existir (fail-closed);
 * - a próxima execução do comando reconcilie, de forma determinística, a #011 com a #006.
 *
 * Estados: `intent` → `reserved` → `committed`; o arquivo é APAGADO ao concluir (ou ao
 * reconciliar). Cada gravação é atômica (tmp + fsync + rename). Não contém segredos.
 */

export const JOURNAL_FILE = 'admin-release.journal.json';
export const JOURNAL_FORMAT = 'acc-admin-release-journal';
export const JOURNAL_VERSION = 1;
export const RELEASE_OPERATION = 'barrier_release_global';

export const JOURNAL_STATES = ['intent', 'reserved', 'committed'] as const;
export type JournalState = (typeof JOURNAL_STATES)[number];

export interface ReleaseJournal {
  format: typeof JOURNAL_FORMAT;
  version: typeof JOURNAL_VERSION;
  operation: typeof RELEASE_OPERATION;
  state: JournalState;
  /** Linhagem do armazenamento da #011 no início da operação. */
  lineage: string;
  /** Época da #011 em que a operação começou. */
  epoch: number;
  /** Último `seq` do histórico da #011 antes da operação (eventos posteriores são desta operação). */
  historySeq: number;
  approvalId: string | null;
  attemptId: string | null;
  startedAt: string;
  updatedAt: string;
}

export type JournalRead = { kind: 'absent' } | { kind: 'present'; journal: ReleaseJournal } | { kind: 'invalid' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;
const KEYS = ['format', 'version', 'operation', 'state', 'lineage', 'epoch', 'historySeq', 'approvalId', 'attemptId', 'startedAt', 'updatedAt'];

/** Validação estrita (qualquer desvio → `invalid`, que é tratado como pendência ilegível). */
export function parseJournal(text: string): ReleaseJournal | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const j = raw as Record<string, unknown>;
  if (Object.keys(j).sort().join() !== [...KEYS].sort().join()) return null;
  if (j.format !== JOURNAL_FORMAT || j.version !== JOURNAL_VERSION || j.operation !== RELEASE_OPERATION) return null;
  if (!(JOURNAL_STATES as readonly unknown[]).includes(j.state)) return null;
  if (typeof j.lineage !== 'string' || !UUID.test(j.lineage)) return null;
  if (typeof j.epoch !== 'number' || !Number.isSafeInteger(j.epoch) || j.epoch < 1) return null;
  if (typeof j.historySeq !== 'number' || !Number.isSafeInteger(j.historySeq) || j.historySeq < 0) return null;
  if (j.approvalId !== null && (typeof j.approvalId !== 'string' || !UUID.test(j.approvalId))) return null;
  if (j.attemptId !== null && (typeof j.attemptId !== 'string' || !UUID.test(j.attemptId))) return null;
  if (!ISO(j.startedAt) || !ISO(j.updatedAt)) return null;
  // Coerência mínima entre estado e identificadores.
  if (j.state === 'intent' && (j.approvalId !== null || j.attemptId !== null)) return null;
  if (j.state !== 'intent' && (j.approvalId === null || j.attemptId === null)) return null;
  return j as unknown as ReleaseJournal;
}

export interface JournalFileOps {
  write: WriteFile;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  /** `false` só se o caminho NÃO existe; qualquer outra situação lança ou devolve `true`. */
  exists(path: string): Promise<boolean>;
  isRegularFile(path: string): Promise<boolean>;
}

export const defaultJournalOps: JournalFileOps = {
  write: writeFileAtomic,
  read: (path) => readFile(path, 'utf8'),
  remove: (path) => rm(path),
  async exists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  async isRegularFile(path) {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
  },
};

export const journalPath = (dataDir: string) => join(dataDir, JOURNAL_FILE);

export async function readJournal(dataDir: string, ops: JournalFileOps = defaultJournalOps): Promise<JournalRead> {
  const path = journalPath(dataDir);
  try {
    if (!(await ops.exists(path))) return { kind: 'absent' };
    if (!(await ops.isRegularFile(path))) return { kind: 'invalid' };
    const journal = parseJournal(await ops.read(path));
    return journal ? { kind: 'present', journal } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export async function writeJournal(dataDir: string, journal: ReleaseJournal, ops: JournalFileOps = defaultJournalOps): Promise<void> {
  if (parseJournal(JSON.stringify(journal)) === null) throw new Error('journal_invalid');
  await ops.write(journalPath(dataDir), `${JSON.stringify(journal, null, 2)}\n`);
}

export async function removeJournal(dataDir: string, ops: JournalFileOps = defaultJournalOps): Promise<void> {
  await ops.remove(journalPath(dataDir));
  if (await ops.exists(journalPath(dataDir))) throw new Error('journal_remove_failed');
}

/**
 * Usado pelo SERVIDOR antes de abrir as aprovações: existe operação administrativa pendente?
 * Qualquer dúvida (erro ao consultar, arquivo estranho) = pendente (fail-closed).
 */
export async function releasePending(dataDir: string, ops: JournalFileOps = defaultJournalOps): Promise<boolean> {
  try {
    return await ops.exists(journalPath(dataDir));
  } catch {
    return true;
  }
}
