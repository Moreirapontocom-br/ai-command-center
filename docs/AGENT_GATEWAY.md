# Agent Gateway — Especificação (Issue #028, PR 1)

> **Status: ESPECIFICAÇÃO + NÚCLEO DORMENTE E SIMULADO (PR 2, §16). Não autoriza integração, credenciais, gastos, deploy nem execução.**
> - `REAL_EXECUTION_ENABLED = false as const` (inalterado).
> - Todos os perfis de `server/limits/providers.ts` continuam `unverified` (motivo `not_verified_issue_028`). Marcar qualquer perfil como `available` exige PR revisado e aprovação específica do Product Owner (PO).
> - Orçamento adicional autorizado: **R$ 0** (`DEFAULT_LIMITS.budget.globalMinor = 0`).
> - Documentar uma integração **não** é autorização para integrar.
> - PR 2: `server/gateway/` implementado, sem ligação no `server/index.ts`, sem rota HTTP e só com adaptadores simulados (§16).
>
> Base: `main` `f25aa492434c60f56424f23ac5d3e1efe3ddfde2`. Fontes consultadas em **2026-11-18** (registro completo em `docs/evidence/issue028-pr1-sources.txt`).

## Sumário

0. Status (acima)
1. Objetivo e limites
2. Princípios
3. Matriz dos provedores
4. Contrato comum
5. Taxonomia de erros, prazos e cancelamento
6. Autorização (D2/D3)
7. Credenciais e isolamento
8. Fluxo assistido (D5)
9. Fila central e executores (D6)
10. Persistência (D7)
11. Auditoria
12. Incompatibilidades com o código atual (I1–I9)
13. Plano de testes (PR 2 em diante)
14. Divisão em PRs, decisões D1–D9 e pendências
15. Registro de fontes
16. Implementação (PR 2)

---

## 1. Objetivo e limites

**Objetivo da #028.** Oferecer um ponto único e auditável pelo qual o ACC pede trabalho a agentes de IA (ChatGPT/OpenAI, Claude/Anthropic, Gemini/Google e, opcionalmente, Nemotron/NVIDIA) e recebe resultados padronizados, sem supor acesso por API incluído nas assinaturas.

**A #028 entrega (D1):**
- contrato comum de entrada/saída, proveniência, capacidades, timeout e erros;
- adaptadores **simulados** dos quatro provedores;
- **núcleo** do fluxo assistido (D5), sem a experiência completa de frontend;
- matriz comprovada de acesso (seção 3).

**A #028 NÃO entrega:**

