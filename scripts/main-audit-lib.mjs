// Núcleo da auditoria INFORMATIVA (detectiva) de integridade da main. Sem dependências.
//
// O que é confiável (investigado na API do GitHub):
// - `forced` e `deleted` no evento `push`: o próprio GitHub informa push não fast-forward e exclusão.
//   São FATOS e geram `alert`.
// - `GET /repos/{owner}/{repo}/commits/{sha}/pulls`: para commits na branch padrão, lista o PR
//   mesclado que introduziu o commit. Vale para merge commit, squash e rebase. Pode demorar alguns
//   segundos para refletir um merge recém-feito (consistência eventual) — por isso há novas tentativas.
//
// O que NÃO é afirmado: ausência de PR associado NÃO é tratada como violação, e sim como `attention`
// (ex.: commit raiz criado antes do fluxo de PR, atraso de indexação, PR de outro repositório).
// Este módulo nunca recebe nem imprime credenciais.

export const STATUS = Object.freeze({
  OK: 'ok',
  INFO: 'info',
  ATTENTION: 'attention',
  INCONCLUSIVE: 'inconclusive',
  ALERT: 'alert',
  SKIPPED: 'skipped',
});

const SEVERITY = { skipped: 0, ok: 1, info: 1, inconclusive: 2, attention: 3, alert: 4 };
const ZERO_SHA = /^0+$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Classifica um commit a partir dos PRs associados devolvidos pela API. */
export function classifyCommit(sha, pulls, { branch = 'main', isRoot = false } = {}) {
  const list = Array.isArray(pulls) ? pulls : [];
  const merged = list.find((pr) => pr?.merged_at && pr?.base?.ref === branch);
  if (merged) {
    return { sha, status: STATUS.OK, pr: merged.number, detail: `introduzido pelo PR #${merged.number} (mesclado)` };
  }
  if (isRoot) {
    // Fato conhecido e verificável (sem pai): registrado, mas não exige revisão a cada execução.
    return { sha, status: STATUS.INFO, detail: 'commit raiz (criação do repositório), anterior ao fluxo de PR' };
  }
  const open = list.find((pr) => pr?.state === 'open' && pr?.base?.ref === branch);
  if (open) {
    return {
      sha,
      status: STATUS.ATTENTION,
      pr: open.number,
      detail: `associado ao PR #${open.number}, que ainda está ABERTO (não mesclado): verificar como chegou à ${branch}`,
    };
  }
  return { sha, status: STATUS.ATTENTION, detail: `nenhum PR mesclado na ${branch} associado: revisar manualmente` };
}

/** Padrões do orçamento (ver scripts/audit-main.mjs e .github/workflows/main-audit.yml). */
export const AUDIT_DEFAULTS = Object.freeze({
  retries: 3,
  delayMs: 5000,
  /** Tempo máximo de uma consulta à API (aplicado pelo `fetchPulls` via `timeoutMs`). */
  requestTimeoutMs: 10_000,
  /** Não inicia uma consulta com menos tempo restante do que isto. */
  minRequestMs: 1000,
});

const isSettled = (result) => result?.status === STATUS.OK || result?.status === STATUS.INFO;

/**
 * Consulta os PRs de cada commit dentro de um ORÇAMENTO GLOBAL de tempo (`budgetMs`).
 *
 * - Rodada 0: cada commit é consultado uma vez, em ordem.
 * - Rodadas 1..`retries`: só os commits ainda não confirmados (sem PR mesclado ou com falha da API)
 *   são consultados de novo, após UMA espera de `delayMs` por rodada — compartilhada por todos —
 *   para cobrir o atraso de indexação da API. A espera total fica limitada a `retries × delayMs`,
 *   qualquer que seja o tamanho do lote.
 * - Nenhuma consulta começa com menos de `minRequestMs` restantes; cada uma recebe
 *   `timeoutMs = min(requestTimeoutMs, tempo restante)`, que o `fetchPulls` deve respeitar.
 * - Nenhuma espera começa se não sobrar tempo para ela e para mais uma consulta.
 * - Esgotado o orçamento: commits nunca consultados viram `inconclusive`; os já consultados mantêm
 *   o último resultado (`attention`/`inconclusive`). Nenhum commit é aprovado sem confirmação.
 *
 * `now` e `sleep` são injetáveis (relógio simulado nos testes).
 */
