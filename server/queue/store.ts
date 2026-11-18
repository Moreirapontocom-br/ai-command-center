import { StorageError } from '../storage/errors.ts';
import type { WriteFile } from '../storage/jsonFile.ts';
import type { LockFileOps } from '../storage/lock.ts';
import type { PathEnvironment } from '../storage/paths.ts';
import {
  openSignedLedger,
  type EpochInfo,
  type HistoryEntry,
  type LedgerState,
  type LedgerTransaction,
  type OpenedAs,
  type SignedLedger,
  type SignedLedgerKey,
  type WriteBytes,
} from '../storage/signedLedger.ts';
import {
  authorityConfirms,
  QUEUE_IN_FLIGHT_STATES,
  QUEUE_SYSTEM_ACTOR,
  QueueError,
  scopeKey,
  type BarrierAuthority,
  type BarrierScope,
  type PendingBarrier,
  type QueueBody,
  type QueueHistoryData,
  type QueueItem,
} from './contracts.ts';
import { checkQueueBody, checkQueueChange, checkQueueEntry, REASON, UUID, type BarrierClearance } from './documents.ts';

/**
 * Armazenamento durável da fila (Issue #012, PR 1 — D2/U6/U7), sobre o motor genérico
 * `storage/signedLedger.ts`:
 *
 * - dados em `ACC_QUEUE_DIR` (exclusivo da fila; separado do ledger de aprovações);
 * - anchor e segundo marcador no diretório de anchors EXISTENTE (`ACC_APPROVALS_ANCHOR_DIR`), com
 *   nomes (`queue-anchor.json`, `queue-install.json`), domínio de MAC, linhagem e época próprios;
 * - MAC com subchave HKDF `acc:queue:mac:v1` (U5), injetada já derivada.
 *
 * Abertura (U7) — os quatro casos são distinguidos:
 * 1. primeira instalação legítima: nada no disco, sem vestígios e `initialize: 'if_absent'` explícito
 *    → linhagem nova, que JÁ NASCE com pedido de barreira global pendente (bloqueada);
 * 2. reinício normal: documentos íntegros → época nova; itens `dispatching`/`running` viram
 *    `interrupted` (sem retomada automática) e `admitted` vira `expired` (as reservas do
 *    controlador e as aprovações não sobrevivem a um reinício);
 * 3. recuperação após falha: só administrativa (`recover`), com quarentena verificada → linhagem
 *    nova, também com barreira global pendente;
 * 4. perda, substituição ou adulteração (vestígios sem documentos, MAC/encadeamento/anchor
 *    inconsistentes, rollback) → INDISPONÍVEL; nada é reescrito nem liberado.
 *
 * Nenhum caso ambíguo libera execução: a fila só é considerada aberta pelo `barrierGate` quando a
 * autoridade de barreira (#011) também estiver liberada.
 */

export const QUEUE_SPEC_NAMESPACE = 'acc-queue:v1';

export interface OpenQueueStoreOptions {
  queueDir: string;
  /** Diretório de anchors existente (o mesmo das aprovações). */
  anchorDir: string;
  /** Diretório do ledger de aprovações: a fila precisa ficar separada dele. */
  approvalsDir?: string;
  environment: PathEnvironment;
  /** Subchave já derivada para `acc:queue:mac:v1`. */
  loadKey: () => Promise<SignedLedgerKey> | SignedLedgerKey;
  initialize?: 'never' | 'if_absent';
  now?: () => number;
  writeFile?: WriteFile;
  writeBytes?: WriteBytes;
  lockOps?: LockFileOps;
  alive?: (pid: number) => boolean;
  maxLedgerBytes?: number;
  maxHistoryBytes?: number;
  /**
   * Autoridade de barreira (#011). Só ela confirma a remoção de um pedido de barreira pendente (R2);
   * sem autoridade, nenhum pedido é removido. Deve ser a MESMA instância entregue ao `barrierGate`.
   */
  authority?: BarrierAuthority | null;
}

export type QueueTransaction = LedgerTransaction<QueueBody, QueueHistoryData>;

