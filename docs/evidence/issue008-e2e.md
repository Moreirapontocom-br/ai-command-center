# Issue #008 — exercício ponta a ponta do fluxo assistido (roteiro e registro)

> **Estado: EXECUTADO em 2026-11-26/27** (UTC), na máquina do PO, com autorização expressa do PO e no SHA `99d5fe5` (§0). O registro (§7) traz só o que de fato aconteceu. Ações humanas (chave, senha e hash, `.env.local`, liberação da barreira, login, habilitação, aprovações, pacote, vínculo e verificações) foram feitas pelo PO. O Claude Code (sessão do PO, com a assinatura do PO, fora do ACC) fez a alteração na branch designada, o PR de teste e as conferências não sensíveis.
>
> **Autorização.** Configurar, liberar a barreira e exercitar o fluxo exigem autorização do PO **depois** da aprovação técnica do PR de fechamento. Tudo acontece na máquina do PO, com a assinatura do próprio PO para o Claude Code. Custo: R$ 0 (sem API paga; runners padrão do GitHub são gratuitos em repositório público).

Instruções conferidas contra o código desta branch: `server/config.ts` (variáveis e validações), `server/storage/paths.ts` (pastas fora do Git e de pastas sincronizadas), `server/approvals/keyProvider.ts` (formato da chave), `server/auth/hashPasswordCli.ts`, `server/admin/releaseBarrierCli.ts` (recusas de terminal) e `shared/approvalPresentation.ts` (nome da branch de trabalho).

## 0. Código exato (obrigatório antes de qualquer passo)

O roteiro depende do código do PR #53 (códigos 1/3/4, `reconciled_from_facts`, `admin_audit_inconsistent`). A main anterior ao merge **não** tem esse comportamento. Execute sempre o SHA aprovado na revisão técnica:

```powershell
git fetch origin
git switch feature/008-closing
git status --short                       # só podem aparecer os arquivos NÃO versionados do PO (??); nada modificado
git rev-parse HEAD                       # tem de ser IGUAL ao SHA aprovado pelo ChatGPT
git rev-parse origin/feature/008-closing # idem (a branch local não está à frente nem atrás)
git diff --quiet HEAD; $LASTEXITCODE     # 0 = working tree igual ao commit
npm ci
```

- **Interrompa o exercício** se o SHA for diferente do aprovado, se houver arquivo versionado modificado (`M`, `A`, `D`) ou se `git diff` não der 0. Não "corrija" nada: registre a divergência e peça nova revisão.
- `git switch` preserva os arquivos não versionados do PO (`??`). Não use `git clean`, `git stash -u` nem `git checkout -- .`.
- Anote o SHA no registro (§7). Depois do merge do PR, o mesmo roteiro vale para a main resultante, com a mesma conferência.

## 1. Configuração local no Windows

Use **Windows PowerShell ou Windows Terminal, fora do Claude Code e de qualquer agente**. O comando de liberação recusa o Git Bash (mintty, sem modo raw) e sessões com variáveis de agente (`CLAUDECODE`, `CI` e outras). Edite o `.env.local` com o **Bloco de Notas**: `Set-Content` e `Out-File` do PowerShell 5.1 podem gravar em outra codificação.

### 1.1 Pastas protegidas (fora do Git e do OneDrive)

O repositório fica dentro do OneDrive. O ACC recusa aprovações, anchor, chave e gateway em pasta sincronizada (`path_in_synced_folder`) ou dentro de um repositório Git. Use uma pasta local, por exemplo `C:\ACC`:

```powershell
New-Item -ItemType Directory -Force C:\ACC\approvals, C:\ACC\anchor, C:\ACC\keys, C:\ACC\gateway, C:\ACC\gateway-content
# Opcional (recomendado): só o seu usuário acessa C:\ACC. No Windows, o ACC não confere ACLs.
icacls C:\ACC /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F"
```

Regras que o código confere: caminhos absolutos; aprovações e anchor distintos; gateway e conteúdo distintos entre si e não aninhados com aprovações ou anchor.