| Fora do escopo | Onde fica |
|---|---|
| Adaptadores reais, credenciais, chamadas de rede | PR futuro, com autorização específica do PO |
| Execução do Claude Code em sandbox | #008 + #031 |
| Documentação com Gemini | #009 |
| Orquestração / planejamento | #010 |
| Roteamento automático com override manual | #029 |
| Memória global com ACL | #030 |
| Executor cloud | #031 |
| Experiência completa de UI do fluxo assistido | frontend (#014/#015) |

## 2. Princípios

1. **Usuário é a autoridade final.** Autonomia semiautomática (B): ações críticas sempre exigem aprovação humana.
2. **Negação por padrão.** Sem regra, sem escopo aprovado ou sem perfil `available` → recusado.
3. **O ACC é o hub.** Um agente nunca fala diretamente com outro. Toda troca passa pelo gateway (política, limites, aprovação, auditoria). "Comunicação híbrida" = integração oficial automática quando houver uma aprovada; fluxo assistido (humano no meio) nos demais casos.
4. **Saída de agente é dado não confiável.** Nunca é instrução para o ACC, nunca altera política, limites, escopo ou permissões.
5. **Só integrações oficiais.** Nada de automação de navegador, cookies, raspagem de interface ou uso de credenciais de assinatura por terceiros (seção 3 mostra que os termos proíbem).
6. **Mínimo de dados.** Só o contexto do projeto do dono, dentro do escopo aprovado; dados privados não vão a serviços gratuitos (D4). Desativar o treinamento não basta para enviar dados privados (§3.8).
7. **Custo zero por padrão.** `metered_api` só com orçamento aprovado; hoje é R$ 0, logo bloqueado.

## 3. Matriz dos provedores

### 3.1 Método

- Somente documentação **oficial e pública** de cada provedor (domínios próprios). Fóruns, blogs e notícias **não** servem como prova.
- Sem criar contas, sem credenciais, sem chamadas de API.
- Cada célula cita um identificador de fonte (seção 15). Sem fonte oficial → **"não comprovado"**.
- Quando a página oficial não pôde ser lida diretamente (HTTP 403) e o conteúdo veio do resultado de busca restrita ao domínio oficial, a fonte é marcada **(B)** = confiança média; leitura direta = **(D)** = confiança alta. Ver o registro de fontes.
- A matriz vale **na data de consulta (2026-11-18)**. Termos e preços mudam: revisar a cada 90 dias e antes de qualquer ativação.

### 3.2 Modos (de `server/limits/contracts.ts`)

| Modo | Significado no ACC |
|---|---|
| `subscription_assisted` | A pessoa usa, ela mesma, a ferramenta incluída na sua assinatura; o ACC só prepara o pacote e recebe o resultado colado (fluxo assistido, seção 8). Sem automação da interface. |
| `official_integration` | Canal oficial autorizado pelo provedor, com condições próprias (ex.: produto hospedado sob termos comerciais, assinatura empresarial). |
| `metered_api` | API com cobrança por consumo (tokens/requisições). |

### 3.3 OpenAI — ChatGPT

| Dimensão | `subscription_assisted` (ChatGPT) | `official_integration` | `metered_api` (OpenAI API) |
|---|---|---|---|
| Acesso programático / API oficial | Não: a assinatura não inclui uso da API, cobrado à parte [O5 (B)]. Termos proíbem extrair dados ou Output "automatically or programmatically" [O6 (B)]. | não comprovado | Sim: OpenAI API [O2, O3 (D)]. |
| Autenticação | Login pessoal no ChatGPT (feito pela pessoa, fora do ACC). | não comprovado | Chave de API no cabeçalho `Authorization: Bearer`; recomenda conta de serviço de projeto em vez da chave de um desenvolvedor [O2 (D)]. |
| Limites e quotas | não comprovado (limites do plano não pesquisados) | não comprovado | RPM/RPD/TPM/TPD por organização e projeto, variam por modelo; tiers Free/Build/Launch/Grow com teto mensal de uso [O1 (D)]. |
| Camada gratuita | — (plano gratuito do ChatGPT não pesquisado: não comprovado) | não comprovado | Existe tier Free com limite mensal de US$ 100, "only available to users in an allowed geography" [O1 (D)]. Elegibilidade do Brasil: **não comprovado**. |
| Custo | Assinatura (valor não verificado em fonte direta: não comprovado). | não comprovado | Por 1M tokens; ex.: gpt-5.4-mini US$ 0,75 entrada / US$ 4,50 saída [O3 (D)]. |
| Termos / automação | Automação da interface **proibida** [O6 (B)] → só uso manual pela pessoa. | não comprovado | Uso programático é o propósito da API (termos de API não lidos diretamente: confirmar antes de ativar). |
| Retenção / treinamento | Conteúdo de planos individuais pode ser usado para treinar, salvo desativação de "Improve the model for everyone"; feedback pode incluir a conversa inteira [O7 (B)]. | não comprovado | Não usado para treinar por padrão desde 2023-03-01; logs de abuso por até 30 dias; ZDR sob aprovação prévia [O4 (D)]. |
| Privacidade / localização | não comprovado | não comprovado | Há um guia de residência de dados (regiões não verificadas: não comprovado) [O4 (D)]. LGPD: não comprovado. |
| Uso assistido possível? | **Sim**, só com a pessoa usando a interface manualmente. Desativar o treinamento é recomendado, mas não basta para enviar dados privados (§3.8). | — | — |
| Restrições para produto comercial | Nenhum uso de credencial ou sessão da pessoa pelo ACC. | não comprovado | Chaves só no servidor (fora do código e do repositório) [O2 (D)]; custo exige orçamento (hoje R$ 0). |
| **Conclusão para o ACC** | Viável só como fluxo assistido manual. | Bloqueado (não comprovado). | Bloqueado: orçamento R$ 0; tier Free não presumido (D4). |

### 3.4 Anthropic — Claude / Claude Code

| Dimensão | `subscription_assisted` (Claude Pro/Max/Ultra) | `official_integration` (Claude Code em produto) | `metered_api` (Claude API) |
|---|---|---|---|
| Acesso programático / API oficial | Claude Code aceita login com assinatura Pro/Max/Ultra [A3 (D)], mas OAuth de assinatura é "intended exclusively" para uso ordinário pelos assinantes; terceiros não podem rotear requisições por credenciais Free/Pro/Max/Ultra em nome de usuários [A4 (D)]. | Rodar Claude Code em produtos ou serviços (ex.: sandboxes hospedadas) exige os Commercial Terms, binário não modificado e cada usuário final com a própria credencial; sem revender ou intermediar uso [A4 (D)]. | Sim: Claude API via Console [A1, A2 (D)]. |
| Autenticação | Login claude.ai feito pela pessoa; `claude setup-token` gera token de 1 ano ligado à assinatura [A3 (D)]. O ACC **não** pode coletar, guardar ou intermediar credenciais/tokens claude.ai [A4 (D)]. | Credencial do próprio usuário final (chave de API, assinatura ou provedor 3P) [A4 (D)]. | Chave de API do Console (`X-Api-Key`) [A3 (D)]. |
| Limites e quotas | Limites anunciados dos planos pressupõem "ordinary, individual usage" [A4 (D)]; valores: não comprovado. | não comprovado | Spend caps mensais (Start US$ 500, Build US$ 1.000, Scale US$ 200.000); RPM/ITPM/OTPM por tier; tier Evaluation inicial abaixo do padrão; ramp limits [A1 (D)]. |
| Camada gratuita | — | — | Nenhuma camada gratuita de API documentada na página: **não comprovado**. |
| Custo | Assinatura (valor não verificado: não comprovado). | Conforme a credencial do usuário final [A4 (D)]. | USD por MTok; ex.: Sonnet 5.5 US$ 2 / US$ 10; Haiku 5.5 US$ 0,10 / US$ 0,50 (≤100k tokens) [A2 (D)]. |
| Termos / automação | Consumer Terms (Free/Pro/Max/Ultra) [A4 (D)]. | Commercial Terms [A4 (D)]. | Commercial Terms [A4 (D)]; erros 429 distinguem rate limit, `enforced_spend_limit_reached` e `ramp_limit_exceeded` [A1 (D)]. |
| Retenção / treinamento | Consumidor: com opt-in de treinamento, retenção de 5 anos; sem opt-in, 30 dias [A6 (B)]. | Commercial: não se aplica a política de consumidor [A6 (B)]. | Entradas/saídas apagadas em até 30 dias; conteúdo sinalizado até 2 anos; ZDR por acordo; "Covered Models" com retenção de 30 dias desde 2026-06-09 [A5 (B)]. |
| Privacidade / localização | não comprovado | não comprovado | `inference_geo` permite inferência só nos EUA com multiplicador 1,1× [A2 (D)]. LGPD: não comprovado. |
| Uso assistido possível? | **Sim**, como uso manual pela pessoa (chat ou Claude Code local dela). | — | — |
| Restrições para produto comercial | O ACC não pode usar a assinatura do PO para atender o servidor nem guardar o token dela. | Produto hospedado exige Commercial Terms; não pode pagar ou intermediar uso dos usuários [A4 (D)]. | Uso cobrado ao dono da chave; sem revenda [A4 (D)]. |
| **Conclusão para o ACC** | Viável só como fluxo assistido manual. | **Decisão da #008/#031**: um ACC de administrador único rodando Claude Code com a credencial do próprio PO precisa de leitura jurídica de A4; até lá, bloqueado. Atualização (#008, 2026-11-19): continua bloqueado; a #008 adota só o uso assistido, ver `docs/CLAUDE_CODE_ASSISTED.md` §8. | Bloqueado: orçamento R$ 0. |

### 3.5 Google — Gemini

| Dimensão | `subscription_assisted` (Gemini app / Google AI plans) | `official_integration` (Vertex AI) | `metered_api` (Gemini API) |
|---|---|---|---|
| Acesso programático / API oficial | Não: benefícios do plano valem "only within the Google AI Studio web interface"; uso da API é cobrado e gerido à parte [G5 (D)]. | não comprovado (Vertex AI não pesquisado nesta rodada) | Sim: Gemini API [G2, G3 (D)]. |
| Autenticação | Login Google feito pela pessoa. | não comprovado | Chave de API (`x-goog-api-key`), sempre associada a um projeto Google Cloud; chaves de autorização ligadas a conta de serviço (padrão para novas chaves no AI Studio desde 2026-05-28) [G3 (D)]. |
| Limites e quotas | não comprovado | não comprovado | RPM/TPM/RPD **por projeto**; tiers Free/1/2/3; "Specified rate limits are not guaranteed" [G2 (D)]. |
| Camada gratuita | — | — | Existe tier Free, mas o conteúdo dos serviços não pagos é usado para melhorar produtos, com revisão humana, e os termos dizem "Do not submit sensitive, confidential, or personal information to the Unpaid Services" [G1, G4 (D)]. |
| Custo | Assinatura (valor não verificado: não comprovado). | não comprovado | Por 1M tokens; ex.: Gemini 3.5 Flash-Lite US$ 0,30 / US$ 2,50 [G4 (D)]. |
| Termos / automação | Termos do app Gemini não lidos diretamente: não comprovado. | não comprovado | Termos adicionais da API (vigentes desde 2026-03-23): idade mínima 18 anos; só serviços pagos para usuários no EEE, Suíça ou Reino Unido [G1 (D)]. |
| Retenção / treinamento | App Gemini: revisores humanos podem ler conversas; com atividade desligada, retenção de 72 h; conversas revisadas guardadas até 3 anos; padrão 18 meses com atividade ligada [G6 (B)]. | não comprovado | Pago: prompts e respostas **não** usados para melhorar produtos; registrados por tempo limitado para detectar abuso. Não pago: usados para melhorar produtos [G1 (D)]. |
| Privacidade / localização | não comprovado | não comprovado | não comprovado. LGPD: não comprovado. |
| Uso assistido possível? | **Sim**, manual; atenção à revisão humana e retenção [G6 (B)]: dados privados só com autorização (D4). | — | — |
| Restrições para produto comercial | — | não comprovado | Chaves fora do Git e fora do cliente; proxy no backend; Secret Manager em produção [G3 (D)]. |
| **Conclusão para o ACC** | Viável só como fluxo assistido manual. | Bloqueado (não comprovado). | Bloqueado: pago exige orçamento (R$ 0); tier Free **proibido** para dados de projetos (G1 + D4). |

### 3.6 NVIDIA — Nemotron (opcional)

| Dimensão | `subscription_assisted` | `official_integration` (assinatura / AI Enterprise) | `metered_api` (NVIDIA API Catalog, trial) |
|---|---|---|---|
| Acesso programático / API oficial | Não se aplica: o PO não tem assinatura NVIDIA (já registrado como `unknown` no catálogo). | Termos do trial exigem "separate service subscription" para produção [N1 (D)]; condições dessa assinatura: não comprovado. | Sim, para trial: endpoint `https://integrate.api.nvidia.com` com `POST /v1/chat/completions` [N6 (D)]. |
| Autenticação | — | não comprovado | Chave de API como Bearer, prefixo `nvapi-`, base `integrate.api.nvidia.com/v1` [N2 (B)]. |
| Limites e quotas | — | não comprovado | não comprovado (créditos/limites só descritos em fóruns, que não são prova). |
| Camada gratuita | — | — | Trial "for limited trial purposes only and without use of the API Service or Generated Content in production"; sem assinatura, só "internal testing and evaluation" [N1 (D)]. |
| Custo | — | não comprovado | Trial sem custo declarado; produção exige assinatura (não comprovado o valor) [N1 (D)]. |
| Termos / automação | — | não comprovado | Proíbe incluir "any confidential information … personal data"; proíbe usar para desenvolver produtos concorrentes [N1 (D)]. |
| Retenção / treinamento | — | não comprovado | NVIDIA coleta "User Content and Generated Content to improve NVIDIA products and services, including AI models"; uso registrado para segurança e abuso [N1 (D)]. |
| Privacidade / localização | — | não comprovado | não comprovado |
| Licença do modelo | — | Modelos com pesos abertos: Nemotron Open Model License permite uso comercial [N4 (B)]; algumas versões usam OpenMDW-1.1 [N4 (B)]; o modelo do trial é regido pela Nemotron Open Model License [N3 (D)]. Auto-hospedagem exige infraestrutura (custo > R$ 0). | — |
| Uso assistido possível? | Não (sem assinatura). | — | — |
| **Conclusão para o ACC** | Não aplicável. | Bloqueado (não comprovado, exige custo). | **Proibido para dados de projetos** (trial, não produção, conteúdo usado para treinar). Nemotron é **opcional**: a #028 não depende dele. |

### 3.7 Consequências consolidadas

| Provedor | `subscription_assisted` | `official_integration` | `metered_api` |
|---|---|---|---|
| ChatGPT | assistido manual | não comprovado → bloqueado | bloqueado (R$ 0) |
| Claude | assistido manual | decisão #008/#031 → bloqueado | bloqueado (R$ 0) |
| Gemini | assistido manual | não comprovado → bloqueado | bloqueado (R$ 0; Free proibido para dados privados) |
| Nemotron | não aplicável | bloqueado | trial proibido para dados de projetos |

- **Nenhum perfil muda de status neste PR.** Todos continuam `unverified`. A proposta de passar `subscription_assisted` de ChatGPT/Claude/Gemini a `available` (só para o fluxo assistido manual) fica para um PR futuro com aprovação do PO.
- Nada na matriz autoriza enviar dados privados a qualquer provedor. O envio sempre passa por `data.send_external` (seção 6).

### 3.8 Limites das garantias (leitura obrigatória da matriz)

1. **Desativar o treinamento não garante confidencialidade nem ausência de retenção.** Mesmo com o treinamento desligado, as fontes registram retenção para segurança e abuso (ex.: até 30 dias na API da OpenAI [O4]; 30 dias, ou até 2 anos se sinalizado, na Anthropic [A5]; 72 h com atividade desligada e até 3 anos para conversas revisadas no app Gemini [G6]), revisão humana em alguns serviços [G1, G6] e uso de feedback [O7]. "Sem treinamento" é só uma das condições, nunca a garantia inteira.
2. **Enviar dados privados exige avaliação e autorização.** Antes de qualquer envio, é preciso avaliar termos, retenção, revisão humana, privacidade e localização do serviço específico (muitas dessas células estão "não comprovado"), e ter **autorização explícita** de `data.send_external` dentro do escopo aprovado (§6). Sem avaliação favorável registrada, o envio é negado.
3. **O fluxo assistido depende sempre da intervenção humana.** A pessoa abre a ferramenta, cola o pacote, lê a resposta e a cola de volta. O ACC não automatiza nenhum desses passos.
4. **Nenhuma assinatura pessoal é usada pelo ACC para automatizar requisições.** Sem integração oficialmente permitida pelo provedor, o ACC não usa login, sessão, cookie, token OAuth nem credencial de assinatura de ninguém (inclusive do PO) para enviar requisições [O6, A4]. Uma integração oficial só vale depois de comprovada na matriz, aprovada pelo PO e implementada em PR próprio.
5. **Limitações ficam explícitas.** Toda célula "não comprovado" é tratada como **ausência de garantia**, nunca como permissão. Limites anunciados pelos provedores são tetos, não mínimos garantidos [A1, G2]. Nenhuma garantia de disponibilidade, privacidade, retenção ou custo é presumida além do que a fonte oficial registra na data de consulta.

## 4. Contrato comum

> Contrato implementado no PR 2 em `server/gateway/contracts.ts` (§16). `AgentTaskRequest` final não tem `mode` (vem do escopo) e o canal assistido não tem `timeoutSeconds`.

### 4.1 Identificadores

| Campo | Origem | Regra |
|---|---|---|
| `ownerId` | sessão (#003) | Nunca do chamador. |
| `projectId` | projeto do dono (#004) | UUID; o agente precisa estar atribuído (#020). |
| `taskId` | tarefa (#005) | Tarefa ativa do projeto. |
| `agentId` | `AGENT_IDS` = `chatgpt`, `claude-code`, `gemini`, `nemotron` | Lista fechada. |
| `scopeId` | escopo aprovado por tarefa (seção 6) | Obrigatório para qualquer invocação. |
| `invocationId` | servidor | UUID gerado pelo gateway. |

### 4.2 `AgentTaskRequest`

```ts
interface AgentTaskRequest {
  idempotencyKey: string;          // mesmo pedido → mesma invocação (nunca duas)
  ownerId: string; projectId: string; taskId: string; agentId: AgentRef;
  scopeId: string;                 // escopo aprovado (D3)
  capability: AgentCapability;     // ex.: 'text.review', 'text.draft', 'code.plan' — catálogo fechado
  mode: UsageMode;                 // subscription_assisted | official_integration | metered_api
  inputs: Array<{ kind: 'task' | 'issue' | 'pull_request' | 'document'; ref: string; trust: 'untrusted' }>;
  timeoutSeconds: number;          // ≤ limites da #022 e do escopo
  maxOutputBytes: number;          // teto de tamanho da saída
}
```

- `inputs` são **referências**; o conteúdo é resolvido pelo servidor dentro do escopo, sanitizado e verificado contra segredos antes de qualquer envio.
- Campos extras → recusa (`invalid_request`), como nos demais contratos do ACC.

### 4.3 `AgentTaskResult`

```ts
interface AgentTaskResult {
  invocationId: string; idempotencyKey: string;
  outcome: 'succeeded' | 'failed' | 'needs_human' | 'unavailable';
  reason: string | null;           // token da taxonomia (seção 5), nunca mensagem do provedor
  output: { kind: 'text'; bytes: number; digest: string; trust: 'untrusted' } | null;
  provenance: {
    provider: AgentRef; mode: UsageMode; adapter: { id: string; version: string; kind: 'simulated' | 'assisted' | 'official' };
    modelReported: string | null;   // o que o provedor declarou (não verificado)
    requestDigest: string; responseDigest: string | null;
    startedAt: string; finishedAt: string | null;
    relayedBy: { kind: 'human'; id: string } | null;   // fluxo assistido
  };
  usage: { cost: { kind: 'none' } | { kind: 'unknown' } | { kind: 'confirmed'; amountMinor: number }; tokens: number | null };
}
```

- `usage` reaproveita `ExecutionUsage` da #012 (`server/queue/ports.ts`).
- A saída é armazenada como dado não confiável e exibida como tal.

### 4.4 Capacidades

Cada adaptador declara capacidades num catálogo fechado e revisado como código (mesmo padrão de `POLICY_ACTIONS`). Pedir uma capacidade não declarada → `capability_unsupported`. Capacidades iniciais propostas (só simuladas): `text.review`, `text.draft`, `text.summarize`, `code.plan`. Execução de código **não** é capacidade do gateway (é do sandbox, #021/#008).

### 4.5 Idempotência

- Chave `idempotencyKey` por (dono, projeto, tarefa, agente).
- Mesma chave e mesmo corpo → mesmo resultado; mesma chave com corpo diferente → `idempotency_conflict`.
- Integração com a fila: o token de despacho da #012 (`DispatchResult`, G1) garante que o mesmo despacho nunca inicia duas vezes.

## 5. Taxonomia de erros, prazos e cancelamento

| Token | Significado | Reintento? |
|---|---|---|
| `not_started` | Comprovadamente nada foi enviado ao provedor. | Sim (via fila, item sucessor; Q6 da #012). |
| `uncertain` | Pode ter sido enviado (erro após contato, falha parcial). | **Não** (exposição de custo/dados). |
| `timeout` | Prazo esgotado após o envio. | Não (tratado como `uncertain`). |
| `rate_limited` | Provedor recusou por limite (ex.: HTTP 429 com `retry-after`). | Só depois do prazo informado e se o envio comprovadamente não ocorreu. |
| `quota_exhausted` | Teto mensal/gratuito atingido (ex.: `enforced_spend_limit_reached` [A1]). | Não; vira `ProviderQuota` na #022. |
| `provider_unavailable` | Provedor fora do ar ou modo indisponível. | Não automático; vira `ProviderUnavailability` na #022. |
| `credential_missing` | Adaptador sem credencial própria. | Não. |
| `capability_unsupported` | Capacidade não declarada. | Não. |
| `scope_exceeded` | Pedido fora do escopo aprovado (agente, dados, operação, validade, orçamento). | Não; exige nova aprovação. |
| `secret_detected` | Segredo detectado na entrada ou na saída. | Não; bloqueia e audita. |
| `output_rejected` | Saída excede tamanho ou formato. | Não. |
| `needs_human` | Fluxo assistido aguardando a pessoa. | — |

- **Prazo efetivo** = mínimo entre `timeoutSeconds`, o prazo do escopo e o prazo da admissão (#022). Implementado com `AbortSignal`.
- **Cancelamento**: o gateway pede o cancelamento ao adaptador; só é `cancelled` quando confirmado (mesma semântica do `ExecutorPort.cancel` da #012). Sem confirmação, a vaga continua ocupada (conservador).
- **Indisponibilidade** e **quotas** só restringem (nunca ampliam), reaproveitando `ProviderUnavailability`/`ProviderQuota` do controlador (#022).
- **Nemotron ausente** nunca bloqueia os demais agentes.

## 6. Autorização (D2/D3)

1. **`agent.invoke`** (nova ação, PR 2): autoriza cada invocação. Proposta: categoria `tool`, risco `medium`, `available: false` até haver adaptador aprovado; coberta pela regra A4 da política padrão (`require_approval`, `requiresAssignment`).
2. **`data.send_external`** (ação crítica existente, classe `publication` na #011): exigida sempre que conteúdo do projeto sair do ACC para um provedor, inclusive no fluxo assistido (o pacote entregue à pessoa para colar em outra ferramenta é um envio externo).
3. **Escopo por tarefa (D3)**: uma aprovação humana delimita **agente(s), projeto, dados (referências), operações (capacidades), validade e orçamento**. Qualquer ampliação → nova aprovação. As garantias de autenticidade e uso da #011 (MAC, recibo de uso único, barreira, épocas, `verifyGrant`) devem ser preservadas — ver **I1** (pendente).
4. Ordem de avaliação proposta: validação → política (#020) → escopo (#011) → barreiras/kill switch → admissão (#022) → secret scan → adaptador.
5. Agente nunca aprova, nunca amplia escopo e nunca altera política (invariantes da #020).

## 7. Credenciais e isolamento

- **Nenhuma credencial nesta fase.** Nenhuma variável de ambiente nova.
- Futuro: `CredentialProvider` por provedor; cada adaptador recebe **só** a sua credencial, já resolvida pelo servidor; adaptadores não leem `process.env` nem arquivos (teste estrutural, PR 2).
- Credenciais de assinatura de consumidor (sessões, cookies, tokens OAuth de claude.ai, ChatGPT ou Google) **nunca** são coletadas, guardadas ou usadas pelo ACC [A4, O6].
- **Isolamento entre projetos**: o contexto é resolvido só dentro do projeto do dono e do escopo; não há memória global (#030). Testes negativos de vazamento entre projetos no PR 2.
- **Prompt injection**: conteúdo de issues, PRs, tarefas e saídas de agentes é dado (`trust: 'untrusted'`). Ele nunca escolhe ferramenta, escopo, agente, destino ou política. Saída de um agente que vira entrada de outro passa de novo por todo o fluxo da seção 6.

## 8. Fluxo assistido (D5)

Núcleo na #028; experiência completa no frontend.

| Estado | Significado |
|---|---|
| `prepared` | Pacote gerado (sanitizado, sem segredos), aguardando aprovação de `data.send_external` dentro do escopo. |
| `delivered_to_human` | Pacote liberado para a pessoa autenticada copiar. |
| `awaiting_relay` | A pessoa está usando a ferramenta da própria assinatura, fora do ACC. |
| `relayed` | A pessoa colou o resultado (confirmação de identidade recente, como na #011). |
| `validated` / `rejected` | Tamanho, formato e varredura de segredos do resultado. |
| `expired` | Prazo do escopo esgotado. |

- Sem automação de navegador, sem cookies, sem extensão: a pessoa faz a ponte manualmente (exigência dos termos [O6, A4]). O fluxo **sempre** depende da intervenção humana; nenhum estado avança sozinho de `delivered_to_human` para `relayed` (§3.8).
- Liberar o pacote (`delivered_to_human`) é um envio externo: exige a avaliação e a autorização de §3.8, item 2.
- Proveniência `relayedBy` = humano autenticado; `modelReported` é o que a pessoa declarou (não verificado).
- Espera humana **não ocupa vaga automática** da fila — ver **I4** (pendente).

## 9. Fila central e executores (D6)

- Reutilizar a fila da #012 (`QueueScheduler`, ledger, admissão, idempotência por token, reintento só para `not_started`, cancelamento confirmado, barreira durável).
- Encaminhamento para executores especializados por um **executor composto** que implementa `ExecutorPort` e escolhe o executor pelo tipo do item (`sandbox` da #021 ou `gateway`). Ver **I5**.
- O gateway não importa a fila, o controlador nem o núcleo de aprovações: recebe portas injetadas (mesmo padrão de `server/limits/queueAdmission.ts` e `server/sandbox/queueExecutor.ts`). Ver **I6**.
- Antes de qualquer executor real, `onResult` precisa autenticar a origem do resultado. Ver **I8**.

## 10. Persistência (D7)

- Desde o PR 2: registros de escopo, invocações e handoffs em `server/storage/signedLedger.ts`, com subchave HKDF própria (`server/storage/subkeys.ts`, domínio proposto `acc-gateway:v1`), leituras congeladas, escritor único e barreira, como a fila da #012.
- O ledger guarda **digests** de entrada e saída e metadados. Onde o conteúdo da saída fica, e por quanto tempo, é decisão pendente (P3).

## 11. Auditoria

- Eventos só com tokens, ids e digests; nunca conteúdo, prompts, saídas, credenciais ou mensagens do provedor (regra da #006).
- Novos `AUDIT_ACTIONS` propostos para o PR 2 (ver **I7**): `gateway.scope_created`, `gateway.invocation`, `gateway.invocation_refused`, `gateway.handoff`, `gateway.result`, `gateway.provider_status`.

## 12. Incompatibilidades com o código atual (I1–I9)

> Registradas no PR 1. **Situação no PR 2** na última coluna (detalhes em §16).

| # | Incompatibilidade (evidência no código) | Proposta | Situação |
|---|---|---|---|
| **I1** | **D3 × #011.** Aprovações são de uso único (`approved → consumed`, `server/approvals/contracts.ts`) com TTL curto: `execution` 60 min; `data.send_external` é classe `publication` com 15 min. Não existe aprovação por tarefa com várias invocações e validade longa. | Consumir **uma vez** uma aprovação da #011 para criar um registro de escopo durável no ledger do gateway (digest do escopo, validade, saldo de invocações e orçamento); cada invocação é conferida contra ele. A validade do escopo além do TTL da classe exige decisão (nova classe/TTL na #011 ou escopo curto). | **Resolvido no PR 2** (§16.2), sem alterar TTLs da #011 |
| I2 | `agent.invoke` não existe em `POLICY_ACTIONS` (`shared/contracts.ts`). | Incluir no PR 2 (`tool`, `medium`, `available: false`); versão da política sobe. | Resolvido no PR 2 |
| I3 | Ação aprovável precisa de contrato de apresentação verificável (`shared/approvalPresentation.ts`); hoje só `sandbox`, `admission`, `approvals.retention_change`, `approvals.history_purge`. | Novo tipo `gateway.scope` com todos os parâmetros do escopo. | Resolvido no PR 2 |
| **I4** | **D6 × fila.** A vaga fica `held` de `admitted` até a liquidação (`QUEUE_HOLDING_STATES`); `maxDurationSeconds` = 10 min (teto 30); janela de admissão 60 s (`ADMITTED_WINDOW_MS`); a fila não tem estado de espera humana (`QUEUE_ITEM_STATES`). Um handoff de horas travaria a única vaga (`maxConcurrent = 1`). | (a) handoff fora da admissão: preparar sem vaga; ingestão do resultado como item próprio admitido; ou (b) novo estado de espera na fila que libera a vaga. | **Resolvido no PR 2** (§16.3), opção (a) |
| I5 | `ExecutorPort.kind` só aceita `'simulated'`; o agendador recebe um único executor. | Executor composto que implementa `ExecutorPort` e roteia por tipo; `scheduler.ts` inalterado. | Resolvido no PR 2 (`routingExecutor.ts`) |
| I6 | `RECEIPT_COMPONENTS` não inclui `gateway`; `security.test.ts` restringe importações de `approvals/*` a 4 arquivos e proíbe usar o controlador fora de `server/limits/`. | Portas injetadas; novos testes estruturais explícitos no PR 2. | Resolvido no PR 2 |
| I7 | `AUDIT_ACTIONS` é lista fechada. | Incluir `gateway.*` (seção 11). | Resolvido no PR 2 (eventos `gateway.*` no histórico assinado; espelho na #006 adiado) |
| I8 | `onResult` da fila não autentica a origem do resultado (resíduo da #012). | Obrigatório antes do PR de integração com a fila; no fluxo assistido, autenticação humana com confirmação de identidade. | Resolvido no PR 2 para o gateway (§16.5); sandbox residual |
| I9 | Orçamento R$ 0: o orçamento do escopo (D3) não pode exceder o do controlador. | Na prática, só modos com custo `none`. | Registrado |

## 13. Plano de testes (PR 2 em diante)

Critério 4 da issue (indisponibilidade, limite gratuito, falhas, sem acesso cruzado a credenciais) e demais:

1. Envelope inválido, campos extras, capacidade não declarada → recusa.
2. Idempotência: mesma chave → mesmo resultado; corpo diferente → `idempotency_conflict`.
3. Agente não atribuído → negado (#020); agente tentando aprovar/ampliar escopo → negado.
4. Sem escopo, escopo expirado, escopo ampliado (agente, dado, operação, orçamento) → `scope_exceeded`.
5. Barreira global/projeto e kill switch → bloqueio antes do adaptador.
6. `metered_api` com orçamento R$ 0 → recusado pela admissão.
7. Indisponibilidade simulada → `provider_unavailable` e restrição registrada na #022.
8. Limite gratuito/quota esgotada simulados → `quota_exhausted`, sem reintento.
9. Rate limit com `retry-after` → espera; sem duplicar envio.
10. Timeout após envio → `uncertain`, sem reintento.
11. Cancelamento confirmado × não confirmado (vaga mantida).
12. Nemotron ausente/indisponível não afeta os demais agentes.
13. Acesso cruzado: adaptador A nunca recebe credencial de B (teste negativo); adaptadores sem `process.env`/`fs`/rede (estrutural).
14. Isolamento: contexto de outro projeto nunca entra no pacote (teste negativo).
15. Segredo na entrada ou na saída → `secret_detected`, nada enviado/armazenado.
16. Saída com "instruções" (prompt injection) não altera política, escopo nem destino.
17. Fluxo assistido: transições válidas/inválidas, expiração, `relayed` exige confirmação de identidade.
18. Ledger: integridade (MAC), reinício, leituras congeladas.
19. Estruturais: gateway fora de `index.ts`, sem rota, sem rede, sem subprocesso; `REAL_EXECUTION_ENABLED` continua `false`.

## 14. Divisão em PRs, decisões D1–D9 e pendências

### 14.1 PRs

| PR | Escopo | Estado |
|---|---|---|
| **PR 1** | Esta especificação + matriz (somente `docs/`). | Este PR |
| PR 2 | Núcleo dormente `server/gateway/`: contratos, validação, adaptadores simulados, escopo (após I1), ledger (D7), auditoria, testes da seção 13. | Não autorizado |
| PR 3 | Núcleo do fluxo assistido persistido e rotas mínimas protegidas (após I4). | Não autorizado |
| PR 4 | Executor composto na fila + autenticação de `onResult` (I5, I8). | Não autorizado |

### 14.2 Decisões aprovadas pelo PO

| # | Decisão | Onde se aplica |
|---|---|---|
| D1 | A #028 entrega contratos, adaptadores simulados e núcleo do fluxo assistido; nenhum provedor real ativado. | §1, §3.7 |
| D2 | `agent.invoke` autoriza invocações; `data.send_external` autoriza compartilhamentos externos, com permissões próprias. | §6 |
| D3 | Aprovação por tarefa, delimitando agente, projeto, dados, operações, validade e orçamento; ampliação exige nova aprovação; respeita autenticidade e uso da #011. | §6, I1 |
| D4 | Não presumir disponibilidade ou segurança de serviços gratuitos; não transmitir dados privados sem garantias adequadas e autorização. | §3 (G1, N1, O1), §2 |
| D5 | Núcleo do fluxo assistido na #028; experiência completa no frontend. | §8 |
| D6 | Reutilizar a fila central da #012 com encaminhamento a executores especializados; espera humana não ocupa vagas automáticas. | §9, I4, I5 |
| D7 | `signedLedger` desde o PR 2. | §10 |
| D8 | Auditar os critérios de aceite das #020 e #022 antes de recomendar encerramento. | §14.3 |
| D9 | Implementação iniciada por um PR só de documentação. | Este PR |

### 14.3 Auditoria documental de #020 e #022 (D8)

Ambas permanecem **abertas**. Nenhum trabalho corretivo foi iniciado.

**#020 — Política de autonomia**

| Critério | Situação | Evidência |
|---|---|---|
| Negado por padrão, validado no servidor antes de cada ação | Atendido | `server/policy/engine.ts`, `DEFAULT_POLICY` |
| Políticas por projeto/agente com risco baixo/médio/alto; sensíveis exigem aprovação | **Parcial**: regras por tipo de sujeito e risco; a política é global, **sem regras específicas por projeto** | `server/policy/defaultPolicy.ts` |
| Proibido alterar main, merge, deploy ou ampliar permissões sem autorização | Atendido | regra fixa `repo.push_main`; ações críticas `require_approval` |
| Propostas ≠ autorização; aprovações com escopo, versão e validade | Atendido (via #011) | `server/approvals/` (binding com `policyVersion`, TTL) |
| Agentes não alteram políticas; auditoria e testes de negação | Atendido | invariantes do motor; testes |
| Diretriz V2: permissões verificadas antes de enviar contexto a provedores | **Pendente**: depende de `agent.invoke`/`data.send_external` no gateway (#028) | §6 |

**#022 — Orçamento, quotas e kill switch**

| Critério | Situação | Evidência |
|---|---|---|
| Limites padrão conservadores; sem orçamento, sem execução paga | Atendido | `DEFAULT_LIMITS` (orçamento 0) |
| Orçamento estimado × gasto observado; **alertas** e bloqueios testados | **Parcial**: estimado/confirmado e bloqueios existem; alertas são só registros `cost_alert` internos, sem aviso ao usuário | `server/limits/controller.ts` |
| Kill switch global e por projeto | Atendido (em memória + barreira durável da #011) | controller; `server/queue/barrierGate.ts` |
| Timeout, concorrência, **retry/backoff** e rate limit configuráveis | **Parcial**: retry/backoff são constantes fixas | `server/queue/contracts.ts` (`RETRY_BASE_MS`, `RETRY_CAP_MS`, `MAX_CHAIN_ATTEMPTS`) |
| Custos e decisões rastreáveis sem precisão inventada | Atendido | `CostStatus` `unknown`/`none` |
| (Resíduo da #012) **persistência dos limites** | **Pendente**: limites personalizados não persistem | IMPLEMENTATION_REPORT_012_PR2 §11 |

### 14.4 Pendências

- **P1 (I1)** e **P2 (I4)**: decisões técnicas antes do PR 2.
- **P3**: onde e por quanto tempo guardar o conteúdo das saídas (o ledger guarda só digests).
- **P4**: leitura jurídica de [A4] para o caso Claude Code + credencial do próprio PO (#008/#031).
- **P5**: elegibilidade do Brasil e condições do tier Free da OpenAI [O1]; não usar até verificação (D4).
- **P6**: Vertex AI, assinatura NVIDIA e integrações oficiais da OpenAI: não pesquisadas ("não comprovado").
- **P7**: fontes marcadas (B) devem ser relidas diretamente antes de qualquer ativação.
- **P8**: revisão da matriz a cada 90 dias (próxima até 2027-02-16).

## 15. Registro de fontes

Consultadas em **2026-11-18**. (D) = leitura direta da página oficial; (B) = conteúdo obtido pelo resultado de busca restrita ao domínio oficial porque a leitura direta falhou (HTTP 403) ou não foi feita. Detalhes, citações curtas e conclusões em `docs/evidence/issue028-pr1-sources.txt`.

| ID | Fonte oficial | Tipo |
|---|---|---|
| O1 | https://developers.openai.com/api/docs/guides/rate-limits | D |
| O2 | https://developers.openai.com/api/docs/guides/production-best-practices | D |
| O3 | https://developers.openai.com/api/docs/pricing | D |
| O4 | https://developers.openai.com/api/docs/guides/your-data | D |
| O5 | https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus ; https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform | B |
| O6 | https://openai.com/policies/row-terms-of-use/ | B |
| O7 | https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt ; https://help.openai.com/en/articles/5722486-how-your-data-is-used-to-improve-model-performance | B |
| A1 | https://platform.claude.com/docs/en/api/rate-limits | D |
| A2 | https://platform.claude.com/docs/en/about-claude/pricing | D |
| A3 | https://code.claude.com/docs/en/iam | D |
| A4 | https://code.claude.com/docs/en/legal-and-compliance | D |
| A5 | https://platform.claude.com/docs/en/manage-claude/api-and-data-retention ; https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data | B |
| A6 | https://www.anthropic.com/news/updates-to-our-consumer-terms ; https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data | B |
| G1 | https://aistudio.google.com/docs/terms (redirecionado de ai.google.dev/gemini-api/terms) | D |
| G2 | https://aistudio.google.com/docs/rate-limits | D |
| G3 | https://aistudio.google.com/docs/api-key | D |
| G4 | https://aistudio.google.com/docs/pricing | D |
| G5 | https://aistudio.google.com/docs/google-ai-plans | D |
| G6 | https://support.google.com/gemini/answer/13594961 (Gemini Apps Privacy Hub) | B |
| N1 | https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf | D |
| N2 | https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/apireference ; https://docs.nvidia.com/nemo/retriever/26.8.1/extraction/api-keys/ | B |
| N3 | https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b | D |
| N4 | https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/ | B |
| N6 | https://docs.api.nvidia.com/nim/reference/llm-apis | D |

Fontes **não** usadas como prova: fóruns de desenvolvedores (OpenAI Community, NVIDIA Developer Forums, Google AI Developers Forum), mesmo quando apareceram nas buscas.

## 16. Implementação (Issue #028, PR 2 — núcleo dormente e simulado)

> Implementado em `server/gateway/` e `server/storage/sealedBlobs.ts`. **Dormente**: nada é ligado no
> `server/index.ts`, não há rota HTTP, provedores reais, credenciais nem rede. `agent.invoke` e
> `data.send_external` continuam `available: false` no catálogo real, então em produção toda operação
> do gateway é recusada (`capability_unavailable`). Os testes usam um catálogo próprio.

### 16.1 Componentes

| Arquivo | Papel |
|---|---|
| `server/gateway/contracts.ts` | Tipos: `AgentTaskRequest`, `AgentTaskResult`, `ProviderAdapter`, `AgentCapability`, `GatewayScope`, `GatewayInvocation`, `GatewayHandoff`, `GatewayProvenance`, `GatewayContentRef`; estados, transições e limites. |
| `server/gateway/documents.ts` | Validação estrita do ledger e das entradas do histórico; transições e campos imutáveis entre versões. |
| `server/gateway/store.ts` | Ledger assinado próprio (`acc-gateway:v1`, subchave HKDF `acc:gateway:mac:v1`); ajustes conservadores no reinício. |
| `server/gateway/content.ts` | Conteúdos (P3): referência no ledger, isolamento, retenção, exclusão e varredura de órfãos. |
| `server/storage/sealedBlobs.ts` | Primitiva genérica de conteúdo cifrado (AES-256-GCM, subchave `acc:gateway:content:v1`, AAD com id, dono, projeto e tipo). |
| `server/gateway/secretScan.ts` | Detecção de segredos (entrada, pacote, saída e resultado trazido). |
| `server/gateway/adapters.ts` | Adaptadores **simulados** de ChatGPT, Claude, Gemini e Nemotron (Nemotron `required: false`). |
| `server/gateway/service.ts` | Serviço: escopos (I1), invocações (D6), fluxo assistido (D5/I4), resultados, varredura e o executor da fila (I8). |
| `server/gateway/routingExecutor.ts` | Executor composto: um `ExecutorPort` que encaminha por tipo (`execution.executor === 'gateway'` → gateway; senão sandbox). |

Alterações mínimas fora do módulo (todas cobertas por testes):

- `shared/contracts.ts`: ação `agent.invoke` (`tool`, `medium`, não crítica, `available: false`); política `2026-11-19.1`.
- `shared/approvalPresentation.ts`: apresentação `gateway.scope` (formato fechado; só o componente `gateway` a apresenta; vínculo aponta para o próprio escopo, `resource.type = 'gateway_scope'`).
- `server/approvals/contracts.ts`: componente de recibo `gateway`. Nenhum TTL, classe ou regra de consumo mudou.
- `server/queue/ports.ts` e `server/queue/scheduler.ts`: prova de origem opcional (`proof`) e `verifyResult` (I8). Executor sem `verifyResult` mantém o comportamento da #012.
- `src/features/approvals/ApprovalsPage.tsx`: exibição somente leitura dos parâmetros de `gateway.scope`. `src/features/policy/PolicyPage.tsx`: rótulo de `agent.invoke`.

### 16.2 I1 — escopo por tarefa (resolvido sem alterar a #011)

1. `requestScope`: valida o pedido (formato fechado), projeto, tarefa ativa, agente atribuído, adaptador e operações; pré-avalia a política (DENY/UNAVAILABLE recusam); registra no núcleo **um pedido por ação** (`agent.invoke`; e `data.send_external` no canal assistido) com a apresentação completa; grava o escopo `awaiting_approval`.
2. `activateScope` (protocolo durável): pedidos ainda pendentes → `approval_pending` (nada consumido); intenção `activating` gravada; **reserva** de cada aprovação (consumo de uso único, componente `gateway`); política avaliada **com** o grant; origem verificada pelo recibo (`verifierFor('gateway')`), aprovador humano autenticado; escopo `active` gravado; tentativas `succeeded`. Qualquer falha → `failed` e tentativas `failed` (aprovação continua consumida). Reinício no meio → `activating` vira `failed` (`activation_interrupted`).
3. **Validade efetiva = mínimo entre a pedida e a das aprovações originais.** Canal simulado: até 60 min (classe `execution`). Canal assistido: até **15 min** (classe `publication` de `data.send_external`). Nenhum TTL global foi aumentado.
4. Cada uso confere o escopo: estado, validade (relógio do sistema + prazo monotônico no processo + detecção de relógio voltando), versão da política, canal, agente, operação, dados, tamanho, número de invocações, barreira/kill switch, tarefa ativa e atribuída, e a política (DENY/UNAVAILABLE recusam).
5. Revogação (`revokeScope`, com confirmação de identidade), kill switch (`engageKillSwitch`) e custo inesperado revogam o escopo e encerram o que depende dele.

### 16.3 I4 — espera humana fora da vaga (resolvido)

`prepareHandoff` → `releaseHandoff` (confirmação de identidade; envio externo dentro da validade do escopo) → `awaiting_relay` (**nenhum item na fila**) → `relayResult` (confirmação de identidade; janela de 24 h; escopo não revogado; sem barreira; tamanho e segredos) → item de **ingestão** na fila (admissão própria da #022, 60 s) → `validated`. Teste: com `maxConcurrent = 1`, uma espera de 5 h não impede outra tarefa de rodar até o fim.

### 16.4 P3 — armazenamento dos resultados (resolvido)

Conteúdo cifrado (AES-256-GCM), id opaco, AAD presa a id, dono, projeto, tipo e origem; resumo SHA-256 e tamanho no ledger; leitura só pelo mesmo dono e projeto; vencido, excluído, ausente ou adulterado → recusado por token; retenção padrão de 30 dias (1–90, configurável na criação); varredura de vencidos e órfãos; exclusão controlada com confirmação de identidade; nada com aparência de segredo é armazenado; ledger e histórico guardam só ids, tokens e resumos.

### 16.5 D6/I8 — fila central

Invocações simuladas e ingestões são itens da fila da #012 (mesmo agendador, mesma admissão da #022, mesma idempotência e liquidação). O executor do gateway: `not_started` comprovado só antes de qualquer envio (indisponível, rate limit, quota, escopo inválido); depois do envio, tudo é definitivo ou **incerto** (timeout → `uncertain`, sem reintento); cancelamento só `cancelled` quando o adaptador confirma; resultados com prova HMAC (chave só em memória) entregues por `drain()` depois do ciclo que registrou o início. A fila recusa resultado sem prova válida (`result_unauthenticated`).

### 16.6 Limitações residuais

1. **Aprovação de admissão por item continua existindo (mantida de propósito, R3).** O escopo substitui a aprovação de execução, mas cada invocação/ingestão ainda passa pela aprovação própria do controlador (#022, Q3 da #012). O controlador, sua política e suas permissões **não** foram alterados. Uma integração futura com aprovações de PLANOS poderá eliminar a necessidade de uma nova aprovação HUMANA a cada invocação — mas **nunca** a validação de admissão do controlador (limites, concorrência, orçamento, kill switch e quotas continuam conferidos item a item).
2. Escopos curtos por construção (60 min simulado, 15 min assistido) — ampliar exige decisão sobre os TTLs da #011.
3. A janela de retorno (24 h) é fixa; trazer o resultado não renova nenhuma autorização de envio.
4. Dormente: sem ligação no `index.ts`, sem rotas e sem UI do fluxo assistido (só a exibição da aprovação). O hospedeiro precisa chamar `drain()` depois de `tick()`.
5. O sandbox simulado (#021) ainda não emite prova de origem (resíduo da #012): o executor composto mantém, para ele, o vínculo por token/tentativa/época.
6. Um escopo ativo **não** atravessa um reinício (R1): na época nova ele vence (`restart_closed`), como as aprovações concedidas da #011. Pacotes ainda não liberados vencem junto; o resultado de um pacote já liberado ainda pode voltar dentro da janela própria.
7. O contador de invocações do escopo não é devolvido para invocações nunca despachadas (conservador).
8. A detecção de segredos é por padrões (não exaustiva).
9. Rotação da chave de conteúdo não implementada (subchave derivada da chave principal existente).
10. A auditoria do gateway fica no histórico assinado próprio (`gateway.*`); o espelho em `/api/audit` (#006) fica para quando houver ligação.
11. A versão da política mudou (`2026-11-19.1`): pedidos de aprovação pendentes da versão anterior precisam ser refeitos.
12. Um agente por escopo (o motor da #020 exige uma única atribuição por tarefa).
13. `metered_api` recusado (`paid_usage_unavailable`) e Nemotron sempre bloqueado pelo controlador (custo `unknown`).

### 16.7 Revisão complementar do PR #48 (R1–R3)

- **R1 — falha de persistência na ativação.** Confirmado por teste de injeção de falha: se a gravação do escopo `active` chegava ao ledger mas falhava no anchor, a recuperação (`failed`) também falhava (armazenamento degradado) e, na reabertura, o ledger uma geração à frente do anchor é aceito — o escopo voltava **ativo** embora a ativação tivesse sido informada como falha. Correção: na abertura de cada época, escopos `active`/`exhausted` vencem (`restart_closed`); invocações ainda na fila desses escopos são recusadas e pacotes não liberados vencem. Durante o processo, o estado nunca fica usável (`activating` ou armazenamento degradado). Aprovações continuam consumidas (sem reutilização); nenhum TTL ou contrato da #011 mudou.
- **R2 — referências retidas.** Confirmado: o executor composto só esquecia o item no descarte e nunca esquecia tokens; o executor do gateway acumulava memória de despacho, provas e resultados. Correção: ciclo de vida definido — o item é esquecido na hora no despacho não iniciado, no cancelamento confirmado e no descarte; tokens ficam só pela retenção de 24 h (para reconhecer a repetição de um resultado legítimo) e depois são descartados; teto de 10 000 entradas no executor composto. A verificação de origem continua recusando resultados forjados; um resultado depois da retenção é recusado como não autenticado.
- **R3 — dependência da #022.** Mantida exatamente como está (item 1 de §16.6).
