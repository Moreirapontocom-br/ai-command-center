import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bindingDigest, paramsDigestOf } from '../approvals/binding.ts';
import { ApprovalError, type ApprovalBinding } from '../approvals/contracts.ts';
import type { HistoryEntry } from '../approvals/documents.ts';
import { createPasswordConfirmer, createStepUpRegistry, type IdentityContext } from '../approvals/identity.ts';
import { createEnvKeyProvider, createFileKeyProvider } from '../approvals/keyProvider.ts';
import { createApprovalService } from '../approvals/service.ts';
import { INSTALL_FILE, openApprovalStore, type ApprovalStore } from '../approvals/store.ts';
import { createAuditSequence, openAuditLog, type AuditLog } from '../audit/auditLog.ts';
import type { AuditEventInput } from '../audit/events.ts';
import { ADMIN_USER_ID } from '../auth/adminAuth.ts';
import type { ServerConfig } from '../config.ts';
import { DEFAULT_POLICY } from '../policy/defaultPolicy.ts';
import { openProjectStore } from '../projects/projectStore.ts';
import { createBarrierGate, type BarrierAuthority } from '../queue/barrierGate.ts';
import { openQueueStore, type QueueStore } from '../queue/store.ts';
import type { WriteFile } from '../storage/jsonFile.ts';
import type { LockFileOps, StoreLock } from '../storage/lock.ts';
import { deriveSubkey, QUEUE_KEY_DOMAIN } from '../storage/subkeys.ts';
import { openTaskStore } from '../tasks/taskStore.ts';
import { acquireInstanceLock } from './instance.ts';
import { defaultJournalOps, readJournal, RELEASE_OPERATION, removeJournal, writeJournal, type JournalFileOps, type ReleaseJournal } from './journal.ts';
import { createThrottle, WINDOW_MS } from './throttle.ts';

/**
 * Comando LOCAL de liberação da barreira global inicial (Issue #008, P1).
 *
 * Decisões aplicadas: D-P1.1 (comando local supervisionado, NUNCA rota HTTP), D-P1.2 (só a barreira
 * `initial_install`), D-P1.3 (senha do administrador + terminal + frase ligada à linhagem), D-P1.4
 * (N9 alterado só para este comando), D-P1.5 (nenhuma liberação real nesta fase), H2 = sim (trava
 * dura após 20 falhas, em `throttle.ts`) e H3 = não (não existe variável de linhagem esperada: a
 * frase digitada é a única confirmação da linhagem).
 *
 * O núcleo da #011 NÃO muda: o comando repete o caminho de `service.configure` —
 * `confirmOwner(killswitch.release, {scope:'global'})` → `reserve({component:'approvals'})` →
 * `releaseBarrier({attemptId})` (um único commit atômico). Sequência e pontos de persistência
 * (P1–P13) em `docs/BARRIER_RELEASE.md` §3. Este módulo não lê o terminal: a interação fica em
 * `releaseBarrierCli.ts` e chega aqui por `ReleasePrompt` (injetável nos testes).
 */

export type ReleaseOutcome = 'released' | 'reconciled' | 'refused' | 'pending' | 'audit_pending';

export interface ReleaseResult {
  /** 0 = liberada ou reconciliada; 1 = recusada/pendente (nada liberado); 3 = liberada na #011, auditoria pendente. */
  exitCode: 0 | 1 | 3;
  outcome: ReleaseOutcome;
  /** Motivo-token (nunca segredo, caminho ou mensagem livre). */
  reason: string;
}

/** Interação humana. A senha nunca sai daqui para log, disco, argumento ou variável de ambiente. */
export interface ReleasePrompt {
  show(lines: readonly string[]): void;
  password(label: string): Promise<string>;
  line(label: string): Promise<string>;
}

/** Pontos de persistência; os testes injetam quedas depois de cada um. */
export type Checkpoint = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9' | 'P10' | 'P11' | 'P12' | 'P13';