### 1.2 Chave HMAC das aprovações

São 32 bytes aleatórios em hexadecimal, gravados direto no arquivo, sem aparecer na tela. `wx` recusa sobrescrever uma chave que já existe:

```powershell
node -e "require('fs').writeFileSync('C:/ACC/keys/approval.key', require('crypto').randomBytes(32).toString('hex'), {flag:'wx'})"
```

Guarde um backup desse arquivo **fora** do OneDrive e do repositório. Sem a chave, o armazenamento não abre; com uma chave diferente, ele abre como indisponível (`key_mismatch`).

### 1.3 Administrador

```powershell
npm run auth:hash-password
```

O comando pede a senha sem eco e imprime uma linha `ACC_ADMIN_PASSWORD_HASH=...`. Cole essa linha no `.env.local`. `ACC_ADMIN_PASSWORD` em texto puro é recusado pelo servidor.

### 1.4 `.env.local` (raiz do repositório)

Acrescente ou ajuste, sem apagar as demais linhas:

```
ACC_DEPLOYMENT=local
GITHUB_AUTH=gh-cli
ACC_ADMIN_EMAIL=<seu e-mail de login no ACC>
ACC_ADMIN_PASSWORD_HASH=<linha gerada em 1.3>
ACC_APPROVALS_DIR=C:\ACC\approvals
ACC_APPROVALS_ANCHOR_DIR=C:\ACC\anchor
ACC_APPROVAL_KEY_FILE=C:\ACC\keys\approval.key
ACC_APPROVALS_INITIALIZE=if_absent
ACC_GATEWAY_DIR=C:\ACC\gateway
ACC_GATEWAY_CONTENT_DIR=C:\ACC\gateway-content
ACC_GATEWAY_INITIALIZE=if_absent
```

- **Remova a linha `GITHUB_TOKEN=...`** (ou deixe-a vazia). Com `GITHUB_AUTH=gh-cli`, um token no arquivo torna a configuração ambígua, e tanto o servidor quanto o comando de liberação recusam (`config_invalid`). Com a linha removida, `npm run server` e `npm run admin:release-barrier` funcionam sem a receita do `ProcessStartInfo`.
- `gh auth status` precisa estar ok (credencial do GitHub CLI, somente leitura no uso do ACC).
- **Não configure a fila** (`ACC_QUEUE_*`): ela é dormente, e, se estiver configurada, o comando exige que esteja saudável.
- `ACC_DATA_DIR` pode continuar no padrão (`data`, na raiz do repositório). Ele guarda projetos, tarefas, auditoria, o lock de instância e o diário da liberação.

## 2. Primeira subida (cria os armazenamentos)

```powershell
npm run server
```

Confira no log:

- `approvals_opened` com `state: "available"` e `globalBarrier: true` (barreira `initial_install`, esperada);
- nenhuma linha `admin_reconcile_pending` ou `admin_audit_inconsistent`;
- o aviso de credencial `gh-cli` (permissões amplas) é esperado.

Pare o servidor (Ctrl+C). **Remova do `.env.local` as linhas `ACC_APPROVALS_INITIALIZE=if_absent` e `ACC_GATEWAY_INITIALIZE=if_absent`**: elas só servem para a primeira instalação.

## 3. Liberação manual da barreira

### 3.1 Antes

- [ ] O servidor está parado (nenhum `node` do ACC no Gerenciador de Tarefas).
- [ ] `Test-Path data\admin-release.journal.json` → `False`.
- [ ] `Test-Path data\acc-instance.lock` → `False` (se `True` com o servidor parado, veja §6).
- [ ] `npm run admin:release-barrier -- --help` mostra a ajuda.

### 3.2 Execução

```powershell
npm run admin:release-barrier
```

1. Confira na tela a linhagem, a data de instalação, a época e o motivo `initial_install`.
2. Digite a senha do administrador (sem eco).
3. Digite exatamente `LIBERAR GLOBAL <8 primeiros caracteres da linhagem mostrada>`.

