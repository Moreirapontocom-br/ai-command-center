// @vitest-environment node
/**
 * Issue #008, fechamento — C1/C2: cruzamento #011 × #006 com fatos sintéticos (as sondas R1, R2 e
 * R3 da validação final, como testes permanentes). Puro: nenhum arquivo, rede ou relógio real.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '../approvals/documents.ts';
import { AUDIT_EVENTS_MAX } from '../audit/auditLog.ts';
import { applyRetention, isPreservedEvent, PRESERVED_RELEASE_OPERATION, type EventLog, type StoredAuditEvent } from '../audit/events.ts';
import { checkReleaseAudit } from './consistency.ts';
import { RELEASE_OPERATION } from './journal.ts';

const T = Date.parse('2026-12-01T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** Uma linhagem com UMA liberação global aplicada (seq 10, geração 5) pela aprovação `P`. */
function lineage(opts: { seq?: number; at?: number } = {}) {
  const P = randomUUID();
  const seq = opts.seq ?? 10;
  const at = opts.at ?? T;
  const entry = (s: number, gen: number, when: number, extra: Record<string, unknown>) =>
    ({
      kind: 'entry', seq: s, at: iso(when), prevHash: null, hash: 'h', ledgerGeneration: gen,
      actor: { kind: 'human', id: 'admin' }, approvalId: null, attemptId: null, projectId: null, class: null,
      action: null, bindingDigest: null, from: null, to: null, reason: null, detail: null, ...extra,
    }) as unknown as HistoryItem;
  const items: HistoryItem[] = [
    entry(seq - 7, 2, at - 60_000, { event: 'approval.requested', approvalId: P, action: 'killswitch.release' }),
    entry(seq, 5, at, { event: 'approval.barrier_released', detail: 'scope global' }),
    entry(seq + 1, 5, at, { event: 'approval.attempt_succeeded', approvalId: P, attemptId: randomUUID(), to: 'succeeded' }),
  ];
  return { P, seq, at, history: { items } };
}

let nextSeq = 0;
function ev(at: number, extra: Partial<StoredAuditEvent> = {}): StoredAuditEvent {
  nextSeq += 1;
  return {
    id: randomUUID(), seq: nextSeq, at: iso(at), action: 'auth.login', actor: { kind: 'human', id: 'admin' },
    ownerId: 'admin', projectId: null, resource: { type: 'session', id: null }, outcome: 'success', context: {}, ...extra,
  } as StoredAuditEvent;
}
const finalOf = (l: { P: string; seq: number }, at: number, extra: Partial<StoredAuditEvent> = {}) =>
  ev(at, { action: 'approval.configuration', resource: { type: 'approval', id: l.P }, context: { operation: RELEASE_OPERATION, seq: l.seq }, ...extra });
const anon = (at: number) => ev(at, { action: 'access.denied', actor: { kind: 'system', id: 'anonymous' }, ownerId: null, outcome: 'blocked' });
const logOf = (events: StoredAuditEvent[], droppedEvents = 0): EventLog => ({ events, droppedEvents });
/** Acrescenta eventos aplicando a retenção como `auditLog.append` (em lotes de 500, mesmo resultado final). */
const flood = (log: EventLog, count: number, make: (i: number) => StoredAuditEvent) => {
  for (let i = 0; i < count; i += 1) {
    log.events.push(make(i));
    if (i % 500 === 499 || i === count - 1) applyRetention(log, AUDIT_EVENTS_MAX);
  }
};

