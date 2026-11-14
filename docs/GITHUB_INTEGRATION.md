# Integração GitHub (somente leitura) — Issue #002

Este documento cobre as decisões de arquitetura, a segurança e a configuração local da integração.
O relatório de entrega está em [`IMPLEMENTATION_REPORT_002.md`](IMPLEMENTATION_REPORT_002.md).

## Visão geral

```
Navegador (SPA React)  ──GET /api/...──▶  Vite (proxy /api)  ──▶  Servidor Node (127.0.0.1:8787)  ──GraphQL (query fixa)──▶  api.github.com
       ▲                                                              │  credencial: fine-grained ou gh-cli local (só aqui)
       └──────────── JSON normalizado (shared/contracts.ts) ◀─────────┘  cache em memória · allowlist · limites
```

- **O navegador nunca recebe o token**, nem fala com `api.github.com`.
- O servidor expõe somente **2 endpoints `GET` com caminho fixo**. Não existe proxy genérico.
- Os dados chegam ao frontend já **normalizados** (`shared/contracts.ts`). Os tipos crus do GitHub ficam em `server/github/raw-types.ts` e não saem do servidor.

## Decisões de arquitetura

| Decisão | Alternativas consideradas | Motivo |
| --- | --- | --- |
| Servidor Node mínimo (`node:http`, sem framework) | Express/Fastify/Hono; serverless; só proxy do Vite | Aprovado pelo PO. São 2 rotas, então um framework não compensa a dependência. Serverless prende a um provedor e envolve deploy (fora do escopo). O proxy do Vite sozinho só existe em dev e facilita um proxy aberto. |
| **TypeScript executado nativamente pelo Node** (`--experimental-strip-types`) | `tsx` (autorizado) | Dispensa a dependência nova. Funciona em Node 24 (padrão) e 22.13+ (com a flag). Exige `erasableSyntaxOnly`, aplicado em `tsconfig.server.json`. |
| **GraphQL v4 com consulta fixa** | REST v3 | Ver comparação abaixo. |
| Snapshot agregado por repositório (`/snapshot`) | Endpoints separados para issues, PRs e branches | Uma consulta ao GitHub por atualização, consistência entre indicadores e cache simples. |
| Allowlist **no código** (`server/config.ts`) | Variável de ambiente | Lista explícita e versionada. Toda ampliação passa por revisão de PR. |
| Sem `concurrently` | — | Decisão do PO: `npm run dev` e `npm run server` rodam em terminais separados. |
| Estado da integração em um Context React | Biblioteca de cache (TanStack Query, SWR) | Evita uma dependência nova. Atualização apenas manual nesta issue. |

### REST × GraphQL

| Critério | REST v3 | GraphQL v4 (escolhido) |
| --- | --- | --- |
| Requisições por snapshot | 1 repo + 1 issues + 2 PRs + 1 branches + Search API para contagens + 1–2 por PR/branch para checks: **dezenas** | **1** (custo ≈ 1 ponto) |
| Contagem de issues abertas | `open_issues_count` **soma PRs**; exige a Search API, que tem limite próprio de 30/min | `issues(states: OPEN) { totalCount }`, exato |
| Draft, decisão de revisão, CI agregado | Campos espalhados e chamadas extras (`/check-runs`, `/status`) | `isDraft`, `reviewDecision` e `statusCheckRollup` na mesma consulta |
| Requisições condicionais (ETag/304) | Sim, e não consomem cota | Não. Compensado por cache de 60 s, intervalo mínimo de 15 s e bloqueio até o reset do limite. |
| Tratamento de erros | Por status HTTP | Pode vir HTTP 200 com `errors` e dados parciais. Tratado em `client.ts`, e os dados parciais viram avisos. |
| Risco de "proxy aberto" | — | Mitigado: a consulta é uma constante do servidor e o navegador não envia consultas. A operação é sempre `query`, sem `mutation` (há teste). |

## Autenticação

O modo é escolhido **explicitamente** por `GITHUB_AUTH`. Não há detecção automática.

| `GITHUB_AUTH` | Credencial | Uso |
| --- | --- | --- |
| ausente, vazio ou `fine-grained` | `GITHUB_TOKEN` fine-grained (`github_pat_…`). Tokens clássicos (`ghp_`), OAuth (`gho_`) e outros formatos são recusados nessa variável. Sem token = modo demonstração. | **Padrão recomendado** |
| `gh-cli` | Sessão local do GitHub CLI (`gh auth token`) | **Somente desenvolvimento local** |

