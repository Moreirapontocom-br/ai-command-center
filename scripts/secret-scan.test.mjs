// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprint, isForbiddenEnvFile, loadAllowlist, scanLine, scanText } from './secret-scan.mjs';

// Valores com formato REAL gerados em tempo de execução: nada aqui fica versionado como segredo.
const alnum = (length) => randomBytes(length * 2).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, length);
const fakeFineGrained = () => `github_pat_${alnum(22)}_${alnum(59)}`;
const fakeOAuth = () => `gho_${alnum(36)}`;

const CLI = resolve('scripts/check-secrets.mjs');

function scanEnvExample(content) {
  return scanText(content, { path: '.env.example' });
}

describe('regras de detecção', () => {
  it.each([
    ['token fine-grained', fakeFineGrained(), 'github-fine-grained'],
    ['token OAuth do gh', fakeOAuth(), 'github-token'],
    ['token clássico', `ghp_${alnum(36)}`, 'github-token'],
    ['chave AWS', `AKIA${alnum(16).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}`, 'aws-access-key'],
  ])('detecta %s em qualquer arquivo', (_name, value, rule) => {
    const findings = scanLine(`const x = "${value}";`, { path: 'src/qualquer.ts', lineNumber: 7 });
    expect(findings.map((f) => f.rule)).toContain(rule);
    expect(findings[0]).toMatchObject({ path: 'src/qualquer.ts', line: 7 });
  });

  it('nunca inclui o valor no achado, só a impressão digital truncada', () => {
    const value = fakeFineGrained();
    const findings = scanLine(`TOKEN=${value}`, { path: 'notes.md', lineNumber: 1 });
    expect(findings).toHaveLength(1);
    expect(JSON.stringify(findings)).not.toContain(value);
    expect(findings[0].fingerprint).toBe(fingerprint(value).slice(0, 12));
  });

  it('detecta chave PEM real, mas não um cabeçalho solto em teste de mascaramento', () => {
    expect(scanLine('-----BEGIN RSA PRIVATE KEY-----', { path: 'id_rsa', lineNumber: 1 })).toHaveLength(1);
    const embedded = '"key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC"';
    expect(scanLine(embedded, { path: 'sa.json', lineNumber: 1 })).toHaveLength(1);
    const maskingTest = "redact('-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----')";
    expect(scanLine(maskingTest, { path: 'x.test.ts', lineNumber: 1 })).toHaveLength(0);
  });

  it('procura o valor exato do token configurado localmente', () => {
    const configured = `${alnum(30)}`;
    const findings = scanLine(`copiado: ${configured}`, { path: 'a.txt', lineNumber: 3, extraValues: [configured] });
    expect(findings.map((f) => f.rule)).toEqual(['configured-token']);
  });

  it('recusa arquivos de ambiente local versionados, exceto .env.example', () => {
    expect(isForbiddenEnvFile('.env')).toBe(true);
    expect(isForbiddenEnvFile('.env.local')).toBe(true);
    expect(isForbiddenEnvFile('sub/.env.local.txt')).toBe(true);
    expect(isForbiddenEnvFile('.env.example')).toBe(false);
    expect(isForbiddenEnvFile('docs/env.md')).toBe(false);
  });
});

describe('.env.example', () => {
  it('falha com token real em GITHUB_TOKEN (cenário do commit c368bbf)', () => {
    const value = fakeFineGrained();
    const findings = scanEnvExample(`# comentário\nGITHUB_TOKEN=${value}\n`);
    expect(findings.map((f) => f.rule).sort()).toEqual(['env-example-value', 'github-fine-grained']);
    expect(findings.every((f) => f.line === 2)).toBe(true);
    expect(JSON.stringify(findings)).not.toContain(value);
  });

  it('falha com qualquer valor em variável sensível, mesmo sem formato de token', () => {
    expect(scanEnvExample('API_SECRET=abc123').map((f) => f.rule)).toEqual(['env-example-value']);
    expect(scanEnvExample('export DB_PASSWORD="hunter2"').map((f) => f.rule)).toEqual(['env-example-value']);
  });

  it('aceita o modelo versionado: variáveis sensíveis vazias e exemplos comentados', () => {
    const template = [
      'GITHUB_TOKEN=',
      'GITHUB_TOKEN=""',
      '# GITHUB_AUTH=gh-cli',
      '# GH_PATH=C:\\Program Files\\GitHub CLI\\gh.exe',
      'API_PORT=8787',
    ].join('\n');
    expect(scanEnvExample(template)).toEqual([]);
  });

  it('a regra de valor preenchido vale só para arquivos de exemplo', () => {
    expect(scanText('API_SECRET=abc123', { path: 'docs/README.md' })).toEqual([]);
  });

  it('o .env.example atual do repositório passa', () => {
    const findings = execFileSync(process.execPath, [CLI, 'tracked'], { encoding: 'utf8' });
    expect(findings).toMatch(/Nenhuma credencial encontrada/);
  });
});

