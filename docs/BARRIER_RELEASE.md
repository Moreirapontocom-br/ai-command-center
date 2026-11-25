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
2. `.env.local` com `ACC_DEPLOYMENT=local`, aprovações configuradas (`ACC_APPROVALS_DIR`, `ACC_APPROVALS_ANCHOR_DIR`, chave) e o administrador (`ACC_ADMIN_EMAIL`, `ACC_ADMIN_PASSWORD_HASH`). `NODE_ENV=production` é recusado.
3. O armazenamento da #011 já precisa existir (criado na primeira subida do servidor com `ACC_APPROVALS_INITIALIZE=if_absent`). O comando **nunca** cria um armazenamento.
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
| — | Reconciliação do diário, se houver um pendente (§5); a execução termina aí |
| — | Checagens: store disponível, sem `history_unapplied` nesta abertura, sem barreira volátil, linhagem igual nos dois marcadores, barreira `initial_install` |
| — | Limite de tentativas (§4) |
| P3 | Tentativa registrada no arquivo de limite **antes** de ler a senha |
| — | Senha e frase; frase errada ou senha errada → `approval.confirmation` recusada na #006 |
| P4 | `approval.confirmation` com sucesso na #006 (prova que a auditoria grava) e o limite volta a zero |
| P5 | Diário `intent` |
| P6, P7 | `confirmOwner` (aprovação de uso único) e `reserve` (tentativa) na #011 |
| P8 | Diário `reserved` |
| P9 | `releaseBarrier`: único commit (histórico → ledger → anchor) |
| P10 | Diário `committed` |
| P11 | Fecha e reabre o store; confirma `global === null`, um `barrier_released` e a tentativa `succeeded` |
| P12 | `approval.configuration` com sucesso na #006 (`resource.id` = aprovação, `context.seq` = seq do `barrier_released`) |
| P13 | Diário apagado; só então "LIBERADA" |

### Códigos de saída

| Código | Mensagem | Significado |
|---|---|---|
| 0 | `LIBERADA` | Liberada, gravada, relida e auditada |
| 0 | `RECONCILIADA` | Uma operação anterior foi conciliada (§5) |
| 1 | `RECUSADA` | Nada foi alterado na barreira |
| 1 | `NÃO LIBERADA` | Interrompida depois do diário; as aprovações ficam indisponíveis no servidor até nova execução |
| 3 | `LIBERAÇÃO REGISTRADA NA #011, AUDITORIA PENDENTE` | A liberação vale; a #006 será completada na próxima execução |

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

**Diário corrompido:** confira o estado na #011 (histórico de aprovações). Só apague o diário à mão se a barreira e os eventos estiverem coerentes com uma das duas primeiras linhas; a próxima execução confere tudo de novo.

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
