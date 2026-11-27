# Ponte MCP local entre o ACC e o Claude Code (Issue #055)

> **Status: IMPLEMENTADA (PR único, em draft). Exercício real pendente de autorização separada do PO.**
> - Objetivo: acabar com a transferência MANUAL de pacotes e de referências de PR entre o ACC e o Claude Code.
> - O ACC **não executa** o Claude Code nem nenhum agente. A sessão é aberta pelo PO, com a própria assinatura, no binário oficial da Anthropic (CLI ou Desktop). O ACC só disponibiliza a ordem e registra o que o agente propõe.
> - Nenhuma credencial da Anthropic é coletada, guardada ou intermediada pelo ACC. A credencial da ponte é LOCAL, do próprio ACC.
> - `REAL_EXECUTION_ENABLED = false` (inalterado). Gates #020/#021/#022 preservados. Orçamento adicional: **R$ 0**.
> - Base: `main` `6d21973338984fc360731f40100b20c2d5969d33`. Fontes oficiais consultadas em **2026-11-27** (§11).

## 1. Decisões do PO (Fase 0, 2026-11-27)

| Id | Decisão |
|---|---|
| D-B1 | Nesta entrega, o PO ainda abre a sessão do Claude Code. Channels e tarefas agendadas do Desktop ficam para uma issue futura. |
| D-B2 | O fluxo manual (copiar e colar) continua, só como **contingência**. |
| D-B3 | SDK oficial do MCP, versão estável, fixada no lockfile, depois de avaliar dependências e vulnerabilidades (§9). |

## 2. Arquitetura

