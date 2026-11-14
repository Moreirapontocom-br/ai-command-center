# Política de branches e governança — AI Command Center

> Issue #003 (PR 1). Aplica-se a todas as pessoas e agentes (humanos, Claude Code, ChatGPT) que alteram este repositório.

## 1. Regras

1. **Nenhuma alteração direta na `main`.** Nada de commit, push, push forçado, rebase ou exclusão da `main` fora do merge de um PR aprovado.
2. **Uma branch por issue ou incremento aprovado**, criada a partir da `origin/main` atualizada: `feature/<nº da issue>-<descrição>` (ex.: `feature/003-security-foundation`). Uma issue dividida em vários PRs usa uma branch por PR.
3. **PR obrigatório.** Toda mudança chega à `main` por pull request com a descrição do escopo, evidências e a issue referenciada (`Refs #N` enquanto houver PRs pendentes da issue; `Closes #N` só no último).
4. **Revisão independente pelo ChatGPT** (coordenador técnico e revisor) antes do merge. Quem implementa não revisa o próprio trabalho como aprovação final.
5. **Checks obrigatórios verdes** (CI: testes, lint, build, verificação de segredos) e **aprovação humana do Product Owner** antes do merge. O PO é a autoridade final e o único que executa ou autoriza o merge.
6. **Proibido:** `git push --force`/`--force-with-lease` em branches compartilhadas, exclusão da `main` ou de branches de outra issue, merge sem autorização explícita do PO, `--no-verify` para contornar hooks.
7. **Sem custos:** o repositório permanece no plano gratuito; nenhuma alteração paga sem aprovação. Mudanças de visibilidade e de configurações do GitHub (proteções, rulesets, segurança) são decisão do PO.
8. Antes de publicar: `git fetch origin` e conferir se a `main` remota mudou; divergência relevante interrompe o trabalho para revisão.

## 2. Proteção da `main` no servidor do GitHub

### 2.1 Situação atual — **proteção ativa no servidor**

Histórico: em 13/11/2026 o repositório era **privado** e a API respondia HTTP 403 para branch protection e rulesets (`docs/evidence/issue003-pr1-governance.txt`). O PO tornou o repositório **público**. Em 14/11/2026, a reverificação ainda não encontrou proteção alguma (`docs/evidence/issue003-pr1-main-protection.txt`). No mesmo dia, o PO autorizou a ativação do ruleset da seção 2.2.

Estado efetivo verificado pela API em 14/11/2026 (`GET /rulesets/27242416` e `GET /rules/branches/main`; evidência em `docs/evidence/issue003-main-protection-active.txt`):

| Recurso | Situação |
| --- | --- |
| Visibilidade | **Pública** |
| Ruleset `main-protection` (ID `27242416`) | **Ativo** (`enforcement: active`), alvo `~DEFAULT_BRANCH` (`main`) |
| PR obrigatório | Sim, com **0** aprovações exigidas pelo GitHub; aprovações antigas descartadas em novo push |
| Resolução das conversas de revisão | Obrigatória |
| Checks obrigatórios | `Test, lint & build (Node 22.x)`, `Test, lint & build (Node 24.x)`, `Secret scan (tracked files & commits)`, do app GitHub Actions (`15368`) |
| Branch atualizada antes do merge | Obrigatória (`strict_required_status_checks_policy: true`) |
| Push forçado / exclusão da `main` | **Bloqueados** (`non_fast_forward`, `deletion`) |
| Bypass | **Nenhum** (`bypass_actors: []`; `current_user_can_bypass: never`, inclusive para o administrador) |
| Métodos de merge | merge, squash e rebase |
| Branch protection clássica | Não usada (o ruleset a substitui) |
| Secret scanning / push protection | **Ativos** |
| Dependabot alerts | Ativos; security updates automáticas desativadas |
| Permissão padrão do `GITHUB_TOKEN` nos workflows | `read`; workflows não podem aprovar PRs |
| Workflows de PRs de forks | Exigem aprovação para contribuidores de primeira vez |

**`require_extra_approval_for_unattributed_changes: true`.** O GitHub inclui essa opção automaticamente em toda regra `pull_request` criada pela API, e ela não foi pedida na proposta. Segundo a documentação oficial (*Available rules for rulesets*, recurso em *public preview*), quando o Copilot abre, com a identidade de app dele, um PR não atribuído a uma pessoa, o GitHub exige uma aprovação a mais do que o número configurado. A mesma documentação diz que a opção **não tem efeito quando o ruleset exige 0 aprovações**. Efeito real verificado: o PR #33, aberto pelo dono do repositório, foi mesclado com 0 aprovações e sem bypass. A opção só passaria a valer se o número de aprovações fosse aumentado ou se o Copilot abrisse PRs. Ela não foi alterada; mudar o ruleset exige autorização do PO.

