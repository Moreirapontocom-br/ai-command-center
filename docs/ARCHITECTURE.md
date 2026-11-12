# Documentação técnica inicial

Escopo: Issue #001 — Inicializar a aplicação AI Command Center. A Issue #002 acrescentou a integração GitHub somente leitura; ver [`GITHUB_INTEGRATION.md`](GITHUB_INTEGRATION.md).

## Visão geral

SPA estática (sem backend) construída com React + TypeScript e empacotada pelo Vite. A interface consome exclusivamente dados fictícios definidos em `src/data/mockData.ts`.

## Decisões técnicas

| Decisão | Motivo |
| --- | --- |
| Navegação por estado local (`useState<ViewId>` em `App.tsx`) | A issue pede apenas navegação inicial sem backend, e o procedimento proíbe ferramentas de roteamento não autorizadas. Uma biblioteca de rotas pode ser introduzida depois, mediante aprovação. |
| Organização por funcionalidade (`features/*`) + `components/` compartilhados | Atende ao requisito "estrutura organizada por componentes e funcionalidades" e escala para novas áreas. |
| Tailwind CSS v4 com `@tailwindcss/vite` | Configuração mínima (sem `tailwind.config.js` / PostCSS). |
| Vitest com `jsdom` e Testing Library | Mesma configuração de transformação do Vite; testes orientados a comportamento acessível (roles e labels). |
| ESLint flat config (`eslint.config.js`) | Padrão atual do ESLint; inclui `typescript-eslint`, React Hooks e React Refresh. |
| Sem biblioteca de ícones | Evita dependência fora do escopo; o único ícone é um SVG inline. |

## Modelo de dados (fictício)

- `Agent` — `id`, `name`, `provider`, `role`, `status` (`disponivel` \| `ocupado` \| `offline`).
- `Task` — `id`, `title`, `agentId`, `status` (`pendente` \| `em-andamento` \| `em-revisao` \| `concluida`), `priority`, `updatedAt`.

Os dados fictícios são identificados de três formas:
1. Aviso "Dados fictícios" (`MockDataNotice`) no topo de todas as páginas.
2. Selo "Modo demonstração" no cabeçalho.
3. Prefixo `[Fictício]` em todos os títulos de tarefas, e cabeçalho de comentário em `mockData.ts`.

## Responsividade

- `≥ 1024px (lg)`: sidebar fixa à esquerda.
- `< 1024px`: sidebar vira gaveta, aberta pelo botão de menu no cabeçalho, com overlay; fecha ao navegar, ao clicar no overlay, no botão "Fechar menu" ou com Escape.
- Grades adaptam de 1 a 4 colunas conforme a largura.

## Acessibilidade da gaveta mobile

- O botão do cabeçalho alterna o nome acessível ("Abrir menu" / "Fechar menu") e `aria-expanded`, além de `aria-controls="app-sidebar"`.
- Aberta, a gaveta é um `role="dialog"` com `aria-modal="true"` e o foco vai para o botão "Fechar menu".
- O conteúdo de fundo (cabeçalho + `<main>`) recebe o atributo `inert`. O Tab e o Shift+Tab circulam só dentro da gaveta.
- Ao fechar, por qualquer meio, o foco volta ao botão do menu.
- Fechada no mobile, a gaveta fica `visibility: hidden` e sai da ordem de foco. A visibilidade só é animada no fechamento, para que o foco inicial funcione ao abrir.
- Se a janela passar para o layout desktop com a gaveta aberta, ela é fechada (`matchMedia`) para não deixar um estado modal invisível.

## Integração contínua

`.github/workflows/ci.yml` roda em pull requests para a `main` (e manualmente): `npm ci` → `npm test` → `npm run lint` → `npm run build`, em Node 22.x e 24.x (faixa de `engines`). Permissões: `contents: read`; actions fixadas por SHA; `persist-credentials: false`; sem segredos.

## Issue #002 — integração GitHub (resumo)

- Servidor Node local (`server/`) com 2 endpoints `GET` fixos; o token fine-grained fica só nele.
- Frontend consulta `/api` na própria origem (proxy do Vite) via `src/services/githubApi.ts`; o estado é compartilhado por `GitHubDataProvider`.
- Novas telas: Issues, Pull Requests e Branches; o Dashboard ganhou a seção "Repositório no GitHub".
- Dados reais e demonstrativos ficam separados: issues não viram `Task` nem recebem agente.

## Fora do escopo (não implementado)

Integrações com provedores de IA, escrita no GitHub, webhooks, banco de dados, autenticação de usuários, execução automática de agentes e deploy público.
