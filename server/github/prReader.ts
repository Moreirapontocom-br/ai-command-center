import { createHash } from 'node:crypto';
import type { GraphQLClient, RestCompareClient } from './client.ts';
import { IntegrationError } from './errors.ts';
import { MAIN_HEAD_QUERY, PR_VERIFICATION_LIMITS, PR_VERIFICATION_QUERY } from './queries.ts';
import { GitHubReadError, type CheckState, type CompareRead, type MainHeadRead, type PullRequestRead, type PullRequestReaderPort, type PullRequestSnapshot } from './prTypes.ts';

/**
 * Leitor de PRs da Issue #008 — SOMENTE LEITURA, sobre a integração da #002:
 * - GraphQL: só os documentos aprovados `MainHead` e `PullRequestVerification` (allowlist);
 * - REST: só `GET /repos/{o}/{r}/compare/{base}...{head}?per_page=1` (allowlist fechada).
 *
 * Toda resposta é DADO NÃO CONFIÁVEL, normalizada por esquema fechado: campo ausente, tipo errado
 * ou valor fora da lista → `malformed` (nunca "ok"). Os resumos (`digest`) são calculados sobre a
 * forma NORMALIZADA, para o histórico guardar só a evidência, não o conteúdo.
 */

const SHA = /^[0-9a-f]{40}$/;
const NODE_ID = /^[A-Za-z0-9_=-]{1,100}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;
const PATH_MAX = 1024;
const NAME_MAX = 200;

class Malformed extends Error {}
const bad = (): never => {
  throw new Malformed('malformed');
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown) => (isObj(v) ? v : bad());
const str = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v) ? v : bad());
const bool = (v: unknown) => (typeof v === 'boolean' ? v : bad());
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : bad());
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : bad());
const isoOrNull = (v: unknown) => (v === null ? null : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : bad());
const arr = (v: unknown, max: number) => (Array.isArray(v) && v.length <= max ? (v as unknown[]) : bad());
const login = (v: unknown): string | null => {
  if (v === null) return null;
  const o = obj(v);
  if (o.user === null || o.user === undefined) return null;
  const u = obj(o.user);
  return typeof u.login === 'string' && LOGIN.test(u.login) ? u.login : bad();
};
const digest = (value: unknown) => createHash('sha256').update(`acc-pr-evidence:v1\n${JSON.stringify(value)}`, 'utf8').digest('hex');

/**
 * Formato válido E presença EXATA na allowlist do servidor, antes de qualquer credencial ou rede.
 * Defesa em profundidade: os chamadores (gateway) já conferem a allowlist, mas a credencial pode
 * ler outros repositórios da conta (ex.: `gh-cli`), então o leitor não confia nessa conferência.
 */
function splitRepository(repository: string, allowed: ReadonlySet<string>): { owner: string; name: string } {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository) || !allowed.has(repository)) throw new GitHubReadError('github_unauthorized');
  const [owner, name] = repository.split('/');
  return { owner, name };
}

/** Erro da integração → erro da porta (nada é gravado em nenhum dos dois casos). */
function toReadError(error: unknown): never {
  if (error instanceof GitHubReadError) throw error;
  const code = error instanceof IntegrationError ? error.code : 'internal';
  if (['unauthorized', 'forbidden', 'missing_credentials'].includes(code)) throw new GitHubReadError('github_unauthorized');
  if (code === 'internal') throw error;
  throw new GitHubReadError('github_unavailable', error instanceof IntegrationError ? error.retryAfterSeconds : undefined);
}

