/**
 * Leituras NORMALIZADAS do GitHub usadas pela verificação de PRs da Issue #008 (somente tipos).
 *
 * Quem produz: `server/github/prReader.ts` (consulta GraphQL aprovada + uma comparação REST GET
 * fechada). Quem consome: `server/gateway/prVerification.ts` (regras puras V1–V13). O gateway só
 * conhece estes TIPOS e uma porta injetada — nunca a rede nem a credencial.
 *
 * Toda leitura é DADO NÃO CONFIÁVEL: os normalizadores aceitam só formatos fechados; o que não
 * couber vira `malformed`, nunca um "ok" presumido.
 */

export type CheckState = 'success' | 'pending' | 'failure';

export interface PullRequestSnapshot {
  repository: { id: string; nameWithOwner: string };
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  merged: boolean;
  mergedAt: string | null;
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  isCrossRepository: boolean;
  headRepositoryId: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  commits: {
    total: number;
    /** Até 100 (V9 só exibe os primeiros). */
    listed: Array<{ oid: string; authorLogin: string | null; committerLogin: string | null; signatureValid: boolean | null }>;
  };
  /** Último commit do PR e os checks dele (V11/V12). */
  lastCommit: {
    oid: string;
    rollup: null | { state: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'ERROR' | 'EXPECTED'; contextsTotal: number; contexts: Array<{ name: string; state: CheckState }> };
  } | null;
  /** Caminhos alterados (até 3 páginas de 100). `complete` = a lista cobre `total`. */
  files: { total: number; paths: string[]; complete: boolean };
}

/** Leitura do PR (consulta GraphQL `PullRequestVerification`). */
export type PullRequestRead =
  | { kind: 'ok'; digest: string; pr: PullRequestSnapshot }
  /** Repositório legível, mas sem PR com esse número (V2). */
  | { kind: 'pr_missing'; digest: string; repository: { id: string; nameWithOwner: string } }
  /** Resposta fora do formato esperado (nunca vira sucesso). */
  | { kind: 'malformed' };

/** Comparação REST `GET /repos/{o}/{r}/compare/{base}...{head}?per_page=1` (V6, §6.4). */
export type CompareRead =
  | { kind: 'ok'; digest: string; status: 'ahead' | 'behind' | 'identical' | 'diverged'; aheadBy: number; behindBy: number; baseSha: string; mergeBaseSha: string }
  /** 404, 422, campo ausente ou tipo errado: sem prova (→ `needs_review`, `ancestry_unproven`). */
  | { kind: 'unproven'; reason: 'not_found' | 'unprocessable' | 'malformed' };

/** Cabeça de `main` lida na preparação da ordem (SHA base) e a identidade estável do repositório. */
export interface MainHeadRead {
  repositoryId: string;
  nameWithOwner: string;
  sha: string;
}

/** Erros que impedem gravar qualquer verificação (o estado não muda). */
export type GitHubReadErrorCode = 'github_unavailable' | 'github_unauthorized';

export class GitHubReadError extends Error {
  name = 'GitHubReadError';
  readonly code: GitHubReadErrorCode;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: GitHubReadErrorCode, retryAfterSeconds?: number) {
    super(code);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Porta somente leitura entregue ao coordenador das ordens (implementação: `prReader.ts`). */
export interface PullRequestReaderPort {
  mainHead(repository: string): Promise<MainHeadRead>;
  pullRequest(repository: string, number: number): Promise<PullRequestRead>;
  compare(repository: string, baseSha: string, headSha: string): Promise<CompareRead>;
}
