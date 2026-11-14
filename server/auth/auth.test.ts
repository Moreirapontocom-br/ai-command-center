// @vitest-environment node
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_LIMITS, normalizeEmail, readCookie } from './adminAuth.ts';
import { createLoginThrottle } from './loginThrottle.ts';
import { DEFAULT_SCRYPT_PARAMS, hashPassword, parsePasswordHash, PasswordHashFormatError, verifyPassword } from './password.ts';
import { createSessionStore } from './sessions.ts';
import { createTestAuth, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, TEST_SCRYPT } from '../test/authFixtures.ts';

describe('hash de senha (scrypt)', () => {
  it('gera hash com salt aleatório, verifica a senha correta e recusa as demais', async () => {
    const a = await hashPassword('uma senha longa e boa', TEST_SCRYPT);
    const b = await hashPassword('uma senha longa e boa', TEST_SCRYPT);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt:1024:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('uma senha');
    const parsed = parsePasswordHash(a);
    expect(await verifyPassword('uma senha longa e boa', parsed)).toBe(true);
    expect(await verifyPassword('uma senha longa e boA', parsed)).toBe(false);
    expect(await verifyPassword('', parsed)).toBe(false);
    expect(await verifyPassword('x'.repeat(10_000), parsed)).toBe(false);
  });

  it('o padrão segue a recomendação da OWASP (N=2^17, r=8, p=1)', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
  });

  it.each([
    'texto-puro',
    'scrypt:1000:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'scrypt:1024:8:1:curto:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '$scrypt$ln=17,r=8,p=1$abc$def',
  ])('recusa hash malformado sem repetir o valor (%#)', (value) => {
    expect(() => parsePasswordHash(value)).toThrow(PasswordHashFormatError);
    try {
      parsePasswordHash(value);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
});

describe('sessões no servidor', () => {
  const limits = { idleTimeoutMs: 1000, absoluteTimeoutMs: 5000, maxSessions: 3 };

  it('token aleatório de 256 bits; o mapa não guarda o valor do cookie', () => {
    const store = createSessionStore({ ...limits, now: () => 0 });
    const { token } = store.create({ email: 'a@b.c', scope: ['x/y'] });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.touch(token)?.email).toBe('a@b.c');
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(store.touch(tampered)).toBeNull();
    expect(store.touch('invalido')).toBeNull();
  });

  it('expira por inatividade e por tempo absoluto', () => {
    let now = 0;
    const store = createSessionStore({ ...limits, now: () => now });
    const { token } = store.create({ email: 'a@b.c', scope: [] });
    now = 900;
    expect(store.touch(token)).not.toBeNull(); // renova a inatividade
    now = 1800;
    expect(store.touch(token)).not.toBeNull();
    now = 2900;
    expect(store.touch(token)).toBeNull(); // 1100 ms sem uso
    const second = store.create({ email: 'a@b.c', scope: [] });
    for (now = 3000; now < 7900; now += 900) expect(store.touch(second.token)).not.toBeNull();
    now = 8000; // 5000 ms desde a criação, mesmo com uso contínuo
    expect(store.touch(second.token)).toBeNull();
  });

  it('revogação e limite de sessões simultâneas', () => {
    const store = createSessionStore({ ...limits, now: () => 0 });
    const tokens = [1, 2, 3, 4].map(() => store.create({ email: 'a@b.c', scope: [] }).token);
    expect(store.size()).toBe(3);
    expect(store.touch(tokens[0])).toBeNull(); // a mais antiga foi descartada
    store.revoke(tokens[3]);
    expect(store.touch(tokens[3])).toBeNull();
    expect(store.touch(tokens[2])).not.toBeNull();
  });
});

describe('limitação de tentativas de login', () => {
  it('bloqueia o cliente após o limite e libera depois do tempo de bloqueio', () => {
    let now = 0;
    const throttle = createLoginThrottle({ windowMs: 1000, lockMs: 5000, perClientLimit: 3, globalLimit: 100, now: () => now });
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.check('a').allowed).toBe(true);
      throttle.recordFailure('a');
    }
    expect(throttle.check('a')).toEqual({ allowed: false, retryAfterSeconds: 5 });
    expect(throttle.check('b').allowed).toBe(true);
    now = 5000;
    expect(throttle.check('a').allowed).toBe(true);
  });

  it('falhas fora da janela não acumulam; sucesso zera o cliente', () => {
    let now = 0;
    const throttle = createLoginThrottle({ windowMs: 1000, lockMs: 5000, perClientLimit: 3, globalLimit: 100, now: () => now });
    throttle.recordFailure('a');
    throttle.recordFailure('a');
    now = 1500;
    throttle.recordFailure('a');
    expect(throttle.check('a').allowed).toBe(true);
    throttle.recordSuccess('a');
    throttle.recordFailure('a');
    throttle.recordFailure('a');
    expect(throttle.check('a').allowed).toBe(true);
  });

  it('limite global protege a conta única contra tentativas distribuídas', () => {
    const throttle = createLoginThrottle({ windowMs: 1000, lockMs: 5000, perClientLimit: 3, globalLimit: 4, now: () => 0 });
    for (const client of ['a', 'b', 'c', 'd']) throttle.recordFailure(client);
    expect(throttle.check('e').allowed).toBe(false);
  });

  it('limites padrão: 5 por cliente e 20 no total a cada 15 min, bloqueio de 15 min', () => {
    expect(DEFAULT_AUTH_LIMITS.throttle).toEqual({ windowMs: 900_000, lockMs: 900_000, perClientLimit: 5, globalLimit: 20 });
    expect(DEFAULT_AUTH_LIMITS.sessions).toMatchObject({ idleTimeoutMs: 1_800_000, absoluteTimeoutMs: 28_800_000 });
  });
});

