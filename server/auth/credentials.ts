/**
 * Abstração de credenciais do GitHub.
 *
 * Hoje existe apenas o token fine-grained (somente leitura, restrito ao repositório autorizado).
 * Um provedor de GitHub App poderá implementar a mesma interface no futuro (gerando o token de
 * instalação sob demanda) sem alterar o cliente HTTP nem as rotas.
 */
export interface CredentialProvider {
  readonly kind: 'fine-grained-token';
  /** Valor do cabeçalho `Authorization`. Uso exclusivo do cliente HTTP do GitHub. */
  getAuthorizationHeader(): Promise<string>;
}

export class CredentialError extends Error {
  name = 'CredentialError';
}

const FINE_GRAINED_PATTERN = /^github_pat_[A-Za-z0-9_]{20,255}$/;

export function createFineGrainedTokenProvider(token: string): CredentialProvider {
  if (!FINE_GRAINED_PATTERN.test(token)) {
    // Recusa tokens clássicos (ghp_), OAuth (gho_) e outros: só o token fine-grained foi aprovado.
    throw new CredentialError(
      'GITHUB_TOKEN deve ser um token fine-grained (prefixo github_pat_) com permissões somente de leitura.',
    );
  }

  const provider: CredentialProvider = {
    kind: 'fine-grained-token',
    getAuthorizationHeader: () => Promise.resolve(`Bearer ${token}`),
  };

  // O token vive apenas no closure. Evita que apareça em JSON.stringify, console.log ou util.inspect.
  Object.defineProperties(provider, {
    toJSON: { value: () => ({ kind: provider.kind }), enumerable: false },
    [Symbol.for('nodejs.util.inspect.custom')]: {
      value: () => `CredentialProvider<${provider.kind}>`,
      enumerable: false,
    },
  });

  return provider;
}
