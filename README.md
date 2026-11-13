# AI Command Center

Aplicação web para gerenciar o fluxo de trabalho entre diferentes agentes de inteligência artificial (ChatGPT, Claude Code e Gemini).

> **Estado atual (Issue #002):** integração **somente leitura** com o GitHub (issues, Pull Requests, branches e CI de um repositório autorizado) por meio de um servidor local mínimo. Agentes e tarefas continuam **fictícios** (modo demonstração). Não há integração com provedores de IA nem operações de escrita no GitHub.

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
Sem token, ou sem o servidor, a interface continua funcionando em modo demonstração e indica o motivo.
Em desenvolvimento local também é possível usar a sessão do GitHub CLI (`GITHUB_AUTH=gh-cli`, que exige `ACC_DEPLOYMENT=local`). Esse token costuma ter permissões amplas: veja os riscos antes de usar.

Governança: nenhuma alteração direta na `main` — veja [docs/BRANCH_POLICY.md](docs/BRANCH_POLICY.md) e ative os hooks locais com `npm run hooks:install`.
Detalhes, permissões do token e segurança: [`docs/GITHUB_INTEGRATION.md`](docs/GITHUB_INTEGRATION.md).

## Scripts

| Comando              | Descrição                                          |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Inicia o servidor de desenvolvimento (porta 5173)  |
| `npm run server`     | Inicia o servidor somente leitura do GitHub (porta 8787) |
| `npm run dev:server` | Mesmo servidor, reiniciando ao editar arquivos     |
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
│   ├── github/        # Dados do GitHub: provider, dashboard, issues, PRs, branches, estados
│   ├── agents/        # Cartões/lista de agentes e utilitários
│   └── tasks/         # Lista de tarefas, utilitários e testes
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
- O servidor só escuta em loopback, aceita apenas `GET` em rotas fixas e consulta somente repositórios da allowlist.
