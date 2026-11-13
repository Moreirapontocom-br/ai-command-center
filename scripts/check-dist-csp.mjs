// Verifica se o build (`dist/`) é compatível com a CSP de produção (shared/securityHeaders.ts):
// nenhum script/estilo inline, nenhum handler de evento inline, nenhum recurso de outra origem e
// nenhum uso de eval/new Function nos bundles (bloqueados sem 'unsafe-eval').
// Uso: `npm run build && npm run check:csp`. Saída: 0 = compatível, 1 = incompatível, 2 = sem build.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = process.argv[2] ?? 'dist';
const indexPath = join(DIST, 'index.html');
if (!existsSync(indexPath)) {
  console.error(`${indexPath} não encontrado. Execute "npm run build" antes.`);
  process.exit(2);
}

const html = readFileSync(indexPath, 'utf8');
const problems = [];

for (const tag of html.match(/<script\b[^>]*>/gi) ?? []) {
  if (!/\bsrc=/.test(tag)) problems.push(`script inline: ${tag}`);
}
if (/<style\b/i.test(html)) problems.push('elemento <style> inline');
if (/\son[a-z]+\s*=/i.test(html)) problems.push('handler de evento inline (on...=)');
if (/\sstyle\s*=/i.test(html)) problems.push('atributo style= inline');
for (const [, url] of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
  if (!url.startsWith('/') || url.startsWith('//')) problems.push(`recurso fora da origem: ${url}`);
}

const assets = join(DIST, 'assets');
for (const name of existsSync(assets) ? readdirSync(assets).filter((n) => n.endsWith('.js')) : []) {
  const code = readFileSync(join(assets, name), 'utf8');
  if (/\beval\(|\bnew Function\(/.test(code)) problems.push(`${name}: uso de eval/new Function`);
}

if (problems.length > 0) {
  console.error('Build incompatível com a CSP de produção:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`Build compatível com a CSP de produção (${indexPath} e bundles verificados).`);
