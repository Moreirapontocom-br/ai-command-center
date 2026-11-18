// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, namespacedMacHex, without } from './canonical.ts';
import { StorageError } from './errors.ts';
import { deriveSubkey } from './subkeys.ts';
import { openSignedLedger, type SignedLedger, type SignedLedgerSpec } from './signedLedger.ts';

/** Motor genérico (D2) com um conteúdo mínimo: contador + eventos-token. */
interface Body {
  count: number;
}
const spec: SignedLedgerSpec<Body, string> = {
  namespace: 'acc-test:v1',
  format: 'acc-test',
  filePrefix: 'test',
  emptyBody: () => ({ count: 0 }),
  checkBody(raw) {
    const b = raw as Body;
    if (typeof raw !== 'object' || raw === null || Object.keys(raw).length !== 1 || !Number.isSafeInteger(b.count) || b.count < 0) throw new Error('corpo');
    return { count: b.count };
  },
  checkEntry(raw) {
    if (typeof raw !== 'string' || !/^[a-z_]{1,32}$/.test(raw)) throw new Error('entrada');
    return raw;
  },
  checkChange(before, after) {
    if (after.count < before.count) throw new Error('regrediu');
  },
  onEpoch: (tx) => tx.append('opened'),
  onLineage: (tx, cause) => tx.append(cause),
};

const roots: string[] = [];
const ledgers: SignedLedger<Body, string>[] = [];
afterEach(async () => {
  for (const l of ledgers.splice(0)) await l.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'acc-ledger-'));
  roots.push(root);
  const key = deriveSubkey(randomBytes(32), 'acc:test:mac:v1');
  const open = async (extra: Partial<Parameters<typeof openSignedLedger<Body, string>>[0]> = {}) => {
    const ledger = await openSignedLedger<Body, string>({ spec, dataDir: join(root, 'data'), anchorDir: join(root, 'anchor'), environment: { env: {} }, loadKey: () => key, ...extra });
    ledgers.push(ledger);
    return ledger;
  };
  return { root, open, key };
}
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof StorageError ? error.code : `unexpected:${(error as Error).message}`;
  }
};

describe('motor de ledger assinado', () => {
  it('alteração recusada (checkChange/checkBody/entrada) não grava nem degrada', async () => {
    const t = await setup();
    const l = await t.open({ initialize: 'if_absent' });
    await l.commit((tx) => {
      tx.body.count = 5;
      tx.append('set');
    });
    const before = await readFile(join(t.root, 'data', 'test-ledger.json'), 'utf8');
    expect(await code(l.commit((tx) => void (tx.body.count = 1)))).toBe('change_rejected');
    expect(await code(l.commit((tx) => void ((tx.body as unknown as Record<string, unknown>).extra = 1)))).toBe('change_invalid');
    expect(await code(l.commit((tx) => tx.append('INVÁLIDO')))).toBe('change_invalid');
    expect(await code(l.commit(() => { throw new Error('regra'); }))).toBe('unexpected:regra');
    expect(l.status()).toEqual({ state: 'available', reason: null });
    expect(await readFile(join(t.root, 'data', 'test-ledger.json'), 'utf8')).toBe(before);
    // Sem mudança nenhuma: nada é gravado (geração não avança).
    expect(await l.commit(() => 42)).toBe(42);
    expect(await readFile(join(t.root, 'data', 'test-ledger.json'), 'utf8')).toBe(before);
  });

  it('limite de tamanho: recusa antes de gravar, sem degradar', async () => {
    const t = await setup();
    const l = await t.open({ initialize: 'if_absent', maxHistoryBytes: 1200 });
    let result = 'resolved';
    for (let i = 0; i < 20 && result === 'resolved'; i += 1) result = await code(l.commit((tx) => tx.append('grow')));
    expect(result).toBe('history_full');
    expect(l.status().state).toBe('available');
  });

  it('documento com campo extra ou formato de outro núcleo → document_invalid; MAC de outro namespace → mac_invalid', async () => {
    const t = await setup();
    await (await t.open({ initialize: 'if_absent' })).close();
    ledgers.splice(0);
    const path = join(t.root, 'data', 'test-ledger.json');
    const doc = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, canonicalJson({ ...doc, extra: true }));
    const a = await t.open();
    expect(a.status().reason).toBe('document_invalid');
    await a.close();
    await writeFile(path, canonicalJson({ ...doc, format: 'acc-approvals-ledger' }));
    const b = await t.open();
    expect(b.status().reason).toBe('document_invalid');
    await b.close();
    // Mesmo conteúdo, MAC recalculado com a chave certa mas OUTRO namespace → não valida.
    await writeFile(path, canonicalJson({ ...doc, mac: namespacedMacHex(t.key.key, 'acc-other:v1', 'ledger', without(doc, 'mac')) }));
    const c = await t.open();
    expect(c.status().reason).toBe('mac_invalid');
    await c.close();
    await writeFile(path, canonicalJson(doc));
    const ok = await t.open();
    expect(ok.status().state).toBe('available');
  });

  it('especificação inválida é recusada', async () => {
    const t = await setup();
    await expect(openSignedLedger({ spec: { ...spec, filePrefix: '../x' }, dataDir: join(t.root, 'd'), anchorDir: join(t.root, 'a'), environment: { env: {} }, loadKey: () => deriveSubkey(randomBytes(32), 'acc:test:mac:v1') })).rejects.toThrow('spec_invalid');
  });

  it('chave ausente ou curta → indisponível (key_unavailable/key_invalid), sem criar documentos', async () => {
    const t = await setup();
    const a = await t.open({ initialize: 'if_absent', loadKey: () => Promise.reject(new Error('sem chave')) });
    expect(a.status()).toEqual({ state: 'unavailable', reason: 'key_unavailable' });
    await a.close();
    const b = await t.open({ initialize: 'if_absent', loadKey: () => ({ keyId: '0123456789abcdef', key: Buffer.alloc(8) }) });
    expect(b.status()).toEqual({ state: 'unavailable', reason: 'key_invalid' });
    expect(await code(b.recover({ actorId: 'admin', reason: 'integrity_failure' }))).toBe('recovery_refused_key_invalid');
  });
});
