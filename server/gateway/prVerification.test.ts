// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CompareRead, PullRequestRead, PullRequestSnapshot } from '../github/prTypes.ts';
import { ancestry, evaluatePullRequest, forbiddenPathCodes, MAX_COMMITS, type OrderFacts } from './prVerification.ts';

/** Issue #008 (§6) — regras V1–V13 e critério de ancestralidade (§6.4), funções puras. */

const BASE = 'b'.repeat(40);
const HEAD = 'a1'.repeat(20);
const OTHER = 'c3'.repeat(20);
const ORDER: OrderFacts = { repository: 'owner/repo', repositoryId: 'R_1', baseSha: BASE, workBranch: 'agent/claude-code/33333333-44444444', prNumber: 7 };

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository: { id: 'R_1', nameWithOwner: 'owner/repo' },
    number: 7,
    state: 'OPEN',
    merged: false,
    mergedAt: null,
    isDraft: false,
    headRefName: ORDER.workBranch,
    headRefOid: HEAD,
    baseRefName: 'main',
    isCrossRepository: false,
    headRepositoryId: 'R_1',
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    commits: { total: 1, listed: [{ oid: HEAD, authorLogin: 'po', committerLogin: 'po', signatureValid: null }] },
    lastCommit: { oid: HEAD, rollup: { state: 'SUCCESS', contextsTotal: 1, contexts: [{ name: 'ci', state: 'success' }] } },
    files: { total: 1, paths: ['src/a.ts'], complete: true },
    ...overrides,
  };
}
const read = (pr: PullRequestSnapshot): PullRequestRead => ({ kind: 'ok', digest: 'd'.repeat(64), pr });
const ahead = (overrides: Partial<Extract<CompareRead, { kind: 'ok' }>> = {}): CompareRead => ({ kind: 'ok', digest: 'e'.repeat(64), status: 'ahead', aheadBy: 1, behindBy: 0, baseSha: BASE, mergeBaseSha: BASE, ...overrides });
function run(pr: Partial<PullRequestSnapshot> = {}, compare: CompareRead | null = ahead(), end?: PullRequestRead) {
  const start = read(snapshot(pr));
  return evaluatePullRequest(ORDER, start, compare, end ?? start);
}
function rule(outcome: ReturnType<typeof run>, id: string) {
  if (outcome.kind !== 'verdict') throw new Error(`sem veredito: ${outcome.kind}`);
  return outcome.rules.find((r) => r.rule === id)!;
}
const verdict = (outcome: ReturnType<typeof run>) => (outcome.kind === 'verdict' ? outcome.verdict : outcome.kind);

