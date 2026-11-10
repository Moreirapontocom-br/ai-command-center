# Relatório de implementação — Issue #002: Integração GitHub somente leitura

- **Branch:** `feature/002-github-integration`, criada a partir de `origin/main` em `90f1849` (merge do PR #1).
- **Base validada:** PR #1 com estado `MERGED` em 2026-11-10T20:03:05Z. O conteúdo da `main` é idêntico ao de `feature/001-project-setup@0e17cc2`.
- **Sem alterações na `main`**, sem merge, sem push forçado e sem deploy. Nenhuma operação de escrita no GitHub foi implementada nem executada pela aplicação.

Decisões de arquitetura, segurança e configuração: [`GITHUB_INTEGRATION.md`](GITHUB_INTEGRATION.md).

## Decisões aprovadas e como foram aplicadas

| Decisão do PO | Aplicação |
| --- | --- |
| Servidor Node mínimo | `server/`, com `node:http`, 2 rotas `GET` e sem framework |
| GraphQL justificado frente ao REST | Comparação em `GITHUB_INTEGRATION.md` e no cabeçalho de `server/github/queries.ts` |
| `tsx` se necessário; sem `concurrently` | **Nenhum dos dois foi adicionado.** O Node executa TypeScript nativamente (`--experimental-strip-types`). |
| Apenas token fine-grained; separação para GitHub App | `CredentialProvider` em `server/auth/credentials.ts`. Tokens que não são `github_pat_` são recusados. |
| Sem atribuição automática a agentes | Issues mostram só os responsáveis registrados no GitHub. O tipo `Task` (demo) não foi reaproveitado para issues. Há teste confirmando que nenhum nome de agente aparece na lista de issues. |
| Repositório autorizado: `Moreirapontocom-br/ai-command-center` | `ALLOWED_REPOSITORIES` em `server/config.ts` |

## Critérios de aceite

| Critério | Situação | Evidência |
| --- | --- | --- |
| Dados reais de ≥ 1 repositório autorizado consultáveis | 🟡 **Parcial** | A consulta fixa e a normalização foram **validadas contra a API real** (`issue002-graphql-real-schema-check.txt`: 0 erros, 23 issues abertas, PR #1 incorporado, 2 branches). O caminho com o token fine-grained da aplicação (`.env.local` + `npm run server`) ainda depende da configuração do PO; ver "Validação com dados reais" abaixo. |
| Issues e PRs exibidos corretamente | ✅ (simulado) | `GitHubIntegration.test.tsx`; capturas `issue002-simulado-*` |
| Branches listadas | ✅ (simulado) | Teste "lista branches com commit HEAD"; `issue002-simulado-branches-1440.png` |
| Indicadores com dados reais, sem contagens fictícias | ✅ | Todos derivados de `totalCount` e dos dados do snapshot; nada é inventado quando falta informação (`normalize.test.ts`) |
| Estados de erro e carregamento | ✅ | Carregando, conectado, sem dados, credencial ausente, acesso negado, erro de rede, limite de requisições e dados desatualizados: todos testados |
| Credenciais não aparecem no frontend | ✅ | `check:secrets` (também na CI); testes com token canário em respostas e logs |
| Dados demonstrativos identificados | ✅ | Aviso "Dados fictícios" nas seções de agentes e tarefas, títulos "(demonstração)" e selo "Modo demonstração" no cabeçalho enquanto não há dados reais |
| Interface responsiva | ✅ | Capturas em 390px e 1440px; sem rolagem horizontal a 390px (verificado no Chrome) |
| Sem operações de escrita no GitHub | ✅ | Só `query` GraphQL (há teste); rotas só aceitam `GET`/`HEAD` |
| Testes existentes passando | ✅ | 20 testes da #001 mantidos e verdes |
| Novos testes: integração, transformação e erros | ✅ | 81 testes novos (101 no total) |
| `npm test`, `npm run lint` e `npm run build` | ✅ | `docs/evidence/issue002-checks-output.txt` |
| Nenhuma mudança direta na `main` / nenhum merge | ✅ | Trabalho só em `feature/002-github-integration` |

## Validação com dados reais (pendente — ação do PO)

A credencial é configurada manualmente pelo PO e não foi criada, lida nem manipulada por mim. Para validar:

1. Crie o token conforme [`GITHUB_INTEGRATION.md` → Permissões do token](GITHUB_INTEGRATION.md#permissões-do-token-settings--developer-settings--fine-grained-tokens).
2. Coloque-o em `.env.local` como `GITHUB_TOKEN=...`.
3. Rode `npm run server` e `npm run dev`.

A consulta já foi executada contra a API real com a credencial do `gh` CLI do PO (somente leitura), não com a da aplicação. Resultado em `docs/evidence/issue002-graphql-real-schema-check.txt`:
- o schema aceita todos os campos;
- o custo é de 2 pontos;
- a normalização não gerou avisos;
- a `main` aparece com CI "sem informação", o que é correto, porque a CI só roda em PRs e o commit de merge não tem checks.

O servidor da aplicação recusa o token OAuth do `gh` (`gho_`) por design.

Pontos a confirmar na execução com o token da aplicação:
- se o token fine-grained enxerga o `statusCheckRollup` dos checks do GitHub Actions. Se não enxergar, aparece "CI: sem informação" e um aviso de dados parciais;
- se o indicador "aguardando revisão" corresponde ao estado real dos PRs.

## Arquivos criados

| Arquivo | Função |
| --- | --- |
| `shared/contracts.ts` | Tipos internos compartilhados entre servidor e frontend |
| `server/index.ts` | Inicialização: carrega `.env.local`, valida a configuração e sobe o servidor em loopback |
| `server/config.ts` | Allowlist, porta/host, recusa de configuração insegura |
| `server/auth/credentials.ts` | `CredentialProvider` e provedor de token fine-grained |
| `server/logger.ts` | Logger JSON com mascaramento de segredos |
| `server/http/app.ts` | Rotas, validação, proteções de Host/Origin e respostas normalizadas |
| `server/http/rateLimiter.ts` | Limite por cliente (janela fixa) |
| `server/github/client.ts` | Cliente GraphQL: timeout e mapeamento de 401/403/429/rede/5xx/erros GraphQL |
| `server/github/queries.ts` | Consulta fixa do snapshot e justificativa GraphQL × REST |
| `server/github/raw-types.ts` | Tipos crus da resposta do GitHub |
| `server/github/normalize.ts` | Transformações puras GitHub → contrato interno |
| `server/github/errors.ts` | Erros normalizados, mensagens fixas e status HTTP |
| `server/snapshotService.ts` | Cache, intervalo mínimo, agrupamento, fallback desatualizado e bloqueio por limite |
| `server/test/fixtures.ts` | Respostas GraphQL simuladas e token canário |
| `server/**/*.test.ts` (5 arquivos) | Testes do servidor |
| `src/services/githubApi.ts` (+ teste) | Cliente do servidor intermediário no navegador |
| `src/features/github/*` | Provider de dados, painel do dashboard, páginas de Issues, PRs e Branches, estados de conexão e rótulos |
| `src/components/ui/Badge.tsx` | Selo genérico por tom, reaproveitado pelo `StatusBadge` |
| `src/test/githubFixtures.ts` | Snapshot normalizado simulado e mock de `fetch` |
| `scripts/check-dist-secrets.mjs` | Varredura de credenciais no build |
| `tsconfig.server.json` | Typecheck do servidor (`erasableSyntaxOnly`) |
| `.env.example` | Variáveis sem valores |
| `docs/GITHUB_INTEGRATION.md`, `docs/IMPLEMENTATION_REPORT_002.md` | Documentação |
| `docs/evidence/issue002-*` | Evidências de testes, servidor e telas |

## Arquivos modificados

| Arquivo | Mudança |
| --- | --- |
| `package.json` | Scripts `server`, `dev:server` e `check:secrets`. **Nenhuma dependência nova.** |
| `vite.config.ts` | Proxy `/api` → `127.0.0.1:8787` em `dev` e `preview` |
| `tsconfig.json`, `tsconfig.app.json` | Referência ao projeto do servidor; inclusão de `shared/` |
| `eslint.config.js` | Globals de Node para `server/` e `scripts/` |
| `.github/workflows/ci.yml` | Passo `npm run check:secrets` após o build |
| `src/types/index.ts`, `src/components/layout/navigation.ts`, `src/App.tsx` | Telas Issues, Pull Requests e Branches; provider de dados |
| `src/components/layout/Header.tsx` | Selo de origem dos dados: "Modo demonstração", "GitHub conectado" ou "GitHub: dados desatualizados" |
| `src/features/dashboard/DashboardPage.tsx` | Seção "Repositório no GitHub" com indicadores reais; seções demo rotuladas |
| `src/features/dashboard/StatCard.tsx` | Aceita valor textual e `hint` |
| `src/components/ui/StatusBadge.tsx` | Passa a usar `Badge` (mesma API e cores) |
| `src/components/ui/MockDataNotice.tsx` | O texto passa a se referir a agentes e tarefas, que são os únicos dados fictícios |
| `src/test/setup.ts` | `fetch` bloqueado por padrão nos testes: nenhuma chamada real de rede |

## Dependências introduzidas

**Nenhuma.** O `package-lock.json` não foi alterado. Os recursos necessários vêm do Node e do navegador:
- `fetch`, `AbortSignal.timeout` e `node:http`;
- `process.loadEnvFile`;
- execução nativa de TypeScript.

## Testes

- **101 testes, 11 arquivos, todos passando.** São 20 da #001 e 81 novos. Nenhum depende de rede: o `fetch` global é bloqueado e o GitHub é sempre simulado.
- Saída completa: `docs/evidence/issue002-checks-output.txt`.

| Cenário exigido (seção 8) | Onde |
| --- | --- |
| Repositório acessível | `normalize.test.ts` · `client.test.ts` |
| Repositório sem issues | `normalize.test.ts` · `GitHubIntegration.test.tsx` |
| PR em draft / aberto / fechado sem merge / incorporado | `normalize.test.ts` (bloco "Pull Requests") · `GitHubIntegration.test.tsx` |
| Falha de autenticação | `client.test.ts` (401) · `app.test.ts` · UI "Acesso negado" |
| Erro de permissão | `client.test.ts` (403, `NOT_FOUND`) · UI "Acesso negado" |
| Limite de requisições | `client.test.ts` (403 + remaining 0, 429 + retry-after, `RATE_LIMITED`) · `snapshotService.test.ts` (bloqueio até o reset) · `app.test.ts` (limite local) · UI |
| Falha de conexão | `client.test.ts` (rede e timeout) · `githubApi.test.ts` · UI "Erro de rede" |
| Dados incompletos ou inesperados | `normalize.test.ts` (itens descartados, URLs inválidas, contagens ausentes, erros parciais) · `githubApi.test.ts` |
| Proteção contra exposição de credenciais | `config.test.ts` (serialização e inspeção do provedor, logger, `VITE_*`) · `app.test.ts` (token canário ausente de respostas e logs, query string não logada) · `client.test.ts` (token só no `Authorization`) · `check:secrets` |
| Estados de carregamento e erro na interface | `GitHubIntegration.test.tsx` |

Outras verificações:
- **Teste de fumaça do servidor real** (`docs/evidence/issue002-server-smoke-test.txt`): status, credencial ausente, repositório fora da allowlist, proxy aberto, `POST`/`DELETE`, `Host` e `Origin` hostis, e recusas de `API_HOST=0.0.0.0`, token clássico e `VITE_GITHUB_TOKEN`.
- **Teste positivo da varredura:** um `dist` falso com token plantado faz o `check:secrets` falhar com código 1.

## Evidências visuais

Capturadas no Chrome headless via DevTools Protocol, com o fluxo completo: Vite, proxy `/api` e servidor.

| Arquivo | Conteúdo |
| --- | --- |
| `issue002-graphql-real-schema-check.txt` | Consulta fixa executada contra a API real e normalizada (indicadores reais do repositório) |
| `issue002-real-sem-credencial-1440.png` | **Servidor real**, sem token: estado "Credencial ausente" e demo identificado |
| `issue002-simulado-dashboard-1440.png` / `-390.png` | Dashboard conectado, desktop e mobile |
| `issue002-simulado-pull-requests-1440.png` / `-390.png` | PRs: draft, pronto, aguardando revisão, CI, incorporado e fechado sem merge |
| `issue002-simulado-issues-1440.png` | Issues com responsável, labels, data e estado |
| `issue002-simulado-branches-1440.png` | Branches com HEAD e CI |

> ⚠️ **As capturas `issue002-simulado-*` não mostram dados reais.** Foram geradas com o código real do servidor (rotas, normalização e cache), mas com a chamada ao GitHub substituída por respostas fixas, cujos títulos têm o prefixo `[SIMULADO]`. Por isso o selo "Dados reais do GitHub" aparece nelas: a interface exibe o que o servidor afirma. As capturas com dados reais dependem do token do PO.

## Limitações identificadas

1. **Listas limitadas:** até 50 issues abertas, 50 PRs abertos, 10 issues e 10 PRs fechados recentes, 100 branches, e até 10 responsáveis e 20 labels por item. Os totais vêm de `totalCount`, que é exato, e a interface avisa quando a lista está truncada. A contagem "aguardando revisão" é marcada como parcial se houver mais de 50 PRs abertos.
2. **"Aguardando revisão" depende do repositório.** Sem regra de proteção de branch exigindo revisão, o `reviewDecision` vem `null`. Nesses casos só PRs com revisor solicitado entram na contagem, e os demais aparecem como "sem informação".
3. **CI** reflete o `statusCheckRollup` do commit HEAD, não o histórico de execuções. A visibilidade dos checks com token fine-grained ainda precisa ser confirmada na validação real.
4. **Apenas o primeiro repositório** da allowlist é exibido na interface. O servidor já aceita vários.
5. **Cache e limites em memória:** são perdidos ao reiniciar o servidor e não funcionam com várias instâncias.
6. **Origens aceitas fixas** (`localhost`/`127.0.0.1` nas portas 5173 e 4173). Requisições `GET` da própria origem normalmente não enviam `Origin`, então outras portas funcionam, mas a lista não é configurável.
7. **Sem servidor de produção:** o servidor atende só a API e o frontend é servido pelo Vite (`dev`/`preview`). Hospedagem e deploy ficam fora do escopo.
8. **`--experimental-strip-types`:** no Node 22.13–22.17 o recurso é experimental. No Node 24 é estável.
9. **Ambiente de desenvolvimento local:** a porta 5173 desta máquina está ocupada por um contêiner Docker sem relação com o projeto. As capturas usaram a porta 5181, sem impacto no código.

## Riscos de segurança conhecidos

| Risco | Mitigação atual | Residual |
| --- | --- | --- |
| Token no disco (`.env.local`) | Ignorado pelo Git (`.env.*`); token só de leitura, restrito a 1 repositório, com expiração | Qualquer processo do usuário local consegue ler o arquivo |
| Outros processos locais consultando a API | Loopback, Host/Origin, `Sec-Fetch-Site`, limite por cliente | Um processo local malicioso pode ler o snapshot. Não há autenticação de usuário, o que foi aceito para uso local. |
| Exposição acidental na rede | O servidor recusa host fora do loopback | Um túnel manual (ngrok etc.) contornaria isso. Não faça sem autenticação. |
| Vazamento via build | Recusa de `VITE_*` com nome de credencial; `check:secrets` local e na CI | Padrões cobrem os formatos conhecidos do GitHub |
| Dados do GitHub exibidos na interface (XSS) | O React escapa o texto; só links `https://github.com/`; cor de label validada | — |
| Esgotamento da cota da API | Cache, intervalo mínimo, agrupamento, bloqueio até o reset | — |

## Itens pendentes para a Issue #003

- Validação com token real e capturas com dados reais (ação do PO).
- GitHub App: implementar `GitHubAppProvider` (JWT RS256 e token de instalação) sobre a interface existente.
- Paginação completa de issues e PRs, se o volume ultrapassar os limites atuais.
- Seleção de repositório na interface quando houver mais de um autorizado.
- Autenticação de usuários, pré-requisito para qualquer acesso fora do loopback.
- Histórico de execuções do CI (GitHub Actions), se desejado.
- Convenção explícita e confiável (labels ou metadados) para associar issues a agentes, mediante decisão do PO.
- Servidor de produção que sirva `dist/` e a API juntos, se houver plano de hospedagem.
