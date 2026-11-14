// @vitest-environment node
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createFineGrainedTokenProvider } from './auth/credentials.ts';
import type { ExecFileLike } from './auth/ghCli.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createConsoleLogger, redact } from './logger.ts';
import { hashPassword } from './auth/password.ts';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD, testPasswordHash } from './test/authFixtures.ts';
import { CANARY_TOKEN } from './test/fixtures.ts';

describe('configuração', () => {
  it('sem token, inicia em modo demonstração', () => {
    const config = loadConfig({});
    expect(config.credentials).toBeNull();
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.allowedRepositories).toEqual(['Moreirapontocom-br/ai-command-center']);
  });

  it('aceita token fine-grained', () => {
    expect(loadConfig({ GITHUB_TOKEN: CANARY_TOKEN }).credentials?.kind).toBe('fine-grained-token');
  });

  it('recusa tokens que não são fine-grained, sem repetir o valor na mensagem', () => {
    for (const token of ['ghp_' + 'a'.repeat(36), 'gho_' + 'b'.repeat(36), 'qualquer-coisa']) {
      try {
        loadConfig({ GITHUB_TOKEN: token });
        throw new Error('esperava falha');
      } catch (error) {
        expect((error as Error).name).toBe('CredentialError');
        expect((error as Error).message).not.toContain(token);
      }
    }
  });

  it('recusa credenciais em variáveis VITE_ (seriam embutidas no frontend)', () => {
    expect(() => loadConfig({ VITE_GITHUB_TOKEN: CANARY_TOKEN })).toThrow(ConfigError);
    expect(() => loadConfig({ VITE_API_KEY: 'x' })).toThrow(/VITE_API_KEY/);
    expect(() => loadConfig({ VITE_TITLE: 'ok' })).not.toThrow();
  });

  it('recusa expor o servidor fora do loopback', () => {
    expect(() => loadConfig({ API_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ API_HOST: '192.168.0.10' })).toThrow(ConfigError);
    expect(loadConfig({ API_HOST: 'localhost' }).host).toBe('localhost');
  });

  it('valida a porta', () => {
    expect(() => loadConfig({ API_PORT: 'abc' })).toThrow(ConfigError);
    expect(loadConfig({ API_PORT: '9000' }).port).toBe(9000);
  });
});

