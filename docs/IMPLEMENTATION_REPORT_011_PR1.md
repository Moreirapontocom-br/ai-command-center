# Issue #011 — PR 1: núcleo de aprovações humanas

> **Escopo:** somente o núcleo (D10). Camada **dormente**: nenhum código do servidor importa
> `server/approvals/` neste PR, não há rota HTTP, interface, integração com agentes nem execução real.
> `REAL_EXECUTION_ENABLED = false` e todas as capacidades críticas continuam `available: false`.
> A integração com #021/#022, as rotas autenticadas e a interface mínima são o **PR 2**.

## 1. Componentes

| Arquivo | Responsabilidade |
|---|---|
| `server/approvals/contracts.ts` | Classes, estados e transições (aprovação e tentativa), métodos de confirmação, `classOf`, TTLs (D5), limites de step-up (N5), compactação (N7), retenção (N10), motivos de preservação (N8) e de recuperação, eventos `approval.*`. |
| `server/approvals/canonical.ts` | JSON canônico (chaves ordenadas; recusa `undefined`/não finitos/objetos não planos), SHA-256 e HMAC-SHA256 com separação de domínio. |
| `server/approvals/binding.ts` | Validação estrita do `ApprovalBinding` e `bindingDigest` canônico; SHA obrigatório nas `SHA_BOUND_ACTIONS` da #020; escopos de barreira. |
| `server/approvals/keyProvider.ts` | `ApprovalKeyProvider` (D3): variável de ambiente (injetada) ou arquivo protegido; ≥ 32 bytes; `keyId` derivado por HMAC; interface pronta para um cofre. |
| `server/approvals/paths.ts` | N2: caminhos absolutos, resolvidos com `realpath.native` (links simbólicos e **junções**); recusa Git, pastas sincronizadas (variáveis do OneDrive e nomes de clientes conhecidos), diretórios aninhados; arquivos nunca link nem com hard links. |
| `server/approvals/lock.ts` | Escritor único: bloqueio exclusivo (`wx`); bloqueio abandonado só é retomado se for desta máquina e o processo dono não existir (registrado no histórico). |
| `server/approvals/documents.ts` | Formatos persistidos e validação estrita (campos fechados, invariantes por estado, encadeamento do histórico, lápides). |
| `server/approvals/store.ts` | Ledger + histórico + anchor com HMAC, geração, encadeamento, época, linhagem; abertura com verificação; degradação; recuperação administrativa com quarentena. |
| `server/approvals/identity.ts` | `IdentityConfirmer` (senha nesta fase; extensível a TOTP/WebAuthn) e registro de provas de step-up (sessão, uso único, 5 min, bloqueio 5×/15 min reutilizando o limitador da #003). |
| `server/approvals/service.ts` | O gate: pedido, decisão, confirmação do PO, retirada, revogação, reserva durável, recibos, verificadores confiáveis por componente, resultado, reconhecimento, barreiras, retenção, preservação, compactação e recuperação. |

## 2. Contratos alterados (compatíveis)

- `shared/contracts.ts`: `APPROVAL_METHODS`/`ApprovalMethod` e `ApprovalGrant.method?` (**opcional**; ausente = `approval`). Grants existentes da #020/#021/#022 continuam válidos sem alteração.
- `server/policy/engine.ts`: `PolicyFacts.verifiedOwnerConfirmationId?` (opcional). A exceção ao `self_approval` vale **somente** quando: `method === 'owner_confirmation'`, sujeito humano igual ao aprovador, ação **crítica** e id atestado pelo servidor. Sem o fato, o comportamento anterior é mantido (testes antigos inalterados). Método desconhecido → `invalid_method`.
- `ApprovalVerifier` da #022: **sem alteração**. O `TrustedApprovalVerifier` (`kind: 'trusted'`) implementa `verify(HumanApproval)` e acrescenta `verifyGrant(ApprovalGrant)` para a #020.
  - **Ajuste em relação à Fase 0.1 (N4):** a proposta era mudar `verify` para aceitar uma união; isso exigiria alterar o verificador simulado e o controlador. Um método adicional tipado atinge o mesmo objetivo (verificador único) sem tocar o contrato da #022.

## 3. Soluções R1–R6

### R1 — consumo e falha entre etapas
- Decisão (`decide`/`confirmOwner`) → reserva durável (`reserve`: `approved → consumed` + tentativa `reserved`, **gravados antes** de qualquer efeito) → recibo (memória, 30 s) → resultado (`recordOutcome`).
- O recibo é preso a tentativa, aprovação, época, **componente** e ao **resumo exato** do objeto entregue (`ApprovalGrant` ou `HumanApproval`); a validação é síncrona, de uso único, e consulta de novo as barreiras.
- `succeeded` exige recibo validado. Falha antes da reserva não consome; depois, a aprovação continua consumida. Queda com tentativa `reserved` → `indeterminate` ao reabrir; só o PO a reconhece (`acknowledged_by_owner`) e **nada é reexecutado**. Repetir exige nova aprovação.

### R2 — persistência e recuperação
- Escrita atômica (`writeFileAtomic`: tmp + fsync + rename) na ordem histórico → ledger → anchor, em fila única; o estado em memória só muda depois das três gravações.
- Qualquer falha de gravação → **degradado** até reiniciar (nada mais é decidido nem consumido; recibos são recusados).
- Abertura: valida caminhos, bloqueio, chave, formato, MAC, invariantes, linhagem e coerência com o anchor. Aceita apenas a queda entre a gravação de um documento e a do anchor (ledger exatamente +1 e encadeado; histórico à frente contendo o item do anchor). Entradas do histórico de gerações não gravadas ficam marcadas (`approval.history_unapplied`).
- Inconsistência, estado desconhecido, arquivo ilegível ou chave diferente → **indisponível** (nega tudo); os arquivos nunca são reescritos.
- **Recuperação administrativa (revisada, 5.5):** `service.recover` exige armazenamento indisponível, prova de step-up de uso único do PO e motivo da lista fechada. Os arquivos atuais são **movidos para quarentena** (o anchor é copiado), nunca apagados; inicia-se linhagem e época novas **sem nenhuma aprovação antiga** e com **barreira global ativa**. Liberar a barreira exige aprovação de configuração. Tudo fica no novo histórico (`approval.store_recovered`). A Fase 0.1 previa "mover os arquivos e reiniciar"; isso foi substituído por este procedimento controlado.

### R3 — kill switch e concorrência
- `engageBarrier`: efeito **imediato em memória** (síncrono) e, em seguida, durável no ledger. Revoga as aprovações de execução não usadas do escopo (D6) e invalida recibos pendentes no escopo.
- Reserva **e** validação do recibo consultam a barreira durável, a volátil e o kill switch do controlador #022 (gancho; falha ao consultar = acionado).
- Decisão, reserva, revogação e barreira passam pela mesma fila, o que dá ordem linear.
- **N6:** com barreira ou kill switch ativos no escopo, pedidos não-configuração não podem ser aprovados.
- A barreira durável prevalece após reinício (o estado volátil some; a barreira não). Só uma aprovação `killswitch.release` consumida a libera: pelo próprio núcleo (`releaseBarrier`) ou pelo controlador #022 (`recordOutcome` com sucesso). Revogadas continuam revogadas.
- **Interpretação conservadora (documentada):** a reserva bloqueia todas as classes exceto configuração (execução, merge, publicação, custo); a revogação automática (D6) atinge só a classe execução, como decidido.

### R4 — confirmação especial do administrador
- `confirmOwner`: sujeito = pessoa da sessão (nunca do corpo), prova de step-up desta sessão (≤ 5 min, uso único), `bindingDigest` exibido, classe não-execução.
- Agentes: `assertHumanContext` recusa ids de agentes; `request` só aceita sujeito agente e **recusa** operações de configuração; nenhuma API recebe `approvedBy`; só `identity.ts` usa `verifyPassword` (teste estrutural).

### R5 — auditoria e retenção
- Separação: estado mínimo (ledger) × histórico consultável (`approvals-history.json`, encadeado, somente acréscimo) × eventos da #006 (espelhamento no PR 2).
- Retenção configurável (30 dias–5 anos, padrão 365; mudar exige aprovação de configuração). Descarte transforma entradas em **lápides** que preservam o encadeamento; nunca descarta entradas de aprovações ainda no ledger nem preservadas.
- Descarte administrativo: aprovação de configuração + janela ≥ 30 dias. Preservação: motivo de lista fechada + texto saneado ≤ 200 caracteres, com prova.
- Compactação (N7): terminais com mais de 30 dias, sem preservação e sem tentativa em aberto. Id compactado → `approval_not_issued`: ausência = negação, nunca reativação.

### R6 — rollback
- O HMAC prova a origem, não a atualidade. Defesas: geração + `prevHead`; **anchor em outro diretório** com `{generation, head}` do ledger e `{seq, head}` do histórico; linhagem; **época (N1)**.
- Ledger antigo → `ledger_rollback`; histórico antigo → `history_rollback`; anchor ausente → `anchor_missing`.
- Restauração conjunta dos três (indetectável localmente) → a época nova invalida o que estava aprovado e não consumido.

## 4. N1–N10 neste PR
N1 época (aprovações concedidas expiram ao reiniciar; pendentes sobrevivem) · N2 caminhos efetivos validados · N3 barreira durável independente do controlador · N4 `method`, exceção controlada e verificador tipado · N5 step-up (sessão, uso único, 5 min, 5 falhas → 15 min) · N6 sem aprovação de pedidos em escopo barrado · N7 compactação segura · N8 preservação · N9 nenhuma rota · N10 faixa de retenção.

> **Emenda ao N9 (Issue #008, P1, autorizada pelo PO).** Continua não existindo rota HTTP que acione ou libere o kill switch ou a barreira. A única exceção é o comando LOCAL `npm run admin:release-barrier` (`server/admin/`), que libera **somente** a barreira global `initial_install`, com senha do administrador, terminal interativo, frase ligada à linhagem e aprovação de configuração de uso único pelo próprio núcleo. Todas as demais proibições do N9 permanecem. Procedimento: `docs/BARRIER_RELEASE.md`.

## 5. Testes
- `server/approvals/approvals.test.ts`: **77 testes** (52 iniciais + 25 da rodada R1), cobrindo todos os cenários da seção 7 do pedido (válida, forjada, identidade, autoaprovação, SHA, parâmetros, política, expirada, revogada, reutilização, concorrência, reinício, falha de escrita, ledger corrompido, anchor ausente/divergente, rollback, recibo expirado/de outro componente, revogação durante a tentativa, kill switch durante o consumo e após reinício, histórico preservado, compactação, chave indisponível, falha de verificador, compatibilidade #020/#022, execução real desligada, caminhos e bloqueio).
- `server/security.test.ts`: +1 teste estrutural (núcleo dormente; sem rede, subprocesso, `process.env`, sandbox, controlador ou verificador simulado; senha só em `identity.ts`; nenhuma rota).
- Evidências: `docs/evidence/issue011-pr1-approvals-tests.txt` e `docs/evidence/issue011-pr1-checks.txt`.

## 5.1 Revisão independente — rodada R1 (correções)

| Ponto | Correção |
|---|---|
| **R1 — recuperação/quarentena** | `recover()` não ignora mais nenhuma falha. Cada evidência (ledger, histórico, anchor e os dois marcadores) é COPIADA para `quarantine/<id>/` e verificada byte a byte (SHA-256 e tamanho); um `manifest.json` (presentes/ausentes, SHA-256, tamanho) é gravado e verificado. Só então a nova linhagem é gravada. Falha na quarentena (diretório, leitura, cópia, verificação, arquivo não regular) → `quarantine_*`, nada fora da quarentena é alterado, continua indisponível. Falha ao gravar a nova linhagem → os originais são restaurados e verificados (`recovery_failed`); se a restauração também falhar → `recovery_restore_failed`. Recuperação é recusada quando o motivo não é de integridade/ausência (ex.: `store_locked`, `store_not_initialized`). |
| **R2 — documentos ausentes** | Marcador de instalação assinado (`approvals-install.json`) nos dois diretórios, gravado antes dos documentos e conferido (MAC, chave, linhagem) em toda abertura. Sem documentos: com marcador ou qualquer vestígio (quarentena, temporários, arquivo de retomada) → `store_missing`; sem vestígios → `store_not_initialized`, salvo `initialize: 'if_absent'` explícito. **Toda instalação nova começa com barreira global** (`initial_install`), que só sai com aprovação de configuração. Limite documentado: sem referência externa confiável, a remoção COMPLETA dos dois diretórios é indistinguível de uma primeira instalação — por isso o bloqueio inicial: apagar o armazenamento nunca libera um bloqueio de emergência. |
| **R3 — transações** | `StoreTransaction.afterCommit`: efeitos em memória que concedem ou restauram autoridade (prazo monotônico de uso, remoção da barreira volátil) só rodam depois da gravação. Efeitos que só restringem (invalidar recibo, apagar prazo, acionar barreira volátil, encerrar validação) continuam imediatos. Recibos já eram emitidos só depois da gravação. |
| **R4 — lock** | Retomada serializada por `approvals.lock.takeover` (criação exclusiva) e com releitura: só remove o bloqueio se ainda for exatamente o abandonado (mesmo nonce) — elimina a corrida em que um recuperador atrasado apagava o bloqueio recém-criado por outro. Conteúdo ilegível, link, outra máquina, pid vivo ou reutilizado → `store_locked`; falha na retomada → `lock_recovery_failed` (arquivo de retomada sempre removido); retomada abandonada → `lock_recovery_stale`. Liberação só remove o próprio bloqueio (nonce). |

Testes novos da rodada: 25 (R1: 7, R2: 6, R3: 6, R4: 6), incluindo dois processos reais (o filho é encerrado com `SIGKILL`) e corridas determinísticas de retomada.

## 6. Limitações e riscos residuais
- **Windows:** sem fsync de diretório; um `rename` perdido numa queda resulta em bloqueio (*fail-closed*), não em liberação. ACLs do arquivo de chave não são verificadas no Windows (POSIX: exige 0600).
- Detecção de pasta sincronizada por variáveis e nomes conhecidos: clientes desconhecidos com nomes arbitrários não são detectados.
- Atacante com acesso ao usuário (lê a chave e grava ledger e anchor com o processo parado) está fora do alcance local.
- Histórico em um documento (reescrita atômica, limite de 32 MB). Volumes maiores exigiriam formato incremental.
- Barreira cuja gravação falhou vale só em memória até reiniciar; depois do reinício não há aprovações utilizáveis (N1), mas o kill switch do controlador #022 continua volátil (D9 → #012).
- Sem referência externa, remover COMPLETAMENTE os dois diretórios equivale a uma primeira instalação (mitigado pela barreira global inicial). Um processo que reutilize o pid de um dono encerrado impede a retomada automática (fail-closed; exige remoção humana do bloqueio).
- A falha local de `scripts/main-audit.test.mjs` é do ambiente Windows (`core.autocrlf`); ocorre também na `main` e não na CI.

## 7. Próximo (PR 2, não iniciado)
Espelhamento dos eventos na #006; ligação em `server/index.ts` com configuração (`ACC_APPROVALS_DIR`, `ACC_APPROVALS_ANCHOR_DIR`, `ACC_APPROVAL_KEY`/`_FILE`); sandbox e controlador usando `reserve`/verificadores; rotas autenticadas com CSRF; interface mínima (D4); agendamento do `sweep`.
