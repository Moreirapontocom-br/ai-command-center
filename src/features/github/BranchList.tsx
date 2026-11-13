import type { BranchItem } from '../../../shared/contracts.ts';
import { Badge } from '../../components/ui/Badge';
import { CI_LABELS, formatDateTime } from './githubLabels';

export function BranchList({ branches }: { branches: BranchItem[] }) {
  if (branches.length === 0) {
    return <p className="text-sm text-slate-500">Nenhuma branch encontrada.</p>;
  }

  return (
    <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
      {branches.map((branch) => {
        const ci = CI_LABELS[branch.ci];
        return (
          <li key={branch.name} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                <code className="break-all">{branch.name}</code>
                {branch.isDefault && <Badge tone="info">Padrão</Badge>}
              </p>
              <p className="text-xs text-slate-500">
                HEAD:{' '}
                {branch.headShortSha && branch.headUrl ? (
                  <a
                    href={branch.headUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-indigo-700 hover:underline"
                  >
                    {branch.headShortSha}
                  </a>
                ) : (
                  'indisponível'
                )}{' '}
                · {branch.committedAt ? <>Commit em {formatDateTime(branch.committedAt)}</> : 'data indisponível'}
              </p>
            </div>
            <div className="self-start sm:self-auto">
              <Badge tone={ci.tone}>{ci.label}</Badge>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
