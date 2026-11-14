# Relatório de implementação — Issue #003, PR 1

**Segurança, governança e endurecimento da infraestrutura**

| Item | Valor |
| --- | --- |
| Branch | `feature/003-security-foundation` (criada a partir de `origin/main`) |
| SHA inicial (base) | `0de3903d9530feb45cc8d25a91fe7f0fbd580ec1` (merge do PR #32), igual à base esperada |
| Commits | `c65fa35` S1 (governança) · `c360d05` S2 (segurança) · `13d2c86` relatório (SHA revisado) · `f31dffe` correção **R1** (seção 10) · rodada final de governança, só documentação (head da branch; seção 11) |
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
| Testes | `scripts/pre-push-hook.test.mjs` (17), `scripts/main-audit.test.mjs` (33, sendo 12 da correção R1) |

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

A proteção **no servidor** (branch protection/rulesets) era indisponível durante a implementação: HTTP 403 em repositório privado no plano Free. O repositório foi tornado público depois; os recursos ficaram disponíveis, mas **nenhuma proteção está ativa** (seção 11). Nenhuma regra foi criada ou alterada.

## 7. Evidências

| Arquivo | Conteúdo |
| --- | --- |
| `docs/evidence/issue003-pr1-governance.txt` | Fase 0, 403 de proteção/rulesets (repositório ainda privado), Dependabot antes/depois, `core.hooksPath`, auditoria real e simulada |
| `docs/evidence/issue003-pr1-main-protection.txt` | Rodada final: repositório público, ausência de branch protection e rulesets, configurações de segurança e Actions, refs públicas |
| `docs/evidence/issue003-pr1-checks.txt` | Testes, lint, build, verificações de segredos (dist, versionados, commits, histórico) e CSP, hook no clone real |
| `docs/evidence/issue003-pr1-csp-browser.txt` | CSP efetiva e comportamento no Chrome (preview, preview com labels, dev) |
| `docs/evidence/issue003-pr1-csp-preview-tarefas-1440.png` | Captura do preview sob a CSP de produção |
| `docs/evidence/issue003-pr1-r1-audit-budget.txt` | Correção R1: testes com relógio simulado, auditoria real e eventos simulados |
| `docs/evidence/issue003-pr1-dependencies.txt` | `npm audit` (omit=dev e completo), `npm ls minimatch`, versões publicadas, alertas do Dependabot |

**CI do PR:** resultado registrado na descrição/comentários do PR. O workflow `Main audit` e o gatilho de push da CI só podem executar depois que estes arquivos estiverem na `main` (o GitHub lê workflows de push/dispatch da branch padrão). Portanto, **não foram executados no GitHub** neste PR, só localmente.

## 8. Pendências, riscos e limitações

1. ~~Proteção no servidor não ativada.~~ **Resolvido em 14/11/2026:** ruleset `main-protection` ativo (seção 11.1).
2. **Hooks são locais e opcionais**: cada clone precisa de `npm run hooks:install`; `--no-verify` contorna.
3. **Primeira execução real** da auditoria e da CI em push na `main` só ocorrerá no merge deste PR. Recomenda-se conferir o run após o merge. O commit de merge deve aparecer como `ok` (PR #N).
4. **Auditoria limitada** a 2048 commits por evento (limite do payload, sinalizado no relatório), à consistência eventual da API e ao orçamento de 3 min (seção 10). Commits não examinados a tempo aparecem como inconclusivos.
5. **RISK-001** (`minimatch`) aberto até 13/12/2026; existe atualização parcial do ESLint disponível (seção 4).
6. **Mudança de configuração para gh-cli**: `.env.local` existentes precisam de `ACC_DEPLOYMENT=local`.
7. A CSP vale onde o Vite serve o frontend (dev e preview). Uma hospedagem futura precisa reproduzir `appSecurityHeaders('production')`.
8. Os testes do hook levam cerca de 40 s no Windows (Git real); no Linux da CI são mais rápidos.

## 9. Recomendações para o PR 2

> **Implementadas no PR #35** (mesclado em `f1115ab`): login de administrador único, sessão no servidor, cookie `HttpOnly; SameSite=Strict`, CSRF por `Origin`, limite de tentativas. Ver `docs/IMPLEMENTATION_REPORT_003_PR2.md`. A lista abaixo é o registro original.

- Antes de expor o servidor fora do loopback, implementar autenticação de usuários da aplicação. O gh-cli continua sendo só credencial do desenvolvedor perante o GitHub.
- Sessões com cookie `HttpOnly; Secure; SameSite=Strict`, prefixo `__Host-`, expiração curta e rotação no login. O logger já mascara `Cookie`/`Set-Cookie`; manter os testes de não eco.
- Senhas com hash adaptativo (Argon2id/scrypt) e rate limit específico para login, com bloqueio progressivo. O rate limiter atual é por IP e global.
- Primeiras rotas POST (login/logout) com proteção CSRF: `Origin` obrigatório e igual à origem, além de `SameSite`. Atualizar o teste que exige somente GET/HEAD de forma explícita, sem afrouxar as rotas de negócio.
- Em `ACC_DEPLOYMENT=production`: exigir HTTPS, HSTS e host/origens configuráveis com allowlist, e continuar recusando gh-cli.
- Manter `shared/securityHeaders.ts` como fonte única e estender `hardening.test.ts`.

## 10. Correção R1 — orçamento de tempo da auditoria (revisão independente do SHA `13d2c86`)

**Problema apontado:** o job tem timeout de 5 min, mas `auditCommits` fazia até 3 novas tentativas com 5 s de espera **para cada** commit não confirmado. Um lote grande sem PR associado poderia estourar o timeout: cerca de 15 s × N commits, mais as consultas.

**Correção** (`scripts/main-audit-lib.mjs`, `scripts/audit-main.mjs`, `.github/workflows/main-audit.yml`):

| Item | Como foi resolvido |
| --- | --- |
| Orçamento global | `budgetMs` em `auditCommits`. No workflow, `AUDIT_BUDGET_MS=180000` (3 min) contra o timeout de 5 min do job, deixando ≥ 2 min para checkout e setup. A CLI recusa valores fora de 10–240 s. Um teste garante que `orçamento + 90 s ≤ timeout` |
| Retries preservados, sem espera excessiva | Retries por **rodada**: a rodada 0 consulta todos os commits; as rodadas 1–3 consultam de novo só os não confirmados, após **uma** espera de 5 s compartilhada. A espera total cai para no máximo 15 s, qualquer que seja o tamanho do lote |
| Consultas limitadas | Nenhuma consulta começa com menos de 1 s restante. Cada uma recebe `timeoutMs = min(10 s, tempo restante)`, aplicado na CLI com `AbortSignal.timeout` (cobre também a leitura do corpo). Nenhuma espera começa sem tempo para ela e para mais uma consulta |
| Esgotamento | Commits nunca consultados viram `inconclusive` ("não examinado: orçamento de tempo da auditoria esgotado"); os já consultados mantêm o último resultado (`attention`/`inconclusive`). **Nada é aprovado sem confirmação.** O relatório inclui uma nota com a quantidade de commits não examinados |
| Alertas confirmados | `forced`/`deleted` vêm do evento e não dependem da API nem do orçamento. A anotação `::error` agora é emitida **antes** das consultas: mesmo que o job fosse interrompido, o alerta já estaria no log. O status continua `alert` (saída 1) |
| Natureza informativa | Inalterada: só `alert` falha o job; `attention`/`inconclusive` geram avisos |

**Testes novos (12, relógio simulado, sem esperas reais):**
- lote de 50 commits sem PR: 200 consultas e só 3 esperas;
- 2048 commits com orçamento esgotado: os examinados ficam `ok` e os demais `inconclusive`, sem nenhuma espera;
- espera de retry não iniciada sem tempo suficiente;
- falhas da API: `inconclusive` e número de consultas limitado;
- `timeoutMs` limitado pelo tempo restante;
- PR que aparece na 2ª rodada é confirmado;
- alerta de push forçado sobrevive ao esgotamento;
- CLI sem rede: `::error` antes do relatório com saída 1, inconclusivo sem credencial, e recusa de `AUDIT_BUDGET_MS` inválido (3 casos).

**Validação:**
- `npm test`: **274/274** (178 preexistentes + 96 novos);
- lint, build, `check:secrets` (dist), `check:csp` e varredura de arquivos versionados: OK;
- auditoria real da `main`: OK;
- evento simulado do merge do PR #32 na API real: OK; o mesmo evento com `forced=true`: alerta, saída 1.

Evidência: `docs/evidence/issue003-pr1-r1-audit-budget.txt`.

## 11. Rodada final de governança — proteção da `main` (14/11/2026)

> Situação **anterior** à autorização do PO. O estado atual está na seção 11.1.

Somente leitura no GitHub; nenhuma configuração foi alterada. Evidência: `docs/evidence/issue003-pr1-main-protection.txt`.

| Verificação | Resultado |
| --- | --- |
| Branch / SHA revisado | `feature/003-security-foundation` @ `f31dffee901644aee0105601640a09b4c42f5a79` (local = remoto); PR #33 OPEN, MERGEABLE/CLEAN, 3 checks verdes |
| Visibilidade | **Pública** (antes: privada, com 403 nas APIs de proteção) |
| Branch protection clássica | Não configurada (HTTP 404 "Branch not protected", `protected=false`) |
| Rulesets / regras efetivas na `main` | Nenhum (`[]`) |
| Secret scanning / push protection | Disponíveis em repositório público, **desativados** |

**Alterações (só documentação):** `docs/BRANCH_POLICY.md` §2 reescrita com a situação real e a proposta de ruleset (§2.2); regra 7 da §1 deixou de afirmar que o repositório é privado; tabela da §3 com a linha do ruleset pendente. Nenhum controle existente (hooks, CI, auditoria, varredura de segredos, cabeçalhos) foi alterado.

**Proposta (aguarda o PO):** ruleset `main-protection` na branch padrão, sem bypass, com: PR obrigatório com **0** aprovações (o autor não pode aprovar o próprio PR; a revisão do ChatGPT e a aprovação do PO seguem por processo); os 3 checks da CI exigidos (app GitHub Actions, `15368`) com branch atualizada; bloqueio de push forçado e de exclusão. Comando pronto em `docs/BRANCH_POLICY.md` §2.2.

**Pendências para decisão do PO:**

1. Ativar o ruleset da §2.2.
2. Ativar secret scanning e push protection (gratuitos em repositório público).
3. **Exposição do commit `c368bbf`** (token da Issue #002, já revogado em 11/11/2026): com o repositório público, ele é acessível por `refs/heads/feature/002-github-integration` e `refs/pull/25/head`. O token revogado não dá acesso, mas o valor está público. Remediação possível: excluir a branch remota antiga (decisão do PO) e pedir ao GitHub Support a remoção de `refs/pull/25/head` e dos objetos em cache.

### 11.1 Execução autorizada pelo PO (14/11/2026)

Evidência: `docs/evidence/issue003-main-protection-active.txt`. Nenhum valor de credencial foi registrado.

| Ação | Resultado |
| --- | --- |
| Ruleset `main-protection` | **Ativo**, ID `27242416`, alvo `main` (`~DEFAULT_BRANCH`). Regras: PR obrigatório com **0** aprovações e resolução obrigatória das conversas; 3 checks da CI obrigatórios (Actions, `15368`) com **branch atualizada**; **bloqueio de push forçado e de exclusão**. **Nenhum bypass** (`current_user_can_bypass: never`) |
| `require_extra_approval_for_unattributed_changes` | `true`, padrão do GitHub. Só afeta PRs não atribuídos abertos pelo Copilot e **não tem efeito com 0 aprovações** (documentação oficial). Confirmado na prática pelo merge do PR #33. Não alterado. Detalhes em `docs/BRANCH_POLICY.md` §2.1 |
| Secret scanning / push protection | **Ativos** |
| Merge do PR #33 | Antes do merge: SHA autorizado `7ae3923`, `main` = `0de3903`, 3 checks verdes, sem conflitos, regras efetivas conferidas. Merge commit **`e3d44326bd14c391059a8ebcb095d4fecbfcda4b`**, sem `--admin`, com o head travado no SHA autorizado |
| Workflows na `main` | CI (push): 3 jobs com sucesso. **Main audit**: OK, com os 6 commits auditados "introduzido pelo PR #33 (mesclado)" |
| Branch comprometida `feature/002-github-integration` | **Removida**, depois de confirmar: PR #25 CLOSED sem merge; única branch remota contendo `c368bbf`; nenhum PR aberto dependente; árvore idêntica à da v2 já mesclada |
| `refs/pull/25/head` | **Pendente**: continua expondo `c368bbf` (token revogado) e 8 commits alcançáveis só por ela. A remoção depende do GitHub Support. O texto do chamado foi entregue ao PO |
| Alerta de secret scanning #1 | Aberto. Tipo `github_personal_access_token`, `.env.example` linha 8, commit `c368bbf`. Corresponde à credencial **revogada** |

**Estado após o PR #35:** a `main` está em `f1115abeccaa895a88019f0bf62bf2d1d37674d3`, com CI e `Main audit` verdes. Ruleset, secret scanning e push protection seguem ativos, sem alteração.

**Pendências restantes:** envio do chamado ao GitHub Support pelo PO, e fechamento do alerta #1 como *revoked* depois da remoção. As branches locais `backup/002-original-bcc3c1e` e `rebuild/002-clean` ficam a critério do PO.
