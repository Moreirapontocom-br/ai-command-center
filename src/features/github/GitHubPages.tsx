import type { ReactNode } from 'react';
import { BranchList } from './BranchList';
import { GitHubGate } from './ConnectionState';
import { IssueList } from './IssueList';
import { PullRequestList } from './PullRequestList';

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {note && <p className="text-xs text-slate-500">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function truncationNote(shown: number, total: number, truncated: boolean, noun: string): string | undefined {
  return truncated ? `Exibindo ${shown} ${noun} atualizados mais recentemente de um total de ${total}.` : undefined;
}

export function IssuesPage() {
  return (
    <GitHubGate>
      {(snapshot) => {
        const open = snapshot.issues.filter((issue) => issue.state === 'open');
        const closed = snapshot.issues.filter((issue) => issue.state === 'closed');
        return (
          <>
            <Section
              id="issues-abertas"
              title={`Issues abertas (${snapshot.metrics.openIssues})`}
              note={truncationNote(open.length, snapshot.metrics.openIssues, snapshot.truncated.openIssues, 'itens')}
            >
              <IssueList issues={open} emptyMessage="Nenhuma issue aberta neste repositório." />
            </Section>
            <Section id="issues-fechadas" title="Fechadas recentemente">
              <IssueList issues={closed} emptyMessage="Nenhuma issue fechada." />
            </Section>
          </>
        );
      }}
    </GitHubGate>
  );
}

export function PullRequestsPage() {
  return (
    <GitHubGate>
      {(snapshot) => {
        const open = snapshot.pullRequests.filter((pr) => pr.state === 'open');
        const finished = snapshot.pullRequests.filter((pr) => pr.state !== 'open');
        return (
          <>
            <Section
              id="prs-abertos"
              title={`Pull Requests abertos (${snapshot.metrics.openPullRequests})`}
              note={truncationNote(
                open.length,
                snapshot.metrics.openPullRequests,
                snapshot.truncated.openPullRequests,
                'itens',
              )}
            >
              <PullRequestList pullRequests={open} emptyMessage="Nenhum Pull Request aberto." />
            </Section>
            <Section id="prs-concluidos" title="Fechados ou incorporados recentemente">
              <PullRequestList pullRequests={finished} emptyMessage="Nenhum Pull Request fechado ou incorporado." />
            </Section>
          </>
        );
      }}
    </GitHubGate>
  );
}

export function BranchesPage() {
  return (
    <GitHubGate>
      {(snapshot) => (
        <Section
          id="branches"
          title={`Branches (${snapshot.metrics.branches})`}
          note={truncationNote(
            snapshot.branches.length,
            snapshot.metrics.branches,
            snapshot.truncated.branches,
            'itens',
          )}
        >
          <BranchList branches={snapshot.branches} />
        </Section>
      )}
    </GitHubGate>
  );
}
