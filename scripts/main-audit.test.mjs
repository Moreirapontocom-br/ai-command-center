// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { analyzePushEvent, auditCommits, classifyCommit, overallStatus, renderReport, STATUS } from './main-audit-lib.mjs';

const sha = (c) => c.repeat(40);
const mergedPr = (number, mergeSha, base = 'main') => ({
  number,
  state: 'closed',
  merged_at: '2026-11-13T17:18:23Z',
  merge_commit_sha: mergeSha,
  base: { ref: base },
});
const openPr = (number) => ({ number, state: 'open', merged_at: null, merge_commit_sha: null, base: { ref: 'main' } });

function pushEvent(overrides = {}) {
  return {
    ref: 'refs/heads/main',
    before: sha('a'),
    after: sha('c'),
    created: false,
    deleted: false,
    forced: false,
    pusher: { name: 'Moreirapontocom-br' },
    commits: [{ id: sha('b') }, { id: sha('c') }],
    ...overrides,
  };
}

const noSleep = () => Promise.resolve();

describe('auditoria da main: classificação de commits', () => {
  it.each([
    ['merge commit (o próprio commit de merge)', sha('c'), [mergedPr(32, sha('c'))]],
    ['commit da branch trazido por merge commit', sha('b'), [mergedPr(32, sha('c'))]],
    ['squash merge', sha('d'), [mergedPr(40, sha('d'))]],
    ['rebase merge (commit reescrito associado ao PR)', sha('e'), [mergedPr(41, sha('f'))]],
  ])('%s → ok', (_label, commit, pulls) => {
    expect(classifyCommit(commit, pulls).status).toBe(STATUS.OK);
  });

  it('PR mesclado em outra base não conta para a main', () => {
    expect(classifyCommit(sha('b'), [mergedPr(9, sha('b'), 'develop')]).status).toBe(STATUS.ATTENTION);
  });

  it('commit sem PR → atenção (não afirma violação)', () => {
    const r = classifyCommit(sha('b'), []);
    expect(r.status).toBe(STATUS.ATTENTION);
    expect(r.detail).toMatch(/revisar manualmente/);
    expect(r.detail).not.toMatch(/viola/i);
  });

  it('commit ligado a PR ainda aberto → atenção específica', () => {
    expect(classifyCommit(sha('b'), [openPr(50)])).toMatchObject({ status: STATUS.ATTENTION, pr: 50 });
  });

  it('commit raiz sem PR é identificado como criação do repositório', () => {
    const r = classifyCommit(sha('1'), [], { isRoot: true });
    expect(r).toMatchObject({ status: STATUS.INFO, detail: expect.stringMatching(/commit raiz/) });
    expect(overallStatus({ results: [r, classifyCommit(sha('2'), [mergedPr(1, sha('2'))])] })).toBe(STATUS.OK);
  });
});

