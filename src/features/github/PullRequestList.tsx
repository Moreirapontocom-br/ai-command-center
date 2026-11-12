import type { PullRequestItem } from '../../../shared/contracts.ts';
import { Badge } from '../../components/ui/Badge';
import { CI_LABELS, PR_STATE_LABELS, REVIEW_LABELS, formatDateTime } from './githubLabels';

export function PullRequestList({ pullRequests, emptyMessage }: { pullRequests: PullRequestItem[]; emptyMessage: string }) {
  if (pullRequests.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {pullRequests.map((pr) => {
        const state = PR_STATE_LABELS[pr.state];
        const review = REVIEW_LABELS[pr.review];
        const ci = CI_LABELS[pr.ci];
        return (
          <li key={pr.number} className="space-y-2 p-4">
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block font-medium break-words text-slate-900 hover:text-indigo-700 hover:underline"
            >
              <span className="text-slate-500">#{pr.number}</span> {pr.title}
            </a>
            <p className="text-xs break-words text-slate-500">
              <code className="rounded bg-slate-100 px-1">{pr.headRef}</code> →{' '}
              <code className="rounded bg-slate-100 px-1">{pr.baseRef}</code>
              {pr.author && <> · por {pr.author}</>} ·{' '}
              <span className="whitespace-nowrap">
                Atualizado em <time dateTime={pr.updatedAt}>{formatDateTime(pr.updatedAt)}</time>
              </span>
              {pr.mergedAt && <> · Incorporado em {formatDateTime(pr.mergedAt)}</>}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={state.tone}>{state.label}</Badge>
              {pr.state === 'open' &&
                (pr.isDraft ? <Badge tone="neutral">Draft</Badge> : <Badge tone="info">Pronto para revisão</Badge>)}
              {review && <Badge tone={review.tone}>{review.label}</Badge>}
              <Badge tone={ci.tone}>{ci.label}</Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
