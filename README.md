# AI Command Center

Aplicação web para gerenciar o fluxo de trabalho entre diferentes agentes de inteligência artificial (ChatGPT, Claude Code e Gemini).

> **Estado atual:** versão de demonstração (Issue #001). Todos os dados exibidos são **fictícios**. Não há backend, autenticação nem integração com provedores de IA.

## Stack

- [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vite.dev/) (dev server e build)
- [Tailwind CSS v4](https://tailwindcss.com/) via plugin `@tailwindcss/vite`
- [Vitest](https://vitest.dev/) + Testing Library (testes)
- [ESLint](https://eslint.org/) com `typescript-eslint` e regras de React Hooks

## Pré-requisitos

- Node.js 22.13+ ou 24+ (desenvolvido com Node 24.18)
- npm 10+

## Instalação

```bash
npm install
```

## Scripts

| Comando              | Descrição                                          |
| -------------------- | -------------------------------------------------- |
| `npm run dev`        | Inicia o servidor de desenvolvimento (porta 5173)  |
| `npm run build`      | Verifica tipos (`tsc -b`) e gera o build em `dist/` |
| `npm run preview`    | Serve localmente o build de produção               |
| `npm run lint`       | Executa o ESLint                                   |
| `npm test`           | Executa os testes uma vez                          |
| `npm run test:watch` | Executa os testes em modo observação               |

## Estrutura

```
src/
├── components/
│   ├── layout/        # AppLayout, Sidebar, Header, itens de navegação
│   └── ui/            # Componentes reutilizáveis (StatusBadge, MockDataNotice)
├── features/
│   ├── dashboard/     # Página inicial e cartões de resumo
│   ├── agents/        # Cartões/lista de agentes e utilitários
│   └── tasks/         # Lista de tarefas, utilitários e testes
├── data/mockData.ts   # Dados FICTÍCIOS de demonstração
├── types/             # Tipos de domínio (Agent, Task, ViewId)
├── test/setup.ts      # Configuração do Vitest / jest-dom
├── App.tsx            # Navegação por estado entre as seções
└── main.tsx           # Ponto de entrada
```

Mais detalhes em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Segurança

- Nenhuma credencial ou chave de API faz parte do código.
- Arquivos `.env*` estão no `.gitignore`.
