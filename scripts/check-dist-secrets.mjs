// Verifica se o build do frontend (`dist/`) contém credenciais ou referências a elas.
// Uso: `npm run build && npm run check:secrets`. Nunca imprime o valor encontrado.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';

const PATTERNS = [
  ['token fine-grained do GitHub', /github_pat_[A-Za-z0-9_]{20,}/],
  ['token do GitHub (ghp_/gho_/ghu_/ghs_/ghr_)', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['chave privada PEM', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

// Se houver um token configurado localmente, procura também o valor exato (sem exibi-lo).
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const configuredToken = process.env.GITHUB_TOKEN?.trim();
if (configuredToken) PATTERNS.push(['valor do GITHUB_TOKEN configurado', configuredToken]);

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

if (!existsSync(DIST)) {
  console.error(`Diretório ${DIST}/ não encontrado. Execute "npm run build" antes.`);
  process.exit(2);
}

const findings = [];
const files = listFiles(DIST);
for (const file of files) {
  const content = readFileSync(file, 'latin1');
  for (const [label, pattern] of PATTERNS) {
    const found = typeof pattern === 'string' ? content.includes(pattern) : pattern.test(content);
    if (found) findings.push(`${file}: ${label}`);
  }
}

if (findings.length > 0) {
  console.error('Possível credencial no build do frontend:\n' + findings.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`Nenhuma credencial encontrada em ${files.length} arquivo(s) de ${DIST}/.`);
