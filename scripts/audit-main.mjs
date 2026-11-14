// Auditoria INFORMATIVA da main (ver scripts/main-audit-lib.mjs para os critérios).
//
// No GitHub Actions (workflow "Main audit"):
//   - push na main: usa o evento (`forced`, `deleted`, commits enviados);
//   - workflow_dispatch: audita os últimos AUDIT_DEPTH commits de HEAD (padrão 20).
// Localmente (somente leitura, exige `GITHUB_TOKEN` no ambiente — nunca é impresso):
//   node scripts/audit-main.mjs --ref origin/main --depth 20
//
// Orçamento: AUDIT_BUDGET_MS (padrão 180000 = 3 min), bem abaixo do timeout de 5 min do job, que
// ainda inclui checkout e setup do Node. Commits não examinados a tempo ficam como inconclusivos.
//
// Saída: 0 = ok / atenção / inconclusivo (relatório e avisos), 1 = alerta (push forçado ou exclusão
// reportados pelo GitHub), 2 = uso incorreto.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { analyzePushEvent, AUDIT_DEFAULTS, auditCommits, overallStatus, renderReport, STATUS } from './main-audit-lib.mjs';

const BRANCH = 'main';
const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const repo = process.env.GITHUB_REPOSITORY ?? 'Moreirapontocom-br/ai-command-center';
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const token = process.env.GITHUB_TOKEN?.trim();
const eventName = process.env.GITHUB_EVENT_NAME ?? 'local';
const inActions = process.env.GITHUB_ACTIONS === 'true';

if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
  console.error('GITHUB_REPOSITORY inválido.');
  process.exit(2);
}

const depthRaw = argValue('--depth') ?? process.env.AUDIT_DEPTH ?? '20';
if (!/^\d{1,3}$/.test(depthRaw) || Number(depthRaw) < 1) {
  console.error('Profundidade inválida: use um inteiro entre 1 e 999.');
  process.exit(2);
}
const depth = Number(depthRaw);
const budgetRaw = process.env.AUDIT_BUDGET_MS ?? '180000';
if (!/^\d{4,7}$/.test(budgetRaw) || Number(budgetRaw) < 10_000 || Number(budgetRaw) > 240_000) {
  console.error('AUDIT_BUDGET_MS inválido: use um inteiro entre 10000 e 240000 (o job tem timeout de 5 min).');
  process.exit(2);
}
const budgetMs = Number(budgetRaw);
const ref = argValue('--ref') ?? 'HEAD';
if (!/^[A-Za-z0-9._/-]+$/.test(ref)) {
  console.error('Ref inválida.');
  process.exit(2);
}

const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const roots = new Set();
try {
  for (const sha of git('rev-list', '--max-parents=0', ref).split('\n')) if (sha) roots.add(sha);
} catch {
  // Sem histórico local (checkout raso): nenhum commit é tratado como raiz.
}

async function fetchPulls(sha, { timeoutMs = AUDIT_DEFAULTS.requestTimeoutMs } = {}) {
  const response = await fetch(`${api}/repos/${repo}/commits/${sha}/pulls?per_page=100`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-command-center-main-audit',
    },
    redirect: 'error',
    // Cobre conexão, cabeçalhos e leitura do corpo: uma consulta travada não consome o orçamento.
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

let alerts = [];
let notes = [];
let shas = [];
let skip = false;
let context;

if (eventName === 'push') {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  ({ alerts, notes, shas, skip } = analyzePushEvent(event, BRANCH));
  context = `Evento: push em \`${event.ref}\` (${String(event.before).slice(0, 7)} → ${String(event.after).slice(0, 7)}).`;
} else {
  shas = git('rev-list', `--max-count=${depth}`, ref).split('\n').filter(Boolean);
  context = `Evento: ${eventName} — últimos ${shas.length} commit(s) de \`${ref}\`.`;
}

// Alertas confirmados (push forçado/exclusão) são emitidos ANTES das consultas à API: mesmo que o
// job seja interrompido depois, o alerta já está no log.
if (inActions) for (const alert of alerts) console.log(`::error title=Auditoria da main::${alert}`);
else for (const alert of alerts) console.error(`ALERTA: ${alert}`);

let results = [];
if (!skip && shas.length > 0) {
  if (!token) {
    notes.push('GITHUB_TOKEN ausente: associação a PRs não verificada');
    results = shas.map((sha) => ({ sha, status: STATUS.INCONCLUSIVE, detail: 'sem credencial de leitura para consultar a API' }));
  } else {
    const audit = await auditCommits({
      shas,
      branch: BRANCH,
      fetchPulls,
      isRoot: (sha) => roots.has(sha),
      retries: eventName === 'push' ? AUDIT_DEFAULTS.retries : 0,
      budgetMs,
    });
    results = audit.results;
    if (audit.budgetExhausted) {
      notes.push(
        `orçamento de tempo (${budgetMs / 1000}s) esgotado: ${audit.unexamined} commit(s) não examinado(s) e marcados como inconclusivos`,
      );
    }
  }
}

const status = overallStatus({ alerts, results, skip });
const report = renderReport({ status, alerts, notes, results, context });
console.log(report);

if (inActions) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  for (const r of results.filter((x) => x.status !== STATUS.OK && x.status !== STATUS.INFO)) {
    console.log(`::warning title=Auditoria da main (${r.status})::${r.sha.slice(0, 7)} — ${r.detail}`);
  }
}

process.exit(status === STATUS.ALERT ? 1 : 0);
