// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageError } from './errors.ts';
import { acquireLock } from './lock.ts';

/**
 * Bloqueio compartilhado (D7) com PROCESSOS REAIS (Condição B). Garantia testada: exclusão entre
 * processos da mesma máquina em disco local. Não há (nem se alega) garantia distribuída.
 */
const NAMES = { lock: 'queue.lock', takeover: 'queue.lock.takeover' };
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), 'acc-lock-'));
  roots.push(root);
  return root;
}
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof StorageError ? error.code : `unexpected:${(error as Error).message}`;
  }
};

/** Processo que tenta o bloqueio; `hold` segura até ser morto, `try` imprime o resultado e sai. */
function contender(dir: string, mode: 'hold' | 'try') {
  const lockModule = pathToFileURL(join(process.cwd(), 'server', 'storage', 'lock.ts')).href;
  const script = `
const m = await import(${JSON.stringify(lockModule)});
try {
  const lock = await m.acquireLock(${JSON.stringify(dir)}, ${JSON.stringify(NAMES)});
  process.stdout.write('locked ' + lock.recovered + '\\n');
  if (${JSON.stringify(mode)} === 'hold') setInterval(() => {}, 1000);
  else { await new Promise((r) => setTimeout(r, 300)); await lock.release(); process.exit(0); }
} catch (e) { process.stdout.write('refused ' + e.code + '\\n'); process.exit(0); }
`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const line = () =>
    new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        if (out.includes('\n')) {
          clearInterval(timer);
          resolve(out.trim());
        }
      }, 20);
      void exited.then(() => {
        clearInterval(timer);
        if (out.includes('\n')) resolve(out.trim());
        else reject(new Error('no output'));
      });
    });
  return { child, exited, line, output: () => out.trim() };
}

describe('bloqueio compartilhado — processos reais', () => {
  it('disputa simultânea entre 5 processos: no máximo um segura o bloqueio por vez', async () => {
    const dir = await tempDir();
    const contenders = [1, 2, 3, 4, 5].map(() => contender(dir, 'try'));
    await Promise.all(contenders.map((c) => c.exited));
    const outputs = contenders.map((c) => c.output());
    // Cada um segura por 300 ms; os que chegaram durante a posse de outro foram recusados.
    expect(outputs.filter((o) => o.startsWith('locked')).length).toBeGreaterThanOrEqual(1);
    for (const o of outputs) expect(o).toMatch(/^(locked false|refused store_locked)$/);
    expect(await readdir(dir)).toEqual([]);
  }, 60_000);

  it('processo vivo segura: este processo é recusado; morto (SIGKILL) → retomada única e registrada', async () => {
    const dir = await tempDir();
    const holder = contender(dir, 'hold');
    try {
      expect(await holder.line()).toBe('locked false');
      expect(await code(acquireLock(dir, NAMES))).toBe('store_locked');
      const other = contender(dir, 'try');
      expect(await other.line()).toBe('refused store_locked');
      await other.exited;
    } finally {
      holder.child.kill('SIGKILL');
      await holder.exited;
    }
    const lock = await acquireLock(dir, NAMES);
    expect(lock.recovered).toBe(true);
    const content = JSON.parse(await readFile(join(dir, NAMES.lock), 'utf8'));
    expect(content.pid).toBe(process.pid);
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  }, 60_000);

  it('bloqueio de OUTRA máquina nunca é retomado (sem garantia distribuída: fail-closed)', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, NAMES.lock), JSON.stringify({ pid: 999_999_999, host: 'outra-maquina', nonce: 'a'.repeat(32), at: 'x' }));
    expect(await code(acquireLock(dir, NAMES))).toBe('store_locked');
    expect(await readdir(dir)).toEqual([NAMES.lock]);
  });

  it('mesmo processo: segunda aquisição recusada; liberação só remove o próprio bloqueio', async () => {
    const dir = await tempDir();
    const first = await acquireLock(dir, NAMES);
    expect(await code(acquireLock(dir, NAMES))).toBe('store_locked');
    await first.release();
    await first.release(); // idempotente
    expect(await readdir(dir)).toEqual([]);
  });
});
