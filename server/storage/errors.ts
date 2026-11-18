/**
 * Erros das primitivas compartilhadas de armazenamento (Issue #012, D7/U4).
 *
 * As primitivas (`canonical`, `paths`, `lock`) são usadas por mais de um núcleo. Cada núcleo
 * mantém a PRÓPRIA classe de erro e os MESMOS códigos: o chamador injeta uma `ErrorFactory` e a
 * primitiva cria e reconhece erros só por ela. Assim o núcleo de aprovações (#011) continua
 * recebendo `ApprovalError` com exatamente os códigos de antes — inclusive dentro da retomada do
 * bloqueio, onde um erro "próprio" (ex.: `store_locked`) é repassado intacto e qualquer outro vira
 * `lock_recovery_failed`.
 */
export interface ErrorFactory {
  /** Cria o erro com o código-token indicado. */
  create(code: string): Error;
  /** O erro foi criado por esta fábrica (e deve ser repassado sem conversão)? */
  is(error: unknown): boolean;
}

export class StorageError extends Error {
  name = 'StorageError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export const storageErrors: ErrorFactory = {
  create: (code) => new StorageError(code),
  is: (error) => error instanceof StorageError,
};
