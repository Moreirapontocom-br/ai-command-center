import { useState } from 'react';
import { TASK_TRANSITIONS, TASK_WORK_STATUSES, type Task, type TaskStatus, type TaskUpdateRequest } from '../../../shared/contracts.ts';
import { Badge } from '../../components/ui/Badge';
import type { ApiClientError } from '../../services/apiClient';
import { ERROR_COPY, formatDateTime } from '../github/githubLabels';
import type { AssigneeChoices } from './AssigneeOptions';
import {
  assigneeName,
  ORIGIN_LABELS,
  PRIORITY_LABELS,
  PRIORITY_TONES,
  referenceLabel,
  referenceUrl,
  WORK_STATUS_LABELS,
  WORK_STATUS_TONES,
} from './workLabels';

interface WorkTaskCardProps {
  task: Task;
  byId: Map<string, Task>;
  choices: AssigneeChoices;
  onUpdate: (patch: TaskUpdateRequest) => Promise<ApiClientError | null>;
  onEdit: () => void;
}

const RESOLVED: readonly TaskStatus[] = ['done', 'cancelled'];

/** Cartão de uma tarefa real: status com transições permitidas, dependências, referências e histórico. */
export function WorkTaskCard({ task, byId, choices, onUpdate, onEdit }: WorkTaskCardProps) {
  const [pendingStatus, setPendingStatus] = useState<TaskStatus | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dependencies = task.dependsOn.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
  const unresolved = dependencies.filter((t) => !RESOLVED.includes(t.status));

  async function apply(patch: TaskUpdateRequest) {
    setSaving(true);
    const failure = await onUpdate(patch);
    setSaving(false);
    setError(failure ? (ERROR_COPY[failure.code]?.description ?? 'Não foi possível atualizar a tarefa.') : null);
    if (!failure) {
      setPendingStatus(null);
      setReason('');
    }
  }

  function chooseStatus(next: TaskStatus) {
    setError(null);
    if (next === 'blocked') {
      setPendingStatus('blocked');
      return;
    }
    void apply({ status: next });
  }

  return (
    <article aria-label={task.title} className="space-y-2 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 font-semibold break-words text-slate-900">{task.title}</h3>
        <Badge tone={WORK_STATUS_TONES[task.status]}>{WORK_STATUS_LABELS[task.status]}</Badge>
        <Badge tone={PRIORITY_TONES[task.priority]}>Prioridade {PRIORITY_LABELS[task.priority].toLowerCase()}</Badge>
      </div>
      {task.description && <p className="text-sm whitespace-pre-line text-slate-700">{task.description}</p>}
      <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">Responsável: </dt>
          <dd className="inline">{assigneeName(task.assignee, choices)}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Origem: </dt>
          <dd className="inline">{ORIGIN_LABELS[task.origin]}</dd>
        </div>
      </dl>
      {task.assignee?.kind === 'agent' && task.status !== 'done' && (
        <p className="text-xs text-slate-500">Atribuída a agente: nenhuma execução foi iniciada pelo ACC.</p>
      )}
      {task.status === 'blocked' && (
        <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-900">
          <span className="font-medium">Bloqueada:</span> {task.blockedReason}
        </p>
      )}
      {task.completion && (
        <p className="text-xs text-emerald-800">
          Conclusão confirmada por {assigneeName({ kind: 'human', userId: task.completion.confirmedBy }, choices)} em{' '}
          {formatDateTime(task.completion.confirmedAt)}.
        </p>
      )}

      {dependencies.length > 0 && (
        <div className="text-sm">
          <p className="font-medium text-slate-800">Depende de:</p>
          <ul className="ml-4 list-disc text-slate-700">
            {dependencies.map((dep) => (
              <li key={dep.id}>
                {dep.title} — {WORK_STATUS_LABELS[dep.status]}
              </li>
            ))}
          </ul>
          {unresolved.length > 0 && !TASK_WORK_STATUSES.includes(task.status) && (
            <p className="mt-1 text-xs text-amber-800">
              Aguardando {unresolved.length} dependência(s): só pode iniciar depois que elas forem concluídas ou canceladas.
            </p>
          )}
        </div>
      )}

      {task.references.length > 0 && (
        <ul aria-label="Referências" className="flex flex-wrap gap-2 text-xs">
          {task.references.map((reference, index) => (
            <li key={index}>
              <a href={referenceUrl(reference)} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                {referenceLabel(reference)}
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <span>Mudar status</span>
          <select
            aria-label={`Mudar status de ${task.title}`}
            value=""
            disabled={saving}
            onChange={(e) => e.target.value && chooseStatus(e.target.value as TaskStatus)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Selecione…</option>
            {TASK_TRANSITIONS[task.status].map((next) => (
              <option key={next} value={next}>
                {WORK_STATUS_LABELS[next]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={onEdit} className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Editar
        </button>
      </div>

      {pendingStatus === 'blocked' && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim() === '') {
              setError('Informe o motivo do bloqueio.');
              return;
            }
            void apply({ status: 'blocked', blockedReason: reason });
          }}
        >
          <label className="text-sm text-slate-700">
            Motivo do bloqueio
            <input className="mt-1 block w-64 rounded-md border border-slate-300 px-2 py-1 text-sm" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="submit" disabled={saving} className="rounded-md bg-rose-700 px-3 py-1 text-sm font-medium text-white hover:bg-rose-600">
            Bloquear
          </button>
          <button type="button" onClick={() => setPendingStatus(null)} className="rounded-md border border-slate-300 px-3 py-1 text-sm">
            Cancelar
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      )}

      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer">Histórico ({task.history.length})</summary>
        <ol className="mt-1 space-y-0.5">
          {[...task.history].reverse().map((entry, index) => (
            <li key={index}>
              <time dateTime={entry.at}>{formatDateTime(entry.at)}</time> —{' '}
              {entry.action === 'created' && 'criada'}
              {entry.action === 'status_changed' &&
                `status: ${WORK_STATUS_LABELS[entry.from as TaskStatus] ?? entry.from} → ${WORK_STATUS_LABELS[entry.to as TaskStatus] ?? entry.to}`}
              {entry.action === 'assignee_changed' && `responsável: ${entry.from ?? 'nenhum'} → ${entry.to ?? 'nenhum'}`}
              {entry.action === 'updated' && `editada (${(entry.fields ?? []).join(', ')})`}
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}
