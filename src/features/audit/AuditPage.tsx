import { useCallback, useEffect, useState } from 'react';
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  type AuditAction,
  type AuditActor,
  type AuditEvent,
  type AuditOutcome,
} from '../../../shared/contracts.ts';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { ApiClientError } from '../../services/apiClient';
import { fetchAudit, type AuditFilters } from '../../services/auditApi';
import { useAuth } from '../auth/authContext';
import { ERROR_COPY, formatDateTime } from '../github/githubLabels';
import { useProjects } from '../projects/projectsContext';

const ACTION_LABELS: Record<AuditAction, string> = {
  'project.created': 'Projeto criado',
  'project.updated': 'Projeto alterado',
  'project.activated': 'Projeto ativo selecionado',
  'task.created': 'Tarefa criada',
  'task.updated': 'Tarefa alterada',
  'task.status_changed': 'Status da tarefa alterado',
  'task.assignee_changed': 'Responsável alterado',
  'task.completion_confirmed': 'Conclusão confirmada',
  'auth.login': 'Login',
  'auth.logout': 'Logout',
  'auth.login_rejected': 'Login recusado',
  'access.denied': 'Acesso negado',
  'policy.decision': 'Decisão de política (bloqueio)',
};

const OUTCOME_LABELS: Record<AuditOutcome, string> = { success: 'Sucesso', failure: 'Falha', blocked: 'Bloqueado' };
const OUTCOME_TONES: Record<AuditOutcome, BadgeTone> = { success: 'success', failure: 'danger', blocked: 'warning' };
const selectClass = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm';

type Load =
  | { phase: 'loading' }
  | { phase: 'error'; error: ApiClientError }
  | { phase: 'ready'; events: AuditEvent[]; nextBefore: number | null; droppedEvents: number; loadingMore: boolean };

function actorLabel(actor: AuditActor, email: string | null): string {
  if (actor.kind === 'system') return actor.id === 'anonymous' ? 'Sistema (cliente não autenticado)' : 'Sistema';
  if (actor.kind === 'agent') return `Agente ${actor.id}`;
  return actor.id === 'admin' && email ? `${email} (administrador)` : actor.id;
}

/** Histórico de auditoria (Issue #006), somente leitura. Mais recentes primeiro. */
export function AuditPage() {
  const { state: auth, sessionLost } = useAuth();
  const { state: projects } = useProjects();
  const email = auth.phase === 'authenticated' ? auth.email : null;
  const [filters, setFilters] = useState<{ projectId: string; action: string; outcome: string }>({ projectId: '', action: '', outcome: '' });
  const [load, setLoad] = useState<Load>({ phase: 'loading' });

  const toError = useCallback(
    (error: unknown) => {
      const clientError = error instanceof ApiClientError ? error : new ApiClientError('internal');
      if (clientError.code === 'unauthenticated') sessionLost();
      return clientError;
    },
    [sessionLost],
  );

  const query = useCallback(
    (before?: number): AuditFilters => ({
      projectId: filters.projectId || undefined,
      action: (filters.action || undefined) as AuditAction | undefined,
      outcome: (filters.outcome || undefined) as AuditOutcome | undefined,
      before,
    }),
    [filters],
  );

  useEffect(() => {
    if (auth.phase !== 'authenticated') return;
    const controller = new AbortController();
    fetchAudit(query(), controller.signal)
      .then((body) => setLoad({ phase: 'ready', events: body.events, nextBefore: body.nextBefore, droppedEvents: body.retention.droppedEvents, loadingMore: false }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoad({ phase: 'error', error: toError(error) });
      });
    return () => controller.abort();
  }, [auth.phase, query, toError]);

  async function loadMore() {
    if (load.phase !== 'ready' || load.nextBefore === null) return;
    setLoad({ ...load, loadingMore: true });
    try {
      const body = await fetchAudit(query(load.nextBefore));
      setLoad({ ...load, events: [...load.events, ...body.events], nextBefore: body.nextBefore, loadingMore: false });
    } catch (error) {
      setLoad({ phase: 'error', error: toError(error) });
    }
  }

  if (auth.phase !== 'authenticated') {
    return (
      <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p className="font-semibold">Auditoria indisponível</p>
        <p className="mt-1">O histórico fica no servidor local, que não está acessível.</p>
      </div>
    );
  }

  const projectList = projects.phase === 'ready' ? projects.projects : [];
  const projectName = (id: string | null) => (id === null ? null : (projectList.find((p) => p.id === id)?.name ?? id));
  const setFilter = (key: keyof typeof filters, value: string) => {
    setLoad({ phase: 'loading' });
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-600">
        Registro somente de adição: eventos não podem ser editados nem excluídos pela aplicação. O autor é sempre
        o da sessão ou o próprio servidor.
      </p>
      <section aria-label="Filtros" className="flex flex-wrap gap-3 text-sm text-slate-700">
        <label className="flex items-center gap-2">
          Projeto
          <select className={selectClass} value={filters.projectId} onChange={(e) => setFilter('projectId', e.target.value)}>
            <option value="">Todos</option>
            {projectList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Evento
          <select className={selectClass} value={filters.action} onChange={(e) => setFilter('action', e.target.value)}>
            <option value="">Todos</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Resultado
          <select className={selectClass} value={filters.outcome} onChange={(e) => setFilter('outcome', e.target.value)}>
            <option value="">Todos</option>
            {AUDIT_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
      </section>

      {load.phase === 'loading' && (
        <p role="status" className="text-sm text-slate-600">
          Carregando histórico…
        </p>
      )}
      {load.phase === 'error' && (
        <div role="alert" className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-4 text-sm text-rose-900">
          <p className="font-semibold">Não foi possível carregar a auditoria</p>
          <p className="mt-1">{ERROR_COPY[load.error.code].description}</p>
        </div>
      )}
      {load.phase === 'ready' && (
        <>
          {load.droppedEvents > 0 && (
            <p className="text-xs text-slate-500">
              {load.droppedEvents} evento(s) antigo(s) foram descartados pela política de retenção.
            </p>
          )}
          {load.events.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-600">
              Nenhum evento para os filtros escolhidos.
            </p>
          ) : (
            <ol aria-label="Eventos de auditoria" className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {load.events.map((event) => (
                <li key={event.id} className="space-y-1 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <time dateTime={event.at} className="text-xs text-slate-500">
                      {formatDateTime(event.at)}
                    </time>
                    <span className="font-medium text-slate-900">{ACTION_LABELS[event.action]}</span>
                    <Badge tone={OUTCOME_TONES[event.outcome]}>{OUTCOME_LABELS[event.outcome]}</Badge>
                  </div>
                  <p className="text-xs text-slate-600">
                    Autor: {actorLabel(event.actor, email)}
                    {event.projectId && <> · Projeto: {projectName(event.projectId)}</>}
                    {event.resource.id && event.resource.type === 'task' && <> · Tarefa {event.resource.id.slice(0, 8)}</>}
                  </p>
                  {Object.keys(event.context).length > 0 && (
                    <p className="font-mono text-xs break-all text-slate-500">
                      {Object.entries(event.context)
                        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
                        .join('  ')}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {load.nextBefore !== null && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={load.loadingMore}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
            >
              {load.loadingMore ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
