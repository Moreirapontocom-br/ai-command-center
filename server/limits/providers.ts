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

/**
 * Issue #008 (D-08.3, §10.7.3): o ÚNICO perfil disponível é `claude-code/subscription_assisted` —
 * o PO usa o Claude Code com a própria assinatura, FORA do ACC (o ACC não executa nem chama a
 * Anthropic). Todos os demais continuam `unverified`; `metered_api` continua recusado sem orçamento.
 * Voltar este perfil a `unverified` desliga o fluxo assistido sem deploy de outra parte (rollback).
 */
export const ASSISTED_PROFILE = Object.freeze({ provider: 'claude-code', mode: 'subscription_assisted' } as const);

export function defaultProviderCatalog(): ProviderProfile[] {
  return AGENT_IDS.flatMap((provider) =>
    USAGE_MODES.map((mode) => {
      const assisted = provider === ASSISTED_PROFILE.provider && mode === ASSISTED_PROFILE.mode;
      return {
        provider,
        mode,
        status: assisted ? ('available' as const) : ('unverified' as const),
        billing: defaultBilling(provider, mode),
        statusReason: assisted ? 'assisted_issue_008' : 'not_verified_issue_028',
        statusUntil: null,
        officialRequestLimit: null,
      };
    }),
  );
}

/** O perfil assistido está disponível no catálogo do servidor? (falha fechada em qualquer dúvida) */
export function assistedProfileAvailable(catalog: readonly ProviderProfile[] = defaultProviderCatalog()): boolean {
  const matches = catalog.filter((p) => p.provider === ASSISTED_PROFILE.provider && p.mode === ASSISTED_PROFILE.mode);
  return matches.length === 1 && matches[0].status === 'available' && matches[0].billing === 'included';
}
