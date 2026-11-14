// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_LIMITS } from '../../shared/contracts.ts';
import { IntegrationError } from '../github/errors.ts';
import { openProjectStore, ProjectStoreError, STORE_FORMAT, STORE_VERSION } from './projectStore.ts';
import { parseActiveProject, parseProjectCreate, parseProjectUpdate } from './validation.ts';

const REPO = 'Moreirapontocom-br/ai-command-center';
const ALLOWED = [REPO];
const dirs: string[] = [];

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-projects-'));
  dirs.push(dir);
  return join(dir, 'nested', 'projects.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fields = (overrides: Record<string, unknown> = {}) => parseProjectCreate({ name: 'Projeto A', ...overrides }, ALLOWED);

describe('validação de entradas', () => {
  it('criação: só o nome é obrigatório; padrões aplicados e texto normalizado', () => {
    expect(fields({ description: '  linha 1\r\nlinha 2  ' })).toEqual({
      name: 'Projeto A',
      description: 'linha 1\nlinha 2',
      objective: '',
      status: 'planning',
      repositories: [],
    });
  });

  it.each([
    ['sem nome', {}],
    ['nome vazio', { name: '   ' }],
    ['nome não string', { name: 42 }],
    ['nome com quebra de linha', { name: 'a\nb' }],
    ['nome com caractere de controle', { name: 'a\u0007b' }],
    ['texto com controle bidirecional', { name: 'ok', description: 'abc‮def' }],
    ['nome longo demais', { name: 'x'.repeat(PROJECT_LIMITS.nameMax + 1) }],
    ['descrição longa demais', { name: 'ok', description: 'x'.repeat(PROJECT_LIMITS.descriptionMax + 1) }],
    ['objetivo longo demais', { name: 'ok', objective: 'x'.repeat(PROJECT_LIMITS.objectiveMax + 1) }],
    ['estado desconhecido', { name: 'ok', status: 'deleted' }],
    ['campo desconhecido', { name: 'ok', ownerId: 'outro' }],
    ['id informado pelo cliente', { name: 'ok', id: 'x' }],
    ['repositórios não lista', { name: 'ok', repositories: REPO }],
    ['repositório duplicado', { name: 'ok', repositories: [REPO, REPO.toUpperCase()] }],
    ['corpo não objeto', null],
    ['corpo lista', []],
  ])('recusa %s com 400', (_case, body) => {
    expect(() => parseProjectCreate(body, ALLOWED)).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });

  it('limites contam caracteres, não unidades UTF-16', () => {
    expect(fields({ name: '😀'.repeat(PROJECT_LIMITS.nameMax) }).name).toHaveLength(PROJECT_LIMITS.nameMax * 2);
  });

  it('repositório fora da allowlist: 422, sem consultar nada', () => {
    expect(() => fields({ repositories: ['octocat/hello-world'] })).toThrow(
      expect.objectContaining({ code: 'repository_not_allowed' }),
    );
  });

  it('repositório com outra caixa é aceito com o nome canônico', () => {
    expect(fields({ repositories: [REPO.toLowerCase()] }).repositories).toEqual([REPO]);
  });

  it('atualização parcial exige ao menos um campo válido', () => {
    expect(parseProjectUpdate({ status: 'active' }, ALLOWED)).toEqual({ status: 'active' });
    for (const body of [{}, { name: '' }, { status: undefined }, { foo: 1 }]) {
      expect(() => parseProjectUpdate(body, ALLOWED)).toThrow(IntegrationError);
    }
  });

  it('seleção do projeto ativo aceita UUID ou null', () => {
    expect(parseActiveProject({ projectId: null })).toBeNull();
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(parseActiveProject({ projectId: id })).toBe(id);
    for (const body of [{}, { projectId: 'abc' }, { projectId: id.toUpperCase() }, { projectId: id, x: 1 }, [id]]) {
      expect(() => parseActiveProject(body)).toThrow(IntegrationError);
    }
  });
});

describe('armazenamento de projetos', () => {
  it('cria, lista, atualiza e persiste em disco entre aberturas', async () => {
    const filePath = await tempFile();
    let clock = Date.parse('2026-11-13T10:00:00Z');
    const store = await openProjectStore({ filePath, allowedRepositories: ALLOWED, now: () => clock });
    expect(store.list('admin')).toEqual({ projects: [], activeProjectId: null });

    const created = await store.create('admin', fields({ repositories: [REPO] }));
    expect(created).toMatchObject({ name: 'Projeto A', status: 'planning', repositories: [REPO] });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).not.toHaveProperty('ownerId');

    clock += 60_000;
    const updated = await store.update('admin', created.id, { status: 'active', objective: 'MVP' });
    expect(updated).toMatchObject({ status: 'active', objective: 'MVP', createdAt: created.createdAt });
    expect(updated?.updatedAt).toBe('2026-11-13T10:01:00.000Z');
    expect(await store.setActive('admin', created.id)).toBe(true);

    const reopened = await openProjectStore({ filePath, allowedRepositories: ALLOWED });
    expect(reopened.list('admin')).toEqual({ projects: [updated], activeProjectId: created.id });

    const onDisk = JSON.parse(await readFile(filePath, 'utf8'));
    expect(onDisk).toMatchObject({ format: STORE_FORMAT, version: STORE_VERSION });
    expect(onDisk.projects[0].ownerId).toBe('admin');
    // Nenhum arquivo temporário sobra após a gravação atômica.
    expect(await readdir(join(filePath, '..'))).toEqual(['projects.json']);
  });

  it('projeto sem repositório é válido (GitHub é opcional)', async () => {
    const store = await openProjectStore({ filePath: await tempFile(), allowedRepositories: ALLOWED });
    const project = await store.create('admin', fields());
    expect(project.repositories).toEqual([]);
  });

  it('isolamento por dono: outro dono não lê, não edita e não seleciona', async () => {
    const store = await openProjectStore({ filePath: await tempFile(), allowedRepositories: ALLOWED });
    const mine = await store.create('admin', fields());
    const theirs = await store.create('user-b', fields({ name: 'Projeto B' }));

    expect(store.list('admin').projects.map((p) => p.id)).toEqual([mine.id]);
    expect(store.list('user-b').projects.map((p) => p.id)).toEqual([theirs.id]);
    expect(store.get('admin', theirs.id)).toBeNull();
    expect(await store.update('admin', theirs.id, { name: 'invadido' })).toBeNull();
    expect(await store.setActive('admin', theirs.id)).toBe(false);
    expect(store.get('user-b', theirs.id)?.name).toBe('Projeto B');
    // A seleção de um dono não afeta a do outro.
    await store.setActive('admin', mine.id);
    expect(store.list('user-b').activeProjectId).toBeNull();
  });

  it('falha na gravação não altera o estado em memória', async () => {
    let failing = false;
    const store = await openProjectStore({
      filePath: await tempFile(),
      allowedRepositories: ALLOWED,
      writeFile: async () => {
        if (failing) throw new Error('disco cheio');
      },
    });
    const project = await store.create('admin', fields());
    failing = true;
    await expect(store.update('admin', project.id, { name: 'novo' })).rejects.toThrow('disco cheio');
    await expect(store.create('admin', fields({ name: 'outro' }))).rejects.toThrow('disco cheio');
    expect(store.list('admin').projects).toEqual([project]);
  });

  it('escritas concorrentes são serializadas sem perda', async () => {
    const filePath = await tempFile();
    const store = await openProjectStore({ filePath, allowedRepositories: ALLOWED });
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.create('admin', fields({ name: `P${i}` }))));
    const reopened = await openProjectStore({ filePath, allowedRepositories: ALLOWED });
    expect(reopened.list('admin').projects).toHaveLength(10);
  });

  it(`limite de ${PROJECT_LIMITS.projectsPerOwnerMax} projetos por dono`, async () => {
    const store = await openProjectStore({ filePath: await tempFile(), allowedRepositories: ALLOWED, writeFile: async () => {} });
    for (let i = 0; i < PROJECT_LIMITS.projectsPerOwnerMax; i += 1) await store.create('admin', fields());
    await expect(store.create('admin', fields())).rejects.toMatchObject({ code: 'project_limit_reached' });
    await expect(store.create('user-b', fields())).resolves.toBeDefined();
  });

  it('repositório retirado da allowlist deixa de ser exposto', async () => {
    const filePath = await tempFile();
    const store = await openProjectStore({ filePath, allowedRepositories: ALLOWED });
    const project = await store.create('admin', fields({ repositories: [REPO] }));
    const narrowed = await openProjectStore({ filePath, allowedRepositories: [] });
    expect(narrowed.get('admin', project.id)?.repositories).toEqual([]);
  });

  describe('arquivo corrompido: falha fechada, sem sobrescrever', () => {
    const valid = {
      id: '0f8fad5b-d9cb-469f-a165-70867728950e',
      ownerId: 'admin',
      name: 'A',
      description: '',
      objective: '',
      status: 'planning',
      repositories: [],
      createdAt: '2026-11-13T10:00:00.000Z',
      updatedAt: '2026-11-13T10:00:00.000Z',
    };
    const wrap = (projects: unknown[], activeProjects: unknown[] = []) =>
      JSON.stringify({ format: STORE_FORMAT, version: 1, projects, activeProjects });

    it.each([
      ['JSON ilegível', '{"format":'],
      ['formato errado', JSON.stringify({ format: 'x', version: 1, projects: [], activeProjects: [] })],
      ['versão futura', JSON.stringify({ format: STORE_FORMAT, version: 99, projects: [], activeProjects: [] })],
      ['campo extra', wrap([{ ...valid, secret: 'x' }])],
      ['id inválido', wrap([{ ...valid, id: '../../etc' }])],
      ['ids duplicados', wrap([valid, valid])],
      ['nome com controle', wrap([{ ...valid, name: 'a\u0000' }])],
      ['estado inválido', wrap([{ ...valid, status: 'x' }])],
      ['ativo de outro dono', wrap([valid], [{ ownerId: 'user-b', projectId: valid.id }])],
    ])('%s', async (_case, content) => {
      const filePath = await tempFile();
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content);
      const error = await openProjectStore({ filePath, allowedRepositories: ALLOWED }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectStoreError);
      // A mensagem não repete o conteúdo do arquivo.
      expect(String((error as Error).message)).not.toContain('secret');
      expect(await readFile(filePath, 'utf8')).toBe(content);
    });

    it('arquivo válido é aceito', async () => {
      const filePath = await tempFile();
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, wrap([valid], [{ ownerId: 'admin', projectId: valid.id }]));
      const store = await openProjectStore({ filePath, allowedRepositories: ALLOWED });
      expect(store.list('admin').activeProjectId).toBe(valid.id);
    });
  });
});
