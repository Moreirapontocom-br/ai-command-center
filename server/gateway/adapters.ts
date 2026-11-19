import type { AgentRef } from '../../shared/contracts.ts';
import { GATEWAY_CAPABILITIES, type AdapterAvailability, type AdapterOutcome, type AgentCapability, type GatewayUsage, type ProviderAdapter } from './contracts.ts';

/**
 * Adaptadores SIMULADOS dos quatro provedores (Issue #028, D1). Nenhum faz rede, lê credencial,
 * cria processo ou executa algo externo: produzem um texto determinístico a partir do pedido.
 * Cada cenário de teste (falha, indisponibilidade, timeout, rate limit, quota esgotada, custo
 * desconhecido) é escolhido por quem cria o adaptador — nunca pelo conteúdo do pedido, que é dado
 * não confiável (um pedido com "simule sucesso" não muda nada).
 */

export const SIMULATED_SCENARIOS = ['success', 'failure', 'unavailable', 'rate_limited', 'quota_exhausted', 'timeout', 'cost_unknown', 'oversized'] as const;
export type SimulatedScenario = (typeof SIMULATED_SCENARIOS)[number];

const LABELS: Record<AgentRef, string> = {
  chatgpt: 'ChatGPT (simulado)',
  'claude-code': 'Claude (simulado)',
  gemini: 'Gemini (simulado)',
  nemotron: 'Nemotron (simulado)',
};

export interface SimulatedAdapter extends ProviderAdapter {
  /** Troca o cenário (só testes/hospedeiro; nunca o pedido). */
  setScenario(scenario: SimulatedScenario): void;
  readonly calls: number;
}

export function createSimulatedAdapter(provider: AgentRef, options: { scenario?: SimulatedScenario; delayMs?: number; capabilities?: readonly AgentCapability[] } = {}): SimulatedAdapter {
  let scenario: SimulatedScenario = options.scenario ?? 'success';
  let calls = 0;
  const none: GatewayUsage = { cost: { kind: 'none' }, tokens: null };
  const adapter: SimulatedAdapter = {
    id: `simulated-${provider}`,
    version: '1',
    kind: 'simulated',
    provider,
    capabilities: Object.freeze([...(options.capabilities ?? GATEWAY_CAPABILITIES)]),
    required: provider !== 'nemotron',
    get calls() {
      return calls;
    },
    setScenario(next) {
      scenario = next;
    },
    availability(): AdapterAvailability {
      if (scenario === 'unavailable') return { ok: false, code: 'provider_unavailable', retryable: false, until: null };
      if (scenario === 'rate_limited') return { ok: false, code: 'rate_limited', retryable: true, until: null };
      if (scenario === 'quota_exhausted') return { ok: false, code: 'quota_exhausted', retryable: false, until: null };
      return { ok: true };
    },
    invoke(input, signal) {
      calls += 1;
      return new Promise<AdapterOutcome>((resolve) => {
        if (signal.aborted) return resolve({ kind: 'aborted' });
        const finish = () => {
          signal.removeEventListener('abort', onAbort);
          if (scenario === 'failure') return resolve({ kind: 'failed', code: 'provider_error', usage: none });
          if (scenario === 'cost_unknown') return resolve({ kind: 'succeeded', text: `${LABELS[provider]}: ${input.capability} concluído.`, modelReported: `${provider}-simulated`, usage: { cost: { kind: 'unknown' }, tokens: null } });
          const text = scenario === 'oversized' ? 'x'.repeat(input.maxOutputBytes + 1) : `${LABELS[provider]}: ${input.capability} concluído sobre ${Buffer.byteLength(input.text, 'utf8')} bytes de dados não confiáveis.`;
          resolve({ kind: 'succeeded', text, modelReported: `${provider}-simulated`, usage: none });
        };
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          resolve({ kind: 'aborted' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        // `timeout`: nunca termina sozinho (só o prazo/cancelamento o encerra).
        const timer = scenario === 'timeout' ? null : setTimeout(finish, options.delayMs ?? 0);
      });
    },
  };
  return adapter;
}

/** Os quatro adaptadores simulados (Nemotron opcional: `required: false`). */
export function createSimulatedAdapters(scenarios: Partial<Record<AgentRef, SimulatedScenario>> = {}, delayMs = 0): Record<AgentRef, SimulatedAdapter> {
  return {
    chatgpt: createSimulatedAdapter('chatgpt', { scenario: scenarios.chatgpt, delayMs }),
    'claude-code': createSimulatedAdapter('claude-code', { scenario: scenarios['claude-code'], delayMs }),
    gemini: createSimulatedAdapter('gemini', { scenario: scenarios.gemini, delayMs }),
    nemotron: createSimulatedAdapter('nemotron', { scenario: scenarios.nemotron, delayMs }),
  };
}