describe('C1 — retenção da #006 preserva o registro final', { timeout: 30_000 }, () => {
  it('a operação preservada é a mesma do comando; só o registro FINAL de sucesso é preservado', () => {
    expect(PRESERVED_RELEASE_OPERATION).toBe(RELEASE_OPERATION);
    const l = lineage();
    expect(isPreservedEvent(finalOf(l, T + 1))).toBe(true);
    expect(isPreservedEvent(finalOf(l, T + 1, { outcome: 'failure' }))).toBe(false);
    expect(isPreservedEvent(ev(T, { action: 'approval.confirmation', context: { operation: RELEASE_OPERATION } }))).toBe(false);
    expect(isPreservedEvent(ev(T, { action: 'approval.configuration', context: { operation: 'approve' } }))).toBe(false);
  });

  it('R1: sem registro final, dezenas de milhares de eventos (anônimos e atribuídos) NUNCA tornam a lacuna aceita', () => {
    const l = lineage();
    const log = logOf([ev(T - 120_000), ev(T + 1_000)]);
    expect(checkReleaseAudit(l.history, log).state).toBe('missing');
    flood(log, 20_000, (i) => anon(T + 10_000 + i));
    expect(checkReleaseAudit(l.history, log).state).toBe('missing');
    flood(log, 25_000, (i) => ev(T + 100_000 + i));
    expect(log.droppedEvents).toBeGreaterThan(20_000);
    expect(log.events.every((e) => Date.parse(e.at) > l.at)).toBe(true); // a janela já passou pela liberação
    expect(checkReleaseAudit(l.history, log).state).toBe('missing');
  });

  it('registro final legítimo sobrevive a 45.000 eventos; o restante da retenção continua igual', () => {
    const l = lineage();
    const log = logOf([ev(T - 1), finalOf(l, T + 1)]);
    flood(log, 20_000, (i) => anon(T + 10 + i));
    flood(log, 25_000, (i) => ev(T + 100_000 + i));
    expect(log.events).toHaveLength(AUDIT_EVENTS_MAX);
    expect(log.events.filter(isPreservedEvent)).toHaveLength(1);
    expect(log.events[0]).toMatchObject({ action: 'approval.configuration', resource: { id: l.P } }); // o mais antigo retido
    expect(log.droppedEvents).toBe(2 + 45_000 - AUDIT_EVENTS_MAX);
    expect(checkReleaseAudit(l.history, log)).toEqual({ state: 'consistent', releases: 1 });
  });

  it('várias linhagens: os registros preservados nunca são descartados, nem acima do limite (sem perda silenciosa)', () => {
    const finals = [lineage(), lineage(), lineage()].map((l, i) => finalOf(l, T + i));
    const log = logOf([...finals, ev(T + 10), ev(T + 11)]);
    applyRetention(log, 2);
    expect(log.events).toEqual(finals); // só restaram preservados: fica acima do limite (3 > 2)
    expect(log.droppedEvents).toBe(2); // contagem exata do que saiu
    log.events.push(ev(T + 12));
    applyRetention(log, 2);
    expect(log.events).toEqual(finals);
    expect(log.droppedEvents).toBe(3);
  });

  it('retenção sem preservados: comportamento anterior (anônimos primeiro, depois os mais antigos)', () => {
    const e = [ev(T, {}), anon(T), ev(T, {}), anon(T), ev(T, {})];
    const log = logOf([...e], 3);
    applyRetention(log, 3);
    expect(log.events).toEqual([e[0], e[2], e[4]]);
    expect(log.droppedEvents).toBe(5);
    applyRetention(log, 2);
    expect(log.events).toEqual([e[2], e[4]]);
    expect(log.droppedEvents).toBe(6);
  });
});

