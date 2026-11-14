# Issue #006: auditoria e rastreabilidade

Branch `feature/006-audit-events`, criada a partir da `main` em `99c2282aaaedf07d0f256109fdde3a7a2f7278a3` (merge do PR #38, com CI e Main audit verdes). Autenticação, governança, projetos e tarefas foram preservados.

## 1. Modelo de evento (`shared/contracts.ts`)

| Campo | Conteúdo |
| --- | --- |
| `id` | UUID v4 |
| `seq` | Sequência global crescente, que define a ordem determinística. Pode ter lacunas se uma gravação falhar |
| `at` | Data e hora no formato ISO 8601, gerada pelo servidor |
| `action` | `project.created`, `project.updated`, `project.activated`, `task.created`, `task.updated`, `task.status_changed`, `task.assignee_changed`, `task.completion_confirmed`, `auth.login`, `auth.logout`, `auth.login_rejected` ou `access.denied` |
| `actor` | `{ kind: 'human' \| 'agent' \| 'system', id }`, sempre da sessão ou do servidor. `system/anonymous` indica um cliente não autenticado. O tipo `agent` existe só para o futuro: **nenhum evento desta versão é atribuído a agente** |
| `projectId` | Projeto relacionado, ou `null` |
| `resource` | `{ type: 'project' \| 'task' \| 'session' \| 'route', id }` |
| `outcome` | `success`, `failure` (entrada inválida ou erro interno) ou `blocked` (recusa por regra, acesso negado ou limite de tentativas) |
| `context` | Lista fixa de chaves com valores do tipo **token** (ids, enums, nomes de campos), números, booleanos ou `null`. Texto livre não cabe nesse formato, então títulos, descrições, e-mails, mensagens, cabeçalhos, cookies, senhas, hashes e tokens ficam de fora. Isso é validado ao gravar **e** ao ler |

Para aprovações do PO, execuções de agentes, revisões e sincronizações, o modelo já tem o tipo de autor `agent` e a lista de ações extensível. Basta adicionar a ação e as chaves de contexto, com revisão. Nenhum evento de execução é inventado.

## 2. Consistência entre alteração e evento (ponto crítico)

**Garantia real, sem transação entre arquivos:**

- **Alterações bem-sucedidas** de projetos e tarefas gravam o evento **no mesmo documento JSON** da alteração (`projects.json` ou `tasks.json`, agora na versão 2). As duas coisas são aplicadas na mesma cópia e gravadas pelo mesmo `rename` atômico, então ou existem as duas ou nenhuma. Se a gravação falha, nada muda e nenhum evento de sucesso é registrado.
- **Eventos avulsos** ficam em `audit.json`. São os que não acompanham nenhuma alteração de dados: login, logout, login recusado, acesso negado, e escrita recusada ou que falhou. Como descrevem algo que **não alterou** dados, perder um deles não cria registros contraditórios, apenas deixa de registrar uma tentativa.
- **Não existe transação entre arquivos**, e nenhuma é declarada. Nenhum caso precisa de uma: toda alteração tem o seu evento no próprio arquivo.

Comportamento quando a gravação da auditoria falha:

| Situação | Resultado |
| --- | --- |
| Login com sucesso | A sessão recém-criada é revogada e a resposta é **503 `audit_unavailable`** (falha fechada) |
| Logout | A sessão **é encerrada** (é a ação segura), mas a resposta é **503**, nunca um sucesso sem registro |
| Recusa ou falha (401, 403, 404, 409, 422, 500…) | A resposta continua sendo a recusa original; o erro de gravação vai para o log do servidor (`audit_write_failed`) |

O formato v1 da #004 e da #005 é migrado em memória ao abrir e gravado como v2 na próxima escrita. A validação estrita na leitura cobre formato, versão, campos exatos, `seq` crescente e único, ids únicos e o contexto permitido. Arquivo corrompido impede o servidor de iniciar e nunca é sobrescrito.

## 3. Eventos registrados

| Evento | Quando | Contexto |
| --- | --- | --- |
| `project.created`, `project.updated` | Criar ou editar um projeto | `status`, `fields` e, se o status mudar, `from`/`to` |
| `project.activated` | Selecionar o projeto ativo | `cleared` |
| `task.created` | Criar uma tarefa | `status`, `priority`, `origin` |
| `task.updated` | Editar uma tarefa | `fields` |
| `task.status_changed` | Mudar o status | `from`, `to` |
| `task.assignee_changed` | Trocar o responsável | `from`, `to` (`agent:<id>`, `human:<id>` ou `null`) |
| `task.completion_confirmed` | Entrar em `done` | `evidence` (tipos das referências) e `to` (responsável). O autor é a **pessoa** que confirmou |
| `auth.login`, `auth.logout` | Login ou logout | `hadSession` |
| `auth.login_rejected` | Senha errada, bloqueio por tentativas (`blocked`), administrador não configurado ou CSRF | `reason` |
| `access.denied` | POST recusado por CSRF, Origin ou tipo de corpo; POST sem sessão; recurso de outro dono ou inexistente, com sessão | `reason`, `route` (nome fixo), `method` |
| Ação tentada com `blocked`/`failure` | Escrita de projeto ou tarefa recusada por regra, entrada inválida ou falha de disco | `reason` (código do erro) |

Requisições barradas pelo limite global de requisições, e GETs anônimos, **não** geram escrita. Isso evita amplificar ataques de negação de serviço. O projeto de um evento negado só é preenchido se pertencer ao usuário da sessão.

## 4. API e interface

- **`GET /api/audit`**: exige autenticação e é somente leitura. POST, PUT, PATCH e DELETE respondem 405, e não há rota de escrita sob `/api/audit`.
  - Parâmetros: `projectId`, `action`, `outcome`, `before` (cursor de `seq`) e `limit` (de 1 a 200, padrão 50). Qualquer outro parâmetro, ou valor inválido, responde 400.
  - Ordem: mais recentes primeiro. A resposta inclui `nextBefore` e `retention.droppedEvents`.
  - Isolamento: só aparecem eventos do dono da sessão. Eventos da instância (sem dono, como login recusado e acesso anônimo negado) só aparecem para o administrador. Filtrar por um projeto de outro dono responde 404.
- **Página Auditoria:** lista cronológica, filtros por projeto, evento e resultado, autor identificado, data e hora, contexto, "Carregar mais", aviso de retenção e mensagens de erro.

## 5. Retenção (MVP)

Limites por arquivo: 5000 eventos em `projects.json`, 20 000 em `tasks.json` e 20 000 em `audit.json`.

- **Ordem de descarte:** acima do limite, saem primeiro os eventos mais antigos de clientes **não autenticados**, para que ruído externo não empurre para fora o histórico atribuível. Depois, saem os mais antigos em geral.
- **Contagem:** o total descartado fica em `droppedEvents` e aparece na interface.
- **Backup:** para guardar o histórico completo, copie a pasta `ACC_DATA_DIR` com o servidor parado.
- **Futuro:** exportação, arquivamento e retenção por tempo ficam para quando houver hospedagem.

## 6. Testes

- `server/audit/audit.test.ts`, 23 testes:
  - contra contaminação: texto livre, e-mail, chaves desconhecidas, autor e ação inválidos;
  - retenção, persistência e sequência contínua, interface só de adição e leitura;
  - falha de escrita e arquivo corrompido;
  - migração de v1;
  - alteração e evento no mesmo arquivo, e regra violada que não deixa nenhum dos dois;
  - isolamento e limites da consulta.
- `server/http/audit.test.ts`, 25 testes no servidor HTTP real:
  - todos os eventos, autor da sessão e nenhum agente;
  - login recusado e bloqueado, logout, acessos negados;
  - ausência de senha, hash, cookie, token, e-mail e texto do usuário em arquivos, respostas e logs;
  - consistência com falha de disco em projetos, na auditoria do login, na do logout e nas recusas;
  - persistência após reiniciar;
  - 405 em `/api/audit`, 401, isolamento entre donos, filtros, paginação e parâmetros inválidos.
- `src/features/audit/Audit.test.tsx`, 5 testes: lista, filtros como parâmetros, paginação com aviso de retenção, erro e servidor fora do ar.
- `server/security.test.ts`: `/api/audit` sem escrita; `server/audit` sem rede, GitHub nem subprocesso.
- **Smoke test do processo real:** 12/12, cobrindo migração de v1, ordem dos eventos, CSRF, 405, 401, arquivos sem segredos, persistência e arquivo de auditoria corrompido (exit 1, arquivo intacto).

## 7. Riscos e limites

- O arquivo é local e a imutabilidade vale **pela API**. Quem tem acesso ao disco pode editar os arquivos, porque não há assinatura nem encadeamento por hash. Se isso for necessário, é um passo futuro.
- Clientes anônimos podem gerar até o limite de requisições (60 por minuto por cliente) em eventos `access.denied`. A retenção descarta esses eventos primeiro.