Esperado: `LIBERADA: ... [released]` e código de saída 0 (`$LASTEXITCODE`).

### 3.3 Depois

- [ ] `Test-Path data\admin-release.journal.json` → `False`.
- [ ] `npm run server`: `approvals_opened` com `globalBarrier: false`; nenhuma linha `admin_reconcile_pending` ou `admin_audit_inconsistent`.
- [ ] Na interface (`npm run dev` em outro terminal, login como administrador), a página *Aprovações* não mostra barreira global.
- [ ] Auditoria (`GET /api/audit?action=approval.configuration`, ou pela interface): um registro de sucesso com `operation: barrier_release_global` e `seq` preenchido; `approval.confirmation` com sucesso logo antes.

## 4. Roteiro ponta a ponta

Repositório: `Moreirapontocom-br/ai-command-center` (o único da allowlist). O PR de teste **nunca** é mesclado.

### 4.1 Preparação no ACC (servidor e interface ativos)

1. Crie (ou escolha) um projeto vinculado ao repositório e uma tarefa de teste, por exemplo "E2E #008: alterar um arquivo de documentação".
2. No projeto, use **"Habilitar o Claude Code neste projeto"** (confirmação de configuração com senha).
3. Na tarefa, use **"Preparar ordem para Claude Code"**: objetivo curto, critérios de aceite e nenhum segredo. Anote o `orderId`, a **branch** (`agent/claude-code/<8 da tarefa>-<8 da ordem>`) e o **SHA base** exibidos.
4. Em *Aprovações*, aprove os dois pedidos da ordem (`agent.invoke` e `data.send_external`), conferindo a apresentação (projeto, tarefa, repositório, branch, SHA base).
5. Na ordem, use **"Liberar e copiar o pacote"** (senha). O texto é entregue só nessa resposta.

### 4.2 Execução fora do ACC (Claude Code com a sua assinatura)

1. Num clone local: `git fetch origin`, depois `git switch -c <branch exata> <SHA base exato>`.
2. Rode o Claude Code com o pacote copiado. Peça uma alteração pequena **fora** de `.github/workflows/**`, `.githooks/**` e de arquivos de segredo (V10).
3. Faça o commit, publique a branch (`git push -u origin <branch>`) e abra o PR contra `main` (pode ser draft). Aguarde os checks.

### 4.3 Caso A — conforme

1. Na ordem, use **"Informar o PR"** (`Moreirapontocom-br/ai-command-center#N`, com senha).
2. Com os checks verdes, use **"Verificar PR (somente leitura)"**.
3. Esperado: `conforming`, com o estado "Verificado para o HEAD lido". V1–V8, V10 e V11 comprovadas; V9 e V13 informativas.

### 4.4 Caso B — HEAD alterado

1. Publique um novo commit na mesma branch do PR.
2. Esperado antes de reverificar: a verificação anterior continua presa ao SHA antigo. O ACC só percebe o novo HEAD na próxima leitura, e o estado "Verificado para o HEAD lido" só vale com uma leitura do mesmo SHA de até 5 min (depois disso, ou após reinício, aparece como desatualizado).
3. Verifique de novo (respeite o intervalo mínimo de 30 s). Esperado: uma nova entrada para o novo SHA, que `supersedes` a anterior; o histórico de verificações mantém as duas.
4. Se o HEAD mudar **durante** a leitura (V12), o resultado esperado é `head_changed` e nada gravado. Esse caso é difícil de provocar à mão; registre-o só se ocorrer.

### 4.5 Encerramento do exercício

1. Feche o PR de teste **sem merge** e apague a branch remota.
2. Na ordem, use **"Cancelar a ordem"** (senha), se ela ainda estiver aberta.
3. Opcional: **"Desabilitar o Claude Code neste projeto"** (encerra as ordens abertas).
4. Registre as evidências na seção 7 e anexe-as ao PR de fechamento.

## 5. O que NÃO fazer

