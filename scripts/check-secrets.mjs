// Verificação de segredos no repositório (não só no `dist/`). Nunca imprime o valor encontrado.
//
// Uso:
//   node scripts/check-secrets.mjs tracked            # todos os arquivos versionados (padrão)
//   node scripts/check-secrets.mjs commits <range>    # linhas adicionadas em commits (ex.: origin/main..HEAD)
//   node scripts/check-secrets.mjs history            # linhas adicionadas em todo o histórico de HEAD
//   node scripts/check-secrets.mjs staged             # conteúdo preparado (hook pre-commit)
//
// Saída: 0 = nada encontrado, 1 = possível credencial, 2 = uso incorreto ou falha do Git.
import { existsSync } from 'node:fs';
import { formatFinding, loadAllowlist, scanCommits, scanStaged, scanTrackedFiles } from './secret-scan.mjs';

const [mode = 'tracked', range] = process.argv.slice(2);

// Valor exato do token configurado localmente (se houver), procurado sem nunca ser exibido.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const configured = process.env.GITHUB_TOKEN?.trim();
const extraValues = configured && configured.length >= 20 ? [configured] : [];

let result;
let scope;
try {
  const allowlist = loadAllowlist();
  const options = { allowlist, extraValues };
  if (mode === 'tracked') {
    result = scanTrackedFiles(options);
    scope = `${result.scanned} arquivo(s) versionado(s)`;
  } else if (mode === 'commits') {
    if (!range) throw new Error('Informe o intervalo de commits, ex.: origin/main..HEAD');
    result = scanCommits({ ...options, range });
    scope = `${result.scanned} commit(s) em ${range}`;
  } else if (mode === 'history') {
    result = scanCommits({ ...options, range: 'HEAD' });
    scope = `${result.scanned} commit(s) do histórico de HEAD`;
  } else if (mode === 'staged') {
    result = scanStaged(options);
    scope = `${result.scanned} arquivo(s) preparado(s)`;
  } else {
    throw new Error(`Modo desconhecido. Use: tracked | commits <range> | history | staged`);
  }
} catch (error) {
  // Mensagens do Git podem citar caminhos, nunca conteúdo; ainda assim só a primeira linha é exibida.
  console.error(`Falha na verificação de segredos: ${String(error?.message ?? error).split('\n')[0]}`);
  process.exit(2);
}

if (result.findings.length > 0) {
  console.error(
    `Possível credencial encontrada (${scope}):\n` +
      result.findings.map((finding) => `  - ${formatFinding(finding)}`).join('\n') +
      '\nRemova o valor, revogue a credencial se ela for real e, se for um valor de teste conhecido, ' +
      'registre o SHA-256 completo em scripts/secret-scan-allowlist.json com justificativa.',
  );
  process.exit(1);
}
console.log(`Nenhuma credencial encontrada (${scope}).`);
