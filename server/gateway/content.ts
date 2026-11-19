import { createHash } from 'node:crypto';
import type { SealedBlobStore } from '../storage/sealedBlobs.ts';
import { GATEWAY_LIMITS, GATEWAY_SYSTEM_ACTOR, GatewayError, type ContentKind, type GatewayContentRef } from './contracts.ts';
import { containsSecret } from './secretScan.ts';
import type { GatewayStore, GatewayTransaction } from './store.ts';

/**
 * Conteúdos do gateway (Issue #028, P3): pacotes assistidos, resultados trazidos pela pessoa e
 * saídas dos adaptadores simulados.
 *
 * - O texto fica CIFRADO (AES-256-GCM, `storage/sealedBlobs.ts`) com dados associados que prendem
 *   o conteúdo ao id, ao dono, ao projeto e ao tipo; o ledger assinado guarda só a referência
 *   (id opaco, resumo SHA-256, tamanho, validade, estado). Resumo não é criptografia: é a
 *   conferência extra de integridade na leitura.
 * - Leitura só pelo MESMO dono e projeto (outro projeto é indistinguível de inexistente); excluído,
 *   vencido, ausente ou adulterado → recusado, por token, sem conteúdo em erro ou log.
 * - Nada com aparência de segredo é armazenado (`secret_detected`).
 * - Retenção conservadora e configurável (padrão 30 dias; 1–90); a varredura exclui os vencidos e
 *   os arquivos órfãos (gravados sem referência por falha entre as duas gravações).
 */

export interface ContentManager {
  /** Grava o arquivo cifrado e devolve a referência para o chamador incluir NA MESMA transação do registro de origem. */
  seal(input: { id: string; ownerId: string; projectId: string; kind: ContentKind; sourceId: string; text: string; maxBytes: number }): Promise<GatewayContentRef>;
  read(ownerId: string, projectId: string, contentId: string): Promise<string>;
  /** Exclusão controlada (marca no ledger e remove o arquivo). */
  remove(ownerId: string, projectId: string, contentId: string, reason: string, actor: { kind: 'human' | 'system'; id: string }): Promise<void>;
  /** Exclui vencidos e órfãos. Devolve quantos foram excluídos. */
  sweep(): Promise<number>;
  /** Descarta o arquivo de um conteúdo cuja referência não chegou a ser gravada. */
  discard(contentId: string): Promise<void>;
  retentionDays: number;
}

const aadOf = (ref: Pick<GatewayContentRef, 'ownerId' | 'projectId' | 'kind' | 'sourceId'>) => `${ref.ownerId}|${ref.projectId}|${ref.kind}|${ref.sourceId}`;
export const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function createContentManager(options: { store: GatewayStore; blobs: SealedBlobStore; retentionDays?: number; now?: () => number }): ContentManager {
  const now = options.now ?? Date.now;
  const days = options.retentionDays ?? GATEWAY_LIMITS.contentRetentionDays.default;
  const range = GATEWAY_LIMITS.contentRetentionDays;
  if (!Number.isSafeInteger(days) || days < range.min || days > range.max) throw new GatewayError('invalid_retention');
  const { store, blobs } = options;
  const iso = (ms = now()) => new Date(ms).toISOString();

  const find = (ownerId: string, projectId: string, id: string) => {
    const ref = store.body().contents.find((c) => c.id === id);
    if (!ref || ref.ownerId !== ownerId || ref.projectId !== projectId) throw new GatewayError('not_found');
    return ref;
  };

  function markDeleted(tx: GatewayTransaction, id: string, reason: string, actor: { kind: 'human' | 'system'; id: string }) {
    const ref = tx.body.contents.find((c) => c.id === id);
    if (!ref || ref.state === 'deleted') return false;
    Object.assign(ref, { state: 'deleted', deletedAt: iso(), deletedReason: reason });
    tx.append({ event: 'gateway.content_deleted', actor, projectId: ref.projectId, ref: ref.id, reason, detail: `kind ${ref.kind}` });
    return true;
  }

  return {
    retentionDays: days,

    async seal(input) {
      const bytes = Buffer.byteLength(input.text, 'utf8');
      if (bytes > Math.min(input.maxBytes, GATEWAY_LIMITS.maxPackageBytes)) throw new GatewayError('content_too_large');
      if (containsSecret(input.text)) throw new GatewayError('secret_detected');
      const at = now();
      const ref: GatewayContentRef = {
        id: input.id,
        ownerId: input.ownerId,
        projectId: input.projectId,
        kind: input.kind,
        sourceId: input.sourceId,
        digest: digestOf(input.text),
        bytes,
        createdAt: iso(at),
        expiresAt: iso(at + days * 24 * 60 * 60 * 1000),
        state: 'stored',
        deletedAt: null,
        deletedReason: null,
      };
      try {
        await blobs.put(ref.id, aadOf(ref), Buffer.from(input.text, 'utf8'));
      } catch {
        throw new GatewayError('content_write_failed');
      }
      return ref;
    },

    async read(ownerId, projectId, contentId) {
      const ref = find(ownerId, projectId, contentId);
      if (ref.state === 'deleted') throw new GatewayError('content_deleted');
      if (Date.parse(ref.expiresAt) <= now()) throw new GatewayError('content_expired');
      let plain: Buffer;
      try {
        plain = await blobs.get(ref.id, aadOf(ref));
      } catch (error) {
        throw new GatewayError((error as { code?: string }).code === 'blob_missing' ? 'content_missing' : 'content_corrupted');
      }
      const text = plain.toString('utf8');
      if (digestOf(text) !== ref.digest || Buffer.byteLength(text, 'utf8') !== ref.bytes) throw new GatewayError('content_corrupted');
      return text;
    },

    async remove(ownerId, projectId, contentId, reason, actor) {
      const ref = find(ownerId, projectId, contentId);
      if (ref.state === 'deleted') return;
      await store.commit((tx) => markDeleted(tx, contentId, reason, actor));
      await blobs.delete(contentId).catch(() => undefined);
    },

    async sweep() {
      const at = now();
      const due = store.body().contents.filter((c) => c.state === 'stored' && Date.parse(c.expiresAt) <= at).map((c) => c.id);
      if (due.length > 0) await store.commit((tx) => due.forEach((id) => markDeleted(tx, id, 'retention_elapsed', GATEWAY_SYSTEM_ACTOR)));
      const referenced = new Map(store.body().contents.map((c) => [c.id, c.state]));
      let removed = 0;
      for (const id of await blobs.list()) {
        const state = referenced.get(id);
        if (state === undefined || state === 'deleted') {
          await blobs.delete(id).catch(() => undefined);
          removed += 1;
        }
      }
      return removed;
    },

    async discard(contentId) {
      await blobs.delete(contentId).catch(() => undefined);
    },
  };
}