describe('allowlist por impressão digital', () => {
  it('ignora apenas o valor exato listado', () => {
    const allowed = fakeFineGrained();
    const other = fakeFineGrained();
    const allowlist = new Set([fingerprint(allowed)]);
    expect(scanLine(allowed, { path: 'f.ts', lineNumber: 1, allowlist })).toEqual([]);
    expect(scanLine(other, { path: 'f.ts', lineNumber: 1, allowlist })).toHaveLength(1);
  });

  it('o arquivo versionado só contém o canário dos testes', async () => {
    const { CANARY_TOKEN } = await import('../server/test/fixtures.ts');
    const allowlist = loadAllowlist();
    expect([...allowlist]).toEqual([fingerprint(CANARY_TOKEN)]);
  });

  it('recusa entradas sem SHA-256 completo ou sem justificativa', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allowlist-'));
    try {
      const file = join(dir, 'a.json');
      writeFileSync(file, JSON.stringify({ fingerprints: [{ sha256: 'abc', reason: 'x' }] }));
      expect(() => loadAllowlist(file)).toThrow(/SHA-256 completo/);
      writeFileSync(file, JSON.stringify({ fingerprints: [{ sha256: 'a'.repeat(64), reason: ' ' }] }));
      expect(() => loadAllowlist(file)).toThrow(/justificativa/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI em repositório Git real (temporário)', () => {
  let repo = '';
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
    });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8' });

  function setupRepo() {
    repo = mkdtempSync(join(tmpdir(), 'secret-scan-'));
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.env.example'), 'GITHUB_TOKEN=\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  }

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = '';
  });

  it('falha (exit 1) quando .env.example versionado tem credencial e não imprime o valor', () => {
    setupRepo();
    const value = fakeFineGrained();
    writeFileSync(join(repo, '.env.example'), `GITHUB_TOKEN=${value}\n`);
    git('commit', '-q', '-am', 'leak');

    for (const args of [['tracked'], ['commits', 'main~1..main'], ['history']]) {
      const result = run(...args);
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr).toMatch(/\.env\.example:1/);
      expect(result.stdout + result.stderr).not.toContain(value);
    }
  });

  it('após corrigir o arquivo, a árvore passa mas o histórico continua acusando o commit', () => {
    setupRepo();
    const value = fakeOAuth();
    writeFileSync(join(repo, '.env.example'), `GITHUB_TOKEN=${value}\n`);
    git('commit', '-q', '-am', 'leak');
    const leakCommit = git('rev-parse', '--short=7', 'HEAD').trim();
    writeFileSync(join(repo, '.env.example'), 'GITHUB_TOKEN=\n');
    git('commit', '-q', '-am', 'fix');

    expect(run('tracked').status).toBe(0);
    expect(run('commits', 'HEAD~1..HEAD').status).toBe(0);
    const history = run('history');
    expect(history.status).toBe(1);
    expect(history.stderr).toContain(`commit ${leakCommit}`);
    expect(history.stdout + history.stderr).not.toContain(value);
  });

  it('acusa .env.local versionado e conteúdo preparado no modo staged', () => {
    setupRepo();
    writeFileSync(join(repo, '.env.local'), 'API_PORT=1\n');
    git('add', '-f', '.env.local');
    expect(run('staged').status).toBe(1);
    git('commit', '-q', '-m', 'env');
    expect(run('tracked').stderr).toMatch(/\.env\.local: arquivo de ambiente local versionado/);

    const value = fakeFineGrained();
    writeFileSync(join(repo, 'config.json'), JSON.stringify({ token: value }));
    git('add', 'config.json');
    const staged = run('staged');
    expect(staged.status).toBe(1);
    expect(staged.stderr).toMatch(/config\.json:1/);
    expect(staged.stdout + staged.stderr).not.toContain(value);
  });

  it('modo desconhecido ou intervalo ausente sai com código 2', () => {
    setupRepo();
    expect(run('qualquer').status).toBe(2);
    expect(run('commits').status).toBe(2);
  });
});
