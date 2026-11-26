# Issue #008 — PR de fechamento: L1, L3, registro do L2 e preparação do exercício real

> **Autorização.** O PO autorizou a implementação deste PR único de fechamento (L1, L3, registro do L2, testes, roteiro ponta a ponta e checklist). **Não** autorizados nesta etapa: merge, liberação real da barreira, ações contra dados reais, PR #52, Issues #009/#010. O exercício real e suas evidências entram neste mesmo PR depois da aprovação técnica.

## 1. Baseline

- Main `3718703580a073ac099e2aced94ed51338acad36` (merge do PR #51; CI e Main audit pós-merge verdes).
- Branch `feature/008-closing`, criada da main.
- Baseline local: 1460 testes, 1459 ok. A única falha é a conhecida de CRLF (`scripts/main-audit.test.mjs`), que passa 33/33 num checkout LF.

## 2. Soluções

### L1 — resultado `indeterminate` (código 4)

| Situação | Antes | Agora |
|---|---|---|
| Queda até o P8 ou recusa do núcleo **antes** de gravar (recibo vencido, tentativa inválida, store indisponível) | 1 `pending` | 1 `pending` (comprovadamente nada liberado) |
| `releaseBarrier` falha com `store_write_failed` ou erro desconhecido (histórico, ledger ou anchor) | 1 `pending` ("NÃO LIBERADA", mesmo com o ledger já gravado) | **4 `indeterminate`** |
| Releitura no P11 contradiz o commit confirmado pelo núcleo | 3 `audit_pending` | **4 `indeterminate`** |
| Queda depois do commit confirmado (P9–P12) | 3 | 3 (inalterado) |

- A distinção vem do tipo do erro: `ApprovalError` com código diferente de `store_write_failed` só acontece antes do commit (validação do recibo e da tentativa, ou `commit` cuja função lançou: nada gravado).
- Recuperação: o diário continua `reserved` ou `committed`, o servidor sobe com as aprovações indisponíveis, e a próxima execução reconcilia pelos fatos da #011 (já idempotente desde a R1). Se a #011 contradisser o diário ou estiver indisponível, o comando recusa e mantém tudo.
- Mensagem nova: "RESULTADO INDETERMINADO ... Não presuma que a barreira está liberada nem ativa".

### L3 — cruzamento #011 × #006 (`server/admin/consistency.ts`)

> Regras de correlação e retenção atualizadas por C1/C2 (§7): a relação é só pela aprovação, sem relógio, e a retenção da #006 preserva o registro final. A descrição abaixo é a da versão `6bf2a2b`; onde ela divergir, vale a §7.

Módulo **puro**: não importa `node:*` e só recebe o histórico e a auditoria já abertos. Ele decide, nunca grava. É usado pelo **servidor** (na subida, depois de abrir o store e antes de criar o serviço) e pelo **comando** (antes de qualquer reconciliação ou liberação).

**Correlação** de cada `approval.barrier_released` global, humano e aplicado (seqs de `history_unapplied` excluídos):

1. Ator = administrador. Outro → `release_actor_unexpected`.
2. Exatamente uma `approval.attempt_succeeded` na **mesma geração do ledger** (o commit atômico de `applyInternal`). Ela dá `approvalId` e `attemptId`. Zero ou mais de uma → `release_uncorrelated`.
3. O `approval.requested` dessa aprovação, se retido, é `killswitch.release` sem projeto. Outro → `release_approval_unexpected`. Ausente sem tombstones → `release_uncorrelated`.
4. Na #006, entre os `approval.configuration` de sucesso com operação `barrier_release_global` e gravados **depois** da liberação, os que citam o mesmo seq **ou** a mesma aprovação precisam ser idênticos em identidade (ator humano `admin`, `ownerId` `admin`), escopo (sem projeto, recurso `approval`) e correlação (aprovação **e** seq). Qualquer divergência → `audit_record_mismatch`. Mais de um idêntico → `audit_record_duplicate`.
5. Nenhum registro: se a retenção da #006 já descartou eventos posteriores à liberação, a ausência é aceita. Caso contrário → `missing`.
6. Qualquer exceção na leitura → `check_failed`.

| Veredito | Servidor | Comando |
|---|---|---|
| `consistent` | Aprovações abertas | Segue |
| `missing` | Indisponíveis (`admin_reconcile_pending`) | `reconcileFromFacts`: grava o registro faltante (`reason: reconciled_from_facts`), confere de novo, código 0 `reconciled` |
| `inconsistent` | Indisponíveis (`admin_audit_inconsistent`) | Recusa `consistency_<motivo>` sem gravar |

- **Sem duplicação:** a reconciliação só grava quando o cruzamento aponta `missing`, isto é, quando não há nenhum registro relacionado. Depois de gravar, ela confere de novo e exige `consistent`.
- **Não libera nada:** os dois caminhos de reconciliação só chamam `audit.append`. Um teste estrutural proíbe, em `consistency.ts`, `append`, `commit`, `releaseBarrier`, `engageBarrier`, `confirmOwner`, `reserve` e `node:*`.
- **Linhagens anteriores:** registros gravados antes da liberação não contam. Um `audit.json` antigo com seq coincidente (reinstalação ou recuperação da #011 reinicia o seq) não trava a nova linhagem.
- **Compatibilidade:** instalação sem liberação é sempre `consistent`. Históricos com barreira reacionada, confirmações recusadas e operações interrompidas também são.
- **Independe do diário e de `ACC_DATA_DIR`:** o diário continua em `ACC_DATA_DIR` e não foi para o diretório das aprovações, porque o `recover()` da #011 põe em quarentena arquivos que não reconhece. Agora um servidor com outro `ACC_DATA_DIR`, ou com o diário apagado, vê a lacuna pelos fatos.
- **Núcleo da #011 inalterado:** nenhum arquivo de `server/approvals/` mudou.

### L2 — risco residual (sem mudança de código)

Registrado em `docs/BARRIER_RELEASE.md` §8: a trava dura de 20 falhas fica só em `admin-release.throttle.json`. Apagar o arquivo zera o contador; a cruzada com a #006 cobre só 15 minutos. Isso exige escrita em `ACC_DATA_DIR`, fora do modelo de ameaça. `throttle.ts` não foi tocado.

## 3. Arquivos

| Tipo | Arquivo |
|---|---|
| Novo | `server/admin/consistency.ts` — cruzamento puro (L3) |
| Alterado | `server/admin/releaseBarrier.ts` — fases `release_attempted`/`indeterminate` (L1); cruzamento antes da reconciliação; `reconcileFromFacts`; regra única de liberações aplicadas vinda de `consistency.ts` |
| Alterado | `server/admin/releaseBarrierCli.ts` — mensagem do código 4 |
| Alterado | `server/index.ts` — cruzamento na subida; indisponível com `admin_reconcile_pending`/`admin_audit_inconsistent` |
| Testes | `server/admin/releaseBarrier.test.ts` (+18 casos; F9 ajustado para o código 4), `server/security.test.ts` (listas fechadas, pureza do cruzamento e posição no `index.ts`) |
| Docs | `docs/BARRIER_RELEASE.md` (códigos 1/3/4, recuperação, §5.1 cruzamento, L2), `docs/ARCHITECTURE.md`, `docs/evidence/issue008-e2e.md` (configuração Windows, subida, liberação, roteiro A/B, recuperação, registro em branco, checklist), este relatório, `docs/evidence/issue008-closing-validation.txt` |

## 4. Testes novos

| Pedido | Teste |
|---|---|
| Falha de gravação → incerto | F9 (histórico, ledger, anchor) → código 4; reconciliação determinística e repetição sem novo registro |
| Falha comprovada | L1: recibo vencido no P8 → código 1 `pending`, nunca 4 |
| Releitura contraditória | L1: ledger adulterado antes do P11 → código 4; reconciliação recusa e mantém o diário |
| Registro ausente / diário apagado numa operação incompleta | L3: queda no P11 + diário apagado → `missing`; o comando reconcilia pelos fatos |
| Diário apagado antes da liberação | L3: queda no P7 + diário apagado → consistente; a próxima execução libera |
| Reinicializações sucessivas | L3: três reaberturas, veredito estável (consistente e `missing`) |
| Reconciliação repetida | L3: segunda execução não grava nem cria aprovações (`no_global_barrier`) |
| Correlação incorreta com seq coincidente | L3: aprovação trocada (mesmo seq), seq trocado (mesma aprovação), ator agente, outro dono, tipo de recurso → `audit_record_mismatch`; o comando recusa sem gravar nem liberar |
| Duplicado | L3: `audit_record_duplicate` |
| Histórico legítimo anterior | L3: instalação nova + confirmação recusada + barreira manual → consistente; registro de outra linhagem com seq coincidente e anterior → ignorado |
| Retenção da #006 | L3: descarte posterior à liberação aceito; sem descarte → `missing` |
| Falha de leitura da auditoria | L3: entradas malformadas → `check_failed`; `audit.json` ilegível → o comando recusa (`data_files_unavailable`) |
| Divergência entre diretórios | L3: outro `ACC_DATA_DIR` sobre as mesmas aprovações reconcilia na própria #006; os dois ficam consistentes |
| Servidor real | L3: processo filho mostra `admin_reconcile_pending` (inclusive com outro `ACC_DATA_DIR`), depois `approvals_opened` após reconciliar, e `admin_audit_inconsistent` com registro adulterado |

## 5. Resultados

Ver `docs/evidence/issue008-closing-validation.txt`.

## 6. Riscos residuais

1. **L2** (acima).
2. O cruzamento compara arquivos que quem escreve em `ACC_DATA_DIR` também pode editar. Ele detecta lacuna e inconsistência, mas não protege contra adulteração coordenada da #006 (que não tem MAC).
3. Contradição (`admin_audit_inconsistent`) não tem correção automática, de propósito. A saída é humana: recuperação da #011 ou backup íntegro (`BARRIER_RELEASE.md` §5.1).
4. ~~Relógio que voltou muito…~~ Corrigido em C2: a correlação não usa o relógio. Resta só o registro informativo de interrupção (fora do cruzamento), que pode se repetir ou faltar com o relógio atrasado.
5. Os riscos de P1 continuam valendo (`IMPLEMENTATION_REPORT_008_P1.md` §7).
6. **Nada foi executado contra dados reais.** O comportamento do terminal real (PowerShell e Windows Terminal, modo raw) está coberto por testes unitários, não por execução manual.

## 7. Correções C1–C4 (validação final do ChatGPT, autorizadas pelo PO)

A validação dirigida (R1–R3) sobre `6bf2a2b` confirmou dois defeitos no cruzamento, nenhum deles capaz de liberar sem aprovação correlacionada:

- **R1:** com o registro final ausente, 45.000 eventos fariam a lacuna ser aceita pela tolerância à retenção.
- **R2:** o filtro de tempo fazia registros gravados com o relógio atrasado não contarem (reconciliações repetidas gravavam registros ignorados), e um registro de linhagem antiga com o relógio adiantado causava um `inconsistent` indevido.

| Correção | O que mudou |
|---|---|
| **C1** | `server/audit/events.ts`: `isPreservedEvent` (registro final de sucesso de `barrier_release_global`); `applyRetention` nunca o descarta, fica acima do limite se só restarem preservados e passa a contar o descarte efetivo. `consistency.ts` sem a tolerância a `droppedEvents`: ausência = sempre `missing`. Impacto no armazenamento em `BARRIER_RELEASE.md` §5.1 (cerca de 0,6 KiB por liberação; limite de bytes → falha explícita, nunca descarte silencioso). |
| **C2** | `consistency.ts`: sem filtro temporal. Relação só pelo `approvalId` (UUID v4 de uso único, nunca reaproveitado entre linhagens), com **qualquer** resultado; registro relacionado tem de ser exato (seq, ator, dono, projeto, tipo, operação, sucesso). Duplicado → `audit_record_duplicate`; contraditório → `audit_record_mismatch`; outra aprovação ou linhagem → ignorado (não valida, não bloqueia); aprovação em duas liberações → `release_uncorrelated`. `releaseBarrier.ts`: a idempotência da reconciliação com diário também deixa de usar o relógio para o registro final. |
| **C3** | `docs/evidence/issue008-e2e.md` §0: branch `feature/008-closing`, SHA aprovado, working tree íntegra (arquivos não versionados do PO preservados), `npm ci`; interrupção em qualquer divergência. |
| **C4** | Checklist: "Ambiente isolado" **pendente da #021**. Execução assistida e externa; o ACC não isola o processo do Claude Code; proteção de branch e verificação posterior não equivalem a isolamento. O exercício comprova só a integração assistida. |

**Testes** (`server/admin/consistency.test.ts`, novo, puro; mais ajustes em `releaseBarrier.test.ts`):
- retenção com 45.000 eventos (anônimos e atribuídos) mantendo `missing`;
- preservação do registro legítimo;
- várias linhagens acima do limite, com contagem exata;
- retenção anterior inalterada;
- relógio atrasado e adiantado, nos testes puros e com o comando real;
- reconciliações sucessivas sem duplicação;
- linhagens com seq coincidente, antes e depois;
- duplicado e contraditório da mesma aprovação;
- aprovação em duas liberações;
- auditoria malformada;
- regressões de R3 (dois `ACC_DATA_DIR`, correlação ausente, pedido de outra ação, nenhuma liberação fabricada);
- servidor real indisponível com registro divergente.

## 8. Pendências para fechar a #008

1. Revisão técnica (ChatGPT) deste PR no SHA final.
2. Autorização do PO para configurar o ambiente local e liberar a barreira (`docs/evidence/issue008-e2e.md` §1–§3).
3. Exercício ponta a ponta, casos A e B (§4), com o registro preenchido (§7) e commitado neste PR.
4. Checklist de encerramento (§8 do roteiro) atualizado, merge autorizado pelo PO e fechamento da Issue #8.
