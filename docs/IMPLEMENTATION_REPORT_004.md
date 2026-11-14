# Issue #004: gerenciamento de projetos

Branch `feature/004-project-management`, criada a partir da `main` em `0111841e87cdcefb8ef08375bcef21baa5cbf87e`. Segue as diretrizes V2 da Issue #026: projetos são independentes do GitHub, e o GitHub é uma integração opcional.

## 1. O que foi entregue

| Requisito | Implementação |
| --- | --- |
| Projetos sem repositório | `repositories` é opcional (padrão `[]`). O painel mostra "Projeto sem repositório GitHub", sem tratar isso como erro |
| Nome, descrição, objetivo, estado | Campos validados no servidor. Estados: `planning`, `active`, `paused`, `completed`, `archived` |
| Listar, criar, editar, selecionar | Página **Projetos** com formulário de criação e edição, mais o seletor do projeto ativo no cabeçalho. O primeiro projeto criado vira o ativo |
| Projeto ativo persistido com segurança | Gravado no servidor, por usuário, no mesmo arquivo dos projetos. O navegador não guarda nada (`localStorage`, `sessionStorage` e cookies legíveis continuam proibidos pelo teste estrutural) |
| Vínculo com repositórios autorizados | Só nomes da allowlist do servidor ∩ escopo da sessão (`linkableRepositories`). Qualquer outro responde 422 `repository_not_allowed`. Vincular não consulta o GitHub |
| Dados isolados por projeto | O snapshot do GitHub sai de `GET /api/projects/:id/repositories/:owner/:repo/snapshot`, que exige que o projeto pertença ao usuário e que o repositório esteja vinculado a ele. Ao trocar de projeto, o frontend descarta os dados anteriores |
| Preparação para vários usuários | Todo registro tem `ownerId`, igual ao `Session.userId` (hoje `ADMIN_USER_ID = 'admin'`). Toda operação filtra por dono e o cliente nunca informa o dono. Não há RBAC |

## 2. Rotas novas (todas exigem sessão)

| Método | Rota | Função |
| --- | --- | --- |
| GET | `/api/projects` | Lista de projetos do usuário, `activeProjectId` e `linkableRepositories` |
| POST | `/api/projects` | Cria um projeto (201). Só `name` é obrigatório |
| GET | `/api/projects/:id` | Detalhe do projeto |
| POST | `/api/projects/:id` | Atualização parcial |
| POST | `/api/projects/active` | `{ projectId: uuid \| null }` |
| GET | `/api/projects/:id/repositories/:owner/:repo/snapshot` | Snapshot somente leitura do repositório vinculado (`?refresh=1`) |

A atualização usa POST, e não PATCH, para manter um único método de escrita no servidor. O teste estrutural continua recusando PUT, PATCH e DELETE. Não existe exclusão: para retirar um projeto de uso, o estado `archived` cumpre esse papel.

A rota antiga `/api/repos/:owner/:repo/snapshot` foi mantida. Ela é limitada à allowlist e ao escopo da sessão, mas a interface não a usa mais. Pode ser removida num PR futuro.

## 3. Segurança

- **Autenticação primeiro.** Sem sessão válida, toda rota de projetos responde 401 antes de ler o corpo ou tocar no arquivo.
- **CSRF.** Todo POST passa por `assertSafePost` antes da autenticação: `Origin` obrigatório e presente na allowlist, `Sec-Fetch-Site` igual a `same-origin`, corpo `application/json`. Isso vale também para login e logout, cuja verificação foi movida para antes do roteamento sem mudar o comportamento. O cookie continua `SameSite=Strict`.
- **Validação.** Chaves desconhecidas são recusadas, incluindo `id` e `ownerId` vindos do cliente. O texto é normalizado em NFC, com quebras de linha `\n` e espaços das pontas removidos. Os limites contam caracteres: nome até 100, descrição até 2000, objetivo até 1000. Controles C0 e C1 e caracteres de direção bidirecional ("Trojan Source") são recusados, e o nome não aceita quebra de linha. O corpo é limitado a 16 KiB, com no máximo 10 repositórios por projeto e 100 projetos por dono (409).
- **Acesso cruzado.** Um projeto de outro dono, ou um id malformado, recebe o mesmo 404 de um projeto inexistente, sem alterar o arquivo. O snapshot exige, nesta ordem: projeto do próprio dono, repositório na allowlist e vínculo com o projeto. A falta de qualquer um deles responde 404.
- **GitHub somente leitura.** `server/projects/` não importa o cliente GitHub, não usa rede nem subprocessos, o que é verificado por teste estrutural. As consultas continuam restritas às queries GraphQL aprovadas.
- **Logs.** Registram apenas o evento (`project_created`, `project_updated`) e o id. Nome e descrição nunca são registrados.
- **Credenciais.** O arquivo de dados não contém senha, hash, cookie nem token; o smoke test verifica isso.

