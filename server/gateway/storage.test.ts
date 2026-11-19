// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSealedBlobStore } from '../storage/sealedBlobs.ts';
import { deriveSubkey } from '../storage/subkeys.ts';
import { createGatewayStack, PROJECT, PROJECT_B, type GatewayStack } from '../test/gatewayFixtures.ts';
import { GATEWAY_CONTENT_KEY_DOMAIN, openGatewayStore } from './store.ts';
import { checkGatewayChange } from './documents.ts';

/** P3 e D7 — conteúdos cifrados com referência no ledger assinado; integridade e recuperação. */

let g: GatewayStack | null = null;
const roots: string[] = [];
afterEach(async () => {
  await g?.close();
  g = null;
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

async function storedOutput(g: GatewayStack) {
  const scope = await g.activeScope();
  const inv = await g.gateway.invoke('admin', g.taskBody(scope.id));
  await g.cycle();
  return g.gateway.result('admin', PROJECT, inv.id)!.output!;
}

describe('conteúdos cifrados (P3)', () => {
  it('cifra em repouso com AES-GCM; arquivo adulterado, trocado de id ou de contexto → content_corrupted', async () => {
    g = await createGatewayStack();
    const out = await storedOutput(g);
    const file = join(g.dirs.content, `${out.contentId}.blob.json`);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(doc).sort()).toEqual(['data', 'format', 'iv', 'keyId', 'tag', 'version']);
    const flipped = Buffer.from(doc.data, 'base64');
    flipped[0] ^= 0xff;
    await writeFile(file, JSON.stringify({ ...doc, data: flipped.toString('base64') }));
    expect(await codeOf(g.gateway.readContent('admin', PROJECT, out.contentId))).toBe('content_corrupted');
    // Outro conteúdo copiado para este id não decifra (AAD presa ao id e ao contexto).
    const pkg = g.store.body().contents.find((c) => c.kind === 'package')!;
    await writeFile(file, await readFile(join(g.dirs.content, `${pkg.id}.blob.json`)));
    expect(await codeOf(g.gateway.readContent('admin', PROJECT, out.contentId))).toBe('content_corrupted');
    await rm(file);
    expect(await codeOf(g.gateway.readContent('admin', PROJECT, out.contentId))).toBe('content_missing');
  });

  it('retenção conservadora: vencido não é lido e a varredura exclui; órfãos são removidos; exclusão exige confirmação', async () => {
    g = await createGatewayStack();
    const out = await storedOutput(g);
    const orphan = randomUUID();
    await writeFile(join(g.dirs.content, `${orphan}.blob.json`), '{}');
    expect(await codeOf(g.gateway.deleteContent('admin', PROJECT, out.contentId, { proofId: 'x', identity: { userId: 'admin', sessionKey: 'y' } }))).toBe('identity_not_confirmed');
    g.s.advance(31 * 24 * 60 * 60 * 1000);
    expect(await codeOf(g.gateway.readContent('admin', PROJECT, out.contentId))).toBe('content_expired');
    const swept = await g.gateway.sweep();
    expect(swept.deletedContents).toBeGreaterThanOrEqual(2);
    expect((await readdir(g.dirs.content)).some((n) => n.startsWith(orphan))).toBe(false);
    expect(g.store.body().contents.every((c) => c.state === 'deleted' && c.deletedReason === 'retention_elapsed')).toBe(true);
    expect(await codeOf(g.gateway.readContent('admin', PROJECT, out.contentId))).toBe('content_deleted');
  });

  it('exclusão controlada pelo dono, com confirmação; outro projeto não exclui', async () => {
    g = await createGatewayStack();
    const out = await storedOutput(g);
    expect(await codeOf(g.gateway.deleteContent('admin', PROJECT_B, out.contentId, await g.confirm()))).toBe('not_found');
    await g.gateway.deleteContent('admin', PROJECT, out.contentId, await g.confirm());
    expect(await codeOf(g.gateway.readContent('admin', PROJECT, out.contentId))).toBe('content_deleted');
    expect(g.gateway.history().some((e) => e.event === 'gateway.content_deleted' && e.reason === 'deleted_by_owner' && e.actor.kind === 'human')).toBe(true);
  });

  it('nada de conteúdo, instrução ou segredo no ledger e no histórico (só ids, tokens e resumos)', async () => {
    g = await createGatewayStack();
    await storedOutput(g);
    const ledger = (await readdir(g.dirs.gateway)).filter((n) => n.endsWith('.json'));
    for (const name of ledger) {
      const text = await readFile(join(g.dirs.gateway, name), 'utf8');
      expect(text).not.toContain('Descrição da tarefa A');
      expect(text).not.toContain('Revise a tarefa.');
      expect(text).not.toContain('simulado):');
    }
  });

  it('chave de conteúdo errada não decifra; diretórios precisam ser separados', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acc-blob-'));
    roots.push(root);
    const a = await openSealedBlobStore({ dir: join(root, 'blobs'), environment: { env: {} }, loadKey: () => deriveSubkey(randomBytes(32), GATEWAY_CONTENT_KEY_DOMAIN) });
    const id = randomUUID();
    await a.put(id, 'ctx', Buffer.from('segredo de teste'));
    const b = await openSealedBlobStore({ dir: join(root, 'blobs'), environment: { env: {} }, loadKey: () => deriveSubkey(randomBytes(32), GATEWAY_CONTENT_KEY_DOMAIN) });
    expect(await codeOf(b.get(id, 'ctx'))).toBe('blob_corrupted');
    expect(await codeOf(a.get(id, 'outro-ctx'))).toBe('blob_corrupted');
    expect((await a.get(id, 'ctx')).toString()).toBe('segredo de teste');
    expect(await codeOf(openSealedBlobStore({ dir: join(root, 'blobs', 'x'), environment: { env: {} }, loadKey: () => deriveSubkey(randomBytes(32), GATEWAY_CONTENT_KEY_DOMAIN), separateFrom: [join(root, 'blobs')] }))).toBe('paths_not_separate');
    expect(await codeOf(a.put('nao-uuid', 'ctx', Buffer.from('x')))).toBe('blob_id_invalid');
  });
});

