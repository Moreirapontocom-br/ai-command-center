// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as approvalCanonical from '../approvals/canonical.ts';
import { ApprovalError } from '../approvals/contracts.ts';
import { keyIdOf } from '../approvals/keyProvider.ts';
import * as approvalLock from '../approvals/lock.ts';
import * as approvalPaths from '../approvals/paths.ts';
import { canonicalJson, namespacedMacHex } from './canonical.ts';
import { StorageError } from './errors.ts';
import { acquireLock, type LockFileOps } from './lock.ts';
import { checkRegularFile, secureDirectory } from './paths.ts';

/**
 * Compatibilidade com a Issue #011 (Condição C): a extração de `canonical`, `paths` e `lock` para
 * `server/storage/` não muda bytes, MACs, nomes de arquivo, códigos nem classes de erro.
 *
 * Os vetores abaixo foram calculados com o código ANTERIOR à extração (main a65b238) e fixados aqui.
 */
const GOLDEN = {
  value: { b: [1, 'x', null, true], a: { z: 1.5, y: 'ç' } },
  canonical: '{"a":{"y":"ç","z":1.5},"b":[1,"x",null,true]}',
  sha256: '8013a0f80aba8aabc823f55fb40110b088d9220540218ee196b375abcf27315f',
  macLedger: 'b16a5729961e6ff3b254e47ae6d16345f70d7e053028eb2dfc6ab43e5f0461c7',
  keyId: 'c44cbba58bf27257',
};
const KEY = Buffer.alloc(32, 7);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function tempDir() {
  const root = await mkdtemp(join(tmpdir(), 'acc-compat-'));
  roots.push(root);
  return root;
}
const errorOf = async (fn: () => unknown) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};
const stale = (nonce = 'a'.repeat(32)) => JSON.stringify({ pid: 999_999_999, host: hostname(), nonce, at: new Date().toISOString() });

describe('canonical/MAC (U4): mesmos bytes da #011', () => {
  it('vetores fixos: JSON canônico, SHA-256, MAC do ledger e keyId', () => {
    expect(approvalCanonical.canonicalJson(GOLDEN.value)).toBe(GOLDEN.canonical);
    expect(canonicalJson(GOLDEN.value)).toBe(GOLDEN.canonical);
    expect(approvalCanonical.sha256Hex(GOLDEN.canonical)).toBe(GOLDEN.sha256);
    expect(approvalCanonical.macHex(KEY, 'ledger', GOLDEN.value)).toBe(GOLDEN.macLedger);
    expect(namespacedMacHex(KEY, 'acc-approvals:v1', 'ledger', GOLDEN.value)).toBe(GOLDEN.macLedger);
    expect(keyIdOf(KEY)).toBe(GOLDEN.keyId);
  });

  it('erros: aprovações recebem ApprovalError; o módulo compartilhado, StorageError — mesmos códigos', async () => {
    for (const [value, code] of [
      [Number.NaN, 'canonical_invalid_number'],
      [new Date(0), 'canonical_invalid_object'],
      [{ a: undefined }, 'canonical_undefined'],
      [() => 1, 'canonical_invalid_type'],
    ] as const) {
      const a = await errorOf(() => approvalCanonical.canonicalJson(value));
      expect(a).toBeInstanceOf(ApprovalError);
      expect((a as ApprovalError).code).toBe(code);
      const s = await errorOf(() => canonicalJson(value));
      expect(s).toBeInstanceOf(StorageError);
      expect((s as StorageError).code).toBe(code);
    }
  });
});

describe('paths (U4): mesmas regras e códigos', () => {
  it('ApprovalError com os códigos de antes (pelo shim) e StorageError (direto)', async () => {
    const root = await tempDir();
    const env = { env: {} };
    for (const [fn, code] of [
      [() => approvalPaths.secureDirectory('relativo', env), 'path_not_absolute'],
      [() => approvalPaths.assertSeparate(join(root, 'a'), join(root, 'a', 'b')), 'paths_not_separate'],
    ] as const) {
      const error = await errorOf(fn);
      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).code).toBe(code);
    }
    await mkdir(join(root, 'repo', '.git'), { recursive: true });
    const git = await errorOf(() => approvalPaths.secureDirectory(join(root, 'repo', 'x'), env));
    expect((git as ApprovalError).code).toBe('path_in_git_repository');
    expect(await readdir(join(root, 'repo'))).toEqual(['.git']); // recusado ANTES de criar
    const synced = await errorOf(() => approvalPaths.secureDirectory(join(root, 'OneDrive', 'x'), env));
    expect((synced as ApprovalError).code).toBe('path_in_synced_folder');
    const shared = await errorOf(() => secureDirectory('relativo', env));
    expect(shared).toBeInstanceOf(StorageError);
    expect((shared as StorageError).code).toBe('path_not_absolute');
    // Arquivos: inexistente → false; link → file_is_link (quando o sistema permite criar links).
    expect(await approvalPaths.checkRegularFile(join(root, 'nada'))).toBe(false);
    await writeFile(join(root, 'f'), 'x');
    expect(await checkRegularFile(join(root, 'f'))).toBe(true);
    let linked = false;
    try {
      await symlink(join(root, 'f'), join(root, 'l'));
      linked = true;
    } catch {
      // Sem permissão para criar links (Windows sem modo desenvolvedor): coberto pela suíte da #011.
    }
    if (linked) expect(((await errorOf(() => approvalPaths.checkRegularFile(join(root, 'l')))) as ApprovalError).code).toBe('file_is_link');
  });
});

