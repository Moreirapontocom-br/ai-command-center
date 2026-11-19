import type { CompareRead, PullRequestRead, PullRequestSnapshot } from '../github/prTypes.ts';
import { PR_RULES, type PrRule, type PrRuleResult, type PrVerdict } from './contracts.ts';

/**
 * Verificação do PR de uma ordem do Claude Code (Issue #008, §6) — FUNÇÕES PURAS sobre leituras já
 * normalizadas (sem rede, relógio, armazenamento nem credencial).
 *
 * Princípios:
 * - sem prova, sem conformidade: regra sem prova completa → `pending` (`needs_review`), nunca `ok`;
 * - falha eliminatória COMPROVADA (V1–V7) → `nonconforming` (entrada final);
 * - V9 (proveniência DECLARADA) e V13 (estado) são só informativos: o ACC não prova autoria;
 * - checks verdes NÃO autorizam merge: o resultado nunca cria nem sugere aprovação de merge;
 * - V12: a cabeça do PR precisa ser a mesma no início e no fim da leitura; se mudou, a leitura
 *   inteira é descartada (`head_changed`) e nada é gravado.
 */

export interface OrderFacts {
  repository: string;
  repositoryId: string;
  baseSha: string;
  workBranch: string;
  prNumber: number;
}

export interface RuleRow {
  rule: PrRule;
  result: PrRuleResult;
  reason: string | null;
}

/** Detalhes exibidos na resposta da verificação (NUNCA gravados no ledger). */
export interface VerificationDetails {
  alerts: string[];
  checks: { state: string | null; failing: string[]; pending: string[]; total: number };
  commits: { total: number; listed: number; truncated: boolean; authors: Array<{ author: string | null; committer: string | null; signatureValid: boolean | null }> };
  files: { total: number; complete: boolean; forbidden: string[] };
  state: { isDraft: boolean | null; mergeable: string | null; reviewDecision: string | null; prState: string | null };
  compare: { status: string | null; aheadBy: number | null; behindBy: number | null };
}

export type VerificationOutcome =
  | { kind: 'verdict'; headSha: string | null; verdict: PrVerdict; rules: RuleRow[]; evidence: { pullRequest: string; compare: string | null; confirm: string }; details: VerificationDetails }
  /** A cabeça mudou entre as leituras (V12): descartar e pedir nova verificação. */
  | { kind: 'head_changed'; observedHeadSha: string | null }
  /** Leitura sem formato reconhecível: nada é gravado (nunca vira sucesso). */
  | { kind: 'invalid_read' };

/** Caminhos proibidos (V10): só os CÓDIGOS são guardados, nunca os caminhos. */
const FORBIDDEN_PATHS: ReadonlyArray<{ code: string; test: (path: string) => boolean }> = [
  { code: 'workflows', test: (p) => p.startsWith('.github/workflows/') },
  { code: 'githooks', test: (p) => p.startsWith('.githooks/') },
  { code: 'env_file', test: (p) => /(^|\/)\.env($|\.)/.test(p) },
  { code: 'key_material', test: (p) => /\.(pem|key|p12|pfx|jks|keystore)$/i.test(p) || /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(p) },
  { code: 'credentials_file', test: (p) => /(^|\/)(credentials|secrets?)(\.[a-z]+)?$/i.test(p) || /(^|\/)\.(npmrc|pypirc|netrc|git-credentials)$/.test(p) },
];

export function forbiddenPathCodes(paths: readonly string[]): string[] {
  const found = new Set<string>();
  for (const path of paths) for (const f of FORBIDDEN_PATHS) if (f.test(path)) found.add(f.code);
  return [...found].sort();
}

const SHA = /^[0-9a-f]{40}$/;
const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Limite de commits do PR antes de exigir revisão (V8; a comparação REST lista até 250). */
export const MAX_COMMITS = 250;

/** Critério de prova da ancestralidade (§6.4), com a cabeça já confirmada pelas leituras GraphQL. */
export function ancestry(compare: CompareRead | null, baseSha: string): RuleRow {
  if (!compare || compare.kind !== 'ok') return { rule: 'V6', result: 'pending', reason: 'ancestry_unproven' };
  if (compare.status === 'diverged' || compare.status === 'behind') return { rule: 'V6', result: 'fail', reason: `base_${compare.status}` };
  if (compare.status === 'identical') return { rule: 'V6', result: 'fail', reason: 'no_new_commits' };
  const proven = compare.status === 'ahead' && compare.behindBy === 0 && compare.aheadBy >= 1 && compare.baseSha === baseSha && compare.mergeBaseSha === baseSha;
  return proven ? { rule: 'V6', result: 'ok', reason: null } : { rule: 'V6', result: 'pending', reason: 'ancestry_unproven' };
}

