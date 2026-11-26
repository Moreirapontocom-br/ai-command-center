// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultJournalOps, JOURNAL_FILE, parseJournal, readJournal, releasePending, removeJournal, writeJournal, type ReleaseJournal } from './journal.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const dir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'acc-journal-'));
  roots.push(d);
  return d;
};
const AT = '2026-11-24T12:00:00.000Z';
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const base: ReleaseJournal = {
  format: 'acc-admin-release-journal',
  version: 1,
  operation: 'barrier_release_global',
  state: 'intent',
  lineage: '11111111-1111-4111-8111-111111111111',
  epoch: 3,
  historySeq: 10,
  approvalId: null,
  attemptId: null,
  startedAt: AT,
  updatedAt: AT,
};

describe('diário da liberação (R2)', () => {
  it('ida e volta, estados e remoção', async () => {
    const d = await dir();
    expect(await readJournal(d)).toEqual({ kind: 'absent' });
    expect(await releasePending(d)).toBe(false);
    await writeJournal(d, base);
    expect(await readJournal(d)).toEqual({ kind: 'present', journal: base });
    expect(await releasePending(d)).toBe(true);
    const reserved = { ...base, state: 'reserved' as const, approvalId: ID, attemptId: ID };
    await writeJournal(d, reserved);
    expect(await readJournal(d)).toEqual({ kind: 'present', journal: reserved });
    await removeJournal(d);
    expect(await readJournal(d)).toEqual({ kind: 'absent' });
  });

  it.each([
    ['campo extra', { ...base, extra: 1 }],
    ['estado desconhecido', { ...base, state: 'done' }],
    ['intent com ids', { ...base, approvalId: ID }],
    ['reserved sem ids', { ...base, state: 'reserved' }],
    ['linhagem inválida', { ...base, lineage: 'x' }],
    ['operação diferente', { ...base, operation: 'limits_change' }],
    ['data não canônica', { ...base, startedAt: '2026-11-24' }],
  ])('rejeita %s', async (_name, doc) => {
    expect(parseJournal(JSON.stringify(doc))).toBeNull();
    const d = await dir();
    await writeFile(join(d, JOURNAL_FILE), JSON.stringify(doc));
    expect(await readJournal(d)).toEqual({ kind: 'invalid' });
    // Inválido continua sendo PENDÊNCIA para o servidor (fail-closed).
    expect(await releasePending(d)).toBe(true);
  });

  it('não grava diário inválido', async () => {
    const d = await dir();
    await expect(writeJournal(d, { ...base, state: 'reserved' })).rejects.toThrow('journal_invalid');
  });

  it('erro ao consultar o diário = pendente (fail-closed)', async () => {
    const ops = { ...defaultJournalOps, exists: async () => Promise.reject(new Error('EACCES')) };
    expect(await releasePending('/qualquer', ops)).toBe(true);
    expect(await readJournal('/qualquer', ops)).toEqual({ kind: 'invalid' });
  });
});
