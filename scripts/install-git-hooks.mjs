// Ativa os hooks versionados em `.githooks/` neste clone (`core.hooksPath` LOCAL).
//
// Regras: nunca sobrescreve uma configuração existente diferente; só grava quando `core.hooksPath`
// local está vazio. Configurações global/do sistema e hooks em `.git/hooks` são apenas relatados.
//
// Uso: npm run hooks:install          (grava, se seguro)
//      npm run hooks:install -- --check  (só verifica; saída 1 se não estiver ativo)
//
// Saída: 0 = ativo, 1 = não ativo/conflito (nada alterado), 2 = falha do Git.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXPECTED = '.githooks';
const checkOnly = process.argv.includes('--check');

function git(args) {
  try {
    return { ok: true, out: execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (error) {
    // `git config --get` sai com 1 quando a chave não existe.
    return { ok: false, status: error.status, out: String(error.stdout ?? '').trim() };
  }
}

const top = git(['rev-parse', '--show-toplevel']);
if (!top.ok) {
  console.error('Não é um repositório Git.');
  process.exit(2);
}

const local = git(['config', '--local', '--get', 'core.hooksPath']);
const effective = git(['config', '--get', 'core.hooksPath']);
for (const scope of ['--global', '--system']) {
  const value = git(['config', scope, '--get', 'core.hooksPath']);
  if (value.ok && value.out) console.warn(`Aviso: core.hooksPath ${scope.slice(2)} = "${value.out}" (a configuração local tem precedência).`);
}

const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');

if (local.ok && normalize(local.out) === EXPECTED) {
  console.log(`Hooks ativos: core.hooksPath local = "${EXPECTED}".`);
  process.exit(0);
}

if (local.ok && local.out) {
  console.error(
    `core.hooksPath local já está definido como "${local.out}". Nada foi alterado.\n` +
      `Revise manualmente: para usar os hooks do projeto, execute "git config --local core.hooksPath ${EXPECTED}" ` +
      'depois de confirmar que os hooks atuais não são necessários (ou incorpore-os em .githooks/).',
  );
  process.exit(1);
}

if (checkOnly) {
  console.error(
    `Hooks do projeto NÃO estão ativos (core.hooksPath efetivo: ${effective.ok ? `"${effective.out}"` : 'padrão .git/hooks'}). ` +
      'Execute "npm run hooks:install".',
  );
  process.exit(1);
}

// Hooks próprios em .git/hooks deixariam de rodar quando core.hooksPath for definido.
const legacyDir = join(top.out, '.git', 'hooks');
const legacy = existsSync(legacyDir) ? readdirSync(legacyDir).filter((name) => !name.endsWith('.sample')) : [];
if (legacy.length > 0) {
  console.error(
    `Existem hooks em .git/hooks (${legacy.join(', ')}) que deixariam de executar. Nada foi alterado.\n` +
      `Incorpore-os em ${EXPECTED}/ ou remova-os e execute novamente.`,
  );
  process.exit(1);
}

const set = git(['config', '--local', 'core.hooksPath', EXPECTED]);
if (!set.ok) {
  console.error('Falha ao gravar core.hooksPath.');
  process.exit(2);
}
console.log(`Hooks ativados: core.hooksPath local = "${EXPECTED}" (pre-commit: segredos; pre-push: bloqueio da main).`);
