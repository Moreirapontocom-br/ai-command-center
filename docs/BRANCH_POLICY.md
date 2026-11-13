# Política de branches e governança — AI Command Center

> Issue #003 (PR 1). Aplica-se a todas as pessoas e agentes (humanos, Claude Code, ChatGPT) que alteram este repositório.

## 1. Regras

1. **Nenhuma alteração direta na `main`.** Nada de commit, push, push forçado, rebase ou exclusão da `main` fora do merge de um PR aprovado.
2. **Uma branch por issue ou incremento aprovado**, criada a partir da `origin/main` atualizada: `feature/<nº da issue>-<descrição>` (ex.: `feature/003-security-foundation`). Uma issue dividida em vários PRs usa uma branch por PR.
3. **PR obrigatório.** Toda mudança chega à `main` por pull request com a descrição do escopo, evidências e a issue referenciada (`Refs #N` enquanto houver PRs pendentes da issue; `Closes #N` só no último).
4. **Revisão independente pelo ChatGPT** (coordenador técnico e revisor) antes do merge. Quem implementa não revisa o próprio trabalho como aprovação final.
5. **Checks obrigatórios verdes** (CI: testes, lint, build, verificação de segredos) e **aprovação humana do Product Owner** antes do merge. O PO é a autoridade final e o único que executa ou autoriza o merge.
6. **Proibido:** `git push --force`/`--force-with-lease` em branches compartilhadas, exclusão da `main` ou de branches de outra issue, merge sem autorização explícita do PO, `--no-verify` para contornar hooks.
7. **Sem custos:** o repositório permanece privado e no plano gratuito; nenhuma alteração paga sem aprovação.
8. Antes de publicar: `git fetch origin` e conferir se a `main` remota mudou; divergência relevante interrompe o trabalho para revisão.

## 2. Limitações do GitHub Free em repositório privado pessoal

Verificado em 13/11/2026 (API do GitHub, evidência em `docs/evidence/issue003-pr1-governance.txt`):

| Recurso | Situação neste repositório |
| --- | --- |
| Branch protection rules (`/branches/main/protection`) | **Indisponível** — HTTP 403 "Upgrade to GitHub Pro or make this repository public" |
| Rulesets (`/rulesets`) | **Indisponível** — mesmo HTTP 403 |
| Required status checks / required reviews no servidor | **Indisponíveis** (dependem dos itens acima) |
| GitHub Actions, Dependabot alerts | Disponíveis gratuitamente |

Consequência: **o servidor do GitHub não impede** push direto, push forçado ou exclusão da `main` por quem tem permissão de escrita. As regras da seção 1 são cumpridas por processo, pelo hook local (preventivo, contra engano) e pela auditoria (detectiva). Tornar o repositório público ou contratar o GitHub Pro habilitaria a proteção no servidor — ambas as decisões são do PO e **não** foram tomadas.

## 3. Controles preventivos x detectivos

| Controle | Tipo | O que faz | O que NÃO faz |
| --- | --- | --- | --- |
| Hook `.githooks/pre-push` | **Preventivo local** | Recusa, neste clone, qualquer push cujo destino seja `refs/heads/main` (qualquer remoto ou URL, inclusive forçado e exclusão; `Main`/`MAIN` também). Com vários refspecs, nada é enviado | Não impede `git push --no-verify`, outro clone sem o hook, a interface web nem a API do GitHub. **Não é controle de segurança contra usuário malicioso**: evita engano |
| Hook `.githooks/pre-commit` | Preventivo local | Bloqueia commit com possível credencial (`scripts/check-secrets.mjs staged`) | Também é contornável com `--no-verify` |
| CI (`.github/workflows/ci.yml`) | Preventivo **por processo** + detectivo | Em PR: testes, lint, build, segredos — o PO só faz merge com checks verdes. Em push na `main`: revalida o estado da `main` | Não bloqueia merge no servidor (não há required checks no plano Free) |
| Auditoria (`.github/workflows/main-audit.yml`) | **Detectivo** | Após cada push na `main`, informa se cada commit chegou por PR mesclado e se o GitHub reportou push forçado/exclusão | Não impede nada; roda depois do fato. Quem tem acesso de administrador pode desativar workflows ou apagar execuções |
| Revisão independente + aprovação do PO | Preventivo por processo | Ninguém faz merge sozinho | Depende de disciplina |

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
