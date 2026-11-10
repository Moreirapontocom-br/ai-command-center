import type { ReactNode } from 'react';
import type { RepoSnapshot } from '../../../shared/contracts.ts';
import { Badge } from '../../components/ui/Badge';
import { ERROR_COPY, formatDateTime } from './githubLabels';
import { useGitHubData, type GitHubDataState } from './githubDataContext';

function RetryButton({ onClick, label = 'Tentar novamente' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
    >
      {label}
    </button>
  );
}

function Panel({
  role,
  tone,
  title,
  children,
}: {
  role: 'status' | 'alert';
  tone: 'neutral' | 'warning' | 'danger';
  title: string;
  children: ReactNode;
}) {
  const styles = {
    neutral: 'border-slate-200 bg-white text-slate-700',
    warning: 'border-amber-300 bg-amber-50 text-amber-900',
    danger: 'border-rose-300 bg-rose-50 text-rose-900',
  }[tone];
  return (
    <div role={role} className={`rounded-xl border px-4 py-4 text-sm ${styles}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1 space-y-1">{children}</div>
    </div>
  );
}

/** Estados sem dados reais: carregando, demonstração (credencial ausente / servidor fora) e erros. */
export function ConnectionPanel({ state, onRetry }: { state: Exclude<GitHubDataState, { phase: 'ready' }>; onRetry: () => void }) {
  if (state.phase === 'loading') {
    return (
      <Panel role="status" tone="neutral" title="Carregando dados do GitHub…">
        <p>Consultando o servidor de integração local.</p>
      </Panel>
    );
  }

  if (state.phase === 'demo') {
    if (state.reason === 'missing_credentials') {
      return (
        <Panel role="status" tone="warning" title="Credencial ausente">
          <p>
            A integração com o GitHub não está configurada. Defina <code>GITHUB_TOKEN</code> (token
            fine-grained somente leitura) no arquivo <code>.env.local</code> e reinicie{' '}
            <code>npm run server</code>.
          </p>
          <p>Nenhum dado do GitHub é exibido. Agentes e tarefas continuam em modo demonstração.</p>
          <RetryButton onClick={onRetry} />
        </Panel>
      );
    }
    if (state.reason === 'no_repositories') {
      return (
        <Panel role="status" tone="warning" title="Sem dados">
          <p>Nenhum repositório autorizado está configurado no servidor.</p>
          <RetryButton onClick={onRetry} />
        </Panel>
      );
    }
    return (
      <Panel role="alert" tone="warning" title="Erro de rede">
        <p>
          O servidor de integração local não respondeu. Verifique se <code>npm run server</code> está
          em execução.
        </p>
        <p>Nenhum dado do GitHub é exibido. Agentes e tarefas continuam em modo demonstração.</p>
        <RetryButton onClick={onRetry} />
      </Panel>
    );
  }

  const copy = ERROR_COPY[state.error.code];
  const isRateLimit = state.error.code === 'rate_limited' || state.error.code === 'too_many_requests';
  return (
    <Panel role="alert" tone={isRateLimit ? 'warning' : 'danger'} title={copy.title}>
      <p>{copy.description}</p>
      {state.repository && <p>Repositório: {state.repository}</p>}
      {state.error.resetAt && <p>A cota será restaurada por volta de {formatDateTime(state.error.resetAt)}.</p>}
      {state.error.retryAfterSeconds && !state.error.resetAt && (
        <p>Tente novamente em cerca de {state.error.retryAfterSeconds} segundos.</p>
      )}
      <RetryButton onClick={onRetry} />
    </Panel>
  );
}

/** Barra de origem: identifica dados reais, repositório, última sincronização e atualização manual. */
export function SourceBar() {
  const { state, refresh } = useGitHubData();
  if (state.phase !== 'ready') return null;
  const { snapshot, stale, staleReason, refreshing } = state;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 rounded-xl border border-emerald-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="success">Dados reais do GitHub</Badge>
            <a
              href={snapshot.repository.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium break-all text-indigo-700 hover:underline"
            >
              {snapshot.repository.fullName}
            </a>
            {snapshot.repository.isPrivate && <Badge tone="neutral">Privado</Badge>}
            {snapshot.repository.isArchived && <Badge tone="warning">Arquivado</Badge>}
          </div>
          <p className="text-xs text-slate-500">
            Última sincronização bem-sucedida:{' '}
            <time dateTime={snapshot.fetchedAt}>{formatDateTime(snapshot.fetchedAt)}</time>
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          aria-busy={refreshing}
          className="self-start rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:cursor-wait disabled:opacity-60 sm:self-auto"
        >
          {refreshing ? 'Atualizando…' : 'Atualizar'}
        </button>
      </div>

      {stale && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong className="font-semibold">Dados desatualizados:</strong> a última atualização falhou
          {staleReason ? ` (${ERROR_COPY[staleReason].title.toLowerCase()})` : ''}. Exibindo a sincronização
          de {formatDateTime(snapshot.fetchedAt)}.
        </div>
      )}

      {snapshot.warnings.length > 0 && (
        <ul className="list-disc rounded-lg border border-slate-200 bg-white py-2 pr-4 pl-8 text-xs text-slate-600">
          {snapshot.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Renderiza o conteúdo apenas com dados reais; caso contrário mostra o estado da conexão. */
export function GitHubGate({ children }: { children: (snapshot: RepoSnapshot) => ReactNode }) {
  const { state, refresh } = useGitHubData();
  if (state.phase !== 'ready') return <ConnectionPanel state={state} onRetry={refresh} />;
  return (
    <div className="space-y-6">
      <SourceBar />
      {children(state.snapshot)}
    </div>
  );
}
