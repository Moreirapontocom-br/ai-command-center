/**
 * Abstração de credenciais do GitHub.
 *
 * Provedores disponíveis:
 * - `fine-grained-token`: token fine-grained somente leitura, restrito ao repositório autorizado;
 * - `gh-cli`: token da sessão local do GitHub CLI (ver `ghCli.ts`) — apenas desenvolvimento local.
 *
 * Um provedor de GitHub App poderá implementar a mesma interface no futuro (gerando o token de
 * instalação sob demanda) sem alterar o cliente HTTP nem as rotas.
 */
export type CredentialKind = 'fine-grained-token' | 'gh-cli';

export interface CredentialProvider {
  readonly kind: CredentialKind;
  /** Valor do cabeçalho `Authorization`. Uso exclusivo do cliente HTTP do GitHub. */
  getAuthorizationHeader(): Promise<string>;
  /**
   * Descarta a credencial em cache para que a próxima chamada a obtenha novamente. Só existe em
   * provedores renováveis; o cliente chama no máximo uma vez por requisição, após um HTTP 401.
   */
  invalidate?(): void;
}

export class CredentialError extends Error {
  name = 'CredentialError';
}

/**
 * Impede que o provedor (e, portanto, o token guardado no closure) apareça em `JSON.stringify`,
 * `console.log` ou `util.inspect`.
 */
export function sealProvider<T extends CredentialProvider>(provider: T): T {
  Object.defineProperties(provider, {
    toJSON: { value: () => ({ kind: provider.kind }), enumerable: false },
    toString: { value: () => `CredentialProvider<${provider.kind}>`, enumerable: false },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value: () => `CredentialProvider<${provider.kind}>`,
      enumerable: false,
    },
  });
  return provider;
}

const FINE_GRAINED_PATTERN = /^github_pat_[A-Za-z0-9_]{20,255}$/;

export function createFineGrainedTokenProvider(token: string): CredentialProvider {
  if (!FINE_GRAINED_PATTERN.test(token)) {
    // Recusa tokens clássicos (ghp_), OAuth (gho_) e outros: só o token fine-grained foi aprovado.
    throw new CredentialError(
      'GITHUB_TOKEN deve ser um token fine-grained (prefixo github_pat_) com permissões somente de leitura.',
    );
  }

  return sealProvider<CredentialProvider>({
    kind: 'fine-grained-token',
    getAuthorizationHeader: () => Promise.resolve(`Bearer ${token}`),
  });
}
