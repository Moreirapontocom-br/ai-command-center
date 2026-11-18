# Issue #012 — PR 1: Fundação persistente da fila (relatório de implementação)

> **Escopo autorizado:** somente o PR 1 (fundação persistente, DORMENTE). Merge **não** autorizado.
> PR 2 (admissão, agendamento, despacho, cancelamento, reservas — U8) **não** foi iniciado.

| Item | Valor |
|---|---|
| Base | `origin/main` `a65b238cc5aba09adee0d5975f969c0152b207a6` (merge do PR #44) |
| Branch | `feature/012-queue-foundation` |
| Decisões aplicadas | D2, D3, D7, U1–U7 (U8 adiada para o PR 2) |
| Execução real | `REAL_EXECUTION_ENABLED = false` (inalterado) |
| Rotas HTTP / UI / temporizadores novos | nenhum |
| Custo / provedores | R$ 0; nenhum provedor real, nenhuma rede |

## 1. Verificação inicial

- `git status`: apenas dois arquivos não versionados preexistentes (`docs/evidence/issue002-review-validation.txt`, `documenta_o_t_cnica_initial_issue_001.md`), **não** incluídos neste PR.
- `git fetch`; `origin/main` = `a65b238…`; PR #44 `MERGED` (merge commit `a65b238`); Issue #012 `OPEN`.
- Branch criada com `git switch -c feature/012-queue-foundation origin/main` + `git branch --unset-upstream`.
- Inspecionados: `server/approvals/*` (#011), `server/policy/*` (#020), `server/sandbox/*` (#021), `server/limits/*` (#022), `server/storage/jsonFile.ts`, `server/config.ts`, `server/index.ts`, `server/security.test.ts`, `server/hardening.test.ts`. Nenhuma incompatibilidade com a `main` vigente.

## 2. Arquivos

### Criados
| Arquivo | Papel |
|---|---|
| `server/storage/errors.ts` | `ErrorFactory` + `StorageError`: cada núcleo injeta a própria classe de erro (mesmos códigos). |
| `server/storage/canonical.ts` | JSON canônico, SHA-256, `namespacedMacHex`, `equalHex`, `without` (extraídos sem mudança de bytes). |
| `server/storage/paths.ts` | `secureDirectory`, `assertSeparate`, `checkRegularFile` (extraídos; mesmas regras). |
| `server/storage/lock.ts` | `acquireLock(dir, names, {errors})` (extraído; nomes de arquivo e erros parametrizados). |
| `server/storage/subkeys.ts` | HKDF-SHA256 por domínio (`acc:queue:mac:v1`), `keyId` próprio, sem serialização da chave. |
| `server/storage/signedLedger.ts` | Motor genérico: ledger + histórico encadeado + anchor + marcadores + época/linhagem + quarentena. |
| `server/queue/contracts.ts` | Estados, transições, item, pedido de barreira pendente, eventos, `QueueError`. |
| `server/queue/documents.ts` | Validação estrita do corpo/eventos e regras entre versões (`checkQueueChange`). |
| `server/queue/store.ts` | `openQueueStore`: casos U7, reinício conservador, pedidos de barreira duráveis. |
| `server/queue/barrierGate.ts` | `BarrierAuthority` (interface estreita) + portão fail-closed + `engage`/`reconcile`. |
| `server/test/queueFixtures.ts` | Utilitários de teste (inclui processo Node real). Fora do código do servidor. |
| `server/storage/{compat,subkeys,lock,signedLedger}.test.ts`, `server/queue/{store,barrierGate}.test.ts` | Testes. |
| `docs/IMPLEMENTATION_REPORT_012_PR1.md`, `docs/evidence/issue012-pr1-*.txt` | Relatório e evidências. |

### Alterados
| Arquivo | Mudança |
|---|---|
| `server/approvals/canonical.ts` | Vira shim sobre `storage/canonical.ts` (namespace `acc-approvals:v1`, `ApprovalError`). |
| `server/approvals/paths.ts` | Vira shim sobre `storage/paths.ts` (`ApprovalError`). |
| `server/approvals/lock.ts` | Vira shim: `LOCK_FILE='approvals.lock'`, `TAKEOVER_FILE='approvals.lock.takeover'`, `acquireStoreLock`, `processAlive`. |
| `server/config.ts` (+ teste) | `QueueConfig` / `resolveQueueConfig` (`ACC_QUEUE_DIR`, `ACC_QUEUE_INITIALIZE`). |
| `server/index.ts` | Abre a fila DORMENTE, adapta a autoridade de barreira, `reconcile()`, log só com tokens; fecha no encerramento. |
| `server/security.test.ts` | Lista de `server/storage/` atualizada + 2 testes estruturais novos (ver §8). |
| `.env.example`, `docs/ARCHITECTURE.md` | Documentação das variáveis e resumo da arquitetura. |

**Ajustes à lista prevista (justificados):**
- `server/storage/errors.ts` (novo): necessário para preservar `ApprovalError` e os códigos **sem** embrulhar erros — a primitiva cria e reconhece erros só pela fábrica injetada (ver §4, D7).
- `storage/keys.ts` → **`storage/subkeys.ts`**: o teste de hardening da #003 proíbe o trecho `/keys` em código do servidor (endpoint REST de chaves do GitHub); o import `./storage/keys.ts` disparava o teste. Renomear evita afrouxar a proteção.
- `server/test/queueFixtures.ts`: utilitários de teste (pasta `test`, excluída das verificações estruturais, como `fixtures.ts`).
- Nenhum teste existente da #011 foi alterado.

## 3. Funcionalidades implementadas

1. **Motor de ledger assinado** (`signedLedger.ts`), mesmo desenho validado na #011:
   - `queue-ledger.json` (corpo + `generation` + `prevHead`), `queue-history.json` (somente acréscimo, `seq` contínuo, `prevHash`, hash por entrada), `queue-anchor.json` (no diretório de anchors), `queue-install.json` nos dois diretórios; HMAC-SHA256 por documento com domínio (`acc-queue:v1:<ledger|history|anchor|install>`).
   - Gravação histórico → ledger → anchor, cada uma atômica (tmp `wx` 0600 + fsync + rename); memória só muda depois das três; falha → `degraded` até reiniciar.
   - Alteração validada **antes** de gravar (`checkChange` + `checkBody` + entradas): recusa sem degradar e sem tocar no disco.
   - Abertura: caminhos seguros, bloqueio, chave, marcadores, MAC, formato estrito, encadeamento, linhagem, coerência com anchor (tolera só a queda antes do anchor), rollback de ledger/histórico/época, histórico à frente do ledger. Qualquer divergência → `unavailable`, arquivos nunca reescritos.
   - Recuperação administrativa com quarentena verificada (SHA-256 por arquivo + manifesto), restauração verificada em caso de falha.
   - Limites de tamanho (8 MiB ledger / 32 MiB histórico) checados antes de gravar.
2. **Registros da fila** (`contracts.ts`/`documents.ts`): item com identidade imutável, `idempotencyKey` única por dono, estados `queued → admitted → dispatching → running → {succeeded|failed|cancelled|interrupted|revoked}`, `expired`. Transições impostas em TODA gravação: nada volta a `queued`, terminais (inclusive `revoked`) nunca mudam, itens nunca são removidos, tentativa só cresce ao entrar em `dispatching`, aprovação vinculada nunca é trocada, `admitted+` exige aprovação.
3. **Abertura conservadora (U7)** em `store.ts`: ver §5.
4. **Portão de barreira (D3)** em `barrierGate.ts`: ver §4.
5. **Wiring dormente** em `index.ts`: abre a fila se `ACC_QUEUE_DIR` estiver configurado (exige aprovações configuradas), deriva a subchave e zera a cópia local da chave principal, adapta `service.status/barriers/engageBarrier` como `BarrierAuthority`, executa `reconcile()` e registra `state/reason/openedAs/blocked` (sem caminhos nem chaves). Não há ciclo, temporizador, rota nem executor.

## 4. Decisões arquiteturais efetivamente aplicadas

### D2 — Persistência durável
Aplicada como descrita em §3.1, em diretório exclusivo (`ACC_QUEUE_DIR`), com escritor único entre processos e fila única de operações no processo. A fila **não** depende da implementação interna da #011: só das primitivas compartilhadas. O armazenamento de aprovações **não** foi migrado para o motor genérico (risco de regressão sem ganho imediato); a duplicação temporária de desenho fica registrada como dívida para uma issue futura.

### D3 — Kill switch / barreira durável
- Autoridade única para **liberar**: a barreira durável da #011. O portão só **bloqueia** e bloqueia se QUALQUER fonte indicar: autoridade ausente/`degraded`/`unavailable`, barreira durável global ou do projeto, barreira volátil global ou do projeto, kill switch do controlador (#022, opcional; exceção = acionado), fila `degraded`/`unavailable`, pedido de barreira da fila pendente, resposta com formato inesperado ou exceção (`query_failed`).
- `BarrierAuthority { status, barriers, engage }` injetada; a fila não importa `server/approvals/`.
- `engage`: (1) grava o pedido na fila (durável) → (2) **aguarda** `engageBarrier` da #011 → (3) relê a autoridade e só com a barreira durável confirmada remove o pedido. Falha em qualquer passo mantém bloqueado; o pedido sobrevive ao reinício e é reenviado por `reconcile()`.
- Diferente do wiring da #011 entre controlador e aprovações (`void engageBarrier(...).catch()`), o caminho da fila **aguarda** a confirmação.
- Revogados nunca são reativados (imposto na gravação); liberação continua exigindo a aprovação `killswitch.release` da #011 — **nenhum** caminho novo de liberação foi criado.

### D7 + U4 — Primitivas compartilhadas
- `lock.ts`, `paths.ts`, `canonical.ts` movidos para `server/storage/` com `git mv` (histórico preservado) e generalizados com `ErrorFactory`.
- **Ponto crítico `instanceof ApprovalError`:** a retomada do bloqueio usava `throw error instanceof ApprovalError ? error : new ApprovalError('lock_recovery_failed')`. Agora é `errors.is(error) ? error : errors.create('lock_recovery_failed')`, com a fábrica do chamador. O shim de aprovações injeta a fábrica de `ApprovalError`: o comportamento é idêntico (o erro não é embrulhado nem convertido). Teste dedicado: um `store_locked` gerado DENTRO da exclusão (outra instância cria o bloqueio entre a remoção do abandonado e a recriação) continua `store_locked` — para as duas classes — e uma falha inesperada continua `lock_recovery_failed`.
- Shims em `server/approvals/` preservam API pública, nomes de arquivo, códigos e classes de erro.

### U5 — Subchave HKDF
`HKDF-SHA256(ikm = chave principal, salt = "acc-storage-subkey-salt:v1", info = "acc:queue:mac:v1", 32 bytes)`; `keyId = HMAC(subchave, "acc-subkey-id:v1:" + domínio)[0..16]`. A #011 continua usando a chave principal diretamente com o prefixo `acc-approvals:v1:` (sem migração). Na derivação, a chave principal só entra como material de entrada do HKDF (mensagem do HMAC de extração), nunca como chave de MAC de documento da fila. O objeto derivado tem a chave não enumerável, `toJSON`/`inspect` sem segredo, e é congelado.

### U6 — Anchor no diretório existente
`queue-anchor.json` e `queue-install.json` em `ACC_APPROVALS_ANCHOR_DIR`, com formato (`acc-queue-*`), domínio de MAC, linhagem e época próprios. A detecção de vestígios das aprovações (`approvals-*`) e da fila (`queue-*`) não se confundem (testado nas duas ordens de instalação). `ACC_QUEUE_DIR` precisa ser separado e não aninhado dos diretórios de aprovações e de anchors (validado na configuração e, pelo caminho real, na abertura).

### U7 — Distinção dos casos de abertura
Ver §5.

## 5. Inicialização e recuperação (Condição A)

| Caso | Detecção | Resultado |
|---|---|---|
| 1. Primeira instalação legítima | nenhum documento, nenhum marcador, nenhum vestígio (`queue-*`, temporários, `quarantine`, `queue.lock.takeover`) **e** `ACC_QUEUE_INITIALIZE=if_absent` | linhagem nova, época 1, **pedido de barreira global pendente** (`queue_initial_install`); `reconcile()` aciona a barreira global da #011 |
| 2. Reinício normal | documentos íntegros e coerentes com o anchor | época +1; `dispatching`/`running` → `interrupted` (`instance_restart`, sem retomada); `admitted` → `expired` (reservas/aprovações não sobrevivem ao reinício); `queued` intacto; pedidos pendentes preservados e reenviados |
| 3. Recuperação após falha | só `recover()` administrativo, com fila `unavailable` por integridade/ausência | quarentena verificada + manifesto; linhagem nova sem itens antigos; **pedido de barreira global** (`queue_recovery`); falha → originais restaurados e verificados, continua `unavailable` |
| 4. Perda / substituição / adulteração | marcador sem documentos (`store_missing`), anchor/ledger/histórico ausente, MAC, formato, `lineage_mismatch`, `key_mismatch`, `*_rollback`, `*_anchor_mismatch`, `history_ahead_of_ledger` | `unavailable`, nada reescrito; `reconcile()` aciona a barreira global da #011 (`queue_integrity`) |

Perda **total** (inclusive os arquivos da fila no diretório de anchors) é indistinguível de uma primeira instalação — por isso exige `if_absent` explícito e, mesmo assim, a linhagem nova nasce bloqueada. Nenhum caso ambíguo libera execução.

`recover()` não tem rota nem chamador neste PR; a autorização humana (como a `recover` da #011 com prova de identidade) fica para quando houver interface aprovada.

## 6. Concorrência (Condição B)

- **No processo:** todas as operações (`commit`, `recover`, `close`) passam por uma fila única; o portão serializa `engage`/`reconcile`.
- **Entre processos:** bloqueio de escritor único (`queue.lock`, criação exclusiva `wx`); uma instância indisponível continua segurando o bloqueio (necessário para `recover`).
- **Testado com processos Node reais:** 4 processos escrevendo em paralelo (cada um repete em `store_locked`) → 20 itens, histórico contínuo, época coerente; processo segurando o bloqueio → outra instância recusada; `SIGKILL` → retomada registrada (`queue.lock_recovered`) e item em curso marcado `interrupted`; 5 processos disputando o lock genérico.
- **Não alegado:** garantia distribuída, compartilhamento de rede, proteção contra escrita fora do ACC (papel do MAC/anchor). Bloqueio de outra máquina ou pid vivo/reutilizado → `store_locked` (remoção humana).

## 7. Compatibilidade com a Issue #011 (Condição C)

- **Vetores fixos** calculados com o código da `main` (`a65b238`) ANTES da extração: JSON canônico, SHA-256, `macHex(key,'ledger',…)` e `keyIdOf` — idênticos após a extração (`storage/compat.test.ts`).
- Códigos e classes de erro (`canonical_*`, `path_*`, `paths_not_separate`, `file_*`, `store_locked`, `lock_recovery_failed`, …) preservados; API do shim `lock` = exatamente `LOCK_FILE`, `TAKEOVER_FILE`, `acquireStoreLock`, `processAlive`.
- Suíte da #011 e vizinhas **sem nenhuma alteração nos testes**: 17 arquivos / 653 testes verdes (`approvals`, `limits`, `sandbox`, `http`, `tasks`, `projects`, `audit`, `policy`).
- Integração com o núcleo REAL: barreira acionada pela fila é durável na #011 (sobrevive à reabertura, ator `acc-queue`), aprovações continuam íntegras com os arquivos da fila no mesmo diretório de anchors (em qualquer ordem de instalação), perda das aprovações continua detectada, aprovações com gravação falhando → fila bloqueada e pedido mantido.
- Testes estruturais da #011 (lista de arquivos, imports permitidos de `approvals/*`, rotas) passam **sem alteração**.

## 8. Testes estruturais alterados (justificativa)

1. Lista de `server/storage/` no teste "projetos e tarefas…": acrescenta os 6 módulos novos (as mesmas proibições — GitHub, rede, subprocesso — continuam valendo para eles).
2. **Novo** "armazenamento compartilhado": `server/storage/*` sem `process.env`, rede, subprocesso, `vm`/`worker_threads`/`eval`, e sem importar `approvals/`, `queue/`, `sandbox/`, `limits/`.
3. **Novo** "fila dormente": lista fechada de `server/queue/*`; sem `process.env`, rede, subprocesso, **sem `setInterval`/`setTimeout`/`setImmediate`**, sem importar aprovações/sandbox/controlador; só `server/index.ts` usa a fila; nenhuma rota `queue|dispatch|enqueue|schedul|fila`; `REAL_EXECUTION_ENABLED = false as const`.

Nenhuma restrição existente foi removida ou afrouxada.

## 9. Testes e verificações executados

| Verificação | Resultado |
|---|---|
| Suítes novas (`storage`, `queue`, `config`, `security`, `hardening`) | 9 arquivos / **151** testes verdes |
| Regressão #011 e vizinhas (testes inalterados) | 17 arquivos / **653** verdes |
| Suíte completa local | **1064/1065** verdes; 1 falha = `scripts/main-audit.test.mjs`, peculiaridade LOCAL conhecida (workflows com CRLF por `core.autocrlf=true`; o arquivo não foi tocado e passa no CI/Linux) |
| `tsc -b` | sem erros |
| `eslint .` | sem erros |
| `npm run build` + `check:secrets` (dist) + `check:csp` | ok |
| `scripts/check-secrets.mjs tracked` e `staged` | nenhuma credencial |
| Teste de fumaça do servidor (`server/index.ts`) | ver `docs/evidence/issue012-pr1-checks.txt` |
| GitHub Actions do PR | ver §13 / PR |

Total da suíte: 1006 testes na `main` + 59 novos = 1065.

## 10. Riscos e limitações conhecidos

- **Duplicação de desenho**: `approvals/store.ts` e `storage/signedLedger.ts` implementam o mesmo protocolo separadamente (sem migração da #011 nesta etapa).
- **Regravação completa por commit** (ledger e histórico inteiros): custo O(n); limitado por 10 000 itens e 8/32 MiB. Sem retenção/compactação do histórico da fila neste PR → ao atingir o teto, gravações são recusadas (`history_full`, fail-safe). Retenção fica para o PR 2 ou issue futura.
- **Rollback completo e consistente** de TODOS os arquivos da fila (dados + anchor) para um estado antigo assinado não é detectável sem referência externa (mesma limitação da #011).
- **Windows:** ACLs dos diretórios não são verificadas (só no POSIX, como na #011); `process.kill(pid, 0)` decide abandono do bloqueio.
- **Bloqueio:** só mesma máquina/disco local; pid reutilizado → `store_locked` (intervenção humana).
- **Produção:** a barreira global inicial da #011 continua ativa e sem rota de liberação (N9) → a fila fica sempre bloqueada em produção, por desenho.
- **`recover()` da fila** existe só como API interna (sem rota/chamador); exigirá prova humana quando exposto.
- **Pedido de barreira global**: uma barreira global confirmada satisfaz qualquer pedido global pendente (o escopo importa, não o motivo); o motivo original fica no histórico da fila.
- **Transições**: a tabela é imposta na gravação; o PR 2 poderá revisá-la (ex.: reintentos), sob nova revisão.

## 11. Situação das Issues #004, #020, #021 e #022 (U2 — nenhuma foi fechada)

| Issue | Estado no GitHub | PR | Situação funcional | Ações pendentes |
|---|---|---|---|---|
| #004 Projetos | OPEN, checklist não marcado | #37 merged | Funcionalmente concluída no escopo aprovado (lista autorizada no servidor, persistência atômica, isolamento por dono, testes de autorização) | Marcar critérios / documentação Gemini, se aplicável; fechamento pelo PO |
| #020 Política | OPEN, checklist não marcado | #40 merged | Funcionalmente concluída (negação por padrão, antes de cada rota; consumo de aprovações integrado na #011) | Fechamento pelo PO |
| #021 Sandbox | OPEN, checklist não marcado | #41 merged | **Preparatória**: contratos, ciclo de vida, isolamento lógico e limpeza com provedor simulado; execução real desligada | Isolamento real depende de executor (#031); decidir fechar com ressalva ou manter aberta |
| #022 Orçamento/kill switch | OPEN, checklist não marcado | #42 merged | **Parcial**: limites, quotas, kill switch e cancelamento em memória; persistência e retry/backoff ainda não | Persistência de admissões/reservas (U8, #012 PR 2) e retry/backoff (#012/#028) |

Sequência planejada registrada (U3): **#012 → #028 → #008 → #009 → #010**. Nenhuma dessas foi iniciada. U1: #008/#010 dispensadas como pré-requisito somente para execução simulada.

## 12. Checklist de segurança

- [x] Nada na `main`; branch dedicada; sem merge.
- [x] Sem rota, UI, temporizador, despacho, executor, subprocesso ou rede na fila (teste estrutural).
- [x] `REAL_EXECUTION_ENABLED = false`; nenhum provedor real; R$ 0.
- [x] Fail-closed em qualquer dúvida; linhagem nova nasce bloqueada; liberação só pela #011.
- [x] Chave nunca registrada/serializada; cópia local da chave principal zerada após a derivação; logs só com tokens.
- [x] Diretórios fora do Git e de pastas sincronizadas; arquivos sem links; 0600/0700.
- [x] Quarentena verificada antes de nova linhagem; originais nunca reescritos na leitura.
- [x] Revogados/terminais imutáveis; interrompidos nunca retomados automaticamente.
- [x] Varredura de segredos (`tracked`, `staged`, `dist`).

## 13. Parecer

A implementação cobre D2, D3, D7 e U1–U7 com testes de integridade, recuperação, concorrência entre processos reais e compatibilidade com a #011. **Apta para revisão independente** assim que a CI do PR estiver verde (estado registrado no PR). Merge e PR 2 aguardam autorização explícita do Product Owner.