export interface ReleaseDeps {
  config: ServerConfig;
  env: Readonly<Record<string, string | undefined>>;
  prompt: ReleasePrompt;
  now?: () => number;
  monotonicNow?: () => number;
  /** Só testes: queda simulada (lançar) depois de um ponto de persistência. */
  checkpoint?: (point: Checkpoint) => void | Promise<void>;
  /** Só testes: injeção de falhas de gravação. */
  approvalsWriteFile?: WriteFile;
  auditWriteFile?: WriteFile;
  journalOps?: JournalFileOps;
  throttleOps?: JournalFileOps;
  instanceLockOps?: LockFileOps;
  alive?: (pid: number) => boolean;
}

/** Barreiras que o comando pode liberar (D-P1.2): SOMENTE a da instalação nova. */
export const RELEASABLE_REASONS = Object.freeze(['initial_install'] as const);
export const PHRASE_PREFIX = 'LIBERAR GLOBAL';
export const phraseFor = (lineage: string) => `${PHRASE_PREFIX} ${lineage.slice(0, 8)}`;

const ACTOR = { kind: 'human' as const, id: ADMIN_USER_ID };
const LINEAGE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class Refusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}
const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

/** Vínculo EXATO da liberação, montado aqui (o operador não informa nada). */
export function globalReleaseBinding(policyVersion: string): ApprovalBinding {
  return {
    action: 'killswitch.release',
    projectId: null,
    resource: { type: 'killswitch', id: 'global' },
    target: { sha: null, ref: null },
    subject: { kind: 'human', id: ADMIN_USER_ID },
    paramsDigest: paramsDigestOf('killswitch.release', { scope: 'global' }),
    policyVersion,
  };
}

export interface StateFacts {
  status: { state: string; reason: string | null };
  global: { reason: string; engagedAt: string } | null;
  volatile: readonly string[];
  historyUnapplied: boolean;
  lineageA: string | null;
  lineageB: string | null;
}

/** R4: decide se a barreira pode ser liberada. Pura (testada isoladamente). */
export function assessState(facts: StateFacts): { ok: true } | { ok: false; reason: string } {
  if (facts.status.state !== 'available') return { ok: false, reason: `approvals_${facts.status.state}` };
  if (facts.historyUnapplied) return { ok: false, reason: 'history_unapplied' };
  if (facts.volatile.length > 0) return { ok: false, reason: 'volatile_barrier' };
  if (facts.lineageA === null || facts.lineageA !== facts.lineageB || !LINEAGE.test(facts.lineageA)) return { ok: false, reason: 'lineage_unverified' };
  if (facts.global === null) return { ok: false, reason: 'no_global_barrier' };
  if (!(RELEASABLE_REASONS as readonly string[]).includes(facts.global.reason)) return { ok: false, reason: 'barrier_reason_not_releasable' };
  return { ok: true };
}

const entries = (store: ApprovalStore) => store.history().items.filter((i): i is HistoryEntry => i.kind === 'entry');

/** A abertura ATUAL registrou `history_unapplied` (entre o `store_opened` desta época e o anterior)? */
export function openedWithUnapplied(items: readonly HistoryEntry[]): boolean {
  const last = items.map((e) => e.event).lastIndexOf('approval.store_opened');
  if (last < 0) return false;
  for (let i = last - 1; i >= 0; i -= 1) {
    const e = items[i].event;
    if (e === 'approval.history_unapplied') return true;
    if (e === 'approval.store_opened' || e === 'approval.store_initialized' || e === 'approval.store_recovered') return false;
  }
  return false;
}

/** Seqs que a #011 declarou NÃO aplicados (ledger perdido): não contam como fato. */
function unappliedSeqs(items: readonly HistoryEntry[]): Set<number> {
  const out = new Set<number>();
  for (const e of items) {
    if (e.event !== 'approval.history_unapplied' || typeof e.detail !== 'string') continue;
    const m = /^seq (\d+)-(\d+)$/.exec(e.detail);
    if (!m) continue;
    for (let s = Number(m[1]); s <= Number(m[2]) && s - Number(m[1]) < 100_000; s += 1) out.add(s);
  }
  return out;
}