describe('seleção da autenticação (GITHUB_AUTH)', () => {
  const GH_TOKEN_FAKE = 'gho_' + 'E'.repeat(36);
  const exec = () => vi.fn<ExecFileLike>().mockResolvedValue(GH_TOKEN_FAKE);

  it('sem GITHUB_AUTH, mantém o comportamento fine-grained', () => {
    expect(loadConfig({ GITHUB_TOKEN: CANARY_TOKEN }).credentials?.kind).toBe('fine-grained-token');
    expect(loadConfig({ GITHUB_AUTH: '', GITHUB_TOKEN: CANARY_TOKEN }).credentials?.kind).toBe('fine-grained-token');
    expect(loadConfig({ GITHUB_AUTH: 'fine-grained', GITHUB_TOKEN: CANARY_TOKEN }).credentials?.kind).toBe('fine-grained-token');
    expect(loadConfig({ GITHUB_AUTH: 'fine-grained' }).credentials).toBeNull();
  });

  it('GITHUB_AUTH=gh-cli ativa o GitHub CLI sem executar nada ao carregar a configuração', async () => {
    const run = exec();
    const config = loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli' }, { exec: run });
    expect(config.credentials?.kind).toBe('gh-cli');
    expect(run).not.toHaveBeenCalled();
    expect(await config.credentials?.getAuthorizationHeader()).toBe(`Bearer ${GH_TOKEN_FAKE}`);
    expect(run.mock.calls[0][0]).toBe('gh');
  });

  it('gh-cli não detecta nada automaticamente: sem GITHUB_AUTH, sem token, é modo demonstração', () => {
    const run = exec();
    expect(loadConfig({}, { exec: run }).credentials).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('recusa GITHUB_AUTH=gh-cli junto com GITHUB_TOKEN (configuração ambígua)', () => {
    expect(() => loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', GITHUB_TOKEN: CANARY_TOKEN })).toThrow(/ambígua/);
    try {
      loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', GITHUB_TOKEN: CANARY_TOKEN });
    } catch (error) {
      expect((error as Error).message).not.toContain(CANARY_TOKEN);
    }
    // GITHUB_TOKEN vazio não é conflito.
    expect(loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', GITHUB_TOKEN: '  ' }).credentials?.kind).toBe('gh-cli');
  });

  it('recusa valores desconhecidos sem repetir o valor', () => {
    for (const value of ['GH-CLI', 'github-app', CANARY_TOKEN]) {
      try {
        loadConfig({ GITHUB_AUTH: value });
        throw new Error('esperava falha');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('gh-cli é exclusivo para desenvolvimento local', () => {
    expect(() => loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', NODE_ENV: 'production' })).toThrow(ConfigError);
    // E continua restrito ao loopback como qualquer outro modo.
    expect(() => loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', API_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('GH_PATH precisa ser absoluto e só vale com gh-cli', async () => {
    expect(() => loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', GH_PATH: 'gh.exe' })).toThrow(/absoluto/);
    expect(() => loadConfig({ GITHUB_TOKEN: CANARY_TOKEN, GH_PATH: 'C:\\Tools\\gh.exe' })).toThrow(/GH_PATH/);

    const run = exec();
    const absolute = process.platform === 'win32' ? 'C:\\Tools\\gh.exe' : '/opt/gh/bin/gh';
    await loadConfig({ ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli', GH_PATH: absolute }, { exec: run }).credentials?.getAuthorizationHeader();
    expect(run.mock.calls[0][0]).toBe(absolute);
  });
});

describe('gh-cli restrito a ACC_DEPLOYMENT=local (Issue #003)', () => {
  const exec = () => vi.fn<ExecFileLike>().mockResolvedValue('gho_' + 'E'.repeat(36));

  it('recusa gh-cli sem ACC_DEPLOYMENT, sem executar o gh', () => {
    const run = exec();
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli' }, { exec: run })).toThrow(/ACC_DEPLOYMENT=local/);
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli', ACC_DEPLOYMENT: '' }, { exec: run })).toThrow(ConfigError);
    expect(run).not.toHaveBeenCalled();
  });

  it('recusa gh-cli com ACC_DEPLOYMENT=production', () => {
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli', ACC_DEPLOYMENT: 'production' })).toThrow(/ACC_DEPLOYMENT=local/);
  });

  it('recusa valores desconhecidos de ACC_DEPLOYMENT sem repetir o valor (inclusive variações de "local")', () => {
    for (const value of ['LOCAL', 'Local', 'dev', 'localhost', 'local,production', CANARY_TOKEN]) {
      try {
        loadConfig({ GITHUB_AUTH: 'gh-cli', ACC_DEPLOYMENT: value });
        throw new Error('esperava falha');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).not.toContain(value);
      }
    }
    // Valor inválido é recusado mesmo no modo fine-grained (configuração incoerente não passa).
    expect(() => loadConfig({ GITHUB_TOKEN: CANARY_TOKEN, ACC_DEPLOYMENT: 'prod' })).toThrow(ConfigError);
  });

  it('aceita gh-cli com ACC_DEPLOYMENT=local (espaços nas pontas ignorados) e registra o ambiente', () => {
    const config = loadConfig({ GITHUB_AUTH: 'gh-cli', ACC_DEPLOYMENT: ' local ' }, { exec: exec() });
    expect(config.credentials?.kind).toBe('gh-cli');
    expect(config.deployment).toBe('local');
  });

  it('ACC_DEPLOYMENT=local não relaxa as demais restrições do gh-cli', () => {
    const local = { ACC_DEPLOYMENT: 'local', GITHUB_AUTH: 'gh-cli' };
    expect(() => loadConfig({ ...local, NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...local, GITHUB_TOKEN: CANARY_TOKEN })).toThrow(/ambígua/);
    expect(() => loadConfig({ ...local, API_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...local, API_HOST: '::' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...local, GH_PATH: 'gh' })).toThrow(/absoluto/);
  });

  it('fine-grained continua funcionando com ou sem ACC_DEPLOYMENT', () => {
    expect(loadConfig({ GITHUB_TOKEN: CANARY_TOKEN }).deployment).toBeNull();
    expect(loadConfig({ GITHUB_TOKEN: CANARY_TOKEN, ACC_DEPLOYMENT: 'production' }).credentials?.kind).toBe('fine-grained-token');
    expect(loadConfig({ ACC_DEPLOYMENT: 'local' }).credentials).toBeNull();
  });
});

describe('proteção contra exposição de credenciais', () => {
  it('o provedor de credencial não revela o token ao ser serializado ou inspecionado', async () => {
    const provider = createFineGrainedTokenProvider(CANARY_TOKEN);
    expect(JSON.stringify(provider)).not.toContain(CANARY_TOKEN);
    expect(JSON.stringify({ config: loadConfig({ GITHUB_TOKEN: CANARY_TOKEN }) })).not.toContain(CANARY_TOKEN);
    expect(inspect(provider)).not.toContain(CANARY_TOKEN);
    expect(String(provider)).not.toContain(CANARY_TOKEN);
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${CANARY_TOKEN}`);
  });

  it('o logger mascara tokens e chaves privadas', () => {
    const lines: string[] = [];
    const logger = createConsoleLogger((line) => lines.push(line));
    logger.log('error', `falha com ${CANARY_TOKEN}`, { header: `Bearer ${CANARY_TOKEN}`, classic: 'ghp_' + 'x'.repeat(36) });
    expect(lines[0]).not.toContain(CANARY_TOKEN);
    expect(lines[0]).not.toContain('ghp_x');
    expect(lines[0]).toContain('[REDACTED]');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toBe('[REDACTED]');
  });
});

describe('administrador do ACC (Issue #003, PR 2)', () => {
  const strongHash = () => hashPassword(TEST_ADMIN_PASSWORD, { N: 2 ** 17, r: 8, p: 1 });

  function expectConfigError(env: Record<string, string>, secretFragments: string[] = []) {
    try {
      loadConfig(env);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      for (const fragment of secretFragments) expect((error as Error).message).not.toContain(fragment);
      return;
    }
    throw new Error('esperava ConfigError');
  }

  it('sem administrador: admin=null (login indisponível); cookie não Secure fora de produção', () => {
    const config = loadConfig({});
    expect(config.admin).toBeNull();
    expect(config.secureCookie).toBe(false);
    expect(loadConfig({ ACC_DEPLOYMENT: 'local' }).secureCookie).toBe(false);
  });

  it('aceita e-mail + hash scrypt forte; cookie Secure em produção', async () => {
    const hash = await strongHash();
    const config = loadConfig({ ACC_ADMIN_EMAIL: TEST_ADMIN_EMAIL, ACC_ADMIN_PASSWORD_HASH: hash, ACC_DEPLOYMENT: 'production' });
    expect(config.admin?.email).toBe(TEST_ADMIN_EMAIL);
    expect(config.admin?.passwordHash.params.N).toBe(2 ** 17);
    expect(config.secureCookie).toBe(true);
  });

  it('recusa senha em texto puro no ambiente, sem repetir o valor', () => {
    expectConfigError({ ACC_ADMIN_EMAIL: TEST_ADMIN_EMAIL, ACC_ADMIN_PASSWORD: TEST_ADMIN_PASSWORD }, [TEST_ADMIN_PASSWORD]);
    expectConfigError({ ACC_ADMIN_PASSWORD: '' });
  });

  it('exige e-mail e hash juntos e válidos, sem repetir valores', async () => {
    const hash = await strongHash();
    expectConfigError({ ACC_ADMIN_EMAIL: TEST_ADMIN_EMAIL });
    expectConfigError({ ACC_ADMIN_PASSWORD_HASH: hash }, [hash]);
    expectConfigError({ ACC_ADMIN_EMAIL: 'nao-e-email', ACC_ADMIN_PASSWORD_HASH: hash });
    expectConfigError({ ACC_ADMIN_EMAIL: TEST_ADMIN_EMAIL, ACC_ADMIN_PASSWORD_HASH: TEST_ADMIN_PASSWORD }, [TEST_ADMIN_PASSWORD]);
  });

  it('recusa hash com custo scrypt abaixo do mínimo', async () => {
    const weak = await testPasswordHash(); // N = 2^10
    expectConfigError({ ACC_ADMIN_EMAIL: TEST_ADMIN_EMAIL, ACC_ADMIN_PASSWORD_HASH: weak }, [weak]);
  });

  it('variáveis VITE_ de senha, sessão ou administrador são recusadas (iriam para o bundle)', () => {
    for (const key of ['VITE_ADMIN_PASSWORD', 'VITE_ACC_ADMIN_PASSWORD_HASH', 'VITE_SESSION_SECRET']) {
      expectConfigError({ [key]: 'x' });
    }
  });
});
