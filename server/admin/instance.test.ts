// @vitest-environment node
/**
 * Issue #008, P1 — lock de instância (matriz F, itens 11, 12 e 22), inclusive com o SERVIDOR real
 * iniciado como processo filho (sem rede externa, sem GitHub, sem credenciais; porta de loopback).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, adminReleasePending, INSTANCE_LOCK_FILES, InstanceLockError } from './instance.ts';
import { JOURNAL_FILE } from './journal.ts';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 50));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
const dir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'acc-instance-'));
  roots.push(d);
  return d;
};

describe('lock de instância (unidade)', () => {
  it('exclusivo no mesmo processo; liberação só do próprio nonce; reaquisição depois', async () => {
    const d = await dir();
    const lock = await acquireInstanceLock(d);
    await expect(acquireInstanceLock(d)).rejects.toMatchObject({ code: 'store_locked' });
    await lock.release();
    const again = await acquireInstanceLock(d);
    // A liberação antiga (já usada) não remove o lock novo.
    await lock.release();
    await expect(acquireInstanceLock(d)).rejects.toBeInstanceOf(InstanceLockError);
    await again.release();
  });

  it('lock de processo morto é retomado; de processo vivo nunca é removido', async () => {
    const d = await dir();
    const content = JSON.stringify({ pid: process.pid + 100_000, host: hostname(), nonce: randomBytes(16).toString('hex'), at: new Date().toISOString() });
    await writeFile(join(d, INSTANCE_LOCK_FILES.lock), content);
    await expect(acquireInstanceLock(d, { alive: () => true })).rejects.toMatchObject({ code: 'store_locked' });
    expect(await readFile(join(d, INSTANCE_LOCK_FILES.lock), 'utf8')).toBe(content);
    const lock = await acquireInstanceLock(d, { alive: () => false });
    expect(lock.recovered).toBe(true);
    await lock.release();
  });

  it('arquivo de retomada abandonado → lock_recovery_stale (intervenção humana)', async () => {
    const d = await dir();
    const host = hostname();
    const stale = (pid: number) => JSON.stringify({ pid, host, nonce: randomBytes(16).toString('hex'), at: new Date().toISOString() });
    await writeFile(join(d, INSTANCE_LOCK_FILES.lock), stale(process.pid + 100_000));
    await writeFile(join(d, INSTANCE_LOCK_FILES.takeover), stale(process.pid + 100_001));
    await expect(acquireInstanceLock(d, { alive: () => false })).rejects.toMatchObject({ code: 'lock_recovery_stale' });
  });

  it('cria o diretório de dados se faltar (sem abrir nenhum arquivo de dados)', async () => {
    const d = join(await dir(), 'novo', 'data');
    const lock = await acquireInstanceLock(d);
    await lock.release();
  });
});

const freePort = () =>
  new Promise<number>((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => done(port));
    });
  });

/** Sobe o servidor real num diretório temporário (sem `.env.local`, sem credenciais). */
async function startServer(dataDir: string, extra: Record<string, string> = {}) {
  const cwd = await dir();
  const port = await freePort();
  const env: Record<string, string> = { ACC_DEPLOYMENT: 'local', ACC_DATA_DIR: dataDir, API_PORT: String(port), ...extra };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name]!;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', resolve('server/index.ts')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (c) => (output += c));
  child.stderr!.on('data', (c) => (output += c));
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const started = new Promise<boolean>((r) => {
    const timer = setInterval(() => {
      if (output.includes('Servidor iniciado')) {
        clearInterval(timer);
        r(true);
      }
    }, 25);
    void exited.then(() => {
      clearInterval(timer);
      r(false);
    });
  });
  return { child, started, exited, output: () => output };
}

describe('F22 — ciclo de vida do servidor com o lock de instância', { timeout: 60_000 }, () => {
  it('o servidor obtém o lock antes de abrir os dados e recusa subir com outra instância ativa', async () => {
    const data = await dir();
    const held = await acquireInstanceLock(data);
    const blocked = await startServer(data);
    expect(await blocked.exited).toBe(1);
    expect(blocked.output()).toContain('instance_locked');
    // Nenhum arquivo de dados foi criado/aberto.
    await expect(readFile(join(data, 'projects.json'))).rejects.toThrow();
    await held.release();

    const server = await startServer(data);
    expect(await server.started).toBe(true);
    const lock = JSON.parse(await readFile(join(data, INSTANCE_LOCK_FILES.lock), 'utf8')) as { pid: number };
    expect(lock.pid).toBe(server.child.pid);
    // Com o servidor ativo, o comando (mesmo lock) não roda.
    await expect(acquireInstanceLock(data)).rejects.toMatchObject({ code: 'store_locked' });

    if (process.platform !== 'win32') {
      // Encerramento normal: libera o lock depois de fechar os armazenamentos.
      server.child.kill('SIGTERM');
      expect(await server.exited).toBe(0);
      await expect(readFile(join(data, INSTANCE_LOCK_FILES.lock))).rejects.toThrow();
    } else {
      // Windows: kill é forçado (TerminateProcess) e não executa o tratamento de sinais.
      server.child.kill('SIGKILL');
      await server.exited;
    }
  });

  it('queda forçada deixa um lock órfão retomável de forma determinística', async () => {
    const data = await dir();
    const first = await startServer(data);
    expect(await first.started).toBe(true);
    first.child.kill('SIGKILL');
    await first.exited;
    expect(await readFile(join(data, INSTANCE_LOCK_FILES.lock), 'utf8')).toContain(String(first.child.pid));
    const second = await startServer(data);
    expect(await second.started).toBe(true);
    second.child.kill('SIGKILL');
    await second.exited;
  });

  it('diário pendente → o servidor sobe com as aprovações indisponíveis (admin_reconcile_pending)', async () => {
    const root = await dir();
    const data = join(root, 'data');
    await mkdir(data, { recursive: true });
    await writeFile(join(data, JOURNAL_FILE), '{}');
    expect(await adminReleasePending(data)).toBe(true);
    const server = await startServer(data, {
      ACC_APPROVALS_DIR: join(root, 'ledger'),
      ACC_APPROVALS_ANCHOR_DIR: join(root, 'anchor'),
      ACC_APPROVAL_KEY: randomBytes(32).toString('hex'),
      ACC_APPROVALS_INITIALIZE: 'if_absent',
    });
    expect(await server.started).toBe(true);
    expect(server.output()).toContain('admin_reconcile_pending');
    // O armazenamento nem foi aberto (nenhuma época nova, nenhuma instalação criada).
    await expect(readFile(join(root, 'ledger', 'approvals-ledger.json'))).rejects.toThrow();
    server.child.kill('SIGKILL');
    await server.exited;
  });
});
