import {
  assertSeparate as sharedAssertSeparate,
  checkRegularFile as sharedCheckRegularFile,
  secureDirectory as sharedSecureDirectory,
  type PathEnvironment,
} from '../storage/paths.ts';
import { approvalErrors } from './canonical.ts';

/**
 * Validação dos caminhos EFETIVOS do armazenamento de aprovações (N2). Desde a Issue #012 (U4) a
 * implementação fica em `server/storage/paths.ts`; este módulo mantém a API e as mesmas regras,
 * com erros `ApprovalError` e os mesmos códigos (`path_in_git_repository`, `file_is_link`, …).
 */
export type { PathEnvironment };

/** Valida (e cria, se preciso) um diretório protegido. Devolve o caminho REAL. */
export function secureDirectory(path: string, environment: PathEnvironment): Promise<string> {
  return sharedSecureDirectory(path, environment, approvalErrors);
}

/** Os dois diretórios precisam ser distintos e não aninhados (o anchor fica fora do ledger). */
export function assertSeparate(a: string, b: string, platform: NodeJS.Platform = process.platform): void {
  sharedAssertSeparate(a, b, platform, approvalErrors);
}

/** Arquivo existente: nunca link simbólico nem com links físicos extras. `false` se não existe. */
export function checkRegularFile(path: string): Promise<boolean> {
  return sharedCheckRegularFile(path, approvalErrors);
}