export interface QueueStore {
  status(): { state: LedgerState; reason: string | null };
  openedAs(): OpenedAs | null;
  epoch(): number;
  /** Leituras CONGELADAS em profundidade (R1): modificar lança `TypeError`; o estado não muda. */
  items(): readonly Readonly<QueueItem>[];
  pendingBarriers(): readonly Readonly<PendingBarrier>[];
  history(): ReadonlyArray<Readonly<HistoryEntry<QueueHistoryData>>>;
  /**
   * Alteração atômica e validada (`checkQueueChange`). Para o PR 2 e para os testes. Nunca remove
   * nem altera pedidos de barreira (R2).
   */
  commit<R>(change: (tx: QueueTransaction) => R): Promise<R>;
  /** Grava (de forma durável) um pedido de barreira ainda não confirmado na autoridade. */
  recordBarrierRequest(scope: BarrierScope, reason: string): Promise<void>;
  /**
   * Remove o pedido — SÓ se a autoridade injetada na abertura confirmar a barreira durável no
   * escopo, verificado dentro da operação serializada. Caso contrário: `barrier_not_confirmed`.
   */
  clearBarrierRequest(scope: BarrierScope): Promise<void>;
  /** Recuperação ADMINISTRATIVA: sem rota; a autorização humana é responsabilidade de quem chama. */
  recover(input: { actorId: string; reason: string }): Promise<{ quarantineId: string }>;
  close(): Promise<void>;
}

const entry = (data: Partial<QueueHistoryData> & Pick<QueueHistoryData, 'event'>): QueueHistoryData => ({
  actor: QUEUE_SYSTEM_ACTOR,
  itemId: null,
  projectId: null,
  from: null,
  to: null,
  reason: null,
  detail: null,
  ...data,
});

export function parseBarrierScope(raw: unknown): BarrierScope {
  if (typeof raw === 'object' && raw !== null && (raw as { kind?: unknown }).kind === 'global' && Object.keys(raw).length === 1) return { kind: 'global' };
  const value = raw as { kind?: unknown; projectId?: unknown };
  if (typeof raw === 'object' && raw !== null && value.kind === 'project' && typeof value.projectId === 'string' && UUID.test(value.projectId) && Object.keys(raw).length === 2) {
    return { kind: 'project', projectId: value.projectId };
  }
  throw new QueueError('invalid_scope');
}

/** Pedido de barreira global com que TODA linhagem nova nasce (U7). */
function requestGlobalBarrier(tx: QueueTransaction, reason: string, at: string) {
  tx.body.pendingBarriers.push({ scope: { kind: 'global' }, reason, requestedAt: at, epoch: tx.epoch });
  tx.append(entry({ event: 'queue.barrier_requested', reason, detail: 'scope global' }));
}

