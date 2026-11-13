import type { CiState, RepoMetrics } from '../../../shared/contracts.ts';
import { StatCard } from '../dashboard/StatCard';
import { GitHubGate } from './ConnectionState';
import { CI_SHORT_LABELS } from './githubLabels';

function awaitingReviewHint(metric: RepoMetrics['awaitingReview']): string {
  const parts: string[] = [];
  if (metric.undetermined > 0) parts.push(`${metric.undetermined} sem informação de revisão`);
  if (!metric.complete) parts.push('contagem parcial: nem todos os PRs abertos foram carregados');
  return parts.length > 0 ? parts.join(' · ') : 'Confirmado pelos dados do GitHub';
}

function openPrCiHint(counts: Record<CiState, number>): string {
  const entries = (Object.keys(counts) as CiState[])
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${CI_SHORT_LABELS[state].toLowerCase()}`);
  return entries.length > 0 ? `PRs abertos: ${entries.join(', ')}` : 'Sem PRs abertos';
}

/** Indicadores calculados exclusivamente a partir do snapshot real devolvido pelo servidor. */
export function GitHubOverview() {
  return (
    <section aria-labelledby="github-titulo" className="space-y-3">
      <h2 id="github-titulo" className="text-base font-semibold">
        Repositório no GitHub
      </h2>
      <GitHubGate>
        {({ metrics, repository }) => (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <StatCard label="Issues abertas" value={metrics.openIssues} />
            <StatCard label="Pull Requests abertos" value={metrics.openPullRequests} />
            <StatCard
              label="PRs aguardando revisão"
              value={metrics.awaitingReview.count}
              hint={awaitingReviewHint(metrics.awaitingReview)}
            />
            <StatCard label="PRs incorporados (merge)" value={metrics.mergedPullRequests} />
            <StatCard label="Branches" value={metrics.branches} />
            <StatCard
              label={`CI na branch padrão${repository.defaultBranch ? ` (${repository.defaultBranch})` : ''}`}
              value={CI_SHORT_LABELS[metrics.ci.defaultBranch]}
              hint={openPrCiHint(metrics.ci.openPullRequests)}
            />
          </div>
        )}
      </GitHubGate>
    </section>
  );
}
