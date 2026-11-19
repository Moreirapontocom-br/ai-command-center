# Issue #008 — PR 2: Integração assistida com Claude Code (relatório)

> **Fluxo ASSISTIDO apenas.** O ACC prepara a ordem, registra as aprovações e **lê** o PR no GitHub. Quem executa o Claude Code é o PO, fora do ACC, com a própria assinatura.
> `REAL_EXECUTION_ENABLED = false as const` (inalterado). Nenhuma API paga, nenhum provedor real, nenhuma escrita no GitHub, nenhum workflow novo. Orçamento adicional: **R$ 0**.
> Merge **não** realizado. Issue #008 continua aberta.

| Item | Valor |
|---|---|
| Base | `origin/main` `7ec45ee0f679d7dc21af5a0ba9bd5e00ba8d1552` (merge do PR #49), conferida com `git fetch` |
| Branch | `feature/008-claude-assisted-implementation` |
| Especificação | `docs/CLAUDE_CODE_ASSISTED.md` (D-08.1–D-08.11 aprovadas); diferenças em §13 dela e em §9 deste relatório |
| Testes | 1318 (1317 ok + 1 falha local conhecida de CRLF); 103 casos novos em 8 arquivos |

## 1. Verificação inicial (Etapa 0)

- `git fetch origin`: `origin/main` = `7ec45ee…` = merge commit esperado do PR #49. Main não avançou.
- Working tree: só os três arquivos **não versionados** preexistentes (`ACC_Explicacao_Tecnica.pdf`, `docs/evidence/issue002-review-validation.txt`, `documenta_o_t_cnica_initial_issue_001.md`) — preservados, não incluídos.
- Lidos: `docs/CLAUDE_CODE_ASSISTED.md` (inteiro), o relatório do PR 1 e os contratos de `server/gateway`, `server/approvals`, `server/policy`, `server/limits`, `server/github`, `server/http`, `server/queue/barrierGate.ts`, `shared/approvalPresentation.ts`, `shared/contracts.ts`, `server/index.ts`, `server/config.ts` e os testes estruturais (`server/security.test.ts`, `server/hardening.test.ts`).
- Linha de base: 1211 testes, 1 falha local conhecida (`scripts/main-audit.test.mjs`, CRLF no Windows).

## 2. Arquitetura implementada

```
PO (sessão #003) ── POST criar ordem ──► rotas (claudeOrderRoutes.ts: CSRF, sessão, política, corpo fechado)
                                          │
                                          ├─► coordenador (gateway/orders.ts) ──► porta de leitura do GitHub
                                          │        │                               (github/prReader.ts: 2 queries + 1 GET)
                                          │        ▼
                                          └─► gateway (gateway/service.ts, canal assisted)
                                                 ├─ escopo `code.change` + bloco `code` (repo, id estável, SHA base, branch, resumo)
                                                 ├─ política (#020) com a exceção fechada §10.7 (fatos do servidor)
                                                 ├─ aprovações (#011): agent.invoke (60 min) + data.send_external (15 min)
                                                 ├─ pacote cifrado (sealedBlobs) + histórico assinado `gateway.*`
                                                 └─ histórico de verificações, marcas e habilitações (somente acréscimo)
PO copia o pacote ─► Claude Code FORA do ACC ─► PR na branch designada ─► PO informa owner/repo#N ─► ACC verifica (V1–V13)
```

- **Ordem = handoff do canal `assisted`** (id do handoff = `orderId`). Antes das aprovações, a ordem é o escopo `awaiting_approval` com o bloco `code` + o conteúdo cifrado `order_input` (objetivo e critérios).
- **Liberação** (`/package`, step-up): consome as duas aprovações (uso único), prepara o pacote (bloco fixo do servidor + dados não confiáveis entre marcadores), entrega o texto só nesta resposta.
- **Vínculo do PR** (step-up): validação estrutural, `awaiting_relay → relayed → validated` (= referência aceita, **não** conformidade). Sem fila (D-08.4).
- **Verificação** (leitura direta): PR lido no início e no fim (V12) + comparação REST com a cabeça lida; regras puras V1–V13; entrada somente de acréscimo no **mesmo** ledger assinado.
- **Produção** (`server/index.ts`): o gateway só abre com `ACC_GATEWAY_DIR` e `ACC_GATEWAY_CONTENT_DIR` (+ aprovações configuradas), com chaves derivadas por HKDF da chave das aprovações. `adapters: {}`, sem fila, sem executor, sem temporizador de invocação. Manutenção periódica = `sweep` (expirações e retenção).

## 3. Arquivos

**Criados**

| Arquivo | Conteúdo |
|---|---|
| `server/gateway/orders.ts` | Coordenador: criação (lê `main` no GitHub), liberação, encaminhado, PR, cancelamento, verificação, projeção de estados, habilitação. Sem rede própria. |
| `server/gateway/prVerification.ts` | Regras V1–V13 e critério de ancestralidade (§6.4), puras. Caminhos proibidos só como códigos. |
| `server/github/prTypes.ts` | Tipos das leituras normalizadas e da porta somente leitura. |
| `server/github/prReader.ts` | Leitor: `MainHead`, `PullRequestVerification` (até 3 páginas de arquivos, mesma cabeça) e comparação REST; normalização fechada. |
| `server/http/claudeOrderRoutes.ts` | Rotas, corpos fechados, step-up, mapeamento de erros públicos, espelho de auditoria. |
| `src/services/claudeOrdersApi.ts` | Cliente do navegador. |
| `src/features/tasks/ClaudeOrderPanel.tsx` | Interface mínima na tarefa atribuída ao Claude Code. |
| `server/test/claudeOrderFixtures.ts` | Pilha de teste (catálogo de produção + GitHub falso em memória). |
| Testes | `server/gateway/{orders,prVerification,claudeContracts}.test.ts`, `server/policy/assisted.test.ts`, `server/github/{prReader,restCompare}.test.ts`, `server/http/claudeOrders.test.ts`, `src/features/tasks/ClaudeOrderPanel.test.tsx`. |
| Documentos | Este relatório e `docs/evidence/issue008-pr2-{tests,checks,github-read}.txt`. |

**Modificados**

| Arquivo | Mudança |
|---|---|
| `shared/approvalPresentation.ts` | `code.change`; bloco opcional `code` em `gateway.scope` (formato fechado, branch derivada); tipo `gateway.claude_project_enable`. |
| `shared/contracts.ts` | Códigos de erro novos; ações e recurso de auditoria `claude_order.*`; tipos das respostas das ordens. |
| `server/policy/engine.ts` | `ASSISTED_AVAILABILITY` (2 entradas congeladas) e `PolicyFacts.assisted`; a exceção força aprovação. |
| `server/policy/defaultPolicy.ts` | Versão `2026-11-19.2` (invalida pedidos pendentes da anterior). |
| `server/limits/providers.ts` | Só `claude-code/subscription_assisted` → `available`; `assistedProfileAvailable()`. |
| `server/limits/contracts.ts` | `HumanApproval.operation` aceita `gateway.claude_project_enable`. |
| `server/approvals/contracts.ts`, `service.ts` | Operação de configuração `gateway.claude_project_enable`; artefato humano preso ao `paramsDigest`; `ApprovalCoordinator` com `confirmOwner` opcional. |
| `server/gateway/contracts.ts`, `documents.ts`, `store.ts`, `service.ts` | Bloco `code`; conteúdo `order_input`; `verifications`, `orderMarks`, `projectSettings` (aditivos, somente acréscimo, validados); eventos `gateway.order_*`/`pr_*`/`project_enablement`; métodos das ordens; o caminho genérico recusa `code.change`. |
| `server/github/client.ts`, `queries.ts`, `errors.ts` | Dois documentos GraphQL de consulta na allowlist; cliente REST de um único GET com allowlist fechada. |
| `server/http/app.ts` | Rotas novas, métodos, nome de rota, política e auditoria de recusas. |
| `server/index.ts`, `server/config.ts` | Ligação mínima do gateway (canal assistido) e `ACC_GATEWAY_*`. |
| `server/audit/events.ts` | Recurso `claude_order`; contexto `verdict`, `head`, `seq` (tokens). |
| `src/features/{approvals,audit,github,tasks}/…` | Apresentação do bloco `code` e da habilitação; rótulos de auditoria e de erro; painel na tarefa. |
| Testes existentes | Estreitados (ver `docs/evidence/issue008-pr2-tests.txt`). |
| `docs/CLAUDE_CODE_ASSISTED.md`, `docs/AGENT_GATEWAY.md` | Status e §13 (diferenças). |

## 4. Rotas e contratos

| Método | Rota | Função | Step-up | Política (pessoa) |
|---|---|---|---|---|
| GET | `/api/projects/:id/claude-orders` | Listar ordens, habilitação e repositórios habilitáveis (sem pacote nem objetivo) | — | `task.read` |
| POST | `/api/projects/:id/tasks/:taskId/claude-orders` | Criar a ordem (`idempotencyKey`, `objective`, `acceptanceCriteria`, `dataRefs?` só tarefas do projeto) | — | `task.update` |
| POST | `/api/projects/:id/claude-enablement` | Habilitar (`repository`) ou desabilitar o projeto | sim | `project.update` |
| POST | `/api/claude-orders/:orderId/package` | Ativar (consumir aprovações), preparar e liberar o pacote | sim | `task.update` |
| POST | `/api/claude-orders/:orderId/forwarded` | Marca opcional `awaiting_pr` | — | `task.update` |
| POST | `/api/claude-orders/:orderId/pr` | Vincular `owner/repo#N` | sim | `task.update` |
| POST | `/api/claude-orders/:orderId/verify` | Verificar o PR (somente leitura) | — | `github.read`, `task.read` |
| POST | `/api/claude-orders/:orderId/cancel` | Cancelar | sim | `task.update` |

Todas sob a sessão do administrador, com Origin/`Sec-Fetch-Site`/JSON verificados antes da autenticação (padrão do `app.ts`). Nenhum corpo aceita dono, repositório, branch, SHA, capacidade, agente ou escopo. Erros públicos novos: `order_conflict`, `order_closed`, `order_expired`, `project_not_enabled`, `secret_detected`, `pr_reference_invalid`, `verification_limit`, `head_changed`, `github_unavailable`, `github_unauthorized`, `gateway_unavailable`; intervalo mínimo → 429 com `Retry-After: 30`.

**Estados projetados:** `awaiting_approval → prepared → delivered → awaiting_pr → pr_linked ⇄ verified`; finais `rejected`, `expired`, `cancelled`. `HANDOFF_TRANSITIONS` idêntico ao da #028 (teste comparando).

## 5. Segurança

**Matriz de permissões (exceção §10.7).** `POLICY_ACTIONS['agent.invoke'|'data.send_external'].available` continua `false`. `ASSISTED_AVAILABILITY` tem exatamente as duas combinações (ação × `agent:claude-code` × `assisted` × `subscription_assisted` × `code.change` × `gateway`) e só vale com o projeto habilitado e recurso `gateway_scope`. Os fatos vêm só do gateway (escopo persistido + habilitação no ledger + catálogo). Fato ausente, divergente, com tipo errado ou chave extra → `UNAVAILABLE`. Mesmo com a exceção, a decisão é `REQUIRE_APPROVAL` até haver grant válido e de uso único. A matriz de teste percorre mais de 10.000 combinações; só as duas aprovadas mudam.

**Aprovações (#011).** Duas por ordem, presas ao escopo exato (apresentação com projeto, tarefa, agente, repositório e id estável, branch, SHA base, resumo do objetivo, capacidade, canal, modo e referências). Qualquer mudança → outro `paramsDigest` → outra aprovação. TTLs inalterados (60/15 min); validade efetiva = menor prazo. Step-up para liberar, vincular, cancelar e habilitar; prova de uso único e presa à sessão. Revogação, kill switch e barreira encerram a ordem. A janela de 24 h só serve para informar o PR: não relê o pacote nem reativa aprovação vencida (testado). Reinício: escopo ativo vence (R1 da #028).

**Habilitação por projeto (D-08.11).** Desligada por padrão. Habilitar = confirmação de configuração do PO (`gateway.claude_project_enable`, classe `configuration`, 15 min), reservada para o componente `gateway` e conferida pelo verificador confiável. Desabilitar (step-up) é imediato e encerra as ordens abertas (entrada final `cancelled` nas que têm PR). Um projeto nunca habilita outro.

**Isolamento e dados.** Tudo preso a `ownerId` + `projectId`; outro projeto → `not_found`. Objetivo, critérios, referências e resposta do GitHub são dados não confiáveis (marcadores neutralizados). `secretScan` no objetivo, nos critérios, no pacote, nos dados resolvidos e na referência do PR. Ledger, auditoria e logs guardam só ids, tokens, SHAs e resumos — nunca pacote, objetivo, corpo de PR, cookies ou credenciais (testado).

**Bloqueio de execução e de provedores.** `REAL_EXECUTION_ENABLED = false`; nenhum `child_process`/`spawn`/`exec` no caminho da #008; nenhum adaptador registrado em produção; nenhum SDK, host ou variável de provedor de IA; nenhum workflow com Claude Code (testes estruturais).

**GitHub somente leitura.** GraphQL: três documentos na allowlist, todos `query`. REST: um único GET (`/repos/{o}/{r}/compare/{40hex}...{40hex}?per_page=1`), validado antes da credencial e da rede; qualquer outro método, caminho, parâmetro, fragmento ou credencial embutida → recusa. Nenhuma mutation, branch, commit, PR, merge, dispatch ou alteração de proteção.

**Custo.** R$ 0. O único perfil disponível é de assinatura (`included`); `metered_api` continua recusado; `spend.create` indisponível.

## 6. Verificação (V1–V13) e ancestralidade

Implementadas como em §6 da especificação. `conforming` só com V1–V8, V10 e V11 comprovadas (checks todos verdes, comparação com prova completa e cabeça confirmada). Pendência ou falta de prova → `needs_review`. Falha eliminatória (V1–V7) → `nonconforming` final. V9 e V13 são informativas. Erro de rede, limite, timeout, autorização ou resposta malformada → erro explícito, **nada gravado**. HEAD alterado durante a leitura → `head_changed`, nada gravado. Novo push → entrada nova com `supersedes`; a anterior deixa de ser atual. Limites: 50 verificações por ordem e uma a cada 30 s.

**Verificação real (somente leitura, R$ 0)** — `docs/evidence/issue008-pr2-github-read.txt`: o PR #49 (já mesclado) resultou em `nonconforming` só por V7 (`merged`), com V6 provada pela comparação de SHAs completos. Um PR inexistente resultou em `pr_missing` (V2).

## 7. Testes e verificações

| Verificação | Resultado |
|---|---|
| `npx vitest run` | 1318 testes: 1317 ok; 1 falha local conhecida (CRLF, `scripts/main-audit.test.mjs`) |
| Testes novos | 103 casos em 8 arquivos (lista em `docs/evidence/issue008-pr2-tests.txt`) |
| `npx eslint .` | limpo |
| `npx tsc -b` | limpo |
| `npm run build` | ok |
| `npm run check:csp` | compatível com a CSP de produção |
| `npm run check:secrets` (dist) e `check:secrets:repo` (versionados) | nenhuma credencial |
| CI do PR | ver `docs/evidence/issue008-pr2-checks.txt` |

## 8. Restrições preservadas

Sem alteração direta na `main`; sem merge; sem execução de agentes; nenhum `child_process` novo; nenhuma API paga, OAuth de assinatura no servidor ou Agent SDK; nenhum GitHub Actions novo; nenhuma credencial nova; nenhum sandbox real; TTLs da #011 inalterados; controles das #020/#021/#022 mantidos (a barreira global inicial continua ativa e sem rota de liberação); estados terminais do gateway e `HANDOFF_TRANSITIONS` inalterados; nenhuma outra issue implementada.

## 9. Diferenças em relação à especificação

| Item | Especificação | Implementado | Motivo |
|---|---|---|---|
| Rota de liberação | `/release` | `/package` (`/release` → 405) | O teste estrutural proíbe `release` em rotas POST (N9 da #011). A recusa foi mantida, não contornada. |
| Estado inicial | `prepared` | `awaiting_approval` antes de `prepared` | Antes das aprovações não há handoff. |
| Documentos GraphQL | um | dois (`PullRequestVerification`, `MainHead`) | O SHA base precisa ser lido na preparação, antes de existir PR. |
| `dataRefs` | issue/PR/tarefa | só tarefas do mesmo projeto | O servidor só sabe resolver tarefas; recusa explícita em vez de falha tardia. |
| Formato inválido de PR | `handoff.rejected` | 400 sem mudar o estado | Um erro de digitação não encerra a ordem. Repositório diferente continua rejeitando. |
| Aprovação rejeitada | ordem recusada | nada liberado nem consumido; novo pedido pendente | Comportamento existente da #028 (inalterado); o PO pode cancelar. |
| "Leitura atual" | a leitura exibida | `verified` só com leitura da mesma cabeça há ≤ 5 min neste processo | A listagem não consulta o GitHub. |
| Resposta GraphQL malformada | `needs_review` | erro sem gravação (`github_unavailable`) | Sem cabeça confiável não há entrada válida; nunca vira sucesso. |

## 10. Pendências, limitações e riscos

1. **Produção bloqueada pela barreira global inicial (#011, N9).** Em instalação nova, a criação de ordens responde 423 (`approval_blocked`) até o PO liberar a barreira, e essa liberação continua sem rota (decisão R2 da #011). A habilitação por projeto (configuração) funciona. **O fluxo completo só foi exercitado em testes, com a barreira liberada pelo fluxo de configuração.** Não declaro o fluxo "em uso" em produção.
2. **Credencial fine-grained ainda não validada na prática** (ver §11, P2). Pela documentação oficial, a comparação exige `Contents: read`, permissão que já está na lista da #002. O token local, porém, é rejeitado pelo GitHub (401) até na consulta de snapshot da #002. A verificação real depende de um token novo, que precisa de autorização do PO. A falha fechada foi confirmada contra o GitHub real.
3. **Catálogo da #022.** Com `claude-code/subscription_assisted` disponível, o controlador (dormente, não instanciado em produção) passaria a admitir itens de **observação** desse perfil, se a fila fosse ligada no futuro. Nenhuma ação de execução fica admissível (testado). Revisar quando a fila for ligada.
4. **"Visto em" e leitura atual** ficam em memória (por processo): depois de um reinício, a conformidade aparece desatualizada até nova verificação (falha fechada, intencional). Dentro dos 5 min, `verified` vale para o HEAD lido e sempre aparece com o SHA e a hora. O ACC não lê o GitHub ao apresentar a ordem (§11, P3).
5. **Proveniência e isolamento** não são comprovados pelo ACC (V9 informativa; Windows nativo sem sandbox no Claude Code). A interface diz isso.
6. **Pedidos órfãos.** Se a gravação do escopo falhar depois dos pedidos de aprovação, os pedidos ficam pendentes até vencer (comportamento da #028).
7. **Recomendações futuras** (cada uma exige autorização própria): decisão do PO sobre como liberar a barreira inicial; confirmação com o token fine-grained; alternativa GitHub Action (D-08.8); resolução de issue/PR como dado do pacote.

## 11. Revisão complementar (P1–P3)

Pedido do PO sobre o SHA `50cb0ae`. Evidências em `docs/evidence/issue008-pr2-review-p1p3.txt`.

### P1 — Barreira global inicial (bloqueio que exige decisão do PO)

**Por que 423.**
- Toda instalação nova da #011 nasce com `barriers.global = { reason: 'initial_install' }` (`server/approvals/store.ts`, `startLineage`; decisão R2 da #011 PR 1).
- O gateway consulta a barreira pela porta `barriers.blocked` (`server/index.ts`). Barreira global durável → `global_barrier` → 423 `approval_blocked`.
- A mesma barreira faz o núcleo recusar decisões de execução e de publicação (N6, `barredClass`).
- Configuração não é barrada; por isso a habilitação do projeto funciona.

**Contratos que controlam.**
- `server/approvals/service.ts`: `blocked()`, `barredClass()`, `engageBarrier()`, `releaseBarrier()`, `releaseBarrierIn()`, `recordOutcome()` (liberação pelo controlador #022) e a validação do vínculo `killswitch.release`.
- `server/approvals/contracts.ts`: ação `killswitch.release`, da classe configuração, com TTL de 15 min (inalterado).
- `IMPLEMENTATION_REPORT_011_PR1.md` (R2, N3, N6, N9) e `IMPLEMENTATION_REPORT_011_PR2.md` §12: "a liberação operacional depende de etapa futura aprovada pelo Product Owner".

**Mecanismos aprovados para liberar.** Só uma aprovação `killswitch.release` do escopo exato (`global`). Ela precisa:
- nascer de `confirmOwner`, com prova de step-up de uso único do PO;
- ser reservada pelo componente `approvals`;
- ser consumida por `releaseBarrier` (ou pelo controlador #022, via `recordOutcome`).

Por decisão N9, nenhum desses caminhos tem rota HTTP.

**O que foi feito.** Nada foi removido, contornado ou enfraquecido, e nenhuma rota foi criada. Um teste novo em `server/http/claudeOrders.test.ts` ("revisão P1") prova, pelas rotas reais:
- com a barreira, a criação responde 423;
- não existe nenhum caminho HTTP plausível de liberação;
- liberação sem aprovação, com agente como sujeito ou com prova forjada é recusada;
- pelo mecanismo da #011, a barreira é liberada uma única vez e auditada (`approval.barrier_released`, ator humano, motivo `human_approved`);
- depois disso, a criação continua exigindo as duas aprovações por ordem;
- reacionar a barreira bloqueia de novo.

**Proposta de desbloqueio supervisionado (para decisão do PO; não implementada).**
1. Uma rota única, por exemplo `POST /api/approvals/barrier-unlock`. Hoje, `server/security.test.ts` proíbe `kill`, `barrier` e `release` em POST_ROUTES e proíbe que rotas chamem `releaseBarrier`. Por isso, qualquer rota de desbloqueio exige uma exceção explícita do PO, restrita a esse único caminho. Corpo fechado: `{ scope: 'global' | <projectId>, proofId }`.
2. O servidor monta o vínculo `killswitch.release`; o cliente nunca o envia. O sujeito é a pessoa da sessão, e ids de agente são recusados.
3. Step-up obrigatório (senha, uso único, 5 min, por sessão), com CSRF e sessão como nas demais rotas.
4. Fluxo `confirmOwner` → `reserve('approvals')` → `releaseBarrier` numa única chamada, como `service.configure` já faz para a retenção.
5. Recusa se o armazenamento da #011 estiver degradado, se houver divergência de restauração da fila (#012) ou se o kill switch do controlador estiver acionado.
6. Auditoria nos dois históricos (#011 e o espelho da #006), com motivo e escopo. Nenhuma aprovação revogada é reativada.
7. Testes: estrutural (rota exata, corpo fechado), sem step-up, prova reutilizada, agente, escopo de outro projeto, barreira reacionada, falha de gravação e reinício.

Isso altera o contrato N9 da #011, que é sensível e está fora do escopo autorizado. **Esta frente fica interrompida até a decisão do PO.**

### P2 — Credencial do GitHub

- **Permissão exigida.** A documentação oficial do GitHub ("Permissions required for fine-grained personal access tokens") lista `GET /repos/{owner}/{repo}/compare/{basehead}` com **Contents: read**. Essa permissão já consta da lista da #002 (`docs/GITHUB_INTEGRATION.md`), então **nenhuma permissão nova é necessária**.
- **Verificação real (somente leitura, R$ 0).** Usei o provedor de produção `createFineGrainedTokenProvider` com o token do `.env.local`, sem imprimi-lo. O GitHub respondeu **401** às três leituras: o snapshot da #002 (anterior a este PR), o MainHead e a comparação. Ou seja, o GitHub rejeitou o token local como credencial (vencido ou revogado); não é falta de permissão. A mesma sonda com a credencial do GitHub CLI funciona.
- **Comportamento.** A falha fechada foi confirmada contra o GitHub real: `github_unauthorized`, nada gravado. Nenhuma credencial foi criada, copiada, alterada ou elevada.
- **Procedimento de validação (exige o PO).**
  1. Gerar um token fine-grained novo, só para `Moreirapontocom-br/ai-command-center`, com `Metadata`, `Contents`, `Pull requests` e `Commit statuses` em Read-only. Acrescentar `Checks: Read-only` só se os checks vierem vazios.
  2. Gravá-lo em `.env.local`.
  3. Repetir `docs/evidence/issue008-pr2-github-read.txt`. Esperado: PR #49 → `nonconforming` só por V7; PR 999999 → `pr_missing`; nenhum 401/403.

### P3 — Concorrência na verificação (falha confirmada e corrigida)

**Falha.** `orders.ts` gravava a "leitura atual" (base do estado `verified`) **antes** de `appendVerification`. Se a leitura nova desse outro resultado para a mesma cabeça (por exemplo, PR fechado) e a gravação falhasse, a conformidade **anterior** voltava a aparecer como `verified`. O mesmo acontecia em dois outros casos:
- uma verificação que falhava no GitHub;
- um `head_changed` que terminava numa cabeça já conforme (força-push de volta).

Os três casos foram reproduzidos por teste antes da correção.

**Correção.**
- Cada nova tentativa apaga a leitura atual da ordem. Ela só volta a existir depois que o resultado **desta** verificação é gravado, e para o `headSha` efetivamente lido e comparado.
- Uma leitura interrompida (`head_changed`) registra a cabeça vista com `confirms: false` e nunca confirma nada.
- A interface acrescenta: "vale só para este HEAD, lido há menos de 5 min; commits novos exigem nova verificação".

**Testes novos** (`server/gateway/orders.test.ts`, bloco "revisão P3"), um para cada momento:
- push durante a leitura inicial (snapshot inconsistente e páginas de cabeças diferentes);
- push entre a comparação REST e a segunda leitura;
- push entre a segunda leitura e a gravação: o resultado fica preso ao SHA verificado e é substituído pela próxima verificação;
- push antes da próxima apresentação: `verified` só com leitura atual de até 5 min e com o SHA; depois disso, e após reinício, desatualizada;
- mais três regressões.

## 12. Governança

Nenhuma alteração direta na `main`; nenhum merge; nenhuma outra issue iniciada; nenhuma API paga; nenhum gasto adicional; Issue #008 mantida aberta. O merge depende da revisão independente e da autorização explícita do PO.