export async function auditCommits({
  shas,
  branch = 'main',
  fetchPulls,
  isRoot = () => false,
  retries = AUDIT_DEFAULTS.retries,
  delayMs = AUDIT_DEFAULTS.delayMs,
  budgetMs = Number.POSITIVE_INFINITY,
  requestTimeoutMs = AUDIT_DEFAULTS.requestTimeoutMs,
  minRequestMs = AUDIT_DEFAULTS.minRequestMs,
  now = Date.now,
  sleep,
}) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + budgetMs;
  const remaining = () => deadline - now();
  const results = new Map();
  let budgetExhausted = false;
  let requests = 0;

  async function examine(sha) {
    requests++;
    try {
      const timeoutMs = Math.min(requestTimeoutMs, remaining());
      return classifyCommit(sha, await fetchPulls(sha, { timeoutMs }), { branch, isRoot: isRoot(sha) });
    } catch (error) {
      return { sha, status: STATUS.INCONCLUSIVE, detail: `consulta à API falhou (${safeMessage(error)})` };
    }
  }

  for (let round = 0; round <= retries && !budgetExhausted; round++) {
    const queue = round === 0 ? shas : shas.filter((sha) => results.has(sha) && !isSettled(results.get(sha)));
    if (queue.length === 0) break;
    if (round > 0) {
      if (remaining() < delayMs + minRequestMs) {
        budgetExhausted = true;
        break;
      }
      await wait(delayMs);
    }
    for (const sha of queue) {
      if (remaining() < minRequestMs) {
        budgetExhausted = true;
        break;
      }
      results.set(sha, await examine(sha));
    }
  }

  const ordered = shas.map(
    (sha) =>
      results.get(sha) ?? {
        sha,
        status: STATUS.INCONCLUSIVE,
        detail: 'não examinado: orçamento de tempo da auditoria esgotado',
      },
  );
  const unexamined = shas.length - results.size;
  return { results: ordered, budgetExhausted, unexamined, requests };
}

/** Só a primeira linha e sem nada que pareça credencial. */
function safeMessage(error) {
  return String(error?.message ?? error)
    .split('\n')[0]
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 200);
}

/** Interpreta o evento `push`: fatos reportados pelo GitHub e os commits a auditar. */
export function analyzePushEvent(event, branch = 'main') {
  if (event?.ref !== `refs/heads/${branch}`) {
    return { skip: true, alerts: [], notes: [`evento para ${String(event?.ref)} — fora do escopo`], shas: [] };
  }
  const alerts = [];
  const notes = [];
  if (event.deleted) alerts.push(`o GitHub reportou a EXCLUSÃO da branch ${branch} (pusher: ${pusherOf(event)})`);
  if (event.forced) {
    alerts.push(
      `o GitHub reportou push FORÇADO (não fast-forward) na ${branch}: ${short(event.before)} → ${short(event.after)} ` +
        `(pusher: ${pusherOf(event)}). Histórico anterior pode ter sido reescrito.`,
    );
  }
  if (event.created) notes.push(`a branch ${branch} foi criada neste push`);

  const commits = Array.isArray(event.commits) ? event.commits : [];
  if (commits.length >= 2048) notes.push('o evento lista o limite de 2048 commits: a auditoria pode estar incompleta');
  const shas = [...new Set([...commits.map((c) => c?.id), event.deleted ? null : event.after])].filter(
    (sha) => typeof sha === 'string' && SHA.test(sha) && !ZERO_SHA.test(sha),
  );
  return { skip: false, alerts, notes, shas };
}

function pusherOf(event) {
  return String(event?.pusher?.name ?? 'desconhecido').replace(/[^A-Za-z0-9._-]/g, '');
}

function short(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : '?';
}

export function overallStatus({ alerts = [], results = [], skip = false }) {
  if (skip) return STATUS.SKIPPED;
  if (alerts.length > 0) return STATUS.ALERT;
  if (results.length === 0) return STATUS.INCONCLUSIVE;
  return results.reduce((worst, r) => (SEVERITY[r.status] > SEVERITY[worst] ? r.status : worst), STATUS.OK);
}

const LABEL = {
  ok: '✅ OK — nenhum commit auditado exige revisão (PR mesclado ou commit raiz)',
  attention: '⚠️ ATENÇÃO — há commits que exigem revisão manual (não é afirmação de violação)',
  inconclusive: '❔ INCONCLUSIVO — não foi possível verificar todos os commits',
  alert: '🚨 ALERTA — o GitHub reportou um fato que exige revisão imediata',
  skipped: '— Ignorado (evento fora do escopo)',
};

export function renderReport({ status, alerts = [], notes = [], results = [], context = '' }) {
  const lines = ['## Auditoria informativa da main', '', `**Resultado:** ${LABEL[status]}`, ''];
  if (context) lines.push(context, '');
  for (const alert of alerts) lines.push(`- 🚨 ${alert}`);
  for (const note of notes) lines.push(`- ℹ️ ${note}`);
  if (alerts.length || notes.length) lines.push('');
  if (results.length) {
    lines.push('| Commit | Resultado | Detalhe |', '| --- | --- | --- |');
    for (const r of results) lines.push(`| \`${short(r.sha)}\` | ${r.status} | ${r.detail} |`);
    lines.push('');
  }
  lines.push(
    '_Controle DETECTIVO: roda depois que a main já mudou e não impede nada. Ausência de PR associado ' +
      'é sinal para revisão, não prova de alteração indevida. Ver docs/BRANCH_POLICY.md._',
  );
  return lines.join('\n');
}