describe('serviço de autenticação do administrador', () => {
  it('e-mail sem diferenciar maiúsculas; e-mail desconhecido e senha errada têm a mesma resposta', async () => {
    const auth = await createTestAuth();
    expect((await auth.login({ email: ` ${TEST_ADMIN_EMAIL.toUpperCase()} `, password: TEST_ADMIN_PASSWORD, client: 'a' })).ok).toBe(true);
    expect(await auth.login({ email: 'outro@example.test', password: TEST_ADMIN_PASSWORD, client: 'b' })).toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });
    expect(await auth.login({ email: TEST_ADMIN_EMAIL, password: 'errada', client: 'c' })).toEqual({
      ok: false,
      reason: 'invalid_credentials',
    });
  });

  it('limita verificações simultâneas (cada scrypt usa muita memória)', async () => {
    const auth = await createTestAuth({ maxConcurrentVerifications: 1 });
    const [first, second] = await Promise.all([
      auth.login({ email: TEST_ADMIN_EMAIL, password: 'errada-1', client: 'a' }),
      auth.login({ email: TEST_ADMIN_EMAIL, password: 'errada-2', client: 'b' }),
    ]);
    expect(first).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(second).toEqual({ ok: false, reason: 'busy', retryAfterSeconds: 1 });
  });

  it('sem administrador configurado, nenhum login é possível', async () => {
    const auth = await createTestAuth({ withAdmin: false });
    expect(auth.configured).toBe(false);
    expect(await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'a' })).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  it('atributos do cookie: HttpOnly, SameSite=Strict, Path=/; Secure e __Host- em produção', async () => {
    const local = await createTestAuth();
    expect(local.sessionCookie('t')).toBe('acc_session=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800');
    expect(local.clearedCookie()).toBe('acc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    const production = await createTestAuth({ secureCookie: true });
    expect(production.sessionCookie('t')).toBe('__Host-acc_session=t; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800');
  });

  it('utilitários', () => {
    expect(normalizeEmail('  Admin@Example.TEST ')).toBe('admin@example.test');
    expect(readCookie('a=1; acc_session=xyz; b=2', 'acc_session')).toBe('xyz');
    expect(readCookie('xacc_session=1', 'acc_session')).toBeNull();
    expect(readCookie(undefined, 'acc_session')).toBeNull();
  });
});

describe('npm run auth:hash-password', () => {
  function runCli(input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'server/auth/hashPasswordCli.ts'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  it('lê a senha da entrada padrão e imprime só a linha do hash, sem a senha', async () => {
    const { code, stdout, stderr } = await runCli(`${TEST_ADMIN_PASSWORD}\n`);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^ACC_ADMIN_PASSWORD_HASH=scrypt:131072:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\n$/);
    expect(stdout + stderr).not.toContain(TEST_ADMIN_PASSWORD);
    const parsed = parsePasswordHash(stdout.trim().split('=')[1]);
    expect(await verifyPassword(TEST_ADMIN_PASSWORD, parsed)).toBe(true);
  }, 30_000);

  it('recusa senha curta', async () => {
    const { code, stdout } = await runCli('curta\n');
    expect(code).toBe(1);
    expect(stdout).toBe('');
  }, 30_000);
});