describe('auditoria da main: consultas à API', () => {
  it('repete a consulta quando o PR ainda não aparece (consistência eventual)', async () => {
    const fetchPulls = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([mergedPr(32, sha('c'))]);
    const sleep = vi.fn(noSleep);
    const [r] = await auditCommits({ shas: [sha('c')], fetchPulls, sleep, retries: 3 });
    expect(r.status).toBe(STATUS.OK);
    expect(fetchPulls).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('falha da API → inconclusivo, sem vazar credenciais na mensagem', async () => {
    const leaked = 'github_pat_' + 'X'.repeat(30);
    const fetchPulls = vi.fn().mockRejectedValue(new Error(`HTTP 500 Bearer ${leaked}\nstack`));
    const [r] = await auditCommits({ shas: [sha('c')], fetchPulls, sleep: noSleep, retries: 1 });
    expect(r.status).toBe(STATUS.INCONCLUSIVE);
    expect(r.detail).not.toContain(leaked);
    expect(r.detail).not.toContain('stack');
  });

  it('commit raiz não é consultado repetidamente', async () => {
    const fetchPulls = vi.fn().mockResolvedValue([]);
    await auditCommits({ shas: [sha('1')], fetchPulls, isRoot: () => true, sleep: noSleep, retries: 3 });
    expect(fetchPulls).toHaveBeenCalledTimes(1);
  });
});

describe('auditoria da main: evento push', () => {
  it('merge normal via PR: sem alertas, audita commits enviados e o head', () => {
    const analysis = analyzePushEvent(pushEvent());
    expect(analysis).toMatchObject({ skip: false, alerts: [] });
    expect(analysis.shas).toEqual([sha('b'), sha('c')]);
  });

  it('push forçado reportado pelo GitHub → alerta', () => {
    const analysis = analyzePushEvent(pushEvent({ forced: true }));
    expect(analysis.alerts.join()).toMatch(/FORÇADO/);
    expect(overallStatus({ alerts: analysis.alerts, results: [] })).toBe(STATUS.ALERT);
  });

  it('exclusão da main → alerta, sem auditar o SHA zerado', () => {
    const analysis = analyzePushEvent(pushEvent({ deleted: true, after: '0'.repeat(40), commits: [] }));
    expect(analysis.alerts.join()).toMatch(/EXCLUSÃO/);
    expect(analysis.shas).toEqual([]);
  });

  it('push em outra branch é ignorado', () => {
    const analysis = analyzePushEvent(pushEvent({ ref: 'refs/heads/feature/x' }));
    expect(overallStatus(analysis)).toBe(STATUS.SKIPPED);
  });

  it('ignora SHAs malformados e não ecoa caracteres de controle do pusher', () => {
    const analysis = analyzePushEvent(
      pushEvent({ forced: true, commits: [{ id: 'nao-e-sha' }], pusher: { name: 'x\n::error::injetado' } }),
    );
    expect(analysis.shas).toEqual([sha('c')]);
    expect(analysis.alerts.join()).not.toContain('\n');
    expect(analysis.alerts.join()).not.toContain('::');
  });
});

describe('auditoria da main: resultado e relatório', () => {
  it('o pior resultado define o status geral', () => {
    const ok = { sha: sha('b'), status: STATUS.OK, detail: '' };
    const att = { sha: sha('c'), status: STATUS.ATTENTION, detail: '' };
    const inc = { sha: sha('d'), status: STATUS.INCONCLUSIVE, detail: '' };
    expect(overallStatus({ results: [ok] })).toBe(STATUS.OK);
    expect(overallStatus({ results: [ok, inc] })).toBe(STATUS.INCONCLUSIVE);
    expect(overallStatus({ results: [inc, att, ok] })).toBe(STATUS.ATTENTION);
    expect(overallStatus({ results: [] })).toBe(STATUS.INCONCLUSIVE);
  });

  it('o relatório se declara detectivo e não afirma violação', () => {
    const report = renderReport({ status: STATUS.ATTENTION, results: [classifyCommit(sha('b'), [])] });
    expect(report).toMatch(/DETECTIVO/);
    expect(report).toMatch(/não é afirmação de violação/);
  });
});

/** Gatilhos do bloco `on:` (sem comentários): evento → filtro de branches ('' se não houver). */
function triggers(workflow) {
  const block = workflow.replace(/\r\n/g, '\n').split(/^on:\n/m)[1].split(/^\S/m)[0];
  const result = {};
  let current;
  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const event = /^ {2}([a-z_]+):\s*$/.exec(line);
    if (event) result[(current = event[1])] = '';
    const branches = /^ {4}branches:\s*(\S.*)$/.exec(line);
    if (branches && current) result[current] = branches[1];
  }
  return result;
}

describe('workflows de CI', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const audit = readFileSync('.github/workflows/main-audit.yml', 'utf8');

  it('CI dispara em pull_request, workflow_dispatch e push na main', () => {
    expect(triggers(ci)).toEqual({ pull_request: '[main]', push: '[main]', workflow_dispatch: '' });
  });

  it('a auditoria roda em push na main e manualmente, só com permissões de leitura', () => {
    expect(triggers(audit)).toEqual({ push: '[main]', workflow_dispatch: '' });
    expect(audit).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read\n/);
    expect(audit).not.toMatch(/: write/);
    // Expressões do GitHub nunca são interpoladas em comandos `run:` (entram por variável de ambiente).
    expect(audit).not.toMatch(/run:.*\$\{\{/);
  });

  it('nenhum workflow concede escrita nem usa pull_request_target', () => {
    for (const wf of [ci, audit]) {
      expect(wf).not.toMatch(/:\s*write\b/);
      expect(wf).not.toContain('pull_request_target');
    }
  });
});
