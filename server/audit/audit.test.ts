// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openProjectStore, STORE_FORMAT } from '../projects/projectStore.ts';
import { parseProjectCreate } from '../projects/validation.ts';
import { DataFileError } from '../storage/jsonFile.ts';
import { openTaskStore } from '../tasks/taskStore.ts';
import { parseTaskCreate } from '../tasks/validation.ts';
import { AUDIT_FORMAT, createAuditSequence, openAuditLog, queryAudit } from './auditLog.ts';
import { applyRetention, makeEvent, type AuditEventInput, type StoredAuditEvent } from './events.ts';

const P1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'acc-audit-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const input = (overrides: Partial<AuditEventInput> = {}): AuditEventInput => ({
  action: 'auth.login',
  actor: { kind: 'human', id: 'admin' },
  ownerId: 'admin',
  projectId: null,
  resource: { type: 'session', id: null },
  outcome: 'success',
  ...overrides,
});

describe('formato dos eventos (contra contaminação)', () => {
  it.each([
    ['texto livre no contexto', { context: { reason: 'senha errada: hunter2' } }],
    ['e-mail no contexto', { context: { reason: 'admin@example.test' } }],
    ['chave de contexto desconhecida', { context: { password: 'x' } }],
    ['cabeçalho no contexto', { context: { cookie: 'acc_session=abc' } }],
    ['lista com texto livre', { context: { fields: ['ok', 'não ok'] } }],
    ['número não finito', { context: { from: Number.NaN } }],
    ['autor com id inválido', { actor: { kind: 'human', id: 'Admin Root' } }],
    ['tipo de autor desconhecido', { actor: { kind: 'root', id: 'x' } as never }],
    ['ação desconhecida', { action: 'project.deleted' as never }],
    ['projeto com id inválido', { projectId: '../x' }],
    ['recurso com id de texto livre', { resource: { type: 'task', id: 'título da tarefa' } }],
  ])('recusa %s', (_case, overrides) => {
    expect(() => makeEvent(input(overrides as Partial<AuditEventInput>), 1, '2026-11-14T00:00:00.000Z')).toThrow();
  });

  it('aceita tokens, ids, números, booleanos, null e listas curtas de tokens', () => {
    const event = makeEvent(
      input({ context: { from: 'in_progress', to: 'agent:claude-code', fields: ['title', 'dependsOn'], cleared: false, reason: null } }),
      7,
      '2026-11-14T00:00:00.000Z',
    );
    expect(event).toMatchObject({ seq: 7, actor: { kind: 'human', id: 'admin' } });
  });
});

describe('retenção', () => {
  const ev = (seq: number, anonymous: boolean): StoredAuditEvent =>
    makeEvent(
      input(anonymous ? { actor: { kind: 'system', id: 'anonymous' }, ownerId: null, action: 'access.denied', outcome: 'blocked' } : {}),
      seq,
      '2026-11-14T00:00:00.000Z',
    );

  it('descarta primeiro os eventos anônimos mais antigos e contabiliza o descarte', () => {
    const log = { events: [ev(1, false), ev(2, true), ev(3, false), ev(4, true), ev(5, false)], droppedEvents: 3 };
    applyRetention(log, 3);
    expect(log.events.map((e) => e.seq)).toEqual([1, 3, 5]);
    expect(log.droppedEvents).toBe(5);
    applyRetention(log, 2);
    expect(log.events.map((e) => e.seq)).toEqual([3, 5]);
    expect(log.droppedEvents).toBe(6);
  });
});