- Não executar o comando de liberação por um agente, por CI ou com entrada redirecionada (ele recusa).
- Não mesclar o PR de teste: "Checks verdes não autorizam merge".
- Não colar o pacote, senhas, a chave ou o hash em issues, PRs ou conversas.
- Não editar à mão `audit.json`, os arquivos de `C:\ACC\` ou o diário, a não ser pelos procedimentos de `docs/BARRIER_RELEASE.md`.

## 6. Recuperação em caso de falha

| Sintoma | O que fazer |
|---|---|
| `RECUSADA (instance_locked)` / servidor `instance_locked` | Outro servidor ou comando ativo. Encerre-o. Se não houver nenhum, o lock órfão é retomado sozinho; se for recusado (pid reutilizado), apague `data\acc-instance.lock` e `data\acc-instance.lock.takeover` depois de conferir o Gerenciador de Tarefas (`BARRIER_RELEASE.md` §6). |
| `RECUSADA (config_invalid)` | Confira §1.4 (token antigo com `gh-cli`, caminhos relativos, pasta sincronizada, hash inválido). |
| `RECUSADA (interactive_terminal_required)` / `(agent_environment)` | Use PowerShell ou Windows Terminal fora de qualquer agente. |
| `RECUSADA (approvals_*)` | Armazenamento ausente ou indisponível: refaça §2; confira a chave (`key_mismatch`, `key_unavailable`). |
| `NÃO LIBERADA` (código 1) | Nada foi liberado. Rode o comando de novo: a primeira execução reconcilia (`interrupted`), e a seguinte libera. |
| `LIBERAÇÃO REGISTRADA NA #011, AUDITORIA PENDENTE` (código 3) | A liberação vale. Rode de novo para completar a auditoria (`RECONCILIADA`). |
| `RESULTADO INDETERMINADO` (código 4) | Não presuma nada. Rode de novo: a reconciliação decide pelos fatos da #011. Se recusar (`reconcile_divergence`, `reconcile_store_unavailable`), siga `BARRIER_RELEASE.md` §5. |
| Servidor com `admin_reconcile_pending` | Pare o servidor e rode `npm run admin:release-barrier` (reconcilia pelo diário ou pelos fatos). |
| Servidor com `admin_audit_inconsistent` / comando `consistency_*` | Contradição entre a #011 e a #006. Nada é corrigido sozinho: `BARRIER_RELEASE.md` §5.1 (procedimento humano). |
| `temporarily_locked` / `hard_locked` | `BARRIER_RELEASE.md` §4. |
| Ordem `approval_blocked` (423) | A barreira ainda está ativa: refaça §3. |
| Verificação com erro de rede, limite ou autorização | Nada é gravado; confira `gh auth status` e tente depois de 30 s. |
| Reverter a liberação | Reacione a barreira pelos caminhos existentes (`BARRIER_RELEASE.md` §7). |

## 7. Registro (valores reais)

