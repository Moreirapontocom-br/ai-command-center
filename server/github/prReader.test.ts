// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { GraphQLClient, RestCompareClient } from './client.ts';
import { IntegrationError } from './errors.ts';
import { createPullRequestReader, normalizeCompare } from './prReader.ts';
import { MAIN_HEAD_QUERY, PR_VERIFICATION_QUERY } from './queries.ts';

/** Issue #008 — leitor de PRs: só os documentos aprovados, normalização fechada e erros sem gravação. */

const HEAD = 'a1'.repeat(20);
const BASE = 'b'.repeat(40);

function rawPr(overrides: Record<string, unknown> = {}, files: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: 'OPEN',
    merged: false,
    mergedAt: null,
    isDraft: false,
    headRefName: 'agent/claude-code/33333333-44444444',
    headRefOid: HEAD,
    baseRefName: 'main',
    isCrossRepository: false,
    headRepository: { id: 'R_1' },
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    commits: { totalCount: 1, nodes: [{ commit: { oid: HEAD, author: { user: { login: 'po' } }, committer: { user: null }, signature: null } }] },
    lastCommit: {
      nodes: [
        {
          commit: {
            oid: HEAD,
            statusCheckRollup: {
              state: 'SUCCESS',
              contexts: { totalCount: 2, nodes: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS' }] },
            },
          },
        },
      ],
    },
    files: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ path: 'src/a.ts' }], ...files },
    ...overrides,
  };
}
const data = (pullRequest: unknown, repository: Record<string, unknown> = {}) => ({ rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-11-19T13:00:00Z' }, repository: { id: 'R_1', nameWithOwner: 'owner/repo', pullRequest, ...repository } });

function reader(pages: unknown[], rest?: Partial<RestCompareClient>) {
  const query = vi.fn(async (document: string, variables: Record<string, string | number>) => {
    void document;
    void variables;
    const next = pages.shift();
    if (next instanceof Error) throw next;
    return { data: next, partialErrors: [] };
  });
  const graphql = { query } as unknown as GraphQLClient;
  const compare = vi.fn(rest?.compare ?? (async () => ({ status: 200 as const, body: { status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, commits: [{}], files: [] } })));
  return { r: createPullRequestReader({ graphql, rest: { compare } }), query, compare };
}

describe('leitura do PR (GraphQL aprovado)', () => {
  it('normaliza o PR completo; usa só o documento aprovado e as variáveis fechadas', async () => {
    const { r, query } = reader([data(rawPr())]);
    const read = await r.pullRequest('owner/repo', 7);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.pr).toMatchObject({ number: 7, headRefOid: HEAD, headRepositoryId: 'R_1', commits: { total: 1 }, files: { total: 1, paths: ['src/a.ts'], complete: true } });
    expect(read.pr.lastCommit!.rollup!.contexts).toEqual([
      { name: 'build', state: 'success' },
      { name: 'ci/legacy', state: 'success' },
    ]);
    expect(read.pr.commits.listed[0]).toEqual({ oid: HEAD, authorLogin: 'po', committerLogin: null, signatureValid: null });
    expect(read.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(query).toHaveBeenCalledWith(PR_VERIFICATION_QUERY, { owner: 'owner', name: 'repo', number: 7 });
  });

  it('PR inexistente → pr_missing; repositório ilegível → erro de autorização (nada gravado)', async () => {
    expect((await reader([data(null)]).r.pullRequest('owner/repo', 7)).kind).toBe('pr_missing');
    await expect(reader([{ rateLimit: {}, repository: null }]).r.pullRequest('owner/repo', 7)).rejects.toMatchObject({ code: 'github_unauthorized' });
  });

  it.each([
    ['estado desconhecido', { state: 'WEIRD' }],
    ['SHA da cabeça inválido', { headRefOid: 'abc' }],
    ['tipo errado', { merged: 'no' }],
    ['campo ausente', { headRefName: undefined }],
    ['mergeable fora da lista', { mergeable: 'MAYBE' }],
    ['check desconhecido', { lastCommit: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'SUCCESS', contexts: { totalCount: 1, nodes: [{ __typename: 'Other' }] } } } }] } }],
    ['commits listados acima do total', { commits: { totalCount: 0, nodes: [{ commit: { oid: HEAD, author: null, committer: null, signature: null } }] } }],
  ])('resposta malformada (%s) → malformed (nunca sucesso)', async (_name, overrides) => {
    expect((await reader([data(rawPr(overrides as Record<string, unknown>))]).r.pullRequest('owner/repo', 7)).kind).toBe('malformed');
  });

  it('checks: em andamento → pendente; falha/cancelado/timeout → falha; neutro/ignorado → sucesso', async () => {
    const contexts = [
      { __typename: 'CheckRun', name: 'a', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'd', state: 'EXPECTED' },
      { __typename: 'StatusContext', context: 'e', state: 'ERROR' },
    ];
    const read = await reader([data(rawPr({ lastCommit: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: { state: 'PENDING', contexts: { totalCount: 5, nodes: contexts } } } }] } }))]).r.pullRequest('owner/repo', 7);
    expect(read.kind === 'ok' && read.pr.lastCommit!.rollup!.contexts.map((c) => c.state)).toEqual(['pending', 'failure', 'success', 'pending', 'failure']);
  });

  it('arquivos: até 3 páginas da MESMA cabeça; mais que isso → incompleto; cabeça mudou entre páginas → malformed', async () => {
    const page = (n: number, hasNext: boolean, cursor: string | null, total = 250) => ({ totalCount: total, pageInfo: { hasNextPage: hasNext, endCursor: cursor }, nodes: Array.from({ length: n }, (_, i) => ({ path: `f${cursor}-${i}` })) });
    const three = reader([data(rawPr({}, page(100, true, 'c1'))), data(rawPr({}, page(100, true, 'c2'))), data(rawPr({}, page(50, false, null)))]);
    const ok = await three.r.pullRequest('owner/repo', 7);
    expect(ok.kind === 'ok' && ok.pr.files).toMatchObject({ total: 250, complete: true });
    expect(ok.kind === 'ok' && ok.pr.files.paths).toHaveLength(250);
    expect(three.query.mock.calls.map((c) => c[1])).toEqual([
      { owner: 'owner', name: 'repo', number: 7 },
      { owner: 'owner', name: 'repo', number: 7, filesAfter: 'c1' },
      { owner: 'owner', name: 'repo', number: 7, filesAfter: 'c2' },
    ]);
    const tooMany = await reader([data(rawPr({}, page(100, true, 'c1', 400))), data(rawPr({}, page(100, true, 'c2', 400))), data(rawPr({}, page(100, true, 'c3', 400)))]).r.pullRequest('owner/repo', 7);
    expect(tooMany.kind === 'ok' && tooMany.pr.files.complete).toBe(false);
    const moved = await reader([data(rawPr({}, page(100, true, 'c1'))), data(rawPr({ headRefOid: 'c'.repeat(40) }, page(100, false, null)))]).r.pullRequest('owner/repo', 7);
    expect(moved.kind).toBe('malformed');
  });

  it('erros da integração: limite/rede/timeout → indisponível; credencial → não autorizado', async () => {
    for (const code of ['rate_limited', 'network', 'timeout', 'upstream_error', 'upstream_invalid'] as const) {
      await expect(reader([new IntegrationError(code, { retryAfterSeconds: 9 })]).r.pullRequest('owner/repo', 7)).rejects.toMatchObject({ code: 'github_unavailable' });
    }
    for (const code of ['unauthorized', 'forbidden', 'missing_credentials'] as const) {
      await expect(reader([new IntegrationError(code)]).r.pullRequest('owner/repo', 7)).rejects.toMatchObject({ code: 'github_unauthorized' });
    }
    // Repositório com formato inválido nunca chega à rede.
    const r = reader([]);
    await expect(r.r.pullRequest('owner/repo/x', 7)).rejects.toMatchObject({ code: 'github_unauthorized' });
    expect(r.query).not.toHaveBeenCalled();
  });
});

