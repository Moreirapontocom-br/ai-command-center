import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROJECT_LIMITS, PROJECT_STATUSES, type Project } from '../../shared/contracts.ts';
import { IntegrationError } from '../github/errors.ts';
import { PROJECT_ID_PATTERN, parseRepositories, parseText, type ProjectFields } from './validation.ts';

/**
 * Persistência local dos projetos (Issue #004): um arquivo JSON fora do Git (`ACC_DATA_DIR`).
 *
 * - **Isolamento:** todo registro tem `ownerId`; toda operação recebe o `ownerId` da sessão e só
 *   enxerga os registros dele. Projeto de outro dono é indistinguível de inexistente (`null` → 404).
 * - **Integridade:** escrita atômica (arquivo temporário + `fsync` + `rename`), operações de escrita
 *   serializadas e estado em memória trocado só depois de gravar com sucesso. Na leitura, o arquivo
 *   é validado por completo; se estiver corrompido o servidor NÃO inicia e NÃO sobrescreve o arquivo.
 * - **Sem segredos:** o arquivo guarda apenas dados de projeto; nenhuma credencial ou sessão.
 */

export const STORE_FORMAT = 'acc-projects';
export const STORE_VERSION = 1;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

interface ProjectRecord extends Project {
  ownerId: string;
}

interface StoreData {
  projects: ProjectRecord[];
  /** Projeto ativo por dono. Lista (e não objeto) para não usar ids externos como chaves. */
  activeProjects: Array<{ ownerId: string; projectId: string }>;
}

export class ProjectStoreError extends Error {
  name = 'ProjectStoreError';
}

export interface ProjectStore {
  list(ownerId: string): { projects: Project[]; activeProjectId: string | null };
  get(ownerId: string, projectId: string): Project | null;
  create(ownerId: string, fields: ProjectFields): Promise<Project>;
  /** `null` se o projeto não existir para este dono. */
  update(ownerId: string, projectId: string, patch: Partial<ProjectFields>): Promise<Project | null>;
  /** `false` se o projeto não existir para este dono. `null` limpa a seleção. */
  setActive(ownerId: string, projectId: string | null): Promise<boolean>;
}

export interface ProjectStoreOptions {
  filePath: string;
  /** Allowlist atual: vínculos a repositórios retirados dela deixam de ser expostos. */
  allowedRepositories: readonly string[];
  now?: () => number;
  generateId?: () => string;
  /** Apenas para testes: substitui a gravação atômica. */
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Grava de forma atômica: o arquivo final só é substituído por um conteúdo completo e sincronizado
 * em disco. No Windows, antivírus/sincronização podem segurar o arquivo por instantes; o `rename`
 * é repetido algumas vezes antes de falhar.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt < 5 && RETRYABLE_RENAME.has(code)) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function corrupt(detail: string): never {
  // A mensagem descreve o problema estrutural, nunca o conteúdo do arquivo.
  throw new ProjectStoreError(`Arquivo de projetos inválido (${detail}). Corrija ou restaure um backup; ele não será sobrescrito.`);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function validateRecord(raw: unknown, index: number): ProjectRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) corrupt(`projeto ${index}`);
  const r = raw as Record<string, unknown>;
  const expected = ['id', 'ownerId', 'name', 'description', 'objective', 'status', 'repositories', 'createdAt', 'updatedAt'];
  const keys = Object.keys(r);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) corrupt(`campos do projeto ${index}`);
  if (typeof r.id !== 'string' || !PROJECT_ID_PATTERN.test(r.id)) corrupt(`id do projeto ${index}`);
  if (typeof r.ownerId !== 'string' || !OWNER_PATTERN.test(r.ownerId)) corrupt(`dono do projeto ${index}`);
  if (!isIsoDate(r.createdAt) || !isIsoDate(r.updatedAt)) corrupt(`datas do projeto ${index}`);
  if (typeof r.status !== 'string' || !(PROJECT_STATUSES as readonly string[]).includes(r.status)) {
    corrupt(`estado do projeto ${index}`);
  }
  try {
    const name = parseText(r.name, { max: PROJECT_LIMITS.nameMax, required: true, multiline: false });
    const description = parseText(r.description, { max: PROJECT_LIMITS.descriptionMax, required: false, multiline: true });
    const objective = parseText(r.objective, { max: PROJECT_LIMITS.objectiveMax, required: false, multiline: true });
    // Formato `owner/repo`; a allowlist atual é aplicada só na exposição (pode ter mudado).
    if (!Array.isArray(r.repositories) || !r.repositories.every((x) => typeof x === 'string' && /^[^/\s]+\/[^/\s]+$/.test(x))) {
      corrupt(`repositórios do projeto ${index}`);
    }
    const repositories = parseRepositories(r.repositories, r.repositories as string[]);
    return {
      id: r.id,
      ownerId: r.ownerId,
      name,
      description,
      objective,
      status: r.status as Project['status'],
      repositories,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  } catch (error) {
    if (error instanceof ProjectStoreError) throw error;
    return corrupt(`conteúdo do projeto ${index}`);
  }
}

