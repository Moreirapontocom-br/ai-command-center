// @vitest-environment node
/**
 * Testes de integração do hook `.githooks/pre-push` com o Git real, em repositórios descartáveis
 * (diretório temporário). A configuração global/do sistema do usuário é isolada.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SOURCE_HOOK = resolve('.githooks/pre-push');
let root;
let hooksDir;
let emptyConfig;

function env() {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Teste',
    GIT_AUTHOR_EMAIL: 'teste@example.invalid',
    GIT_COMMITTER_NAME: 'Teste',
    GIT_COMMITTER_EMAIL: 'teste@example.invalid',
  };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Executa `git push` e devolve o resultado sem lançar exceção. */
function push(cwd, ...args) {
  const r = spawnSync('git', ['push', ...args], { cwd, env: env(), encoding: 'utf8' });
  return { code: r.status, output: `${r.stdout}${r.stderr}` };
}

function remoteRef(bare, ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: bare, env: env(), encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

let n = 0;
/** Cria um remoto bare com `main` e um clone de trabalho com o hook ativo e uma branch de feature. */
function setup() {
  const dir = join(root, `case-${++n}`);
  const bare = join(dir, 'remote.git');
  const work = join(dir, 'work');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  git(root, 'init', '--quiet', '-b', 'main', work);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', 'a.txt');
  git(work, 'commit', '--quiet', '-m', 'inicial');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', '--quiet', 'origin', 'main'); // semeadura, antes de ativar o hook
  git(work, 'remote', 'add', 'upstream', bare);
  git(work, 'config', 'core.hooksPath', hooksDir);

  git(work, 'switch', '--quiet', '-c', 'feature/x');
  writeFileSync(join(work, 'b.txt'), 'b\n');
  git(work, 'add', 'b.txt');
  git(work, 'commit', '--quiet', '-m', 'feature');
  const mainSha = remoteRef(bare, 'refs/heads/main');
  return { bare, work, mainSha };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'acc-prepush-'));
  emptyConfig = join(root, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  // Só o pre-push (cópia idêntica do arquivo versionado): o pre-commit do projeto não se aplica aqui.
  hooksDir = join(root, 'hooks');
  mkdirSync(hooksDir);
  copyFileSync(SOURCE_HOOK, join(hooksDir, 'pre-push'));
  chmodSync(join(hooksDir, 'pre-push'), 0o755);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('hook pre-push: bloqueio da main', { timeout: 60_000 }, () => {
  it('é um script POSIX com finais de linha LF', () => {
    const content = readFileSync(SOURCE_HOOK, 'utf8');
    expect(content.startsWith('#!/bin/sh\n')).toBe(true);
    expect(content).not.toContain('\r');
  });

  it.each([
    ['push direto da main', ['origin', 'main'], 'main'],
    ['refspec HEAD:main', ['origin', 'HEAD:main'], 'feature'],
    ['refspec completo feature:refs/heads/main', ['origin', 'feature/x:refs/heads/main'], 'feature'],
    ['remoto com outro nome', ['upstream', 'feature/x:main'], 'feature'],
    ['variação de maiúsculas (Main)', ['origin', 'feature/x:Main'], 'feature'],
  ])('recusa %s', (_label, args, from) => {
    const { bare, work, mainSha } = setup();
    if (from === 'main') {
      git(work, 'switch', '--quiet', 'main');
      git(work, 'merge', '--quiet', '--ff-only', 'feature/x');
    }
    const result = push(work, ...args);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('pre-push: bloqueado');
    expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
    // Lista exata (o sistema de arquivos do Windows não diferencia maiúsculas em `rev-parse`).
    expect(git(bare, 'for-each-ref', '--format=%(refname)', 'refs/heads/').split(/\r?\n/)).toEqual(['refs/heads/main']);
  });

  it('recusa push pela URL do remoto (sem nome de remoto)', () => {
    const { bare, work, mainSha } = setup();
    const result = push(work, bare, 'feature/x:main');
    expect(result.code).not.toBe(0);
    expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
  });

  it.each([
    ['refspec vazio (:main)', ['origin', ':main']],
    ['--delete main', ['--delete', 'origin', 'main']],
  ])('recusa exclusão da main: %s', (_label, args) => {
    const { bare, work, mainSha } = setup();
    const result = push(work, ...args);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('EXCLUSÃO');
    expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
  });

  it.each([
    ['--force', ['--force', 'origin', 'feature/x:main']],
    ['refspec com +', ['origin', '+feature/x:main']],
    ['--force-with-lease', ['--force-with-lease', 'origin', 'feature/x:main']],
  ])('recusa push forçado reescrevendo a main: %s', (_label, args) => {
    const { bare, work, mainSha } = setup();
    // Histórico divergente: a branch não contém o commit atual da main.
    git(work, 'switch', '--quiet', '--orphan', 'reescrita');
    writeFileSync(join(work, 'c.txt'), 'c\n');
    git(work, 'add', 'c.txt');
    git(work, 'commit', '--quiet', '-m', 'outro histórico');
    git(work, 'branch', '--quiet', '-f', 'feature/x', 'reescrita');
    const result = push(work, ...args);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('FORÇADA');
    expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
  });

  it('permite push normal de branch de feature', () => {
    const { bare, work, mainSha } = setup();
    const result = push(work, '-u', 'origin', 'feature/x');
    expect(result.code).toBe(0);
    expect(remoteRef(bare, 'refs/heads/feature/x')).toBe(git(work, 'rev-parse', 'feature/x'));
    expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
  });

  it('permite branches cujo nome apenas contém "main" e tags', () => {
    const { bare, work } = setup();
    git(work, 'tag', 'v0.0.1');
    const result = push(work, 'origin', 'feature/x:feature/main-fix', 'feature/x:mainline', 'feature/x:refs/heads/main2', 'v0.0.1');
    expect(result.code).toBe(0);
    for (const ref of ['refs/heads/feature/main-fix', 'refs/heads/mainline', 'refs/heads/main2', 'refs/tags/v0.0.1']) {
      expect(remoteRef(bare, ref)).not.toBeNull();
    }
  });

  it('com múltiplos refspecs, um destino main recusa o push inteiro (nenhuma ref é enviada)', () => {
    const { bare, work, mainSha } = setup();
    const result = push(work, 'origin', 'feature/x', 'feature/x:main');
    expect(result.code).not.toBe(0);
    expect(remoteRef(bare, 'refs/heads/feature/x')).toBeNull();
    expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
  });

  it('recusa --all e --mirror quando a main local diverge do remoto', () => {
    const { bare, work, mainSha } = setup();
    git(work, 'branch', '--quiet', '-f', 'main', 'feature/x');
    for (const flag of ['--all', '--mirror']) {
      const result = push(work, flag, 'origin');
      expect(result.code).not.toBe(0);
      expect(remoteRef(bare, 'refs/heads/main')).toBe(mainSha);
    }
    expect(remoteRef(bare, 'refs/heads/feature/x')).toBeNull();
  });

  it('limitação documentada: --no-verify ignora o hook (não é controle de segurança)', () => {
    const { bare, work, mainSha } = setup();
    const result = push(work, '--no-verify', 'origin', 'feature/x:main');
    expect(result.code).toBe(0);
    expect(remoteRef(bare, 'refs/heads/main')).not.toBe(mainSha);
  });
});
