# Issue #008 — P1: comando local de liberação da barreira global inicial

**Branch:** `feature/008-p1-barrier-release` (base `origin/main` `df442e7`, merge do PR #50).
**Autorização do PO:** implementar a P1 conforme a revisão final de segurança (D-P1.1–D-P1.5, R1–R5), com **H2 = sim** e **H3 = não**, ajuste restrito do N9, lock de instância, um único PR, testes completos, **sem merge e sem liberação real**.
**Procedimento operacional:** `docs/BARRIER_RELEASE.md`.

## 1. Decisões aplicadas

| Decisão | Significado recuperado | Onde está |
|---|---|---|
| D-P1.1 | Opção B: comando local supervisionado; nenhum endpoint HTTP | `server/admin/`, `npm run admin:release-barrier`; `POST_ROUTES` inalterado |
| D-P1.2 | Só a barreira `initial_install` | `RELEASABLE_REASONS` congelado; `assessState` |
| D-P1.3 | Senha do administrador (scrypt, via step-up da #011) + TTY + frase ligada à linhagem | `releaseBarrier.ts`, `releaseBarrierCli.ts` |
| D-P1.4 | Emenda restrita do N9 (só este comando); demais proibições mantidas | `IMPLEMENTATION_REPORT_011_PR1.md` (emenda), `ARCHITECTURE.md`, `security.test.ts` |
| D-P1.5 | Nenhuma liberação real nesta fase | Nenhuma execução contra dados reais; `.env.local` intocado |
| **H2 = sim** | Trava dura após 20 falhas seguidas sem sucesso, removida só por procedimento humano documentado | `HARD_LOCK_FAILURES = 20` em `throttle.ts`; `BARRIER_RELEASE.md` §4 |
| **H3 = não** | Não adotar `ACC_APPROVALS_EXPECTED_LINEAGE`; a frase com a linhagem cumpre o papel | Teste estrutural: `EXPECTED_LINEAGE` não aparece em nenhum arquivo do servidor |

Fonte das decisões: revisão final de segurança da P1 (2026-11-19, seção H: "2. Trava dura de 20 falhas… Recomendo adotar"; "3. Lineage esperada opcional (`ACC_APPROVALS_EXPECTED_LINEAGE`): recomendo não adotar agora").

## 2. Arquivos

| Tipo | Arquivo |
|---|---|
| Novo | `server/admin/releaseBarrier.ts` — orquestração P1–P13, reconciliação, checagens R4 (dependências injetáveis) |
| Novo | `server/admin/releaseBarrierCli.ts` — terminal (modo raw, recusas de argumentos/agente/TTY, sinais) |
| Novo | `server/admin/journal.ts` — diário `intent → reserved → committed` (R2) |
| Novo | `server/admin/throttle.ts` — limite persistente write-ahead + trava dura H2 (R3) |
| Novo | `server/admin/instance.ts` — lock de instância (`acc-instance.lock`) e consulta de pendência para o servidor (R1) |
| Novos (testes) | `server/admin/{releaseBarrier,releaseBarrierCli,journal,throttle,instance}.test.ts` |
| Alterado | `server/index.ts` — lock de instância antes de abrir qualquer arquivo de dados; liberado após fechar os stores (SIGINT/SIGTERM) e antes dos `process.exit(1)` posteriores; diário pendente → aprovações nem são abertas (`admin_reconcile_pending`) |
| Alterado | `server/security.test.ts` — só estreitado: os importadores de `approvals/*` e `queue/*` ganham exatamente `server/admin/releaseBarrier.ts`; novo bloco estrutural da P1 |
| Alterado | `package.json` — script `admin:release-barrier` |
| Alterado (texto) | `docs/IMPLEMENTATION_REPORT_011_PR1.md` (emenda ao N9), `docs/ARCHITECTURE.md` |
| Novos (docs) | `docs/BARRIER_RELEASE.md`, este relatório, `docs/evidence/issue008-p1-validation.txt` |
| **Sem mudança** | `approvals/*` (núcleo da #011), fila, limites, sandbox, políticas, gateway, rotas HTTP, contrato da #006 |

**Diferença em relação ao desenho:** o desenho previa que o `index.ts` importasse só `admin/journal.ts`. O lock de instância e a consulta de pendência ficaram em `admin/instance.ts`, e o `index.ts` importa só esse arquivo (fixado em teste). O lock usa a primitiva revisada `storage/lock.ts` sem alterá-la.

## 3. N9 — o que mudou e o que não mudou

- **Continua proibido:** qualquer rota HTTP que acione/libere kill switch ou barreira, recupere o armazenamento ou mexa em limites. `POST_ROUTES` é idêntico ao da main; nenhum arquivo de `server/http/` importa `admin/`; o `index.ts` não referencia `releaseBarrier`.
- **Exceção única:** o comando local, que chama `releaseBarrier` (único chamador fora do núcleo, verificado estruturalmente) com uma aprovação `killswitch.release` de escopo exato `{scope:'global'}`, montada internamente, sujeito humano fixo `admin`, nascida de `confirmOwner` com prova de step-up de uso único.
- **Não é genérica:** só `initial_install`; outros motivos (`recovery`, `queue_integrity`, `manual`, emergência, desconhecido) recusados; nenhuma barreira de projeto; nenhuma outra operação de configuração.

## 4. Lock de instância

- `ACC_DATA_DIR/acc-instance.lock`, criação exclusiva `wx` + fsync; retomada só de lock da mesma máquina, de outro pid que não existe, serializada por `acc-instance.lock.takeover` com releitura do nonce; liberação só do próprio nonce.
- Servidor e comando obtêm o lock **antes** de abrir projetos, tarefas, auditoria, aprovações, fila e gateway (ordem fixada em teste estrutural e verificada com o servidor real como processo filho).
- Ambíguo (ilegível, link, outra máquina, processo vivo, mesmo pid) → recusa; o lock não é removido.

## 5. Matriz de critérios de aceite × testes

| # | Critério | Testes |
|---|---|---|
| 1 | Aprovação autenticada de uso único | `releaseBarrier.test.ts` F1 (histórico completo, releitura, #006 correlacionada, reserva repetida → `approval_already_used`) |
| 2 | TTLs preservados | F2 (valores; prova, aprovação e recibo vencidos → nada liberado, reconciliado) |
| 3 | Apenas `initial_install` | F3 (6 motivos recusados; `assessState`) |
| 4 | Identidade incorreta | F4/F5 (`step_up_session_mismatch`, `identity_mismatch`, `invalid_owner_confirmation`) |
| 5 | Agente | F4/F5 (`identity_invalid` para id de agente); `releaseBarrierCli.test.ts` (argumentos, 11 variáveis de agente, sem TTY/raw, ambiente real desta sessão recusado) |
| 6 | Senha incorreta | F6 (recusa, contador, #006, barreira continua; cancelamento) |
| 7 | Limite persistente / H2 | F7 + `throttle.test.ts` (5 falhas em execuções separadas, queda no P3 conta, frase errada conta, trava dura de 20, arquivo corrompido, relógio voltou, conferência cruzada com a #006, falha de gravação) |
| 8 | Reinício | F8 (quedas após P5–P8 → `interrupted`; após P9–P12 → código 3 e `reconciled`; diário ilegível, divergente ou de outra linhagem → recusa) |
| 9 | Falha de armazenamento | F9 (falha no histórico, no ledger e no anchor durante a liberação) |
| 10 | Falha de auditoria | F10 (P4 aborta antes da #011; P12 → código 3 e reconciliação; auditoria ilegível) |
| 11 | Concorrência | F11/F12 (instância ativa; duas execuções simultâneas → uma só libera); `instance.test.ts` (servidor real × lock) |
| 12 | Lock órfão | F11/F12 e `instance.test.ts` (retomada; vivo/outra máquina/ilegível/mesmo pid → recusa sem remover; takeover abandonado) |
| 13 | Fila divergente | F13 (fila ausente, pedido pendente aplicado na reconciliação, configuração inválida) |
| 14 | Kill switch ativo | `assessState` (barreira volátil); tripwire estrutural `controllerKillSwitch` |
| 15 | Linhagem incorreta | F15/F16 (frase errada; marcador de outra linhagem) |
| 16 | Anchor inválido | F15/F16 (ausente, adulterado) |
| 17 | Reacionamento | F17 (`engageBarrier` manual bloqueia de novo e não é liberável pelo comando) |
| 18 | Sem rota HTTP | `security.test.ts` bloco P1 + teste de `POST_ROUTES` existente |
| 19 | Nenhuma execução automática | lista fechada de importações; `REAL_EXECUTION_ENABLED === false`; só aprovação de configuração criada |
| 20 | Duas aprovações da #008 | a liberação só cria a aprovação `killswitch.release`; o fluxo de ordens não muda (testes existentes de `claudeOrders.test.ts` inalterados e verdes) |
| 21 | Instalação nova / store ausente | F21 (store ausente não é criado) |
| 22 | Ciclo de vida do servidor | `instance.test.ts` (servidor real: recusa com lock ativo sem abrir dados; lock com o pid do servidor; SIGTERM libera no Linux/CI; kill forçado → retomada; diário pendente → aprovações indisponíveis sem abrir o store) |

## 6. Validação

| Verificação | Resultado |
|---|---|
| Testes (antes, `origin/main` df442e7) | 1334 (1333 ✓ + 1 falha local conhecida) |
| Testes (depois) | 1459 (1458 ✓ + a mesma falha local) — **+125** |
| Falha local conhecida | `scripts/main-audit.test.mjs` (workflows com CRLF por `core.autocrlf=true`); idêntica na main; passa na CI (Linux) |
| `npm run lint` | limpo |
| `tsc -b` | limpo |
| `npm run build`, `check:csp`, `check:secrets` | ok |
| `check:secrets:repo`, `check:secrets:history` | nenhuma credencial |

Detalhes em `docs/evidence/issue008-p1-validation.txt`.

## 7. Riscos residuais e limitações

1. **Nunca executado contra dados reais** (D-P1.5). O `.env.local` desta máquina não tem aprovações nem administrador; a primeira liberação exige configuração e autorização separada.
2. Escrita no disco + chave da #011 permite forjar estado (fora do modelo de ameaça).
3. Agente com pseudoterminal que conheça a senha passaria pelas recusas de terminal; contenção: senha só em hash, frase com a linhagem, auditoria.
4. Relógio adiantado encurta a espera de 15 min; trava dura e scrypt continuam valendo.
5. Kill forçado no Windows não executa o tratamento de sinais: lock e diário ficam pendentes e são retomados/reconciliados (testado).
6. A liberação de SIGTERM do lock só é verificável fora do Windows (o teste roda essa parte na CI Linux).
7. Apagar o diário à mão entre P9 e P12 cria lacuna só na #006; a #011 mantém o registro.
8. A lista de variáveis de agente é defesa adicional e pode ficar desatualizada; não é a garantia.

## 8. Pendências da Issue #008

- Revisão independente (ChatGPT) e autorização do PO para o merge deste PR.
- Configuração local das aprovações e do administrador, e autorização **separada** para a primeira liberação real.
- Depois da liberação real: exercitar o fluxo assistido completo em produção local (hoje só exercitado em testes, `IMPLEMENTATION_REPORT_008_PR2.md` §limitações).
