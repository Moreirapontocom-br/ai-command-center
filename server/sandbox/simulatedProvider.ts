import type { SandboxSpec } from './contracts.ts';
import { SandboxProviderError, type SandboxProvider } from './provider.ts';

/**
 * Adaptador SIMULADO (Issue #021), exclusivo para testes da camada preparatória.
 *
 * NÃO É UMA SANDBOX: não executa nada, não cria processos, não toca no sistema de arquivos nem na
 * rede, e NÃO oferece isolamento algum. Nunca deve ser usado para código não confiável — ele
 * apenas registra chamadas em memória e permite injetar falhas.
 */
export interface SimulatedProvider extends SandboxProvider {
  readonly calls: ReadonlyArray<{ op: 'prepare' | 'start' | 'stop' | 'destroy'; requestId: string }>;
  /** Workspaces "vivos" (preparados e ainda não descartados). */
  readonly liveWorkspaces: ReadonlySet<string>;
  /** Execuções "ativas" simuladas (iniciadas e ainda não paradas nem descartadas). Nada roda de fato. */
  readonly activeExecutions: ReadonlySet<string>;
  /**
   * Faz a próxima chamada de `op` lançar `SandboxProviderError(code, message)`. Com `partial: true`,
   * o efeito simulado acontece ANTES do erro (workspace criado / execução marcada como ativa),
   * reproduzindo um provedor que falha no meio da operação.
   */
  failNext(op: 'prepare' | 'start' | 'stop' | 'destroy', code?: string, message?: string, options?: { partial?: boolean }): void;
}

export function createSimulatedProvider(): SimulatedProvider {
  const calls: Array<{ op: 'prepare' | 'start' | 'stop' | 'destroy'; requestId: string }> = [];
  const live = new Set<string>();
  const active = new Set<string>();
  const failures = new Map<string, { code: string; message?: string; partial: boolean }>();

  /** Aplica o efeito simulado; com falha agendada, lança antes dele (padrão) ou depois (`partial`). */
  const run = (op: string, effect: () => void) => {
    const failure = failures.get(op);
    if (!failure) return effect();
    failures.delete(op);
    if (failure.partial) effect();
    throw new SandboxProviderError(failure.code, failure.message);
  };

  return {
    id: 'simulated',
    isolation: 'simulated',
    executesCode: false,
    calls,
    liveWorkspaces: live,
    activeExecutions: active,
    failNext(op, code = 'provider_error', message, options) {
      failures.set(op, { code, message, partial: options?.partial === true });
    },
    async prepare(spec: SandboxSpec) {
      calls.push({ op: 'prepare', requestId: spec.requestId });
      run('prepare', () => live.add(spec.workspace.id));
    },
    async start(spec: SandboxSpec) {
      calls.push({ op: 'start', requestId: spec.requestId });
      // Nada é executado: a simulação só registra que "começou".
      run('start', () => active.add(spec.requestId));
    },
    async stop(requestId: string) {
      calls.push({ op: 'stop', requestId });
      run('stop', () => active.delete(requestId));
    },
    async destroy(requestId: string) {
      calls.push({ op: 'destroy', requestId });
      // Descartar o workspace (simulado) encerra também o que estivesse "ativo" nele.
      run('destroy', () => {
        live.delete(`ws-${requestId.replaceAll('-', '')}`);
        active.delete(requestId);
      });
    },
  };
}
