// @vitest-environment node
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createFineGrainedTokenProvider } from './auth/credentials.ts';
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
