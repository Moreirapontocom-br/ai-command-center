# Issue #022: orçamento, quotas e kill switch (camada preparatória)

Branch `feature/022-budget-quotas-killswitch`, criada a partir da `main` em `355909fde5774451fd85b1538553695a726a12c3` (merge do PR #41). A CI e a Main audit pós-merge estavam verdes.

**Diretriz do PO (Opção A):** priorizar as assinaturas existentes (ChatGPT Plus, Claude Pro com Claude Code, Gemini, opções gratuitas oficiais do Nemotron), com orçamento adicional de **R$ 0**.

**Esta camada:**
- não autentica em contas de IA, não chama APIs (nem pagas, nem gratuitas), não executa código e não tem rota HTTP;
- não usa automação de navegador, cookies ou sessões;
- não gera nenhum custo.

`REAL_EXECUTION_ENABLED` (#021) continua `false`.

## 1. O que foi implementado (`server/limits/`)

| Arquivo | Conteúdo |
| --- | --- |
| `contracts.ts` | Modos de uso, classes de cobrança, perfil de provedor, limites (`DEFAULT_LIMITS`, congelado), tetos rígidos, admissão, situação de custo, aprovação humana, kill switch e entrada de auditoria |
| `providers.ts` | Catálogo de provedores do servidor. **Tudo começa `unverified`**, e a classificação de cobrança é conservadora |
| `validation.ts` | Validação estrita do pedido de admissão, dos limites e do formato da aprovação humana. Campos extras são recusados, e assim o chamador não consegue declarar gratuidade, saldo ou cobrança |
| `controller.ts` | Admissão, quotas, orçamento (reserva e reconciliação), kill switch, relatos de provedor, alteração de limites e registro auditável |
| `simulatedApprovalVerifier.ts` | Verificador de aprovações **simulado**, só para testes. Reconhece apenas as aprovações que o próprio teste "emitiu". **Não é confiável** e nenhum código de produção o importa |
| `limits.test.ts` | 71 testes |

Além disso, `server/security.test.ts` tem um teste estrutural: o módulo não usa `fs`, rede, subprocessos, `vm`, `eval`, sandbox, cookies nem `process.env`; nada fora dele o usa; e não existe rota de limites, orçamento, kill switch ou gasto.

## 2. Modos de uso: assinatura × API

| Modo | O que é | Custo adicional | Tokens |
| --- | --- | --- | --- |
| `subscription_assisted` | Uso **assistido e explícito** de ferramenta incluída numa assinatura: a pessoa usa a ferramenta, e o ACC organiza e limita | `included` para ChatGPT, Claude Code e Gemini. `unknown` (bloqueado) para Nemotron, que não tem assinatura do PO | **Nenhuma quota presumida.** Pedir teto de tokens ou informar consumo de tokens é recusado (`tokens_not_applicable`) |
| `official_integration` | Integração oficial autorizada pelo provedor, com condições próprias | `unknown` (bloqueado) até a #028 apurar condições e limites | Nenhuma quota presumida |
| `metered_api` | API com consumo mensurável e possível cobrança separada | `metered`. Exige estimativa, aprovação de `spend.create` e orçamento. Créditos gratuitos **não** são presumidos | Teto conservador de **20.000** tokens por tarefa (configurável). Não representa saldo de assinatura |

Escolher um modo **não** prova que a conta ou o provedor oferece a capacidade. O catálogo do servidor decide (`status`), e no padrão todas as combinações estão `unverified` (`provider_unverified`).

## 3. Garantias de orçamento e quotas

**Limites iniciais (`DEFAULT_LIMITS`)**
- Orçamento global de R$ 0.
- 1 execução simultânea.
- 10 minutos de duração lógica por tarefa.
- 30 admissões por hora (limite de solicitações do próprio ACC).
- 20.000 tokens por tarefa, só em `metered_api`.

**Tetos rígidos:** nem com aprovação os limites passam de 4 simultâneas, 30 minutos, 500 solicitações por janela, R$ 100.000 e 200.000 tokens.

**Custo:** quem decide é sempre o servidor, nunca o chamador.
- Cobrança `unknown`, ou inconsistente com o modo, resulta em `cost_unknown` (bloqueado).
- Em `metered_api`, estimativa ausente é recusada (`cost_estimate_required`), e estimativa **zero** é tratada como alegação de gratuidade e recusada (`free_claim_not_trusted`).
- Custo acima de zero exige a ação crítica `spend.create` da #020. No catálogo real ela é `available: false`, o que dá `paid_usage_unavailable` mesmo com orçamento. Com o catálogo de teste, ela exige aprovação exata e de uso único (`spend_approval_required` ou `spend_approval_invalid`).
- Depois disso o orçamento é conferido: global (`budget_exceeded`) e as restrições opcionais por projeto e por provedor (`project_budget_exceeded`, `provider_budget_exceeded`), que só restringem.
- Conclusão: **em produção nenhuma operação paga é admitida**.

**Reserva e reconciliação**
- A estimativa é reservada na admissão (`estimated`).
- No encerramento, o valor informado pelo provedor vira `confirmed`. Um confirmado menor libera a diferença; um confirmado maior gera o alerta `budget_overrun`.
- Se o provedor não informar, o custo fica `unknown` e a reserva continua contando. Nenhum valor é inventado.
- Cobrança informada num modo `included` gera o alerta `unexpected_charge`, e tokens acima do teto geram `token_ceiling_exceeded`.
- `budgetSummary()` separa os valores estimado, confirmado e desconhecido.

**Admissão:** a ordem das verificações é esta (a primeira que falha decide):
1. validação estrita;
2. idempotência;
3. expiração preguiçosa das vencidas;
4. kill switch;
5. projeto e tarefa ativa;
6. provedor (status, relato oficial, limite oficial de solicitações);
7. cobrança;
8. concorrência;
9. rate limit;
10. política da #020 para a ação, com aprovação de uso único;
11. gasto e orçamento;
12. só então a reserva e o consumo das aprovações.

**Concorrência:** a admissão é **síncrona** (nenhum `await` entre verificar e reservar). Pedidos concorrentes no mesmo processo nunca se intercalam: não há reserva dupla nem duas vagas. Isso é testado com pedidos disparados juntos.

**Idempotência:** a chave do chamador vale por dono. O mesmo pedido devolve a mesma admissão, mesmo já encerrada, sem nova reserva. A mesma chave com outro conteúdo dá `idempotency_conflict`. Pedidos recusados não ocupam a chave.

**Duração:** pedido acima do limite é recusado (`duration_out_of_limits`). Encerrar no prazo ou depois dá `expired`. As admissões vencidas são expiradas, tanto na próxima admissão quanto por `expireOverdue()`, e o cancelamento é pedido a quem hospeda a execução. A vaga, porém, só volta conforme a seção 4. Reserva não confirmada passa a `unknown`.

**Concorrência conta vagas ocupadas, não estados ativos (correção R2).** Cada admissão tem `capacity: 'held' | 'released'`, separado do estado lógico:
- **libera a vaga:** o término informado por quem executa (`complete`); o cancelamento com resultado `cancelled`; ou a confirmação explícita de parada (`confirmStopped`), feita pela pessoa dona do projeto ou pelo host e auditada;
- **mantém a vaga ocupada:** cancelamento `failed`, `not_supported` ou ainda `pending`. A operação pode continuar ativa, então nova admissão recebe `concurrency_limit`;
- **repetir o pedido:** `cancel()` numa admissão já encerrada sem interrupção confirmada repete o pedido, sem mudar o estado. Um pedido em andamento nunca é duplicado;
- **consulta:** `capacityInUse()` mostra as vagas ocupadas; `activeCount()` mostra só as admissões ainda `admitted`.

**Provedores (correção R3):** indisponibilidade temporária e quota oficial de solicitações são relatos **separados**.
- `reportProviderUnavailable(provider, mode, { reason, until })` bloqueia (`provider_unavailable`) até o prazo.
- `reportProviderQuota(provider, mode, { reason, count, windowSeconds, until })` registra uma quota **sem** declarar o provedor indisponível.
- **Todas** as quotas vigentes se aplicam, junto com o limite do catálogo (`provider_request_limit`). Uma quota mais generosa não substitui uma anterior mais restritiva nem amplia o catálogo, e cada uma expira no seu prazo.
- Há no máximo 20 quotas vigentes por provedor e modo; acima disso, `too_many_quotas`.
- Nenhum relato torna disponível um provedor `unverified`: `effectiveStatus` nunca é mais permissivo que o catálogo.

## 4. Kill switch

- **Acionamento:** global ou por projeto, por pessoa autenticada (o projeto precisa ser dela) ou pelo próprio sistema. Agentes recebem `invalid_actor`.
- **Bloqueio imediato:** o estado muda **antes** de qualquer `await`, então novas admissões são recusadas (`kill_switch_engaged`) até enquanto os pedidos de cancelamento ainda estão em andamento.
- **Admissões ativas no escopo:** passam a `cancelled` (motivo `kill_switch`), e o cancelamento é **pedido** a quem hospeda a execução (`cancelHandler`). O resultado é registrado com honestidade: `cancelled`, `not_supported` (sem handler) ou `failed`. Não há garantia de interrupção física de provedor externo.
- **Vagas:** só `cancelled` libera a vaga (R2). Um novo acionamento também repete o pedido para as operações encerradas cuja interrupção nunca foi confirmada. Reativar o kill switch não libera vagas ocupadas.
- **Reativação:** só por pessoa autenticada, com aprovação humana `killswitch.release` para o escopo exato (`global` ou o id do projeto). A aprovação é de uso único e tem validade de no máximo 24 h. Ids de agentes são recusados como aprovador. Reativar o global não reativa um projeto, e o inverso também vale.
- **Alteração de limites:** exige aprovação humana `limits.change` cujo alvo é a impressão digital (SHA-256) dos limites **exatos** propostos, também de uso único e com validade.
- **Autenticidade das aprovações (correção R1):** campos, datas e alvo válidos **não** tornam uma aprovação autêntica. O contrato `ApprovalVerifier` (`verify(approval) → { authentic, approverId } | { authentic: false, reason }`) é síncrono e compatível com o fluxo persistente da #011.
  - **sem verificador** configurado (a situação atual de produção): alteração de limites e reativação são **negadas** (`approval_verifier_unavailable`);
  - **origem não atestada:** aprovação não emitida, adulterada ou com falha do verificador dá `approval_not_authentic`;
  - **identidade:** se o aprovador autenticado for diferente do declarado, ou for um agente, dá `approver_identity_mismatch`;
  - **regras de antes continuam:** uso único, validade máxima, alvo exato e auditoria seguem valendo depois da verificação. Tentativas recusadas não consomem a aprovação;
  - **testes:** usam `createSimulatedApprovalVerifier()`, que é explícito. O controlador não o importa (teste estrutural).
- **Auditoria:** todas as decisões e resultados vão para o registro auditável (`auditTrail()`) e para o logger: admissões, recusas, repetições idempotentes, expirações, alertas de custo, acionamento e reativação, alterações de limites, relatos de provedor e resultados de cancelamento. O registro guarda só tokens e ids, nunca texto livre, credenciais ou conteúdo. Motivos fora do formato viram `unspecified` ou `invalid_reason`.

## 5. Integração com as outras issues

- **#020:** reutiliza `evaluatePolicy` para a ação admitida e para `spend.create`, incluindo a invariante de agente atribuído, as regras fixas e as aprovações de uso único. A política e o catálogo da #020 **não** foram alterados.
- **#021:** os contratos do sandbox não mudaram, `REAL_EXECUTION_ENABLED` continua `false` e o controlador não usa o sandbox.
- **#011, #012, #028, #031:** nada foi antecipado (ver a seção 7).

## 6. Testes

`server/limits/limits.test.ts`, 71 testes (51 da entrega inicial e 20 das correções R1, R2 e R3):
- **padrões do PO:** catálogo real sem nenhuma admissão em nenhum modo e provedor; classificação conservadora de cobrança; execução real desabilitada;
- **R$ 0 e operações pagas:** operação paga sem autorização; `spend.create` indisponível no catálogo real; alegações de gratuidade e campos declarados pelo chamador; custo desconhecido;
- **orçamento:** reserva concorrente; reconciliação (confirmado menor, confirmado maior, desconhecido); restrições por projeto e por provedor; teto de tokens da API;
- **assinaturas:** sem saldo de tokens; sem consumo inventado; alerta de cobrança inesperada; fluxo sem custo;
- **admissão:** permissões da #020 (agente não atribuído, aprovação de ferramenta de uso único, push na main); isolamento por dono; idempotência, inclusive com reserva; limite de 1 simultânea; duração; expiração (com e sem `expireOverdue`); rate limit; estados terminais;
- **provedores:** indisponibilidade com prazo; relatos que só restringem; limite oficial de solicitações; provedor indisponível no catálogo;
- **kill switch:** global (bloqueio antes do fim dos cancelamentos) e por projeto; resultados `failed` e `not_supported`; agente e outro dono recusados; 8 formas de reativação inválida; reativação válida, uso único e independência entre escopos;
- **limites:** sem aprovação, aprovação para outros limites, ator não humano, acima do teto, campo extra; aplicação válida e uso único;
- **dados e credenciais:** segredos em motivos, chaves e aprovações ausentes do registro e dos logs; erros só com códigos; cópias defensivas;
- **R1:** sem verificador (produção) a mudança é negada; aprovação forjada; aprovação adulterada (alvo, validade, operação); identidade divergente (outra pessoa ou agente); verificador que lança exceção ou devolve motivo fora do formato; uso único, validade e alvo com aprovação autêntica;
- **R2:** cancelamento `failed`, `not_supported` e `pending`; nova tentativa; confirmação explícita de parada (dono, host, agente, outro dono); expiração sem confirmação; expiração com admissões concorrentes; kill switch com cancelamento não confirmado e após reativação; novo kill switch repetindo o pedido; `complete` liberando a vaga;
- **R3:** quota sem indisponibilidade; expiração da quota; quota mais generosa não amplia; quota e indisponibilidade independentes; relatos sobre provedor não verificado.

Também conferi que os testes detectam falhas:
- removendo a checagem do kill switch, 2 falham;
- removendo o bloqueio de custo desconhecido, 1 falha;
- contando concorrência por estado em vez de vaga ocupada (R2), 6 falham;
- ignorando o resultado do verificador (R1), 3 falham;
- deixando uma quota nova substituir as anteriores (R3), 1 falha.

## 7. Limitações e dependências futuras

- **Estado em memória:** limites, admissões, reservas, aprovações usadas e **o próprio kill switch** se perdem num reinício. Antes de qualquer operação real são necessários persistência e recuperação (#012) e aprovações persistidas (#011). Até lá, nada usa o controlador.
- **Aprovação humana:** não existe ainda verificador confiável. Por isso, em produção, **alteração de limites e reativação do kill switch estão negadas**: um kill switch acionado só é desfeito reiniciando o processo (o estado é em memória) até a #011 entregar o verificador. O controlador também não separa quem pede de quem aprova, algo pensado para o uso pessoal de um único PO.
- **Aprovações da #020 sem verificador:** as aprovações `ApprovalGrant` usadas na admissão (`tool.use`, `spend.create`) seguem o modelo da #020 e ainda não passam por verificador de origem. Hoje isso não abre nada em produção, porque essas capacidades estão indisponíveis no catálogo real. A verificação delas fica para a #011.
- **Vagas presas:** uma vaga sem interrupção confirmada fica ocupada até haver confirmação (`cancelled`, `confirmStopped` ou `complete`). Isso é intencional, mas exige ação humana ou do host em uso assistido, em que o ACC não tem como parar nada sozinho.
- **Aprovações separadas das do sandbox:** o conjunto de aprovações já usadas é próprio do controlador, separado do conjunto do sandbox. Unificar fica para a #011.
- **Orçamento sem período:** o orçamento é um total acumulado, sem reinício mensal, e só em BRL, sem conversão de moeda. Reinício e conversão dependem de persistência e de decisão do PO.
- **Ainda não configuráveis:** retry e backoff ficam para as filas (#012) e para o Agent Gateway (#028).
- **Cancelamento:** é um pedido, não uma garantia. Um provedor externo pode continuar, e a admissão é marcada `cancelled` no ACC com o resultado do pedido registrado.
- **Escopo do rate limit e da concorrência:** valem para todo o ACC, em um processo. Com vários processos seria preciso estado compartilhado.
- **#028:** verificar oficialmente cada ferramenta e plano, inclusive limites e termos, e só então marcar perfis `available`. Isso é feito por PR revisado, nunca em tempo de execução.
- **#031:** provedor de execução isolada.

## 8. Custos

- Gastos adicionais: **zero**.
- Nenhuma API paga ou gratuita foi chamada.
- Nenhum serviço foi contratado.
- Nenhuma conta de IA foi acessada.
