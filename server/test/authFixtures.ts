import { createAuthService, DEFAULT_AUTH_LIMITS, type AuthOptions, type AuthService } from '../auth/adminAuth.ts';
import { hashPassword, parsePasswordHash } from '../auth/password.ts';
import { ALLOWED_REPOSITORIES } from '../config.ts';

/** Credenciais fictícias, exclusivas dos testes. Funcionam como "canário" nas verificações de vazamento. */
export const TEST_ADMIN_EMAIL = 'admin@example.test';
export const TEST_ADMIN_PASSWORD = 'SENHACANARIA-correta-123';

/** Custo scrypt reduzido só para os testes (a configuração real exige N ≥ 2^17). */
export const TEST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };

let cachedHash: Promise<string> | undefined;
export function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_ADMIN_PASSWORD, TEST_SCRYPT);
  return cachedHash;
}

export async function createTestAuth(overrides: Partial<AuthOptions> & { withAdmin?: boolean } = {}): Promise<AuthService> {
  const { withAdmin = true, ...rest } = overrides;
  return createAuthService({
    admin: withAdmin ? { email: TEST_ADMIN_EMAIL, passwordHash: parsePasswordHash(await testPasswordHash()) } : null,
    scope: ALLOWED_REPOSITORIES,
    secureCookie: false,
    ...DEFAULT_AUTH_LIMITS,
    ...rest,
  });
}

/** Cria uma sessão válida diretamente no serviço e devolve o cabeçalho `Cookie` correspondente. */
export async function sessionCookieFor(auth: AuthService): Promise<string> {
  const result = await auth.login({ email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD, client: 'fixture' });
  if (!result.ok) throw new Error('login da fixture falhou');
  return `${auth.cookieName}=${result.token}`;
}
