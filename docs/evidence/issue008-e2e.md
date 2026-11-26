# Issue #008 — exercício ponta a ponta do fluxo assistido (roteiro e registro)

> **Estado: NÃO EXECUTADO.** Este documento traz o roteiro e um modelo de registro em branco. Nenhuma configuração real foi feita, nenhuma barreira foi liberada e nenhum exercício foi realizado. As seções "Registro" só podem ser preenchidas com o que de fato acontecer, pelo PO ou com ele presente.
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

## 7. Registro (preencher só com o que acontecer)

| Item | Valor |
|---|---|
| Data e hora | — |
| SHA executado (§0) = SHA aprovado | — |
| Primeira subida: `approvals_opened` (state, globalBarrier) | — |
| Liberação: mensagem e código de saída | — |
| Depois: `globalBarrier`, diário, registros na #006 (seq) | — |
| Projeto habilitado (id) / ordem (id) / branch / SHA base | — |
| PR de teste (número) | — |
| Caso A: veredito e HEAD verificado | — |
| Caso B: novo HEAD, veredito, `supersedes` | — |
| Encerramento: PR fechado sem merge, branch apagada, ordem cancelada | — |
| Incidentes e recuperação | — |

## 8. Checklist de encerramento da Issue #008

| Critério da issue | Onde está atendido | Estado |
|---|---|---|
| Cada execução exige autorização explícita | Duas aprovações humanas por ordem (#011), step-up no pacote, PR e cancelamento; habilitação por projeto (`IMPLEMENTATION_REPORT_008_PR2.md` §5) | Implementado e testado; exercício real pendente (§4) |
| Ambiente isolado | **Não cumprido nesta etapa; depende da Issue #021.** A execução é **assistida e externa** ao ACC: o PO roda o Claude Code na própria máquina, com a própria assinatura. O ACC **não isola** o processo do Claude Code (sistema de arquivos, rede, credenciais), não o inicia e não o supervisiona; ele só não executa agentes (`REAL_EXECUTION_ENABLED = false`, sem `child_process` no caminho da #008). A proteção de branch, a branch designada e a verificação posterior do PR (V1–V13) restringem e conferem o **resultado**, mas **não equivalem a isolamento de execução**. | **Pendente de #021** (aplicabilidade registrada; não declarado como cumprido) |
| Operações restritas à branch designada | Branch fixa por ordem; V3/V4/V5/V6 na verificação | Implementado e testado; exercício real pendente (§4.3) |
| Status rastreável | Estados projetados da ordem, histórico assinado do gateway, verificações só de acréscimo, auditoria #006 | Implementado e testado; exercício real pendente |
| Erros e interrupção tratados | Verificação sem gravação em erro; `head_changed`; liberação com diário, cruzamento e códigos 1/3/4 (`BARRIER_RELEASE.md`) | Implementado e testado; caso B pendente (§4.4) |
| Sem merge automático | Nenhuma mutation no GitHub; V7 alerta merge fora do fluxo | Implementado e testado |
| Testes, lint e build passam; evidências anexadas | CI do PR de fechamento; `docs/evidence/issue008-closing-validation.txt` | Pendente da CI e do exercício |
| Relatório do Claude Code, revisão do ChatGPT, documentação | `IMPLEMENTATION_REPORT_008_CLOSING.md`; revisão do ChatGPT no PR | Relatório pronto; revisão pendente |
| PO aprova decisões; branch própria; sem push na main; sem merge automático | Governança do repositório (ruleset `main-protection`, hook pre-push) | Em vigor |
| Barreira inicial liberada de forma supervisionada | Comando local (P1, PR #51) | Implementado; liberação real pendente (§3) |
| Exercício ponta a ponta real | Este documento. Ele comprova a **integração assistida** (ordem, aprovações, pacote, PR na branch designada, verificação somente leitura), não isolamento nem execução pelo ACC | **Pendente (não executado)** |