describe('SHA de main (preparação)', () => {
  it('lê id estável, nome e SHA de refs/heads/main com o documento aprovado', async () => {
    const { r, query } = reader([{ rateLimit: {}, repository: { id: 'R_1', nameWithOwner: 'owner/repo', ref: { name: 'main', target: { oid: BASE } } } }]);
    expect(await r.mainHead('owner/repo')).toEqual({ repositoryId: 'R_1', nameWithOwner: 'owner/repo', sha: BASE });
    expect(query).toHaveBeenCalledWith(MAIN_HEAD_QUERY, { owner: 'owner', name: 'repo' });
  });

  it('sem main, SHA inválido ou repositório ilegível → erro (nada é preparado)', async () => {
    await expect(reader([{ rateLimit: {}, repository: { id: 'R_1', nameWithOwner: 'owner/repo', ref: null } }]).r.mainHead('owner/repo')).rejects.toMatchObject({ code: 'github_unavailable' });
    await expect(reader([{ rateLimit: {}, repository: { id: 'R_1', nameWithOwner: 'owner/repo', ref: { name: 'main', target: { oid: 'x' } } } }]).r.mainHead('owner/repo')).rejects.toMatchObject({ code: 'github_unavailable' });
    await expect(reader([{ rateLimit: {}, repository: null }]).r.mainHead('owner/repo')).rejects.toMatchObject({ code: 'github_unauthorized' });
  });
});

