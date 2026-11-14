import {
  AGENT_IDS,
  TASK_INITIAL_STATUSES,
  TASK_LIMITS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskAssignee,
  type TaskPriority,
  type TaskReference,
  type TaskStatus,
} from '../../shared/contracts.ts';
import { IntegrationError } from '../github/errors.ts';
import { PROJECT_ID_PATTERN, parseText } from '../projects/validation.ts';

/**
 * Validação de FORMATO das entradas de tarefas (Issue #005). Regras que dependem do estado
 * (transições, dependências existentes, ciclos, evidência) ficam em `taskStore.ts`, dentro da
 * mesma operação serializada que grava. Campos controlados pelo servidor (`id`, `projectId`,
 * `origin`, `completion`, `history`, datas) são recusados se vierem do cliente.
 */

/** Ids de tarefa usam o mesmo formato (UUID v4) dos projetos. */
export const TASK_ID_PATTERN = PROJECT_ID_PATTERN;

export interface TaskFields {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: TaskAssignee | null;
  dependsOn: string[];
  references: TaskReference[];
}
export type TaskPatch = Partial<TaskFields> & { blockedReason?: string };

/** Contexto da sessão/projeto usado para validar valores permitidos. */
export interface TaskInputContext {
  /** Repositórios vinculados ao projeto (e na allowlist): únicos alvos de referências. */
  repositories: readonly string[];
  /** Pessoas que podem receber tarefas (hoje, só o usuário da sessão). */
  assignableUserIds: readonly string[];
}

const CREATE_FIELDS = ['title', 'description', 'status', 'priority', 'assignee', 'dependsOn', 'references'] as const;
const UPDATE_FIELDS = [...CREATE_FIELDS, 'blockedReason'] as const;
type Field = (typeof UPDATE_FIELDS)[number];

/**
 * Nome de branch: subconjunto conservador das regras do Git (`git check-ref-format`). Sem `..`,
 * `//`, `@{`, barra ou ponto no fim, `.lock`, espaço, controle ou caracteres especiais.
 */
const BRANCH_PATTERN = /^(?![-/.])(?!.*(?:\.\.|\/\/|@\{|\/\.|\.lock$|[/.]$))[A-Za-z0-9._/-]{1,200}$/;
const MAX_REFERENCE_NUMBER = 1_000_000_000;

function invalid(): never {
  throw new IntegrationError('bad_request');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const present = Object.keys(record);
  if (present.length !== keys.length || !keys.every((key) => present.includes(key))) invalid();
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid();
  return value as T;
}

export function parseAssignee(value: unknown, context: TaskInputContext): TaskAssignee | null {
  if (value === null) return null;
  if (!isPlainObject(value)) invalid();
  if (value.kind === 'human') {
    exactKeys(value, ['kind', 'userId']);
    if (typeof value.userId !== 'string' || !context.assignableUserIds.includes(value.userId)) invalid();
    return { kind: 'human', userId: value.userId };
  }
  if (value.kind === 'agent') {
    exactKeys(value, ['kind', 'agentId']);
    return { kind: 'agent', agentId: parseEnum(value.agentId, AGENT_IDS) };
  }
  return invalid();
}

export function parseDependencies(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.dependenciesMax) invalid();
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !TASK_ID_PATTERN.test(id) || ids.includes(id)) invalid();
    ids.push(id);
  }
  return ids;
}

function parseReference(value: unknown, repositories: readonly string[]): TaskReference {
  if (!isPlainObject(value) || typeof value.repository !== 'string') invalid();
  const repository = repositories.find((name) => name.toLowerCase() === (value.repository as string).toLowerCase());
  // Referência só a repositório vinculado ao projeto: nada de apontar para repositórios arbitrários.
  if (repository === undefined) throw new IntegrationError('repository_not_allowed');
  if (value.kind === 'issue' || value.kind === 'pull_request') {
    exactKeys(value, ['kind', 'repository', 'number']);
    const { number } = value;
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_REFERENCE_NUMBER) invalid();
    return { kind: value.kind, repository, number };
  }
  if (value.kind === 'branch') {
    exactKeys(value, ['kind', 'repository', 'name']);
    if (typeof value.name !== 'string' || !BRANCH_PATTERN.test(value.name)) invalid();
    return { kind: 'branch', repository, name: value.name };
  }
  return invalid();
}

export function parseReferences(value: unknown, repositories: readonly string[]): TaskReference[] {
  if (!Array.isArray(value) || value.length > TASK_LIMITS.referencesMax) invalid();
  const references = value.map((item) => parseReference(item, repositories));
  const keys = references.map((r) => `${r.kind}|${r.repository.toLowerCase()}|${'number' in r ? r.number : r.name}`);
  if (new Set(keys).size !== keys.length) invalid();
  return references;
}

function parseField(key: Field, value: unknown, context: TaskInputContext) {
  switch (key) {
    case 'title':
      return parseText(value, { max: TASK_LIMITS.titleMax, required: true, multiline: false });
    case 'description':
      return parseText(value, { max: TASK_LIMITS.descriptionMax, required: false, multiline: true });
    case 'blockedReason':
      return parseText(value, { max: TASK_LIMITS.blockedReasonMax, required: false, multiline: false });
    case 'status':
      return parseEnum(value, TASK_STATUSES);
    case 'priority':
      return parseEnum(value, TASK_PRIORITIES);
    case 'assignee':
      return parseAssignee(value, context);
    case 'dependsOn':
      return parseDependencies(value);
    case 'references':
      return parseReferences(value, context.repositories);
  }
}

function asRecord(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(body)) invalid();
  for (const key of Object.keys(body)) if (!allowed.includes(key)) invalid();
  return body;
}

/** Criação: `title` obrigatório; status inicial só `pending` ou `planned` (padrão `pending`). */
export function parseTaskCreate(body: unknown, context: TaskInputContext): TaskFields {
  const record = asRecord(body, CREATE_FIELDS);
  if (!('title' in record)) invalid();
  const get = <T>(key: Field, fallback: T): T =>
    record[key] === undefined ? fallback : (parseField(key, record[key], context) as T);
  const status = get<TaskStatus>('status', 'pending');
  if (!TASK_INITIAL_STATUSES.includes(status)) throw new IntegrationError('invalid_status_transition');
  return {
    title: get('title', ''),
    description: get('description', ''),
    status,
    priority: get<TaskPriority>('priority', 'medium'),
    assignee: get<TaskAssignee | null>('assignee', null),
    dependsOn: get<string[]>('dependsOn', []),
    references: get<TaskReference[]>('references', []),
  };
}

/** Atualização parcial: ao menos um campo, cada um validado como na criação. */
export function parseTaskUpdate(body: unknown, context: TaskInputContext): TaskPatch {
  const record = asRecord(body, UPDATE_FIELDS);
  const keys = Object.keys(record) as Field[];
  if (keys.length === 0) invalid();
  const patch: TaskPatch = {};
  for (const key of keys) {
    if (record[key] === undefined) invalid();
    Object.assign(patch, { [key]: parseField(key, record[key], context) });
  }
  return patch;
}
