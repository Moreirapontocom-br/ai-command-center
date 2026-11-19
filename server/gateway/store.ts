import type { WriteFile } from '../storage/jsonFile.ts';
import type { LockFileOps } from '../storage/lock.ts';
import type { PathEnvironment } from '../storage/paths.ts';
import { openSignedLedger, type HistoryEntry, type LedgerState, type LedgerTransaction, type OpenedAs, type SignedLedger, type SignedLedgerKey, type WriteBytes } from '../storage/signedLedger.ts';
import { GATEWAY_SYSTEM_ACTOR, GatewayError, type GatewayBody, type GatewayHistoryData } from './contracts.ts';
import { checkGatewayBody, checkGatewayChange, checkGatewayEntry, GatewayDocumentError } from './documents.ts';

/**
 * Armazenamento durável do gateway (Issue #028, D7) sobre o motor `storage/signedLedger.ts`:
 * MAC com subchave HKDF própria (`acc:gateway:mac:v1`), linhagem, época e anchor próprios.
 *
 * Reinício (época nova), ajustes conservadores — nada é retomado sozinho:
 * - escopo `activating` → `failed` (`activation_interrupted`): a aprovação consumida NUNCA vira
 *   escopo depois de uma falha (o recibo só existe em memória); repetir exige nova aprovação;
 * - invocação `requested`/`dispatched` → `interrupted` (o adaptador em memória foi perdido; sem
 *   reenvio automático);
 * - handoffs continuam no estado gravado (a pessoa ainda pode trazer o resultado dentro do prazo).
 */

export const GATEWAY_SPEC_NAMESPACE = 'acc-gateway:v1';
export const GATEWAY_KEY_DOMAIN = 'acc:gateway:mac:v1';
export const GATEWAY_CONTENT_KEY_DOMAIN = 'acc:gateway:content:v1';

export type GatewayTransaction = LedgerTransaction<GatewayBody, GatewayHistoryData>;

export interface GatewayStore {
  status(): { state: LedgerState; reason: string | null };
  openedAs(): OpenedAs | null;
  epoch(): number;
  body(): Readonly<GatewayBody>;
  history(): ReadonlyArray<Readonly<HistoryEntry<GatewayHistoryData>>>;
  commit<R>(change: (tx: GatewayTransaction) => R): Promise<R>;
  close(): Promise<void>;
}

export interface OpenGatewayStoreOptions {
  gatewayDir: string;
  anchorDir: string;
  /** Diretórios que o do gateway não pode conter nem estar contido (aprovações, fila, conteúdos). */
  separateFrom?: readonly string[];
  environment: PathEnvironment;
  loadKey: () => Promise<SignedLedgerKey> | SignedLedgerKey;
  initialize?: 'never' | 'if_absent';
  now?: () => number;
  writeFile?: WriteFile;
  writeBytes?: WriteBytes;
  lockOps?: LockFileOps;
  alive?: (pid: number) => boolean;
}

const entry = (event: GatewayHistoryData['event'], reason: string, detail: string | null = null): GatewayHistoryData => ({ event, actor: GATEWAY_SYSTEM_ACTOR, projectId: null, ref: null, reason, detail });

export async function openGatewayStore(options: OpenGatewayStoreOptions): Promise<GatewayStore> {
  const now = options.now ?? Date.now;
  const ledger: SignedLedger<GatewayBody, GatewayHistoryData> = await openSignedLedger<GatewayBody, GatewayHistoryData>({
    spec: {
      namespace: GATEWAY_SPEC_NAMESPACE,
      format: 'acc-gateway',
      filePrefix: 'gateway',
      emptyBody: () => ({ scopes: [], invocations: [], handoffs: [], contents: [] }),
      checkBody: checkGatewayBody,
      checkEntry: checkGatewayEntry,
      checkChange: (before, after) => checkGatewayChange(before, after),
      onEpoch(tx, info) {
        const at = new Date(now()).toISOString();
        let interrupted = 0;
        const closed = new Set<string>();
        for (const scope of tx.body.scopes) {
          if (scope.state === 'activating') {
            Object.assign(scope, { state: 'failed', reason: 'activation_interrupted', updatedAt: at });
            tx.append({ ...entry('gateway.scope_activation_failed', 'activation_interrupted'), projectId: scope.projectId, ref: scope.id });
          } else if (scope.state === 'active' || scope.state === 'exhausted') {
            // R1 (revisão do PR #48): nenhuma autorização atravessa um reinício — como as aprovações
            // concedidas da #011, que vencem na troca de época. Também cobre a gravação do escopo
            // ativo que chegou ao ledger, mas não ao anchor, numa ativação informada como falha.
            Object.assign(scope, { state: 'expired', reason: 'restart_closed', updatedAt: at });
            tx.append({ ...entry('gateway.scope_closed', 'restart_closed', 'to expired'), projectId: scope.projectId, ref: scope.id });
            closed.add(scope.id);
          }
        }
        for (const invocation of tx.body.invocations) {
          if (invocation.state === 'requested' || invocation.state === 'dispatched') {
            Object.assign(invocation, { state: 'interrupted', reason: 'restart_interrupted', updatedAt: at });
            interrupted += 1;
          } else if (invocation.state === 'queued' && closed.has(invocation.scopeId)) {
            Object.assign(invocation, { state: 'refused', reason: 'scope_expired', updatedAt: at });
          }
        }
        // Pacote ainda não liberado não pode mais sair; o já liberado ainda pode voltar (janela própria).
        for (const handoff of tx.body.handoffs) {
          if (handoff.state === 'prepared' && closed.has(handoff.scopeId)) {
            Object.assign(handoff, { state: 'expired', reason: 'scope_expired', updatedAt: at });
            tx.append({ ...entry('gateway.handoff_closed', 'scope_expired'), projectId: handoff.projectId, ref: handoff.id });
          }
        }
        tx.append(entry('gateway.store_opened', info.lockRecovered ? 'lock_recovered' : 'restart', interrupted > 0 ? `interrupted ${interrupted}` : null));
        if (interrupted > 0) tx.append(entry('gateway.interrupted', 'restart_interrupted', `count ${interrupted}`));
      },
      onLineage(tx, cause) {
        tx.append(entry('gateway.store_initialized', cause));
      },
    },
    dataDir: options.gatewayDir,
    anchorDir: options.anchorDir,
    separateFrom: options.separateFrom,
    environment: options.environment,
    loadKey: options.loadKey,
    initialize: options.initialize ?? 'never',
    now,
    writeFile: options.writeFile,
    writeBytes: options.writeBytes,
    lockOps: options.lockOps,
    alive: options.alive,
  });

  return {
    status: () => ledger.status(),
    openedAs: () => ledger.openedAs(),
    epoch: () => ledger.epoch(),
    body: () => ledger.body(),
    history: () => ledger.history(),
    async commit(change) {
      try {
        return await ledger.commit(change);
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (error instanceof GatewayDocumentError) throw new GatewayError('change_rejected');
        const code = (error as { code?: unknown })?.code;
        throw new GatewayError(typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'store_write_failed');
      }
    },
    close: () => ledger.close(),
  };
}
