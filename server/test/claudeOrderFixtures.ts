import { createHash } from 'node:crypto';
import { POLICY_ACTIONS, type ClaudeOrderView } from '../../shared/contracts.ts';
import { createClaudeOrders, type ClaudeOrders } from '../gateway/orders.ts';
import type { GatewayServiceOptions } from '../gateway/service.ts';
import { GitHubReadError, type CompareRead, type MainHeadRead, type PullRequestRead, type PullRequestReaderPort, type PullRequestSnapshot } from '../github/prTypes.ts';
import { createGatewayStack, PROJECT, TASK, TASK_B, type GatewayStack } from './gatewayFixtures.ts';
import { REPO } from './schedulerFixtures.ts';

/**
 * Pilha de teste das ordens do Claude Code (Issue #008): a pilha REAL do gateway (#028) com o
 * catálogo de PRODUÇÃO (`agent.invoke`/`data.send_external` indisponíveis — só a exceção fechada
 * libera), aprovações reais (#011) e um GitHub FALSO, somente leitura, em memória (sem rede).
 */

export const REPO_ID = 'R_kgDOTestRepo01';
export const BASE = 'b'.repeat(40);
export const HEAD = 'a1'.repeat(20);
export const HEAD_2 = 'a2'.repeat(20);
export { PROJECT, REPO, TASK };

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export type Fault = 'unavailable' | 'unauthorized' | 'malformed';

export interface FakeGitHub extends PullRequestReaderPort {
  main: MainHeadRead;
  /** PR atual (`null` = o número não existe no repositório). */
  pr: PullRequestSnapshot | null;
  /** Resultado da comparação (padrão: `ahead` com o SHA base conferindo). */
  compareWith: (base: string, head: string) => CompareRead;
  /** Falhas injetadas, consumidas uma por chamada (qualquer operação). */
  faults: Fault[];
  /** Chamado a cada leitura do PR (índice da chamada): permite mudar a cabeça no meio. */
  onPullRequest: ((call: number) => void) | null;
  calls: Array<{ op: 'mainHead' | 'pullRequest' | 'compare'; args: unknown[] }>;
}

export function conformingPr(order: Pick<ClaudeOrderView, 'workBranch'>, overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    repository: { id: REPO_ID, nameWithOwner: REPO },
    number: 7,
    state: 'OPEN',
    merged: false,
    mergedAt: null,
    isDraft: false,
    headRefName: order.workBranch,
    headRefOid: HEAD,
    baseRefName: 'main',
    isCrossRepository: false,
    headRepositoryId: REPO_ID,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    commits: { total: 2, listed: [{ oid: 'c1'.repeat(20), authorLogin: 'po', committerLogin: 'po', signatureValid: null }, { oid: HEAD, authorLogin: 'po', committerLogin: 'web-flow', signatureValid: true }] },
    lastCommit: { oid: HEAD, rollup: { state: 'SUCCESS', contextsTotal: 3, contexts: [{ name: 'build', state: 'success' }, { name: 'test', state: 'success' }, { name: 'secret-scan', state: 'success' }] } },
    files: { total: 2, paths: ['server/x.ts', 'docs/y.md'], complete: true },
    ...overrides,
  };
}