/** Eventos `barrier_released` globais, humanos e aplicados, posteriores a `afterSeq`. */
function releasesAfter(items: readonly HistoryEntry[], afterSeq: number): HistoryEntry[] {
  const lost = unappliedSeqs(items);
  return items.filter((e) => e.seq > afterSeq && !lost.has(e.seq) && e.event === 'approval.barrier_released' && e.projectId === null && e.actor.kind === 'human');
}

async function readLineage(dir: string): Promise<{ lineage: string; createdAt: string } | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, INSTALL_FILE), 'utf8')) as { lineage?: unknown; createdAt?: unknown };
    if (typeof raw.lineage !== 'string' || typeof raw.createdAt !== 'string') return null;
    return { lineage: raw.lineage, createdAt: raw.createdAt };
  } catch {
    return null;
  }
}

/** Execução completa do comando. Nunca lança: toda falha vira um resultado com código ≠ 0. */
export async function runBarrierRelease(deps: ReleaseDeps): Promise<ReleaseResult> {
  const { config, prompt } = deps;
  const now = deps.now ?? Date.now;
  const journalOps = deps.journalOps ?? defaultJournalOps;
  const checkpoint = async (p: Checkpoint) => {
    await deps.checkpoint?.(p);
  };
  const dataDir = dirname(config.auditFile);

  let instanceLock: StoreLock | null = null;
  let store: ApprovalStore | null = null;
  let queue: QueueStore | null = null;
  /** Fase: antes do diário nada mudou; depois dele só a reconciliação ou o sucesso o apagam. */
  let phase: 'before_journal' | 'journal_written' | 'released' = 'before_journal';

  const closeStores = async () => {
    await Promise.allSettled([queue?.close(), store?.close()]);
    queue = null;
    store = null;
  };

  try {
    // ── Ambiente e configuração (nenhum arquivo de dados aberto) ─────────────────────────────
    if (config.deployment !== 'local') refuse('deployment_not_local');
    if (deps.env.NODE_ENV === 'production') refuse('node_env_production');
    if (!config.admin) refuse('admin_not_configured');
    if (config.approvals.state !== 'configured') refuse(`approvals_${config.approvals.state}`);
    if (config.queue.state === 'invalid') refuse('queue_config_invalid');
    const settings = config.approvals.state === 'configured' ? config.approvals : refuse('approvals_not_configured');
    const admin = config.admin!;

    // ── P1: lock de instância ANTES de qualquer arquivo de dados ─────────────────────────────
    try {
      instanceLock = await acquireInstanceLock(dataDir, { now, ops: deps.instanceLockOps, alive: deps.alive });
    } catch {
      refuse('instance_locked');
    }
    await checkpoint('P1');

    // ── P2: dados, auditoria (sequência global), #011 e fila ────────────────────────────────
    const sequence = createAuditSequence();
    let audit: AuditLog;
    try {
      await openProjectStore({ filePath: config.projectsFile, allowedRepositories: config.allowedRepositories, sequence });
      await openTaskStore({ filePath: config.tasksFile, sequence });
      audit = await openAuditLog({ filePath: config.auditFile, sequence, now, writeFile: deps.auditWriteFile });
    } catch {
      return refuse('data_files_unavailable');
    }
    const environment = { env: { ...deps.env } };
    const keyProvider = settings.key.kind === 'env' ? createEnvKeyProvider(deps.env) : createFileKeyProvider(settings.key.path, environment);
    const openStore = () =>
      openApprovalStore({ approvalsDir: settings.approvalsDir, anchorDir: settings.anchorDir, keyProvider, environment, initialize: 'never', now, writeFile: deps.approvalsWriteFile });
    store = await openStore();
    const identity = createStepUpRegistry({ confirmers: [createPasswordConfirmer({ userId: ADMIN_USER_ID, passwordHash: admin.passwordHash })], now });
    // Sem `controllerKillSwitch`: o controlador da #022 não tem instância em produção (tripwire estrutural).
    const service = createApprovalService({ store, identity, policyVersion: DEFAULT_POLICY.version, now, monotonicNow: deps.monotonicNow });
    if (store.status().state !== 'available') refuse(`approvals_${store.status().reason ?? store.status().state}`);
    if (config.queue.state === 'configured') {
      const authority: BarrierAuthority = { status: () => service.status(), barriers: () => service.barriers(), engage: (input) => service.engageBarrier(input) };
      try {
        queue = await openQueueStore({
          authority,
          queueDir: config.queue.queueDir,
          anchorDir: settings.anchorDir,
          approvalsDir: settings.approvalsDir,
          environment,
          initialize: 'never',
          now,
          loadKey: async () => {
            const master = await keyProvider.load();
            try {
              return deriveSubkey(master.key, QUEUE_KEY_DOMAIN);
            } finally {
              master.key.fill(0);
            }
          },
        });
      } catch {
        refuse('queue_open_failed');
      }
      // A reconciliação só pode ACIONAR barreiras (direção segura). Qualquer efeito → recusa.
      const reconciled = await createBarrierGate({ authority, store: queue }).reconcile().catch(() => ({ confirmed: 0, failed: 1 }));
      if (queue!.status().state !== 'available') refuse(`queue_${queue!.status().reason ?? queue!.status().state}`);
      if (reconciled.confirmed > 0 || reconciled.failed > 0) refuse('queue_barrier_applied');
      if (queue!.pendingBarriers().length > 0) refuse('queue_barrier_pending');
    }
    await checkpoint('P2');

    const mirror = async (event: AuditEventInput) => {
      await audit.append(event);
    };

    // ── Reconciliação do diário (R2), se houver ─────────────────────────────────────────────
    const lineageA = await readLineage(settings.approvalsDir);
    const lineageB = await readLineage(settings.anchorDir);
    const pending = await readJournal(dataDir, journalOps);
    if (pending.kind === 'invalid') refuse('journal_unreadable');
    if (pending.kind === 'present') {
      return await reconcile({ journal: pending.journal, store, lineage: lineageA?.lineage ?? null, mirror, dataDir, journalOps, prompt });
    }

    // ── R4: estado ───────────────────────────────────────────────────────────────────────────
    const barriers = service.barriers();
    const facts: StateFacts = {
      status: service.status(),
      global: barriers.durable.global as StateFacts['global'],
      volatile: barriers.volatile,
      historyUnapplied: openedWithUnapplied(entries(store)),
      lineageA: lineageA?.lineage ?? null,
      lineageB: lineageB?.lineage ?? null,
    };
    const verdict = assessState(facts);
    if (!verdict.ok) refuse(verdict.reason);
    const lineage = facts.lineageA!;

    // ── R3: limite persistente + conferência cruzada com a #006 ─────────────────────────────
    const throttle = createThrottle({ dataDir, now, ops: deps.throttleOps });
    const auditFailures = confirmationFailures(audit, now());
    const gate = await throttle.check(auditFailures);
    if (!gate.allowed) refuse(gate.reason);

    prompt.show([
      'Liberação da barreira GLOBAL inicial do ACC (Issue #008, P1).',
      `Linhagem do armazenamento: ${lineage}`,
      `Instalação: ${lineageA!.createdAt}`,
      `Época atual: ${store.epoch()}`,
      `Motivo da barreira: ${facts.global!.reason} (desde ${facts.global!.engagedAt})`,
      'Depois da liberação, cada ordem continua exigindo as aprovações humanas da #008.',
    ]);

    // ── P3: tentativa registrada ANTES de qualquer verificação ──────────────────────────────
    try {
      await throttle.recordAttempt();
    } catch {
      refuse('throttle_write_failed');
    }
    await checkpoint('P3');

    const secret = await prompt.password('Senha do administrador: ');
    const phrase = await prompt.line(`Digite exatamente "${phraseFor(lineage)}": `);
    const failConfirmation = async (reason: string) => {
      await mirror({ action: 'approval.confirmation', actor: ACTOR, ownerId: ADMIN_USER_ID, projectId: null, resource: { type: 'approval', id: null }, outcome: 'blocked', context: { reason, operation: RELEASE_OPERATION } }).catch(() => undefined);
      return refuse(reason);
    };
    if (phrase !== phraseFor(lineage)) await failConfirmation('phrase_mismatch');
    // Sessão local do comando: identificador aleatório desta execução (não é token de login).
    const ctx: IdentityContext = { userId: ADMIN_USER_ID, sessionKey: createHash('sha256').update(randomBytes(32)).digest('hex') };
    let proofId: string;
    try {
      proofId = (await identity.confirm(ctx, 'password', secret)).proofId;
    } catch (error) {
      return await failConfirmation(error instanceof ApprovalError ? error.code : 'step_up_failed');
    }

    // ── P4: a auditoria aceita escrita (prova) e o contador volta a zero ────────────────────
    try {
      await mirror({ action: 'approval.confirmation', actor: ACTOR, ownerId: ADMIN_USER_ID, projectId: null, resource: { type: 'approval', id: null }, outcome: 'success', context: { reason: 'password', operation: RELEASE_OPERATION } });
    } catch {
      refuse('audit_unavailable');
    }
    try {
      await throttle.recordSuccess();
    } catch {
      refuse('throttle_write_failed');
    }
    await checkpoint('P4');

    // ── P5: diário `intent` ──────────────────────────────────────────────────────────────────
    const history = entries(store);
    const startedAt = new Date(now()).toISOString();
    const journal: ReleaseJournal = {
      format: 'acc-admin-release-journal',
      version: 1,
      operation: RELEASE_OPERATION,
      state: 'intent',
      lineage,
      epoch: store.epoch(),
      historySeq: history.length > 0 ? history[history.length - 1].seq : 0,
      approvalId: null,
      attemptId: null,
      startedAt,
      updatedAt: startedAt,
    };
    try {
      await writeJournal(dataDir, journal, journalOps);
    } catch {
      refuse('journal_write_failed');
    }
    phase = 'journal_written';
    await checkpoint('P5');

    // ── P6/P7/P8: aprovação de uso único, reserva e diário `reserved` ────────────────────────
    const binding = globalReleaseBinding(DEFAULT_POLICY.version);
    const approval = await service.confirmOwner({ ownerId: ADMIN_USER_ID, binding, bindingDigest: bindingDigest(binding), proofId, identity: ctx });
    await checkpoint('P6');
    const reservation = await service.reserve({ ownerId: ADMIN_USER_ID, approvalId: approval.id, component: 'approvals', binding });
    await checkpoint('P7');
    await writeJournal(dataDir, { ...journal, state: 'reserved', approvalId: approval.id, attemptId: reservation.attemptId, updatedAt: new Date(now()).toISOString() }, journalOps);
    await checkpoint('P8');

    // ── P9: o ÚNICO commit da liberação (histórico → ledger → anchor) ────────────────────────
    await service.releaseBarrier({ attemptId: reservation.attemptId });
    phase = 'released';
    await checkpoint('P9');
    await writeJournal(dataDir, { ...journal, state: 'committed', approvalId: approval.id, attemptId: reservation.attemptId, updatedAt: new Date(now()).toISOString() }, journalOps);
    await checkpoint('P10');

    // ── P11: prova de durabilidade — fecha, reabre (nova época) e relê ───────────────────────
    await closeStores();
    store = await openStore();
    await checkpoint('P11');
    if (store.status().state !== 'available' || store.ledger().barriers.global !== null) refuse('release_not_durable');
    const released = releasesAfter(entries(store), journal.historySeq);
    const attempt = store.ledger().attempts.find((t) => t.id === reservation.attemptId);
    if (released.length !== 1 || attempt?.state !== 'succeeded') refuse('release_not_durable');
    await closeStores();

    // ── P12: espelho na #006 · P13: diário apagado ───────────────────────────────────────────
    await mirror({ action: 'approval.configuration', actor: ACTOR, ownerId: ADMIN_USER_ID, projectId: null, resource: { type: 'approval', id: approval.id }, outcome: 'success', context: { operation: RELEASE_OPERATION, seq: released[0].seq } });
    await checkpoint('P12');
    await removeJournal(dataDir, journalOps);
    await checkpoint('P13');
    return { exitCode: 0, outcome: 'released', reason: 'released' };
  } catch (error) {
    const reason =
      error instanceof Refusal ? error.reason : error instanceof ApprovalError ? error.code : (error as Error | null)?.name === 'PromptCancelled' ? 'cancelled' : 'internal_error';
    if (phase === 'released') return { exitCode: 3, outcome: 'audit_pending', reason };
    if (phase === 'journal_written') return { exitCode: 1, outcome: 'pending', reason };
    return { exitCode: 1, outcome: 'refused', reason };
  } finally {
    await closeStores();
    await instanceLock?.release();
  }
}

