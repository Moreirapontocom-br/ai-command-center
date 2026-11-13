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

/**
 * Consulta os PRs de cada commit. Um commit sem PR mesclado é consultado novamente (consistência
 * eventual); falha da API resulta em `inconclusive`, nunca em violação.
 */
export async function auditCommits({ shas, branch = 'main', fetchPulls, isRoot = () => false, retries = 3, delayMs = 5000, sleep }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const results = [];
  for (const sha of shas) {
    let result;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        result = classifyCommit(sha, await fetchPulls(sha), { branch, isRoot: isRoot(sha) });
      } catch (error) {
        result = { sha, status: STATUS.INCONCLUSIVE, detail: `consulta à API falhou (${safeMessage(error)})` };
      }
      if (result.status === STATUS.OK || isRoot(sha) || attempt === retries) break;
      await wait(delayMs);
    }
    results.push(result);
  }
  return results;
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