function validateData(raw: unknown): StoreData {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) corrupt('estrutura');
  const r = raw as Record<string, unknown>;
  if (r.format !== STORE_FORMAT) corrupt('formato');
  if (r.version !== STORE_VERSION) corrupt('versão não suportada');
  if (!Array.isArray(r.projects) || !Array.isArray(r.activeProjects)) corrupt('estrutura');
  const projects = r.projects.map(validateRecord);
  if (new Set(projects.map((p) => p.id)).size !== projects.length) corrupt('ids duplicados');
  const activeProjects = r.activeProjects.map((entry, index) => {
    const e = entry as Record<string, unknown>;
    if (typeof e !== 'object' || e === null || typeof e.ownerId !== 'string' || typeof e.projectId !== 'string') {
      corrupt(`projeto ativo ${index}`);
    }
    const owned = projects.some((p) => p.id === e.projectId && p.ownerId === e.ownerId);
    if (!owned) corrupt(`projeto ativo ${index}`);
    return { ownerId: e.ownerId, projectId: e.projectId };
  });
  if (new Set(activeProjects.map((a) => a.ownerId)).size !== activeProjects.length) corrupt('projeto ativo duplicado');
  return { projects, activeProjects };
}

async function loadData(filePath: string): Promise<StoreData> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    // Primeiro uso: o arquivo é criado na primeira escrita.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [], activeProjects: [] };
    throw new ProjectStoreError('Não foi possível ler o arquivo de projetos.');
  }
  if (size > MAX_FILE_BYTES) corrupt('tamanho acima do limite');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return corrupt('JSON ilegível');
  }
  return validateData(parsed);
}

function serialize(data: StoreData): string {
  return `${JSON.stringify({ format: STORE_FORMAT, version: STORE_VERSION, ...data }, null, 2)}\n`;
}

export async function openProjectStore(options: ProjectStoreOptions): Promise<ProjectStore> {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? randomUUID;
  const write = options.writeFile ?? writeFileAtomic;
  let data = await loadData(options.filePath);
  let queue: Promise<unknown> = Promise.resolve();

  // `ownerId` nunca sai do servidor.
  const toProject = (record: ProjectRecord): Project => ({
    id: record.id,
    name: record.name,
    description: record.description,
    objective: record.objective,
    status: record.status,
    repositories: record.repositories.filter((name) => options.allowedRepositories.includes(name)),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  const find = (ownerId: string, projectId: string) =>
    data.projects.find((p) => p.ownerId === ownerId && p.id === projectId);

  /** Aplica uma alteração numa cópia, grava e só então a torna visível. Uma escrita por vez. */
  function mutate<T>(change: (draft: StoreData) => T): Promise<T> {
    const run = queue.then(async () => {
      const draft = structuredClone(data);
      const result = change(draft);
      await write(options.filePath, serialize(draft));
      data = draft;
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  }

  return {
    list(ownerId) {
      const projects = data.projects.filter((p) => p.ownerId === ownerId).map(toProject);
      const active = data.activeProjects.find((a) => a.ownerId === ownerId)?.projectId ?? null;
      return { projects, activeProjectId: active };
    },

    get(ownerId, projectId) {
      const record = find(ownerId, projectId);
      return record ? toProject(record) : null;
    },

    create(ownerId, fields) {
      return mutate((draft) => {
        if (draft.projects.filter((p) => p.ownerId === ownerId).length >= PROJECT_LIMITS.projectsPerOwnerMax) {
          throw new IntegrationError('project_limit_reached');
        }
        let id = generateId();
        while (draft.projects.some((p) => p.id === id)) id = generateId();
        const at = new Date(now()).toISOString();
        const record: ProjectRecord = { id, ownerId, ...fields, repositories: [...fields.repositories], createdAt: at, updatedAt: at };
        draft.projects.push(record);
        return toProject(record);
      });
    },

    update(ownerId, projectId, patch) {
      if (!find(ownerId, projectId)) return Promise.resolve(null);
      return mutate((draft) => {
        const record = draft.projects.find((p) => p.ownerId === ownerId && p.id === projectId);
        if (!record) return null;
        Object.assign(record, patch, { updatedAt: new Date(now()).toISOString() });
        if (patch.repositories) record.repositories = [...patch.repositories];
        return toProject(record);
      });
    },

    setActive(ownerId, projectId) {
      if (projectId !== null && !find(ownerId, projectId)) return Promise.resolve(false);
      return mutate((draft) => {
        if (projectId !== null && !draft.projects.some((p) => p.ownerId === ownerId && p.id === projectId)) return false;
        draft.activeProjects = draft.activeProjects.filter((a) => a.ownerId !== ownerId);
        if (projectId !== null) draft.activeProjects.push({ ownerId, projectId });
        return true;
      });
    },
  };
}
