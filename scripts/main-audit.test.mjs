// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    const { results: [r] } = await auditCommits({ shas: [sha('c')], fetchPulls, sleep, retries: 3 });
    expect(r.status).toBe(STATUS.OK);
    expect(fetchPulls).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('falha da API → inconclusivo, sem vazar credenciais na mensagem', async () => {
    const leaked = 'github_pat_' + 'X'.repeat(30);
    const fetchPulls = vi.fn().mockRejectedValue(new Error(`HTTP 500 Bearer ${leaked}\nstack`));
    const { results: [r] } = await auditCommits({ shas: [sha('c')], fetchPulls, sleep: noSleep, retries: 1 });
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

/** Relógio simulado: nenhuma espera real. Cada consulta "custa" o tempo que avança; `sleep` só avança o relógio. */
function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    advance: (ms) => (t += ms),
    sleep: vi.fn(async (ms) => {
      sleeps.push(ms);
      t += ms;
    }),
    sleeps,
  };
}

const manyShas = (n) => Array.from({ length: n }, (_, i) => 'a' + i.toString(16).padStart(39, '0'));

describe('auditoria da main: orçamento de tempo (R1)', () => {
  it('lote grande sem PR: espera por RODADA (não por commit) e respeita o orçamento', async () => {
    const clock = fakeClock();
    const fetchPulls = vi.fn(async () => (clock.advance(200), []));
    const audit = await auditCommits({ shas: manyShas(50), fetchPulls, retries: 3, delayMs: 5000, budgetMs: 180_000, now: clock.now, sleep: clock.sleep });
    // 4 rodadas x 50 consultas; 3 esperas no total (não 150).
    expect(fetchPulls).toHaveBeenCalledTimes(200);
    expect(clock.sleeps).toEqual([5000, 5000, 5000]);
    expect(clock.now()).toBeLessThanOrEqual(180_000);
    expect(audit.budgetExhausted).toBe(false);
    expect(audit.results.every((r) => r.status === STATUS.ATTENTION)).toBe(true);
  });

  it('orçamento esgotado na 1ª rodada: commits não consultados ficam inconclusivos, nunca aprovados', async () => {
    const clock = fakeClock();
    const shas = manyShas(2048); // limite do payload do evento push
    const fetchPulls = vi.fn(async (s) => (clock.advance(300), [mergedPr(1, s)]));
    const audit = await auditCommits({ shas, fetchPulls, budgetMs: 180_000, now: clock.now, sleep: clock.sleep });
    expect(audit.budgetExhausted).toBe(true);
    expect(clock.now()).toBeLessThanOrEqual(180_000);
    expect(audit.unexamined).toBeGreaterThan(0);
    expect(audit.results).toHaveLength(2048);
    const cut = 2048 - audit.unexamined;
    expect(audit.results.slice(0, cut).every((r) => r.status === STATUS.OK)).toBe(true);
    expect(audit.results.slice(cut).every((r) => r.status === STATUS.INCONCLUSIVE && /orçamento/.test(r.detail))).toBe(true);
    expect(fetchPulls).toHaveBeenCalledTimes(cut);
    expect(overallStatus({ results: audit.results })).toBe(STATUS.INCONCLUSIVE);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('não inicia espera de retry sem tempo para ela e para mais uma consulta', async () => {
    const clock = fakeClock();
    const fetchPulls = vi.fn(async () => (clock.advance(100), []));
    const audit = await auditCommits({
      shas: manyShas(10),
      fetchPulls,
      retries: 3,
      delayMs: 5000,
      minRequestMs: 1000,
      budgetMs: 5500, // a 1ª rodada usa 1000 ms; sobram 4500 < 5000 + 1000
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(fetchPulls).toHaveBeenCalledTimes(10);
    expect(audit.budgetExhausted).toBe(true);
    // Mantém o último resultado (atenção), sem aprovar nada.
    expect(audit.results.every((r) => r.status === STATUS.ATTENTION)).toBe(true);
  });

  it('falhas da API: inconclusivo, retries limitados pelo orçamento, consultas limitadas', async () => {
    const clock = fakeClock();
    const fetchPulls = vi.fn(async () => {
      clock.advance(10_000); // cada falha consome o timeout inteiro da consulta
      throw new Error('HTTP 502');
    });
    const audit = await auditCommits({ shas: manyShas(30), fetchPulls, budgetMs: 180_000, now: clock.now, sleep: clock.sleep });
    expect(audit.budgetExhausted).toBe(true);
    expect(clock.now()).toBeLessThanOrEqual(180_000);
    expect(fetchPulls.mock.calls.length).toBeLessThanOrEqual(18);
    expect(audit.results.every((r) => r.status === STATUS.INCONCLUSIVE)).toBe(true);
    expect(audit.results.some((r) => /HTTP 502/.test(r.detail))).toBe(true);
    expect(audit.results.some((r) => /orçamento/.test(r.detail))).toBe(true);
  });

  it('cada consulta recebe timeoutMs limitado pelo tempo restante e pelo teto por requisição', async () => {
    const clock = fakeClock();
    const timeouts = [];
    const fetchPulls = vi.fn(async (_s, { timeoutMs }) => (timeouts.push(timeoutMs), clock.advance(timeoutMs < 4000 ? timeoutMs : 4000), []));
    await auditCommits({ shas: manyShas(5), fetchPulls, retries: 0, budgetMs: 15_000, requestTimeoutMs: 10_000, now: clock.now, sleep: clock.sleep });
    expect(timeouts).toEqual([10_000, 10_000, 7000, 3000]);
    for (const t of timeouts) expect(t).toBeGreaterThanOrEqual(1000);
    expect(clock.now()).toBeLessThanOrEqual(15_000);
  });

  it('atraso de indexação continua coberto: PR que aparece na 2ª rodada é confirmado', async () => {
    const clock = fakeClock();
    let calls = 0;
    const fetchPulls = vi.fn(async (s) => (clock.advance(200), ++calls > 3 ? [mergedPr(9, s)] : []));
    const audit = await auditCommits({ shas: manyShas(3), fetchPulls, budgetMs: 180_000, now: clock.now, sleep: clock.sleep });
    expect(audit.results.every((r) => r.status === STATUS.OK)).toBe(true);
    expect(clock.sleeps).toEqual([5000]);
  });

  it('alerta de push forçado sobrevive ao esgotamento do orçamento', async () => {
    const analysis = analyzePushEvent(pushEvent({ forced: true }));
    const clock = fakeClock();
    const audit = await auditCommits({
      shas: analysis.shas,
      fetchPulls: async () => (clock.advance(60_000), []),
      budgetMs: 30_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(audit.budgetExhausted).toBe(true);
    expect(overallStatus({ alerts: analysis.alerts, results: audit.results })).toBe(STATUS.ALERT);
  });
});

describe('auditoria da main: CLI (sem rede)', () => {
  function runCli(event, extraEnv = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'acc-audit-'));
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify(event));
    const env = { ...process.env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventPath, GITHUB_ACTIONS: 'true', GITHUB_TOKEN: '', ...extraEnv };
    delete env.GITHUB_STEP_SUMMARY;
    const r = spawnSync(process.execPath, ['scripts/audit-main.mjs'], { env, encoding: 'utf8' });
    rmSync(dir, { recursive: true, force: true });
    return r;
  }

  it('push forçado: anotação de erro emitida antes do relatório e saída 1', () => {
    const r = runCli(pushEvent({ forced: true }));
    expect(r.status).toBe(1);
    const errorAt = r.stdout.indexOf('::error title=Auditoria da main::');
    expect(errorAt).toBeGreaterThanOrEqual(0);
    expect(errorAt).toBeLessThan(r.stdout.indexOf('## Auditoria informativa da main'));
  });

  it('push normal sem credencial: inconclusivo, saída 0', () => {
    const r = runCli(pushEvent());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/INCONCLUSIVO/);
  });

  it.each(['5000', '999999', 'abc'])('recusa AUDIT_BUDGET_MS fora da faixa segura (%s)', (value) => {
    expect(runCli(pushEvent(), { AUDIT_BUDGET_MS: value }).status).toBe(2);
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
    // Orçamento do script com margem >= 90 s para checkout/setup dentro do timeout do job.
    const timeoutMin = Number(/timeout-minutes:\s*(\d+)/.exec(audit)[1]);
    const budgetMs = Number(/AUDIT_BUDGET_MS:\s*'(\d+)'/.exec(audit)[1]);
    expect(budgetMs + 90_000).toBeLessThanOrEqual(timeoutMin * 60_000);
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