function checkContext(raw: unknown): { name: string; state: CheckState } {
  const node = obj(raw);
  if (node.__typename === 'CheckRun') {
    const name = typeof node.name === 'string' && node.name.length > 0 && node.name.length <= NAME_MAX ? node.name : bad();
    const status = oneOf(node.status, ['QUEUED', 'IN_PROGRESS', 'COMPLETED', 'WAITING', 'PENDING', 'REQUESTED'] as const);
    if (status !== 'COMPLETED') return { name, state: 'pending' };
    const conclusion = oneOf(node.conclusion, ['ACTION_REQUIRED', 'TIMED_OUT', 'CANCELLED', 'FAILURE', 'SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE', 'STARTUP_FAILURE'] as const);
    return { name, state: conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED' ? 'success' : 'failure' };
  }
  if (node.__typename === 'StatusContext') {
    const name = typeof node.context === 'string' && node.context.length > 0 && node.context.length <= NAME_MAX ? node.context : bad();
    const state = oneOf(node.state, ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'] as const);
    return { name, state: state === 'SUCCESS' ? 'success' : state === 'PENDING' || state === 'EXPECTED' ? 'pending' : 'failure' };
  }
  return bad();
}

/** Normaliza o `pullRequest` (sem os arquivos, que vêm por página). */
function normalizePullRequest(repo: { id: string; nameWithOwner: string }, raw: Record<string, unknown>): Omit<PullRequestSnapshot, 'files'> {
  const commits = obj(raw.commits);
  const listed = arr(commits.nodes, PR_VERIFICATION_LIMITS.commits).map((n) => {
    const c = obj(obj(n).commit);
    const signature = c.signature === null ? null : obj(c.signature);
    return { oid: str(c.oid, SHA), authorLogin: login(c.author), committerLogin: login(c.committer), signatureValid: signature === null ? null : bool(signature.isValid) };
  });
  const lastNodes = arr(obj(raw.lastCommit).nodes, 1);
  let lastCommit: PullRequestSnapshot['lastCommit'] = null;
  if (lastNodes.length === 1) {
    const c = obj(obj(lastNodes[0]).commit);
    let rollup: NonNullable<PullRequestSnapshot['lastCommit']>['rollup'] = null;
    if (c.statusCheckRollup !== null) {
      const r = obj(c.statusCheckRollup);
      const contexts = obj(r.contexts);
      rollup = {
        state: oneOf(r.state, ['SUCCESS', 'PENDING', 'FAILURE', 'ERROR', 'EXPECTED'] as const),
        contextsTotal: count(contexts.totalCount),
        contexts: arr(contexts.nodes, PR_VERIFICATION_LIMITS.contexts).map(checkContext),
      };
    }
    lastCommit = { oid: str(c.oid, SHA), rollup };
  }
  const headRepository = raw.headRepository === null ? null : obj(raw.headRepository);
  const total = count(commits.totalCount);
  if (listed.length > total) bad();
  return {
    repository: repo,
    number: count(raw.number),
    state: oneOf(raw.state, ['OPEN', 'CLOSED', 'MERGED'] as const),
    merged: bool(raw.merged),
    mergedAt: isoOrNull(raw.mergedAt),
    isDraft: bool(raw.isDraft),
    headRefName: str(raw.headRefName, BRANCH),
    headRefOid: str(raw.headRefOid, SHA),
    baseRefName: str(raw.baseRefName, BRANCH),
    isCrossRepository: bool(raw.isCrossRepository),
    headRepositoryId: headRepository === null ? null : str(headRepository.id, NODE_ID),
    mergeable: oneOf(raw.mergeable, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] as const),
    reviewDecision: raw.reviewDecision === null ? null : oneOf(raw.reviewDecision, ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const),
    commits: { total, listed },
    lastCommit,
  };
}

function filesPage(raw: Record<string, unknown>) {
  const f = obj(raw.files);
  const page = obj(f.pageInfo);
  const hasNext = bool(page.hasNextPage);
  const cursor = page.endCursor === null ? null : typeof page.endCursor === 'string' && page.endCursor.length > 0 && page.endCursor.length <= 200 ? page.endCursor : bad();
  if (hasNext && cursor === null) bad();
  const paths = arr(f.nodes, PR_VERIFICATION_LIMITS.filesPerPage).map((n) => {
    const p = obj(n).path;
    return typeof p === 'string' && p.length > 0 && p.length <= PATH_MAX ? p : bad();
  });
  return { total: count(f.totalCount), paths, hasNext, cursor };
}

/** Comparação REST normalizada (§6.4): só os campos do veredito, todos obrigatórios. */
export function normalizeCompare(body: unknown): CompareRead {
  try {
    const b = obj(body);
    const status = oneOf(b.status, ['ahead', 'behind', 'identical', 'diverged'] as const);
    const normalized = {
      status,
      aheadBy: count(b.ahead_by),
      behindBy: count(b.behind_by),
      baseSha: str(obj(b.base_commit).sha, SHA),
      mergeBaseSha: str(obj(b.merge_base_commit).sha, SHA),
    };
    return { kind: 'ok', digest: digest(normalized), ...normalized };
  } catch (error) {
    if (error instanceof Malformed) return { kind: 'unproven', reason: 'malformed' };
    throw error;
  }
}

export interface PullRequestReaderOptions {
  graphql: GraphQLClient;
  rest: RestCompareClient;
  /** Allowlist do servidor (`config.allowedRepositories`). Obrigatória; vazia = nada é consultado. */
  allowedRepositories: readonly string[];
}

export function createPullRequestReader(options: PullRequestReaderOptions): PullRequestReaderPort {
  // Cópia privada feita na construção: alterar o array original depois não amplia o acesso.
  const allowed: ReadonlySet<string> = new Set(options.allowedRepositories.filter((r) => typeof r === 'string' && REPOSITORY.test(r)));
  return {
    async mainHead(repository: string): Promise<MainHeadRead> {
      const { owner, name } = splitRepository(repository, allowed);
      let data: unknown;
      try {
        data = (await options.graphql.query<unknown>(MAIN_HEAD_QUERY, { owner, name })).data;
      } catch (error) {
        return toReadError(error);
      }
      try {
        const root = obj(data);
        // Repositório ilegível para a credencial do servidor: nada é preparado.
        if (root.repository === null) throw new GitHubReadError('github_unauthorized');
        const repo = obj(root.repository);
        const ref = obj(repo.ref);
        if (ref.name !== 'main') bad();
        return { repositoryId: str(repo.id, NODE_ID), nameWithOwner: str(repo.nameWithOwner, REPOSITORY), sha: str(obj(ref.target).oid, SHA) };
      } catch (error) {
        if (error instanceof Malformed) throw new GitHubReadError('github_unavailable');
        throw error;
      }
    },

    async pullRequest(repository: string, number: number): Promise<PullRequestRead> {
      const { owner, name } = splitRepository(repository, allowed);
      const fetchPage = async (after: string | null) => {
        try {
          return (await options.graphql.query<unknown>(PR_VERIFICATION_QUERY, after === null ? { owner, name, number } : { owner, name, number, filesAfter: after })).data;
        } catch (error) {
          return toReadError(error);
        }
      };
      try {
        const first = obj(await fetchPage(null));
        if (first.repository === null) throw new GitHubReadError('github_unauthorized');
        const repo = obj(first.repository);
        const repository = { id: str(repo.id, NODE_ID), nameWithOwner: str(repo.nameWithOwner, REPOSITORY) };
        if (repo.pullRequest === null) return { kind: 'pr_missing', digest: digest({ repository, pullRequest: null }), repository };
        const raw = obj(repo.pullRequest);
        const pr = normalizePullRequest(repository, raw);
        let page = filesPage(raw);
        const total = page.total;
        const paths = [...page.paths];
        // Páginas seguintes (até 3 no total), sempre da MESMA cabeça; mudou no meio → leitura descartada.
        for (let i = 1; i < PR_VERIFICATION_LIMITS.filePages && page.hasNext; i += 1) {
          const next = obj(await fetchPage(page.cursor));
          const nextPr = obj(obj(next.repository).pullRequest);
          if (str(nextPr.headRefOid, SHA) !== pr.headRefOid) return { kind: 'malformed' };
          page = filesPage(nextPr);
          paths.push(...page.paths);
        }
        const files = { total, paths, complete: !page.hasNext && paths.length === total };
        const snapshot: PullRequestSnapshot = { ...pr, files };
        return { kind: 'ok', digest: digest(snapshot), pr: snapshot };
      } catch (error) {
        if (error instanceof Malformed) return { kind: 'malformed' };
        throw error;
      }
    },

    async compare(repository: string, baseSha: string, headSha: string): Promise<CompareRead> {
      const { owner, name } = splitRepository(repository, allowed);
      let result;
      try {
        result = await options.rest.compare(owner, name, baseSha, headSha);
      } catch (error) {
        return toReadError(error);
      }
      if (result.status !== 200) return { kind: 'unproven', reason: result.status === 404 ? 'not_found' : 'unprocessable' };
      return normalizeCompare(result.body);
    },
  };
}
