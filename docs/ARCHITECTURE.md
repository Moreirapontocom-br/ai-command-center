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

## Issue #011 — aprovações humanas (resumo)

- **Núcleo** (`server/approvals/`, PR 1): estado mínimo e histórico oficial com HMAC, anchor em outro diretório, escritor único, época por reinício (N1), reserva de uso único com recibo de 30 s e barreiras de emergência duráveis.
- **Integração** (PR 2): rotas do administrador em `server/http/approvalRoutes.ts` (sessão + CSRF + confirmação por senha de uso único, presa à sessão, 5 min); o sandbox (#021) e o controlador (#022) pedem aprovações e só aceitam grants com recibo válido do verificador confiável; a política (#020) segue pura, e a exceção `owner_confirmation` depende de atestado do servidor.
- **Interface:** página *Aprovações* (lista, detalhe do vínculo exato com resumo recalculado no navegador, parâmetros exatos somente leitura conferidos contra o `paramsDigest` — correção R1, `shared/approvalPresentation.ts` —, aprovar/rejeitar/revogar com senha, histórico). Aprovar exige os parâmetros apresentados e o `presentationDigest`; rejeitar nunca depende deles.
- **Limites intencionais:** nenhuma rota executa, admite, inicia sandbox, aciona ou libera o kill switch (N9) ou altera limites; execução real continua desligada. A barreira global inicial permanece ativa até ser liberada pelo comando LOCAL `npm run admin:release-barrier` (Issue #008, P1; emenda ao N9): nunca por HTTP, só o motivo `initial_install`, com o servidor parado e lock de instância compartilhado. O servidor também cruza a #011 com a #006 na subida: liberação sem registro final correlacionado, ou com registro contraditório, deixa as aprovações indisponíveis até a reconciliação (fechamento da #008, L3). Procedimento em `docs/BARRIER_RELEASE.md`; a primeira liberação real exige autorização separada do PO. Detalhes em `docs/IMPLEMENTATION_REPORT_011_PR2.md`.

## Issue #012 — fila de execução (PR 1: fundação persistente, dormente)

- **Primitivas compartilhadas** (`server/storage/`): `canonical` (JSON canônico + MAC por namespace), `paths` (caminhos fora do Git/pastas sincronizadas), `lock` (escritor único, mesma máquina/disco local), `subkeys` (HKDF-SHA256 por domínio) e `signedLedger` (ledger + histórico encadeado + anchor + quarentena, mesmo desenho da #011). Os módulos de aprovações viraram reexportações com os mesmos bytes, nomes de arquivo e códigos de erro.
- **Fila** (`server/queue/`): registros persistidos com transições impostas na gravação; reinício marca `dispatching`/`running` como `interrupted` (sem retomada) e `admitted` como `expired`; toda linhagem nova nasce bloqueada. O portão (`barrierGate`) só bloqueia: a barreira durável da #011, injetada por interface estreita, é a única autoridade que libera.
- **Limites intencionais:** sem admissão, agendamento, despacho, rota, interface ou temporizador (PR 2); execução real desligada. Detalhes em `docs/IMPLEMENTATION_REPORT_012_PR1.md`.

## Fora do escopo (não implementado)

Integrações com provedores de IA, escrita no GitHub, webhooks, banco de dados, autenticação de usuários, execução automática de agentes e deploy público.