/**
 * Falhas de `approval.confirmation` do administrador na #006 dentro da janela, POSTERIORES ao último
 * sucesso (um sucesso zera, como no arquivo do limite).
 */
export function confirmationFailures(audit: Pick<AuditLog, 'log'>, at: number): number[] {
  const events = audit
    .log()
    .events.filter((e) => e.action === 'approval.confirmation' && e.actor.kind === 'human' && e.actor.id === ADMIN_USER_ID)
    .sort((a, b) => a.seq - b.seq);
  const lastSuccess = events.map((e) => e.outcome).lastIndexOf('success');
  return events
    .slice(lastSuccess + 1)
    .map((e) => Date.parse(e.at))
    .filter((t) => Number.isFinite(t) && t > at - WINDOW_MS);
}

/** Reconciliação determinística (tabela da R2). Só apaga o diário quando a #011 confirma o estado. */
async function reconcile(input: {
  journal: ReleaseJournal;
  store: ApprovalStore;
  lineage: string | null;
  mirror: (event: AuditEventInput) => Promise<void>;
  dataDir: string;
  journalOps: JournalFileOps;
  prompt: ReleasePrompt;
}): Promise<ReleaseResult> {
  const { journal, store } = input;
  if (store.status().state !== 'available') refuse('reconcile_store_unavailable');
  if (input.lineage === null || journal.lineage !== input.lineage) refuse('reconcile_lineage_mismatch');
  const items = entries(store);
  const released = releasesAfter(items, journal.historySeq);
  const global = store.ledger().barriers.global;
  const attempt = journal.attemptId === null ? null : (store.ledger().attempts.find((t) => t.id === journal.attemptId) ?? null);
  const base = { actor: ACTOR, ownerId: ADMIN_USER_ID, projectId: null, resource: { type: 'approval' as const, id: journal.approvalId } };

  const interrupted = journal.state !== 'committed' && global !== null && released.length === 0 && (journal.attemptId === null ? journal.state === 'intent' : attempt !== null && attempt.state !== 'succeeded');
  const completed = journal.state !== 'intent' && global === null && released.length === 1 && attempt?.state === 'succeeded';
  if (!interrupted && !completed) refuse('reconcile_divergence');

  try {
    if (interrupted) await input.mirror({ ...base, action: 'approval.configuration', outcome: 'failure', context: { operation: RELEASE_OPERATION, reason: 'interrupted' } });
    else await input.mirror({ ...base, action: 'approval.configuration', outcome: 'success', context: { operation: RELEASE_OPERATION, reason: 'reconciled', seq: released[0].seq } });
  } catch {
    refuse('reconcile_audit_failed');
  }
  try {
    await removeJournal(input.dataDir, input.journalOps);
  } catch {
    refuse('reconcile_journal_remove_failed');
  }
  input.prompt.show([
    interrupted
      ? 'Operação anterior INTERROMPIDA antes da liberação: registrada na auditoria. A barreira continua ativa; execute o comando de novo para liberar.'
      : 'Operação anterior CONCLUÍDA na #011: auditoria completada. A barreira global já está liberada.',
  ]);
  return { exitCode: 0, outcome: 'reconciled', reason: interrupted ? 'interrupted' : 'reconciled' };
}
