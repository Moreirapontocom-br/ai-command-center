# Issue #028 — PR 2: Agent Gateway (implementação integral, dormente e simulada)

> **Escopo autorizado:** todo o restante da #028 num único PR, incluindo as soluções I1, I4 e P3. Merge **não** autorizado.
> Execução real **desligada** (`REAL_EXECUTION_ENABLED = false`). Nenhum provedor real, credencial, rede, rota HTTP, gasto ou ligação no `server/index.ts`.

| Item | Valor |
|---|---|
| Base | `origin/main` `97f309f5f0acddab59c148bc513bfb748f76f3e1` (merge do PR #47) |
| Branch | `feature/028-agent-gateway-implementation` |
| Decisões aplicadas | D1–D9; I1, I4 e P3 conforme aprovadas |
| Catálogo de provedores | todos `unverified` (inalterado) |
| Política | `agent.invoke` adicionada (`available: false`); versão `2026-11-19.1` |
| Custo | R$ 0 |

## 1. Verificação inicial

- `git fetch`; `origin/main` = `97f309f…`; o merge do PR #47 está na história da `main`; a branch não existia (local e remota).
- Árvore de trabalho: nenhum arquivo versionado modificado. Os dois não versionados preexistentes (`docs/evidence/issue002-review-validation.txt`, `documenta_o_t_cnica_initial_issue_001.md`) não foram tocados nem incluídos.
- Lidos: `docs/AGENT_GATEWAY.md`; aprovações (#011: `contracts`, `service`, `binding`, apresentação); política (#020); sandbox e executor simulado (#021/#012); controlador e adaptador de admissão (#022); fila, portas e agendador (#012); ledger assinado e subchaves; testes estruturais.

## 2. O que foi entregue

Detalhes completos em `docs/AGENT_GATEWAY.md` §16.

| Área | Entrega |
|---|---|
| Contratos | `AgentTaskRequest`, `AgentTaskResult`, `ProviderAdapter`, `AgentCapability`, `GatewayScope`, `GatewayHandoff`, `GatewayInvocation`, `GatewayProvenance`, `GatewayContentRef`; validação estrita e transições (`server/gateway/contracts.ts`, `documents.ts`). |
| I1 | Escopo por tarefa criado por aprovação autêntica e de uso único, com protocolo durável (intenção → reserva → verificação de origem e da política com o grant → escopo ativo → resultado). Validade limitada pelas aprovações originais. |
| I4 | Fluxo assistido fora da fila; só a ingestão do resultado ocupa uma vaga, como item curto e admitido. |
| P3 | Conteúdos cifrados (AES-256-GCM) com referência, resumo, retenção e exclusão no ledger assinado. |
| Adaptadores | ChatGPT, Claude, Gemini e Nemotron simulados: sucesso, falha, indisponibilidade, rate limit, quota, timeout, custo desconhecido e saída grande demais. Nemotron opcional. |
| Fila (D6) | Executor do gateway + executor composto (roteamento por tipo); mesmo agendador, admissão e liquidação da #012/#022. |
| I8 | Prova de origem (HMAC, chave só em memória) e `verifyResult` na fila. |
| Auditoria | Eventos `gateway.*` no histórico assinado (só ids, tokens e resumos). |
| Política (D2) | `agent.invoke` (tool, médio, não crítica, indisponível no catálogo real); `data.send_external` exigida no canal assistido. |

### 2.1 Arquivos

Criados: `server/gateway/{adapters,content,contracts,documents,routingExecutor,secretScan,service,store}.ts`, `server/storage/sealedBlobs.ts`, `server/test/gatewayFixtures.ts`, testes `server/gateway/{scope,invoke,assisted,storage,contracts}.test.ts`, este relatório e `docs/evidence/issue028-pr2-{tests,checks}.txt`.

Alterados (mínimo necessário):

| Arquivo | Alteração | Motivo |
|---|---|---|
| `shared/contracts.ts` | `agent.invoke` | D2 |
| `server/policy/defaultPolicy.ts` | versão `2026-11-19.1` | o catálogo mudou (A4 passa a cobrir `agent.invoke`) |
| `shared/approvalPresentation.ts` | tipo `gateway.scope` | apresentação verificável do escopo (I1, #011 R1) |
| `server/approvals/contracts.ts` | componente `gateway` | recibo da reserva do escopo (I1); nenhum TTL/regra alterado |
| `server/queue/ports.ts`, `server/queue/scheduler.ts` | `proof` opcional e `verifyResult` | I8 |
| `src/features/approvals/ApprovalsPage.tsx` | exibição de `gateway.scope` | o PO precisa ver todos os limites para aprovar (R1) |
| `src/features/policy/PolicyPage.tsx` | rótulo de `agent.invoke` | lista tipada das ações |
| `server/security.test.ts` | listas atualizadas + 2 testes do gateway | ver §4 |
| `server/test/schedulerFixtures.ts` | tarefas extras de outros agentes | testes com os quatro provedores |
| `docs/AGENT_GATEWAY.md` | status, I1–I9 e §16 | documentação do comportamento |

## 3. Decisões técnicas relevantes

1. **Rotas HTTP não foram criadas.** O serviço é dormente, como o agendador da #012; criar rotas exigiria também clientes no frontend (o teste estrutural compara as rotas POST com as chamadas do navegador). As confirmações humanas usam o mesmo registro de *step-up* da #011, injetado.
2. **O vínculo da aprovação aponta para o escopo** (`resource.type = 'gateway_scope'`), não para a tarefa. Assim o pedido do escopo nunca é marcado como `superseded` pelo pedido de admissão da #022 na mesma tarefa.
3. **Aprovação rejeitada ou vencida:** ativar faz um pedido novo (pendente), sem consumir nada — mesma semântica do sandbox.
4. **Entrega dos resultados por `drain()`:** o executor guarda o resultado com a prova, e o hospedeiro entrega à fila depois do ciclo que registrou o início. Isso evita `result_before_start`.
5. **Efeitos fora da fila de operações:** revogação e kill switch cancelam itens na fila depois da gravação, evitando um impasse entre a fila e o executor.
6. **Conteúdo e referência na mesma operação serializada:** a varredura nunca apaga um arquivo recém-gravado.
7. **`secretScan.ts`** (e não `secrets.ts`): o teste de endurecimento da #003 proíbe o trecho `/secrets` em caminhos. O módulo foi renomeado, sem relaxar a regra.

## 4. Alterações nas regras estruturais (mínimas, com testes)

- Aprovações: `server/gateway/service.ts` entra na lista dos que usam o núcleo, e o teste exige que seja **só** `import type { ApprovalCoordinator }`.
- Fila: o gateway importa `queue/ports.ts` só por tipo. `routingExecutor.ts` segue as mesmas regras dos adaptadores da #012. Para `service.ts`, valem as regras próprias do bloco do gateway (que usa o tipo do coordenador e um temporizador de prazo).
- Armazenamento: `sealedBlobs.ts` entra na lista. Testes: não conhece gateway, aprovações, fila, sandbox nem controlador, e usa AES-256-GCM.
- Novo bloco do gateway:
  - lista exata de arquivos;
  - nenhuma rede, `fs`, subprocesso, código dinâmico, `process.env` ou cookie;
  - nenhum acesso ao controlador, sandbox, núcleo de aprovações ou fila em si;
  - adaptadores só simulados;
  - executor composto recusa executores não simulados;
  - nada fora do módulo cria o gateway, e `index.ts` não o menciona;
  - nenhuma rota do gateway;
  - nenhum log/console no gateway;
  - `REAL_EXECUTION_ENABLED = false`.

## 5. Testes

Lista nominal em `docs/evidence/issue028-pr2-tests.txt`.

| Suíte | Testes | Cobertura principal |
|---|---|---|
| `scope.test.ts` | 13 | I1: pedido, pendente, rejeitada, concorrência, forjada/outro componente, sem verificador, expirada, validade monotônica, revogação com step-up, kill switch, reinício na ativação, isolamento, formato fechado/R$ 0 |
| `invoke.test.ts` | 12 | D6: fluxo completo, I8 (sem prova/forjada), idempotência/conflito, limites do escopo, isolamento entre projetos, indisponível/quota/rate limit, falha/timeout/saída grande, custo desconhecido, segredo/prompt injection, cancelamento/revogação, quatro provedores e Nemotron indisponível, reinício na execução |
| `assisted.test.ts` | 8 | D5/I4: fluxo completo, espera de horas sem bloquear outra tarefa, validade do escopo na liberação, janela de retorno/revogação/barreira, segredo/tamanho/outro dono, canal errado, reinício, releitura |
| `storage.test.ts` | 8 | P3/D7: cifra/adulteração/troca de contexto/ausência, retenção/órfãos, exclusão controlada, nada de conteúdo no ledger, chave errada/diretórios, adulteração do ledger, regras entre versões/leituras congeladas, falha de gravação |
| `contracts.test.ts` | 6 | política (D2), apresentação `gateway.scope`, espelhos das listas, adaptadores, segredos |
| `security.test.ts` | +2 | estruturais do gateway |

Suíte completa: **1205 de 1206**. A única falha é `scripts/main-audit.test.mjs`, a falha local conhecida no Windows: `core.autocrlf=true` faz o checkout dos workflows com CRLF. Nenhum workflow foi alterado, e na CI Linux ela passa. ESLint: 0 problemas. TypeScript (`tsc -p tsconfig.server.json`, `tsc -b`), build, CSP e varredura de segredos: ok. Detalhes em `docs/evidence/issue028-pr2-checks.txt`.

## 6. Critérios de aceite da #028 (dentro do escopo autorizado)

| Critério | Situação |
|---|---|
| Matriz comprovada | Atendido no PR 1 (#47) |
| Contrato comum (entrada/saída, proveniência, capacidades, timeout, erros) | Atendido (§16.1, testes) |
| Fluxo assistido explícito | Atendido (núcleo; experiência completa no frontend, D5) |
| Indisponibilidade, limite gratuito/quota, falhas; sem acesso cruzado a credenciais | Atendido (nenhuma credencial existe; testes de agente/projeto cruzados) |
| Nemotron opcional | Atendido |

## 7. Limitações residuais e riscos

Ver `docs/AGENT_GATEWAY.md` §16.6. As principais:

1. **Cada invocação ou ingestão ainda exige a aprovação de admissão do controlador (#022)** — mantida de propósito (R3). O escopo substitui só a aprovação de execução. Uma integração futura com aprovações de planos poderá eliminar a nova aprovação humana por invocação, mas nunca a validação de admissão.
2. Escopos curtos por construção: 60 min no canal simulado e 15 min no assistido, porque os TTLs da #011 não foram alterados.
3. O gateway é dormente: sem rotas, UI do fluxo assistido nem ligação no `index.ts`. Ativar tudo isso exige PR e aprovação próprios.
4. O sandbox simulado ainda não tem prova de origem (resíduo da #012).
5. A detecção de segredos é por padrões.
6. Rotação da chave de conteúdo não implementada.
7. Espelho da auditoria do gateway na #006 adiado.
8. A mudança de versão da política invalida pedidos de aprovação pendentes da versão anterior.

## 8. Governança

- `main` não foi alterada diretamente e não houve merge.
- Nenhuma API real foi chamada, nenhuma credencial criada e nenhum custo gerado.
- Nenhum executor real foi ativado.
- #008, #009 e #010 não foram iniciadas. #020 e #022 continuam abertas.
- A #028 **não** está concluída antes do merge autorizado e da verificação pós-merge.

## 9. Revisão complementar (R1–R3)

| Ponto | Diagnóstico | Correção | Testes |
|---|---|---|---|
| R1 | **Confirmado.** O anchor falha depois de o ledger gravar `active`, e a gravação de `failed` também falha (armazenamento degradado). Na reabertura, o ledger uma geração à frente do anchor é aceito, e o escopo voltava **ativo** com a ativação informada como falha. | `store.ts`/`onEpoch`: escopos `active`/`exhausted` vencem a cada época nova (`restart_closed`), como as aprovações concedidas da #011; invocações na fila desses escopos são recusadas; pacotes não liberados vencem. | `review.test.ts`: falha simultânea (ledger gravado, anchor e recuperação falham) + reinício; recuperação que não grava → `activating` inutilizável → `failed` no reinício; nenhum escopo atravessa o reinício |
| R2 | **Confirmado.** `byItem` só era removido no descarte, e `byToken` nunca. O executor do gateway acumulava `dispatches`, `proofs`, `completions` e `routes`. | Ciclo de vida: o item é esquecido na hora no despacho não iniciado, no cancelamento confirmado e no descarte; tokens ficam por 24 h e depois são descartados; teto de 10 000 entradas. `verifyResult` também confere o item do token. | `review.test.ts`: retenção e descarte, forjado recusado, repetição tardia reconhecida dentro da retenção, recusada depois; not_started e cancelamento liberam na hora |
| R3 | Mantido | Só documentação (AGENT_GATEWAY.md §16.6 item 1 e §16.7) | — |

Nenhuma alteração em TTLs, contratos ou regras da #011, no controlador da #022, nas rotas ou no `server/index.ts`.
