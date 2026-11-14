// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_LIMITS, TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from '../../shared/contracts.ts';
import { DataFileError } from '../storage/jsonFile.ts';
import { openTaskStore, TASKS_FORMAT, TASKS_VERSION } from './taskStore.ts';
import { parseTaskCreate, parseTaskUpdate, type TaskInputContext } from './validation.ts';

const REPO = 'Moreirapontocom-br/ai-command-center';
const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const P2 = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const CTX: TaskInputContext = { repositories: [REPO], assignableUserIds: ['admin'] };
const dirs: string[] = [];

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-tasks-'));
  dirs.push(dir);
  return join(dir, 'tasks.json');
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const fields = (body: Record<string, unknown> = {}) => parseTaskCreate({ title: 'Tarefa', ...body }, CTX);
const patch = (body: Record<string, unknown>) => parseTaskUpdate(body, CTX);

async function openStore(options: { writeFile?: (p: string, c: string) => Promise<void> } = {}) {
  const filePath = await tempFile();
  let clock = Date.parse('2026-11-13T12:00:00Z');
  const store = await openTaskStore({ filePath, now: () => (clock += 1000), ...options });
  return { store, filePath };
}

/** Leva uma tarefa até `target` por um caminho válido de transições. */
async function moveTo(store: Awaited<ReturnType<typeof openTaskStore>>, id: string, target: TaskStatus) {
  const path: Record<TaskStatus, Array<Record<string, unknown>>> = {
    pending: [],
    planned: [{ status: 'planned' }],
    in_progress: [{ status: 'in_progress' }],
    blocked: [{ status: 'blocked', blockedReason: 'aguardando' }],
    in_review: [{ status: 'in_progress' }, { status: 'in_review' }],
    done: [{ status: 'in_progress' }, { status: 'done' }],
    cancelled: [{ status: 'cancelled' }],
  };
  for (const step of path[target]) await store.update('admin', P1, id, patch(step), 'admin');
}

describe('validação de formato', () => {
  it('criação com padrões; status inicial só pendente/planejada', () => {
    expect(fields()).toEqual({
      title: 'Tarefa', description: '', status: 'pending', priority: 'medium', assignee: null, dependsOn: [], references: [],
    });
    expect(fields({ status: 'planned' }).status).toBe('planned');
    for (const status of ['in_progress', 'in_review', 'done', 'blocked', 'cancelled']) {
      expect(() => fields({ status })).toThrow(expect.objectContaining({ code: 'invalid_status_transition' }));
    }
  });

  it.each([
    ['sem título', { title: undefined }],
    ['título longo', { title: 'x'.repeat(TASK_LIMITS.titleMax + 1) }],
    ['descrição longa', { description: 'x'.repeat(TASK_LIMITS.descriptionMax + 1) }],
    ['prioridade inválida', { priority: 'urgent' }],
    ['origem vinda do cliente', { origin: 'agent' }],
    ['conclusão vinda do cliente', { completion: { confirmedBy: 'claude-code', confirmedAt: '2026-11-13T00:00:00Z' } }],
    ['histórico vindo do cliente', { history: [] }],
    ['projeto vindo do cliente', { projectId: P2 }],
    ['agente desconhecido', { assignee: { kind: 'agent', agentId: 'skynet' } }],
    ['pessoa não autorizada', { assignee: { kind: 'human', userId: 'outra-pessoa' } }],
    ['responsável com campo extra', { assignee: { kind: 'agent', agentId: 'gemini', authorized: true } }],
    ['dependência com id inválido', { dependsOn: ['abc'] }],
    ['dependência duplicada', { dependsOn: [P1, P1] }],
    ['dependências demais', { dependsOn: Array.from({ length: 21 }, (_, i) => `0f8fad5b-d9cb-469f-a165-${String(i).padStart(12, '0')}`) }],
    ['referência sem número válido', { references: [{ kind: 'issue', repository: REPO, number: 0 }] }],
    ['referência com número fracionário', { references: [{ kind: 'pull_request', repository: REPO, number: 1.5 }] }],
    ['branch com ..', { references: [{ kind: 'branch', repository: REPO, name: 'feature/../main' }] }],
    ['branch com espaço', { references: [{ kind: 'branch', repository: REPO, name: 'a b' }] }],
    ['branch terminando em .lock', { references: [{ kind: 'branch', repository: REPO, name: 'x.lock' }] }],
    ['tipo de referência desconhecido', { references: [{ kind: 'commit', repository: REPO, sha: 'abc' }] }],
    ['referência duplicada', { references: [{ kind: 'issue', repository: REPO, number: 5 }, { kind: 'issue', repository: REPO, number: 5 }] }],
  ])('recusa %s (400)', (_case, body) => {
    const merged = { title: 'T', ...body };
    if (merged.title === undefined) delete (merged as Record<string, unknown>).title;
    expect(() => parseTaskCreate(merged, CTX)).toThrow(expect.objectContaining({ code: 'bad_request' }));
  });

  it('referência a repositório não vinculado ao projeto: 422', () => {
    expect(() => fields({ references: [{ kind: 'issue', repository: 'octocat/hello-world', number: 1 }] })).toThrow(
      expect.objectContaining({ code: 'repository_not_allowed' }),
    );
  });

  it('referências válidas usam o nome canônico do repositório', () => {
    const refs = fields({
      references: [
        { kind: 'issue', repository: REPO.toLowerCase(), number: 5 },
        { kind: 'pull_request', repository: REPO, number: 37 },
        { kind: 'branch', repository: REPO, name: 'feature/005-task-management' },
      ],
    }).references;
    expect(refs.map((r) => r.repository)).toEqual([REPO, REPO, REPO]);
  });
});

