/**
 * Consultas GraphQL FIXAS. O navegador nunca envia consultas nem caminhos da API: só escolhe um
 * repositório da lista autorizada. Todas as operações são `query` (leitura); não há `mutation`.
 *
 * Por que GraphQL em vez de REST: com REST, um snapshot exigiria ~1 chamada por recurso (repo,
 * issues, PRs abertos, PRs fechados, branches), chamadas à Search API para contagens confiáveis
 * (o `open_issues_count` do REST soma PRs) e 1–2 chamadas por PR/branch para o estado dos checks —
 * dezenas de requisições por atualização. Em GraphQL é uma única requisição (custo ~1 ponto), com
 * `totalCount` exato por estado, `isDraft`, `reviewDecision` e `statusCheckRollup`.
 * Contrapartidas assumidas: erros podem vir com HTTP 200 (tratados em `client.ts`) e não há
 * requisições condicionais com ETag (compensado pelo cache em memória).
 */

export const LIST_LIMITS = {
  openIssues: 50,
  recentClosedIssues: 10,
  openPullRequests: 50,
  recentClosedPullRequests: 10,
  branches: 100,
  assignees: 10,
  labels: 20,
} as const;

const COMMIT_FIELDS = `
  oid
  abbreviatedOid
  committedDate
  url
  statusCheckRollup { state }
`;

const ISSUE_FIELDS = `
  number
  title
  state
  stateReason
  url
  updatedAt
  assignees(first: ${LIST_LIMITS.assignees}) { nodes { login url } }
  labels(first: ${LIST_LIMITS.labels}) { nodes { name color } }
`;

const PULL_REQUEST_FIELDS = `
  number
  title
  state
  isDraft
  url
  updatedAt
  mergedAt
  closedAt
  headRefName
  baseRefName
  reviewDecision
  author { login }
  reviewRequests { totalCount }
  assignees(first: ${LIST_LIMITS.assignees}) { nodes { login url } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

export const REPO_SNAPSHOT_QUERY = `
query RepoSnapshot($owner: String!, $name: String!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    nameWithOwner
    description
    url
    isPrivate
    isArchived
    updatedAt
    pushedAt
    defaultBranchRef { name target { ... on Commit { ${COMMIT_FIELDS} } } }
    openIssueCount: issues(states: OPEN) { totalCount }
    closedIssueCount: issues(states: CLOSED) { totalCount }
    openPullRequestCount: pullRequests(states: OPEN) { totalCount }
    closedPullRequestCount: pullRequests(states: CLOSED) { totalCount }
    mergedPullRequestCount: pullRequests(states: MERGED) { totalCount }
    openIssues: issues(states: OPEN, first: ${LIST_LIMITS.openIssues}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${ISSUE_FIELDS} }
    }
    recentClosedIssues: issues(states: CLOSED, first: ${LIST_LIMITS.recentClosedIssues}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${ISSUE_FIELDS} }
    }
    openPullRequests: pullRequests(states: OPEN, first: ${LIST_LIMITS.openPullRequests}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${PULL_REQUEST_FIELDS} }
    }
    recentClosedPullRequests: pullRequests(states: [CLOSED, MERGED], first: ${LIST_LIMITS.recentClosedPullRequests}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${PULL_REQUEST_FIELDS} }
    }
    refs(refPrefix: "refs/heads/", first: ${LIST_LIMITS.branches}, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      totalCount
      nodes { name target { ... on Commit { ${COMMIT_FIELDS} } } }
    }
  }
}
`;
