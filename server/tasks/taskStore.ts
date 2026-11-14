import { randomUUID } from 'node:crypto';
import {
  AGENT_IDS,
  TASK_LIMITS,
  TASK_ORIGINS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TASK_WORK_STATUSES,
  type Task,
  type TaskAssignee,
  type TaskHistoryEntry,
  type TaskOrigin,
  type TaskReference,
} from '../../shared/contracts.ts';
import { IntegrationError } from '../github/errors.ts';
import { parseText } from '../projects/validation.ts';
import { DataFileError, isIsoDate, openJsonFile, type WriteFile } from '../storage/jsonFile.ts';
import { parseDependencies, parseReferences, TASK_ID_PATTERN, type TaskFields, type TaskPatch } from './validation.ts';

/**
 * Tarefas por projeto (Issue #005), num arquivo próprio (`tasks.json`) com o mesmo motor atômico
 * dos projetos — assim gravar uma tarefa não reescreve o arquivo de projetos.
 *
 * Regras de negócio aplicadas DENTRO da operação serializada (nada é gravado se alguma falhar):
 * - isolamento: toda operação exige `ownerId` + `projectId`; tarefa de outro dono/projeto = `null`;
 * - transições de status conforme `TASK_TRANSITIONS`; criação só como `pending`/`planned`;
 * - dependências só entre tarefas do mesmo projeto, sem ciclos; iniciar, revisar ou concluir exige
 *   dependências resolvidas (concluídas ou canceladas);
 * - `blocked` exige motivo; sair de `blocked` limpa o motivo;
 * - tarefa atribuída a AGENTE só fica `done` com evidência (referência a PR ou branch), e a
 *   conclusão é sempre registrada como confirmada pela pessoa autenticada (`completion.confirmedBy`);
 * - atribuir, referenciar ou vincular nunca muda o status: nada é inferido do GitHub ou de agentes;
 * - `origin` é definida pelo servidor, nunca pelo cliente.
 */

export const TASKS_FORMAT = 'acc-tasks';
export const TASKS_VERSION = 1;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const USER_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;

interface TaskRecord extends Task {
  ownerId: string;
}
interface TaskData {
  tasks: TaskRecord[];
}

export interface TaskStore {
  list(ownerId: string, projectId: string): Task[];
  get(ownerId: string, projectId: string, taskId: string): Task | null;
  create(ownerId: string, projectId: string, fields: TaskFields, options: { actor: string; origin?: TaskOrigin }): Promise<Task>;
  /** `null` se a tarefa não existir neste projeto deste dono. */
  update(ownerId: string, projectId: string, taskId: string, patch: TaskPatch, actor: string): Promise<Task | null>;
}

export interface TaskStoreOptions {
  filePath: string;
  now?: () => number;
  generateId?: () => string;
  writeFile?: WriteFile;
}

const fail = (code: ConstructorParameters<typeof IntegrationError>[0]): never => {
  throw new IntegrationError(code);
};

const assigneeLabel = (assignee: TaskAssignee | null): string | null =>
  assignee === null ? null : assignee.kind === 'agent' ? `agent:${assignee.agentId}` : `human:${assignee.userId}`;

const isEvidence = (reference: TaskReference) => reference.kind === 'pull_request' || reference.kind === 'branch';