```
PO (navegador, sessão #003)                       PO abre o Claude Code (CLI/Desktop) com a PRÓPRIA assinatura
  │ cria a credencial da ponte (#011 + step-up)     │  /mcp__acc__next  (prompt MCP)
  │ aprova a ordem (#011)                           ▼
  │ "Disponibilizar ao Claude Code" (step-up)   Claude Code ──HTTP 127.0.0.1──► POST /mcp
  │ confirma o PR PROPOSTO (step-up)                         Authorization: Bearer accb_…
  ▼                                                         │
┌────────────────────────── ACC (um processo, um listener loopback) ──────────────────────────┐
│ /api/... (sessão + CSRF)            /mcp (pipeline PRÓPRIO: método → Host → Origin → bloqueio  │
│   claudeOrderRoutes                  → tipo → credencial → limite → corpo → SDK MCP sem estado) │
│        │                                   │                                                  │
│        └──► orders.ts (PO) ◄──── bridge.ts (agente) ◄──┘                                       │
│                 │                                                                              │
│                 └──► gateway/service.ts (canal assisted): política #020, barreira/kill switch  │
│                      #011, perfil #022, tarefa atribuída; ledger ASSINADO, somente acréscimo:  │
│                      bridgeCredentials · bridgeRevocations · orderDeliveries · prProposals     │
│ Verificador de PR (somente leitura, V1–V13) inalterado · Auditoria #006 (espelho)             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Por que um endpoint no servidor existente, e não um processo stdio:

- **Lock de instância:** o lock (`acc-instance.lock`) impede um segundo processo de abrir os armazenamentos. Uma ponte stdio teria de falar com o servidor por HTTP de qualquer forma.
- **Sem porta nova:** um único processo, sem porta nova e sem cópia de estado.
- **Fora do proxy do navegador:** a rota fica fora de `/api`, então o proxy do Vite nunca a encaminha a partir do navegador.

## 3. Fluxo operacional

| # | Quem | Onde | O que acontece |
|---|---|---|---|
| 0 | PO, uma vez | terminal + painel | `ACC_BRIDGE_ENABLED=true` (com `ACC_DEPLOYMENT=local`). Em seguida: **Criar a credencial da ponte** (senha), copiar o comando exibido UMA vez e rodá-lo na pasta do repositório. |
| 1 | PO | painel | Cria a ordem e aprova as duas solicitações (#011), como na #008. |
| 2 | PO | painel | **Disponibilizar ao Claude Code** (senha). O pacote é liberado só para o canal da ponte e não aparece no navegador. |
| 3 | PO | Claude Code | Abre a sessão no repositório e digita `/mcp__acc__next`. |
| 4 | Claude Code | `/mcp` | `acc_list_orders` → `acc_claim_order`. O recebimento é gravado antes do pacote ser devolvido e marca a ordem como encaminhada. |
| 5 | Claude Code | GitHub + `/mcp` | Trabalha na `workBranch`, abre o PR e chama `acc_report_pr`. É uma **proposta**: nada é vinculado. |
| 6 | PO | painel | **Confirmar o PR proposto e verificar** (senha): vincula o PR e, na mesma ação, roda a verificação somente leitura (V1–V13). |
| 7 | Claude Code | `/mcp` | `acc_get_order_status` mostra o resultado (para o HEAD lido). |

Ao PO restam três cliques com senha (passos 2 e 6, mais a aprovação da #011) e a abertura da sessão (passo 3). Copiar o pacote, colar o pacote, marcar como encaminhado e digitar a referência do PR deixam de existir.

**Prazos:**

- **Recebimento:** dentro da validade efetiva do escopo, que é o menor prazo das aprovações (15 min de publicação, inalterado).
- **Proposta e confirmação do PR:** dentro da janela de retorno de 24 h (inalterada).

## 4. Configuração

1. No `.env.local` do PO (fora do Git): `ACC_BRIDGE_ENABLED=true` e `ACC_DEPLOYMENT=local`.
   - Qualquer outro valor é recusado na inicialização.
   - `true` sem `ACC_DEPLOYMENT=local` também é recusado.
   - O host já é sempre loopback.
2. No painel (projeto habilitado para o Claude Code), **Criar a credencial da ponte**: validade de 1, 7 ou 30 dias, mais a senha. O painel mostra uma única vez o comando montado pelo servidor:

   ```
   claude mcp add --transport http --scope local acc http://127.0.0.1:<porta>/mcp --header "Authorization: Bearer <token>"
   ```

   - Escopo `local`: a configuração fica no perfil do PO (`~/.claude.json`, entrada da pasta do projeto). **Nunca use `--scope project`**: geraria um `.mcp.json` versionável, e o repositório é público. Um teste estrutural recusa `.mcp.json` na raiz.
   - `claude mcp get acc` exibe o cabeçalho com o token em claro no terminal. Use com cuidado e não cole a saída em lugar nenhum.
3. Permissões do Claude Code (opcional): liberar `mcp__acc__acc_list_orders` e `mcp__acc__acc_get_order_status` evita perguntas nas leituras. As gravações (`acc_claim_order` e `acc_report_pr`) podem continuar perguntando. Os gates humanos ficam no ACC de qualquer forma.
4. Para **revogar** (senha), use o painel. Para **trocar**, crie uma credencial nova: ela revoga a anterior. Desabilitar o projeto também revoga as credenciais dele.

## 5. Contratos das ferramentas MCP

As entradas são validadas duas vezes:

- **esquema fechado** do SDK (`additionalProperties: false`);
- **validação estrita** no gateway.

Dono, projeto e agente vêm SEMPRE da credencial, nunca dos argumentos. As falhas são resultados de ferramenta (`isError: true`) com um código fixo `{"error":"<código>"}`, sem detalhes internos.

| Ferramenta | Entrada | Saída | Regras |
|---|---|---|---|
| `acc_list_orders` | `{}` | `{orders:[{orderId, repository, baseSha, workBranch, claimableUntil, prDeadline, claimed, claimId, blocked}]}` | Só ordens disponibilizadas no projeto da credencial, aguardando PR e não recebidas por outra credencial. **Nunca o pacote.** `blocked` traz o motivo de um gate vivo. |
| `acc_claim_order` | `{orderId, idempotencyKey}` | 1º bloco: `{claimId, replay, order:{…}, instructions}`; 2º bloco: o **pacote** (texto) | Um recebimento por ordem, gravado ANTES de devolver o pacote. A mesma credencial, a mesma chave e o mesmo pedido, dentro de 15 min e da validade do escopo, devolvem o mesmo recebimento (`replay: true`). Outra chave ou outra credencial → `already_claimed`. A mesma chave com outro pedido → `idempotency_conflict`. |
| `acc_report_pr` | `{orderId, claimId, pullRequest:"owner/repo#N", idempotencyKey}` | `{proposalId, pullRequest, status:"awaiting_owner_confirmation", replay, notice}` | Exige o recebimento DESTA credencial. Só aceita o repositório da ordem: outro repositório é só recusado, sem encerrar a ordem. Até 5 propostas; a mais recente vale. **Nunca vincula.** |
| `acc_get_order_status` | `{orderId}` | `{state, stateReason, claimId, blocked, prDeadline, proposal, pullRequest, verification:{seq, verdict, headSha, checkedAt, current, staleReason, attention[]}}` | Somente leitura; não aciona o GitHub. A conformidade vale para o `headSha` lido (`current`). |
| Prompt `next` | — | instrução fixa (código revisado, sem dados) | Listar, receber, trabalhar só na branch designada, abrir o PR, propor e avisar o PO. |

**Códigos entregues ao agente:**

- recusas da ordem: `not_found`, `already_claimed`, `claim_replay_expired`, `idempotency_conflict`, `claim_invalid`, `order_closed`, `order_expired`, `claim_window_elapsed`;
- recusas do PR proposto: `pr_reference_invalid`, `repository_not_allowed`, `secret_detected`, `proposal_limit`, `pr_already_linked`;
- recusas de política e entrada: `invalid_arguments`, `project_not_enabled`, `task_not_active`, `policy_denied`;
- situação do ACC: `blocked` (barreira ou kill switch), `unauthorized`, `unavailable`, `internal`.

**Rotas administrativas novas** (sessão + CSRF + política; todas com step-up):

| Rota | Corpo | Efeito |
|---|---|---|
| `POST /api/claude-orders/:orderId/offer` | `{proofId}` | Disponibiliza a ordem à ponte (consome as aprovações se preciso). |
| `POST /api/claude-orders/:orderId/confirm-pr` | `{proposalId, proofId}` | Vincula a proposta MAIS RECENTE e verifica. Resposta: `{order, outcome, verificationError}`. |
| `POST /api/projects/:id/claude-bridge/credentials` | `{validityDays, proofId}` | Cria a credencial (aprovação de configuração #011). O token e o comando saem só nesta resposta. |
| `POST /api/projects/:id/claude-bridge/credentials/:credentialId/revoke` | `{proofId}` | Revoga na hora. |

A listagem `GET /api/projects/:id/claude-orders` passa a trazer:

- `bridge: {enabled, endpoint, credential}`, sem o token;
- em cada ordem, `bridge: {offeredAt, claim, proposal, proposals, maxProposals}`.

## 6. Modelo de segurança

**Pipeline do `/mcp`** (`server/http/mcpBridge.ts`), nesta ordem:

| # | Etapa | Resposta em caso de falha |
|---|---|---|
| 1 | Ponte desligada | 404 |
| 2 | Método diferente de `POST` | 405 |
| 3 | `Host` diferente de `127.0.0.1:porta`, `localhost:porta` ou `[::1]:porta` | 403 (DNS rebinding) |
| 4 | **Qualquer** `Origin` ou `Sec-Fetch-*` presente | 403 (o Claude Code não os envia; navegadores sim) |
| 5 | Bloqueio temporário: 10 falhas de autenticação em 5 min, todas as credenciais | 429 |
| 6 | `Content-Type` diferente de `application/json` | 415 |
| 7 | `MCP-Protocol-Version` malformado | 400 |
| 8 | `Authorization: Bearer accb_…` sem formato exato ou sem credencial ativa (busca pelo SHA-256) | 401 |
| 9 | Mais de 60 requisições/min por credencial | 429 |
| 10 | Corpo maior que 16 KiB | 413 |
| 11 | Lote JSON-RPC ou JSON inválido | 400 |
| 12 | SDK: versão de protocolo não suportada | 400 |
| 13 | SDK: resposta maior que 512 KiB | 500 |
| — | Query string | 400 (recusada no `app.ts`) |

**Separação das autenticações:**

- o `/mcp` nunca lê cookie nem sessão do administrador;
- as rotas administrativas nunca leem o cabeçalho `Authorization`;
- ambos os pontos têm testes estruturais e de ponta a ponta.

**Credencial:**

- 32 bytes aleatórios em base64url com o prefixo `accb_`;
- o ledger guarda só o SHA-256 do token;
- presa a projeto e ao agente `claude-code`;
- validade de 1 a 30 dias, imutável;
- revogação como registro próprio, somente de acréscimo;
- relógio voltado para antes da criação → recusada.

A criação exige uma **aprovação de configuração da #011** (`gateway.claude_bridge_credential`: 15 min, step-up, uso único). Ela é presa ao projeto, à credencial, ao agente, à validade e ao **resumo do token**, é reservada para o componente `gateway` e conferida pelo verificador confiável. Essa é a "configuração autorizada" exigida.

**Replay e idempotência:**

- `keyDigest = SHA-256(operação, credencial, chave)` e `requestDigest = SHA-256(pedido canônico)`;
- o recebimento é único por ordem;
- a repetição só vale com a MESMA credencial, chave e pedido, em até 15 min e dentro da validade do escopo;
- o relato do PR exige o `claimId` da própria credencial.

**Concorrência:**

- Todas as operações que gravam passam pela fila serial do gateway, e dentro da transação a credencial e o estado são revalidados.
- Disponibilizar (ponte) e liberar (manual) são **mutuamente exclusivos**: `delivery_channel_bridge` / `delivery_channel_manual`. A ativação concorrente do escopo é tolerada, e o canal é decidido dentro da fila.
- Revogação e recebimento também são serializados. Revogada antes, nenhum pacote sai; revogada depois, a repetição é recusada.

**Gates em toda operação do agente, inclusive na repetição:**

- escopo não revogado;
- barreira e kill switch (#011);
- perfil `claude-code/subscription_assisted` (#022) e habilitação do projeto;
- tarefa ativa e atribuída ao agente;
- política (#020, exceção assistida fechada);
- validade do escopo (no recebimento) e janela do PR (na proposta).

**Vínculo humano:**

- só `confirmProposal`, com step-up e só da proposta mais recente, vincula o PR;
- ele usa o MESMO núcleo do vínculo manual (`linkCore`);
- a verificação fica presa ao HEAD efetivamente lido (V12 e histórico por `headSha`, inalterados).

**Sem vazamentos:**

- token, corpo e pacote nunca vão para log nem auditoria;
- o pacote só sai no `acc_claim_order`, depois do recebimento gravado;
- os scanners de segredo, do repositório e do gateway, reconhecem o formato `accb_`.

**Auditoria:**

- O ledger assinado do gateway registra `gateway.bridge_credential_created/_revoked`, `gateway.order_offered`, `gateway.order_claimed` e `gateway.pr_proposed`.
- O espelho na #006 registra:
  - `claude_order.offered/claimed/pr_proposed/pr_confirmed`;
  - `claude_bridge.credential`;
  - `claude_bridge.access` (recusas de acesso).
- O agente aparece como `{kind:'agent', id:'claude-code'}` e a credencial só pelo id.

**Risco residual:**

- Um processo malicioso rodando com o MESMO usuário do Windows consegue ler o token em `~/.claude.json`. É o mesmo risco que já existe com o token do `gh`, e fica fora do modelo de ameaça. A validade curta, a revogação, o bloqueio por falhas e os gates do ACC limitam o estrago.
- A comparação pelo SHA-256 não é feita em tempo constante: ela só revela prefixos do resumo, não do token.

## 7. Impactos no que já existia

| Área | Impacto |
|---|---|
| `REAL_EXECUTION_ENABLED`, gates #020/#021/#022, `HANDOFF_TRANSITIONS`, TTLs da #011, orçamento | **Inalterados** (testes estruturais existentes continuam verdes). |
| Ledger do gateway | Quatro conjuntos novos, somente de acréscimo e validados de forma estrita. Ledgers antigos continuam válidos. |
| `linkPullRequest` | O corpo virou `linkCore` (mesma lógica), reutilizado pela confirmação da proposta. |
| Liberação manual | Recusada para ordens disponibilizadas à ponte. Continua como contingência para as demais. |
| `disableProject` | Também revoga as credenciais da ponte do projeto. |
| #011 | Nova operação de configuração `gateway.claude_bridge_credential` (apresentação fechada e verificável). |
| `app.ts` | `/mcp` é desviado ANTES da lista de métodos, do CSRF e da sessão. Nenhuma outra rota muda. |
| Interface | Seção da ponte no painel; botões **Disponibilizar** e **Confirmar PR**; o fluxo manual vai para "Contingência". |

## 8. Limitações reais

1. **Sessão aberta pelo PO:** o PO ainda abre a sessão do Claude Code e digita `/mcp__acc__next` (D-B1). Não há disparo local oficial sem humano.
2. **Prompts de permissão** do Claude Code pausam o trabalho até alguém responder.
3. **Sem sandbox no Windows:** no Windows nativo o Claude Code roda sem sandbox [A10]. O isolamento continua pendente na #021.
4. **Sem push de eventos:** o ACC não avisa a sessão quando uma ordem fica disponível. Channels resolveriam isso, mas estão em research preview.
5. **Reinício do servidor:** depois de reiniciar, a validade do escopo acaba (época nova; nenhuma autorização é renovada). Um recebimento cuja resposta se perdeu não pode ser repetido depois disso: o PO cancela e cria nova ordem. O PR de um recebimento já gravado ainda pode ser proposto dentro de 24 h.
6. **Uso da assinatura:** valem os limites de "ordinary, individual usage" da assinatura [L1]. O ACC não os mede.

## 9. Dependências (D-B3)

| Pacote | Versão fixada | Licença | Dependências | `npm audit` |
|---|---|---|---|---|
| `@modelcontextprotocol/server` (SDK oficial v2, servidor) | `2.4.0` (exata) | Apache-2.0 | `@modelcontextprotocol/core` 2.4.0, `zod` | 0 vulnerabilidades em produção (`--omit=dev`) |
| `@modelcontextprotocol/core` | `2.4.0` (transitiva) | Apache-2.0 | `zod` | — |
| `zod` | `4.6.7` (exata; já estava no lockfile como transitiva de desenvolvimento) | MIT | — | — |

Nenhum dos três tem script de instalação. Não foram adicionados `express`, `hono` nem o middleware Node do SDK. Foi usado o transporte Web Standard (`WebStandardStreamableHTTPServerTransport`) com `Request`/`Response` nativos do Node 24. O SDK v1 (`@modelcontextprotocol/sdk`) foi descartado porque traz `express`, `hono`, `cors`, `jose`, `cross-spawn` e outras 12 dependências.

## 10. Compatibilidade verificada (2026-11-27)

O cliente real foi testado contra uma instância descartável do endpoint, sem dados do ACC e sem acionar modelo:

- **Ambiente:** Claude Code **2.1.332** no Windows 11, com `claude mcp add --transport http --scope local … --header "Authorization: Bearer …"`.
- **Conexão:** `claude mcp get acc` e `claude mcp list` → `✔ Connected`.
- **Negociação:** o cliente tenta primeiro a revisão `2026-07-28`, recebe 400 (o SDK 2.4.0 suporta até `2025-11-25`) e refaz a inicialização, negociando `2025-11-25`.
- **SSE:** o `GET` de SSE recebe 405 e o cliente aceita.
- **Cabeçalhos:** nenhum `Origin` enviado; `Accept: application/json, text/event-stream`.
- **Limpeza:** o registro de teste foi removido (`claude mcp remove acc -s local`) e o token de teste não ficou em `~/.claude.json`.

**Gemini (futuro, não implementado):** o contrato não depende do agente. O agente vem da credencial (`agentId`) e as ferramentas não citam o Claude. Estender ao Gemini exige:

- um `agentId` novo na credencial;
- o perfil assistido correspondente no catálogo (#022);
- a exceção fechada da política (#020);
- verificar o cliente MCP do Gemini (#009).

## 11. Fontes oficiais consultadas (2026-11-27)

| Id | Fonte | Uso |
|---|---|---|
| L1 | https://code.claude.com/docs/en/legal-and-compliance | Assinatura para uso ordinário do binário oficial; nada de coletar ou intermediar credenciais da Anthropic. |
| L2 | https://code.claude.com/docs/en/authentication | `--bare` não lê a assinatura; precedência de `ANTHROPIC_API_KEY` (não usado). |
| L3 | https://code.claude.com/docs/en/headless | Automação programática exige chave de API (não usada). |
| M1 | https://code.claude.com/docs/en/mcp | Transporte HTTP, escopos `local/project/user`, `--header`, prompts como `/mcp__server__prompt`, alertas de injeção de prompt. |
| C1 | https://code.claude.com/docs/en/channels | Research preview; exige sessão aberta (futuro). |
| D1 | https://code.claude.com/docs/en/desktop-scheduled-tasks | Local, exige o app aberto (futuro). |
| R1 | https://code.claude.com/docs/en/remote-control | Opera uma sessão local já aberta. |
| RT1 | https://code.claude.com/docs/en/routines | Nuvem; não alcança o localhost. |
| S1 | https://modelcontextprotocol.io/specification/2025-11-25/basic/transports | `Origin` → 403, bind em loopback, autenticação, 202, 405 para GET, versão → 400. |
| S2 | https://modelcontextprotocol.io/specification/2025-11-25/basic/security_best_practices | Sem *token passthrough*, sessão não é autenticação, riscos de servidor local (exigir token). |
| A10 | https://code.claude.com/docs/en/sandboxing (lida na #008) | Windows nativo sem sandbox. |