export async function openQueueStore(options: OpenQueueStoreOptions): Promise<QueueStore> {
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();

  /** Reinício normal: nada em curso é retomado; o que não começou expira. */
  function onEpoch(tx: QueueTransaction, info: EpochInfo) {
    if (info.lockRecovered) tx.append(entry({ event: 'queue.lock_recovered', reason: 'stale_lock' }));
    if (info.unapplied) tx.append(entry({ event: 'queue.history_unapplied', reason: 'ledger_write_lost', detail: `seq ${info.unapplied.first}-${info.unapplied.last}` }));
    const nowIso = iso();
    for (const item of tx.body.items) {
      // Relógio atrasado nunca faz `updatedAt` regredir (a regra é imposta em `checkQueueChange`).
      const at = Date.parse(item.updatedAt) > Date.parse(nowIso) ? item.updatedAt : nowIso;
      if (QUEUE_IN_FLIGHT_STATES.includes(item.state)) {
        const from = item.state;
        Object.assign(item, { state: 'interrupted', reason: 'instance_restart', updatedAt: at, stateEpoch: tx.epoch });
        tx.append(entry({ event: 'queue.item_interrupted', itemId: item.id, projectId: item.projectId, from, to: 'interrupted', reason: 'instance_restart' }));
      } else if (item.state === 'admitted') {
        Object.assign(item, { state: 'expired', reason: 'instance_restart', updatedAt: at, closedAt: at, stateEpoch: tx.epoch });
        tx.append(entry({ event: 'queue.item_expired', itemId: item.id, projectId: item.projectId, from: 'admitted', to: 'expired', reason: 'instance_restart' }));
      }
    }
    tx.append(entry({ event: 'queue.store_opened', reason: 'epoch_started', detail: `epoch ${tx.epoch}` }));
  }

  function onLineage(tx: QueueTransaction, cause: 'initial_install' | 'recovery', detail: string | null) {
    if (cause === 'initial_install') {
      tx.append(entry({ event: 'queue.store_initialized', reason: 'fresh_store', detail: `epoch ${tx.epoch}` }));
      requestGlobalBarrier(tx, 'queue_initial_install', iso());
    } else {
      tx.append(entry({ event: 'queue.store_recovered', reason: 'recovery', detail }));
      requestGlobalBarrier(tx, 'queue_recovery', iso());
    }
  }

  const ledger: SignedLedger<QueueBody, QueueHistoryData> = await openSignedLedger({
    spec: {
      namespace: QUEUE_SPEC_NAMESPACE,
      format: 'acc-queue',
      filePrefix: 'queue',
      emptyBody: () => ({ items: [], pendingBarriers: [] }),
      checkBody: checkQueueBody,
      checkEntry: checkQueueEntry,
      checkChange: checkQueueChange,
      onEpoch,
      onLineage,
    },
    dataDir: options.queueDir,
    anchorDir: options.anchorDir,
    separateFrom: options.approvalsDir ? [options.approvalsDir] : [],
    environment: options.environment,
    loadKey: options.loadKey,
    initialize: options.initialize,
    now,
    writeFile: options.writeFile,
    writeBytes: options.writeBytes,
    lockOps: options.lockOps,
    alive: options.alive,
    maxLedgerBytes: options.maxLedgerBytes,
    maxHistoryBytes: options.maxHistoryBytes,
  });

  const toQueueError = (error: unknown): never => {
    throw error instanceof StorageError ? new QueueError(error.code) : error;
  };
  // `commit` público: NUNCA repassa permissão (`allow`) ao motor — pedidos de barreira não podem ser
  // removidos por aqui (R2). Só `clearBarrierRequest` abaixo fornece a permissão, após confirmar.
  const commit = <R>(change: (tx: QueueTransaction) => R) => ledger.commit(change).catch(toQueueError);
  const authority = options.authority ?? null;

  return {
    status: () => ledger.status(),
    openedAs: () => ledger.openedAs(),
    epoch: () => ledger.epoch(),
    items: () => ledger.body().items,
    pendingBarriers: () => ledger.body().pendingBarriers,
    history: () => ledger.history(),
    commit,
    async recordBarrierRequest(rawScope, reason) {
      const scope = parseBarrierScope(rawScope);
      if (typeof reason !== 'string' || !REASON.test(reason)) throw new QueueError('invalid_reason');
      return commit((tx) => {
        if (tx.body.pendingBarriers.some((b) => scopeKey(b.scope) === scopeKey(scope))) return;
        tx.body.pendingBarriers.push({ scope, reason, requestedAt: iso(), epoch: tx.epoch });
        tx.append(entry({ event: 'queue.barrier_requested', projectId: scope.kind === 'project' ? scope.projectId : null, reason, detail: `scope ${scope.kind}` }));
      });
    },
    async clearBarrierRequest(rawScope) {
      const scope = parseBarrierScope(rawScope);
      const clearance: BarrierClearance = { kind: 'clear_barrier', scopeKey: scopeKey(scope) };
      return ledger
        .commit((tx) => {
          const index = tx.body.pendingBarriers.findIndex((b) => scopeKey(b.scope) === scopeKey(scope));
          if (index < 0) return;
          // Confirmação DENTRO da operação serializada, na autoridade injetada na abertura (R2):
          // sem barreira durável confirmada, nada é removido.
          if (!authorityConfirms(authority, scope)) throw new QueueError('barrier_not_confirmed');
          const [removed] = tx.body.pendingBarriers.splice(index, 1);
          tx.append(entry({ event: 'queue.barrier_confirmed', projectId: scope.kind === 'project' ? scope.projectId : null, reason: removed.reason, detail: `scope ${scope.kind}` }));
        }, clearance)
        .catch(toQueueError);
    },
    recover: (input) => ledger.recover(input).catch(toQueueError),
    close: () => ledger.close(),
  };
}
