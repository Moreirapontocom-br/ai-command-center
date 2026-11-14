# Issue #020: políticas de autonomia e classificação de risco

Branch `feature/020-autonomy-policy`, criada a partir da `main` em `69aa08148dae6fb10d31b8079cb7f98df2b1cbcf` (merge do PR #39, com CI e Main audit verdes). Autonomia oficial: **semiautomática (B)**. O Product Owner é a autoridade final.

## 1. Motor (`server/policy/engine.ts`)

O motor é uma função pura e determinística: a mesma entrada sempre produz a mesma decisão. Ele não faz I/O, não usa rede e não grava nada. As decisões possíveis são `ALLOW`, `DENY`, `REQUIRE_APPROVAL` e `UNAVAILABLE`, e a primeira etapa que se aplica decide:

1. **Entrada inválida:** requisição malformada, com campos extras (por exemplo, tentando injetar `policy` ou `facts`), sujeito inventado, ids ou SHA inválidos, ou ação fora do catálogo → `DENY`.
2. **Regras fixas, que nenhuma política altera:**
   - push direto na main → `DENY`, mesmo com aprovação;
   - agente alterando permissões → `DENY`;
   - projeto fora do escopo do sujeito → `DENY`;
   - agente sem tarefa atribuída no projeto → `DENY`.
3. **Regras da política:** sem regra aplicável → `DENY` (negação por padrão). Regra `deny` → `DENY`. Uma regra só cobre ações com risco até o seu `maxRisk`.
4. **Capacidade:** se o ACC ainda não oferece a capacidade → `UNAVAILABLE`, informando em `requiresApproval` se ela exigiria aprovação quando existir.
5. **Aprovação:** ação crítica, ou regra `require_approval` → `REQUIRE_APPROVAL`, salvo uma aprovação válida para **exatamente** esta operação → `ALLOW` com `approvalId`, para quem chama consumir (uso único).
6. **Caso contrário** → `ALLOW`.

O risco é baixo, médio ou alto e vem de um catálogo fechado de 25 ações, que cobre:
- observação;
- planejamento e propostas;
- projetos e tarefas;
- ferramentas e preparação de alterações;
- execução isolada (apenas classificação);
- solicitação de aprovação;
- as ações críticas: merge, push na main, deploy, permissões, segredos, envio de dados a terceiros e despesas.

## 2. Política padrão (`server/policy/defaultPolicy.ts`, versão `2026-11-14.1`)

| Sujeito | Regras |
| --- | --- |
| Pessoa (dono do projeto) | Observar e gerenciar projetos e tarefas: **ALLOW**. Planejar, usar ferramentas, preparar alterações e pedir aprovação: ALLOW, mas hoje **UNAVAILABLE**. Execução isolada e ações críticas: **exigem aprovação**, e hoje estão UNAVAILABLE |
| Agente (`agent:*`) | Só no projeto em que tem tarefa atribuída. Observar (projeto, tarefas, GitHub): ALLOW. Propor e pedir aprovação: ALLOW, hoje UNAVAILABLE. Alterar ou mudar o status de tarefa, ferramentas, preparação de alterações e sandbox: **exigem aprovação**. Ações críticas: exigem aprovação e **nunca ALLOW sem aprovação**. Sem regra, portanto **negado**: criar ou alterar projetos, selecionar projeto, criar, atribuir ou concluir tarefas, ler auditoria e ler políticas |

A política é validada na carga, e uma política inválida impede o servidor de iniciar. As verificações são:
- ids únicos, e ações e categorias conhecidas;
- **nenhuma ação crítica com `allow`**;
- regra de **agente específico só restringe** (`deny` ou `require_approval`). Assim, nenhum override amplia permissões.

A política é **código revisado**: mudar uma regra exige PR aprovado pelo PO. A interface e a API não editam políticas.

## 3. Aprovações (contrato; o fluxo completo é da Issue #011)

Uma `ApprovalGrant` vincula:
- **operação:** ação, projeto e recurso exatos;
- **alvo:** SHA e ref (o SHA é obrigatório em merge, deploy e preparação de alterações);
- **sujeito** da ação;
- **aprovador:** precisa ser uma pessoa, e não pode ser o próprio sujeito;
- **validade:** no máximo 24 h, com início e expiração;
- **uso único:** os ids já consumidos são recusados.

Qualquer divergência mantém `REQUIRE_APPROVAL` com `approval_invalid`, e a ausência de aprovação significa bloqueio. Agentes nunca aprovam. Uma aprovação também não libera o que está indisponível: o ACC continua sem capacidade de merge.

## 4. Integração

- **Avaliação no servidor antes de cada ação**, com a pessoa da sessão como sujeito. O cliente nunca escolhe o sujeito.
  - Leituras: listar e ler projetos, tarefas, auditoria, GitHub e políticas.
  - Escritas: criar, alterar e selecionar projetos; criar tarefas; atualizar tarefas, avaliando `task.update` mais `task.assign`, `task.status_change` e `task.complete` conforme o pedido. A pior decisão vence.
- **Projeto antes da política:** a posse do projeto é confirmada antes de avaliar. Projeto de outro dono continua respondendo 404.
- **Respostas de recusa:**
  - `DENY` → 403 `policy_denied`;
  - `REQUIRE_APPROVAL` → 403 `approval_required`;
  - `UNAVAILABLE` → 503 `capability_unavailable`.
- **Auditoria:** cada recusa da política vira um evento `policy.decision` (`blocked`), com `policyAction`, `decision`, `reason`, `risk` e `rule`. Avaliações `ALLOW` de rotina não geram evento: o sucesso da própria operação já é auditado na #006.
- **Atribuição a agentes:** continua possível. Ela só dá ao agente acesso de **leitura** ao projeto, e mudanças continuam exigindo aprovação. Nada é executado e nenhum evento é atribuído a agente.
- **Separação de etapas:** proposta (`task.propose`), aprovação (`approval.request` e `ApprovalGrant`) e execução (`sandbox.execute`) são ações distintas, com regras distintas.
- **Matriz de decisões:** `GET /api/projects/:id/policy` devolve, somente leitura, a matriz do projeto para a pessoa e para cada agente, indicando quem tem tarefa atribuída. Não aceita parâmetros, como escolher o sujeito. POST, PUT, PATCH e DELETE respondem 405, e projeto de outro dono responde 404.
- **Página Políticas:** mostra a decisão, o risco e o motivo em português para cada ação, agrupadas por categoria, com o seletor "Ver decisões para". Não oferece edição.

## 5. Testes

- `server/policy/engine.test.ts`, 62 testes:
  - política vazia nega tudo; ação desconhecida (inclusive `__proto__` e `toString`) é negada;
  - entradas malformadas e tentativas de injetar política, fatos ou papel;
  - pessoa: permitido, indisponível, push na main e críticas;
  - agente: com e sem atribuição, padrão de negação, permissões, críticas para todos os agentes, override que só restringe;
  - validação da política, risco acima do limite e determinismo;
  - aprovações: exata, outra ação, outro projeto, outro recurso, outro SHA ou ausente, outro sujeito, autoaprovação, aprovador agente, expirada, ainda não válida, validade longa e reutilizada.
- `server/http/policy.test.ts`, 13 testes:
  - matriz e atribuição que não executa;
  - isolamento (404), 401, 400 e 405;
  - nenhuma rota de merge, push, deploy ou permissões;
  - política restritiva: 403 sem gravar e decisão auditada;
  - política padrão sem regressão;
  - política inválida impede o servidor de iniciar.
- `src/features/policy/Policy.test.tsx`, 4 testes: decisões e motivos, ausência de edição, erro e servidor fora do ar.
- `server/security.test.ts`: o motor não faz I/O e não existe rota de escrita de políticas.
- **Smoke test do processo real:** 10/10.

## 6. Riscos e limites

- **Sujeitos reais hoje:** só pessoas. Agentes são avaliados apenas na matriz, porque ainda não executam (#008 e #010). Quando passarem a executar, o motor e as regras já estão prontos, mas o servidor terá de identificar o agente por credencial própria, nunca por um campo enviado pelo cliente.
- **Aprovações:** não há armazenamento de aprovações nem registro de consumo; isso fica para a #011. Hoje nenhuma ação depende de aprovação para funcionar.
- **Escopo do dono:** a política padrão usa `human:owner`. Papéis e vários usuários ficam para issues futuras.
