# Issue #055: ponte MCP local entre o ACC e o Claude Code (relatório técnico)

| | |
|---|---|
| Branch | `feature/055-mcp-bridge`, criada da `main` `6d21973338984fc360731f40100b20c2d5969d33` (fechamento da #008; CI e Main audit verdes) |
| PR | Um único PR, em **draft**, sem merge |
| Especificação e operação | `docs/MCP_BRIDGE.md` |
| Roteiro do exercício real | `docs/evidence/issue055-runbook.md` (não executado; depende de autorização separada do PO) |
| Evidências locais | `docs/evidence/issue055-checks.txt` |

## 1. Resultado

O PO não copia mais pacotes nem digita referências de PR:

- o Claude Code, numa sessão aberta pelo PO com a assinatura dele, **recebe** pela ponte só o pacote autorizado e **propõe** o PR;
- o PO **confirma** com step-up, e a verificação somente leitura roda na mesma ação.

Continuam valendo:

- o ACC não executa nada: `REAL_EXECUTION_ENABLED = false`, sem subprocesso novo e sem rede nova;
- nenhuma credencial de provedor;
- nenhuma API paga;
- os gates #020/#021/#022.

## 2. O que foi implementado

| Arquivo | Conteúdo |
|---|---|
| `server/http/mcpBridge.ts` (novo) | Endpoint `POST /mcp`, Streamable HTTP **sem estado**, só JSON, com o SDK oficial (`McpServer` + `WebStandardStreamableHTTPServerTransport`, um servidor por requisição, preso à credencial já autenticada). Pipeline próprio (§4). Ferramentas `acc_list_orders`, `acc_claim_order`, `acc_report_pr` e `acc_get_order_status`, mais o prompt `next`. Espelho na #006 com ator `agent:claude-code`. |
| `server/gateway/bridge.ts` (novo) | Coordenador do lado do agente: listar, receber, propor e consultar. Sem rede, ambiente nem log; não vincula, não aprova, não cancela, não libera nada. |
| `server/gateway/service.ts` | Métodos da ponte: credencial (criar com #011 + step-up, revogar, autenticar pelo resumo), `offerOrder`, `bridgeOrders`, `bridgeClaim`, `bridgeReportPr`, `bridgeOrderRef` e `confirmProposal`. Também: `linkPullRequest` → `linkCore` (mesma lógica, reutilizada), exclusividade manual × ponte, ativação concorrente tolerada e `disableProject` revogando as credenciais. |
| `server/gateway/contracts.ts`, `documents.ts` | Tipos e `BRIDGE_LIMITS`. Conjuntos **somente de acréscimo** (`bridgeCredentials`, `bridgeRevocations`, `orderDeliveries`, `prProposals`) com validação estrita e coerência cruzada (recebimento só depois da disponibilização, proposta só com recebimento da mesma credencial, validade ≤ 30 dias, chaves únicas). |
| `server/gateway/orders.ts` | Visão `bridge` da ordem, `offer`, `confirmProposal` (vínculo + verificação; a falha da verificação vira `verificationError` público) e credencial vigente. |
| `server/http/claudeOrderRoutes.ts`, `app.ts` | Quatro rotas administrativas (`/offer`, `/confirm-pr`, criar/revogar credencial), todas com step-up. `/mcp` é desviado antes da lista de métodos, do CSRF e da sessão; listagem com `bridge`. |
| `server/config.ts`, `server/index.ts`, `.env.example` | `ACC_BRIDGE_ENABLED` (desligada por padrão; `true` só com `ACC_DEPLOYMENT=local`); ligação no servidor. |
| `server/approvals/*`, `server/limits/contracts.ts`, `shared/approvalPresentation.ts` | Nova operação de configuração `gateway.claude_bridge_credential`, com apresentação fechada (projeto, credencial, agente, validade, resumo do token). |
| `shared/contracts.ts`, `server/github/errors.ts`, `server/audit/events.ts` | Visões e respostas; código público `bridge_unavailable`; ações e contexto (`credential`, `replay`) da auditoria. |
| `scripts/secret-scan.mjs`, `server/gateway/secretScan.ts` | Formato `accb_` reconhecido como segredo. |
| `src/…` | Seção da ponte (criar, revogar, comando exibido uma vez), **Disponibilizar ao Claude Code**, recebimento, PR proposto, **Confirmar PR e verificar** e resultado. Fluxo manual em "Contingência". Rótulos da auditoria e da aprovação. |
| `server/test/claudeHttpFixtures.ts` (novo) | Pilha HTTP real extraída de `claudeOrders.test.ts` (sem mudança de comportamento) e reutilizada com a ponte ligada. |

## 3. Requisitos da autorização × implementação

| Requisito | Onde |
|---|---|
| SDK oficial, versão estável, fixada, avaliada | `@modelcontextprotocol/server` **2.4.0** e `zod` **4.6.7**, versões exatas no `package.json` e no lockfile. Sem scripts de instalação; `npm audit --omit=dev` = 0. O v1 foi descartado (17 dependências diretas). Teste estrutural exige versão exata. |
| Desabilitada por padrão até configuração autorizada | `ACC_BRIDGE_ENABLED` + `ACC_DEPLOYMENT=local` + credencial criada com aprovação de configuração #011 e step-up. Sem credencial ativa, disponibilizar → `bridge_unavailable`. |
| Credencial exclusivamente local, sem chave de provedor | Token `accb_` gerado pelo ACC; só o SHA-256 no ledger. Teste confere que o ledger não contém o token. |
| Revogação e expiração efetivas | Avaliadas em toda requisição e de novo dentro da transação. Testes: revogação → 401 na seguinte; expiração de 1 dia; revogação enfileirada antes do recebimento → nenhum pacote. |
| Host, Origin, método e protocolo | Pipeline §4 (403/405/400), testado ponta a ponta. |
| Limites de requisição, resposta e frequência | 16 KiB, 512 KiB, 60/min por credencial, bloqueio após 10 falhas em 5 min. |
| Autenticação administrativa × MCP separadas | `/mcp` nunca lê cookie; rotas do admin nunca leem `Authorization`. Testes estruturais e ponta a ponta nos dois sentidos. |
| Tokens e pacotes fora de logs | Teste estrutural nas chamadas de log. Testes ponta a ponta varrem auditoria e log em busca do token, de `accb_` e do pacote. |
| Gates em cada operação sensível, inclusive repetições | `agentGate` + `scopeProblem` em todo recebimento (também na repetição) e `agentGate` em toda proposta. Testes com barreira, tarefa reatribuída e cancelamento. |
| Acesso cruzado entre projetos e agentes | Ordem de outro projeto, não disponibilizada ou recebida por outra credencial → invisível (`not_found` / `claim_invalid`). Sujeito sempre `claude-code` e tarefa atribuída. |
| Exclusividade manual × MCP | `delivery_channel_bridge` / `delivery_channel_manual`. Teste concorrente: exatamente um canal vence. |
| Recebimento atômico e persistente | Gravado ANTES de devolver o pacote; sobrevive ao reinício (teste). |
| Idempotência (credencial, ordem, conteúdo) | `keyDigest` + `requestDigest`; mesma chave com outro pedido → `idempotency_conflict` (teste). |
| Recuperação segura | Falha de gravação antes do recebimento: nada gravado e nenhum pacote. Resposta perdida: a mesma chave devolve o mesmo recebimento (até 15 min e dentro da validade). Depois de reinício ou vencimento: falha fechada (§6). |
| Nenhum pacote após cancelamento, revogação, expiração ou barreira | Testes de cada caso, inclusive na repetição. |
| Nenhum vínculo sem confirmação humana | Só `confirmProposal` (step-up, proposta mais recente). O coordenador do agente não alcança vínculo (teste estrutural). |
| Verificação vinculada ao HEAD consultado | Verificador V1–V13 e histórico por `headSha` inalterados; a situação devolve `headSha` e `current`. |
| Interface mínima | §2, com 5 testes de interface. |
| Compatibilidade com o cliente real no Windows | Claude Code 2.1.332: `✔ Connected` com o comando exato (`docs/MCP_BRIDGE.md` §10). |
| Extensível ao Gemini | Agente vindo da credencial; ferramentas neutras; extensão descrita (não implementada). |

## 4. Pipeline do `/mcp`

Ordem das etapas, com a resposta de cada recusa:

1. ponte desligada → 404;
2. método ≠ POST → 405;
3. `Host` ≠ loopback:porta → 403;
4. qualquer `Origin`/`Sec-Fetch-*` → 403;
5. bloqueio por falhas → 429;
6. tipo ≠ JSON → 415;
7. `MCP-Protocol-Version` malformado → 400;
8. Bearer `accb_…` sem credencial ativa → 401;
9. limite por credencial → 429;
10. corpo > 16 KiB → 413;
11. lote ou JSON inválido → 400;
12. versão não suportada (SDK) → 400;
13. resposta > 512 KiB → 500.

A query string é recusada no `app.ts`. Conforme a especificação MCP 2025-11-25: `Origin` → 403, loopback, token obrigatório, 202 para notificações, 405 para GET, sem sessão como autenticação.

## 5. Testes

**Suíte local: 1553 de 1554** (antes: 1507). +47 testes novos:

- `bridge.test.ts`: 20;
- `bridgeContracts.test.ts`: 6;
- `mcpBridge.test.ts`: 10;
- painel: 5;
- estruturais: 5;
- scanner de segredos: 1.

A única falha é a conhecida e local de `main-audit.test.mjs` (CRLF no checkout do Windows), que passa na CI.

Itens exigidos pela autorização e onde estão cobertos:

| Item exigido | Coberto por |
|---|---|
| Concorrência manual × MCP | `bridge.test.ts` (dois testes) e `mcpBridge.test.ts` |
| Revogação durante uma operação | revogação enfileirada antes do recebimento; repetição após revogação |
| Repetição após expiração | `claim_replay_expired`, `scope_expired`, credencial vencida, janela de 24 h |
| Falha de persistência antes do recebimento | nada gravado, nenhum pacote, falha fechada após reinício |
| Falha de persistência depois do recebimento | recebimento persistente; repetição dentro da janela |
| Acesso cruzado entre projetos | credencial do projeto B; credencial rotacionada |
| Compatibilidade real com o cliente MCP | `claude mcp add/get/list` contra instância descartável |
| Regressões completas da #008 | `orders.test.ts`, `claudeOrders.test.ts`, `claudeContracts.test.ts` e estruturais, todos verdes |
| Credenciais fora de logs, configurações versionadas e evidências | varreduras de auditoria e log nos testes; sem `.mcp.json` (teste estrutural); `check:secrets:repo`; busca do formato do token em todo o repositório |

Lint, build, `check:secrets` (dist), `check:csp` e `check:secrets:repo`: todos ok.

## 6. Decisões tomadas dentro do escopo (secundárias)

1. **Comando montado pelo servidor.** Um teste de *hardening* existente proíbe o frontend de conter `authorization`/`bearer`. Por isso o comando `claude mcp add … --header "Authorization: Bearer …"` vem pronto na resposta da criação, e o navegador só o exibe. O teste continua intacto.
2. **Repetição do recebimento só dentro da validade do escopo e sem reinício.** É o mesmo princípio da #008: "nenhuma etapa renova autorização". A liberação manual também só relê o pacote dentro da validade. Depois de reinício (época nova) ou vencimento, o pacote não sai de novo, e o PO cancela e cria nova ordem. O PR de um recebimento já gravado ainda pode ser proposto em 24 h.
3. **Referência de outro repositório vinda do agente é só recusada.** No vínculo manual ela rejeita a ordem; aqui, o agente não pode encerrar a ordem do PO.
4. **Credencial nova revoga a anterior.** Uma ativa por projeto. A ordem recebida pela credencial antiga não passa à nova (`claim_invalid`/`not_found`).
5. **Estado da projeção inalterado.** A ordem disponibilizada aparece como `delivered` e, recebida, como `awaiting_pr`. A visão `bridge` traz recebimento e proposta, e `CLAUDE_ORDER_STATES` não muda.
6. **Ponte desligada continua permitindo revogar.** Revogar é sempre a ação segura.

## 7. Limitações e pendências

- **Pendências desta issue:**
  - o PO ainda abre a sessão e digita `/mcp__acc__next` (D-B1);
  - prompts de permissão do Claude Code pausam o trabalho;
  - Windows nativo sem sandbox (#021).
- **Dependências externas:**
  - o cliente tenta primeiro a revisão `2026-07-28` do protocolo e cai para `2025-11-25`. Uma versão futura do SDK com suporte à nova revisão exige PR próprio, com nova avaliação;
  - Channels e tarefas agendadas do Desktop ficam para uma issue futura.
- **Exercício real:** não executado (roteiro pronto); exige autorização separada do PO.

## 8. Decisões do PO

Nenhuma decisão indispensável ficou pendente para a revisão técnica. Para o exercício real, só a autorização dele (roteiro §0–§6).