function checks(pr: PullRequestSnapshot): { row: RuleRow; failing: string[]; pending: string[]; state: string | null; total: number } {
  const last = pr.lastCommit;
  if (!last || last.oid !== pr.headRefOid) return { row: { rule: 'V11', result: 'pending', reason: 'checks_wrong_sha' }, failing: [], pending: [], state: null, total: 0 };
  const rollup = last.rollup;
  if (!rollup || rollup.contexts.length === 0) return { row: { rule: 'V11', result: 'pending', reason: 'checks_missing' }, failing: [], pending: [], state: rollup?.state ?? null, total: rollup?.contextsTotal ?? 0 };
  const failing = rollup.contexts.filter((c) => c.state === 'failure').map((c) => c.name);
  const pending = rollup.contexts.filter((c) => c.state === 'pending').map((c) => c.name);
  const base = { failing, pending, state: rollup.state, total: rollup.contextsTotal };
  if (rollup.contextsTotal > rollup.contexts.length) return { ...base, row: { rule: 'V11', result: 'pending', reason: 'checks_incomplete' } };
  if (failing.length > 0 || rollup.state === 'FAILURE' || rollup.state === 'ERROR') return { ...base, row: { rule: 'V11', result: 'pending', reason: 'checks_failing' } };
  if (pending.length > 0 || rollup.state !== 'SUCCESS') return { ...base, row: { rule: 'V11', result: 'pending', reason: 'checks_pending' } };
  return { ...base, row: { rule: 'V11', result: 'ok', reason: null } };
}

function emptyDetails(): VerificationDetails {
  return {
    alerts: [],
    checks: { state: null, failing: [], pending: [], total: 0 },
    commits: { total: 0, listed: 0, truncated: false, authors: [] },
    files: { total: 0, complete: false, forbidden: [] },
    state: { isDraft: null, mergeable: null, reviewDecision: null, prState: null },
    compare: { status: null, aheadBy: null, behindBy: null },
  };
}

/** Veredito a partir das regras: falha (V1–V7) encerra; pendência pede revisão; senão, conforme. */
export function verdictOf(rules: readonly RuleRow[]): PrVerdict {
  if (rules.some((r) => r.result === 'fail')) return 'nonconforming';
  if (rules.some((r) => r.result === 'pending')) return 'needs_review';
  return 'conforming';
}

/**
 * Avalia V1–V13. `start` e `end` são duas leituras completas do PR (início e fim); `compare` é a
 * comparação REST feita com a cabeça lida no início (ou `null` se nem chegou a ser feita).
 */