| Item | Valor |
|---|---|
| Data e hora (UTC) | 2026-11-26 23:53 (primeira subida) → 2026-11-27 00:21 (PR de teste fechado) |
| SHA executado (§0) = SHA aprovado | `99d5fe5112ad7fde5814fd4865f68952c5780f0e` = `origin/feature/008-closing` = SHA aprovado; `git diff --quiet HEAD` = 0; só os três arquivos não versionados do PO (`??`); `npm ci` ok |
| Configuração (§1) | Pastas `C:\ACC\{approvals,anchor,keys,gateway,gateway-content}` (ACL só do usuário); chave em arquivo (32 bytes, criada pelo PO); hash do administrador (PO); `.env.local` editado pelo PO. Validação sem valores: `deployment: local`, admin configurado, aprovações `configured` (chave `file`), fila `disabled`, gateway `configured`, credencial `gh-cli`, `GITHUB_TOKEN` ausente. Duas correções durante a configuração: faltavam linhas no `.env.local`, e depois `ACC_ADMIN_EMAIL` não era um e-mail (detectado pelo `loadConfig`) |
| Primeira subida (§2) | `approvals_opened` `state: available`, `globalBarrier: true`; `gateway_opened` `available`, `githubReader: configured`; `adminConfigured: true`; sem `admin_reconcile_pending`/`admin_audit_inconsistent`. Parada forçada (Windows) → locks órfãos, retomados na execução seguinte, como previsto (§6) |
| Liberação (§3), pelo PO | `LIBERADA: a barreira global inicial foi liberada, gravada, relida e auditada. [released]`; código de saída **0** |
| Depois (§3.3) | Linhas `*_INITIALIZE` removidas (`initialize: never`); diário ausente; lock liberado; #006: seq 1 `approval.confirmation` success (`password`, `barrier_release_global`), seq 2 `approval.configuration` success, `resource` = aprovação `886484d8-fc3c-4b1d-9850-73c9534bf261`, `context.seq = 9`. Nova subida: `approvals_opened` `globalBarrier: false`, cruzamento #011 × #006 consistente nos dados reais (sem `admin_reconcile_pending`/`admin_audit_inconsistent`) |
| Projeto / tarefa / ordem | Projeto `b9b244e1-22c8-406c-be10-42d414af5ff2` (repositório `Moreirapontocom-br/ai-command-center`), tarefa `d449169b-0371-4b2d-94b9-e49d74ee4bee`, habilitação `claude_project.enablement` → `enabled`; ordem `749cb7e0-b90e-406c-937c-5a8f6b5d364c`, branch `agent/claude-code/d449169b-749cb7e0`, SHA base `3718703580a073ac099e2aced94ed51338acad36` |
| Aprovações (PO) | `agent.invoke` `be7bb560-fe94-4469-b58d-2ad88b1f7c0f` → `approved`; `data.send_external` `a21faaa8-a314-40e2-ac31-caf2560a08be` → `approved` (antes, uma confirmação de senha recusada, `confirmation_failed`, registrada como `blocked` e repetida com sucesso). Pacote liberado com step-up → `delivered`; escopo válido até 2026-11-27T00:24:26Z |
| Execução fora do ACC | Claude Code (sessão do PO) com o pacote colado pelo PO: worktree temporário em `3718703`, branch exata, só `docs/evidence/e2e-scratch-008.md` (arquivo descartável), push da branch, PR **#54** em draft contra `main` |
| PR de teste | #54, commits `3444a8e` (caso A) e `b1148ef` (caso B); CI dos dois HEADs com os três checks em SUCCESS (runs 45915350033 e 45915674680) |
| Caso A | PR vinculado (`pr_linked`, step-up). Verificação: **`conforming`**, HEAD `3444a8e4505caa8f27a005df625dd0008f99fa3f`, regras obrigatórias aprovadas, V9 e V13 informativas, histórico = 1. #006 seq 19 `claude_order.verified` (`verdict: conforming`, `head: 3444a8e…`, `seq: 1`) |
| Caso B | Novo commit `b1148ef` (mesmo arquivo). Antes de reverificar, a interface mostrava a conformidade só para `3444a8e`, com aviso de que novos commits exigem nova verificação. Reverificação: **`conforming`**, HEAD `b1148ef995eb065e95a5f3cd676da3bc1dc71d56`, 2 commits, histórico = 2. Ledger do gateway: verificação 2 `f3d87a78-9958-4099-94cd-bd182afc2227` tem `supersedes = 54452bb0-d22e-49ac-abea-516adf38e616` (= verificação 1, HEAD `3444a8e`), `closes: false`. #006 seq 20 `claude_order.verified` (`head: b1148ef…`, `seq: 2`) |
| V12 (HEAD muda durante a leitura) | Não ocorreu (não provocado), como previsto em §4.4 |
| Encerramento | PR #54 **fechado sem merge** (`state: CLOSED`, `mergedAt: null`, 2026-11-27T00:21:51Z), branch remota e local apagadas, worktree removido; main inalterada (`3718703`). Ordem não cancelada (passo opcional; o escopo expirou às 00:24:26Z). Servidor e interface parados |
| Incidentes e recuperação | Nenhum incidente de segurança. Correções de configuração (linhas faltando, e-mail inválido) detectadas antes da subida. Uma senha digitada errada (recusada e auditada). Locks órfãos por parada forçada, retomados automaticamente |
| Segredos nas evidências | Nenhum: só ids, SHAs, estados e mensagens. Chave, senha, hash, e-mail e pacote não foram registrados |

