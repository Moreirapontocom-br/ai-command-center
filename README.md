# AI Command Center

Aplicação web para gerenciar o fluxo de trabalho entre diferentes agentes de inteligência artificial (ChatGPT, Claude Code e Gemini).

> **Estado atual (Issue #020):** **políticas de autonomia** semiautomática, negadas por padrão e avaliadas no servidor antes de cada ação (página Políticas, somente leitura); **auditoria** **auditoria** somente de adição (projetos, tarefas, login/logout, recusas e acessos negados), consultável na página Auditoria; **tarefas** **tarefas** por projeto (status interno, prioridade, responsável pessoa ou agente, dependências sem ciclos, referências a issue/PR/branch e histórico) e gerenciamento de **projetos** (nome, descrição, objetivo, estado, projeto ativo), com GitHub **opcional**: cada projeto pode vincular repositórios da allowlist do servidor e mostra apenas os dados deles, em modo **somente leitura**. Acesso com login de administrador único (Issue #003). Agentes e o resumo de tarefas do dashboard continuam **fictícios** (modo demonstração). Não há integração com provedores de IA nem operações de escrita no GitHub.

## Stack

- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/) (dev server e build)
- [Tailwind CSS v4](https://tailwindcss.com/) via plugin `@tailwindcss/vite`
- [Vitest](https://vitest.dev/) + Testing Library (testes)
- [ESLint](https://eslint.org/) com `typescript-eslint` e regras de React Hooks
- Servidor intermediário em Node.js (`node:http`, TypeScript executado nativamente), sem dependências extras

## Pré-requisitos

- Node.js 22.13+ ou 24+ (desenvolvido com Node 24.18)
- npm 10+

## Instalação

```bash
npm install
cp .env.example .env.local   # opcional: GITHUB_TOKEN fine-grained somente leitura (nunca versionar)
```

Rode em dois terminais: `npm run server` (API local em `127.0.0.1:8787`) e `npm run dev` (frontend com proxy `/api`).
Sem o servidor, a interface continua em modo demonstração (somente dados fictícios). Com o servidor, o painel exige login.

### Primeiro administrador (Issue #003)

O ACC tem um administrador único (e-mail + senha). A senha nunca fica em texto puro: só o hash scrypt vai para o servidor.

```bash
npm run auth:hash-password   # digite a senha (mín. 12 caracteres); ela não aparece na tela
```

Copie a linha `ACC_ADMIN_PASSWORD_HASH=…` impressa e, no `.env.local` (nunca versionado), defina também `ACC_ADMIN_EMAIL=<seu e-mail>`. Reinicie `npm run server`. Para trocar a senha, gere um novo hash e reinicie o servidor. Isso encerra todas as sessões.
Em desenvolvimento local também é possível usar a sessão do GitHub CLI (`GITHUB_AUTH=gh-cli`, que exige `ACC_DEPLOYMENT=local`). Esse token costuma ter permissões amplas: veja os riscos antes de usar.

### Projetos (Issue #004)

Na página **Projetos** é possível criar, editar e selecionar projetos; o seletor do cabeçalho troca o projeto ativo. Os dados ficam no servidor, em `data/projects.json` (pasta configurável por `ACC_DATA_DIR`, ignorada pelo Git), e a seleção ativa também é gravada lá, nunca no navegador. Um projeto pode não ter repositório. Se tiver, o painel mostra o primeiro repositório vinculado, e só se ele estiver na allowlist do servidor. Faça backup copiando o arquivo com o servidor parado.

### Tarefas (Issue #005)

A página **Tarefas** lista as tarefas do projeto ativo, com filtros por status, prioridade e responsável, e permite criar e editar tarefas e mudar o status. Os dados ficam em `data/tasks.json`. O status é interno ao ACC e nunca é inferido do GitHub. Atribuir uma tarefa a um agente **não** inicia nenhuma execução, e uma tarefa de agente só pode ser concluída com um PR ou branch como evidência, com a confirmação registrada pela pessoa logada. Regras em `docs/IMPLEMENTATION_REPORT_005.md`.

### Políticas de autonomia (Issue #020)

O servidor avalia cada ação contra a política (`server/policy/defaultPolicy.ts`). O resultado é **permitido**, **negado**, **exige aprovação** ou **indisponível**. Sem regra explícita, a ação é negada. Push direto na main é sempre proibido, e agentes nunca alteram permissões. Ações críticas (merge, deploy, segredos, permissões, envio de dados a terceiros, despesas) exigem aprovação específica do PO, vinculada a operação, recurso e SHA. Atribuir uma tarefa a um agente não autoriza execução. Mudar a política exige PR aprovado. A página **Políticas** mostra as decisões e os motivos. Detalhes em `docs/IMPLEMENTATION_REPORT_020.md`.

### Auditoria (Issue #006)

A página **Auditoria** mostra o histórico, com filtros por projeto, evento e resultado. A API (`GET /api/audit`) é somente leitura. O autor vem sempre da sessão, e os eventos nunca contêm senhas, cookies, tokens, e-mails nem texto livre. Cada alteração de projeto ou tarefa é gravada junto com o seu evento, no mesmo arquivo e de forma atômica. Login, logout e recusas ficam em `data/audit.json`. Retenção e garantias em `docs/IMPLEMENTATION_REPORT_006.md`.

Governança: nenhuma alteração direta na `main` — veja [docs/BRANCH_POLICY.md](docs/BRANCH_POLICY.md) e ative os hooks locais com `npm run hooks:install`.
Detalhes, permissões do token e segurança: [`docs/GITHUB_INTEGRATION.md`](docs/GITHUB_INTEGRATION.md).

## Scripts

| Comando              | Descrição                                          |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Inicia o servidor de desenvolvimento (porta 5173)  |
| `npm run server`     | Inicia o servidor somente leitura do GitHub (porta 8787) |
| `npm run dev:server` | Mesmo servidor, reiniciando ao editar arquivos     |
| `npm run auth:hash-password` | Gera o hash da senha do administrador (`ACC_ADMIN_PASSWORD_HASH`) |
| `npm run check:secrets` | Verifica se o build (`dist/`) contém credenciais |
| `npm run check:secrets:repo` | Verifica credenciais em todos os arquivos versionados |
| `npm run check:secrets:history` | Verifica credenciais nas linhas adicionadas em todo o histórico |
| `npm run build`      | Verifica tipos (`tsc -b`) e gera o build em `dist/` |
| `npm run preview`    | Serve localmente o build de produção               |
| `npm run lint`       | Executa o ESLint                                   |
| `npm test`           | Executa os testes uma vez                          |
| `npm run test:watch` | Executa os testes em modo observação               |

## Estrutura

```
server/                # Servidor intermediário somente leitura (token só aqui)
├── auth/              # CredentialProvider: token fine-grained ou GitHub CLI local (preparado para GitHub App)
├── github/            # Cliente GraphQL, consulta fixa, tipos crus e normalização
├── http/              # Rotas, validação, proteções e limite de requisições
├── projects/          # Projetos: validação e armazenamento local, isolado por dono
├── tasks/             # Tarefas: validação, regras de status/dependências/evidência e armazenamento
├── storage/           # Motor comum de arquivo JSON atômico (projetos, tarefas e auditoria)
├── audit/             # Eventos de auditoria: formato, retenção, registro avulso e consulta
├── policy/            # Motor de políticas (negação por padrão, risco, aprovações) e política padrão
└── snapshotService.ts # Cache, fallback desatualizado e respeito aos limites da API
shared/contracts.ts    # Tipos internos compartilhados servidor ↔ frontend
scripts/               # check-dist-secrets.mjs
src/
├── services/          # Cliente do servidor intermediário (/api)
├── components/
│   ├── layout/        # AppLayout, Sidebar, Header, itens de navegação
│   └── ui/            # Componentes reutilizáveis (StatusBadge, MockDataNotice)
├── features/
│   ├── dashboard/     # Página inicial e cartões de resumo
│   ├── github/        # Dados do GitHub do projeto ativo: provider, issues, PRs, branches, estados
│   ├── projects/      # Projetos: provider, página, formulário e seletor do projeto ativo
│   ├── agents/        # Cartões/lista de agentes e utilitários
│   └── tasks/         # Tarefas reais do projeto ativo (página, formulário, cartão) e demonstração do dashboard
├── data/mockData.ts   # Dados FICTÍCIOS de demonstração
├── types/             # Tipos de domínio (Agent, Task, ViewId)
├── test/setup.ts      # Configuração do Vitest / jest-dom
├── App.tsx            # Navegação por estado entre as seções
└── main.tsx           # Ponto de entrada
```

Mais detalhes em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) e [`docs/GITHUB_INTEGRATION.md`](docs/GITHUB_INTEGRATION.md).

## Segurança

- Nenhuma credencial ou chave de API faz parte do código. O token do GitHub fica apenas no servidor local (`.env.local`), nunca no navegador nem em variáveis `VITE_*`.
- Arquivos `.env*` estão no `.gitignore` (exceto `.env.example`, sem valores). A CI recusa credenciais em arquivos versionados e nos commits do PR (`scripts/check-secrets.mjs`); localmente, ative o hook opcional com `git config core.hooksPath .githooks`.
- O servidor só escuta em loopback e consulta somente repositórios da allowlist. Rotas de dados exigem sessão válida. `POST` existe só em login/logout e nas rotas de projetos e tarefas (`/api/projects`, `/api/projects/:id`, `/api/projects/active`, `/api/projects/:id/tasks`, `/api/projects/:id/tasks/:taskId`), sempre com `Origin` obrigatório, `Sec-Fetch-Site` same-origin e corpo JSON (CSRF), verificados antes da autenticação. Não há `PUT`/`PATCH`/`DELETE`, e nenhuma escrita chega ao GitHub.
- Projetos são isolados por dono (`userId` da sessão). Projeto de outro dono responde 404, como um inexistente, e o snapshot do GitHub só é servido para um repositório vinculado ao próprio projeto. Detalhes em `docs/IMPLEMENTATION_REPORT_004.md`.
- Uma única sessão administrativa ativa, no servidor: novo login encerra a anterior, inclusive em outro navegador. Cookie `HttpOnly; SameSite=Strict` (`Secure` e `__Host-` com `ACC_DEPLOYMENT=production`). Expira após 30 min de inatividade ou 8 h no total.
- Limite de tentativas (somente MVP local): após 5 falhas por cliente, ou 20 no total, o login fica bloqueado por 15 min. Quem alcança a porta pode usar isso para atrasar o login (DoS), mas a sessão ativa não é afetada. Atrás do proxy do Vite, todos os navegadores contam como um único cliente. Detalhes em `docs/IMPLEMENTATION_REPORT_003_PR2.md` §5.
