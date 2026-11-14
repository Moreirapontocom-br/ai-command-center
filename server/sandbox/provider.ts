import type { SandboxSpec } from './contracts.ts';

/**
 * Interface abstrata de provedor de sandbox (Issue #021). Um provedor real (container, microVM ou
 * serviço gerenciado — escolha da #031, com aprovação do PO) precisará cumprir TODAS as garantias
 * descritas em `SandboxSpec`. O tipo de isolamento é declarado pelo provedor e o serviço recusa
 * provedores que declarem execução real enquanto `REAL_EXECUTION_ENABLED` for `false`.
 */
export interface SandboxProvider {
  readonly id: string;
  /**
   * `simulated`: nenhuma execução, nenhum isolamento — só para testes. Os demais valores serão
   * usados por provedores reais e indicam o nível de isolamento oferecido.
   */
  readonly isolation: 'simulated' | 'container' | 'microvm' | 'managed';
  /** `true` se o provedor executa código de fato. */
  readonly executesCode: boolean;
  /** Prepara o workspace exclusivo (vazio ou com o SHA base, somente leitura fora da branch de trabalho). */
  prepare(spec: SandboxSpec): Promise<void>;
  /** Inicia a execução já autorizada. */
  start(spec: SandboxSpec): Promise<void>;
  /** Interrompe a execução (idempotente). */
  stop(requestId: string): Promise<void>;
  /** Descarta workspace, credenciais temporárias e rede (idempotente). */
  destroy(requestId: string): Promise<void>;
}

/** Erro de provedor: só o código (token) é guardado; a mensagem nunca vai para registros. */
export class SandboxProviderError extends Error {
  name = 'SandboxProviderError';
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}
