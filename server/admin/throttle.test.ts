// @vitest-environment node
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STEP_UP_LOCK_MS, STEP_UP_MAX_FAILURES } from '../approvals/contracts.ts';
import { defaultJournalOps } from './journal.ts';
import { createThrottle, HARD_LOCK_FAILURES, LOCK_MS, MAX_FAILURES, THROTTLE_FILE, WINDOW_MS, windowLock } from './throttle.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const MIN = 60_000;
async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'acc-throttle-'));
  roots.push(dataDir);
  const clock = { now: Date.parse('2026-11-24T12:00:00Z') };
  return { dataDir, clock, throttle: createThrottle({ dataDir, now: () => clock.now }) };
}

describe('limite persistente (R3)', () => {
  it('mesmos valores do step-up da #011; trava dura H2 = 20', () => {
    expect([MAX_FAILURES, WINDOW_MS, LOCK_MS]).toEqual([STEP_UP_MAX_FAILURES, STEP_UP_LOCK_MS, STEP_UP_LOCK_MS]);
    expect(MAX_FAILURES).toBe(5);
    expect(WINDOW_MS).toBe(15 * MIN);
    expect(HARD_LOCK_FAILURES).toBe(20);
  });

  it('a tentativa é gravada ANTES (conta como falha) e o sucesso zera', async () => {
    const t = await setup();
    expect(await t.throttle.check([])).toEqual({ allowed: true });
    for (let i = 0; i < 4; i += 1) await t.throttle.recordAttempt();
    expect(await t.throttle.check([])).toEqual({ allowed: true });
    await t.throttle.recordAttempt();
    expect(await t.throttle.check([])).toMatchObject({ allowed: false, reason: 'temporarily_locked', until: new Date(t.clock.now + LOCK_MS).toISOString() });
    t.clock.now += LOCK_MS;
    expect(await t.throttle.check([])).toEqual({ allowed: true });
    await t.throttle.recordSuccess();
    expect(JSON.parse(await readFile(join(t.dataDir, THROTTLE_FILE), 'utf8'))).toMatchObject({ consecutive: 0, recent: [] });
  });

  it('um novo objeto (outra execução) lê o mesmo estado do disco', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) await t.throttle.recordAttempt();
    const again = createThrottle({ dataDir: t.dataDir, now: () => t.clock.now });
    expect(await again.check([])).toMatchObject({ reason: 'temporarily_locked' });
  });

  it('falhas espaçadas (mais de 15 min entre a 1ª e a 5ª) não bloqueiam pela janela', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i += 1) {
      await t.throttle.recordAttempt();
      t.clock.now += 4 * MIN;
    }
    expect(await t.throttle.check([])).toEqual({ allowed: true });
  });

  it('20 falhas seguidas → trava dura permanente', async () => {
    const t = await setup();
    for (let i = 0; i < HARD_LOCK_FAILURES; i += 1) {
      await t.throttle.recordAttempt();
      t.clock.now += 20 * MIN;
    }
    t.clock.now += 365 * 24 * 60 * MIN;
    expect(await t.throttle.check([])).toEqual({ allowed: false, reason: 'hard_locked' });
  });

  it('conferência cruzada: a auditoria sozinha bloqueia (vale o maior)', async () => {
    const t = await setup();
    const audit = [0, 1, 2, 3, 4].map((i) => t.clock.now - i * MIN);
    expect(await t.throttle.check(audit)).toMatchObject({ reason: 'temporarily_locked' });
    expect(await t.throttle.check(audit.slice(1))).toEqual({ allowed: true });
  });

  it('relógio voltou: registro (arquivo ou auditoria) no futuro → recusa', async () => {
    const t = await setup();
    await t.throttle.recordAttempt();
    t.clock.now -= 10 * MIN;
    expect(await t.throttle.check([])).toEqual({ allowed: false, reason: 'clock_moved_back' });
    const u = await setup();
    expect(await u.throttle.check([u.clock.now + 2 * MIN])).toEqual({ allowed: false, reason: 'clock_moved_back' });
  });

  it('arquivo link, ilegível ou com gravação não confirmada → recusa / lança', async () => {
    const t = await setup();
    const target = join(t.dataDir, 'outro.json');
    await writeFile(target, JSON.stringify({ format: 'acc-admin-release-throttle', version: 1, consecutive: 0, recent: [] }));
    try {
      await symlink(target, join(t.dataDir, THROTTLE_FILE));
      expect(await t.throttle.check([])).toEqual({ allowed: false, reason: 'throttle_unreadable' });
      await expect(t.throttle.recordAttempt()).rejects.toThrow();
    } catch (error) {
      // Sem privilégio para criar links (Windows): o caso de link não se aplica nesta máquina.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    const u = await setup();
    const silent = createThrottle({ dataDir: u.dataDir, now: () => u.clock.now, ops: { ...defaultJournalOps, write: async () => undefined } });
    await expect(silent.recordAttempt()).rejects.toThrow();
    await expect(silent.recordSuccess()).rejects.toThrow();
  });

  it('windowLock', () => {
    expect(windowLock([1, 2, 3, 4], 5)).toBeNull();
    expect(windowLock([1, 2, 3, 4, 5], 6)).toBe(5 + LOCK_MS);
    expect(windowLock([1, 2, 3, 4, 5], 5 + LOCK_MS)).toBeNull();
    expect(windowLock([0, WINDOW_MS + 1, WINDOW_MS + 2, WINDOW_MS + 3, WINDOW_MS + 4], WINDOW_MS + 5)).toBeNull();
  });
});
