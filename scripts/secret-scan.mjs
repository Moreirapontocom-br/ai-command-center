// Núcleo da verificação de segredos (sem dependências externas).
//
// Regras de segurança deste módulo:
// - NUNCA devolve nem imprime o valor encontrado: cada achado traz apenas arquivo, linha, regra e
//   uma impressão digital (SHA-256 truncado) que permite comparar ocorrências sem expor o segredo.
// - Valores conhecidamente falsos (ex.: o canário dos testes) só são ignorados pela impressão
//   digital SHA-256 completa listada em `secret-scan-allowlist.json`, nunca por caminho de arquivo.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Padrões de credenciais. Os de GitHub seguem os prefixos documentados pela própria plataforma. */
export const SECRET_PATTERNS = Object.freeze([
  { id: 'github-fine-grained', label: 'token fine-grained do GitHub', regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { id: 'github-token', label: 'token do GitHub (ghp_/gho_/ghu_/ghs_/ghr_)', regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  // Chave PEM: cabeçalho sozinho na linha (arquivo .pem/.key) ou seguido de `\n` escapado e conteúdo
  // base64 (chave embutida em JSON/string). Um cabeçalho solto em teste de mascaramento não é chave.
  { id: 'private-key', label: 'chave privada PEM', regex: /^\s*-----BEGIN [A-Z ]*PRIVATE KEY-----\s*$/g },
  { id: 'private-key', label: 'chave privada PEM', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\r)?\\n[A-Za-z0-9+/=]{20,}/g },
  { id: 'aws-access-key', label: 'chave de acesso AWS', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
]);

/** Variáveis que nunca podem ter valor preenchido em arquivos de exemplo (`.env.example`). */
const SENSITIVE_ENV_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|CREDENTIAL)/i;
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Arquivos de ambiente local que nunca podem ser versionados (só `.env.example` é permitido). */
export function isForbiddenEnvFile(path) {
  const name = basename(path);
  if (name === '.env.example') return false;
  return name === '.env' || name.startsWith('.env.');
}

export function isEnvExampleFile(path) {
  const name = basename(path);
  return name === '.env.example' || name === '.env.sample' || name === '.env.template';
}

export function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOWLIST_PATH = join(HERE, 'secret-scan-allowlist.json');

/** Lê as impressões digitais permitidas. Só aceita SHA-256 completos (64 hex). */
export function loadAllowlist(path = DEFAULT_ALLOWLIST_PATH) {
  if (!existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed?.fingerprints) ? parsed.fingerprints : [];
  const allowed = new Set();
  for (const entry of entries) {
    if (typeof entry?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`Entrada inválida em ${basename(path)}: use o SHA-256 completo do valor.`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`Entrada sem justificativa em ${basename(path)}.`);
    }
    allowed.add(entry.sha256);
  }
  return allowed;
}

/** Dados binários (NUL nos primeiros 8 KiB) não são analisados. */
export function looksBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

/**
 * Analisa uma linha. `extraValues` são valores exatos (ex.: o GITHUB_TOKEN configurado localmente)
 * procurados além dos padrões. Devolve achados sem o valor.
 */
export function scanLine(line, { path, lineNumber, allowlist = new Set(), extraValues = [] }) {
  const findings = [];
  const push = (rule, label, value) => {
    const fp = fingerprint(value);
    if (allowlist.has(fp)) return;
    findings.push({ path, line: lineNumber, rule, label, fingerprint: fp.slice(0, 12) });
  };

  for (const { id, label, regex } of SECRET_PATTERNS) {
    for (const match of line.matchAll(regex)) push(id, label, match[0]);
  }
  for (const value of extraValues) {
    if (value && line.includes(value)) push('configured-token', 'valor do GITHUB_TOKEN configurado localmente', value);
  }
  if (isEnvExampleFile(path)) {
    const assignment = ENV_ASSIGNMENT.exec(line);
    if (assignment && !line.trimStart().startsWith('#')) {
      const [, key, rawValue] = assignment;
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2');
      if (SENSITIVE_ENV_KEY.test(key) && value !== '') {
        push('env-example-value', `valor preenchido em ${key} no arquivo de exemplo`, value);
      }
    }
  }
  return findings;
}

