// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { AGENT_ENV_VARS, checkInvocation, createTtyPrompt, PromptCancelled, type RawInput } from './releaseBarrierCli.ts';

const tty = { argv: [] as string[], env: {}, stdinIsTTY: true, stderrIsTTY: true, hasRawMode: true };

describe('invocação do comando (F5: agentes, argumentos e terminal)', () => {
  it('terminal interativo sem argumentos → executa; --help → ajuda', () => {
    expect(checkInvocation(tty)).toEqual({ kind: 'run' });
    expect(checkInvocation({ ...tty, argv: ['--help'] })).toEqual({ kind: 'help' });
  });

  it.each([['--yes'], ['--password=x'], ['--help', '--yes'], ['x'], ['-y']])('qualquer argumento (%s) → recusa', (...argv) => {
    expect(checkInvocation({ ...tty, argv })).toEqual({ kind: 'refuse', reason: 'arguments_not_accepted' });
  });

  it.each([...AGENT_ENV_VARS])('variável de agente %s → recusa', (name) => {
    expect(checkInvocation({ ...tty, env: { [name]: '1' } })).toEqual({ kind: 'refuse', reason: 'agent_environment' });
  });

  it('variável vazia não conta', () => {
    expect(checkInvocation({ ...tty, env: { CLAUDECODE: '' } })).toEqual({ kind: 'run' });
  });

  it.each([
    ['entrada redirecionada', { stdinIsTTY: false }],
    ['saída redirecionada', { stderrIsTTY: false }],
    ['sem modo raw (mintty/Git Bash)', { hasRawMode: false }],
  ])('%s → recusa', (_name, patch) => {
    expect(checkInvocation({ ...tty, ...patch })).toEqual({ kind: 'refuse', reason: 'interactive_terminal_required' });
  });

  it('esta sessão de teste (agente) seria recusada pelo ambiente real', () => {
    const real = checkInvocation({ argv: [], env: process.env, stdinIsTTY: process.stdin.isTTY === true, stderrIsTTY: process.stderr.isTTY === true, hasRawMode: typeof process.stdin.setRawMode === 'function' });
    expect(real.kind).toBe('refuse');
  });
});

class FakeStdin extends EventEmitter implements RawInput {
  raw: boolean[] = [];
  setRawMode(mode: boolean) {
    this.raw.push(mode);
  }
  resume() {}
  pause() {}
  setEncoding() {}
  type(text: string) {
    this.emit('data', text);
  }
}

describe('prompt em modo raw', () => {
  const make = () => {
    const stdin = new FakeStdin();
    let out = '';
    const prompt = createTtyPrompt(stdin, { write: (s: string) => (out += s) });
    return { stdin, prompt, out: () => out };
  };

  it('senha sem eco, com apagar; modo raw ligado e desligado', async () => {
    const t = make();
    const p = t.prompt.password('Senha: ');
    t.stdin.type('segredoX');
    t.stdin.type('\u007f\r');
    expect(await p).toBe('segredo');
    expect(t.out()).toBe('Senha: \n');
    expect(t.stdin.raw).toEqual([true, false]);
  });

  it('frase com eco', async () => {
    const t = make();
    const p = t.prompt.line('Frase: ');
    t.stdin.type('LIBERAR\r');
    expect(await p).toBe('LIBERAR');
    expect(t.out()).toContain('LIBERAR');
  });

  it.each([['Ctrl+C', '\u0003'], ['Ctrl+D', '\u0004']])('%s cancela', async (_n, key) => {
    const t = make();
    const p = t.prompt.password('Senha: ');
    t.stdin.type(`abc${key}`);
    await expect(p).rejects.toBeInstanceOf(PromptCancelled);
    expect(t.stdin.raw).toEqual([true, false]);
  });

  it('sinal aborta a leitura pendente', async () => {
    const t = make();
    const p = t.prompt.password('Senha: ');
    t.prompt.abort();
    await expect(p).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('entrada longa demais → cancela', async () => {
    const t = make();
    const p = t.prompt.password('Senha: ');
    t.stdin.type('a'.repeat(2000));
    await expect(p).rejects.toThrow('input_too_long');
  });
});