describe('ledger assinado do gateway (D7)', () => {
  it('adulteração do ledger → indisponível na reabertura (nada é reescrito)', async () => {
    g = await createGatewayStack();
    await g.activeScope();
    await g.store.close();
    const file = join(g.dirs.gateway, 'gateway-ledger.json');
    const doc = JSON.parse(await readFile(file, 'utf8'));
    doc.body.scopes[0].maxInvocations = 50;
    await writeFile(file, JSON.stringify(doc));
    // MESMA chave: a recusa vem do MAC/anchor, não de uma chave diferente.
    const reopened = await openGatewayStore({ gatewayDir: g.dirs.gateway, anchorDir: g.dirs.anchor, environment: { env: {} }, loadKey: () => g!.keys.mac }).catch((e) => e);
    const status = 'status' in reopened ? reopened.status() : { state: 'unavailable', reason: (reopened as { code?: string }).code };
    expect(status.state).toBe('unavailable');
    expect(status.reason).toMatch(/mac|anchor|invalid/);
    if ('close' in reopened) await reopened.close();
  });

  it('regras entre versões: vínculo imutável, transição inválida e contador que diminui são recusados', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope();
    expect(await codeOf(g.store.commit((tx) => void (tx.body.scopes[0].maxInvocations = 50)))).toBe('change_rejected');
    expect(await codeOf(g.store.commit((tx) => void (tx.body.scopes[0].state = 'awaiting_approval')))).toBe('change_rejected');
    expect(await codeOf(g.store.commit((tx) => void tx.body.scopes.splice(0, 1)))).toBe('change_rejected');
    await g.gateway.invoke('admin', g.taskBody(scope.id));
    expect(await codeOf(g.store.commit((tx) => void (tx.body.scopes[0].usedInvocations = 0)))).toBe('change_rejected');
    expect(await codeOf(g.store.commit((tx) => void (tx.body.scopes[0].validUntil = new Date(g!.s.h.clock.now + 9e7).toISOString())))).toBe('change_rejected');
    // Leituras congeladas (R1 da #012).
    expect(() => {
      (g!.store.body().scopes[0] as { state: string }).state = 'revoked';
    }).toThrow(TypeError);
    expect(() => checkGatewayChange({ scopes: [], invocations: [], handoffs: [], contents: [] }, { scopes: [], invocations: [], handoffs: [], contents: [] })).not.toThrow();
  });

  it('falha de gravação durante a invocação: nada fica pela metade e o pacote não vira órfão referenciado', async () => {
    g = await createGatewayStack();
    const scope = await g.activeScope();
    const real = g.store.commit.bind(g.store);
    let fail = true;
    (g.store as { commit: typeof real }).commit = ((change: Parameters<typeof real>[0]) => {
      if (fail) {
        fail = false;
        return Promise.reject(Object.assign(new Error('x'), { code: 'store_write_failed' }));
      }
      return real(change);
    }) as typeof real;
    expect(await codeOf(g.gateway.invoke('admin', g.taskBody(scope.id)))).toBe('store_write_failed');
    expect(g.store.body().invocations).toHaveLength(0);
    expect(g.store.body().scopes[0].usedInvocations).toBe(0);
    expect(await readdir(g.dirs.content)).toHaveLength(0);
  });
});
