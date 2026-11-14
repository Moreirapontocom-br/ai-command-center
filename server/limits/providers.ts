import { AGENT_IDS, type AgentRef } from '../../shared/contracts.ts';
import { USAGE_MODES, type BillingClass, type ProviderProfile, type UsageMode } from './contracts.ts';

/**
 * Catálogo de provedores (Issue #022), mantido no servidor e revisado como código.
 *
 * TUDO começa `unverified`: nenhuma capacidade foi verificada oficialmente para as contas do PO.
 * A verificação de compatibilidade e dos limites de cada plano é da Issue #028; até lá, nenhuma
 * admissão é possível com este catálogo. Os testes usam um catálogo próprio.
 *
 * Cobrança (`billing`) é a classificação CONSERVADORA do que se sabe, nunca do que o chamador diz:
 * - uso assistido de assinatura existente (ChatGPT Plus, Claude Pro/Claude Code, Gemini) → `included`;
 * - Nemotron não tem assinatura do PO: o modo assistido fica `unknown` (bloqueado);
 * - integrações oficiais → `unknown` até a #028 apurar condições e limites;
 * - APIs → `metered`. Créditos gratuitos NÃO são presumidos: continua exigindo orçamento.
 */
const SUBSCRIPTION_BILLING: Record<AgentRef, BillingClass> = {
  chatgpt: 'included',
  'claude-code': 'included',
  gemini: 'included',
  nemotron: 'unknown',
};

function defaultBilling(provider: AgentRef, mode: UsageMode): BillingClass {
  if (mode === 'subscription_assisted') return SUBSCRIPTION_BILLING[provider];
  if (mode === 'metered_api') return 'metered';
  return 'unknown';
}

export function defaultProviderCatalog(): ProviderProfile[] {
  return AGENT_IDS.flatMap((provider) =>
    USAGE_MODES.map((mode) => ({
      provider,
      mode,
      status: 'unverified' as const,
      billing: defaultBilling(provider, mode),
      statusReason: 'not_verified_issue_028',
      statusUntil: null,
      officialRequestLimit: null,
    })),
  );
}