describe('registro avulso (audit.json)', () => {
  it('persiste entre aberturas, com sequência contínua e somente adição', async () => {
    const filePath = join(await tempDir(), 'audit.json');
    const log = await openAuditLog({ filePath, sequence: createAuditSequence() });
    const a = await log.append(input());
    const b = await log.append(input({ action: 'auth.logout' }));
    expect(b.seq).toBe(a.seq + 1);
    const sequence = createAuditSequence();
    const reopened = await openAuditLog({ filePath, sequence });
    expect(reopened.log().events.map((e) => e.id)).toEqual([a.id, b.id]);
    expect((await reopened.append(input())).seq).toBe(b.seq + 1);
    // A interface do registro não oferece edição nem exclusão.
    expect(Object.keys(reopened).sort()).toEqual(['append', 'log']);
  });

  it('falha de gravação rejeita a promessa e não adiciona o evento', async () => {
    const filePath = join(await tempDir(), 'audit.json');
    let failing = false;
    const log = await openAuditLog({ filePath, sequence: createAuditSequence(), writeFile: async () => { if (failing) throw new Error('disco cheio'); } });
    await log.append(input());
    failing = true;
    await expect(log.append(input())).rejects.toThrow('disco cheio');
    expect(log.log().events).toHaveLength(1);
  });

  it.each([
    ['JSON ilegível', '{'],
    ['evento com campo extra', { events: [{ ...makeEvent(input(), 1, '2026-11-14T00:00:00.000Z'), token: 'x' }], droppedEvents: 0 }],
    ['evento com texto livre', { events: [{ ...makeEvent(input(), 1, '2026-11-14T00:00:00.000Z'), context: { reason: 'texto livre aqui' } }], droppedEvents: 0 }],
    ['ordem de seq quebrada', { events: [makeEvent(input(), 2, '2026-11-14T00:00:00.000Z'), makeEvent(input(), 1, '2026-11-14T00:00:00.000Z')], droppedEvents: 0 }],
    ['contador de retenção inválido', { events: [], droppedEvents: -1 }],
  ])('arquivo corrompido (%s): não abre e não é sobrescrito', async (_case, body) => {
    const filePath = join(await tempDir(), 'audit.json');
    const content = typeof body === 'string' ? body : JSON.stringify({ format: AUDIT_FORMAT, version: 1, ...body });
    await writeFile(filePath, content);
    await expect(openAuditLog({ filePath, sequence: createAuditSequence() })).rejects.toBeInstanceOf(DataFileError);
    expect(await readFile(filePath, 'utf8')).toBe(content);
  });
});

describe('eventos no mesmo arquivo da alteração', () => {
  it('projeto v1 é migrado; criar grava projeto e evento juntos; falha não grava nenhum', async () => {
    const dir = await tempDir();
    const filePath = join(dir, 'projects.json');
    await writeFile(filePath, JSON.stringify({ format: STORE_FORMAT, version: 1, projects: [], activeProjects: [] }));
    let failing = false;
    const store = await openProjectStore({
      filePath,
      allowedRepositories: [],
      sequence: createAuditSequence(),
      writeFile: async (path, content) => {
        if (failing) throw new Error('disco cheio');
        await writeFile(path, content);
      },
    });
    const project = await store.create('admin', parseProjectCreate({ name: 'A' }, []));
    const disk = JSON.parse(await readFile(filePath, 'utf8'));
    expect(disk.version).toBe(2);
    expect(disk.projects).toHaveLength(1);
    expect(disk.events).toHaveLength(1);
    expect(disk.events[0]).toMatchObject({ action: 'project.created', resource: { id: project.id }, actor: { kind: 'human', id: 'admin' } });

    failing = true;
    await expect(store.update('admin', project.id, { name: 'B' })).rejects.toThrow();
    expect(store.auditLog().events).toHaveLength(1);
    expect(store.get('admin', project.id)?.name).toBe('A');
  });

  it('tarefa: regra violada não deixa evento nem alteração', async () => {
    const store = await openTaskStore({ filePath: join(await tempDir(), 'tasks.json'), sequence: createAuditSequence() });
    const ctx = { repositories: [], assignableUserIds: ['admin'] };
    const task = await store.create('admin', P1, parseTaskCreate({ title: 'T' }, ctx), { actor: 'admin' });
    await expect(store.update('admin', P1, task.id, { status: 'done' }, 'admin')).rejects.toMatchObject({ code: 'invalid_status_transition' });
    expect(store.auditLog().events.map((e) => e.action)).toEqual(['task.created']);
  });
});

describe('consulta', () => {
  it('isola por dono, inclui eventos da instância só quando permitido e respeita o limite máximo', () => {
    const owned = Array.from({ length: 250 }, (_, i) => makeEvent(input(), i + 1, '2026-11-14T00:00:00.000Z'));
    const other = makeEvent(input({ ownerId: 'user-b', actor: { kind: 'human', id: 'user-b' } }), 300, '2026-11-14T00:00:00.000Z');
    const instance = makeEvent(input({ ownerId: null, actor: { kind: 'system', id: 'anonymous' }, action: 'auth.login_rejected', outcome: 'failure' }), 301, '2026-11-14T00:00:00.000Z');
    const sources = [{ events: [...owned, other, instance], droppedEvents: 4 }];

    const admin = queryAudit(sources, { ownerId: 'admin', includeInstanceEvents: true, limit: 1000 });
    expect(admin.events).toHaveLength(200);
    expect(admin.events[0].seq).toBe(301);
    expect(admin.events.some((e) => e.seq === 300)).toBe(false);
    expect(admin.droppedEvents).toBe(4);
    expect(admin.events[0]).not.toHaveProperty('ownerId');

    const user = queryAudit(sources, { ownerId: 'user-b', includeInstanceEvents: false });
    expect(user.events.map((e) => e.seq)).toEqual([300]);
    expect(user.nextBefore).toBeNull();
  });
});
