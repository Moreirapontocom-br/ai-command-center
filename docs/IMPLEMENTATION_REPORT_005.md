# Issue #005: modelo unificado de tarefas e estados de trabalho

Branch `feature/005-task-management`, criada a partir da `main` em `ce9e886ac0a37d14cb53cabd5dd30b65f55ed3d0` (merge do PR #37, com CI e Main audit verdes). Mantém sem alteração a autenticação (Issue #003) e o isolamento de projetos (Issue #004).

## 1. Modelo (`shared/contracts.ts`)

| Campo | Regra |
| --- | --- |
| `id` | UUID v4 gerado pelo servidor |
| `projectId` | Projeto dono da tarefa. Toda operação exige que o projeto pertença ao usuário |
| `title`, `description` | Até 200 e 4000 caracteres, com normalização e recusa de caracteres de controle (mesmas regras de #004) |
| `status` | `pending`, `planned`, `in_progress`, `blocked`, `in_review`, `done`, `cancelled` |
| `priority` | `low`, `medium`, `high`, `critical` |
| `assignee` | `null`, `{ kind: 'human', userId }` (hoje só o usuário da sessão) ou `{ kind: 'agent', agentId }` (`chatgpt`, `claude-code`, `gemini`, `nemotron`) |
| `dependsOn` | Até 20 tarefas do **mesmo** projeto, sem ciclos |
| `references` | Até 10 vínculos (`issue` ou `pull_request` com número, `branch` com nome validado), sempre a um repositório vinculado ao projeto |
| `origin` | `manual`, `integration` ou `agent`, definida **pelo servidor**. Pela API do navegador, é sempre `manual` |
| `blockedReason` | Obrigatório em `blocked`. É limpo ao sair desse status |
| `completion` | `{ confirmedBy, confirmedAt }` só quando `done`, e sempre a pessoa autenticada |
| `history` | Até 50 eventos (`created`, `status_changed`, `assignee_changed`, `updated` com a lista de campos), com ator e data |
| `createdAt`, `updatedAt` | Gerados pelo servidor |

O status é **interno ao ACC**: não é copiado nem inferido do GitHub.

## 2. Regras de estado (servidor, `server/tasks/taskStore.ts`)

- **Criação:** a tarefa nasce só como `pending` ou `planned`. Qualquer outro status inicial responde 409, então não é possível criar trabalho "já em andamento" ou "já concluído".
- **Transições:** seguem uma matriz explícita (`TASK_TRANSITIONS`, compartilhada com a interface); as demais respondem 409. Reabrir também é explícito: `done → in_progress` e `cancelled → pending`.
- **Dependências:** `in_progress`, `in_review` e `done` exigem todas as dependências concluídas ou canceladas (409 `dependencies_unresolved`). Isso vale também para incluir uma dependência pendente numa tarefa que já está em andamento. Ciclos diretos e indiretos respondem 422 `dependency_cycle`.
- **Sem conclusão fictícia:**
  - Uma tarefa atribuída a **agente** só pode ser concluída com evidência: uma referência a PR ou branch. Issue não conta (422 `evidence_required`).
  - A mesma regra recusa remover a evidência de uma tarefa já concluída, ou trocar o responsável de uma tarefa concluída para um agente.
  - A conclusão é sempre registrada como `confirmedBy` igual à pessoa autenticada, nunca como o agente.
- **Atribuir não executa:** atribuir uma tarefa, vincular uma referência ou mudar o responsável **nunca** altera o status, e nada é consultado no GitHub. A interface também informa que atribuir a um agente não inicia nenhuma execução.
- **Campos do servidor:** campos controlados pelo servidor (`id`, `projectId`, `origin`, `completion`, `history`, datas) enviados pelo cliente são recusados com 400.
- **Edições do formulário:** só os campos que mudaram de fato disparam essas regras. Assim, editar o título de uma tarefa antiga não falha por causa de uma dependência reaberta depois.

## 3. API (todas as rotas exigem sessão e um projeto do próprio usuário)

| Método | Rota | Resposta |
| --- | --- | --- |
| GET | `/api/projects/:id/tasks` | `{ tasks, assignableUsers, agents }` |
| POST | `/api/projects/:id/tasks` | Cria a tarefa (201) |
| GET | `/api/projects/:id/tasks/:taskId` | Detalhe da tarefa |
| POST | `/api/projects/:id/tasks/:taskId` | Atualização parcial, inclusive de status |

- **CSRF:** a mesma verificação de todo POST (`Origin`, `Sec-Fetch-Site` e JSON, antes da autenticação), com corpo de até 16 KiB.
- **Métodos:** não há PUT, PATCH nem DELETE. Uma tarefa é retirada de uso com o status `cancelled`.
- **Acesso cruzado:** projeto de outro dono, tarefa de outro projeto ou id malformado recebem o mesmo 404, sem gravar nada.
- **Logs:** só o evento e os ids. Título e descrição nunca são registrados.

## 4. Persistência

- **Motor comum:** o motor atômico da #004 foi extraído para `server/storage/jsonFile.ts`. Ele faz a escrita atômica com `fsync` e `rename`, mantém uma fila de escrita, aplica a alteração numa cópia e só publica depois de gravar, e valida o arquivo inteiro na abertura. Projetos e tarefas usam esse mesmo código, sem duplicação.
- **Arquivo próprio:** as tarefas ficam em `ACC_DATA_DIR/tasks.json`. Assim, gravar uma tarefa não reescreve o arquivo de projetos.
- **Limites:** 300 tarefas por projeto (409 `task_limit_reached`) e arquivo de até 32 MiB.
- **Regras e falhas:** as regras de negócio rodam **dentro** da operação serializada. Uma regra violada ou uma falha de disco cancela tudo, e a memória continua igual ao arquivo.
- **Validação na abertura:** campos exatos, status e prioridade, responsável, coerência entre `done` e `completion` e entre `blocked` e motivo, dependências no mesmo dono e projeto, e ausência de ciclos. Se o arquivo estiver inválido, o servidor não inicia e não o sobrescreve.

## 5. Interface (`/Tarefas`)

- **Escopo:** lista do **projeto ativo**. Ao trocar de projeto, a lista anterior é descartada. Sem projeto ativo, a página orienta a escolher um. Sem servidor, aparece "Tarefas indisponíveis", sem dados inventados.
- **Criação e edição:** título, descrição, prioridade, responsável (pessoa ou agente), dependências (outras tarefas do projeto) e referências a repositórios vinculados. O status inicial só oferece "Pendente" ou "Planejada".
- **Mudar status:** o controle oferece apenas as transições permitidas. Bloquear pede o motivo antes de enviar. O erro do servidor aparece no próprio cartão e o status só muda depois que o servidor confirma.
- **Filtros:** status, prioridade e responsável.
- **Cartão:** mostra as dependências com o status de cada uma, o aviso "Aguardando N dependência(s)", as referências (links somente leitura), a conclusão confirmada por uma pessoa e o histórico.
- **Dashboard:** o resumo de tarefas e os agentes do dashboard continuam fictícios e identificados como demonstração.

## 6. Testes

- `server/tasks/taskStore.test.ts`, 50 testes:
  - validação e limites;
  - matriz completa de transições (7×6 casos);
  - bloqueio, dependências (projeto e dono, a própria tarefa, ciclos diretos e indiretos, pendentes e reabertas);
  - evidência de conclusão por agente, reabertura e origem;
  - isolamento, falha de gravação, cópias defensivas, limites e arquivo corrompido.
- `server/http/tasks.test.ts`, 22 testes no servidor HTTP real:
  - CRUD e persistência ao reiniciar;
  - 401 sem gravar, CSRF (403 e 415), 405, 413 e campos do servidor (400);
  - isolamento entre projetos e donos, referência a repositório não vinculado (422), responsável humano, ciclos, dependências, evidência e logs.
- `src/features/tasks/WorkTasks.test.tsx`, 11 testes:
  - lista, criação e edição;
  - transições permitidas, bloqueio com motivo e erros do servidor;
  - filtros, troca de projeto, ausência de projeto ativo e 401.
- `server/security.test.ts`: inclui as rotas novas e confirma que `server/tasks` e `server/storage` não usam GitHub, rede nem subprocesso.
- **Smoke test do processo real** (`server/index.ts`, credenciais fictícias): 14/14, cobrindo regras, CSRF, 401, persistência após reinício, arquivo sem segredos e arquivo corrompido (exit 1, arquivo intacto).

## 7. Fora do escopo

Execução de agentes, sincronização com o GitHub, exclusão de tarefas, vários responsáveis humanos e RBAC.

Um ponto fica para o PO decidir: reabrir uma dependência **não** altera em cascata as tarefas que dependem dela. Elas mantêm o status atual, e as próximas mudanças de status voltam a exigir as dependências resolvidas.
