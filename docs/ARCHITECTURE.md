# Documentação técnica inicial

Escopo: Issue #001 — Inicializar a aplicação AI Command Center.

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
- `< 1024px`: sidebar vira gaveta, aberta pelo botão de menu no cabeçalho, com overlay; fecha ao navegar, ao clicar no overlay ou no botão "Fechar menu".
- Grades adaptam de 1 a 4 colunas conforme a largura.

## Fora do escopo (não implementado)

Integrações reais com provedores de IA, banco de dados, autenticação, execução automática de agentes e deploy público.
