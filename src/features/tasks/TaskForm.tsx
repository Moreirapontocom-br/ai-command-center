import { useId, useState, type FormEvent } from 'react';
import {
  TASK_INITIAL_STATUSES,
  TASK_LIMITS,
  TASK_PRIORITIES,
  type Task,
  type TaskCreateRequest,
  type TaskPriority,
  type TaskReference,
  type TaskStatus,
} from '../../../shared/contracts.ts';
import type { ApiClientError } from '../../services/apiClient';
import { ERROR_COPY } from '../github/githubLabels';
import { AssigneeOptions, type AssigneeChoices } from './AssigneeOptions';
import { assigneeFromKey, assigneeKey, PRIORITY_LABELS, referenceLabel, WORK_STATUS_LABELS } from './workLabels';

interface TaskFormProps {
  initial?: Task;
  /** Outras tarefas do projeto (candidatas a dependência). */
  otherTasks: Task[];
  repositories: string[];
  choices: AssigneeChoices;
  submitLabel: string;
  onSubmit: (values: TaskCreateRequest) => Promise<ApiClientError | null>;
  onCancel: () => void;
}

const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-600';

/**
 * Criação/edição. O status só é escolhido na criação (pendente ou planejada); depois, muda pelo
 * controle de status da tarefa, que oferece apenas as transições permitidas. Os limites repetem os
 * do servidor, que é quem valida de fato.
 */
export function TaskForm({ initial, otherTasks, repositories, choices, submitLabel, onSubmit, onCancel }: TaskFormProps) {
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [priority, setPriority] = useState<TaskPriority>(initial?.priority ?? 'medium');
  const [status, setStatus] = useState<TaskStatus>('pending');
  const [assignee, setAssignee] = useState(assigneeKey(initial?.assignee ?? null));
  const [dependsOn, setDependsOn] = useState<string[]>(initial?.dependsOn ?? []);
  const [references, setReferences] = useState<TaskReference[]>(initial?.references ?? []);
  const [refKind, setRefKind] = useState<TaskReference['kind']>('pull_request');
  const [refRepo, setRefRepo] = useState(repositories[0] ?? '');
  const [refValue, setRefValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addReference() {
    const value = refValue.trim();
    if (value === '' || refRepo === '') return;
    if (refKind === 'branch') {
      setReferences((current) => [...current, { kind: 'branch', repository: refRepo, name: value }]);
    } else {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) {
        setError('Informe um número de issue/PR válido.');
        return;
      }
      setReferences((current) => [...current, { kind: refKind, repository: refRepo, number }]);
    }
    setRefValue('');
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (title.trim() === '') {
      setError('Informe o título da tarefa.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const values: TaskCreateRequest = {
      title,
      description,
      priority,
      assignee: assigneeFromKey(assignee),
      dependsOn,
      references,
      ...(initial ? {} : { status }),
    };
    const failure = await onSubmit(values);
    setSubmitting(false);
    if (failure) setError(ERROR_COPY[failure.code]?.description ?? 'Não foi possível salvar a tarefa.');
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4" noValidate>
      <div>
        <label htmlFor={`${id}-title`} className="text-sm font-medium text-slate-800">
          Título <span aria-hidden="true">*</span>
        </label>
        <input id={`${id}-title`} className={inputClass} value={title} maxLength={TASK_LIMITS.titleMax} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${id}-description`} className="text-sm font-medium text-slate-800">
          Descrição
        </label>
        <textarea
          id={`${id}-description`}
          className={inputClass}
          rows={3}
          value={description}
          maxLength={TASK_LIMITS.descriptionMax}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {!initial && (
          <div>
            <label htmlFor={`${id}-status`} className="text-sm font-medium text-slate-800">
              Status inicial
            </label>
            <select id={`${id}-status`} className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {TASK_INITIAL_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {WORK_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label htmlFor={`${id}-priority`} className="text-sm font-medium text-slate-800">
            Prioridade
          </label>
          <select id={`${id}-priority`} className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-assignee`} className="text-sm font-medium text-slate-800">
            Responsável
          </label>
          <select id={`${id}-assignee`} className={inputClass} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Sem responsável</option>
            <AssigneeOptions choices={choices} />
          </select>
        </div>
      </div>
      {assignee.startsWith('agent:') && (
        <p className="text-xs text-slate-600">
          Atribuir a um agente não inicia nenhuma execução. Para concluir, será preciso registrar um PR ou branch como evidência.
        </p>
      )}

      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Depende de</legend>
        {otherTasks.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Nenhuma outra tarefa neste projeto.</p>
        ) : (
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto">
            {otherTasks.map((task) => (
              <li key={task.id}>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={dependsOn.includes(task.id)}
                    onChange={(e) =>
                      setDependsOn((current) => (e.target.checked ? [...current, task.id] : current.filter((d) => d !== task.id)))
                    }
                  />
                  <span className="break-words">{task.title}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Referências externas (opcional)</legend>
        {references.length > 0 && (
          <ul className="mt-2 space-y-1">
            {references.map((reference, index) => (
              <li key={`${reference.kind}-${index}`} className="flex items-center gap-2 text-sm text-slate-700">
                <span className="break-all">
                  {reference.repository} — {referenceLabel(reference)}
                </span>
                <button
                  type="button"
                  className="text-xs text-rose-700 hover:underline"
                  onClick={() => setReferences((current) => current.filter((_, i) => i !== index))}
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
        {repositories.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Vincule um repositório ao projeto para adicionar referências.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <select aria-label="Tipo de referência" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={refKind} onChange={(e) => setRefKind(e.target.value as TaskReference['kind'])}>
              <option value="pull_request">PR</option>
              <option value="issue">Issue</option>
              <option value="branch">Branch</option>
            </select>
            {repositories.length > 1 && (
              <select aria-label="Repositório da referência" className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={refRepo} onChange={(e) => setRefRepo(e.target.value)}>
                {repositories.map((repo) => (
                  <option key={repo} value={repo}>
                    {repo}
                  </option>
                ))}
              </select>
            )}
            <input
              aria-label={refKind === 'branch' ? 'Nome da branch' : 'Número'}
              className="w-40 rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={refValue}
              inputMode={refKind === 'branch' ? 'text' : 'numeric'}
              onChange={(e) => setRefValue(e.target.value)}
            />
            <button type="button" onClick={addReference} className="rounded-md border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100">
              Adicionar referência
            </button>
          </div>
        )}
        <p className="mt-1 text-xs text-slate-500">Referências são apenas vínculos: o status da tarefa nunca é alterado a partir do GitHub.</p>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={submitting} className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60">
          {submitting ? 'Salvando…' : submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
          Cancelar
        </button>
      </div>
    </form>
  );
}
