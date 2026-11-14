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
  failNext(op: 'prepare' | 'start' | 'stop' | 'destroy', code?: string, message?: string): void;
}

export function createSimulatedProvider(): SimulatedProvider {
  const calls: Array<{ op: 'prepare' | 'start' | 'stop' | 'destroy'; requestId: string }> = [];
  const live = new Set<string>();
  const failures = new Map<string, { code: string; message?: string }>();

  const maybeFail = (op: string) => {
    const failure = failures.get(op);
    if (failure) {
      failures.delete(op);
      throw new SandboxProviderError(failure.code, failure.message);
    }
  };

  return {
    id: 'simulated',
    isolation: 'simulated',
    executesCode: false,
    calls,
    liveWorkspaces: live,
    failNext(op, code = 'provider_error', message) {
      failures.set(op, { code, message });
    },
    async prepare(spec: SandboxSpec) {
      calls.push({ op: 'prepare', requestId: spec.requestId });
      maybeFail('prepare');
      live.add(spec.workspace.id);
    },
    async start(spec: SandboxSpec) {
      calls.push({ op: 'start', requestId: spec.requestId });
      maybeFail('start');
      // Nada é executado: a simulação só registra que "começou".
    },
    async stop(requestId: string) {
      calls.push({ op: 'stop', requestId });
      maybeFail('stop');
    },
    async destroy(requestId: string) {
      calls.push({ op: 'destroy', requestId });
      maybeFail('destroy');
      live.delete(`ws-${requestId.replaceAll('-', '')}`);
    },
  };
}
