import {
  PROJECT_LIMITS,
  PROJECT_STATUSES,
  type ProjectCreateRequest,
  type ProjectStatus,
} from '../../shared/contracts.ts';
import { IntegrationError } from '../github/errors.ts';

/**
 * Validação das entradas de projetos (Issue #004). O servidor é a única autoridade: o formulário
 * do navegador repete os limites só por conveniência. Toda falha vira `bad_request` (400), exceto
 * repositório fora da allowlist (`repository_not_allowed`, 422). Nenhuma mensagem repete o valor
 * recebido.
 */

export interface ProjectFields {
  name: string;
  description: string;
  objective: string;
  status: ProjectStatus;
  repositories: string[];
}

/** UUID v4 em minúsculas, como gerado por `crypto.randomUUID()`. */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Controles C0/C1 (exceto TAB e LF, tratados à parte) e controles de direção bidirecional, que
// permitem disfarçar texto na interface ("Trojan Source").
// eslint-disable-next-line no-control-regex -- recusar caracteres de controle é exatamente o objetivo.
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
const LINE_CHARS = /[\t\n]/;

const FIELDS = ['name', 'description', 'objective', 'status', 'repositories'] as const;

function invalid(): never {
  throw new IntegrationError('bad_request');
}

/** Tamanho em caracteres (pontos de código), não em unidades UTF-16. */
const codePoints = (value: string) => [...value].length;

/** Normaliza (NFC, quebras de linha `\n`, sem espaços nas pontas) e valida um campo de texto. */
export function parseText(value: unknown, options: { max: number; required: boolean; multiline: boolean }): string {
  if (typeof value !== 'string') invalid();
  const text = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (options.required && text.length === 0) invalid();
  if (FORBIDDEN_CHARS.test(text)) invalid();
  if (!options.multiline && LINE_CHARS.test(text)) invalid();
  if (codePoints(text) > options.max) invalid();
  return text;
}

function parseStatus(value: unknown): ProjectStatus {
  if (typeof value !== 'string' || !(PROJECT_STATUSES as readonly string[]).includes(value)) invalid();
  return value as ProjectStatus;
}

/**
 * Valida a lista de repositórios contra `linkable` (allowlist do servidor ∩ escopo da sessão).
 * A comparação ignora maiúsculas e devolve o nome canônico da allowlist. Duplicatas são recusadas.
 * Nada aqui consulta o GitHub: vincular é só registrar um nome já autorizado.
 */
export function parseRepositories(value: unknown, linkable: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > PROJECT_LIMITS.repositoriesMax) invalid();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 140) invalid();
    const match = linkable.find((fullName) => fullName.toLowerCase() === item.toLowerCase());
    if (match === undefined) throw new IntegrationError('repository_not_allowed');
    if (result.includes(match)) invalid();
    result.push(match);
  }
  return result;
}

function asPlainObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid();
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(FIELDS as readonly string[]).includes(key)) invalid();
  }
  return record;
}

function parseField(key: (typeof FIELDS)[number], value: unknown, linkable: readonly string[]) {
  switch (key) {
    case 'name':
      return parseText(value, { max: PROJECT_LIMITS.nameMax, required: true, multiline: false });
    case 'description':
      return parseText(value, { max: PROJECT_LIMITS.descriptionMax, required: false, multiline: true });
    case 'objective':
      return parseText(value, { max: PROJECT_LIMITS.objectiveMax, required: false, multiline: true });
    case 'status':
      return parseStatus(value);
    case 'repositories':
      return parseRepositories(value, linkable);
  }
}

/** Corpo de criação: `name` obrigatório; os demais campos têm padrão (texto vazio, `planning`, sem repositórios). */
export function parseProjectCreate(body: unknown, linkable: readonly string[]): ProjectFields {
  const record = asPlainObject(body) as Partial<Record<keyof ProjectCreateRequest, unknown>>;
  if (!('name' in record)) invalid();
  return {
    name: parseField('name', record.name, linkable) as string,
    description: record.description === undefined ? '' : (parseField('description', record.description, linkable) as string),
    objective: record.objective === undefined ? '' : (parseField('objective', record.objective, linkable) as string),
    status: record.status === undefined ? 'planning' : (parseField('status', record.status, linkable) as ProjectStatus),
    repositories:
      record.repositories === undefined ? [] : (parseField('repositories', record.repositories, linkable) as string[]),
  };
}

/** Corpo de atualização parcial: ao menos um campo conhecido, cada um validado como na criação. */
export function parseProjectUpdate(body: unknown, linkable: readonly string[]): Partial<ProjectFields> {
  const record = asPlainObject(body);
  const keys = Object.keys(record) as Array<(typeof FIELDS)[number]>;
  if (keys.length === 0) invalid();
  const patch: Partial<ProjectFields> = {};
  for (const key of keys) {
    if (record[key] === undefined) invalid();
    Object.assign(patch, { [key]: parseField(key, record[key], linkable) });
  }
  return patch;
}

/** Corpo de `POST /api/projects/active`: `{ projectId: string | null }`. */
export function parseActiveProject(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid();
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'projectId') invalid();
  const { projectId } = body as { projectId: unknown };
  if (projectId === null) return null;
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) invalid();
  return projectId;
}