export function createFakeGitHub(): FakeGitHub {
  let prCalls = 0;
  const gh: FakeGitHub = {
    main: { repositoryId: REPO_ID, nameWithOwner: REPO, sha: BASE },
    pr: null,
    compareWith: (base, head) => {
      const ahead = gh.pr?.commits.total ?? 1;
      const normalized = { status: 'ahead' as const, aheadBy: ahead, behindBy: 0, baseSha: base, mergeBaseSha: base, head };
      return { kind: 'ok', digest: digest(normalized), status: 'ahead', aheadBy: ahead, behindBy: 0, baseSha: base, mergeBaseSha: base };
    },
    faults: [],
    onPullRequest: null,
    calls: [],
    async mainHead(repository) {
      gh.calls.push({ op: 'mainHead', args: [repository] });
      fault();
      return structuredClone(gh.main);
    },
    async pullRequest(repository, number) {
      gh.calls.push({ op: 'pullRequest', args: [repository, number] });
      gh.onPullRequest?.(prCalls);
      prCalls += 1;
      if (fault() === 'malformed') return { kind: 'malformed' };
      if (gh.pr === null || gh.pr.number !== number) return { kind: 'pr_missing', digest: digest({ missing: number }), repository: { id: REPO_ID, nameWithOwner: REPO } };
      const pr = structuredClone(gh.pr);
      return { kind: 'ok', digest: digest(pr), pr } satisfies PullRequestRead;
    },
    async compare(repository, base, head) {
      gh.calls.push({ op: 'compare', args: [repository, base, head] });
      fault();
      return gh.compareWith(base, head);
    },
  };
  function fault(): Fault | null {
    const next = gh.faults.shift() ?? null;
    if (next === 'unavailable') throw new GitHubReadError('github_unavailable');
    if (next === 'unauthorized') throw new GitHubReadError('github_unauthorized');
    return next;
  }
  return gh;
}

export interface OrderStack {
  g: GatewayStack;
  orders: ClaudeOrders;
  github: FakeGitHub;
  profile: { available: boolean };
  actor: { kind: 'human'; id: string };
  /** Habilita o projeto (confirmação de configuração do PO, #011). */
  enable(projectId?: string): Promise<void>;
  create(overrides?: Record<string, unknown>): Promise<ClaudeOrderView>;
  /** Cria, aprova as duas ações e libera o pacote. */
  released(overrides?: Record<string, unknown>): Promise<{ order: ClaudeOrderView; package: string }>;
  /** Cria → aprova → libera → informa o PR #7 conforme. */
  linked(overrides?: Partial<PullRequestSnapshot>): Promise<ClaudeOrderView>;
  /** Avança o relógio além do intervalo mínimo entre verificações. */
  waitInterval(): void;
  close(): Promise<void>;
}

let keySeq = 0;

export async function createOrderStack(options: { gateway?: Partial<GatewayServiceOptions>; reader?: 'none' } = {}): Promise<OrderStack> {
  const profile = { available: true };
  const g = await createGatewayStack({ gateway: { catalog: POLICY_ACTIONS, assistedProfileAvailable: () => profile.available, ...options.gateway } });
  g.data.set(`${PROJECT}|task|${TASK_B}`, 'Descrição da tarefa B (dado de projeto).');
  const github = createFakeGitHub();
  const orders = createClaudeOrders({
    gateway: g.gateway,
    reader: options.reader === 'none' ? null : github,
    approvalsFor: (ownerId, scopeId) =>
      g.s.service
        .list(ownerId)
        .filter((a) => a.binding.resource.type === 'gateway_scope' && a.binding.resource.id === scopeId)
        .map((a) => ({ id: a.id, action: a.binding.action, state: a.state })),
    now: () => g.s.h.clock.now,
  });
  const stack: OrderStack = {
    g,
    orders,
    github,
    profile,
    actor: { kind: 'human', id: 'admin' },
    async enable(projectId = PROJECT) {
      await orders.enable('admin', projectId, REPO, await g.confirm());
    },
    async create(overrides = {}) {
      keySeq += 1;
      return orders.create('admin', (overrides.projectId as string) ?? PROJECT, (overrides.taskId as string) ?? TASK, {
        idempotencyKey: `order-test-${String(keySeq).padStart(5, '0')}`,
        objective: 'Implementar a validação do campo X.',
        acceptanceCriteria: ['Testes passam', 'Lint limpo'],
        dataRefs: [{ kind: 'task', ref: TASK }],
        ...overrides,
      });
    },
    async released(overrides = {}) {
      const order = await stack.create(overrides);
      await g.approveAll();
      return orders.release('admin', order.projectId, order.orderId, await g.confirm());
    },
    async linked(overrides = {}) {
      const { order } = await stack.released();
      github.pr = conformingPr(order, overrides);
      return orders.linkPullRequest('admin', order.projectId, order.orderId, `${REPO}#7`, await g.confirm());
    },
    waitInterval() {
      g.s.advance(31_000);
    },
    close: () => g.close(),
  };
  return stack;
}

export const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};
