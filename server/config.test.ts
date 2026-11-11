// @vitest-environment node
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createFineGrainedTokenProvider } from './auth/credentials.ts';
import type { ExecFileLike } from './auth/ghCli.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createConsoleLogger, redact } from './logger.ts';
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
    const config = loadConfig({ GITHUB_AUTH: 'gh-cli' }, { exec: run });
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
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli', GITHUB_TOKEN: CANARY_TOKEN })).toThrow(/ambígua/);
    try {
      loadConfig({ GITHUB_AUTH: 'gh-cli', GITHUB_TOKEN: CANARY_TOKEN });
    } catch (error) {
      expect((error as Error).message).not.toContain(CANARY_TOKEN);
    }
    // GITHUB_TOKEN vazio não é conflito.
    expect(loadConfig({ GITHUB_AUTH: 'gh-cli', GITHUB_TOKEN: '  ' }).credentials?.kind).toBe('gh-cli');
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
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli', NODE_ENV: 'production' })).toThrow(ConfigError);
    // E continua restrito ao loopback como qualquer outro modo.
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli', API_HOST: '0.0.0.0' })).toThrow(ConfigError);
  });

  it('GH_PATH precisa ser absoluto e só vale com gh-cli', async () => {
    expect(() => loadConfig({ GITHUB_AUTH: 'gh-cli', GH_PATH: 'gh.exe' })).toThrow(/absoluto/);
    expect(() => loadConfig({ GITHUB_TOKEN: CANARY_TOKEN, GH_PATH: 'C:\\Tools\\gh.exe' })).toThrow(/GH_PATH/);

    const run = exec();
    const absolute = process.platform === 'win32' ? 'C:\\Tools\\gh.exe' : '/opt/gh/bin/gh';
    await loadConfig({ GITHUB_AUTH: 'gh-cli', GH_PATH: absolute }, { exec: run }).credentials?.getAuthorizationHeader();
    expect(run.mock.calls[0][0]).toBe(absolute);
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