Regras de configuração (o servidor **não inicia** se forem violadas):
- `gh-cli` com `GITHUB_TOKEN` preenchido → configuração ambígua.
- `gh-cli` sem `ACC_DEPLOYMENT=local` declarado explicitamente → recusado (Issue #003).
- `gh-cli` com `NODE_ENV=production` → recusado.
- `ACC_DEPLOYMENT` com valor diferente de `local`/`production` → recusado, em qualquer modo.
- O `gh-cli` autentica o **desenvolvedor** perante o GitHub; ele **não** autentica usuários desta aplicação.
- `GITHUB_AUTH` com valor desconhecido → recusado. O valor não é repetido na mensagem.
- `GH_PATH`, se definido, precisa ser um caminho absoluto e só vale com `gh-cli`.

- **Preparado para GitHub App** (sem implementação): o cliente HTTP depende só da interface `CredentialProvider` (`server/auth/credentials.ts`). Um futuro `GitHubAppProvider` gera o JWT e o token de instalação e implementa `getAuthorizationHeader()` (e, opcionalmente, `invalidate()`), sem mudar o cliente, as rotas ou o frontend.
- Em ambos os modos, o token vive apenas no closure do provedor. `JSON.stringify`, `String()`, `console.log` e `util.inspect` do provedor não o revelam (há teste).

### Modo `gh-cli` (somente desenvolvimento local)

> ⚠️ **Risco residual.** O token OAuth do GitHub CLI normalmente tem escopos **amplos**, como `repo` e `workflow`. Isso dá **escrita e administração em todos os repositórios da conta**, não só neste. O modo `gh-cli` **não reduz** essas permissões. A garantia de somente leitura vem exclusivamente do código do servidor (abaixo). Uma falha nessas barreiras teria o alcance do token, não da aplicação.

Como funciona (`server/auth/ghCli.ts`):
- Executa **apenas** `gh auth token --hostname github.com`, com argumentos congelados, via `execFile`, sem shell, com `windowsHide`, **timeout de 5 s** e **saída limitada a 1 KiB**. Nenhum dado de requisição chega a esse módulo.
- Remove do ambiente do `gh` as variáveis `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` e `GH_HOST`. Assim o token vem sempre da sessão do CLI (keyring).
- Valida a saída (uma linha, formato `gho_`/`ghu_`/`ghp_`/`github_pat_`). Qualquer falha gera uma **mensagem fixa**: stdout, stderr e a causa original nunca são propagados.
- Mantém o token em **cache por 10 min**. Chamadas simultâneas compartilham uma única execução. Falhas não ficam em cache.
- Na inicialização, o servidor confirma que o `gh` entrega um token válido, ou encerra. Depois registra um aviso de que o modo usa credencial ampla.
- Se o GitHub responder **401**, o cliente chama `invalidate()`, obtém a credencial de novo **uma única vez** e repete a consulta **uma única vez**. Um segundo 401 encerra com `unauthorized`, sem loop. O token fine-grained não é renovável e não repete a consulta.

Barreiras de somente leitura, válidas mesmo com credencial que permite escrita:
1. As rotas de dados aceitam apenas `GET`/`HEAD` e exigem sessão do administrador (Issue #003, PR 2). `POST` existe só em `/api/auth/login` e `/api/auth/logout`, que não chegam ao GitHub.
2. Allowlist de repositórios no código.
3. **Allowlist estrita de documentos GraphQL** (`APPROVED_DOCUMENTS` em `server/github/client.ts`): o cliente só envia documentos **idênticos** à `REPO_SNAPSHOT_QUERY`. Qualquer outro documento, inclusive a query aprovada com algo anexado, é recusado **antes** de obter a credencial ou tocar a rede. Ao carregar o módulo, o servidor verifica que todo documento aprovado é uma `query` sem `mutation`/`subscription`.
4. Endpoint fixo `https://api.github.com/graphql` com `redirect: 'error'`.
5. O frontend não envia comandos, caminhos de API nem consultas.

Limitações e por que **não** serve para servidor público:
- **Credencial pessoal:** todas as consultas saem como o dono da sessão do `gh`. O servidor não autentica usuários, então qualquer visitante agiria como essa pessoa, e a auditoria do GitHub registraria o nome dela, não o da aplicação.
- **Alcance:** o token vale para todos os repositórios da conta, com escrita.
- **Depende da sessão interativa:** keyring do Windows/macOS, `gh` instalado e login ativo. Um `gh auth logout` derruba a integração (`missing_credentials`). Não funciona como serviço sem usuário logado.
- **PATH:** sem `GH_PATH`, o servidor resolve o `gh` por conta própria (`resolveGhExecutable`): considera só entradas **absolutas** do PATH, ignora `.`, entradas vazias e relativas e, no Windows, aceita apenas `gh.exe`. Assim, um `gh.exe` plantado na pasta do projeto não é executado (a busca padrão do Windows consulta o diretório atual antes do PATH). Um `gh` falso colocado numa pasta absoluta do PATH, antes do verdadeiro, ainda seria executado. É aceitável na máquina do próprio desenvolvedor, inaceitável em máquina compartilhada. Use `GH_PATH` para fixar o executável.
- **Para servidor público:** GitHub App (tokens de instalação curtos, restritos ao repositório e só leitura) com autenticação de usuários. Isso está previsto para a Issue #003.

Para voltar ao fine-grained basta mudar a configuração: remova `GITHUB_AUTH` (ou use `fine-grained`) e preencha `GITHUB_TOKEN`.

### Permissões do token (Settings → Developer settings → Fine-grained tokens)

- **Resource owner:** `Moreirapontocom-br`. **Repository access:** *Only select repositories* → `ai-command-center`.
- **Repository permissions**, todas *Read-only*: `Metadata` (obrigatória), `Contents` (branches e commits), `Issues`, `Pull requests` e `Commit statuses` (checks de CI).
- **Nenhuma** permissão de escrita e nenhuma permissão de conta.
- Defina uma data de expiração curta.

> Se o token não puder ler algum campo (por exemplo, os checks de CI), o GitHub devolve dados parciais. A interface mostra **"CI: sem informação"** e um aviso de *dados parciais*, sem inventar o estado.

## Endpoints internos

| Método | Caminho | Resposta |
| --- | --- | --- |
| `GET` | `/api/status` | `{ configured, authMode, repositories }`, sem nenhum segredo |
| `GET` | `/api/repos/:owner/:repo/snapshot[?refresh=1]` | `{ snapshot, freshness: { stale, staleReason } }` |

Qualquer outra rota responde 404. Métodos diferentes de `GET`/`HEAD` respondem 405. Parâmetros desconhecidos respondem 400.

Erros seguem `{ error: { code, message, resetAt?, retryAfterSeconds? } }`, sempre com **mensagens fixas do servidor**. O corpo devolvido pelo GitHub nunca é repassado.

| Código | HTTP | Quando |
| --- | --- | --- |
| `missing_credentials` | 503 | `GITHUB_TOKEN` não configurado, ou o `gh` não entregou credencial (modo `gh-cli`) |
| `unauthorized` | 502 | GitHub respondeu 401 (token inválido, expirado ou revogado; no `gh-cli`, mesmo após uma renovação) |
| `forbidden` | 502 | 403 sem indicação de limite, ou GraphQL `FORBIDDEN`/`NOT_FOUND` (repositório fora do escopo do token) |

Para o navegador, `FORBIDDEN`, `NOT_FOUND` e HTTP 403 têm o mesmo código e a mesma mensagem, para não revelar se o repositório existe. Internamente o erro carrega um `reason` (`graphql_forbidden`, `graphql_not_found`, `http_403`, `credential_unavailable`, `credential_rejected_after_renewal`, `document_not_approved`) que aparece **apenas no log do servidor**.
| `rate_limited` | 429 | Limite primário ou secundário do GitHub (com `resetAt`/`retryAfterSeconds`) |
| `too_many_requests` | 429 | Limite local: 60 req/min por cliente |
| `network` / `timeout` | 502 / 504 | Falha de conexão ou mais de 10 s sem resposta |
| `upstream_invalid` / `upstream_error` | 502 | Resposta inesperada ou 5xx do GitHub |
| `not_found` / `bad_request` / `method_not_allowed` / `forbidden_origin` | 404 / 400 / 405 / 403 | Proteções locais |

## Proteções contra uso indevido

1. **Bind só em loopback.** O servidor não inicia com `API_HOST` fora de `127.0.0.1`, `localhost` ou `::1`. Mesmo com o login de administrador (Issue #003, PR 2), a exposição à rede exige HTTPS, Host/origens configuráveis e proxy confiável, ainda não implementados.
2. **Allowlist de repositórios** (comparação sem diferenciar maiúsculas). Fora dela, a resposta é 404 e o GitHub não é consultado.
3. **Validação de parâmetros** com regex em `owner` e `repo`, e query string restrita a `refresh=1`.
4. **`Host` obrigatório de loopback**, contra DNS rebinding. **`Origin` desconhecida** e **`Sec-Fetch-Site: cross-site`** são recusadas. Não há cabeçalhos CORS.
5. **Limites:**
   - 60 req/min por cliente;
   - cache de 60 s por repositório;
   - `?refresh=1` respeita um intervalo mínimo de 15 s;
   - requisições simultâneas são agrupadas;
   - depois de um `rate_limited`, nenhuma nova chamada ao GitHub até o horário de reset.
6. **Timeout** de 10 s nas chamadas ao GitHub (`AbortSignal.timeout`), além de `requestTimeout` e `headersTimeout` no servidor HTTP.
7. **Logs:** registram apenas método, caminho, status e duração. A query string nunca é registrada. O logger mascara `github_pat_…`, `gh[pousr]_…`, `Bearer …` e chaves PEM.
8. **Nada de segredo no frontend:**
   - o servidor não inicia se houver variáveis `VITE_*` com nomes de credencial;
   - `npm run check:secrets` varre o `dist/` em busca de padrões de token e do valor exato configurado, e roda também na CI.
10. **Verificação de segredos no repositório** (`scripts/check-secrets.mjs`, job `secret-scan` da CI). Nunca imprime o valor: cada achado mostra arquivo, linha, regra e uma impressão digital SHA-256 truncada.
   - `tracked`: todos os arquivos versionados. Também recusa `.env`/`.env.*` versionados, exceto `.env.example`.
   - `commits <base>..<head>`: linhas adicionadas por cada commit do PR. Na CI roda sobre o intervalo do PR.
   - `history`: todo o histórico de `HEAD`. `staged`: conteúdo preparado, para o hook opcional `.githooks/pre-commit` (ative com `git config core.hooksPath .githooks`).
   - Regras: tokens do GitHub (`github_pat_`, `gh[pousr]_`), chaves PEM, chaves AWS, o valor exato do `GITHUB_TOKEN` local e **qualquer valor preenchido** em variável sensível (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*API_KEY*`…) de `.env.example`.
   - Exceções só pelo SHA-256 completo do valor, com justificativa, em `scripts/secret-scan-allowlist.json`. Hoje a lista contém apenas o canário fictício dos testes.
9. **Links seguros:** só URLs `https://github.com/…` passam pela normalização. Os links abrem com `rel="noopener noreferrer"`.

## Estado "desatualizado" e dados ausentes

- Em `rate_limited`, `network`, `timeout` ou `upstream_error`, o servidor devolve o último snapshot bom com `stale: true`. A interface mostra **"Dados desatualizados"** com o motivo e a data da última sincronização bem-sucedida.
- Em `unauthorized` ou `forbidden`, o cache **não** é servido: a credencial deixou de valer.
- Campos opcionais ausentes viram `null` ou `unknown`. Itens sem campos obrigatórios são descartados e geram aviso. Contagens ausentes invalidam o snapshot (`upstream_invalid`). Nada é inventado.
- **"PRs aguardando revisão"** conta apenas PRs abertos, que não estão em draft e têm `reviewDecision = REVIEW_REQUIRED` ou um revisor solicitado ainda sem resposta. PRs sem essa informação aparecem como *"sem informação de revisão"* e não entram na contagem.

## Configuração local

```bash
npm install
cp .env.example .env.local      # preencha GITHUB_TOKEN localmente (nunca versionar)

# terminal 1 — servidor somente leitura (http://127.0.0.1:8787)
npm run server                  # ou: npm run dev:server (reinicia ao editar)

# terminal 2 — frontend (http://localhost:5173, com proxy /api → 8787)
npm run dev
```

- **Sem `GITHUB_TOKEN`:** o servidor inicia em modo demonstração e a interface mostra **"Credencial ausente"**.
- **Com GitHub CLI (só local):** `gh auth status` precisa estar ok. Defina `ACC_DEPLOYMENT=local`, `GITHUB_AUTH=gh-cli` e deixe `GITHUB_TOKEN` vazio no `.env.local`. Para um teste pontual sem editar o arquivo, variáveis do shell têm precedência: em PowerShell, `$env:ACC_DEPLOYMENT='local'; $env:GITHUB_AUTH='gh-cli'; $env:GITHUB_TOKEN=''; npm run server`.
- **Sem o servidor:** a interface mostra **"Erro de rede"**. Em ambos os casos agentes e tarefas continuam em modo demonstração, e nenhum dado do GitHub é simulado.

Variáveis (ver [`.env.example`](../.env.example)):

| Variável | Obrigatória | Padrão | Descrição |
| --- | --- | --- | --- |
| `ACC_DEPLOYMENT` | Só com `gh-cli` | — (não declarado) | `local` (máquina do desenvolvedor; única opção que aceita `gh-cli`) ou `production` |
| `GITHUB_AUTH` | Não | `fine-grained` | `fine-grained` ou `gh-cli` (somente desenvolvimento local, exige `ACC_DEPLOYMENT=local`) |
| `GITHUB_TOKEN` | Não (sem ela = modo demonstração) | — | Token fine-grained somente leitura. Deve ficar vazio com `gh-cli`. |
| `GH_PATH` | Não | `gh` (`gh.exe` no Windows) na primeira entrada absoluta do PATH | Caminho absoluto do GitHub CLI (apenas com `gh-cli`) |
| `API_HOST` | Não | `127.0.0.1` | Apenas loopback |
| `API_PORT` | Não | `8787` | Porta do servidor. Para mudá-la também no proxy do Vite, exporte a variável no shell: o Vite não lê `.env.local` para `vite.config.ts`. |
