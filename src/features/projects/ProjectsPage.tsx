import { useState } from 'react';
import type { Project } from '../../../shared/contracts.ts';
import { Badge } from '../../components/ui/Badge';
import { ERROR_COPY } from '../github/githubLabels';
import { ProjectForm } from './ProjectForm';
import { STATUS_LABELS, STATUS_TONES } from './projectLabels';
import { useProjects } from './projectsContext';

function ProjectCard({
  project,
  active,
  onEdit,
  onSelect,
}: {
  project: Project;
  active: boolean;
  onEdit: () => void;
  onSelect: () => void;
}) {
  return (
    <article
      aria-label={project.name}
      className={`space-y-2 rounded-xl border bg-white p-4 ${active ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-slate-200'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 font-semibold break-words text-slate-900">{project.name}</h3>
        <Badge tone={STATUS_TONES[project.status]}>{STATUS_LABELS[project.status]}</Badge>
        {active && <Badge tone="violet">Ativo</Badge>}
      </div>
      {project.description && <p className="text-sm whitespace-pre-line text-slate-700">{project.description}</p>}
      {project.objective && (
        <p className="text-sm whitespace-pre-line text-slate-700">
          <span className="font-medium">Objetivo:</span> {project.objective}
        </p>
      )}
      <p className="text-xs text-slate-500">
        {project.repositories.length === 0
          ? 'Sem repositório GitHub'
          : `GitHub: ${project.repositories.join(', ')}`}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        {!active && (
          <button
            type="button"
            onClick={onSelect}
            className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Tornar ativo
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="rounded-md border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          Editar
        </button>
      </div>
    </article>
  );
}

/** Lista, criação, edição e seleção de projetos (Issue #004). Projetos não exigem GitHub. */
export function ProjectsPage() {
  const { state, create, update, select, reload } = useProjects();
  const [mode, setMode] = useState<{ kind: 'idle' } | { kind: 'create' } | { kind: 'edit'; id: string }>({ kind: 'idle' });
  const [selectError, setSelectError] = useState<string | null>(null);

  if (state.phase === 'loading') {
    return (
      <p role="status" className="text-sm text-slate-600">
        Carregando projetos…
      </p>
    );
  }
  if (state.phase !== 'ready') {
    const message =
      state.phase === 'unavailable'
        ? 'O servidor local não respondeu. Os projetos ficam no servidor e não estão disponíveis no modo demonstração.'
        : ERROR_COPY[state.error.code].description;
    return (
      <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
        <p className="font-semibold">Projetos indisponíveis</p>
        <p className="mt-1">{message}</p>
        <button
          type="button"
          onClick={reload}
          className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Tentar novamente
        </button>
      </div>
    );
  }

  const { projects, activeProjectId, linkableRepositories } = state;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">Projetos ({projects.length})</h2>
        {mode.kind !== 'create' && (
          <button
            type="button"
            onClick={() => setMode({ kind: 'create' })}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Novo projeto
          </button>
        )}
      </div>

      {mode.kind === 'create' && (
        <section aria-label="Novo projeto">
          <ProjectForm
            linkableRepositories={linkableRepositories}
            submitLabel="Criar projeto"
            onCancel={() => setMode({ kind: 'idle' })}
            onSubmit={async (values) => {
              const result = await create(values);
              if ('error' in result) return result.error;
              setMode({ kind: 'idle' });
              // O primeiro projeto criado já vira o ativo.
              if (activeProjectId === null) await select(result.project.id);
              return null;
            }}
          />
        </section>
      )}

      {selectError && (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {selectError}
        </p>
      )}

      {projects.length === 0 && mode.kind !== 'create' ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-600">
          Nenhum projeto ainda. Crie o primeiro; vincular um repositório GitHub é opcional.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {projects.map((project) =>
            mode.kind === 'edit' && mode.id === project.id ? (
              <section key={project.id} aria-label={`Editar ${project.name}`}>
                <ProjectForm
                  initial={project}
                  linkableRepositories={linkableRepositories}
                  submitLabel="Salvar alterações"
                  onCancel={() => setMode({ kind: 'idle' })}
                  onSubmit={async (values) => {
                    const result = await update(project.id, values);
                    if ('error' in result) return result.error;
                    setMode({ kind: 'idle' });
                    return null;
                  }}
                />
              </section>
            ) : (
              <ProjectCard
                key={project.id}
                project={project}
                active={project.id === activeProjectId}
                onEdit={() => setMode({ kind: 'edit', id: project.id })}
                onSelect={async () => {
                  const failure = await select(project.id);
                  setSelectError(failure ? ERROR_COPY[failure.code].description : null);
                }}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
