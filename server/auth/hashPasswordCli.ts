/**
 * Gera `ACC_ADMIN_PASSWORD_HASH` para o administrador do ACC.
 *
 *   npm run auth:hash-password
 *
 * A senha é digitada sem eco no terminal (ou lida da primeira linha da entrada padrão, quando
 * redirecionada) e nunca é gravada, registrada nem passada como argumento de linha de comando.
 * A saída é apenas a linha a colar no `.env.local`.
 */
import { createInterface } from 'node:readline';
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password.ts';

function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input: stdin });
      rl.once('line', (line) => {
        // Resolve antes de fechar: `close` dispara de forma síncrona e resolveria com ''.
        resolve(line);
        rl.close();
      });
      rl.once('close', () => resolve(''));
    });
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('Cancelado.'));
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const password = await readHidden('Nova senha do administrador: ');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    process.stderr.write(`A senha deve ter entre ${MIN_PASSWORD_LENGTH} e ${MAX_PASSWORD_LENGTH} caracteres.\n`);
    process.exit(1);
  }
  if (process.stdin.isTTY) {
    const confirmation = await readHidden('Confirme a senha: ');
    if (confirmation !== password) {
      process.stderr.write('As senhas não coincidem.\n');
      process.exit(1);
    }
  }
  const encoded = await hashPassword(password);
  process.stderr.write('Cole a linha abaixo no .env.local (nunca versione esse arquivo):\n');
  process.stdout.write(`ACC_ADMIN_PASSWORD_HASH=${encoded}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Falha ao gerar o hash.'}\n`);
  process.exit(1);
});