**Primeiro uso real:** o PR #33 foi mesclado em 14/11/2026 pelo merge commit `e3d44326bd14c391059a8ebcb095d4fecbfcda4b`, sem `--admin`. Os checks estavam verdes e a branch estava atualizada. A CI no push da `main` (3 jobs) e o workflow `Main audit` passaram, com todos os commits classificados como introduzidos pelo PR #33.

**Uso seguinte:** o PR #35 (Issue #003, PR 2, autenticação) foi mesclado do mesmo modo em `f1115abeccaa895a88019f0bf62bf2d1d37674d3`, e a CI e o `Main audit` passaram nesse commit. O ruleset exige branch atualizada: depois de cada merge, os outros PRs abertos precisam incorporar a `main` (merge normal, sem rebase de histórico publicado) e passar de novo pela CI.

**Limites que continuam valendo:** um administrador pode desativar ou editar o ruleset pela interface ou pela API. Por isso a auditoria detectiva (seção 5) e o hook local continuam ativos. A revisão independente e a aprovação do PO seguem obrigatórias **por processo**, já que o GitHub exige 0 aprovações.

**Credencial revogada da Issue #002:** a branch remota comprometida `feature/002-github-integration` foi excluída em 14/11/2026, depois de confirmar que o PR #25 foi fechado sem merge e que nenhum trabalho ativo dependia dela. O commit `c368bbf` continua acessível por `refs/pull/25/head`, uma referência somente leitura criada pelo GitHub. Remover essa referência e o cache **depende do GitHub Support** e está pendente. O alerta de secret scanning **#1** corresponde a esse token já revogado e permanece aberto até a remoção.

### 2.2 Configuração do ruleset (ativada em 14/11/2026 com autorização do PO)

Objetivo: exigir PR e checks verdes, impedir push forçado e exclusão — **sem** exigir aprovação de revisor no GitHub. O repositório tem um único mantenedor e o GitHub não permite que o autor aprove o próprio PR; exigir 1 aprovação travaria todo merge. A revisão independente (ChatGPT) e a aprovação do PO continuam obrigatórias **por processo** (seção 1, regras 4 e 5), e o merge pelo PO registra essa aprovação.

| Regra | Valor proposto | Efeito |
| --- | --- | --- |
| Alvo | Branch padrão (`~DEFAULT_BRANCH`, hoje `main`) | — |
| `pull_request` | Aprovações exigidas: **0**; descartar aprovações antigas em novo push; exigir resolução das conversas | Nenhum commit chega à `main` sem PR, nem do administrador |
| `required_status_checks` | `Test, lint & build (Node 22.x)`, `Test, lint & build (Node 24.x)`, `Secret scan (tracked files & commits)` (GitHub Actions); exigir branch atualizada com a `main` | Merge só com a CI verde sobre a `main` atual |
| `non_fast_forward` | Ativa | Bloqueia push forçado |
| `deletion` | Ativa | Bloqueia exclusão da `main` |
| Lista de bypass | **Vazia** | A regra vale também para o dono do repositório |
| Métodos de merge | Todos permitidos (merge, squash, rebase) | A auditoria (seção 5) reconhece os três |

O job `Main integrity audit (informative)` **não** entra nos checks exigidos: só roda depois do push na `main` e nunca apareceria num PR.

Comando usado na ativação, mantido como referência para recriar o ruleset. Qualquer alteração precisa de autorização do PO. Equivalente pela web: *Settings → Rules → Rulesets*.

```bash
gh api -X POST repos/Moreirapontocom-br/ai-command-center/rulesets --input - <<'JSON'
{
  "name": "main-protection",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
    } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "Test, lint & build (Node 22.x)", "integration_id": 15368 },
          { "context": "Test, lint & build (Node 24.x)", "integration_id": 15368 },
          { "context": "Secret scan (tracked files & commits)", "integration_id": 15368 }
        ]
    } }
  ]
}
JSON
```

`15368` é o identificador do app GitHub Actions, conferido nos check runs do PR #33. Fixá-lo impede que outro app satisfaça o check com o mesmo nome. Se um job da CI for renomeado, o ruleset precisa ser atualizado no mesmo PR, ou nenhum merge passará.

Verificação após a ativação (somente leitura): `gh api repos/Moreirapontocom-br/ai-command-center/rules/branches/main` deve listar as 4 regras, e o PR aberto deve exibir os 3 checks como *Required*. Não se testa a proteção com push real na `main`.

Secret scanning e push protection foram ativados junto com o ruleset (gratuitos em repositório público).

## 3. Controles preventivos x detectivos