export function scanText(text, options) {
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => scanLine(line, { ...options, lineNumber: index + 1 }));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
}

/** Arquivos versionados (índice do Git), com o conteúdo da árvore de trabalho. */
export function scanTrackedFiles({ cwd = process.cwd(), allowlist, extraValues } = {}) {
  const files = git(['ls-files', '-z'], cwd).toString('utf8').split('\0').filter(Boolean);
  const findings = [];
  let scanned = 0;
  for (const path of files) {
    if (isForbiddenEnvFile(path)) {
      findings.push({ path, line: 0, rule: 'tracked-env-file', label: 'arquivo de ambiente local versionado', fingerprint: '-' });
      continue;
    }
    const absolute = join(cwd, path);
    if (!existsSync(absolute)) continue; // removido na árvore de trabalho
    const buffer = readFileSync(absolute);
    if (looksBinary(buffer)) continue;
    scanned += 1;
    findings.push(...scanText(buffer.toString('utf8'), { path, allowlist, extraValues }));
  }
  return { findings, scanned };
}

/**
 * Linhas ADICIONADAS por commits. `range` segue a sintaxe do `git log` (ex.: `origin/main..HEAD`);
 * `--all` percorre todo o histórico alcançável.
 */
export function scanCommits({ cwd = process.cwd(), range, allowlist, extraValues } = {}) {
  const args = ['log', '--no-color', '--no-ext-diff', '--no-renames', '-p', '-U0', '--format=__COMMIT__%H'];
  const output = git([...args, range ?? 'HEAD', '--'], cwd).toString('utf8');
  const findings = [];
  const commits = new Set();
  let commit = '';
  let path = null;
  let lineNumber = 0;
  let previous = '';
  for (const line of output.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      commit = line.slice('__COMMIT__'.length, '__COMMIT__'.length + 40);
      commits.add(commit);
      path = null;
    } else if (line.startsWith('+++ ') && previous.startsWith('--- ')) {
      const target = line.slice(4);
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (path && isForbiddenEnvFile(path)) {
        findings.push({ path, line: 0, commit: commit.slice(0, 7), rule: 'tracked-env-file', label: 'arquivo de ambiente local adicionado', fingerprint: '-' });
      }
    } else if (line.startsWith('@@')) {
      const hunk = /\+(\d+)/.exec(line);
      lineNumber = hunk ? Number(hunk[1]) : 0;
    } else if (path && line.startsWith('+')) {
      for (const finding of scanLine(line.slice(1), { path, lineNumber, allowlist, extraValues })) {
        findings.push({ ...finding, commit: commit.slice(0, 7) });
      }
      lineNumber += 1;
    }
    previous = line;
  }
  return { findings, scanned: commits.size };
}

/** Conteúdo preparado para o próximo commit (uso em hook `pre-commit`). */
export function scanStaged({ cwd = process.cwd(), allowlist, extraValues } = {}) {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], cwd)
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const findings = [];
  for (const path of files) {
    if (isForbiddenEnvFile(path)) {
      findings.push({ path, line: 0, rule: 'tracked-env-file', label: 'arquivo de ambiente local preparado para commit', fingerprint: '-' });
      continue;
    }
    const buffer = git(['show', `:${path}`], cwd);
    if (looksBinary(buffer)) continue;
    findings.push(...scanText(buffer.toString('utf8'), { path, allowlist, extraValues }));
  }
  return { findings, scanned: files.length };
}

export function formatFinding(finding) {
  const where = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
  const commit = finding.commit ? ` [commit ${finding.commit}]` : '';
  return `${where}${commit}: ${finding.label} (impressão digital ${finding.fingerprint})`;
}
