# Issue #011 — PR 2: integração das aprovações humanas e interface mínima

**Base:** `main` em `0764dc8040f7cca8a71f4f1bd4e4b925209c0ab2` (merge do PR #43, PR 1).
**Branch:** `feature/011-approvals-integration`.
**Escopo:** apenas o PR 2 da Issue #011 (decisão D10). Sem merge, sem deploy, sem custo, sem execução real e sem nenhuma outra issue.

## 1. Resumo

O núcleo do PR 1 agora está ligado a quatro pontos:

1. **Rotas do administrador** (`server/http/approvalRoutes.ts`). A identidade vem da sessão e cada requisição passa por CSRF. A confirmação por senha gera uma prova de uso único, presa à sessão e válida por 5 minutos. Com ela o administrador decide sobre o vínculo exato: aprovar, rejeitar ou revogar. Também há rotas para histórico, preservação, retenção e descarte.
2. **Sandbox (#021).** Ele registra o pedido de aprovação no núcleo e só autoriza com um grant reservado cujo recibo é validado pelo verificador confiável. Um grant informado pelo chamador nunca basta.
3. **Controlador (#022).** Vale o mesmo para admissões. O kill switch aciona a barreira do núcleo. A liberação e a alteração de limites exigem uma aprovação de configuração reservada.
4. **Interface mínima:** a página **Aprovações**.

Nada disso executa algo. `REAL_EXECUTION_ENABLED` continua `false as const`, as 7 capacidades críticas continuam `available: false`, e uma aprovação nunca transforma uma capacidade `UNAVAILABLE` em `AVAILABLE`.

## 2. Arquitetura implementada

```
navegador (página Aprovações)
   │  cookie HttpOnly + Origin/Sec-Fetch-Site + JSON (CSRF)      ← nunca envia userId/approvedBy
   ▼
server/http/app.ts ── autenticação (401) ── server/http/approvalRoutes.ts
                                               │ identidade = {session.userId, SHA-256(token)}
                                               │ step-up (senha) → prova de uso único (5 min)
                                               ▼
                              server/approvals/service.ts (núcleo PR 1 + leitura/configure/atestado)
                                   ▲ request/reserve/recordOutcome      ▲ verifierFor('sandbox'|'limits'|'policy')
                                   │                                     │
                  server/sandbox/service.ts (#021)        server/limits/controller.ts (#022)
                  (pedido, authorizeWithApproval,          (admitWithApproval, verifyGrant na admissão,
                   verificação de origem do grant)          onKillSwitchEngaged → barreira, liberação/limites
                                                            com aprovação de configuração)
                  política (#020): pura; owner_confirmation só com atestado do servidor
```

- **A política (#020) continua pura.** Ela não conhece credenciais, sessões nem armazenamento. A origem do grant é verificada por quem o consome, pelo recibo do núcleo. A exceção `owner_confirmation` vale apenas com `PolicyFacts.verifiedOwnerConfirmationId`, e esse valor só é obtido por `attestOwnerConfirmation`, que exige um recibo válido do componente `policy`. Nenhum campo nem cabeçalho do cliente ativa a exceção.
- **A ordem de verificação é sempre a mesma:** política primeiro, depois a origem do grant e, sem `await` no meio, a transição. Se a política recusa, nenhum recibo é gasto.
- **Indisponível é recusado antes de pedir ou reservar.** O sandbox e o controlador avaliam a política sem aprovação antes. Com `UNAVAILABLE` ou `DENY`, nenhum pedido é criado e nenhuma aprovação é consumida.

## 3. Endpoints

Todos exigem a sessão do administrador. Os POST passam antes por Host/Origin, `Sec-Fetch-Site` e `Content-Type: application/json`. Os corpos têm chaves fechadas: qualquer campo extra resulta em 400. O limite de corpo é 4 KiB.

| Método | Rota | Corpo | Observação |
|---|---|---|---|
| GET | `/api/approvals` | — | Lista do dono e estado do subsistema: disponibilidade, barreiras e `realExecutionEnabled: false` |
| GET | `/api/approvals/:id` | — | Vínculo exato, `bindingDigest`, `presentable`, tentativas e preservações |
| POST | `/api/approvals/step-up` | `{password}` | Gera a prova `{proofId, expiresAt}`. Bloqueia após 5 falhas por 15 min. No máximo 2 verificações scrypt simultâneas |
| POST | `/api/approvals/:id/approve` | `{bindingDigest, proofId}` | O resumo enviado é o recalculado pelo navegador |
| POST | `/api/approvals/:id/reject` | `{bindingDigest, proofId}` | |
| POST | `/api/approvals/:id/revoke` | `{proofId}` | `approved → revoked`. Um recibo pendente é invalidado |
| POST | `/api/approvals/owner-confirmations` | `{operation:'approvals.retention_change', days, proofId}` | Só retenção (30 dias a 5 anos) |
| POST | `/api/approvals/attempts/:id/acknowledge` | `{proofId}` | Tentativa `indeterminate → acknowledged_by_owner`. Nada é repetido |
| GET | `/api/approvals/history` | `?before&limit&approvalId` | Histórico oficial, sem MAC nem `detail`, com preservações |
| POST | `/api/approvals/history/holds` | `{approvalId, reason, note?, proofId}` | Motivos fixos. Observação de até 200 caracteres, saneada, nunca auditada |
| POST | `/api/approvals/history/holds/:id/remove` | `{proofId}` | A rota administrativa estritamente necessária para retirar uma preservação |
| POST | `/api/approvals/history/purge` | `{before, proofId}` | Só entradas com mais de 30 dias e sem preservação |

**Nenhuma rota** executa agentes, admite operações, inicia sandbox, aciona ou libera o kill switch (N9), recupera o armazenamento, altera limites ou ativa capacidades. O teste estrutural garante isso pela lista exata de POST e por padrões proibidos.

**Erros.** A resposta leva só um código público e uma mensagem fixa: `approvals_unavailable` 503, `confirmation_failed` 403, `confirmation_required` 403, `confirmation_locked` 429, `approval_conflict` 409, `approval_expired` 409, `approval_binding_mismatch` 409, `approval_blocked` 423, `not_found` 404 ou `bad_request` 400. O código interno do núcleo nunca é exposto.

## 4. Fluxos de autenticação e confirmação

1. **Sessão.** A sessão é a da #003: cookie `HttpOnly; SameSite=Strict`, um único administrador, inatividade de 30 min e validade absoluta de 8 h.
2. **Identidade.** É derivada no servidor: `userId` da sessão e `sessionKey = SHA-256(token)`. Agentes não têm sessão, e `assertHumanContext` recusa ids de agentes.
3. **Step-up.** A senha é verificada com scrypt pelo `verifyPassword` da #003. Isso gera uma prova aleatória de 256 bits, de uso único, presa a `userId` e `sessionKey`, válida por 5 minutos e mantida só em memória. Cinco falhas bloqueiam novas confirmações por 15 min. Uma nova confirmação substitui a prova anterior da mesma sessão.
4. **Fim da prova.** Logout e novo login encerram as provas da sessão. Reiniciar o servidor invalida todas.
5. **O que não é registrado.** Senha, prova, cookie e chave nunca vão para logs, auditoria ou respostas, o que um teste verifica com valores canário.
6. **Preparação para TOTP/WebAuthn.** `CONFIRMATION_METHODS` já prevê `totp` e `webauthn`, e a interface `IdentityConfirmer` é plugável. Nada disso foi implementado.

## 5. Interface (página Aprovações)

- **Lista.** Mostra projeto, operação, solicitante (componente do servidor ou pessoa), sujeito, estado, data da solicitação e prazo de expiração. Pendentes aparecem primeiro.
- **Detalhes.** Mostram projeto, recurso, operação e classe, sujeito, SHA, ref, resumo dos parâmetros, versão da política, prazos e resumo do vínculo. Os parâmetros aparecem apenas como resumo, com aviso explícito de que não há descrição legível confiável: nada é inventado.
- **Conferência da apresentação.** O navegador recalcula o resumo do vínculo a partir dos campos que exibe (`shared/approvalDigest.ts`, SHA-256 local, sem dependência). A decisão só é liberada se esse resumo for igual ao do servidor e se `presentable` for `true`. Do contrário, aprovar fica bloqueado. O teste `sharedDigest.test.ts` garante que o cálculo do navegador é idêntico ao do núcleo.
- **Decisões.** Aprovar, rejeitar, revogar, reconhecer tentativas, preservar ou retirar preservação, alterar retenção e descartar: todos usam o mesmo formulário de senha. A senha é apagada do campo logo após o envio e nunca é guardada no navegador.
- **Estados.** Os 8 estados aparecem com o nome técnico entre parênteses. "Aprovada, não utilizada" e "Consumida — uso reservado" nunca são apresentados como execução. O aviso fixo diz que aprovar não executa nada.
- **Avisos.** A página indica quando o subsistema está indisponível ou degradado e quando o bloqueio global de emergência está ativo.

## 6. Integrações

### 6.1 Política (#020)

- O motor não foi alterado. Os grants são verificados por quem os consome.
- `attestOwnerConfirmation(grant)` devolve o id para `verifiedOwnerConfirmationId` apenas com um recibo válido do componente `policy` para um grant `owner_confirmation`.
- A confirmação do PO pela web não cobre ações críticas nesta fase. Elas continuam indisponíveis e não há consumidor para elas.

### 6.2 Sandbox (#021)

- **Novas opções.** O serviço passa a receber `approvalVerifier`, o verificador de origem (`verifierFor('sandbox')`), e `approvals`, o coordenador com `request`, `reserve` e `recordOutcome`.
- **Pedido.** Quando a política exige aprovação, `request` registra o pedido no núcleo antes de criar o registro. Se o núcleo estiver indisponível, nada é criado.
- **Vínculo.** É composto por `sandbox.execute`, projeto, tarefa, SHA base, branch de trabalho, agente, resumo de parâmetros e versão da política. O resumo de parâmetros cobre id, repositório, rede, credenciais, limites e entradas.
- **`authorizeWithApproval`.** Recusa antes de qualquer pedido quando a capacidade está indisponível ou negada. Depois obtém o pedido, que é idempotente. Se ele estiver aprovado, faz a reserva de uso único, verifica a origem, autoriza e registra o resultado. Em caso de falha, registra `failed` e a aprovação continua consumida.
- **`authorize(grant)`.** Agora exige verificação de origem. Sem verificador, a resposta é `approval_verifier_unavailable`.
- **Inalterado:** isolamento por dono, projeto, tarefa e agente; rede negada por padrão; limites; credenciais mínimas; nenhum provedor real; `start` recusado para provedor que executa código. Nenhuma rota usa o sandbox.

### 6.3 Controlador (#022)

- **Origem dos grants na admissão.** `admit` passa a verificar a origem de cada grant aceito pela política (`verifyGrant`). Isso acontece depois de todas as outras verificações e antes da reserva de vaga, sem `await` no meio. Sem verificador, a resposta é `approval_verifier_unavailable`.
- **`admitWithApproval`.** Usa o mesmo fluxo do sandbox, com componente `limits`. Uma nova admissão exige uma nova aprovação.
- **Kill switch.** `onKillSwitchEngaged` é chamado de forma síncrona ao acionar o kill switch:
  - a barreira do núcleo é ativada em memória imediatamente e depois gravada;
  - aprovações de execução não usadas são revogadas;
  - recibos pendentes são invalidados.

  Uma falha nesse passo nunca impede o acionamento.
- **Liberação e limites.** `releaseKillSwitchWithApproval` e `updateLimitsWithApproval` exigem a aprovação de configuração exata (15 min, uso único, nascida de `confirmOwner`). A liberação com sucesso libera também a barreira durável. A liberação não reativa aprovações revogadas. Nenhuma rota HTTP chama esses métodos (N9).
- **Inalterado:** orçamento de R$ 0, `spend.create` indisponível no catálogo real, cobrança desconhecida bloqueada, `confirmStopped` obrigatório para liberar vaga. A persistência do controlador continua na Issue #012.

### 6.4 Alterações no núcleo da #011 (justificadas)

- **`service.ts` (só adições):**
  - leitura: `get`, `attemptsOf`, `history`, `policyVersion`;
  - `configure`, que faz confirmação do PO, reserva interna e aplicação para retenção e descarte, montando o vínculo no servidor;
  - `attestOwnerConfirmation`;
  - o tipo `ApprovalCoordinator`.

  Nenhuma regra do PR 1 foi relaxada.
- **`paths.ts` (só aperta a regra):** as verificações de Git e de pasta sincronizada agora rodam também **antes** de criar o diretório. Antes, um caminho recusado deixava uma pasta vazia, o que foi observado no teste de fumaça. A verificação pelo caminho real, depois da criação, continua.
- **`maintenance.ts` (novo):** agendador do `sweep`. Um ciclo em curso faz o seguinte ser pulado, nunca enfileirado. Falhas não interrompem os ciclos. O temporizador usa `unref`.

## 7. Auditoria e histórico

- **Histórico oficial.** É o do núcleo, encadeado por hash e somente de acréscimo, gravado na mesma operação atômica da decisão. Não existe decisão sem o seu registro oficial: se a gravação falha, nada muda e o armazenamento fica degradado. Esse histórico não depende do limite por quantidade da #006.
- **Espelho na #006.** As ações `approval.confirmation`, `approval.decision`, `approval.attempt_acknowledged`, `approval.configuration` e `approval.hold` são espelhadas. O recurso usado é `approval`, e a chave de contexto `operation` foi adicionada. Só entram tokens e números: nunca senha, prova, observação ou e-mail. Recusas também são espelhadas, com `blocked` ou `failure`. Se o espelho falhar, o erro vai para o log e nada é desfeito, porque o oficial já foi gravado.
- **Retenção (D7/N10).** O padrão é 365 dias, com limites de 30 dias a 5 anos, alterável só pela confirmação do PO. O descarte gera lápides verificáveis e respeita preservações (N8). A compactação dos terminais ocorre após 30 dias (N7).
- **Manutenção.** Roda a cada 60 s, sem execuções simultâneas. Entre processos, o bloqueio de escritor único impede um segundo servidor.
- **Acesso.** Agentes não têm acesso: não têm sessão, e as rotas exigem o administrador.

## 8. Configuração e inicialização

| Variável | Regra |
|---|---|
| `ACC_APPROVALS_DIR`, `ACC_APPROVALS_ANCHOR_DIR` | Absolutos, distintos, fora do Git e de pastas sincronizadas. O caminho efetivo é validado ao abrir |
| `ACC_APPROVAL_KEY` **ou** `ACC_APPROVAL_KEY_FILE` | Chave HMAC de pelo menos 32 bytes. As duas ao mesmo tempo são recusadas |
| `ACC_APPROVALS_INITIALIZE=if_absent` | Primeira instalação explícita |

- **Sem nenhuma variável,** o subsistema fica desligado. A página informa `not_configured` e o resto do ACC funciona.
- **Com configuração incompleta ou ambígua,** o estado é `invalid` com um motivo em forma de token. O valor recebido nunca é repetido.
- **Com caminho inseguro, chave errada ou arquivos corrompidos,** o subsistema fica **indisponível** e nega tudo. O servidor continua no ar para o que não depende dele.
- **Instalação nova.** Começa sempre com a **barreira global ativa** (PR 1). Nesta fase a liberação não é exposta na web (N9), então, em produção, aprovações de execução continuam bloqueadas. Hoje nenhum componente de produção faz pedidos de execução, porque sandbox e controlador não têm instância nem rota. Rejeitar, retenção, preservação e descarte funcionam com a barreira ativa.
- **Retenção** não é configurada por variável de ambiente, porque isso contornaria a aprovação exigida pela N10.
- **Logs.** No log aparecem só o estado e o motivo. Os encerramentos `SIGINT` e `SIGTERM` liberam o bloqueio.

**Teste de fumaça no servidor real** (`node server/index.ts`, credenciais em branco, diretórios temporários):

- Com configuração válida: `approvals_opened`, `available`, `globalBarrier: true`. `/api/auth/session` responde 200 e a chave não aparece na saída.
- Com o diretório dentro do repositório no OneDrive: `unavailable`, motivo `path_in_synced_folder`. Nenhuma pasta é criada e o servidor continua respondendo.
- Com configuração parcial: `approvals_config_invalid` com `directories_required`.

## 9. Testes

**Testes adicionados (54):**

| Arquivo | Testes | Grupos |
|---|---|---|
| `server/http/approvals.test.ts` | 20 | A (sessão, CSRF, origem, campos extras, identidade declarada, senha errada, bloqueio, prova expirada, reutilizada ou de outra sessão, logout, concorrência scrypt), B (lista e detalhe, aprovar, rejeitar, revogar, expiração por classe, pedido de 24 h, SHA e parâmetros alterados, resumo divergente, outro contexto, bloqueio inicial), D (reinício e tentativa indeterminada, armazenamento corrompido), E/F (vazamentos, nenhuma rota de execução) |
| `server/approvals/integration.test.ts` | 20 | C (sandbox: pendente, aprovado, uso único; grant forjado, de outro componente ou já usado; sujeito incompatível; execução real recusada; indisponível continua indisponível; falha após reserva. Controlador: admissão aprovada, grant forjado, R$ 0, kill switch revoga e invalida, liberação de configuração de 15 min e uso único sem reativação. Política: `owner_confirmation` atestado, forjado e de agente; agente não se autoaprova), D (barreira durável após reinício, lock concorrente, chave errada, anchor inconsistente, recuperação e quarentena, falha de gravação, agendador sem concorrência, expiração pela manutenção) |
| `server/approvals/sharedDigest.test.ts` | 2 | SHA-256 local igual ao do Node. Resumo do navegador igual ao do servidor |
| `server/config.test.ts` | +4 | Configuração das aprovações |
| `src/features/approvals/Approvals.test.tsx` | 8 | E (lista, detalhes corretos, aprovação com senha, rejeição, atualização de estado, apresentação não validada, mensagens seguras, sem senha na página, indisponível e bloqueio) |

**Testes existentes ajustados (sem remover nem enfraquecer):**

- **`server/sandbox/sandbox.test.ts` e `server/limits/limits.test.ts`.** Como sandbox e controlador agora **recusam** grants sem verificação de origem, os grants dos testes passaram a ser "emitidos" pelo dublê simulado (`issueGrant`), que existe só em testes. Todos os 174 testes continuam com as mesmas asserções. Num teste de reutilização do sandbox, o grant modificado também é emitido pelo dublê, porque ali o que se testa é o prazo e não a origem.
- **`server/security.test.ts`.** As asserções "PR 1 dormente" (nada importa o núcleo, nenhuma rota de aprovação) foram substituídas por versões **mais estritas** do PR 2:
  - a lista exata de POST, com padrões proibidos: execução, sandbox, admissão, kill switch, barreira, liberação, limites, gasto, merge, deploy, segredos e permissões;
  - a lista exata de quem importa o núcleo: `server/http/approvalRoutes.ts`, `server/index.ts`, `server/limits/controller.ts` e `server/sandbox/service.ts`;
  - a garantia de que as rotas não chamam `reserve`, `recordOutcome`, `engageBarrier`, `releaseBarrier` nem `recover`;
  - a garantia de que nenhum código do servidor importa o verificador simulado nem o provedor simulado.

  As asserções de sandbox, limites e política permanecem inalteradas.
- **`server/approvals/approvals.test.ts`.** O teste de caminhos protegidos ganhou asserções de que o diretório recusado não é criado.

**Resultados locais:**

- **Testes:** 968, sendo 914 da `main` mais 54 novos. Passaram 967. A única falha é `scripts/main-audit.test.mjs › a auditoria roda em push na main…`, a conhecida de CRLF: com `core.autocrlf=true`, o workflow é checado como CRLF (`git ls-files --eol` mostra `i/lf w/crlf`). Ela se reproduz na `main` limpa e passa na CI (LF). Nenhum arquivo da `main` foi alterado por causa disso.
- **Build e checagens:** typecheck (`tsc -b`) e lint (`eslint .`) passaram. `npm run build` passou. `check:secrets`, `check:csp` e `check:secrets:repo` encontraram 0 credenciais.

## 10. Riscos residuais e limitações intencionais

1. **A liberação da barreira inicial não está exposta na web** (N9). Em produção, aprovações de **execução** ficam bloqueadas até uma decisão do PO sobre como expor essa liberação. Hoje não há quem peça execução em produção.
2. **Os parâmetros são exibidos só como resumo.** Uma descrição legível confiável exigiria guardar os parâmetros canônicos no pedido, o que é uma decisão de formato para uma fase futura.
3. **Single admin.** As rotas exigem `ADMIN_USER_ID`. Com múltiplos usuários, a visibilidade do histórico da instância precisará ser revista.
4. **Provas e recibos ficam só em memória.** Reiniciar invalida provas, e tentativas em curso viram `indeterminate`. Esse é o comportamento desejado (N1).
5. **Espelho da #006 é de melhor esforço.** Se o espelho falhar, o oficial permanece e o log registra a falha.
6. **ACL de arquivo de chave no Windows** não é verificada (limitação herdada do PR 1, documentada).
7. **A interface é mínima,** sem paginação do histórico (o servidor pagina).

**Dependências da #012:** persistência do controlador (limites, kill switch e admissões), filas, e a integração com o Agent Gateway (#028) para que sandbox e controlador tenham instâncias reais. **Limitações de execução real:** `REAL_EXECUTION_ENABLED = false`, nenhum provedor real, e nenhum endpoint que execute, admita ou inicie qualquer coisa.
