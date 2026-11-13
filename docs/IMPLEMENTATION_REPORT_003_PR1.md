# Relatório de implementação — Issue #003, PR 1

**Segurança, governança e endurecimento da infraestrutura**

| Item | Valor |
| --- | --- |
| Branch | `feature/003-security-foundation` (criada a partir de `origin/main`) |
| SHA inicial (base) | `0de3903d9530feb45cc8d25a91fe7f0fbd580ec1` (merge do PR #32), igual à base esperada |
| Commits | `c65fa35` S1 (governança) · `c360d05` S2 (segurança) · commit deste relatório (head da branch; SHA completo na descrição do PR) |
| Escopo | Somente o PR 1. **Nenhuma** autenticação, login, senha ou sessão (PR 2) |
| Data | 13/11/2026 |

## 1. Fase 0 — verificações

| Verificação | Resultado |
| --- | --- |
| Repositório / origin | `Moreirapontocom-br/ai-command-center` |
| `git fetch` / `origin/main` | `0de3903…`, sem divergência (reconfirmado antes da publicação) |
| PR #32 | MERGED, merge commit `0de3903…` |
| PR #25 | CLOSED, `mergedAt = null` (fechado sem merge) |
| Branch 003 preexistente | Nenhuma (local ou remota) |
| Arquivos não versionados | `docs/evidence/issue002-review-validation.txt` e `documenta_o_t_cnica_initial_issue_001.md` preservados e **fora** dos commits |
| CI na `main` | Nunca executou: o workflow só disparava em `pull_request`/`workflow_dispatch` (todos os 6 runs anteriores são `pull_request`) |
| `core.hooksPath` | Não definido em nenhum escopo antes desta issue |

## 2. S1 — Governança de branches

| Entrega | Arquivo |
| --- | --- |
| Política de branches (regras, limitações do Free, preventivo × detectivo, hooks, auditoria) | `docs/BRANCH_POLICY.md` |
| Hook pre-push | `.githooks/pre-push` (modo `100755`, LF forçado por `.gitattributes`) |
| Ativação segura de `core.hooksPath` | `scripts/install-git-hooks.mjs` · `npm run hooks:install` / `hooks:check` |
| CI também em push na `main` | `.github/workflows/ci.yml` |
| Auditoria informativa da `main` | `.github/workflows/main-audit.yml`, `scripts/audit-main.mjs`, `scripts/main-audit-lib.mjs` · `npm run audit:main` |
| Testes | `scripts/pre-push-hook.test.mjs` (17), `scripts/main-audit.test.mjs` (21) |

**Hook pre-push.** Recusa qualquer ref remota `refs/heads/main` (sem diferenciar maiúsculas), em qualquer remoto ou URL; indica se seria atualização, atualização forçada ou exclusão. Com vários refspecs, o push inteiro é recusado e nada é enviado. Testado com o Git real em repositórios temporários (configuração global isolada): `main`, `HEAD:main`, `feature:refs/heads/main`, remoto `upstream`, URL direta, `Main`, `:main`, `--delete`, `--force`, `+refspec`, `--force-with-lease`, `--all`, `--mirror`, múltiplos refspecs; permitidos: branch de feature, `feature/main-fix`, `mainline`, `main2` e tags. Um teste **documenta a limitação**: `--no-verify` ignora o hook. Também verificado no clone real com `git push --dry-run origin HEAD:main` (bloqueado; nada enviado).

**`core.hooksPath`.** O instalador só grava na configuração **local** e só se a chave estiver vazia; recusa (sem alterar nada) se houver outro valor ou hooks em `.git/hooks`. Neste clone foi ativado (`.githooks`) após a checagem.

**Auditoria da `main`.** Investigação da API (evidência em `docs/evidence/issue003-pr1-governance.txt`):

- `forced`/`deleted` do evento `push` são fatos do GitHub → **alerta** (job falha);
- `GET /commits/{sha}/pulls` devolve o PR mesclado que introduziu o commit (merge, squash, rebase). Validado nos 10 commits reais da `main`: 9 associados aos PRs #1/#32 e o commit raiz `e706359` (criação do repositório), classificado como `info`;
- commit sem PR mesclado → **atenção** (aviso, job verde), nunca "violação"; falha de API → **inconclusivo**; novas tentativas cobrem o atraso de indexação;
- não usados como critério: autor/committer, `pusher`, assinatura `web-flow` (não distinguem com segurança merge legítimo de alteração local).

Simulação do evento `push` do merge do PR #32: **OK**, sem falso positivo. O mesmo evento com `forced=true`: **ALERTA**, saída 1.

## 3. S2 — Endurecimento de segurança

| Entrega | Arquivo |
| --- | --- |
| Cabeçalhos (fonte única) | `shared/securityHeaders.ts`, aplicados em `server/http/app.ts` e `vite.config.ts` |
| Verificação do build contra a CSP | `scripts/check-dist-csp.mjs` · `npm run check:csp` (novo passo da CI) |
| Mascaramento de logs | `server/logger.ts` |
| gh-cli restrito a `ACC_DEPLOYMENT=local` | `server/config.ts` |
| Testes | `server/hardening.test.ts` (40), `server/config.test.ts` (+6) |

**Cabeçalhos.** API (todas as respostas, inclusive 400/403/404/405/429/500): `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, sem CORS. Frontend: os mesmos básicos, mais `Cross-Origin-Opener-Policy` e `Permissions-Policy`.

**CSP — produção (preview):** `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.

**Diferenças necessárias no dev server:** `'unsafe-inline'` em `script-src`/`style-src` (preâmbulo inline do React Refresh e CSS injetado pelo Vite) e `ws://localhost:*`/`ws://127.0.0.1:*` em `connect-src` (HMR). `ws://[::1]:*` foi descartado: o Chrome o rejeita como fonte inválida.

**Validação no navegador** (Chrome headless via DevTools Protocol, `docs/evidence/issue003-pr1-csp-browser.txt`): com dados reais (servidor em `gh-cli` + `ACC_DEPLOYMENT=local`), as 6 páginas renderizaram no preview e no dev, com Tailwind aplicado, `/api` acessível, **zero** exceções e **zero** erros de console. O fetch direto a `api.github.com` foi bloqueado nos dois modos; o script inline injetado foi bloqueado no preview. Labels coloridas (`style={{backgroundColor}}`, aplicado via CSSOM) funcionam sob a CSP de produção: cor computada correta, validada com API simulada local, porque nenhuma issue real tem label. Limitação: `eval()` não é testável via DevTools, que é isento de CSP; a política não contém `'unsafe-eval'` e o `check:csp` verifica os bundles.

**Logs e erros.** Os valores de campos sensíveis são mascarados pelo **nome**: `authorization`, `cookie`, `set-cookie`, `proxy-authorization`, `x-api-key` e nomes contendo token, secret, password, credential, session ou api-key. Também são mascarados por **padrão** na linha final: tokens do GitHub, `Bearer`/`Basic`/`Token`, PEM, cabeçalhos sensíveis em texto livre e parâmetros de query com credenciais. Além disso, `meta` não sobrescreve `time`/`level`/`message`. Testes confirmam que os cabeçalhos `Cookie`, `Authorization` e `Set-Cookie` enviados pelo cliente nunca são ecoados em respostas nem em logs, inclusive em erro interno cuja causa os contém. O campo de inicialização `credential` foi renomeado para `authMode`, porque guarda apenas o nome do modo.

**gh-cli.** O modo exige `ACC_DEPLOYMENT=local` explícito: sem ele, com `production`, vazio ou com variações como `LOCAL`/`dev`/`localhost`, é recusado sem executar o `gh`. Um valor desconhecido de `ACC_DEPLOYMENT` é recusado em qualquer modo, sem repetir o valor na mensagem. `ACC_DEPLOYMENT=local` não relaxa as demais regras: `NODE_ENV=production`, configuração ambígua com `GITHUB_TOKEN`, loopback e `GH_PATH` absoluto continuam valendo. A documentação deixa explícito que o gh-cli **não** autentica usuários da aplicação. **Impacto:** quem já usa gh-cli localmente precisa acrescentar `ACC_DEPLOYMENT=local` ao `.env.local` (atualizados: `.env.example`, `docs/GITHUB_INTEGRATION.md`, `README.md`).

**Somente leitura (novos testes).** No servidor, o único `method:` declarado é o POST do GraphQL. Não há referência a endpoints REST de escrita, permissões ou administração. Os documentos aprovados não contêm campos de mutation. Em execução, o cliente só envia query aprovada ao endpoint fixo, com `redirect: 'error'` e sem cookies. O snapshot entregue ao navegador não contém token nem cabeçalhos de autenticação. O frontend não lê variáveis de ambiente, não monta `Authorization` e não usa `credentials: 'include'`.

**Varredura de segredos.** Os controles existentes foram preservados sem alteração: `check-secrets.mjs`, a allowlist por SHA-256 e o hook pre-commit, que rodou nos dois commits. O CI ganhou o gatilho de push na `main`; nesse evento a varredura do histórico completo é executada pelo passo já existente "Scan full history".

**Nenhuma** rota POST de negócio, login ou sessão foi introduzida.

## 4. Dependências e minimatch

- `npm audit --omit=dev`: **0 vulnerabilidades**.
- `npm audit` completo: **9 moderadas**, todas de GHSA-g3hv-75wg-m249 (`minimatch@10.2.6` via `eslint@10.14.0`, `@eslint/config-array@0.23.5` e `@typescript-eslint/typescript-estree@8.72.2`).
- Risco aceito e registrado em `docs/RISK_ACCEPTANCE.md` (RISK-001): advisory, versões, caminhos, exposição, controles, justificativa, responsável (PO), **revisão em 13/12/2026** e roteiro de reavaliação.
- Não foram usados `audit fix --force`, rebaixamento, `overrides` nem edição de relatórios. `package-lock.json` está inalterado.
- **Fato novo:** `eslint@10.15.0` já usa `minimatch ^11.0.5`. Um `npm audit fix` sem `--force` corrigiria os caminhos do ESLint, mas `typescript-eslint@8.72.2` (o mais recente) ainda exige `minimatch ^10`. Não foi aplicado (fora da decisão aprovada); é a recomendação para a revisão.

## 5. Dependabot alerts

Ativado em 13/11/2026 por `PUT /repos/…/vulnerability-alerts` (HTTP 204), conforme autorização do PO. Antes, o `GET` retornava 404; depois, 204. O alerta #1 apareceu (`minimatch`, escopo `development`, medium), coerente com o diagnóstico. **Não** foram ativados: security updates automáticas (`automated-security-fixes: enabled=false`), `dependabot.yml`, automerge ou qualquer recurso pago.

## 6. Proteção preventiva × auditoria detectiva

| | Preventivo | Detectivo |
| --- | --- | --- |
| Quando age | Antes da mudança | Depois que a `main` já mudou |
| Neste PR | Hook pre-push (local, contra engano), pre-commit de segredos, processo de PR + revisão + aprovação do PO | Workflow `Main audit`, CI em push na `main` |
| Limite | Contornável (`--no-verify`, outro clone, interface web); sem proteção no servidor no plano Free | Não desfaz nada; um administrador pode desativar workflows |

A proteção **no servidor** (branch protection/rulesets) é indisponível: HTTP 403 em repositório privado no plano Free. Nenhuma regra foi criada ou alterada.

## 7. Evidências

| Arquivo | Conteúdo |
| --- | --- |
| `docs/evidence/issue003-pr1-governance.txt` | Fase 0, 403 de proteção/rulesets, Dependabot antes/depois, `core.hooksPath`, auditoria real e simulada |
| `docs/evidence/issue003-pr1-checks.txt` | Testes, lint, build, verificações de segredos (dist, versionados, commits, histórico) e CSP, hook no clone real |
| `docs/evidence/issue003-pr1-csp-browser.txt` | CSP efetiva e comportamento no Chrome (preview, preview com labels, dev) |
| `docs/evidence/issue003-pr1-csp-preview-tarefas-1440.png` | Captura do preview sob a CSP de produção |
| `docs/evidence/issue003-pr1-dependencies.txt` | `npm audit` (omit=dev e completo), `npm ls minimatch`, versões publicadas, alertas do Dependabot |

**CI do PR:** resultado registrado na descrição/comentários do PR. O workflow `Main audit` e o gatilho de push da CI só podem executar depois que estes arquivos estiverem na `main` (o GitHub lê workflows de push/dispatch da branch padrão). Portanto, **não foram executados no GitHub** neste PR, só localmente.

## 8. Pendências, riscos e limitações

1. **Proteção no servidor indisponível** (Free + privado). Opções, que são decisão do PO: tornar o repositório público ou contratar o GitHub Pro. Até lá, valem processo, hook e auditoria.
2. **Hooks são locais e opcionais**: cada clone precisa de `npm run hooks:install`; `--no-verify` contorna.
3. **Primeira execução real** da auditoria e da CI em push na `main` só ocorrerá no merge deste PR. Recomenda-se conferir o run após o merge. O commit de merge deve aparecer como `ok` (PR #N).
4. **Auditoria limitada** a 2048 commits por evento (limite do payload, sinalizado no relatório) e à consistência eventual da API.
5. **RISK-001** (`minimatch`) aberto até 13/12/2026; existe atualização parcial do ESLint disponível (seção 4).
6. **Mudança de configuração para gh-cli**: `.env.local` existentes precisam de `ACC_DEPLOYMENT=local`.
7. A CSP vale onde o Vite serve o frontend (dev e preview). Uma hospedagem futura precisa reproduzir `appSecurityHeaders('production')`.
8. Os testes do hook levam cerca de 40 s no Windows (Git real); no Linux da CI são mais rápidos.

## 9. Recomendações para o PR 2 (não implementadas)

- Antes de expor o servidor fora do loopback, implementar autenticação de usuários da aplicação. O gh-cli continua sendo só credencial do desenvolvedor perante o GitHub.
- Sessões com cookie `HttpOnly; Secure; SameSite=Strict`, prefixo `__Host-`, expiração curta e rotação no login. O logger já mascara `Cookie`/`Set-Cookie`; manter os testes de não eco.
- Senhas com hash adaptativo (Argon2id/scrypt) e rate limit específico para login, com bloqueio progressivo. O rate limiter atual é por IP e global.
- Primeiras rotas POST (login/logout) com proteção CSRF: `Origin` obrigatório e igual à origem, além de `SameSite`. Atualizar o teste que exige somente GET/HEAD de forma explícita, sem afrouxar as rotas de negócio.
- Em `ACC_DEPLOYMENT=production`: exigir HTTPS, HSTS e host/origens configuráveis com allowlist, e continuar recusando gh-cli.
- Manter `shared/securityHeaders.ts` como fonte única e estender `hardening.test.ts`.
