import { join } from 'node:path';
import { defaultJournalOps, type JournalFileOps } from './journal.ts';

/**
 * Limite PERSISTENTE de tentativas do comando de liberação (Issue #008, P1 — R3 da revisão final).
 *
 * O limitador do step-up da #011 vive na memória do processo e zera a cada execução do comando.
 * Por isso o comando usa um arquivo próprio, gravado ANTES de conferir a senha:
 * - cada tentativa é registrada (fsync + substituição atômica) como falha ANTES do scrypt;
 *   matar o processo no meio conta como falha; só um sucesso zera o contador;
 * - 5 falhas em 15 minutos bloqueiam por 15 minutos (os mesmos valores do step-up da #011);
 * - 20 falhas seguidas sem sucesso → TRAVA DURA (decisão H2 do PO): nenhuma espera a libera; só o
 *   procedimento humano documentado em `docs/BARRIER_RELEASE.md`;
 * - arquivo ilegível, corrompido, link ou inacessível → recusa (nunca libera);
 * - registro com horário mais de 1 minuto no futuro (relógio voltou) → recusa.
 *
 * Conferência cruzada: as falhas de `approval.confirmation` na auditoria da #006 (janela de 15 min,
 * depois do último sucesso). Vale o MAIOR dos dois: basta uma fonte para bloquear.
 */

export const THROTTLE_FILE = 'admin-release.throttle.json';
export const THROTTLE_FORMAT = 'acc-admin-release-throttle';
export const THROTTLE_VERSION = 1;
// Mesmos valores do step-up da #011 (`STEP_UP_MAX_FAILURES`/`STEP_UP_LOCK_MS`; igualdade fixada em
// teste). Literais aqui para o módulo não importar o núcleo de aprovações.
export const WINDOW_MS = 15 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const MAX_FAILURES = 5;
/** Decisão H2: trava dura após 20 falhas seguidas sem sucesso. */
export const HARD_LOCK_FAILURES = 20;
export const CLOCK_SKEW_MS = 60_000;
/** Só as falhas recentes importam para a janela; o total seguido fica em `consecutive`. */
const KEEP_RECENT = 32;

export interface ThrottleDocument {
  format: typeof THROTTLE_FORMAT;
  version: typeof THROTTLE_VERSION;
  /** Falhas seguidas desde o último sucesso (tentativas registradas antes da senha contam). */
  consecutive: number;
  /** Horários (ISO) das falhas mais recentes, na ordem de gravação. */
  recent: string[];
}

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'throttle_unreadable' | 'clock_moved_back' | 'hard_locked' | 'temporarily_locked'; until?: string };

const empty = (): ThrottleDocument => ({ format: THROTTLE_FORMAT, version: THROTTLE_VERSION, consecutive: 0, recent: [] });
const isIso = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString() === v;

export function parseThrottle(text: string): ThrottleDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (Object.keys(d).sort().join() !== 'consecutive,format,recent,version') return null;
  if (d.format !== THROTTLE_FORMAT || d.version !== THROTTLE_VERSION) return null;
  if (typeof d.consecutive !== 'number' || !Number.isSafeInteger(d.consecutive) || d.consecutive < 0) return null;
  if (!Array.isArray(d.recent) || d.recent.length > KEEP_RECENT || !d.recent.every(isIso)) return null;
  // A ordem não é exigida (um ajuste pequeno de relógio não pode inutilizar o arquivo); `windowLock` ordena.
  if (d.recent.length > d.consecutive) return null;
  return d as unknown as ThrottleDocument;
}

/**
 * Bloqueio pela regra "5 falhas em 15 min → 15 min": se as 5 falhas mais recentes cabem em 15 min,
 * bloqueia até 15 min depois da última delas.
 */
export function windowLock(failures: readonly number[], now: number): number | null {
  if (failures.length < MAX_FAILURES) return null;
  const sorted = [...failures].sort((a, b) => a - b);
  const last = sorted.slice(-MAX_FAILURES);
  if (last[last.length - 1] - last[0] > WINDOW_MS) return null;
  const until = last[last.length - 1] + LOCK_MS;
  return now < until ? until : null;
}

export interface Throttle {
  /** Lê o arquivo e decide. `auditFailures`: horários das falhas na #006 (conferência cruzada). */
  check(auditFailures: readonly number[]): Promise<ThrottleVerdict>;
  /** Registra a tentativa como FALHA antes de verificar a senha (write-ahead). Lança se não gravar. */
  recordAttempt(): Promise<void>;
  /** Sucesso: zera o contador. Lança se não gravar. */
  recordSuccess(): Promise<void>;
}

export function createThrottle(options: { dataDir: string; now?: () => number; ops?: JournalFileOps }): Throttle {
  const now = options.now ?? Date.now;
  const ops = options.ops ?? defaultJournalOps;
  const path = join(options.dataDir, THROTTLE_FILE);

  /** `null` = ilegível (recusa). Ausente = primeira utilização. */
  async function load(): Promise<ThrottleDocument | null> {
    try {
      if (!(await ops.exists(path))) return empty();
      if (!(await ops.isRegularFile(path))) return null;
      return parseThrottle(await ops.read(path));
    } catch {
      return null;
    }
  }

  async function save(doc: ThrottleDocument) {
    await ops.write(path, `${JSON.stringify(doc)}\n`);
    // Confirma o que ficou em disco (uma gravação "silenciosa" não pode zerar a contagem).
    const back = parseThrottle(await ops.read(path));
    if (!back || back.consecutive !== doc.consecutive || back.recent.join() !== doc.recent.join()) throw new Error('throttle_write_unverified');
  }

  return {
    async check(auditFailures) {
      const doc = await load();
      if (!doc) return { allowed: false, reason: 'throttle_unreadable' };
      const at = now();
      const fileTimes = doc.recent.map((t) => Date.parse(t));
      if ([...fileTimes, ...auditFailures].some((t) => t > at + CLOCK_SKEW_MS)) return { allowed: false, reason: 'clock_moved_back' };
      if (doc.consecutive >= HARD_LOCK_FAILURES) return { allowed: false, reason: 'hard_locked' };
      // Vale o maior: cada fonte, sozinha, pode bloquear.
      const until = Math.max(windowLock(fileTimes, at) ?? 0, windowLock(auditFailures, at) ?? 0);
      if (until > 0) return { allowed: false, reason: 'temporarily_locked', until: new Date(until).toISOString() };
      return { allowed: true };
    },
    async recordAttempt() {
      const doc = await load();
      if (!doc) throw new Error('throttle_unreadable');
      const recent = [...doc.recent, new Date(now()).toISOString()].slice(-KEEP_RECENT);
      await save({ ...doc, consecutive: doc.consecutive + 1, recent });
    },
    async recordSuccess() {
      await save(empty());
    },
  };
}