describe('comparação REST (§6.4)', () => {
  it('200 completo → ok; 404/422 → sem prova; campo ausente ou tipo errado → sem prova', async () => {
    const { r, compare } = reader([]);
    expect(await r.compare('owner/repo', BASE, HEAD)).toMatchObject({ kind: 'ok', status: 'ahead', aheadBy: 1, behindBy: 0, baseSha: BASE, mergeBaseSha: BASE });
    expect(compare).toHaveBeenCalledWith('owner', 'repo', BASE, HEAD);
    expect(await reader([], { compare: async () => ({ status: 404 }) }).r.compare('owner/repo', BASE, HEAD)).toEqual({ kind: 'unproven', reason: 'not_found' });
    expect(await reader([], { compare: async () => ({ status: 422 }) }).r.compare('owner/repo', BASE, HEAD)).toEqual({ kind: 'unproven', reason: 'unprocessable' });
    for (const body of [{}, { status: 'ahead', ahead_by: '1', behind_by: 0, base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } }, { status: 'sideways', ahead_by: 1, behind_by: 0, base_commit: { sha: BASE }, merge_base_commit: { sha: BASE } }, { status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: BASE } }, null]) {
      expect(normalizeCompare(body)).toEqual({ kind: 'unproven', reason: 'malformed' });
    }
  });

  it('401/403/5xx/timeout → erro sem gravação', async () => {
    await expect(reader([], { compare: async () => Promise.reject(new IntegrationError('unauthorized')) }).r.compare('owner/repo', BASE, HEAD)).rejects.toMatchObject({ code: 'github_unauthorized' });
    await expect(reader([], { compare: async () => Promise.reject(new IntegrationError('forbidden')) }).r.compare('owner/repo', BASE, HEAD)).rejects.toMatchObject({ code: 'github_unauthorized' });
    await expect(reader([], { compare: async () => Promise.reject(new IntegrationError('upstream_error')) }).r.compare('owner/repo', BASE, HEAD)).rejects.toMatchObject({ code: 'github_unavailable' });
    await expect(reader([], { compare: async () => Promise.reject(new IntegrationError('timeout')) }).r.compare('owner/repo', BASE, HEAD)).rejects.toMatchObject({ code: 'github_unavailable' });
  });
});
