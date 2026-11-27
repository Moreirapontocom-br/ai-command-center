# Liberação da barreira global inicial (Issue #008, P1)

Toda instalação nova do núcleo de aprovações (#011) nasce com a **barreira global** `initial_install`. Enquanto ela existir, aprovações de execução e a criação de ordens do Claude Code (#008) respondem 423. Este documento descreve o **único** caminho para liberá-la: um comando local, supervisionado e de uso único.

> **Autorização.** Implementar o comando foi autorizado (P1). **Executá-lo contra dados reais não foi.** A primeira liberação real exige autorização separada do Product Owner, depois do merge e da configuração local das aprovações e do administrador (D-P1.5).

## 1. O que o comando faz e não faz

- Libera **somente** a barreira global com motivo `initial_install` (D-P1.2). Os motivos `recovery`, `queue_integrity`, `manual`, emergência ou qualquer outro são recusados.
- **Não existe rota HTTP** (N9). O servidor não importa o comando.
- Usa o mesmo caminho do núcleo que `service.configure`: `confirmOwner(killswitch.release, {scope:'global'})` → `reserve({component:'approvals'})` → `releaseBarrier` (um único commit atômico). O núcleo da #011 não foi alterado.
- Não liga nada além disso: não ativa provedores, fila executora, sandbox, gateway nem limites. `REAL_EXECUTION_ENABLED` continua `false`. Cada ordem da #008 continua exigindo as duas aprovações humanas.
- Não aceita argumentos (só `--help`). Não existe `--yes`, `--password`, entrada redirecionada nem modo automático.

## 2. Pré-requisitos

1. **Servidor parado.** O comando e o servidor disputam o mesmo lock de instância (`ACC_DATA_DIR/acc-instance.lock`). Se um estiver ativo, o outro recusa.
2. A mesma configuração do servidor (`.env.local` no diretório do projeto; o ambiente tem precedência). O comando não usa o GitHub, mas valida a configuração inteira como o servidor: se você inicia o servidor com o GitHub CLI e `GITHUB_TOKEN` vazio (`docs/GITHUB_INTEGRATION.md`, "Iniciar com o GitHub CLI"), use a mesma receita aqui. É preciso `ACC_DEPLOYMENT=local`, aprovações configuradas (`ACC_APPROVALS_DIR`, `ACC_APPROVALS_ANCHOR_DIR`, chave) e o administrador (`ACC_ADMIN_EMAIL`, `ACC_ADMIN_PASSWORD_HASH`). `NODE_ENV=production` é recusado.
3. O armazenamento da #011 já precisa existir (criado na primeira subida do servidor com `ACC_APPROVALS_INITIALIZE=if_absent`). O comando **nunca** cria um armazenamento.

Passo a passo da configuração no Windows, da primeira subida e do exercício ponta a ponta: `docs/evidence/issue008-e2e.md`.
4. **Terminal interativo real:** PowerShell ou Windows Terminal. O Git Bash (mintty) não oferece modo raw e é recusado. Sessões com variáveis típicas de agente ou automação (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`, `GITHUB_ACTIONS`, `CI` e outras) são recusadas. Essa recusa é defesa adicional; a garantia vem da senha e da #011.

## 3. Execução

```powershell
npm run admin:release-barrier
```

O comando mostra a linhagem completa do armazenamento, a data da instalação, a época e o motivo da barreira. Depois pede:

1. a senha do administrador, sem eco;
2. a frase exata `LIBERAR GLOBAL <8 primeiros caracteres da linhagem>`.

Não existe variável de "linhagem esperada" (decisão **H3 = não**): a frase digitada é a confirmação da linhagem.

### Sequência e pontos de persistência

| Passo | O que grava |
|---|---|
| P1 | Lock de instância, antes de qualquer arquivo de dados |
| P2 | Abre projetos, tarefas e auditoria (sequência global), o store da #011 (`initialize: never`, nova época) e a fila (`reconcile()`) |
| — | Cruzamento #011 × #006 (§5.1): contradição → recusa sem gravar |
| — | Reconciliação do diário, se houver um pendente (§5), ou pelos fatos, se faltar registro sem diário (§5.1); a execução termina aí |
| — | Checagens: store disponível, sem `history_unapplied` nesta abertura, sem barreira volátil, linhagem igual nos dois marcadores, barreira `initial_install` |
| — | Limite de tentativas (§4) |
| P3 | Tentativa registrada no arquivo de limite **antes** de ler a senha |
| — | Senha e frase; frase errada ou senha errada → `approval.confirmation` recusada na #006 |
| P4 | `approval.confirmation` com sucesso na #006 (prova que a auditoria grava) e o limite volta a zero |
| P5 | Diário `intent` |
| P6, P7 | `confirmOwner` (aprovação de uso único) e `reserve` (tentativa) na #011 |
| P8 | Diário `reserved` |
| P9 | `releaseBarrier`: único commit (histórico → ledger → anchor). Falha de gravação aqui → **indeterminado** (código 4) |
| P10 | Diário `committed` |
| P11 | Fecha e reabre o store; confirma `global === null`, um `barrier_released` e a tentativa `succeeded`. Releitura contraditória → **indeterminado** (código 4) |
| P12 | `approval.configuration` com sucesso na #006 (`resource.id` = aprovação, `context.seq` = seq do `barrier_released`) |
| P13 | Diário apagado; só então "LIBERADA" |

### Códigos de saída

| Código | Mensagem | Significado |
|---|---|---|
| 0 | `LIBERADA` | Liberada, gravada, relida e auditada |
| 0 | `RECONCILIADA` | Uma operação anterior foi conciliada (§5) |
| 1 | `RECUSADA` | Nada foi alterado na barreira |
| 1 | `NÃO LIBERADA` | Interrompida depois do diário e **comprovadamente** antes de qualquer gravação da liberação (queda até o P8 ou recusa do núcleo antes de gravar, como recibo vencido); as aprovações ficam indisponíveis no servidor até nova execução |
| 3 | `LIBERAÇÃO REGISTRADA NA #011, AUDITORIA PENDENTE` | O núcleo confirmou o commit; a #006 será completada na próxima execução |
| 4 | `RESULTADO INDETERMINADO` | A gravação da liberação começou e falhou (por exemplo, ledger gravado e anchor não), ou a releitura no P11 contradiz o commit. **Não presuma liberada nem ativa.** As aprovações ficam indisponíveis; a próxima execução reconcilia pelos fatos da #011 ou, havendo contradição, recusa e pede investigação humana |

Recuperação: em qualquer código diferente de 0, execute o comando de novo, com o servidor parado. A reconciliação é idempotente: nunca grava um segundo registro final e nunca libera nada.

## 4. Limite de tentativas (R3, H2)

- Arquivo `ACC_DATA_DIR/admin-release.throttle.json`. Cada tentativa é gravada como falha **antes** da senha. Matar o processo no meio conta como falha. Só um sucesso zera.
- 5 falhas em 15 minutos → bloqueio de 15 minutos (os mesmos valores do step-up da #011).
- **20 falhas seguidas → trava dura (decisão H2 = sim).** Nenhuma espera a libera.
- Conferência cruzada com as falhas de `approval.confirmation` na #006 (janela de 15 minutos, depois do último sucesso). Vale a mais restritiva.
- Arquivo ilegível, corrompido ou link → recusa. Horário mais de 1 minuto no futuro (relógio voltou) → recusa.

**Procedimento humano para a trava dura:** (1) investigue as tentativas na auditoria (`GET /api/audit?action=approval.confirmation`) e confirme que foram suas; (2) com o servidor parado, apague `admin-release.throttle.json`; (3) aguarde 15 minutos desde a última falha (a #006 continua contando); (4) execute o comando de novo. Registre o motivo fora do ACC. Quem tem acesso de escrita a `ACC_DATA_DIR` já está fora do modelo de ameaça (§7).

## 5. Diário e reconciliação (R2)

Arquivo `ACC_DATA_DIR/admin-release.journal.json`, sem segredos. Enquanto ele existir, **o servidor sobe com as aprovações indisponíveis** (`admin_reconcile_pending`); o restante do ACC funciona. A fonte de verdade é o histórico da #011; o diário só registra a pendência.

Na próxima execução, o comando reconcilia e termina:

| Diário | Fatos na #011 | Ação |
|---|---|---|
| `intent` ou `reserved` | Barreira global presente, nenhuma liberação aplicada e tentativa não concluída | `approval.configuration` com falha (`interrupted`) na #006; apaga o diário. Execute de novo para liberar. |
| `reserved` ou `committed` | Tentativa `succeeded`, um `barrier_released` aplicado e `global === null` | `approval.configuration` com sucesso (`reconciled`); apaga o diário |
| Qualquer | Divergência (linhagem, eventos, store indisponível ou degradado) | Recusa e mantém o diário. Investigação humana. |
| Ilegível | — | Recusa; as aprovações continuam indisponíveis |

Entradas que a #011 declarou não aplicadas (`history_unapplied`) não contam como fato.

A reconciliação **não pede senha**: ela não libera nada, só completa a #006 a partir dos fatos da #011 e apaga o diário. Ela é idempotente: se o registro final já estiver na #006 (queda depois do P12, ou falha ao apagar o diário), não grava de novo.

**Diário corrompido:** confira o estado na #011 (histórico de aprovações). Só apague o diário à mão se a barreira e os eventos estiverem coerentes com uma das duas primeiras linhas; a próxima execução confere tudo de novo (inclusive o cruzamento de §5.1, que não depende do diário).

### 5.1 Cruzamento #011 × #006 (fechamento da #008, L3)

O diário mora em `ACC_DATA_DIR`. Para que a segurança não dependa dele (diário apagado, ou servidor com outro `ACC_DATA_DIR` sobre as mesmas aprovações), o **servidor** e o **comando** cruzam os fatos a cada abertura (`server/admin/consistency.ts`, puro):

- Para cada `approval.barrier_released` global, humano e aplicado na #011: a mesma geração do ledger tem exatamente uma `approval.attempt_succeeded` (dá a aprovação e a tentativa), e o pedido dessa aprovação, se retido, é `killswitch.release` global.
- Na #006 tem de existir **exatamente um** `approval.configuration` com sucesso, do administrador (`ownerId` e ator), sem projeto, operação `barrier_release_global`, `resource = {approval, <id da aprovação>}` e `context.seq = <seq da liberação>`.
- **Identificador primário: a aprovação** (C2). O `approvalId` é um UUID v4 aleatório da #011, de uso único e nunca reaproveitado entre linhagens. Todo registro desta operação que cite essa aprovação, com qualquer resultado, tem de ser exato. A correlação **não usa o relógio**.

| Veredito | Servidor | Comando |
|---|---|---|
| Consistente | Aprovações abertas normalmente | Segue o fluxo |
| Falta o registro (`missing`) | Aprovações **indisponíveis** (`admin_reconcile_pending`) | Grava o registro que falta (`reason: reconciled_from_facts`), confere de novo e termina com `RECONCILIADA` |
| Contradição (`inconsistent`): registro da mesma aprovação duplicado ou divergente (seq, ator, dono, projeto, tipo, resultado), aprovação usada por duas liberações, correlação ausente na #011, erro de leitura | Aprovações **indisponíveis** (`admin_audit_inconsistent`) | Recusa (`consistency_<motivo>`) sem gravar nada |

- Registros de **outras** aprovações (inclusive de linhagens antigas com o mesmo seq, gravados antes ou depois) são ignorados: nunca validam esta liberação nem a bloqueiam.
- **Relógio** (C2): atraso ou avanço não muda o veredito. Um registro gravado com o relógio atrasado vale normalmente, e a reconciliação só grava quando não existe nenhum registro da aprovação, então nunca duplica.
- **Retenção** (C1): a #006 **nunca descarta** o registro final de sucesso desta operação (`isPreservedEvent` em `server/audit/events.ts`). A ausência é sempre `missing`, por mais eventos que se acumulem. Impacto: cerca de 0,6 KiB por liberação aplicada, no máximo um por linhagem e por `ACC_DATA_DIR` (só `initial_install` é liberável, e só uma instalação nova cria outra), o que dá cerca de 0,55 MiB a cada 1.000 reinstalações, diante do limite de 16 MiB do arquivo. Se só restarem eventos preservados, o registro fica acima de 20.000 em vez de perdê-los. Se o arquivo chegar ao limite de bytes, a gravação **falha de forma explícita** (a escrita é recusada); nada é descartado em silêncio.
- Instalação sem liberação é sempre consistente (compatibilidade com históricos anteriores).

**Contradição (`admin_audit_inconsistent`), procedimento humano:** a auditoria é só de acréscimo, e o ACC nunca apaga nem corrige registros sozinho. Exporte `audit.json` e o histórico de aprovações e compare-os com a tabela acima. Se a adulteração for confirmada, o caminho é a recuperação da #011 (nova linhagem, barreira `recovery`, que este comando não libera) ou a restauração de um backup íntegro de `ACC_DATA_DIR`. Registre a decisão fora do ACC.

## 6. Locks

- `acc-instance.lock` (servidor e comando), `approvals.lock` (store da #011) e o lock da fila.
- Lock órfão (processo morto, mesma máquina): retomado automaticamente na próxima subida.
- Conteúdo ilegível, link, outra máquina ou processo vivo (inclusive número de processo reutilizado): recusa. **O código nunca remove um lock ativo.** Remoção humana: confirme no Gerenciador de Tarefas que nenhum processo do ACC está ativo (o `pid` está no arquivo) e apague o arquivo `.lock` e, se existir, o `.lock.takeover`.
- Kill forçado no Windows (TerminateProcess) não executa o tratamento de sinais: o lock fica órfão e é retomado; o diário, se houver, é reconciliado.

## 7. Rollback depois de uma liberação

Reacionar a barreira pelos caminhos que já existem: o kill switch de emergência da #011, `engageBarrier` com motivo `manual`, ou `recover` (nova linhagem com barreira `recovery`). Nenhum caminho novo foi criado, e o comando recusa liberar qualquer um desses motivos.

## 8. Limites do modelo de ameaça

- Quem tem escrita em `ACC_DATA_DIR`, nos diretórios da #011 **e** a chave HMAC já consegue forjar estado; isso está fora do alcance do comando.
- Um agente com pseudoterminal que conheça a senha passaria pelas recusas de terminal. A senha nunca fica em disco; a frase é ligada à linhagem; tudo fica auditado.
- Relógio adiantado pode encurtar a espera de 15 minutos; a trava dura e o custo do scrypt continuam valendo.
- **L2 (risco residual aceito):** a trava dura de 20 falhas fica só em `admin-release.throttle.json`. Apagar esse arquivo zera o contador; a conferência cruzada com a #006 cobre apenas a janela de 15 minutos. Isso exige escrita em `ACC_DATA_DIR`, que já está fora do modelo de ameaça. O código do contador não foi alterado.
- O cruzamento de §5.1 compara arquivos que quem tem escrita em `ACC_DATA_DIR` também pode editar. Ele detecta inconsistência e lacuna, mas não é prova contra adulteração coordenada dos dois lados.
- O registro informativo de interrupção (`approval.configuration` com falha, `reason: interrupted`) ainda usa o início do diário para não se repetir. Com o relógio atrasado entre duas interrupções, ele pode se repetir ou faltar. Esse registro não participa do cruzamento e não libera nada.