describe('C2 — correlação pela aprovação, independente do relógio', () => {
  it.each([
    ['muito anterior à liberação (relógio atrasado)', -86_400_000],
    ['logo antes', -1],
    ['igual', 0],
    ['muito posterior (relógio adiantado)', 30 * 86_400_000],
  ])('registro final gravado %s → consistente', (_name, offset) => {
    const l = lineage();
    expect(checkReleaseAudit(l.history, logOf([finalOf(l, l.at + offset)]))).toEqual({ state: 'consistent', releases: 1 });
  });

  it('reconciliações sucessivas com o relógio oscilando: o primeiro registro basta; não há segundo', () => {
    const l = lineage();
    const log = logOf([finalOf(l, T - 5_000)]);
    for (let i = 0; i < 3; i += 1) expect(checkReleaseAudit(l.history, log).state).toBe('consistent'); // nada a reconciliar
  });

  it('registro duplicado da MESMA aprovação (qualquer relógio) → audit_record_duplicate', () => {
    const l = lineage();
    expect(checkReleaseAudit(l.history, logOf([finalOf(l, T - 5_000), finalOf(l, T + 9_000)]))).toEqual({ state: 'inconsistent', reason: 'audit_record_duplicate' });
  });

  it.each([
    ['seq errado', { context: { operation: RELEASE_OPERATION, seq: 99 } }],
    ['resultado de falha', { outcome: 'failure' as const }],
    ['ator agente', { actor: { kind: 'agent' as const, id: 'admin' } }],
    ['outro dono', { ownerId: 'outro' }],
    ['com projeto', { projectId: randomUUID() }],
    ['tipo de recurso trocado', { resource: { type: 'project' as const, id: '' } }],
  ])('registro contraditório da MESMA aprovação (%s) → audit_record_mismatch', (_name, change) => {
    const l = lineage();
    const bad = finalOf(l, T + 1, change as Partial<StoredAuditEvent>);
    if (bad.resource.type === 'project') bad.resource.id = l.P;
    expect(checkReleaseAudit(l.history, logOf([bad]))).toEqual({ state: 'inconsistent', reason: 'audit_record_mismatch' });
    // Junto com um registro correto, a contradição continua bloqueando.
    expect(checkReleaseAudit(l.history, logOf([finalOf(l, T + 2), bad])).state).toBe('inconsistent');
  });

  it.each([
    ['anterior', -86_400_000],
    ['posterior (relógio adiantado na linhagem antiga)', 3_600_000],
  ])('linhagem antiga com seq coincidente, %s → ignorada: não valida nem bloqueia', (_name, offset) => {
    const old = lineage({ at: T + offset });
    const current = lineage();
    const oldRecord = finalOf(old, old.at + 1);
    expect(checkReleaseAudit(current.history, logOf([oldRecord]))).toMatchObject({ state: 'missing', missing: [{ approvalId: current.P }] });
    expect(checkReleaseAudit(current.history, logOf([oldRecord, finalOf(current, T + 1)]))).toEqual({ state: 'consistent', releases: 1 });
  });

  it('uma aprovação sustentando duas liberações → release_uncorrelated', () => {
    const l = lineage();
    const items = [...l.history.items];
    const twice = structuredClone(items.slice(1)).map((e) => ({ ...e, seq: (e as { seq: number }).seq + 100, ledgerGeneration: 9 })) as HistoryItem[];
    expect(checkReleaseAudit({ items: [...items, ...twice] }, logOf([finalOf(l, T + 1)]))).toEqual({ state: 'inconsistent', reason: 'release_uncorrelated' });
  });
});

describe('R3 — auditoria incorreta, indisponível ou divergente', () => {
  it('auditoria ou histórico malformados → check_failed (indisponível)', () => {
    const l = lineage();
    expect(checkReleaseAudit(l.history, { events: null as never, droppedEvents: 0 })).toEqual({ state: 'inconsistent', reason: 'check_failed' });
    expect(checkReleaseAudit({ items: null as never }, logOf([]))).toEqual({ state: 'inconsistent', reason: 'check_failed' });
  });

  it('#011 sem attempt_succeeded na geração da liberação → release_uncorrelated, mesmo com registro "perfeito"', () => {
    const l = lineage();
    const items = l.history.items.filter((e) => (e as { event?: string }).event !== 'approval.attempt_succeeded');
    expect(checkReleaseAudit({ items }, logOf([finalOf(l, T + 1)]))).toEqual({ state: 'inconsistent', reason: 'release_uncorrelated' });
  });

  it('pedido da aprovação não é killswitch.release → release_approval_unexpected', () => {
    const l = lineage();
    const items = l.history.items.map((e) => ((e as { event?: string }).event === 'approval.requested' ? ({ ...e, action: 'approvals.retention_change' } as HistoryItem) : e));
    expect(checkReleaseAudit({ items }, logOf([finalOf(l, T + 1)]))).toEqual({ state: 'inconsistent', reason: 'release_approval_unexpected' });
  });

  it('sem liberação na #011, nenhum registro da #006 fabrica uma (consistente, 0 liberações)', () => {
    const l = lineage();
    const items = l.history.items.filter((e) => (e as { event?: string }).event === 'approval.requested');
    expect(checkReleaseAudit({ items }, logOf([finalOf(l, T + 1)]))).toEqual({ state: 'consistent', releases: 0 });
  });

  it('duas auditorias (dois ACC_DATA_DIR) sobre a mesma #011: cada uma é julgada só pelos próprios registros', () => {
    const l = lineage();
    const a = logOf([finalOf(l, T + 1)]);
    const b = logOf([ev(T + 2)]);
    expect(checkReleaseAudit(l.history, a)).toEqual({ state: 'consistent', releases: 1 });
    expect(checkReleaseAudit(l.history, b).state).toBe('missing');
    const bWrong = logOf([finalOf(l, T + 3, { context: { operation: RELEASE_OPERATION, seq: 1 } })]);
    expect(checkReleaseAudit(l.history, bWrong)).toEqual({ state: 'inconsistent', reason: 'audit_record_mismatch' });
  });
});
