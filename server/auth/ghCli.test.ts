// @vitest-environment node
import { delimiter } from 'node:path';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { CredentialError } from './credentials.ts';
import {
  createGhCliCredentialProvider,
  GH_AUTH_TOKEN_ARGS,
  GH_CLI_ERROR_MESSAGE,
  GH_DEFAULTS,
  resolveGhExecutable,
  type ExecFileLike,
} from './ghCli.ts';

/** Token fictício no formato OAuth do `gh`. Nenhum teste pode encontrá-lo em erros ou serializações. */
const GH_CANARY = 'gho_' + 'C'.repeat(36);
const GH_CANARY_2 = 'gho_' + 'D'.repeat(36);

function fakeExec(...outputs: Array<string | Error>) {
  const queue = [...outputs];
  return vi.fn<ExecFileLike>(() => {
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('esperava falha');
}

describe('provedor de credencial do GitHub CLI', () => {
  it('executa somente `gh auth token --hostname github.com`, sem shell, com timeout e limite de saída', async () => {
    const exec = fakeExec(`${GH_CANARY}\n`);
    const provider = createGhCliCredentialProvider({ exec, env: {} });

    expect(provider.kind).toBe('gh-cli');
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${GH_CANARY}`);
    expect(exec).toHaveBeenCalledTimes(1);
    const [file, args, options] = exec.mock.calls[0];
    expect(file).toBe('gh');
    expect(args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(options).toMatchObject({
      shell: false,
      timeout: GH_DEFAULTS.timeoutMs,
      maxBuffer: GH_DEFAULTS.maxOutputBytes,
      windowsHide: true,
    });
  });

  it('os argumentos são imutáveis', () => {
    expect(Object.isFrozen(GH_AUTH_TOKEN_ARGS)).toBe(true);
    expect(() => (GH_AUTH_TOKEN_ARGS as string[]).push('--show-token')).toThrow();
  });

  it('usa o caminho absoluto configurado em vez do PATH', async () => {
    const exec = fakeExec(GH_CANARY);
    await createGhCliCredentialProvider({ exec, env: {}, ghPath: 'C:\\Tools\\gh.exe' }).getAuthorizationHeader();
    expect(exec.mock.calls[0][0]).toBe('C:\\Tools\\gh.exe');
  });

  it('remove do ambiente do `gh` tokens definidos por variável (a credencial vem só da sessão do CLI)', async () => {
    const exec = fakeExec(GH_CANARY);
    const env = { PATH: '/usr/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', GH_ENTERPRISE_TOKEN: 'z', GITHUB_ENTERPRISE_TOKEN: 'w', GH_HOST: 'evil.example' };
    await createGhCliCredentialProvider({ exec, env }).getAuthorizationHeader();
    expect(exec.mock.calls[0][2].env).toEqual({ PATH: '/usr/bin' });
    expect(env.GH_TOKEN).toBe('x'); // o ambiente original não é alterado
  });

  it('mantém o token em cache até expirar e então renova', async () => {
    let clock = 0;
    const exec = fakeExec(GH_CANARY, GH_CANARY_2);
    const provider = createGhCliCredentialProvider({ exec, env: {}, cacheTtlMs: 1000, now: () => clock });

    await provider.getAuthorizationHeader();
    clock = 999;
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${GH_CANARY}`);
    expect(exec).toHaveBeenCalledTimes(1);

    clock = 1000;
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${GH_CANARY_2}`);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('invalidate() força a renovação na próxima chamada', async () => {
    const exec = fakeExec(GH_CANARY, GH_CANARY_2);
    const provider = createGhCliCredentialProvider({ exec, env: {} });
    await provider.getAuthorizationHeader();
    provider.invalidate?.();
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${GH_CANARY_2}`);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('chamadas simultâneas compartilham uma única execução do `gh`', async () => {
    const exec = fakeExec(GH_CANARY);
    const provider = createGhCliCredentialProvider({ exec, env: {} });
    await Promise.all([provider.getAuthorizationHeader(), provider.getAuthorizationHeader(), provider.getAuthorizationHeader()]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('falha do `gh` gera mensagem fixa, sem repassar stderr, e não fica em cache', async () => {
    const exec = fakeExec(new Error(`stderr: not logged in ${GH_CANARY}`), GH_CANARY);
    const provider = createGhCliCredentialProvider({ exec, env: {} });

    const error = await errorOf(provider.getAuthorizationHeader());
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe(GH_CLI_ERROR_MESSAGE);
    expect(error.message).not.toContain('stderr');
    expect(error.cause).toBeUndefined();
    expect(inspect(error)).not.toContain(GH_CANARY);

    // A próxima chamada tenta de novo (ex.: o usuário fez `gh auth login` depois).
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${GH_CANARY}`);
  });

  it.each([
    ['vazia', ''],
    ['só espaço', '   \n'],
    ['texto qualquer', 'not logged in'],
    ['duas linhas', `${GH_CANARY}\n${GH_CANARY_2}\n`],
    ['token com espaço interno', 'gho_AAAA BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'],
    ['prefixo desconhecido', 'xyz_' + 'A'.repeat(36)],
    ['curta demais', 'gho_abc'],
  ])('recusa saída inválida (%s) sem repetir o conteúdo', async (_label, stdout) => {
    const error = await errorOf(createGhCliCredentialProvider({ exec: fakeExec(stdout), env: {} }).getAuthorizationHeader());
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe(GH_CLI_ERROR_MESSAGE);
    if (stdout.trim()) expect(error.message).not.toContain(stdout.trim().slice(0, 8));
  });

  it('aceita quebra de linha final do Windows (CRLF)', async () => {
    const provider = createGhCliCredentialProvider({ exec: fakeExec(`${GH_CANARY}\r\n`), env: {} });
    expect(await provider.getAuthorizationHeader()).toBe(`Bearer ${GH_CANARY}`);
  });

  it('não revela o token ao ser serializado ou inspecionado', async () => {
    const provider = createGhCliCredentialProvider({ exec: fakeExec(GH_CANARY), env: {} });
    await provider.getAuthorizationHeader(); // token já em cache
    expect(JSON.stringify(provider)).toBe('{"kind":"gh-cli"}');
    expect(inspect(provider)).not.toContain(GH_CANARY);
    expect(String(provider)).not.toContain(GH_CANARY);
  });

  it('execução real: sem `gh` em entradas absolutas do PATH, falha de forma controlada sem executar nada', async () => {
    const provider = createGhCliCredentialProvider({ env: { PATH: '.' + delimiter + 'relativo' + delimiter } });
    const error = await errorOf(provider.getAuthorizationHeader());
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe(GH_CLI_ERROR_MESSAGE);
  });

  it('execução real (sem simulação): um executável que não é o `gh` falha de forma controlada', async () => {
    // Node recebe `auth token --hostname github.com` como script inexistente e sai com erro.
    const provider = createGhCliCredentialProvider({ ghPath: process.execPath, env: process.env });
    const error = await errorOf(provider.getAuthorizationHeader());
    expect(error).toBeInstanceOf(CredentialError);
    expect(error.message).toBe(GH_CLI_ERROR_MESSAGE);
  });
});

describe('resolução do executável `gh` (sem busca no diretório atual)', () => {
  const only = (...files: string[]) => (path: string) => files.includes(path);

  it('Windows: ignora `.`, entradas vazias e relativas; aceita só gh.exe em entrada absoluta', () => {
    const env = { Path: '.;tools;;"C:\\Program Files\\GitHub CLI"' };
    const isFile = only('gh.exe', 'tools\\gh.exe', 'C:\\Program Files\\GitHub CLI\\gh.exe');
    expect(resolveGhExecutable(env, { platform: 'win32', isFile })).toBe('C:\\Program Files\\GitHub CLI\\gh.exe');
  });

  it('Windows: não aceita gh.cmd/gh.bat (exigiriam shell)', () => {
    const isFile = only('C:\\bin\\gh.cmd', 'C:\\bin\\gh.bat');
    expect(resolveGhExecutable({ PATH: 'C:\\bin' }, { platform: 'win32', isFile })).toBeNull();
  });

  it('POSIX: ignora entradas relativas e usa a primeira absoluta que contém `gh`', () => {
    const isFile = only('bin/gh', '/usr/local/bin/gh', '/usr/bin/gh');
    expect(resolveGhExecutable({ PATH: 'bin::/opt:/usr/local/bin:/usr/bin' }, { platform: 'linux', isFile })).toBe('/usr/local/bin/gh');
  });

  it('sem PATH, devolve null', () => {
    expect(resolveGhExecutable({}, { platform: 'linux', isFile: () => true })).toBeNull();
    expect(resolveGhExecutable({}, { platform: 'win32', isFile: () => true })).toBeNull();
  });
});
