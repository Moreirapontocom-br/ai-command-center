// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rawIssue, rawPullRequest, rawRepository, rawSnapshot } from '../test/fixtures.ts';
import { IntegrationError } from './errors.ts';
import { mapCiState, mapReviewState, normalizePullRequest, normalizeSnapshot } from './normalize.ts';

const NOW = new Date('2026-11-10T21:00:00Z');
const REPO = 'Moreirapontocom-br/ai-command-center';

describe('normalizeSnapshot', () => {
  it('converte um repositório acessível para o contrato interno', () => {
    const snapshot = normalizeSnapshot(rawSnapshot(), [], NOW);

    expect(snapshot.repository).toMatchObject({
      fullName: REPO,
      url: `https://github.com/${REPO}`,
      isPrivate: true,
      defaultBranch: 'main',
    });
    expect(snapshot.metrics).toMatchObject({
      openIssues: 1,
      openPullRequests: 1,
      mergedPullRequests: 1,
      branches: 2,
      ci: { defaultBranch: 'success', openPullRequests: { success: 1, failure: 0, pending: 0, unknown: 0 } },
    });
    expect(snapshot.issues[0]).toEqual({
      number: 7,
      title: 'Issue simulada',
      repository: REPO,
      state: 'open',
      stateReason: null,
      assignees: [{ login: 'dev-a', url: 'https://github.com/dev-a' }],
      labels: [{ name: 'bug', color: 'd73a4a' }],
      updatedAt: '2026-11-09T12:00:00Z',
      url: `https://github.com/${REPO}/issues/7`,
    });
    expect(snapshot.branches.map((b) => [b.name, b.isDefault])).toEqual([
      ['main', true],
      ['feature/002-github-integration', false],
    ]);
    expect(snapshot.fetchedAt).toBe(NOW.toISOString());
    expect(snapshot.warnings).toEqual([]);
  });

  it('não inventa dados para um repositório sem issues nem PRs', () => {
    const snapshot = normalizeSnapshot(
      rawSnapshot({
        openIssueCount: { totalCount: 0 },
        openPullRequestCount: { totalCount: 0 },
        mergedPullRequestCount: { totalCount: 0 },
        openIssues: { nodes: [] },
        openPullRequests: { nodes: [] },
        recentClosedPullRequests: { nodes: [] },
      }),
      [],
      NOW,
    );
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.pullRequests).toEqual([]);
    expect(snapshot.metrics.openIssues).toBe(0);
    expect(snapshot.metrics.awaitingReview).toEqual({ count: 0, undetermined: 0, complete: true });
    expect(snapshot.metrics.ci.openPullRequests).toEqual({ success: 0, failure: 0, pending: 0, unknown: 0 });
  });

  it('descarta itens com campos obrigatórios ausentes e registra aviso', () => {
    const snapshot = normalizeSnapshot(
      rawSnapshot({
        openIssues: {
          nodes: [
            rawIssue(),
            rawIssue({ number: null }),
            rawIssue({ title: '' }),
            rawIssue({ url: 'javascript:alert(1)' }),
            rawIssue({ url: 'https://evil.example/issues/1' }),
            null,
          ],
        },
      }),
      [],
      NOW,
    );
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.warnings).toContain('4 issues ignorado(s) por dados incompletos.');
  });

  it('trata campos opcionais ausentes ou inválidos como indisponíveis', () => {
    const snapshot = normalizeSnapshot(
      rawSnapshot({
        openIssues: { nodes: [rawIssue({ assignees: null, labels: { nodes: [{ name: 'x', color: 'zzz' }, { name: null }] } })] },
        defaultBranchRef: null,
        refs: { totalCount: 1, nodes: [{ name: 'main', target: null }] },
      }),
      [],
      NOW,
    );
    expect(snapshot.issues[0].assignees).toEqual([]);
    expect(snapshot.issues[0].labels).toEqual([{ name: 'x', color: null }]);
    expect(snapshot.repository.defaultBranch).toBeNull();
    expect(snapshot.metrics.ci.defaultBranch).toBe('unknown');
    expect(snapshot.branches[0]).toMatchObject({ headSha: null, committedAt: null, ci: 'unknown' });
  });

  it('converte erros parciais do GraphQL em avisos sanitizados', () => {
    const snapshot = normalizeSnapshot(
      rawSnapshot(),
      [{ type: 'FORBIDDEN', message: `segredo ${'x'.repeat(5)}`, path: ['repository', 'refs', 0, '<script>'] }],
      NOW,
    );
    expect(snapshot.warnings).toEqual([
      'Dados parciais: o campo "repository.refs.0.script" não pôde ser lido (FORBIDDEN).',
    ]);
  });

  it('marca listas truncadas e contagem parcial de revisão', () => {
    const snapshot = normalizeSnapshot(
      rawSnapshot({ openPullRequestCount: { totalCount: 80 }, openIssueCount: { totalCount: 120 } }),
      [],
      NOW,
    );
    expect(snapshot.truncated).toMatchObject({ openIssues: true, openPullRequests: true });
    expect(snapshot.metrics.awaitingReview.complete).toBe(false);
  });

  it('lança "forbidden" quando o repositório não é acessível ao token (NOT_FOUND)', () => {
    expect(() =>
      normalizeSnapshot({ repository: null }, [{ type: 'NOT_FOUND', path: ['repository'] }], NOW),
    ).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });

  it('lança "upstream_invalid" para respostas inesperadas', () => {
    for (const data of [
      {},
      { repository: rawRepository({ nameWithOwner: null }) },
      { repository: rawRepository({ openIssueCount: null }) },
      { repository: rawRepository({ refs: { totalCount: -1, nodes: [] } }) },
    ]) {
      expect(() => normalizeSnapshot(data, [], NOW)).toThrow(IntegrationError);
      expect(() => normalizeSnapshot(data, [], NOW)).toThrow(
        expect.objectContaining({ code: 'upstream_invalid' }),
      );
    }
  });
});