export function evaluatePullRequest(order: OrderFacts, start: PullRequestRead, compare: CompareRead | null, end: PullRequestRead): VerificationOutcome {
  if (start.kind === 'malformed' || end.kind === 'malformed') return { kind: 'invalid_read' };
  const details = emptyDetails();

  // V12 primeiro: a leitura só vale se a cabeça (e a existência do PR) for a mesma nas duas pontas.
  const head = (r: PullRequestRead) => (r.kind === 'ok' ? r.pr.headRefOid : null);
  if (start.kind !== end.kind || head(start) !== head(end)) return { kind: 'head_changed', observedHeadSha: head(end) };

  const repository = start.kind === 'ok' ? start.pr.repository : start.repository;
  const v1Ok = sameRepo(repository.nameWithOwner, order.repository) && repository.id === order.repositoryId;
  const rows: RuleRow[] = [{ rule: 'V1', result: v1Ok ? 'ok' : 'fail', reason: v1Ok ? null : 'repository_mismatch' }];

  if (start.kind === 'pr_missing') {
    // PR inexistente no repositório autorizado (V2): falha comprovada; nada mais a verificar.
    rows.push({ rule: 'V2', result: 'fail', reason: 'pr_reference_invalid' });
    for (const rule of PR_RULES.slice(2)) rows.push({ rule, result: rule === 'V9' || rule === 'V13' ? 'info' : 'pending', reason: 'not_checked' });
    return { kind: 'verdict', headSha: null, verdict: 'nonconforming', rules: rows, evidence: { pullRequest: start.digest, compare: null, confirm: (end as { digest: string }).digest }, details };
  }

  const pr = start.pr;
  if (!SHA.test(pr.headRefOid)) return { kind: 'invalid_read' };
  // A última página da lista de commits precisa terminar na cabeça lida (V12).
  if (pr.lastCommit && pr.lastCommit.oid !== pr.headRefOid) return { kind: 'head_changed', observedHeadSha: pr.headRefOid };

  rows.push({ rule: 'V2', result: pr.number === order.prNumber && v1Ok ? 'ok' : 'fail', reason: pr.number === order.prNumber && v1Ok ? null : 'pr_reference_invalid' });
  rows.push({ rule: 'V3', result: pr.headRefName === order.workBranch ? 'ok' : 'fail', reason: pr.headRefName === order.workBranch ? null : 'wrong_branch' });
  const fork = pr.isCrossRepository || pr.headRepositoryId === null || pr.headRepositoryId !== repository.id;
  rows.push({ rule: 'V4', result: fork ? 'fail' : 'ok', reason: fork ? 'fork_or_foreign_head' : null });
  rows.push({ rule: 'V5', result: pr.baseRefName === 'main' ? 'ok' : 'fail', reason: pr.baseRefName === 'main' ? null : 'base_not_main' });
  rows.push(ancestry(compare, order.baseSha));

  const merged = pr.merged || pr.mergedAt !== null || pr.state === 'MERGED';
  if (merged) details.alerts.push('merged_outside_flow');
  rows.push({ rule: 'V7', result: !merged && pr.state === 'OPEN' ? 'ok' : 'fail', reason: merged ? 'merged' : pr.state === 'OPEN' ? null : 'closed' });

  // V8: total de commits do PR coerente com a comparação e abaixo do limite.
  const aheadBy = compare && compare.kind === 'ok' ? compare.aheadBy : null;
  let v8: RuleRow;
  if (pr.commits.total > MAX_COMMITS) v8 = { rule: 'V8', result: 'pending', reason: 'too_many_commits' };
  else if (aheadBy === null) v8 = { rule: 'V8', result: 'pending', reason: 'commit_count_unproven' };
  else if ((aheadBy === 0) !== (pr.commits.total === 0)) v8 = { rule: 'V8', result: 'pending', reason: 'commit_count_mismatch' };
  else v8 = { rule: 'V8', result: 'ok', reason: null };
  rows.push(v8);

  // V9: proveniência DECLARADA (logins e assinatura), só informativa.
  const truncated = pr.commits.total > pr.commits.listed.length;
  rows.push({ rule: 'V9', result: 'info', reason: truncated ? 'declared_first_100' : 'declared_only' });

  // V10: caminhos proibidos e lista completa.
  const forbidden = forbiddenPathCodes(pr.files.paths);
  let v10: RuleRow;
  if (forbidden.length > 0) v10 = { rule: 'V10', result: 'pending', reason: `forbidden_${forbidden[0]}` };
  else if (!pr.files.complete) v10 = { rule: 'V10', result: 'pending', reason: 'files_incomplete' };
  else v10 = { rule: 'V10', result: 'ok', reason: null };
  rows.push(v10);

  const c = checks(pr);
  rows.push(c.row);
  rows.push({ rule: 'V12', result: 'ok', reason: null });
  rows.push({ rule: 'V13', result: 'info', reason: pr.isDraft ? 'draft' : null });

  details.checks = { state: c.state, failing: c.failing, pending: c.pending, total: c.total };
  details.commits = {
    total: pr.commits.total,
    listed: pr.commits.listed.length,
    truncated,
    authors: pr.commits.listed.map((x) => ({ author: x.authorLogin, committer: x.committerLogin, signatureValid: x.signatureValid })),
  };
  details.files = { total: pr.files.total, complete: pr.files.complete, forbidden };
  details.state = { isDraft: pr.isDraft, mergeable: pr.mergeable, reviewDecision: pr.reviewDecision, prState: pr.state };
  details.compare = compare && compare.kind === 'ok' ? { status: compare.status, aheadBy: compare.aheadBy, behindBy: compare.behindBy } : { status: null, aheadBy: null, behindBy: null };

  const verdict = verdictOf(rows);
  return {
    kind: 'verdict',
    headSha: pr.headRefOid,
    verdict,
    rules: rows,
    evidence: { pullRequest: start.digest, compare: compare && compare.kind === 'ok' ? compare.digest : null, confirm: end.digest },
    details,
  };
}