/** `true` se seguir `dependsOn` a partir de `startId` volta a `startId`. */
function hasCycle(startId: string, byId: Map<string, TaskRecord>): boolean {
  const seen = new Set<string>();
  const stack = [...(byId.get(startId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === startId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

/**
 * Valida o estado final de `task` contra as regras. `previous` é `null` na criação. `changed`
 * diz quais campos o pedido tocou (as verificações de estado só disparam quando relevantes, para
 * que editar o título de uma tarefa antiga não falhe por regras que ela já cumpria).
 */
function enforceRules(task: TaskRecord, previous: TaskRecord | null, changed: Set<string>, siblings: TaskRecord[]) {
  if (previous && task.status !== previous.status && !TASK_TRANSITIONS[previous.status].includes(task.status)) {
    fail('invalid_status_transition');
  }

  const byId = new Map(siblings.map((t) => [t.id, t]));
  byId.set(task.id, task);
  if (changed.has('dependsOn')) {
    for (const id of task.dependsOn) if (id === task.id || !byId.has(id)) fail('bad_request');
    if (hasCycle(task.id, byId)) fail('dependency_cycle');
  }

  if ((changed.has('status') || changed.has('dependsOn')) && TASK_WORK_STATUSES.includes(task.status)) {
    const unresolved = task.dependsOn.some((id) => !['done', 'cancelled'].includes(byId.get(id)!.status));
    if (unresolved) fail('dependencies_unresolved');
  }

  if (task.status === 'blocked') {
    if (task.blockedReason === '') fail('bad_request');
  } else if (changed.has('blockedReason') && task.blockedReason !== '') {
    fail('bad_request');
  } else {
    task.blockedReason = '';
  }

  const evidenceRelevant = changed.has('status') || changed.has('assignee') || changed.has('references');
  if (evidenceRelevant && task.status === 'done' && task.assignee?.kind === 'agent' && !task.references.some(isEvidence)) {
    fail('evidence_required');
  }
}

function pushHistory(task: TaskRecord, entry: TaskHistoryEntry) {
  task.history.push(entry);
  if (task.history.length > TASK_LIMITS.historyMax) task.history.splice(0, task.history.length - TASK_LIMITS.historyMax);
}

// ---------------------------------------------------------------- validação do arquivo

function validateRecord(raw: unknown, index: number, corrupt: (detail: string) => never): TaskRecord {
  const bad = (what: string): never => corrupt(`${what} da tarefa ${index}`);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('estrutura');
  const r = raw as Record<string, unknown>;
  const expected = [
    'id', 'ownerId', 'projectId', 'title', 'description', 'status', 'priority', 'assignee', 'dependsOn',
    'references', 'origin', 'blockedReason', 'completion', 'history', 'createdAt', 'updatedAt',
  ];
  const keys = Object.keys(r);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) bad('campos');
  if (typeof r.id !== 'string' || !TASK_ID_PATTERN.test(r.id)) bad('id');
  if (typeof r.projectId !== 'string' || !TASK_ID_PATTERN.test(r.projectId)) bad('projeto');
  if (typeof r.ownerId !== 'string' || !USER_PATTERN.test(r.ownerId)) bad('dono');
  if (!isIsoDate(r.createdAt) || !isIsoDate(r.updatedAt)) bad('datas');
  const inList = (value: unknown, list: readonly string[]) => typeof value === 'string' && list.includes(value);
  if (!inList(r.status, TASK_STATUSES)) bad('status');
  if (!inList(r.priority, TASK_PRIORITIES)) bad('prioridade');
  if (!inList(r.origin, TASK_ORIGINS)) bad('origem');

  const a = r.assignee as Record<string, unknown> | null;
  const assigneeOk =
    a === null ||
    (typeof a === 'object' &&
      ((a.kind === 'agent' && Object.keys(a).length === 2 && inList(a.agentId, AGENT_IDS)) ||
        (a.kind === 'human' && Object.keys(a).length === 2 && typeof a.userId === 'string' && USER_PATTERN.test(a.userId))));
  if (!assigneeOk) bad('responsável');

  const c = r.completion as Record<string, unknown> | null;
  const completionOk =
    (r.status === 'done') ===
      (c !== null && typeof c === 'object' && Object.keys(c).length === 2 && typeof c.confirmedBy === 'string' && isIsoDate(c.confirmedAt)) &&
    (r.status === 'done' || c === null);
  if (!completionOk) bad('conclusão');

  if (!Array.isArray(r.history) || r.history.length > TASK_LIMITS.historyMax) bad('histórico');
  const historyOk = (r.history as unknown[]).every((entry) => {
    const e = entry as Record<string, unknown>;
    return typeof e === 'object' && e !== null && isIsoDate(e.at) && typeof e.actor === 'string' &&
      ['created', 'updated', 'status_changed', 'assignee_changed'].includes(e.action as string);
  });
  if (!historyOk) bad('histórico');

  try {
    const title = parseText(r.title, { max: TASK_LIMITS.titleMax, required: true, multiline: false });
    const description = parseText(r.description, { max: TASK_LIMITS.descriptionMax, required: false, multiline: true });
    const blockedReason = parseText(r.blockedReason, { max: TASK_LIMITS.blockedReasonMax, required: false, multiline: false });
    if ((r.status === 'blocked') !== (blockedReason !== '')) bad('motivo de bloqueio');
    const dependsOn = parseDependencies(r.dependsOn);
    const refs = r.references;
    if (!Array.isArray(refs) || !refs.every((x) => typeof x?.repository === 'string' && REPOSITORY_PATTERN.test(x.repository))) {
      bad('referências');
    }
    const references = parseReferences(refs, (refs as Array<{ repository: string }>).map((x) => x.repository));
    return {
      ...(r as unknown as TaskRecord),
      title,
      description,
      blockedReason,
      dependsOn,
      references,
    };
  } catch (error) {
    if (error instanceof DataFileError) throw error;
    return bad('conteúdo');
  }
}

function validateData(raw: Record<string, unknown>, corrupt: (detail: string) => never): TaskData {
  if (Object.keys(raw).length !== 1 || !Array.isArray(raw.tasks)) corrupt('estrutura');
  const tasks = (raw.tasks as unknown[]).map((t, i) => validateRecord(t, i, corrupt));
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) corrupt('ids duplicados');
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const [index, task] of tasks.entries()) {
    for (const dep of task.dependsOn) {
      const target = byId.get(dep);
      if (!target || target.ownerId !== task.ownerId || target.projectId !== task.projectId) {
        corrupt(`dependência da tarefa ${index}`);
      }
    }
    if (hasCycle(task.id, byId)) corrupt(`dependência circular na tarefa ${index}`);
  }
  return { tasks };
}

// ---------------------------------------------------------------- store

export async function openTaskStore(options: TaskStoreOptions): Promise<TaskStore> {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;
  const file = await openJsonFile<TaskData>({
    filePath: options.filePath,
    label: 'tarefas',
    format: TASKS_FORMAT,
    version: TASKS_VERSION,
    maxBytes: MAX_FILE_BYTES,
    empty: () => ({ tasks: [] }),
    validate: validateData,
    writeFile: options.writeFile,
  });

  // `ownerId` nunca sai do servidor; o resto é cópia para não expor o estado interno.
  const toTask = ({ ownerId: _ownerId, ...task }: TaskRecord): Task => structuredClone(task); // eslint-disable-line @typescript-eslint/no-unused-vars
  const inProject = (tasks: TaskRecord[], ownerId: string, projectId: string) =>
    tasks.filter((t) => t.ownerId === ownerId && t.projectId === projectId);
  const iso = () => new Date(now()).toISOString();

  return {
    list(ownerId, projectId) {
      return inProject(file.data.tasks, ownerId, projectId).map(toTask);
    },

    get(ownerId, projectId, taskId) {
      const record = inProject(file.data.tasks, ownerId, projectId).find((t) => t.id === taskId);
      return record ? toTask(record) : null;
    },

    create(ownerId, projectId, fields, { actor, origin = 'manual' }) {
      return file.mutate((draft) => {
        const siblings = inProject(draft.tasks, ownerId, projectId);
        if (siblings.length >= TASK_LIMITS.tasksPerProjectMax) fail('task_limit_reached');
        let id = generateId();
        while (draft.tasks.some((t) => t.id === id)) id = generateId();
        const at = iso();
        const record: TaskRecord = {
          id,
          ownerId,
          projectId,
          ...structuredClone(fields),
          origin,
          blockedReason: '',
          completion: null,
          history: [{ at, actor, action: 'created', to: fields.status }],
          createdAt: at,
          updatedAt: at,
        };
        enforceRules(record, null, new Set(['dependsOn']), siblings);
        draft.tasks.push(record);
        return toTask(record);
      });
    },

    update(ownerId, projectId, taskId, patch, actor) {
      const exists = inProject(file.data.tasks, ownerId, projectId).some((t) => t.id === taskId);
      if (!exists) return Promise.resolve(null);
      return file.mutate((draft) => {
        const siblings = inProject(draft.tasks, ownerId, projectId);
        const record = siblings.find((t) => t.id === taskId);
        if (!record) return null;
        const previous = structuredClone(record);
        Object.assign(record, structuredClone(patch));
        // Só conta como alterado o que mudou de fato: o formulário reenvia todos os campos, e uma
        // edição de título não deve disparar regras de dependência/evidência sobre valores iguais.
        const changed = new Set(
          Object.keys(patch).filter(
            (key) => JSON.stringify(record[key as keyof TaskRecord]) !== JSON.stringify(previous[key as keyof TaskRecord]),
          ),
        );
        enforceRules(record, previous, changed, siblings.filter((t) => t.id !== taskId));

        const at = iso();
        if (record.status === 'done' && previous.status !== 'done') record.completion = { confirmedBy: actor, confirmedAt: at };
        if (record.status !== 'done') record.completion = null;

        if (record.status !== previous.status) {
          pushHistory(record, { at, actor, action: 'status_changed', from: previous.status, to: record.status });
        }
        if (assigneeLabel(record.assignee) !== assigneeLabel(previous.assignee)) {
          pushHistory(record, {
            at,
            actor,
            action: 'assignee_changed',
            from: assigneeLabel(previous.assignee),
            to: assigneeLabel(record.assignee),
          });
        }
        const edited = [...changed].filter((key) => !['status', 'assignee'].includes(key));
        if (edited.length > 0) pushHistory(record, { at, actor, action: 'updated', fields: edited.sort() });
        record.updatedAt = at;
        return toTask(record);
      });
    },
  };
}
