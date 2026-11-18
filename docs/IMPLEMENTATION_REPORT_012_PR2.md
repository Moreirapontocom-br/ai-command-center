# Issue #012 — PR 2: Agendamento e controle (relatório de implementação)

> **Escopo autorizado:** somente o PR 2 da Issue #012, conforme as decisões Q1–Q11 do PO.
> Merge **não** autorizado. Issue #028 **não** iniciada. Execução real **não** habilitada.

| Item | Valor |
|---|---|
| Base | `origin/main` `b1fd7e6d067a116afa54525f2050550eb3972e17` (merge do PR #45) |
| Branch | `feature/012-queue-scheduler` |
| Decisões aplicadas | Q1–Q10 (Q11 apenas registrada, ver §10) |
| Execução real | `REAL_EXECUTION_ENABLED = false` (inalterado) |
| Rotas HTTP / UI / temporizadores novos | nenhum |
| `server/index.ts` | **inalterado** — o agendador não é instanciado em produção (Q7) |
| Custo / provedores | R$ 0; nenhum provedor real, nenhuma rede |

## 1. Verificação inicial

- `git status`: apenas os dois arquivos não versionados preexistentes (`docs/evidence/issue002-review-validation.txt`, `documenta_o_t_cnica_initial_issue_001.md`), **não** incluídos.
- `git fetch`; `origin/main` = `b1fd7e6…`; PR #45 `MERGED` (merge commit `b1fd7e6`); CI e Main audit da `main` em `b1fd7e6`: `success`; Issue #012 `OPEN`.
- Branch criada com `git switch -c feature/012-queue-scheduler origin/main` + `git branch --unset-upstream`.
- Inspecionados: `server/approvals/*` (#011), `server/policy/*` (#020), `server/sandbox/*` (#021), `server/limits/*` (#022), `server/queue/*` e `server/storage/*` (PR 1), `server/index.ts`, `server/security.test.ts`. Nenhuma incompatibilidade material.

## 2. Arquivos

### Criados
| Arquivo | Papel |
|---|---|
| `server/queue/scheduler.ts` | `QueueScheduler`: `submit`, `tick`, `cancel`, `onResult`, `restore`, `engageKillSwitch`, `get`, `list`. Dormente. |
| `server/queue/ports.ts` | Interfaces estreitas, **só tipos**: `AdmissionPort`, `ExecutorPort`, `TaskLookup`, resultados. |
| `server/queue/classification.ts` | Classificação explícita das recusas (definitiva × recuperável), prioridades. |
| `server/limits/queueAdmission.ts` | Adaptador controlador (#022) → `AdmissionPort` (restauração, admissão, liberação, término). |
| `server/sandbox/queueExecutor.ts` | Adaptador sandbox **simulado** (#021) → `ExecutorPort` (idempotente por token). |
| `server/test/schedulerFixtures.ts` | Pilha real de teste (fila + aprovações em disco, controlador, sandbox simulado). |
| `server/queue/scheduler.test.ts`, `server/queue/schedulerDocuments.test.ts`, `server/limits/queueAdmission.test.ts` | 56 testes novos. |
| `docs/IMPLEMENTATION_REPORT_012_PR2.md`, `docs/evidence/issue012-pr2-{tests,checks}.txt` | Relatório e evidências. |

### Alterados
| Arquivo | Mudança |
|---|---|
| `server/queue/contracts.ts` | Extensão opcional `run` (pedido, reserva, despacho, vaga, cancelamento, desfecho), constantes Q6/Q9, eventos novos, `queued → failed` (Q5). |
| `server/queue/documents.ts` | Validação estrita de `run`, invariantes por estado, relações entre itens e regras de alteração (`checkRunChange`). |
| `server/queue/store.ts` | `onEpoch`: `admitted → expired` libera a vaga com desfecho `not_dispatched`; intenção de admissão incerta → `expired`. |
| `server/limits/controller.ts` | Opção `restore` (estrita, tudo ou nada) e admissões incertas contando no rate limit / quotas oficiais. |
| `server/limits/validation.ts` | `parseRestoredAdmission` (validação estrita de admissão restaurada). |
| `server/security.test.ts` | Listas de arquivos atualizadas + garantias novas (agendador fora do `index.ts`, `ports.ts` só tipos e só importado pelos dois adaptadores, executor só simulado). Nenhuma garantia existente afrouxada. |

Nenhum teste existente foi alterado para ocultar regressão; os contratos da #011 não foram alterados.

## 3. Arquitetura

```
             submit / tick / cancel / onResult / restore / engageKillSwitch   (sem rota, sem timer)
                                        │
                              ┌─────────▼─────────┐
                              │  QueueScheduler   │  serializado; 1 ciclo por vez
                              └─┬──────┬──────┬───┘
      QueueStore (ledger PR 1) ◄┘      │      └► BarrierGate (#011 autoridade + pedidos duráveis)
                                       │
          ┌──────────── ports.ts (só tipos) ────────────┐
          ▼                     ▼                       ▼
   AdmissionPort           ExecutorPort             TaskLookup
 limits/queueAdmission   sandbox/queueExecutor     (injetado)
   └► LimitsController     └► SandboxService
      (#022, restaurado)      └► provedor SIMULADO
```

- A fila **não importa** controlador, sandbox nem aprovações (teste estrutural). Os adaptadores ficam nos módulos de origem e importam só `import type` de `queue/ports.ts`.
- Nenhuma importação circular; nenhuma verificação estrutural contornada (as listas foram estendidas e ganharam novas asserções).

### Ciclo de um item (`tick`)
1. Expirações (rodam mesmo bloqueado — só restringem); pedidos de parada por prazo.
2. Bloqueios: armazenamento, restauração, limites (Q2), portão global, kill switch local.
3. Candidatos `queued` ordenados por **prioridade** (`critical > high > medium > low`) e **FIFO** (criação, posição no ledger), respeitando `notBefore` (backoff); **uma tarefa por vez** (ver §9).
4. `executor.prepare` → aprovação **`sandbox.execute`** (componente `sandbox`).
5. **Intenção de admissão gravada** → `admission.admit` → aprovação da **admissão** (componente `limits`).
6. `queued → admitted` gravado com a reserva (`run.admission`, vaga `held`, `dispatchBy = +60 s`).
7. Portão de novo → **intenção de despacho gravada** (`admitted → dispatching`, `attempt + 1`, token único, época) → portão de novo → `executor.dispatch`.
8. Resultado: `started` → `running`; `not_started` (comprovado) → `failed` + vaga liberada + sucessor (se reintentável); qualquer outra coisa → `interrupted` (vaga ocupada).

## 4. Funcionalidades

- **Submit:** idempotente por (dono, chave); impressão digital SHA-256 do pedido canônico; conflito → `idempotency_conflict`; valida identidade (`ACTOR_ID`), projeto/tarefa/agente (`TaskLookup`), parâmetros (formato na fila, semântica nos adaptadores); chaves `retry:*` reservadas; recusado se bloqueado (`execution_blocked`); não inicia nada.
- **Tick:** ver §3. Ciclo concorrente devolve `tick_in_progress` sem rodar.
- **Cancel:** `queued` → `cancelled`; `admitted` → `cancelled` com reserva liberada (nunca despachado); `dispatching`/`running`/`interrupted` → pedido ao executor; só parada **confirmada** encerra e libera; `not_supported`/`failed` ficam registrados e a vaga continua ocupada; terminal → `invalid_transition`; outro dono/projeto → `not_found`; item do PR 1 em curso → `legacy_item_requires_review`.
- **OnResult:** valida formato, item, token, tentativa e época do despacho gravado; terminal → `late_result` (ignorado, registrado); divergência → `result_mismatch`; `running` → `succeeded`/`failed` com custo reconciliado; `interrupted` → vaga liberada com desfecho `ended_after_interruption`, **sem** voltar a executar.
- **Restore:** reconstrói o controlador do ledger (Q1); bloqueia e aciona a barreira global em divergência (Q2).
- **Kill switch:** bloqueio imediato (memória da fila + controlador, antes de qualquer `await`) → barreira durável (`gate.engage`, aguardada) → revoga `queued`/`admitted` do escopo → pede parada do que está em curso.

## 5. Decisões Q1–Q11 aplicadas

| Q | Como foi aplicada |
|---|---|
| Q1 | O ledger da fila é a única fonte persistente. Cada item admitido guarda `run.admission` (id da admissão, aprovações consumidas, custo, teto de tokens, prazos, impressão digital dos limites e do pedido). `restore()` entrega esses registros ao adaptador, que cria o controlador com `restore` (admissões, idempotência, aprovações usadas, vagas, cancelamentos; admissões incertas no rate limit). Nenhum segundo armazenamento. |
| Q2 | Restauração estrita: item do PR 1 em curso, item `admitted`/em curso após abertura de época, impressão digital de limites diferente, aprovação repetida, impressão digital do pedido incoerente ou vaga ocupada fora de `interrupted` → **bloqueado** + `queue.restore_blocked` + barreira global `queue_restore_divergence`. Limites **não** têm persistência comprovada: o controlador restaurado nasce com `DEFAULT_LIMITS` e, se os limites vigentes divergirem dos gravados (ou mudarem durante a sessão), o agendador fica bloqueado (`limits_unproven` / `limits_changed_unpersisted`). Limitação documentada em §11. |
| Q3 | Duas aprovações distintas e de uso único: `sandbox.execute` (componente `sandbox`, no `prepare`) e a da admissão (componente `limits`, `admitWithApproval`). Teste comprova ids diferentes, ambas `consumed`, tentativas em componentes distintos, `item.approvalId` = aprovação da admissão. |
| Q4 | Bloqueio durável via `BarrierGate.engage` (pedido gravado na fila + barreira na autoridade #011); `queued`/`admitted` do escopo → `revoked`; em curso → pedido de parada (`revoked` só com parada confirmada); vagas preservadas sem confirmação; liberação da barreira não reativa nada (terminais imutáveis). |
| Q5 | `classification.ts`: lista explícita de definitivas (política, aprovação inválida, projeto/tarefa, custo/orçamento, parâmetros, execução real desligada…) e recuperáveis (concorrência, rate limit, aprovação pendente, indisponibilidade, não verificado…); **código desconhecido = recuperável**. `queued → failed` adicionado às transições e restrito, no documento, a desfecho `refused_definitive`. |
| Q6 | Sucessor com id novo, chave `retry:<antecessor>`, `retryOf`, `chainAttempt` 2..3, `notBefore` 30 s / 60 s (teto 10 min), nova admissão e novas aprovações. O documento exige antecessor `failed` com desfecho `not_started` reintentável. Só `not_started` comprovado gera reintento; `interrupted`/`revoked`/`cancelled`/incerto nunca. |
| Q7 | `QueueScheduler` não é instanciado no `server/index.ts` (arquivo inalterado; teste estrutural); sem temporizadores; acionado só por `tick()`. |
| Q8 | Estados incertos mantêm `capacity: 'held'`; o documento só permite liberar a vaga com desfecho comprovado; `interrupted` nunca volta a `dispatching`/`running`; nenhuma rota ou mecanismo humano de liberação foi criado. |
| Q9 | `queued`: TTL 24 h (`expiresAt`); `admitted`: 60 s (`dispatchBy`) → `expired` com reserva liberada (nunca despachado). Execução além do prazo: pede parada; a vaga só é liberada se a parada for confirmada. |
| Q10 | `run` é opcional: documentos do PR 1 continuam válidos e legíveis; quando presente é validado por inteiro (sem padrões). Itens do PR 1 nunca ganham `run`, nunca são admitidos, nunca vão a `failed`; `queued` legado expira em 24 h; legado em curso bloqueia a restauração. Nenhuma migração. |
| Q11 | Registrada em §10. Não corrigida; nenhuma issue criada. |

## 6. Garantias G1–G3 (demonstração)

**G1 — Nenhuma execução duplicada**
- Intenção persistida antes do despacho: teste verifica, de dentro do executor, que o item já está `dispatching` com o mesmo token e `attempt = 1`.
- Token único por tentativa (UUID) e único no ledger (validação de relações).
- Executor idempotente por token (mesmo token → mesmo resultado; outro token para o mesmo item → `duplicate_dispatch`, sem tocar o provedor).
- Ciclos simultâneos: o segundo devolve `tick_in_progress`; dois agendadores na mesma fila → um único início (intenção de admissão conferida dentro da transação).
- Reinício: `dispatching`/`running` → `interrupted`; testes de reinício durante o despacho e após início mostram zero novos inícios.
- Incerto → `interrupted`, nunca reintentado.

**G2 — Limites de custo e concorrência preservados**
- Reservas e compromissos reconstruídos (teste: vaga `held`, aprovações e custo restaurados; custo não confirmado continua comprometido; intenções incertas contam no rate limit).
- Nenhuma ampliação: limites divergentes/alterados bloqueiam; restaurar duas vezes é recusado.
- Ocupação preservada após incerto, reinício, cancelamento/kill switch sem confirmação e prazo vencido.
- Orçamento R$ 0: API cobrada → `budget_exceeded` definitiva, nada reservado nem despachado.

**G3 — Nenhuma retomada não autorizada**
- Terminais imutáveis (regra do PR 1, mantida); `revoked` permanece após liberar a barreira e reiniciar; nova tarefa exige novo envio e novas aprovações (teste).
- `interrupted` não volta a executar (documento + teste).
- Reintento só por sucessor, com comprovação de não início e novas aprovações.

## 7. Testes executados

- Novos: **56** (`scheduler.test.ts` 43, `schedulerDocuments.test.ts` 7, `queueAdmission.test.ts` 6), cobrindo os itens 1–19 do pedido (lista nominal em `docs/evidence/issue012-pr2-tests.txt`).
- Suíte completa local: **1134 de 1135** aprovados. A única falha é `scripts/main-audit.test.mjs`, falha **local conhecida e preexistente** no Windows (`core.autocrlf=true` faz checkout dos workflows com CRLF; nenhum workflow foi alterado neste PR; na CI Linux passa).
- TypeScript (`tsc -p tsconfig.server.json` e `tsc -b` no build), ESLint (0 problemas), build (ok), varredura de segredos (`tracked` e `history`: nenhuma credencial), verificações estruturais (`security.test.ts`, `hardening.test.ts`): ok.
- Regressão #011/#020/#021/#022: todas as suítes existentes aprovadas sem alteração.
- CI do GitHub: ver PR.

## 8. Evidências de ausência de execução real

- `REAL_EXECUTION_ENABLED = false as const` (inalterado; teste estrutural).
- O adaptador do executor lança `real_execution_disabled` na criação se o provedor não for `simulated` ou declarar `executesCode` (teste).
- O provedor simulado só registra chamadas (`prepare`/`start`/`destroy`); nada roda.
- `server/index.ts` inalterado; nenhum arquivo de produção importa o agendador; nenhuma rota POST nova; nenhum temporizador ou acesso de rede/subprocesso em `server/queue/` (`docs/evidence/issue012-pr2-checks.txt`).

## 9. Escolhas de implementação a validar (nenhuma amplia permissões)

1. **Ordem das aprovações:** a de execução (`sandbox.execute`) é obtida **antes** da admissão. Motivo: a janela de 60 s entre admissão e despacho (Q9) tornaria impossível aprovar a execução depois de admitir; e o núcleo #011 mantém um único pedido pendente por operação. As duas continuam distintas e de uso único (Q3).
2. **Uma tarefa por vez:** itens da mesma (dono, projeto, tarefa, agente) esperam a vez (`task_busy`, recuperável). Sem isso, dois itens da mesma tarefa substituiriam (`superseded`) o pedido de aprovação um do outro a cada ciclo (livelock observado em teste). Também impede execução paralela da mesma tarefa.
3. **Submit bloqueado** quando o portão/kill switch está fechado (mais restritivo que o mínimo pedido).
4. **`interrupted` com término comprovado** pelo executor libera a vaga mas permanece `interrupted` (o desfecho fica registrado); o encerramento definitivo fica para a confirmação humana futura (Q8).
5. **Admissão incerta** (intenção gravada e reinício antes do registro): o item expira (`admission_uncertain`) e a intenção conta no rate limit.
6. **Falha do provedor após ser chamado** é tratada como incerta (o sandbox não informa se `start()` chegou a iniciar algo): sem reintento, vaga ocupada.
7. Não foi adicionada `admitted → failed`; só `queued → failed` (Q5).

## 10. Q11 — Pendência independente da #011 (registro)

O armazenamento de aprovações (#011) ainda expõe referências internas mutáveis em leituras. **Não** foi corrigido neste PR e **nenhuma issue foi criada**. Recomenda-se uma issue independente para aplicar ao `server/approvals/store.ts` o mesmo tratamento de leituras congeladas adotado na fila (PR 1, R1).

## 11. Riscos residuais e limitações conhecidas

1. **Limites personalizados não persistem** (Q2): qualquer alteração de limites (aprovada) bloqueia o agendador nesta sessão e, após reinício, bloqueia a restauração se houver reservas gravadas com outros limites. Persistir limites exige decisão do PO.
2. **Vaga presa por `interrupted`:** com `maxConcurrent = 1`, um único item incerto bloqueia todas as admissões até haver comprovação do executor ou a futura confirmação humana (não implementada, por Q8). Comportamento intencional e conservador.
3. **Executor em memória:** após reinício o adaptador simulado não conhece execuções anteriores (cancelamento → `not_supported`). Um executor real precisará de idempotência e consulta duráveis.
4. **`onResult` sem autenticação do executor** além do vínculo token/tentativa/época; aceitável só porque não há rota nem executor real. Uma integração futura deve autenticar a origem dos resultados.
5. **Custo de admissões nunca despachadas** continua comprometido no controlador (conservador); o orçamento pode encolher mais que o necessário.
6. **Gravações por ciclo:** enquanto a aprovação da admissão está pendente, cada ciclo grava a intenção e a remove (o ledger inteiro é regravado). Aceitável no volume atual; otimizar se o volume crescer.
7. **Janelas de aprovação:** se a admissão for aprovada mais de 60 min depois da aprovação de execução, o despacho falha como `not_started` (comprovado) e o sucessor exige novas aprovações.
8. **Kill switch do controlador** é em memória; após reinício o bloqueio vem da barreira durável da #011 (o portão a consulta antes de admitir e de despachar).
9. **Múltiplas instâncias:** o bloqueio de processo do armazenamento impede duas instâncias; dois agendadores no mesmo processo só existem em teste.

## 12. Parecer

O PR 2 implementa o agendamento e o controle completos em modo **dormente e simulado**, com G1–G3 demonstradas por testes, CI local verde (exceto a falha preexistente do Windows) e nenhuma execução real habilitada. Os pontos de §9 são escolhas que **restringem** e ficam para validação do revisor e do PO; §11 lista o que permanece fora do escopo aprovado. **Pronto para revisão independente**; não pronto para merge sem a aprovação explícita do PO.
