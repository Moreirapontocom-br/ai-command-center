// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_LIMITS } from './adminAuth.ts';
import { createSessionStore } from './sessions.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD } from '../test/authFixtures.ts';

/** Política de sessão administrativa única (Issue #003, PR 2, rodada final). */
describe('sessão administrativa única', () => {
  it('padrão: no máximo 1 sessão', () => {
    expect(DEFAULT_AUTH_LIMITS.sessions.maxSessions).toBe(1);
  });

  it('login bem-sucedido revoga a sessão anterior, mesmo sem o cookie dela (outro navegador)', async () => {
    const auth = await createTestAuth();
    const first = await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'navegador-a' });
    const second = await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'navegador-b' });
    if (!first.ok || !second.ok) throw new Error('login esperado');
    expect(auth.authenticate(`${auth.cookieName}=${first.token}`)).toBeNull();
    expect(auth.authenticate(`${auth.cookieName}=${second.token}`)?.session.email).toBe(TEST_ADMIN_EMAIL);
  });

  it('login malsucedido não revoga a sessão ativa', async () => {
    const auth = await createTestAuth();
    const active = await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'a' });
    if (!active.ok) throw new Error('login esperado');
    await auth.login({ email: TEST_ADMIN_EMAIL, password: 'errada-123456', client: 'b' });
    await auth.login({ email: 'outro@example.test', password: TEST_ADMIN_PASSWORD, client: 'b' });
    expect(auth.authenticate(`${auth.cookieName}=${active.token}`)).not.toBeNull();
  });

  it('bloqueio por falhas (DoS do login) não derruba a sessão já ativa', async () => {
    const auth = await createTestAuth();
    const active = await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'admin' });
    if (!active.ok) throw new Error('login esperado');
    for (let i = 0; i < DEFAULT_AUTH_LIMITS.throttle.globalLimit; i += 1) {
      await auth.login({ email: TEST_ADMIN_EMAIL, password: `errada-${i}`, client: `atacante-${i}` });
    }
    // O limite global bloqueia novos logins de qualquer cliente…
    expect(await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'admin' })).toMatchObject({
      ok: false,
      reason: 'locked',
    });
    // …mas a sessão existente continua válida.
    expect(auth.authenticate(`${auth.cookieName}=${active.token}`)).not.toBeNull();
  });

  it('o limite do store também impõe uma sessão (defesa em profundidade)', () => {
    const store = createSessionStore({ idleTimeoutMs: 1000, absoluteTimeoutMs: 5000, maxSessions: 1, now: () => 0 });
    const a = store.create({ userId: 'admin', email: 'a@b.c', scope: [] });
    const b = store.create({ userId: 'admin', email: 'a@b.c', scope: [] });
    expect(store.size()).toBe(1);
    expect(store.touch(a.token)).toBeNull();
    expect(store.touch(b.token)).not.toBeNull();
    store.revokeAll();
    expect(store.touch(b.token)).toBeNull();
  });
});