describe('V1–V13', () => {
  it('PR totalmente conforme → conforming, com as 13 regras na ordem', () => {
    const o = run();
    expect(verdict(o)).toBe('conforming');
    expect(o.kind === 'verdict' && o.rules.map((r) => r.rule)).toEqual(['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13']);
    expect(o.kind === 'verdict' && o.headSha).toBe(HEAD);
  });

  it('V1: repositório errado (nome ou identidade estável) → nonconforming', () => {
    expect(rule(run({ repository: { id: 'R_1', nameWithOwner: 'other/repo' } }), 'V1')).toMatchObject({ result: 'fail', reason: 'repository_mismatch' });
    const renamed = run({ repository: { id: 'R_2', nameWithOwner: 'owner/repo' } });
    expect(rule(renamed, 'V1').result).toBe('fail');
    expect(verdict(renamed)).toBe('nonconforming');
    // Mesmo repositório com outra caixa no nome continua conforme (o GitHub não diferencia).
    expect(verdict(run({ repository: { id: 'R_1', nameWithOwner: 'Owner/Repo' } }))).toBe('conforming');
  });

  it('V2: PR inexistente no repositório autorizado → nonconforming, sem headSha', () => {
    const missing: PullRequestRead = { kind: 'pr_missing', digest: 'f'.repeat(64), repository: { id: 'R_1', nameWithOwner: 'owner/repo' } };
    const o = evaluatePullRequest(ORDER, missing, null, missing);
    expect(verdict(o)).toBe('nonconforming');
    expect(rule(o, 'V2')).toMatchObject({ result: 'fail', reason: 'pr_reference_invalid' });
    expect(o.kind === 'verdict' && o.headSha).toBeNull();
    // Número diferente do vinculado.
    expect(rule(run({ number: 8 }), 'V2').result).toBe('fail');
  });

  it('V3: branch errada → nonconforming', () => {
    const o = run({ headRefName: 'feature/qualquer' });
    expect(rule(o, 'V3')).toMatchObject({ result: 'fail', reason: 'wrong_branch' });
    expect(verdict(o)).toBe('nonconforming');
  });

  it('V4: fork ou cabeça de outro repositório → nonconforming', () => {
    expect(verdict(run({ isCrossRepository: true }))).toBe('nonconforming');
    expect(rule(run({ headRepositoryId: 'R_fork' }), 'V4').result).toBe('fail');
    expect(rule(run({ headRepositoryId: null }), 'V4').result).toBe('fail');
  });

  it('V5: base diferente de main → nonconforming', () => {
    expect(rule(run({ baseRefName: 'develop' }), 'V5')).toMatchObject({ result: 'fail', reason: 'base_not_main' });
  });

  it('V6: ancestralidade — tabela da §6.4', () => {
    expect(ancestry(ahead(), BASE)).toMatchObject({ result: 'ok' });
    expect(ancestry(ahead({ status: 'diverged', behindBy: 2 }), BASE)).toMatchObject({ result: 'fail', reason: 'base_diverged' });
    expect(ancestry(ahead({ status: 'behind', aheadBy: 0, behindBy: 1 }), BASE)).toMatchObject({ result: 'fail', reason: 'base_behind' });
    expect(ancestry(ahead({ status: 'identical', aheadBy: 0 }), BASE)).toMatchObject({ result: 'fail', reason: 'no_new_commits' });
    // Prova incompleta ou que não confere → pendente (nunca ok).
    for (const bad of [ahead({ mergeBaseSha: OTHER }), ahead({ baseSha: OTHER }), ahead({ behindBy: 1 }), ahead({ aheadBy: 0 })]) expect(ancestry(bad, BASE)).toMatchObject({ result: 'pending', reason: 'ancestry_unproven' });
    for (const unproven of [{ kind: 'unproven', reason: 'not_found' }, { kind: 'unproven', reason: 'unprocessable' }, { kind: 'unproven', reason: 'malformed' }] as CompareRead[]) {
      expect(ancestry(unproven, BASE)).toMatchObject({ result: 'pending', reason: 'ancestry_unproven' });
    }
    expect(ancestry(null, BASE).result).toBe('pending');
    expect(verdict(run({}, { kind: 'unproven', reason: 'not_found' }))).toBe('needs_review');
    expect(verdict(run({}, ahead({ status: 'diverged', behindBy: 1 })))).toBe('nonconforming');
  });

  it('V7: PR fechado ou mesclado → nonconforming; mesclado gera alerta', () => {
    expect(rule(run({ state: 'CLOSED' }), 'V7')).toMatchObject({ result: 'fail', reason: 'closed' });
    const merged = run({ state: 'MERGED', merged: true, mergedAt: '2026-11-19T10:00:00Z' });
    expect(rule(merged, 'V7')).toMatchObject({ result: 'fail', reason: 'merged' });
    expect(merged.kind === 'verdict' && merged.details.alerts).toEqual(['merged_outside_flow']);
    // `merged` sem estado coerente também conta como mesclado.
    expect(rule(run({ merged: true }), 'V7').result).toBe('fail');
  });

  it('V8: mais de 250 commits, contagem sem prova ou incoerente → needs_review', () => {
    expect(rule(run({ commits: { total: MAX_COMMITS + 1, listed: [] } }), 'V8')).toMatchObject({ result: 'pending', reason: 'too_many_commits' });
    expect(rule(run({}, { kind: 'unproven', reason: 'malformed' }), 'V8').reason).toBe('commit_count_unproven');
    expect(rule(run({ commits: { total: 0, listed: [] } }), 'V8').reason).toBe('commit_count_mismatch');
    // Diferença por commits de merge da main (aheadBy ≠ total, ambos > 0) não é falha.
    expect(rule(run({ commits: { total: 3, listed: [] } }, ahead({ aheadBy: 5 })), 'V8').result).toBe('ok');
  });

  it('V9: proveniência só declarada (informativa); mais de 100 commits → aviso', () => {
    expect(rule(run(), 'V9')).toMatchObject({ result: 'info', reason: 'declared_only' });
    expect(rule(run({ commits: { total: 120, listed: [] } }, ahead({ aheadBy: 120 })), 'V9').reason).toBe('declared_first_100');
  });

  it('V10: workflows, githooks, segredos ou lista incompleta → needs_review (só códigos)', () => {
    expect(rule(run({ files: { total: 1, paths: ['.github/workflows/ci.yml'], complete: true } }), 'V10')).toMatchObject({ result: 'pending', reason: 'forbidden_workflows' });
    expect(rule(run({ files: { total: 1, paths: ['.githooks/pre-push'], complete: true } }), 'V10').reason).toBe('forbidden_githooks');
    expect(rule(run({ files: { total: 301, paths: ['a'], complete: false } }), 'V10').reason).toBe('files_incomplete');
    expect(forbiddenPathCodes(['.env', 'config/.env.local', 'keys/server.pem', 'id_rsa', '.npmrc', 'secrets.json', 'src/ok.ts'])).toEqual(['credentials_file', 'env_file', 'key_material']);
    expect(forbiddenPathCodes(['src/environment.ts', 'docs/github/workflows.md'])).toEqual([]);
  });

  it('V11: checks pendentes, falhando, ausentes, incompletos ou de outro SHA → needs_review', () => {
    const roll = (state: 'SUCCESS' | 'PENDING' | 'FAILURE', contexts: Array<{ name: string; state: 'success' | 'pending' | 'failure' }>, total = contexts.length) => ({ lastCommit: { oid: HEAD, rollup: { state, contextsTotal: total, contexts } } });
    expect(rule(run(roll('PENDING', [{ name: 'ci', state: 'pending' }])), 'V11').reason).toBe('checks_pending');
    const failing = run(roll('FAILURE', [{ name: 'ci', state: 'failure' }]));
    expect(rule(failing, 'V11').reason).toBe('checks_failing');
    expect(verdict(failing)).toBe('needs_review');
    expect(failing.kind === 'verdict' && failing.details.checks.failing).toEqual(['ci']);
    expect(rule(run({ lastCommit: { oid: HEAD, rollup: null } }), 'V11').reason).toBe('checks_missing');
    expect(rule(run(roll('SUCCESS', [{ name: 'ci', state: 'success' }], 150)), 'V11').reason).toBe('checks_incomplete');
    // Rollup "SUCCESS" com um contexto falho não conta como verde.
    expect(rule(run(roll('SUCCESS', [{ name: 'a', state: 'success' }, { name: 'b', state: 'failure' }])), 'V11').result).toBe('pending');
  });

  it('V12: HEAD alterado entre as leituras, ou último commit diferente da cabeça → descartado, nada a gravar', () => {
    const start = read(snapshot());
    const end = read(snapshot({ headRefOid: OTHER, lastCommit: { oid: OTHER, rollup: null } }));
    expect(evaluatePullRequest(ORDER, start, ahead(), end)).toEqual({ kind: 'head_changed', observedHeadSha: OTHER });
    expect(run({ lastCommit: { oid: OTHER, rollup: null } }).kind).toBe('head_changed');
    // PR some entre as leituras.
    expect(evaluatePullRequest(ORDER, start, ahead(), { kind: 'pr_missing', digest: 'f'.repeat(64), repository: { id: 'R_1', nameWithOwner: 'owner/repo' } }).kind).toBe('head_changed');
  });

  it('V13: draft, mergeabilidade e revisão são só informativos (não viram autorização nem falha)', () => {
    const draft = run({ isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' });
    expect(rule(draft, 'V13')).toMatchObject({ result: 'info', reason: 'draft' });
    expect(verdict(draft)).toBe('conforming');
    expect(draft.kind === 'verdict' && draft.details.state).toMatchObject({ isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED' });
  });

  it('resposta malformada nunca vira sucesso', () => {
    const ok = read(snapshot());
    expect(evaluatePullRequest(ORDER, { kind: 'malformed' }, null, ok)).toEqual({ kind: 'invalid_read' });
    expect(evaluatePullRequest(ORDER, ok, ahead(), { kind: 'malformed' })).toEqual({ kind: 'invalid_read' });
    expect(run({ headRefOid: 'nao-e-sha' }).kind).not.toBe('verdict');
  });

  it('falha eliminatória vence pendência: nonconforming mesmo com checks pendentes', () => {
    expect(verdict(run({ headRefName: 'x', lastCommit: { oid: HEAD, rollup: null } }))).toBe('nonconforming');
  });
});
