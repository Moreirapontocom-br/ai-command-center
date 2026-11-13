import type { IssueItem } from '../../../shared/contracts.ts';
import { Badge } from '../../components/ui/Badge';
import { formatDateTime, issueStateLabel } from './githubLabels';

export function IssueList({ issues, emptyMessage }: { issues: IssueItem[]; emptyMessage: string }) {
  if (issues.length === 0) {
    return <p className="text-sm text-slate-500">{emptyMessage}</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {issues.map((issue) => {
        const state = issueStateLabel(issue);
        return (
          <li key={issue.number} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-1">
              <a
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium break-words text-slate-900 hover:text-indigo-700 hover:underline"
              >
                <span className="text-slate-500">#{issue.number}</span> {issue.title}
              </a>
              <p className="text-xs text-slate-500">
                {issue.repository} ·{' '}
                {issue.assignees.length > 0
                  ? `Responsável: ${issue.assignees.map((user) => user.login).join(', ')}`
                  : 'Sem responsável'}{' '}
                ·{' '}
                <span className="whitespace-nowrap">
                  Atualizada em <time dateTime={issue.updatedAt}>{formatDateTime(issue.updatedAt)}</time>
                </span>
              </p>
              {issue.labels.length > 0 && (
                <ul aria-label="Labels" className="flex flex-wrap gap-1.5">
                  {issue.labels.map((label) => (
                    <li
                      key={label.name}
                      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-700"
                    >
                      {label.color && (
                        <span
                          aria-hidden="true"
                          className="size-2 rounded-full"
                          style={{ backgroundColor: `#${label.color}` }}
                        />
                      )}
                      {label.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="self-start">
              <Badge tone={state.tone}>{state.label}</Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