describe('regras de tarefas', () => {
  it('cria, edita e persiste com histórico entre aberturas', async () => {
    const { store, filePath } = await openStore();
    const task = await store.create('admin', P1, fields({ priority: 'high' }), { actor: 'admin' });
    expect(task).toMatchObject({ projectId: P1, status: 'pending', priority: 'high', origin: 'manual', completion: null });
    expect(task).not.toHaveProperty('ownerId');
    await store.update('admin', P1, task.id, patch({ title: 'Novo título', assignee: { kind: 'agent', agentId: 'claude-code' } }), 'admin');

    const reopened = await openTaskStore({ filePath });
    const saved = reopened.get('admin', P1, task.id)!;
    expect(saved.title).toBe('Novo título');
    expect(saved.history.map((h) => h.action)).toEqual(['created', 'assignee_changed', 'updated']);
    expect(saved.history[1]).toMatchObject({ from: null, to: 'agent:claude-code', actor: 'admin' });
    expect(saved.history[2].fields).toEqual(['title']);
  });

  it('matriz de transições: permitidas passam, as demais são recusadas (409)', async () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (from === to) continue;
        const { store } = await openStore({ writeFile: async () => {} });
        const task = await store.create('admin', P1, fields(), { actor: 'admin' });
        await moveTo(store, task.id, from);
        const body = to === 'blocked' ? { status: to, blockedReason: 'motivo' } : { status: to };
        const result = store.update('admin', P1, task.id, patch(body), 'admin');
        if (TASK_TRANSITIONS[from].includes(to)) await expect(result).resolves.toMatchObject({ status: to });
        else await expect(result).rejects.toMatchObject({ code: 'invalid_status_transition' });
      }
    }
  });

  it('bloqueio exige motivo; sair do bloqueio limpa o motivo', async () => {
    const { store } = await openStore();
    const task = await store.create('admin', P1, fields(), { actor: 'admin' });
    await expect(store.update('admin', P1, task.id, patch({ status: 'blocked' }), 'admin')).rejects.toMatchObject({ code: 'bad_request' });
    await expect(store.update('admin', P1, task.id, patch({ blockedReason: 'x' }), 'admin')).rejects.toMatchObject({ code: 'bad_request' });
    const blocked = await store.update('admin', P1, task.id, patch({ status: 'blocked', blockedReason: 'Aguardando API' }), 'admin');
    expect(blocked?.blockedReason).toBe('Aguardando API');
    const resumed = await store.update('admin', P1, task.id, patch({ status: 'planned' }), 'admin');
    expect(resumed?.blockedReason).toBe('');
  });

  describe('dependências', () => {
    it('só tarefas existentes do mesmo projeto e dono; nunca a própria', async () => {
      const { store } = await openStore();
      const a = await store.create('admin', P1, fields(), { actor: 'admin' });
      const otherProject = await store.create('admin', P2, fields(), { actor: 'admin' });
      const otherOwner = await store.create('user-b', P1, fields(), { actor: 'user-b' });
      for (const dep of [otherProject.id, otherOwner.id, P2]) {
        await expect(store.create('admin', P1, fields({ dependsOn: [dep] }), { actor: 'admin' })).rejects.toMatchObject({ code: 'bad_request' });
      }
      await expect(store.update('admin', P1, a.id, patch({ dependsOn: [a.id] }), 'admin')).rejects.toMatchObject({ code: 'bad_request' });
      const b = await store.create('admin', P1, fields({ dependsOn: [a.id] }), { actor: 'admin' });
      expect(b.dependsOn).toEqual([a.id]);
    });

    it('ciclos diretos e indiretos são recusados (422) sem gravar nada', async () => {
      const { store, filePath } = await openStore();
      const a = await store.create('admin', P1, fields({ title: 'A' }), { actor: 'admin' });
      const b = await store.create('admin', P1, fields({ title: 'B', dependsOn: [a.id] }), { actor: 'admin' });
      const c = await store.create('admin', P1, fields({ title: 'C', dependsOn: [b.id] }), { actor: 'admin' });
      const before = await readFile(filePath, 'utf8');
      await expect(store.update('admin', P1, a.id, patch({ dependsOn: [b.id] }), 'admin')).rejects.toMatchObject({ code: 'dependency_cycle' });
      await expect(store.update('admin', P1, a.id, patch({ dependsOn: [c.id] }), 'admin')).rejects.toMatchObject({ code: 'dependency_cycle' });
      expect(await readFile(filePath, 'utf8')).toBe(before);
      expect(store.get('admin', P1, a.id)?.dependsOn).toEqual([]);
    });

    it('editar só o título de tarefa em andamento não reavalia dependências reabertas', async () => {
      const { store } = await openStore();
      const a = await store.create('admin', P1, fields(), { actor: 'admin' });
      const b = await store.create('admin', P1, fields({ dependsOn: [a.id] }), { actor: 'admin' });
      await moveTo(store, a.id, 'done');
      await store.update('admin', P1, b.id, patch({ status: 'in_progress' }), 'admin');
      await store.update('admin', P1, a.id, patch({ status: 'in_progress' }), 'admin'); // reaberta
      // O formulário reenvia todos os campos; só o título mudou.
      const edited = await store.update('admin', P1, b.id, patch({ title: 'Novo', dependsOn: [a.id] }), 'admin');
      expect(edited).toMatchObject({ title: 'Novo', status: 'in_progress' });
      expect(edited?.history.at(-1)).toMatchObject({ action: 'updated', fields: ['title'] });
    });

    it('iniciar, revisar ou concluir exige dependências concluídas ou canceladas (409)', async () => {
      const { store } = await openStore();
      const a = await store.create('admin', P1, fields(), { actor: 'admin' });
      const b = await store.create('admin', P1, fields({ dependsOn: [a.id] }), { actor: 'admin' });
      await expect(store.update('admin', P1, b.id, patch({ status: 'in_progress' }), 'admin')).rejects.toMatchObject({ code: 'dependencies_unresolved' });
      // Planejar ou bloquear continua possível.
      await expect(store.update('admin', P1, b.id, patch({ status: 'planned' }), 'admin')).resolves.toBeTruthy();
      await moveTo(store, a.id, 'done');
      await expect(store.update('admin', P1, b.id, patch({ status: 'in_progress' }), 'admin')).resolves.toMatchObject({ status: 'in_progress' });
      // Adicionar dependência pendente a uma tarefa em andamento também é recusado.
      const c = await store.create('admin', P1, fields(), { actor: 'admin' });
      await expect(store.update('admin', P1, b.id, patch({ dependsOn: [a.id, c.id] }), 'admin')).rejects.toMatchObject({ code: 'dependencies_unresolved' });
      await moveTo(store, c.id, 'cancelled');
      await expect(store.update('admin', P1, b.id, patch({ dependsOn: [a.id, c.id] }), 'admin')).resolves.toBeTruthy();
    });
  });

  describe('sem conclusão ou atribuição fictícia', () => {
    it('atribuir a agente não muda o status nem inicia execução', async () => {
      const { store } = await openStore();
      const task = await store.create('admin', P1, fields({ assignee: { kind: 'agent', agentId: 'claude-code' } }), { actor: 'admin' });
      expect(task.status).toBe('pending');
      const reassigned = await store.update('admin', P1, task.id, patch({ assignee: { kind: 'agent', agentId: 'gemini' } }), 'admin');
      expect(reassigned?.status).toBe('pending');
    });

    it('vincular PR/branch não conclui a tarefa (nada é inferido)', async () => {
      const { store } = await openStore();
      const task = await store.create('admin', P1, fields(), { actor: 'admin' });
      const linked = await store.update('admin', P1, task.id, patch({ references: [{ kind: 'pull_request', repository: REPO, number: 37 }] }), 'admin');
      expect(linked).toMatchObject({ status: 'pending', completion: null });
    });

    it('tarefa de agente só conclui com evidência (PR ou branch); issue não basta', async () => {
      const { store } = await openStore();
      const agent = { kind: 'agent', agentId: 'claude-code' };
      const task = await store.create('admin', P1, fields({ assignee: agent }), { actor: 'admin' });
      await store.update('admin', P1, task.id, patch({ status: 'in_progress' }), 'admin');
      await expect(store.update('admin', P1, task.id, patch({ status: 'done' }), 'admin')).rejects.toMatchObject({ code: 'evidence_required' });
      await expect(
        store.update('admin', P1, task.id, patch({ status: 'done', references: [{ kind: 'issue', repository: REPO, number: 5 }] }), 'admin'),
      ).rejects.toMatchObject({ code: 'evidence_required' });
      const done = await store.update(
        'admin', P1, task.id, patch({ status: 'done', references: [{ kind: 'pull_request', repository: REPO, number: 38 }] }), 'admin',
      );
      // A conclusão é registrada como confirmada pela PESSOA autenticada, nunca pelo agente.
      expect(done?.completion).toEqual({ confirmedBy: 'admin', confirmedAt: expect.any(String) });
      // Remover a evidência de uma tarefa concluída por agente também é recusado.
      await expect(store.update('admin', P1, task.id, patch({ references: [] }), 'admin')).rejects.toMatchObject({ code: 'evidence_required' });
      // Trocar o responsável de uma tarefa concluída sem evidência para agente: recusado.
      const human = await store.create('admin', P1, fields(), { actor: 'admin' });
      await moveTo(store, human.id, 'done');
      await expect(store.update('admin', P1, human.id, patch({ assignee: agent }), 'admin')).rejects.toMatchObject({ code: 'evidence_required' });
    });

    it('reabrir remove a confirmação de conclusão', async () => {
      const { store } = await openStore();
      const task = await store.create('admin', P1, fields(), { actor: 'admin' });
      await moveTo(store, task.id, 'done');
      const reopened = await store.update('admin', P1, task.id, patch({ status: 'in_progress' }), 'admin');
      expect(reopened?.completion).toBeNull();
    });

    it('origem é a informada pelo servidor (padrão manual)', async () => {
      const { store } = await openStore();
      expect((await store.create('admin', P1, fields(), { actor: 'admin' })).origin).toBe('manual');
      expect((await store.create('admin', P1, fields(), { actor: 'admin', origin: 'integration' })).origin).toBe('integration');
    });
  });

  it('isolamento: outro projeto ou dono não lê nem altera', async () => {
    const { store } = await openStore();
    const task = await store.create('admin', P1, fields(), { actor: 'admin' });
    expect(store.list('admin', P2)).toEqual([]);
    expect(store.list('user-b', P1)).toEqual([]);
    expect(store.get('admin', P2, task.id)).toBeNull();
    expect(store.get('user-b', P1, task.id)).toBeNull();
    expect(await store.update('admin', P2, task.id, patch({ title: 'x' }), 'admin')).toBeNull();
    expect(await store.update('user-b', P1, task.id, patch({ title: 'x' }), 'user-b')).toBeNull();
    expect(store.get('admin', P1, task.id)?.title).toBe('Tarefa');
  });

  it('falha de gravação não altera o estado em memória', async () => {
    let failing = false;
    const { store } = await openStore({ writeFile: async () => { if (failing) throw new Error('disco cheio'); } });
    const task = await store.create('admin', P1, fields(), { actor: 'admin' });
    failing = true;
    await expect(store.update('admin', P1, task.id, patch({ status: 'planned', title: 'novo' }), 'admin')).rejects.toThrow('disco cheio');
    await expect(store.create('admin', P1, fields(), { actor: 'admin' })).rejects.toThrow('disco cheio');
    expect(store.list('admin', P1)).toEqual([task]);
  });

  it('dados devolvidos são cópias: alterar o objeto não altera o armazenamento', async () => {
    const { store } = await openStore();
    const task = await store.create('admin', P1, fields(), { actor: 'admin' });
    task.status = 'done';
    task.history.push({ at: 'x', actor: 'x', action: 'created' });
    expect(store.get('admin', P1, task.id)).toMatchObject({ status: 'pending', history: [expect.anything()] });
  });

  it(`limite de ${TASK_LIMITS.tasksPerProjectMax} tarefas por projeto e de ${TASK_LIMITS.historyMax} entradas de histórico`, async () => {
    const { store } = await openStore({ writeFile: async () => {} });
    for (let i = 0; i < TASK_LIMITS.tasksPerProjectMax; i += 1) await store.create('admin', P1, fields(), { actor: 'admin' });
    await expect(store.create('admin', P1, fields(), { actor: 'admin' })).rejects.toMatchObject({ code: 'task_limit_reached' });
    const other = await store.create('admin', P2, fields(), { actor: 'admin' });
    for (let i = 0; i < TASK_LIMITS.historyMax + 5; i += 1) {
      await store.update('admin', P2, other.id, patch({ title: `t${i}` }), 'admin');
    }
    expect(store.get('admin', P2, other.id)?.history).toHaveLength(TASK_LIMITS.historyMax);
  });

  describe('arquivo corrompido: falha fechada, sem sobrescrever', () => {
    const base = {
      id: '6f1e8b2a-1c3d-4e5f-8a9b-0c1d2e3f4a5b', ownerId: 'admin', projectId: P1, title: 'T', description: '',
      status: 'pending', priority: 'medium', assignee: null, dependsOn: [], references: [], origin: 'manual',
      blockedReason: '', completion: null, history: [], createdAt: '2026-11-13T12:00:00.000Z', updatedAt: '2026-11-13T12:00:00.000Z',
    };
    const wrap = (tasks: unknown[]) => JSON.stringify({ format: TASKS_FORMAT, version: TASKS_VERSION, tasks });
    it.each([
      ['JSON ilegível', '{'],
      ['versão futura', JSON.stringify({ format: TASKS_FORMAT, version: 2, tasks: [] })],
      ['campo extra', wrap([{ ...base, executedBy: 'agent' }])],
      ['concluída sem confirmação', wrap([{ ...base, status: 'done' }])],
      ['confirmação sem estar concluída', wrap([{ ...base, completion: { confirmedBy: 'admin', confirmedAt: base.createdAt } }])],
      ['bloqueada sem motivo', wrap([{ ...base, status: 'blocked' }])],
      ['dependência inexistente', wrap([{ ...base, dependsOn: [P2] }])],
      ['dependência circular', wrap([{ ...base, dependsOn: [base.id] }])],
      ['agente desconhecido', wrap([{ ...base, assignee: { kind: 'agent', agentId: 'x' } }])],
    ])('%s', async (_case, content) => {
      const filePath = await tempFile();
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, content);
      await expect(openTaskStore({ filePath })).rejects.toBeInstanceOf(DataFileError);
      expect(await readFile(filePath, 'utf8')).toBe(content);
    });

    it('arquivo válido é aceito', async () => {
      const filePath = await tempFile();
      await writeFile(filePath, wrap([base]));
      expect((await openTaskStore({ filePath })).list('admin', P1)).toHaveLength(1);
    });
  });
});