describe('Pull Requests', () => {
  it('PR em draft: aberto, sem estado de revisão aplicável', () => {
    const pr = normalizePullRequest(rawPullRequest({ isDraft: true, reviewDecision: 'REVIEW_REQUIRED' }), REPO);
    expect(pr).toMatchObject({ state: 'open', isDraft: true, review: 'not_applicable' });
  });

  it('PR aberto sem exigência de revisão não é contado como aguardando revisão', () => {
    const pr = normalizePullRequest(rawPullRequest({ reviewDecision: null }), REPO);
    expect(pr).toMatchObject({ state: 'open', isDraft: false, review: 'unknown' });
  });

  it('PR aberto com revisão exigida ou revisor solicitado aguarda revisão', () => {
    expect(normalizePullRequest(rawPullRequest({ reviewDecision: 'REVIEW_REQUIRED' }), REPO)?.review).toBe('pending');
    expect(normalizePullRequest(rawPullRequest({ reviewRequests: { totalCount: 2 } }), REPO)?.review).toBe('pending');
  });

  it('PR fechado sem merge', () => {
    const pr = normalizePullRequest(
      rawPullRequest({ state: 'CLOSED', closedAt: '2026-11-10T11:00:00Z', reviewDecision: 'REVIEW_REQUIRED' }),
      REPO,
    );
    expect(pr).toMatchObject({ state: 'closed', mergedAt: null, closedAt: '2026-11-10T11:00:00Z', review: 'not_applicable' });
  });

  it('PR incorporado', () => {
    const pr = normalizePullRequest(rawPullRequest({ state: 'MERGED', mergedAt: '2026-11-10T20:03:05Z' }), REPO);
    expect(pr).toMatchObject({ state: 'merged', mergedAt: '2026-11-10T20:03:05Z', review: 'not_applicable' });
  });

  it('PR com estado desconhecido é descartado', () => {
    expect(normalizePullRequest(rawPullRequest({ state: 'WEIRD' }), REPO)).toBeNull();
  });

  it('conta aguardando revisão apenas quando confirmado', () => {
    const snapshot = normalizeSnapshot(
      rawSnapshot({
        openPullRequestCount: { totalCount: 4 },
        openPullRequests: {
          nodes: [
            rawPullRequest({ number: 10, reviewDecision: 'REVIEW_REQUIRED' }),
            rawPullRequest({ number: 11, reviewDecision: 'APPROVED' }),
            rawPullRequest({ number: 12, reviewDecision: null }),
            rawPullRequest({ number: 13, isDraft: true }),
          ],
        },
      }),
      [],
      NOW,
    );
    expect(snapshot.metrics.awaitingReview).toEqual({ count: 1, undetermined: 1, complete: true });
  });
});

describe('mapeamentos', () => {
  it('mapeia o estado de CI do GitHub', () => {
    expect(mapCiState({ state: 'SUCCESS' })).toBe('success');
    expect(mapCiState({ state: 'FAILURE' })).toBe('failure');
    expect(mapCiState({ state: 'ERROR' })).toBe('failure');
    expect(mapCiState({ state: 'PENDING' })).toBe('pending');
    expect(mapCiState({ state: 'EXPECTED' })).toBe('pending');
    expect(mapCiState(null)).toBe('unknown');
    expect(mapCiState({ state: 'NOVO_ESTADO' })).toBe('unknown');
  });

  it('alterações solicitadas', () => {
    expect(
      mapReviewState({ state: 'open', isDraft: false, reviewDecision: 'CHANGES_REQUESTED', requestedReviewers: 0 }),
    ).toBe('changes_requested');
  });
});