| Controle | Tipo | O que faz | O que NÃO faz |
| --- | --- | --- | --- |
| Hook `.githooks/pre-push` | **Preventivo local** | Recusa, neste clone, qualquer push cujo destino seja `refs/heads/main` (qualquer remoto ou URL, inclusive forçado e exclusão; `Main`/`MAIN` também). Com vários refspecs, nada é enviado | Não impede `git push --no-verify`, outro clone sem o hook, a interface web nem a API do GitHub. **Não é controle de segurança contra usuário malicioso**: evita engano |
| Hook `.githooks/pre-commit` | Preventivo local | Bloqueia commit com possível credencial (`scripts/check-secrets.mjs staged`) | Também é contornável com `--no-verify` |
| Secret scanning + push protection (GitHub) | Preventivo no servidor + detectivo | Recusa no servidor push com padrão de credencial conhecido e gera alertas para credenciais no histórico | Cobre só padrões que o GitHub reconhece; não substitui `check-secrets.mjs` |
| CI (`.github/workflows/ci.yml`) | Preventivo **por processo** + detectivo | Em PR: testes, lint, build, segredos — o PO só faz merge com checks verdes. Em push na `main`: revalida o estado da `main` | O bloqueio do merge no servidor vem do ruleset (seção 2.2), que exige estes checks |
| Auditoria (`.github/workflows/main-audit.yml`) | **Detectivo** | Após cada push na `main`, informa se cada commit chegou por PR mesclado e se o GitHub reportou push forçado/exclusão | Não impede nada; roda depois do fato. Quem tem acesso de administrador pode desativar workflows ou apagar execuções |
| Revisão independente + aprovação do PO | Preventivo por processo | Ninguém faz merge sozinho | Depende de disciplina |
| Ruleset `main-protection` (seção 2.2) | **Preventivo no servidor** — ativo | Exige PR, conversas resolvidas, checks verdes e branch atualizada; bloqueia push forçado e exclusão, inclusive para o dono | Não exige aprovação de revisor (único mantenedor); um administrador pode desativar o ruleset |

## 4. Ativando os hooks (`core.hooksPath`)

```bash
npm run hooks:check     # informa se os hooks do projeto estão ativos (não altera nada)
npm run hooks:install   # ativa, se for seguro
```

O `hooks:install` (`scripts/install-git-hooks.mjs`) grava `core.hooksPath=.githooks` **somente na configuração local** do clone e **somente** quando a chave local está vazia. Ele **não altera nada** e explica o motivo quando:

- `core.hooksPath` local já tem outro valor (revise e decida manualmente);
- existem hooks próprios em `.git/hooks` (deixariam de executar; incorpore-os em `.githooks/` antes).

Valores global/do sistema são apenas relatados (a configuração local tem precedência). Equivalente manual, depois de conferir com `git config --show-origin --get-all core.hooksPath`:

```bash
git config --local core.hooksPath .githooks
```

Os hooks são scripts POSIX executados pelo `sh` do Git (inclusive no Git for Windows). O `.gitattributes` força finais de linha LF em `.githooks/*`.

## 5. Auditoria informativa da `main`

Critérios (`scripts/main-audit-lib.mjs`), baseados apenas em dados que o GitHub expõe de forma confiável:

| Fonte | Uso | Confiabilidade |
| --- | --- | --- |
| Evento `push`: `forced`, `deleted` | **Alerta** (job falha, saída 1) | Fato reportado pelo próprio GitHub |
| `GET /repos/{owner}/{repo}/commits/{sha}/pulls` | Commit introduzido por PR mesclado na `main` → `ok` | Documentado pelo GitHub para commits na branch padrão: devolve o PR mesclado que introduziu o commit, em merge commit, squash e rebase. Validado nos 10 commits reais da `main` (PRs #1 e #32). Pode atrasar segundos após o merge → até 3 novas tentativas |
| Commit sem pai (`git rev-list --max-parents=0`) | `info` (commit raiz `e706359`, criação do repositório) | Fato verificável |
| Commit sem PR mesclado associado | **`attention`** (aviso, job verde) | **Não** prova violação: pode ser atraso de indexação ou caso não previsto. Exige revisão humana |
| Falha da API | `inconclusive` (aviso) | — |

Deliberadamente **não** usados como critério: o autor/committer do commit (merge local e merge pela web podem ter metadados parecidos), o `pusher` (no merge pela web é quem clicou em merge) e a assinatura `web-flow` (não distingue rebase local de merge legítimo de forma robusta).

Execução manual: aba *Actions → Main audit → Run workflow* (profundidade configurável) ou, localmente e só leitura, `GITHUB_TOKEN=<token de leitura> npm run audit:main`.

## 6. Em caso de alerta

1. Não tente "corrigir" a `main` com novo push direto ou force-push.
2. Registre o relatório do workflow e avise o PO.
3. O PO decide a remediação (normalmente um PR de reversão).