describe('lock (D7): mesmos nomes, códigos e semântica', () => {
  it('shim mantém nomes de arquivo e API pública da #011', async () => {
    expect(approvalLock.LOCK_FILE).toBe('approvals.lock');
    expect(approvalLock.TAKEOVER_FILE).toBe('approvals.lock.takeover');
    expect(Object.keys(approvalLock).sort()).toEqual(['LOCK_FILE', 'TAKEOVER_FILE', 'acquireStoreLock', 'processAlive']);
    const dir = await tempDir();
    const lock = await approvalLock.acquireStoreLock(dir);
    expect(await readdir(dir)).toEqual(['approvals.lock']);
    const second = await errorOf(() => approvalLock.acquireStoreLock(dir));
    expect(second).toBeInstanceOf(ApprovalError);
    expect((second as ApprovalError).code).toBe('store_locked');
    await lock.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it('retomada: store_locked dentro da exclusão continua store_locked (não vira lock_recovery_failed)', async () => {
    // Bloqueio abandonado; no meio da retomada, outra instância cria o bloqueio novo primeiro.
    for (const variant of ['approvals', 'storage'] as const) {
      const dir = await tempDir();
      const lockName = variant === 'approvals' ? 'approvals.lock' : 'queue.lock';
      await writeFile(join(dir, lockName), stale());
      const real = await import('node:fs/promises');
      const ops: LockFileOps = {
        async create(path, content) {
          try {
            const handle = await real.open(path, 'wx', 0o600);
            await handle.writeFile(content, 'utf8');
            await handle.close();
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
            throw error;
          }
        },
        read: (path) => real.readFile(path, 'utf8'),
        async remove(path) {
          await real.rm(path);
          // Corrida: logo depois de remover o abandonado, outro processo cria o bloqueio.
          if (path.endsWith(lockName)) await real.writeFile(path, JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'b'.repeat(32), at: 'x' }));
        },
        isRegularFile: async () => true,
      };
      const error =
        variant === 'approvals'
          ? await errorOf(() => approvalLock.acquireStoreLock(dir, { ops }))
          : await errorOf(() => acquireLock(dir, { lock: 'queue.lock', takeover: 'queue.lock.takeover' }, { ops }));
      expect(error).toBeInstanceOf(variant === 'approvals' ? ApprovalError : StorageError);
      expect((error as { code: string }).code).toBe('store_locked');
      expect((await readdir(dir)).includes(`${lockName}.takeover`)).toBe(false);
    }
  });

  it('falha inesperada na retomada → lock_recovery_failed (ambas as classes)', async () => {
    for (const variant of ['approvals', 'storage'] as const) {
      const dir = await tempDir();
      const lockName = variant === 'approvals' ? 'approvals.lock' : 'queue.lock';
      await writeFile(join(dir, lockName), stale());
      const real = await import('node:fs/promises');
      const ops: LockFileOps = {
        create: async (path, content) => {
          try {
            await real.writeFile(path, content, { flag: 'wx' });
            return true;
          } catch {
            return false;
          }
        },
        read: (path) => real.readFile(path, 'utf8'),
        remove: async (path) => {
          if (path.endsWith(lockName)) throw new Error('EBUSY');
          await real.rm(path);
        },
        isRegularFile: async () => true,
      };
      const error =
        variant === 'approvals'
          ? await errorOf(() => approvalLock.acquireStoreLock(dir, { ops }))
          : await errorOf(() => acquireLock(dir, { lock: 'queue.lock', takeover: 'queue.lock.takeover' }, { ops }));
      expect((error as { code: string }).code).toBe('lock_recovery_failed');
      expect(error).toBeInstanceOf(variant === 'approvals' ? ApprovalError : StorageError);
    }
  });

  it('bloqueios de armazenamentos diferentes no mesmo diretório não interferem (nomes distintos)', async () => {
    const dir = await tempDir();
    const approvals = await approvalLock.acquireStoreLock(dir);
    const queue = await acquireLock(dir, { lock: 'queue.lock', takeover: 'queue.lock.takeover' });
    expect((await readdir(dir)).sort()).toEqual(['approvals.lock', 'queue.lock']);
    await queue.release();
    await approvals.release();
    expect(await readdir(dir)).toEqual([]);
  });
});