## 4. Persistência

Os projetos ficam num arquivo JSON local, `ACC_DATA_DIR/projects.json`, com padrão `./data/`, que está no `.gitignore`. É a opção mais simples que atende aos requisitos sem dependência nova:

- **Escrita atômica.** O conteúdo vai para um arquivo temporário (`wx`, modo 0600), recebe `fsync` e depois `rename`. No Windows, o `rename` é repetido em caso de EPERM ou EBUSY, que antivírus e OneDrive podem causar.
- **Ordem das gravações.** As gravações são serializadas. O estado em memória só muda depois que a gravação termina, então uma falha de disco não deixa a memória divergente do arquivo, e escritas concorrentes não se perdem.
- **Leitura.** O arquivo é validado por inteiro: formato, versão, campos exatos, ids únicos e projeto ativo pertencente ao dono. Se estiver corrompido, o servidor **não inicia** e **não sobrescreve** o arquivo, e a mensagem de erro não repete o conteúdo.
- **Versão.** `version: 1` permite migrar o formato no futuro. Se um repositório sair da allowlist, o vínculo continua gravado, mas deixa de ser exposto.

Por que não `node:sqlite`: ainda é experimental no Node 22 e emite aviso. Já um JSON com escrita atômica é suficiente para um administrador e até 100 projetos. Se houver vários usuários ou concorrência real, a recomendação é migrar para SQLite ou Postgres por trás da mesma interface `ProjectStore`.

## 5. Interface

- **Página Projetos.** Cartões com estado, indicação de projeto ativo e repositórios (ou "Sem repositório GitHub"), botões **Tornar ativo** e **Editar**, e formulário de criação.
- **Cabeçalho.** Seletor "Projeto ativo" e o selo "Sem GitHub" quando o projeto não tem repositório.
- **Dashboard, Issues, PRs e Branches.** Mostram apenas o repositório principal (o primeiro vinculado) do projeto ativo. Sem projeto ativo, aparece "Nenhum projeto selecionado".
- **Servidor fora do ar.** Os projetos aparecem como indisponíveis, sem dados inventados. Agentes e tarefas continuam em modo demonstração.

## 6. Testes

- `server/projects/projectStore.test.ts`: validação, persistência entre aberturas, isolamento por dono, falha de gravação sem alterar o estado, concorrência, limite de projetos, allowlist reduzida e arquivo corrompido com falha fechada.
- `server/http/projects.test.ts`: servidor HTTP real. Cobre 401 sem sessão (sem tocar no arquivo), CSRF (403 e 415), métodos (405), corpo grande (413), validação (400 e 422), 404 de acesso cruzado em todas as operações, escopo do snapshot e logs sem dados do projeto.
- `src/features/projects/Projects.test.tsx`: listar, criar sem GitHub, editar e vincular, erro do servidor, troca de projeto que descarta os dados do anterior, 401 que leva ao login, servidor fora do ar.
- `server/security.test.ts`: atualizado com as novas rotas POST e a garantia de que `server/projects/` não usa GitHub nem rede.
- **Smoke test do processo real** (`server/index.ts`, porta 8788, credenciais fictícias): login, criação, vínculo permitido e recusado, seleção, CSRF, persistência após reinício e arquivo corrompido (o processo encerra com código 1 e o arquivo fica intacto).

## 7. Fora do escopo

Execução de agentes, integrações pagas, hospedagem em nuvem, RBAC e multiusuário real, exclusão de projetos e escolha de qual repositório vinculado é o principal (hoje é sempre o primeiro).
