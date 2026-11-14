import {
  AUDIT_QUERY_LIMITS,
  type AuditAction,
  type AuditEvent,
  type AuditOutcome,
} from '../../shared/contracts.ts';
import { openJsonFile, type WriteFile } from '../storage/jsonFile.ts';
import {
  applyRetention,
  createAuditSequence,
  makeEvent,
  toPublicEvent,
  validateEventLog,
  type AuditEventInput,
  type AuditSequence,
  type EventLog,
  type StoredAuditEvent,
} from './events.ts';

/**
 * Registro de auditoria AVULSO (`audit.json`): eventos que não acompanham nenhuma alteração de
 * dados — login, logout, logins recusados, acessos negados e tentativas de escrita recusadas ou
 * que falharam. As alterações bem-sucedidas de projetos e tarefas têm o evento gravado no próprio
 * arquivo delas (mesma escrita atômica); este registro nunca é a única prova de uma alteração.
 */

export const AUDIT_FORMAT = 'acc-audit';
export const AUDIT_VERSION = 1;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Retenção (MVP): últimos eventos avulsos mantidos (descarta primeiro os de clientes anônimos). */
export const AUDIT_EVENTS_MAX = 20000;

export interface AuditLog {
  /** Grava o evento. Rejeita se a gravação falhar (quem chama decide como não tratar isso como sucesso). */
  append(input: AuditEventInput): Promise<StoredAuditEvent>;
  log(): Readonly<EventLog>;
}

export interface AuditLogOptions {
  filePath: string;
  sequence: AuditSequence;
  now?: () => number;
  writeFile?: WriteFile;
}

export async function openAuditLog(options: AuditLogOptions): Promise<AuditLog> {
  const now = options.now ?? Date.now;
  const file = await openJsonFile<EventLog>({
    filePath: options.filePath,
    label: 'auditoria',
    format: AUDIT_FORMAT,
    version: AUDIT_VERSION,
    maxBytes: MAX_FILE_BYTES,
    empty: () => ({ events: [], droppedEvents: 0 }),
    validate: (raw, corrupt) => {
      if (Object.keys(raw).length !== 2) corrupt('estrutura');
      return validateEventLog(raw.events, raw.droppedEvents, options.sequence, corrupt);
    },
    writeFile: options.writeFile,
  });
  return {
    append(input) {
      return file.mutate((draft) => {
        const event = makeEvent(input, options.sequence.next(), new Date(now()).toISOString());
        draft.events.push(event);
        applyRetention(draft, AUDIT_EVENTS_MAX);
        return event;
      });
    },
    log() {
      return file.data;
    },
  };
}

export interface AuditQuery {
  ownerId: string;
  /** Pode ver eventos da instância (`ownerId: null`: login recusado, acesso anônimo negado). */
  includeInstanceEvents: boolean;
  projectId?: string;
  action?: AuditAction;
  outcome?: AuditOutcome;
  before?: number;
  limit?: number;
}

/**
 * Consulta unificada sobre as três fontes (projetos, tarefas e registro avulso), ordenada por `seq`
 * decrescente. Isolamento: só eventos do dono da sessão (e, para o administrador da instância,
 * os eventos sem dono). Com `projectId`, só eventos daquele projeto.
 */
export function queryAudit(
  sources: ReadonlyArray<Readonly<EventLog>>,
  query: AuditQuery,
): { events: AuditEvent[]; nextBefore: number | null; droppedEvents: number } {
  const limit = Math.min(query.limit ?? AUDIT_QUERY_LIMITS.defaultLimit, AUDIT_QUERY_LIMITS.maxLimit);
  const matches = sources
    .flatMap((source) => source.events)
    .filter(
      (e) =>
        (e.ownerId === query.ownerId || (e.ownerId === null && query.includeInstanceEvents)) &&
        (query.projectId === undefined || e.projectId === query.projectId) &&
        (query.action === undefined || e.action === query.action) &&
        (query.outcome === undefined || e.outcome === query.outcome) &&
        (query.before === undefined || e.seq < query.before),
    )
    .sort((a, b) => b.seq - a.seq);
  const page = matches.slice(0, limit);
  return {
    events: page.map(toPublicEvent),
    nextBefore: matches.length > limit ? page[page.length - 1].seq : null,
    droppedEvents: sources.reduce((total, source) => total + source.droppedEvents, 0),
  };
}

export { createAuditSequence };
