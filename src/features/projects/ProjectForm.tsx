import { useId, useState, type FormEvent } from 'react';
import { PROJECT_LIMITS, PROJECT_STATUSES, type Project, type ProjectCreateRequest, type ProjectStatus } from '../../../shared/contracts.ts';
import type { ApiClientError } from '../../services/apiClient';
import { ERROR_COPY } from '../github/githubLabels';
import { STATUS_LABELS } from './projectLabels';

interface ProjectFormProps {
  /** Projeto em edição; ausente na criação. */
  initial?: Project;
  linkableRepositories: string[];
  submitLabel: string;
  onSubmit: (values: Required<ProjectCreateRequest>) => Promise<ApiClientError | null>;
  onCancel: () => void;
}

const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-600';

/**
 * Formulário de criação/edição. Os limites repetem os do servidor apenas para orientar; quem
 * valida de fato é o servidor (`server/projects/validation.ts`).
 */
export function ProjectForm({ initial, linkableRepositories, submitLabel, onSubmit, onCancel }: ProjectFormProps) {
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [objective, setObjective] = useState(initial?.objective ?? '');
  const [status, setStatus] = useState<ProjectStatus>(initial?.status ?? 'planning');
  const [repositories, setRepositories] = useState<string[]>(initial?.repositories ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRepository = (fullName: string, checked: boolean) =>
    setRepositories((current) => (checked ? [...current, fullName] : current.filter((r) => r !== fullName)));

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim() === '') {
      setError('Informe o nome do projeto.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const failure = await onSubmit({ name, description, objective, status, repositories });
    setSubmitting(false);
    if (failure) setError(ERROR_COPY[failure.code]?.description ?? 'Não foi possível salvar o projeto.');
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4" noValidate>
      <div>
        <label htmlFor={`${id}-name`} className="text-sm font-medium text-slate-800">
          Nome <span aria-hidden="true">*</span>
        </label>
        <input
          id={`${id}-name`}
          className={inputClass}
          value={name}
          required
          maxLength={PROJECT_LIMITS.nameMax}
          onChange={(event) => setName(event.target.value)}
        />
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
          maxLength={PROJECT_LIMITS.descriptionMax}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${id}-objective`} className="text-sm font-medium text-slate-800">
          Objetivo
        </label>
        <textarea
          id={`${id}-objective`}
          className={inputClass}
          rows={2}
          value={objective}
          maxLength={PROJECT_LIMITS.objectiveMax}
          onChange={(event) => setObjective(event.target.value)}
        />
      </div>
      <div>
        <label htmlFor={`${id}-status`} className="text-sm font-medium text-slate-800">
          Estado
        </label>
        <select
          id={`${id}-status`}
          className={inputClass}
          value={status}
          onChange={(event) => setStatus(event.target.value as ProjectStatus)}
        >
          {PROJECT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Repositórios GitHub (opcional)</legend>
        {linkableRepositories.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Nenhum repositório autorizado no servidor.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {linkableRepositories.map((fullName) => (
              <li key={fullName}>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={repositories.includes(fullName)}
                    onChange={(event) => toggleRepository(fullName, event.target.checked)}
                  />
                  <span className="break-all">{fullName}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1 text-xs text-slate-500">Só repositórios da lista autorizada do servidor, em modo somente leitura.</p>
      </fieldset>
      {error && (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {submitting ? 'Salvando…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
