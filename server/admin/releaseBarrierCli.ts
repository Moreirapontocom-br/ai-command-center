/**
 * Liberação LOCAL e supervisionada da barreira global inicial do ACC (Issue #008, P1).
 *
 *   npm run admin:release-barrier
 *
 * Só no terminal interativo da máquina do ACC (PowerShell ou Windows Terminal), com o servidor
 * PARADO. Não aceita argumentos além de `--help`: não existe `--yes`, `--password`, entrada
 * redirecionada nem qualquer modo automático. Passo a passo e recuperação: `docs/BARRIER_RELEASE.md`.
 *
 * Este arquivo cuida só do terminal. A segurança NÃO depende dele: depende da senha do
 * administrador (scrypt, #003), da prova de step-up de uso único, da aprovação com escopo exato
 * montada internamente, do sujeito humano fixo e da persistência atômica da #011
 * (`releaseBarrier.ts`). As recusas daqui (TTY, variáveis de agente) são defesa adicional.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, loadConfig } from '../config.ts';
import { CredentialError } from '../auth/credentials.ts';
import { runBarrierRelease, type ReleasePrompt, type ReleaseResult } from './releaseBarrier.ts';

/**
 * Variáveis que indicam execução por agente/automação. A lista é defesa ADICIONAL (não é garantia):
 * qualquer uma presente e não vazia → recusa.
 */
export const AGENT_ENV_VARS = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CURSOR_AGENT',
  'GEMINI_CLI',
  'AIDER_MODEL',
  'OPENHANDS_RUNTIME',
  'GITHUB_ACTIONS',
  'CI',
]);

export const HELP = [
  'Uso: npm run admin:release-barrier',
  '',
  'Libera UMA VEZ a barreira global inicial (initial_install) das aprovações do ACC.',
  'Requisitos: servidor parado, ACC_DEPLOYMENT=local, aprovações e administrador configurados,',
  'terminal interativo (PowerShell ou Windows Terminal). Pede a senha do administrador e uma',
  'frase ligada à linhagem do armazenamento. Não há opções nem modo automático.',
  'Passo a passo: docs/BARRIER_RELEASE.md',
].join('\n');

export interface Invocation {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdinIsTTY: boolean;
  stderrIsTTY: boolean;
  hasRawMode: boolean;
}

/** Decide se a invocação é aceitável ANTES de carregar configuração ou abrir qualquer arquivo. */
export function checkInvocation(inv: Invocation): { kind: 'run' } | { kind: 'help' } | { kind: 'refuse'; reason: string } {
  if (inv.argv.length === 1 && inv.argv[0] === '--help') return { kind: 'help' };
  if (inv.argv.length > 0) return { kind: 'refuse', reason: 'arguments_not_accepted' };
  const agent = AGENT_ENV_VARS.find((name) => (inv.env[name] ?? '').trim() !== '');
  if (agent) return { kind: 'refuse', reason: 'agent_environment' };
  if (!inv.stdinIsTTY || !inv.stderrIsTTY || !inv.hasRawMode) return { kind: 'refuse', reason: 'interactive_terminal_required' };
  return { kind: 'run' };
}

/** Fluxo de entrada mínimo (o `process.stdin` real em modo raw; um falso nos testes). */
export interface RawInput {
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: 'utf8'): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
}

export class PromptCancelled extends Error {
  name = 'PromptCancelled';
}

const MAX_INPUT = 1024;

/**
 * Prompt em modo raw: a senha nunca é ecoada; a frase é ecoada. Ctrl+C/Ctrl+D cancelam. `abort()`
 * cancela a leitura pendente (sinais), e o comando então encerra pelo caminho normal (`finally`).
 */
export function createTtyPrompt(stdin: RawInput, out: { write(text: string): unknown }): ReleasePrompt & { abort(): void } {
  let cancel: (() => void) | null = null;
  const read = (label: string, echo: boolean) =>
    new Promise<string>((resolvePromise, reject) => {
      out.write(label);
      let value = '';
      const finish = (error: Error | null) => {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        cancel = null;
        out.write('\n');
        if (error) reject(error);
        else resolvePromise(value);
      };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n') return finish(null);
          if (char === '\u0003' || char === '\u0004') return finish(new PromptCancelled('cancelled'));
          if (char === '\u007f' || char === '\b') {
            if (value.length > 0 && echo) out.write('\b \b');
            value = value.slice(0, -1);
          } else if (char >= ' ') {
            if (value.length >= MAX_INPUT) return finish(new PromptCancelled('input_too_long'));
            value += char;
            if (echo) out.write(char);
          }
        }
      };
      cancel = () => finish(new PromptCancelled('aborted'));
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.resume();
      stdin.on('data', onData);
    });
  return {
    show(lines) {
      out.write(`${lines.join('\n')}\n`);
    },
    password: (label) => read(label, false),
    line: (label) => read(label, true),
    abort() {
      cancel?.();
    },
  };
}

const MESSAGES: Record<ReleaseResult['outcome'], string> = {
  released: 'LIBERADA: a barreira global inicial foi liberada, gravada, relida e auditada.',
  reconciled: 'RECONCILIADA: a operação anterior foi conciliada entre a #011 e a auditoria.',
  refused: 'RECUSADA: nada foi alterado na barreira.',
  pending: 'NÃO LIBERADA: operação interrompida e registrada no diário. As aprovações ficam indisponíveis no servidor até você executar o comando de novo (reconciliação).',
  audit_pending: 'LIBERAÇÃO REGISTRADA NA #011, AUDITORIA PENDENTE. As aprovações ficam indisponíveis no servidor até você executar o comando de novo (reconciliação).',
};

export async function main(): Promise<number> {
  const stdin = process.stdin;
  const decision = checkInvocation({
    argv: process.argv.slice(2),
    env: process.env,
    stdinIsTTY: stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    hasRawMode: typeof stdin.setRawMode === 'function',
  });
  if (decision.kind === 'help') {
    process.stderr.write(`${HELP}\n`);
    return 0;
  }
  if (decision.kind === 'refuse') {
    process.stderr.write(`RECUSADA (${decision.reason}). Veja docs/BARRIER_RELEASE.md.\n`);
    return 1;
  }
  // Mesma configuração do servidor: `.env.local` (fora do Git); o ambiente tem precedência.
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof CredentialError) {
      process.stderr.write('RECUSADA (config_invalid): corrija a configuração (a mensagem do servidor descreve o problema).\n');
      return 1;
    }
    throw error;
  }
  const prompt = createTtyPrompt(stdin as unknown as RawInput, process.stderr);
  const onSignal = () => prompt.abort();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;
  for (const signal of signals) process.on(signal, onSignal);
  try {
    const result = await runBarrierRelease({ config, env: process.env, prompt });
    process.stderr.write(`${MESSAGES[result.outcome]} [${result.reason}]\n`);
    return result.exitCode;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('RECUSADA (internal_error).\n');
      process.exitCode = 1;
    },
  );
}