## 8. Checklist de encerramento da Issue #008

| Critério da issue | Onde está atendido | Estado |
|---|---|---|
| Cada execução exige autorização explícita | Duas aprovações humanas por ordem (#011), step-up no pacote, PR e cancelamento; habilitação por projeto (`IMPLEMENTATION_REPORT_008_PR2.md` §5) | **Comprovado no exercício real** (§7: habilitação, duas aprovações, pacote e vínculo com step-up) |
| Ambiente isolado | **Não cumprido nesta etapa; depende da Issue #021.** A execução é **assistida e externa** ao ACC: o PO roda o Claude Code na própria máquina, com a própria assinatura. O ACC **não isola** o processo do Claude Code (sistema de arquivos, rede, credenciais), não o inicia e não o supervisiona; ele só não executa agentes (`REAL_EXECUTION_ENABLED = false`, sem `child_process` no caminho da #008). A proteção de branch, a branch designada e a verificação posterior do PR (V1–V13) restringem e conferem o **resultado**, mas **não equivalem a isolamento de execução**. | **Pendente de #021** (aplicabilidade registrada; não declarado como cumprido) |
| Operações restritas à branch designada | Branch fixa por ordem; V3/V4/V5/V6 na verificação | **Comprovado** como verificação posterior do resultado (casos A e B `conforming`). O ACC confere, mas não impede, o que o executor externo faz |
| Status rastreável | Estados projetados da ordem, histórico assinado do gateway, verificações só de acréscimo, auditoria #006 | **Comprovado** (#006 seq 1–20; histórico de verificações com `supersedes`) |
| Erros e interrupção tratados | Verificação sem gravação em erro; `head_changed`; liberação com diário, cruzamento e códigos 1/3/4 (`BARRIER_RELEASE.md`) | **Comprovado** no caso B (novo HEAD exige nova verificação; `supersedes`), na senha recusada e nos locks órfãos retomados. Falhas de gravação, interrupções e V12 comprovados por testes (não provocados no exercício real) |
| Sem merge automático | Nenhuma mutation no GitHub; V7 alerta merge fora do fluxo | **Comprovado** (PR #54 fechado sem merge; o ACC só leu) |
| Testes, lint e build passam; evidências anexadas | CI do PR de fechamento; `docs/evidence/issue008-closing-validation.txt`; este registro | **Comprovado** (CI do PR #53; evidências do exercício neste documento) |
| Relatório do Claude Code, revisão do ChatGPT, documentação | `IMPLEMENTATION_REPORT_008_CLOSING.md`; revisão do ChatGPT no PR | Relatório pronto; pareceres favoráveis até `99d5fe5`; **revisão do registro do exercício pendente** |
| PO aprova decisões; branch própria; sem push na main; sem merge automático | Governança do repositório (ruleset `main-protection`, hook pre-push) | Em vigor |
| Barreira inicial liberada de forma supervisionada | Comando local (P1, PR #51) | **Comprovado** (liberação real pelo PO, código 0, auditada e cruzada) |
| Exercício ponta a ponta real | Este documento. Ele comprova a **integração assistida** (ordem, aprovações, pacote, PR na branch designada, verificação somente leitura), não isolamento nem execução pelo ACC | **Comprovado** (casos A e B, §7) |

**Resumo para o encerramento:** os critérios da integração **assistida** estão comprovados. O critério **"ambiente isolado" não está cumprido** e depende da Issue #021 (e das #020/#022 para qualquer execução pelo ACC). Se o PO considerar o isolamento obrigatório para fechar a #008, a issue deve continuar aberta, ou ser fechada com esse critério explicitamente transferido para a #021: **decisão do PO**.
