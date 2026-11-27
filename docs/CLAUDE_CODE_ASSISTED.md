# Integração supervisionada com Claude Code — Especificação (Issue #008, PR 1)

> **Status: ESPECIFICAÇÃO (PR 1, aprovada: D-08.1–D-08.11) + IMPLEMENTAÇÃO DO FLUXO ASSISTIDO (PR 2, em revisão; ver §13 e `docs/IMPLEMENTATION_REPORT_008_PR2.md`).**
> - O ACC **não executa** o Claude Code nem nenhum agente. Nesta integração, quem executa é a pessoa (o PO), com a própria assinatura, em ambiente oficial da Anthropic.
> - `REAL_EXECUTION_ENABLED = false as const` (inalterado). No PR 2, o gateway (#028) é ligado no servidor **só no canal assistido**, sem adaptador, sem fila e sem execução.
> - `agent.invoke` e `data.send_external` continuam `available: false` em `POLICY_ACTIONS`; só a exceção fechada de §10.7 as torna aprováveis, e só o perfil `claude-code/subscription_assisted` ficou `available` no catálogo.
> - Orçamento adicional: **R$ 0**. Assinatura Claude Pro **não** equivale a acesso à API.
> - Merge do PR 2: só com revisão independente e autorização explícita do PO.
> - **Issue #055:** a ponte MCP local (`docs/MCP_BRIDGE.md`) substitui a cópia manual do pacote e da referência do PR. O agente recebe e PROPÕE; o PO confirma com step-up. O fluxo manual deste documento continua como contingência.
>
> Base: `main` `5ac983abaeb80418da6113a98f6346c75f118ffc` (merge do PR #48, conclusão da #028). Fontes oficiais consultadas em **2026-11-19** (registro em `docs/evidence/issue008-pr1-sources.txt`).

## Sumário

1. Objetivo, limites e vocabulário
2. Arquitetura assistida (A)
3. Ordem de trabalho (B)
4. Aprovações (C)
5. Estados (D)
6. Verificação do PR (E)
7. Segurança (F)
8. Custos e provedores (G)
9. Dependências (H)
10. Plano do PR 2
11. Decisões pendentes do PO
12. Registro de fontes

---

## 1. Objetivo, limites e vocabulário

**Objetivo.** O ACC prepara uma **ordem de trabalho** para o Claude Code, o PO a aprova e a leva ao Claude Code por conta própria. O Claude Code trabalha na **branch designada** e abre um PR. O PO informa o PR, e o ACC o **verifica somente por leitura** no GitHub e apresenta o resultado. O ACC **nunca** faz merge.

**Fora do escopo da #008 (nesta fase):**

| Fora do escopo | Onde fica |
|---|---|
| O ACC iniciar o Claude Code (processo local, Agent SDK, API, Action) | Execução real: #021/#022/#031 + decisão própria (§8) |
| Escrita no GitHub pelo ACC (branch, comentário, dispatch, merge) | Não previsto |
| Execução em sandbox cloud | #031 |
| Roteamento automático entre agentes | #029 |
| Experiência completa de frontend | #014/#015 |

**Vocabulário.**

| Termo | Significado |
|---|---|
| Ordem de trabalho | Pacote do fluxo assistido do gateway (`GatewayHandoff`), especializado para o Claude Code. Não é um registro novo e paralelo (§5). |
| Pessoa / PO | O administrador único autenticado do ACC (#003). |
| Executar | Rodar código ou ferramentas. Nesta integração o **ACC nunca executa**: só prepara, registra e lê. |
| Verificar | Ler metadados do PR no GitHub e compará-los com a ordem. Verificar **não** é aprovar merge. |

## 2. Arquitetura assistida (A)

```
 PO (navegador, sessão #003)
   │ 1 pede ordem          5 informa PR (owner/repo#N)          8 vê resultado
   ▼                         │                                   ▲
┌──────────────────────────── ACC (servidor) ─────────────────────────────────┐
│ Coordenador / rotas  ──► Tarefas (#005): tarefa ativa, atribuída a claude-code│
│        │                                                                    │
│        ├─► Política (#020): agent.invoke / data.send_external, atribuição   │
│        ├─► Aprovações (#011): pedido, apresentação gateway.scope, grant,    │
│        │                      recibo de uso único, step-up                  │
│        ├─► Gateway (#028), canal `assisted`: escopo → handoff (pacote       │
│        │      cifrado, secretScan) → liberação → retorno = referência de PR │
│        ├─► Limites (#022): perfil claude-code/subscription_assisted,        │
│        │      barreira e kill switch                                        │
│        ├─► Verificador de PR (NOVO, PR 2) ─► GitHub GraphQL somente leitura │
│        │      (#002: documento na allowlist, credencial do servidor)        │
│        └─► Auditoria: histórico assinado `gateway.*` (+ espelho #006)       │
└─────────────────────────────────────────────────────────────────────────────┘
   │ 3 PO copia o pacote liberado
   ▼
 PO executa, ele mesmo, o Claude Code (CLI/Desktop/claude.ai/code) com a PRÓPRIA assinatura
   │ 4 Claude Code commita na branch designada e abre PR contra main
   ▼
 GitHub (ruleset main-protection: PR obrigatório, 3 checks, sem push direto/force-push)
```

Interação, sem execução autônoma:

| Passo | Componente | O que acontece | O que NÃO acontece |
|---|---|---|---|
| 1 | Coordenador + Tarefas | PO pede uma ordem para uma tarefa ativa atribuída a `claude-code`. | Agente não cria a própria ordem. |
| 2 | Política + Aprovações + Gateway | `requestScope` (canal `assisted`, `externalSharing: true`) cria um pedido por ação (`agent.invoke` e `data.send_external`); o PO aprova vendo a apresentação completa; `activateScope` consome as aprovações. | Nenhum TTL muda; nenhuma aprovação é reutilizada. |
| 3 | Gateway | `prepareHandoff` monta e cifra o pacote; `releaseHandoff` (step-up, dentro da validade do escopo) o mostra ao PO. | O ACC não envia nada a um provedor. |
| 4 | — (fora do ACC) | PO usa o Claude Code. | O ACC não vê, não controla e não garante esse ambiente. |
| 5 | Gateway | PO informa `owner/repo#N` (step-up, dentro da janela de retorno). | Texto livre do agente não é aceito como resultado. |
| 6–7 | Verificador | Lê o PR e compara com a ordem (§6). | Nenhuma escrita no GitHub. |
| 8 | Coordenador | Mostra o resultado e as divergências. | Nenhum merge, nenhuma aprovação de merge implícita. |

**Reutilização sem duplicação.** A ordem é um `GatewayHandoff`; o escopo é um `GatewayScope`; a persistência é o ledger assinado `acc-gateway:v1`; o pacote é um conteúdo `package` em `sealedBlobs`. As peças novas são o **verificador de PR**, um **tipo de resultado** "referência de PR" e um **histórico de verificações** somente de acréscimo no mesmo ledger (§5.2, §10).

## 3. Ordem de trabalho (B)

Contrato conceitual. Campos marcados **(gateway)** já existem em `GatewayScope`/`GatewayHandoff`; **(novo)** precisa de contrato no PR 2.

| Campo | Origem | Regra |
|---|---|---|
| `orderId` | `GatewayHandoff.id` (gateway) | Gerado pelo servidor. |
| `idempotencyKey` | (gateway) | Mesmo pedido → mesma ordem; pedido diferente com a mesma chave → `conflict`. |
| `ownerId`, `projectId`, `taskId` | (gateway) | Tarefa ativa do projeto do dono; isolamento por projeto. |
| `agentId` | (gateway) | Sempre `claude-code`; a tarefa precisa estar atribuída a ele (invariante da #020). |
| `scopeId` | (gateway) | Escopo `active`, canal `assisted`, `externalSharing: true`. |
| `capability` | (novo valor) | `code.change` (proposta, D-08.2). As capacidades atuais (`text.review`, `text.draft`, `text.summarize`, `code.plan`) não descrevem alteração de código. |
| `repository` | (novo) | `owner/repo` **vinculado ao projeto** (#004) e contido na allowlist do servidor (#002). Nunca escolhido pelo agente. |
| `baseSha` | (novo) | SHA de `main` lido pelo servidor no momento da preparação (40 hex). |
| `workBranch` | (novo) | Gerada pelo servidor: `agent/claude-code/<taskId curto>-<orderId curto>`; nunca `main`, nunca escolhida pelo chamador. Mesma ideia de `SandboxSpec.git.workBranch` (#021). |
| `objective` | (novo) | Texto curto da pessoa (≤ 4 KiB, `GATEWAY_LIMITS.maxInstructionBytes`), tratado como **dado**. |
| `instructions` | (novo, fixo) | Bloco **gerado pelo servidor**, não editável: trabalhar só em `workBranch` a partir de `baseSha`; abrir PR contra `main`; não fazer merge; não alterar `.github/workflows`; não incluir segredos; o conteúdo entre marcadores é dado não confiável. |
| `acceptanceCriteria` | (novo) | Lista curta (≤ 20 itens) da pessoa, tratada como dado. |
| `constraints` | (novo, fixo) | Restrições de segurança repetidas em formato legível (§7). |
| `dataRefs` | `inputs` (gateway) | Só referências autorizadas no escopo (`issue`/`pull_request`/`task`), resolvidas pelo servidor, ≤ 16 KiB cada, marcadas `untrusted`. |
| `approvals` | `GatewayScope.approvals` (gateway) | Ids, digests e aprovador das aprovações consumidas; `validUntil` do escopo. Só **ids e digests** vão no pacote, nunca grants ou recibos. |
| `packageDigest` | (gateway) | SHA-256 do pacote cifrado; exibido para o PO conferir. |
| `relayDeadline` | (gateway) | Prazo para informar o PR (hoje 24 h; ver D-08.5). |

**Proibido na ordem:** credenciais, tokens, cookies, conteúdo de `.env`, dados de outros projetos, conteúdo de arquivos do repositório (o Claude Code lê o repositório por conta própria; a ordem leva só referências), qualquer instrução que amplie escopo. O `secretScan` do gateway roda no pacote antes de cifrar; achado → recusa (`secret_detected`).

**Tamanho:** o pacote completo respeita `maxPackageBytes` (128 KiB).

## 4. Aprovações (C)

Reutiliza, sem alterar, as regras da #011 e a §16.2 da #028.

| Ação | Classe (#011) | TTL do grant | O que autoriza |
|---|---|---|---|
| `agent.invoke` | `execution` | 60 min | Que o Claude Code seja o agente da tarefa nesse escopo (capacidade, repositório, branch, base). |
| `data.send_external` | `publication` | 15 min | Que o pacote (objetivo, critérios, referências resolvidas) seja entregue à pessoa para envio à Anthropic. |

- **Identidade:** aprovador = humano autenticado (sessão #003); agente nunca aprova (#020). Liberar o pacote e informar o PR exigem **confirmação de identidade recente** (step-up, 5 min), como em `releaseHandoff`/`relayResult`.
- **Escopo de uso:** uma ordem por escopo por padrão (`maxInvocations: 1`, proposta); repositório, branch, base e capacidade entram na **apresentação** (`gateway.scope` ampliada no PR 2) e no `paramsDigest`; qualquer mudança → nova aprovação.
- **Validade:** efetiva = mínimo entre a pedida e a das aprovações → no canal assistido, **até 15 min para liberar o pacote**. A janela de retorno (24 h) começa na liberação e **não** renova nenhuma autorização. Nenhum TTL muda.
- **Revogação:** `revokeScope` (step-up), kill switch e barreira encerram a ordem (`cancelled`); um PR informado depois disso é recusado.
- **Reinício:** um escopo ativo vence em época nova (`restart_closed`, R1 da #028); ordem ainda não liberada vence junto.
- **Auditoria:** eventos `gateway.*` no histórico assinado; aprovações nos eventos da #011.

**Autorização × admissão (#022).** São camadas diferentes e cumulativas:

| | Autorização (#011 + #020) | Admissão (#022) |
|---|---|---|
| Pergunta | "A pessoa permitiu esta ação, com estes parâmetros?" | "Há capacidade, orçamento, quota e nenhum kill switch agora?" |
| Quando | Na ativação do escopo e a cada uso | A cada item da fila |
| Quem decide | PO (humano) | Controlador (regras), com aprovação própria por item (R3 da #028) |
| Na #008 | Exigida (duas aprovações) | Só se a verificação virar item de fila (D-08.4). Sem item de fila, o controlador ainda é consultado para barreira/kill switch e para o perfil `claude-code/subscription_assisted`. |

## 5. Estados (D)

A máquina pedida é uma **projeção**. Ela combina os estados que o gateway já persiste (`GatewayHandoff`, **sem nenhuma mudança** em `HANDOFF_TRANSITIONS`) com um **histórico de verificações** acrescentado ao mesmo ledger assinado (§5.2). Não há segundo ledger e nenhum estado terminal do handoff é reaberto (R1).

### 5.1 Projeção

| Estado da ordem | Base persistida | Entra quando |
|---|---|---|
| `prepared` | `handoff.prepared` | Pacote montado, cifrado, sem segredos; escopo `active`. |
| `delivered` | `handoff.awaiting_relay` | PO liberou o pacote (step-up, dentro da validade). |
| `awaiting_pr` | `handoff.awaiting_relay` + marca `forwardedAt` | PO declarou que encaminhou ao Claude Code (opcional; ver D-08.6). |
| `pr_linked` | `handoff.validated` (referência aceita) **e** nenhuma verificação `conforming` válida para o `headSha` atual | PO informou `owner/repo#N` (step-up, na janela) e a referência passou na validação estrutural (§5.3). |
| `verified` | `handoff.validated` **e** a verificação mais recente é `conforming` **para o `headSha` observado nessa mesma leitura** | Todas as regras de §6 passaram para um `headSha` fixo. |
| `rejected` | `handoff.rejected` (referência recusada) **ou** encerramento `nonconforming` no histórico | Referência inválida, ou falha eliminatória de §6 (V1–V5, V7). |
| `expired` | `handoff.expired` | Não liberado na validade; sem PR na janela; reinício antes da liberação. |
| `cancelled` | `handoff.revoked` **ou** encerramento `cancelled` no histórico | Revogação, kill switch, barreira, tarefa desatribuída ou cancelada. |

O handoff percorre só o caminho já existente: `prepared → awaiting_relay → relayed → validated` (ou `rejected`/`expired`/`revoked`). Aqui, `validated` significa **"referência de PR aceita e vinculada à ordem"** (repositório e número fixados). Não significa "PR conforme". A conformidade nunca é guardada no estado do handoff: ela fica no histórico de verificações, versionada por `headSha`.

### 5.2 Histórico de verificações versionado por `headSha` (R1)

Novo conjunto **somente de acréscimo** no ledger do gateway (`acc-gateway:v1`), validado por `documents.ts`, com entradas imutáveis:

| Campo | Regra |
|---|---|
| `id`, `orderId`, `seq` | `seq` cresce 1 a 1 por ordem; lacuna ou repetição → ledger recusado (fail-closed). |
| `headSha` | Cabeça do PR lida no início **e** confirmada no fim da verificação (V12). |
| `baseSha` | O da ordem (imutável). |
| `verdict` | `conforming`, `needs_review` ou `nonconforming`. |
| `rules` | Código e resultado de cada regra V1–V13 (sem conteúdo do PR). |
| `evidence` | Digests das respostas normalizadas (GraphQL e comparação de ancestralidade, §6.4). |
| `supersedes` | `id` da verificação anterior da mesma ordem, se houver. |
| `checkedAt`, `checkedBy` | Relógio do servidor; pessoa autenticada que pediu a verificação. |

Regras:

1. **Conformidade vale para um `headSha`.** A ordem só é `verified` quando a verificação mais recente é `conforming` **e** o `headSha` dela é igual ao `headRefOid` lido na consulta que está sendo exibida. A interface sempre mostra o `headSha` a que o resultado se refere.
2. **Novo push invalida a conformidade anterior.** Se uma leitura encontra `headRefOid` diferente do da última verificação, a conformidade anterior **deixa de valer** na hora (projeção volta a `pr_linked`, com o motivo `head_changed`). A nova verificação é registrada com `supersedes` apontando para a anterior. **Nada é apagado nem reescrito**: o histórico completo continua auditável.
3. **Sem reativar escopo nem reutilizar aprovação.** Verificar é uma **leitura do próprio ACC**. Não chama `activateScope`, não consome, não cria e não reaproveita aprovação; o escopo pode estar vencido há muito tempo. Continua exigindo sessão autenticada, política (categoria `observe` da pessoa), barreira e kill switch. Verificar nunca autoriza merge, nem cria vínculo com a classe `merge` da #011.
4. **Encerramento.** Uma falha eliminatória grava uma entrada `nonconforming` **final** (`closes: true`). Revogação ou kill switch depois do vínculo grava uma entrada final `cancelled`. Depois de uma entrada final, nenhuma verificação nova é aceita (`order_closed`), e um novo trabalho exige **nova ordem** com novas aprovações.
5. **Limites.** No máximo 50 verificações por ordem e uma a cada 30 s por ordem (propostas). Acima do teto, a ordem fica `pr_linked` com `needs_review` (`verification_limit`), sem apagar nada.
6. **Auditoria.** Cada entrada gera um evento no histórico assinado do gateway (`gateway.pr_verified`, `gateway.pr_verification_superseded`, `gateway.order_closed`) e no espelho da #006, quando houver ligação.

### 5.3 Transições

```
prepared ──► delivered ──► awaiting_pr ──► pr_linked ◄──────────────┐
   │            │                 │            │   ▲                 │
   │            └─────────────────┼──────────► │   │ head_changed /  │
   │                              │            ▼   │ needs_review     │
   ├─► expired / cancelled        │         verified ────────────────┘
   │                              │            │
   └──────────────────────────────┴─► rejected / cancelled (finais)
```

- `delivered → pr_linked` direto é válido (`awaiting_pr` é opcional).
- `pr_linked ⇄ verified` são mudanças **da projeção**, conforme o histórico de §5.2. O handoff continua `validated`, terminal e sem alteração.
- Validação estrutural da referência (no `relayResult`, antes de `validated`): formato `owner/repo#N`; repositório = `ordem.repository`; número positivo; ordem sem PR vinculado; janela de retorno aberta; escopo não revogado; step-up. Falha → `handoff.rejected`.
- Estados finais: `rejected`, `expired`, `cancelled`.

**Erros** (taxonomia do gateway + novos): `not_found`, `conflict`, `scope_invalid`, `capability_unavailable`, `secret_detected`, `relay_window_closed`, `step_up_required`, `pr_reference_invalid`, `repository_not_allowed`, `order_closed`, `verification_limit`, `head_changed`, `ancestry_unproven`, `github_unavailable` (rede, 5xx ou rate limit: não muda o estado, não grava verificação; tentar depois), `github_unauthorized`, `pr_nonconforming`.

**Reinício.** `prepared` → `expired` (o escopo vence na época nova, R1 da #028). `delivered`/`awaiting_pr` sobrevivem (o pacote já saiu, e o retorno é permitido na janela, como na #028). `pr_linked`/`verified`: o histórico é persistido, e a verificação é uma **leitura pura**, que pode ser refeita. Uma verificação interrompida no meio não grava entrada.

**Idempotência.** Preparar: `idempotencyKey`. Informar PR: mesma referência → no-op; referência diferente depois de uma vinculada → `conflict` (um PR por ordem). Verificar: se o `headSha` e o resultado forem iguais aos da última entrada, a verificação só atualiza o "visto em" exibido e não cria entrada nova. Se mudar qualquer um dos dois, cria uma entrada nova com `supersedes`.

## 6. Verificação do PR (E)

### 6.1 Princípios

- **Somente leitura.** O PR 2 inclui:
  - um novo documento GraphQL de consulta na allowlist `APPROVED_DOCUMENTS` (#002). `isReadOnlyDocument` continua recusando mutation e subscription;
  - **um único** endpoint REST `GET` de comparação (§6.4), com caminho e parâmetros fechados.

  Nenhuma outra chamada REST é aceita.
- **Credencial:** a do servidor (#002: fine-grained read-only; `gh-cli` só local). O ACC não usa credencial do Claude Code nem do PO além dessa.
- **Resposta não confiável:** validada por esquema fechado (como `normalize.ts`). Campo ausente ou inesperado → `needs_review`, nunca "ok".
- **Checks verdes ≠ aprovação de merge.** O resultado mostra o estado dos checks, mas o merge continua sendo decisão do PO, com a regra da #011. Pela §16 da #011, a classe `merge` hoje nem é aprovável para merge com SHA.
- **Sem prova, sem conformidade.** Qualquer regra cuja prova não puder ser obtida por completo resulta em `needs_review`, nunca em `conforming`.

### 6.2 Regras

| # | Verificação | Fonte | Falha → |
|---|---|---|---|
| V1 | Repositório = `ordem.repository` (owner/name e id do nó estável) | GraphQL `repository { id nameWithOwner }` | `nonconforming` |
| V2 | PR existe e é desse repositório | GraphQL `pullRequest(number)` | `nonconforming` (`pr_reference_invalid`) |
| V3 | Branch de origem = `ordem.workBranch` | `headRefName` | `nonconforming` |
| V4 | Não é de fork | `isCrossRepository == false`, `headRepository.id == repository.id` | `nonconforming` |
| V5 | Base = `main` | `baseRefName` | `nonconforming` |
| V6 | `ordem.baseSha` é **ancestral** de `headSha` | REST compare `baseSha...headSha` (§6.4) | sem relação comprovada (`diverged`, `behind`, `identical`) → `nonconforming`; prova indisponível ou incompleta → `needs_review` (`ancestry_unproven`) |
| V7 | Aberto e não mesclado | `state == OPEN`, `merged == false`, `mergedAt == null` | mesclado → `nonconforming` + alerta (merge fora do fluxo); fechado → `nonconforming` |
| V8 | Quantidade de commits | `commits { totalCount }` e `ahead_by` da comparação | divergência entre as duas ou mais de 250 → `needs_review` |
| V9 | Proveniência declarada dos commits | `commits(first: 100)`: autor/committer (login GitHub), `signature { isValid }` | Só **informativo**. O ACC não consegue provar que o Claude Code criou os commits. Mais de 100 → exibe só os primeiros 100, com aviso. |
| V10 | Nenhum arquivo em caminhos proibidos | `files(first: 100) { totalCount nodes { path } }`, paginado até 3 páginas | `.github/workflows/**`, `.githooks/**` ou arquivos de segredo → `needs_review`; mais de 300 arquivos (lista incompleta) → `needs_review` |
| V11 | Checks do `headSha` | `commits(last:1).commit.statusCheckRollup { state contexts }` | pendentes → `needs_review`; falhos → `needs_review` (mostra quais) |
| V12 | Integridade da leitura | `headRefOid` no início e de novo no fim; `oid` do último commit = `headRefOid` | mudou → descarta a leitura, não grava verificação (`head_changed`) e pede repetição |
| V13 | Estado atual | `isDraft`, `mergeable`, `reviewDecision` | só informativo |

### 6.3 Resultado

- `conforming`: V1–V8, V10 e V11 comprovadas e ok, com todos os checks `SUCCESS` → projeção `verified` **para aquele `headSha`**.
- `needs_review`: nenhuma regra eliminatória falhou, mas há pendência ou falta de prova → projeção `pr_linked`, com a lista de pendências. Exemplos: V6 sem prova, V8, V10, V11 pendente ou falho, campo inesperado.
- `nonconforming`: falha eliminatória comprovada (V1–V7) → entrada final, projeção `rejected`. Um novo PR exige **nova ordem**, com nova aprovação.

O registro de verificação guarda só o que está em §5.2. Nenhum corpo de PR, diff, conteúdo de arquivo ou lista de arquivos é guardado; os caminhos proibidos encontrados são guardados só como códigos.

### 6.4 Ancestralidade do SHA base (V6, R2)

**Relação exigida.** `baseSha` (o `main` lido pelo servidor na preparação) precisa ser **ancestral** de `headSha` (a cabeça atual do PR), e o PR precisa ter pelo menos um commit novo. Atualizar a branch a partir de uma `main` mais nova (merge ou rebase sobre descendentes de `baseSha`) mantém a relação. Uma branch criada a partir de outra base, não.

**Consultas oficiais avaliadas** (documentação lida em 2026-11-19; comportamento confirmado por leituras públicas do próprio repositório, sem custo, em `docs/evidence/issue008-pr1-sources.txt`, GH2–GH4):

| Opção | Base aceita | Serve como prova? | Uso |
|---|---|---|---|
| REST `GET /repos/{owner}/{repo}/compare/{baseSha}...{headSha}` [GH2] | SHA de commit ("You can compare refs (branches or tags) and commit SHAs in the same repository"). A descrição do parâmetro fala em "branch names", mas o teste com SHAs completos funcionou. | **Sim.** `status` (`ahead`/`behind`/`identical`/`diverged`), `ahead_by`, `behind_by`, `base_commit.sha`, `merge_base_commit.sha`. | **Principal.** |
| GraphQL `Ref.compare(headRef:)` → `Comparison { status aheadBy behindBy baseTarget headTarget }` [GH3, GH4] | A base é **o próprio `Ref`** (ex.: `refs/heads/main`), não um SHA arbitrário. Na prática, `headRef` aceitou um SHA. | Só se `baseTarget.oid == baseSha`, o que deixa de valer assim que a `main` avança. | Não usada como prova (insuficiente em geral). |
| GraphQL `Commit.history` / `Commit.parents` [GH3] | Percurso paginado a partir de `headSha` | Só prova positiva, se encontrar `baseSha` no limite de páginas. Não encontrar não prova nada. | Não incluída no PR 2 (custo e complexidade; D-08.10). |

**Critério de prova (todas as condições, na mesma resposta):**

1. HTTP 200 com corpo validado por esquema fechado.
2. `status == "ahead"`, `behind_by == 0` e `ahead_by >= 1`.
3. `base_commit.sha == baseSha` e `merge_base_commit.sha == baseSha` (40 hex, comparação exata).
4. O `headSha` comparado é o mesmo `headRefOid` lido antes **e depois** pela consulta GraphQL (V12).

Sem as quatro condições, não há prova. Como os SHAs são imutáveis, a comparação entre dois SHAs fixos não muda com pushes concorrentes. A concorrência real é a cabeça do PR mudar entre as leituras, e é por isso que a condição 4 existe.

**Limites e paginação.**
- A requisição usa `per_page=1`: o veredito vem de `status`/`ahead_by`/`behind_by`/`merge_base_commit`, que se referem à comparação inteira. A lista de commits (até 250 sem paginação) e a de arquivos (até 300, só na primeira página) **não** são usadas para V6 [GH2].
- V8 confronta `ahead_by` com `commits.totalCount` do PR. Uma diferença (ex.: commits de merge da `main`) não é falha, mas vira `needs_review` se for incoerente (`ahead_by == 0` com PR não vazio, ou vice-versa).

**Respostas e decisão:**

| Resposta | Decisão |
|---|---|
| 200 + critério completo | V6 ok |
| 200, `status` = `diverged` ou `behind` | `nonconforming` (relação exigida ausente, comprovadamente) |
| 200, `status` = `identical` | `nonconforming` (PR sem trabalho em relação à base) |
| 200, campo ausente, tipo errado ou SHAs que não conferem | `needs_review` (`ancestry_unproven`) |
| 404 (SHA desconhecido, ex.: force-push removeu a cabeça) ou 422 | `needs_review` (`ancestry_unproven`) |
| 401/403 | erro `github_unauthorized`; nenhuma verificação gravada |
| 5xx, timeout, rate limit, rede | erro `github_unavailable`; nenhuma verificação gravada; sem retry automático em laço |

**Permissão.** A página do endpoint não informa a permissão fine-grained exigida [GH2]. O token atual da #002 já tem `Contents: Read-only`; o PR 2 precisa confirmar em teste com o token real e documentar. Enquanto não houver confirmação, uma resposta 403 cai em `github_unauthorized`, nunca em conformidade.

**Allowlist REST.** O cliente aceita só `GET` com o caminho `/repos/{owner}/{repo}/compare/{40hex}...{40hex}` e só o parâmetro `per_page=1`. `owner/repo` vem da ordem (já na allowlist do servidor). Qualquer outro método, caminho ou parâmetro → recusa antes da rede, com teste estrutural.

## 7. Segurança (F)

| Tema | Regra |
|---|---|
| Isolamento entre projetos | Ordem, escopo, pacote e verificação presos a `ownerId`+`projectId`; repositório só entre os vinculados ao projeto; leitura de pacote por outro projeto → `not_found` (mesma regra de `sealedBlobs`). |
| Prompt injection | Texto de tarefa/issue/PR é `untrusted`, vai entre marcadores, nunca escolhe repositório, branch, capacidade, destino ou política. O bloco de instruções é fixo e gerado pelo servidor. A resposta do GitHub também é dado. O ACC **não** interpreta o conteúdo do PR como instrução. |
| Segredos | `secretScan` no pacote e na referência informada; nenhum segredo no ledger, nos logs ou na auditoria; nenhuma credencial do Claude Code passa pelo ACC [A4]. |
| Branch | `workBranch` gerada pelo servidor; verificação V3–V5. A ordem não pede nem permite escrita na `main`. |
| `main` | O ACC não escreve no GitHub. O ruleset `main-protection` (PR obrigatório, 3 checks, sem force-push/deleção, sem bypass) é a proteção do lado do servidor. |
| Identidade | Sessão #003 + step-up para liberar o pacote e informar o PR; aprovador humano autenticado. |
| Auditoria | Histórico assinado `gateway.*` (preparo, liberação, retorno, verificação, revogação); espelho em `/api/audit` (#006) no PR 2. |
| Revogação | Escopo, kill switch e barreira encerram a ordem e recusam retorno posterior. |
| Falhas | GitHub indisponível/rate limit → estado inalterado, erro explícito, sem retry automático em laço; resposta malformada → `needs_review`. Armazenamento degradado → recusa (fail-closed, como #028). |
| Retenção | Pacote cifrado: 30 dias por padrão (1–90), `sealedBlobs`; registros de verificação: só metadados e digests, no ledger. |
| Honestidade | O ACC **não afirma** que executou código, que o ambiente do Claude Code era isolado, que os commits vieram do Claude Code ou que o PR está pronto para merge. A interface mostra "executado fora do ACC pelo PO; não verificado pelo ACC" e "proveniência declarada". |

**Limite conhecido do ambiente do PO:** a documentação oficial diz que, no Windows nativo, o Claude Code roda comandos **sem sandbox**; o sandbox existe em macOS, Linux e WSL2 e vem desligado por padrão [A10]. Recomenda-se ao PO usar WSL2 com `sandbox.enabled` e `failIfUnavailable`, ou Claude Code na web — mas o ACC não verifica nem garante isso.

## 8. Custos e provedores (G)

Orçamento adicional: **R$ 0**. Nenhuma alternativa é ativada nesta issue.

| Alternativa | Autenticação | Termos (fonte oficial) | Custo | Situação |
|---|---|---|---|---|
| **1. Uso assistido pelo próprio assinante** (CLI, Desktop ou claude.ai/code) | Login da pessoa, feito no fluxo da Anthropic | Pro/Max/Ultra fazem login no Claude Code [A3]; OAuth é para "ordinary use" pelos assinantes [A4]. O ACC não coleta nem guarda credencial [A4]. | Incluído na assinatura; limites "ordinary, individual usage" [A4]. Valores dos limites: não comprovado. | **Escolhida para a #008** |
| **2. GitHub Actions oficial** (`anthropics/claude-code-action`) | `CLAUDE_CODE_OAUTH_TOKEN` (gerado por `claude setup-token`, ~1 ano) ou `ANTHROPIC_API_KEY`, como secret do GitHub [A8, A3] | Caminho documentado pela Anthropic; "runs use your Claude subscription instead of API billing" com OAuth [A8]. App oficial pede permissões amplas (inclui Workflows e Administration) [A8]. | Assinatura + minutos de Actions; runners padrão são gratuitos em repositório público [GH1]. | Futuro, autorização própria (D-08.8) |
| **3. Execução direta por API / Agent SDK** | Chave do Console | Developers com Agent SDK "should use API key authentication" [A4, A9]; Commercial Terms [A9]. Modo `--bare` não lê o token da assinatura [A7]. | Cobrança por uso [A2]. | **Bloqueado** (R$ 0) |
| **4. Sandbox cloud (#031)** | Credencial do usuário final | Produto hospedado exige Commercial Terms, binário não modificado e cada usuário com a própria credencial; sem pagar ou intermediar uso [A4]. | Infraestrutura + uso. | **Bloqueado** (#031, R$ 0) |

**Também bloqueado:** o servidor do ACC iniciar `claude -p` ou o Agent SDK com a assinatura do PO. As fontes oficiais não deixam claro se isso é "ordinary use" ou "routing through plan credentials" [A4, A9]; esclarecer exigiria contato com a Anthropic. Além disso, violaria o gate da #008 e `REAL_EXECUTION_ENABLED`.

**Consequência para o catálogo (#022):** o perfil relevante é `claude-code/subscription_assisted` (cobrança `included`). Liberá-lo — e **só ele**, só no canal assistido, só nos projetos habilitados — é decisão do PR 2 (D-08.3), com o mecanismo restrito de §10.7.

## 9. Dependências (H)

Estado em 2026-11-19 (`main` `5ac983a`): #003, #005, #006, #011, #012, #028 **fechadas**; #020, #021, #022, #031 **abertas** (o código de #020/#021/#022 está na `main`, mas as issues não foram encerradas). Nada foi alterado nessas issues.

| Categoria | Itens |
|---|---|
| **Bloqueantes para execução real** (o ACC executar o Claude Code) | Gate da #008: concluir #020, #021, #022; executor isolado real (#031); `REAL_EXECUTION_ENABLED` (PR próprio); orçamento > R$ 0 ou caminho de assinatura juridicamente claro; prova de origem do sandbox (resíduo da #012). |
| **Necessários para o modo assistido (PR 2)** | Ligar no servidor **só** o canal assistido do gateway (pendência 3 da #028); rotas e interface mínimas (pendência 4); `agent.invoke` e `data.send_external` aprováveis **só** para a combinação restrita de §10.7 (D-08.3); habilitação por projeto (D-08.11); capacidade `code.change`; resultado "referência de PR"; histórico de verificações (§5.2); documento GraphQL e endpoint REST de comparação somente leitura (§6.4); espelho de auditoria (pendência 8 da #028). |
| **Melhorias opcionais** | Marca `awaiting_pr`; janela de retorno própria; verificação periódica manual (botão "verificar de novo"); exibição de pendências por regra. |
| **Pendências futuras** | Alternativa 2 (Action); #031; validade limitada de escopos e rotação de chaves (#028); aprovação de admissão por item (R3 da #028); aprovação de merge com apresentação própria (#011). |

**Leitura do gate.** O gate da #008 bloqueia "qualquer execução de código" até concluir #020/#021/#022. No modo assistido o ACC não executa código; por isso ele **não** é bloqueado pelo gate — mas essa leitura é uma decisão do PO (D-08.1), não uma conclusão automática.

## 10. Plano do PR 2 (não autorizado)

### 10.1 Componentes

| Componente | Tipo | Observação |
|---|---|---|
| `server/gateway/service.ts` | reutilizado + extensão | Resultado do handoff do tipo `pr_reference` (validação estrutural antes de `validated`); verificação e encerramento da ordem. |
| `server/gateway/contracts.ts` / `documents.ts` | extensão | `code.change`; campos `repository`, `baseSha`, `workBranch`; conjunto **somente de acréscimo** `verifications` (§5.2). `HANDOFF_TRANSITIONS` **inalterado** (R1). |
| `shared/approvalPresentation.ts` | extensão | `gateway.scope` com repositório, base e branch (formato fechado). |
| `server/gateway/prVerification.ts` | **novo** | Regras V1–V13 e critério de ancestralidade (puras), sobre as respostas normalizadas. |
| `server/github/queries.ts` + `normalize.ts` | extensão | Um documento de consulta `PullRequestVerification` na allowlist; normalização estrita. |
| `server/github/client.ts` | extensão | Um único `GET` REST de comparação, com caminho e parâmetros fechados (§6.4). |
| `server/index.ts` | ligação mínima | Só canal `assisted`, só agente `claude-code`; nenhum adaptador registrado em produção (os simulados só nos testes). |
| `server/http` | rotas novas | Ver 10.2. |
| `src/features/…` | interface mínima | Ver 10.3. |
| `server/policy/*`, `server/limits/providers.ts`, `shared/contracts.ts`, projetos (#004) | decisão D-08.3/D-08.11 | Liberação restrita de §10.7. |

### 10.2 Rotas mínimas (todas sob sessão #003, POST com CSRF antes da autenticação, política antes de cada ação)

| Método | Rota | Função |
|---|---|---|
| POST | `/api/projects/:id/tasks/:taskId/claude-orders` | Pedir escopo + ordem (cria os pedidos de aprovação). |
| POST | `/api/claude-orders/:orderId/release` | Liberar o pacote (step-up). Resposta: pacote em texto, uma vez por liberação. |
| POST | `/api/claude-orders/:orderId/forwarded` | Marca opcional `awaiting_pr`. |
| POST | `/api/claude-orders/:orderId/pr` | Informar `owner/repo#N` (step-up). |
| POST | `/api/claude-orders/:orderId/verify` | Verificar de novo (leitura no GitHub). |
| POST | `/api/claude-orders/:orderId/cancel` | Cancelar (revoga o escopo; step-up). |
| GET | `/api/projects/:id/claude-orders` | Listar ordens e resultados (sem conteúdo do pacote). |

Sem PUT/PATCH/DELETE (padrão do projeto). Nenhuma rota escreve no GitHub, inicia processo ou chama provedor.

### 10.3 Interface mínima

Na página da tarefa: botão "Preparar ordem para Claude Code"; formulário (objetivo, critérios, referências); estado da ordem; botão "Copiar pacote" após liberação; campo "PR gerado"; quadro da verificação com cada regra (ok / pendente / falha), checks e o aviso fixo "executado fora do ACC; checks verdes não autorizam merge".

### 10.4 Testes

- **Fluxo:** pedido → aprovações → ativação → preparo → liberação → PR → `verified`, com GitHub falso (fixture).
- **Aprovação:** sem aprovação, pendente, rejeitada, vencida, forjada, de outro componente, reutilizada → recusa; TTLs inalterados (teste comparando com a #011).
- **Verificação:** um teste por regra V1–V13, incluindo fork, branch errada, base errada, PR mesclado, fechado, arquivo em `.github/workflows`, checks pendentes/falhos, resposta malformada, `headSha` mudando no meio, novo push depois de `verified`.
- **Ancestralidade (§6.4):** `ahead` com SHAs conferindo → ok; `diverged`, `behind`, `identical` → `nonconforming`; `merge_base_commit` ≠ `baseSha`, campo ausente, 404, 422 → `needs_review`; 401/403/5xx/timeout → erro sem gravação; caminho ou parâmetro REST fora da allowlist → recusado antes da rede.
- **Histórico (§5.2):** novo push invalida a conformidade anterior; entrada nova com `supersedes`; nada apagado; `seq` com lacuna → ledger recusado; verificação depois de entrada final → `order_closed`; verificação não consome nem cria aprovação e não reativa escopo vencido; `HANDOFF_TRANSITIONS` idêntico ao da #028 (teste comparando).
- **Estados:** todas as transições válidas e inválidas; idempotência de preparo, vínculo e verificação; reinício em cada estado.
- **Segurança:** isolamento entre projetos; prompt injection no objetivo, nas referências e no título do PR; segredo no pacote e na referência; step-up exigido; kill switch e revogação no meio; CSRF; agente tentando aprovar ou ampliar escopo.
- **Estruturais (security.test.ts):** nenhum `child_process`/`spawn`/`exec` no caminho da #008; nenhum documento GraphQL com mutation; nenhuma rota de escrita no GitHub; `REAL_EXECUTION_ENABLED` continua `false`; nenhuma variável de ambiente nova de provedor; nenhum import de `claude`/`@anthropic-ai/*`.

### 10.5 Critérios de aceite do PR 2

1. Todo o fluxo acima funciona sem nenhuma chamada a provedor e sem escrita no GitHub (provado por teste estrutural).
2. Cada ordem exige `agent.invoke` + `data.send_external` aprovados pelo PO; nenhum TTL alterado.
3. Verificação reproduz V1–V13. Ela nunca marca `verified` com checks não verdes, com campo inesperado, sem prova completa de ancestralidade (§6.4) ou para um `headSha` diferente do atual (§5.2).
4. `HANDOFF_TRANSITIONS` e os TTLs da #011 continuam idênticos. Só a combinação restrita de §10.7 fica disponível.
5. A interface nunca afirma execução, isolamento ou proveniência que o ACC não comprovou.
6. Lint, tipos, build, testes e os 3 checks da CI verdes; varredura de segredos limpa.
7. Relatório, evidências e revisão independente; merge só com autorização do PO.

### 10.6 Rollback

- **Desligar sem deploy:** kill switch/barreira (#022) recusam novas ordens e encerram as ativas; o perfil pode voltar a `unverified`.
- **Reverter:** PR de revert do merge (sem push direto na `main`); nenhuma migração destrutiva — o ledger do gateway é versionado e os registros novos são aditivos; conteúdos vencem pela retenção.
- **Dados:** nenhum dado do PR é guardado além de metadados; não há nada a limpar no GitHub, porque o ACC nunca escreveu lá.
- **Liberação:** remover a exceção de §10.7 (PR revisado) devolve `agent.invoke` e `data.send_external` a `UNAVAILABLE` em todos os caminhos; esvaziar a lista de projetos habilitados tem o mesmo efeito por projeto.

### 10.7 Disponibilidade e política: liberação restrita (R3)

**Problema.** Hoje a disponibilidade é **por ação e global**: `POLICY_ACTIONS[action].available` em `shared/contracts.ts`, conferida pelo motor da #020 (`server/policy/engine.ts`, decisão `UNAVAILABLE`). Trocar `available` para `true` em `agent.invoke` ou `data.send_external` liberaria essas ações para **qualquer** agente, projeto, canal ou componente futuro coberto pelas regras da política. Por isso essa troca **não** é proposta.

**Proposta para o PR 2 (depende de D-08.3 e D-08.11).**

1. **Flags globais inalteradas.** `agent.invoke` e `data.send_external` continuam `available: false` em `POLICY_ACTIONS`.
2. **Exceção fechada no código revisado.** Uma constante congelada (ex.: `ASSISTED_AVAILABILITY`) lista **exatamente duas** combinações. O motor só troca `UNAVAILABLE` por "disponível" quando **todos** os campos coincidem:

   | Campo | Valor exigido |
   |---|---|
   | `action` | `agent.invoke` ou `data.send_external` |
   | `subject` | `agent:claude-code` |
   | `channel` | `assisted` |
   | `mode` | `subscription_assisted` |
   | `capability` | `code.change` |
   | `component` | `gateway` |
   | `projectId` | contido na lista de projetos habilitados (item 4) |

   Os fatos (`channel`, `mode`, `capability`, `component`, `projectId`) vêm do servidor (escopo e ordem), **nunca** do cliente ou do agente. Fato ausente → `UNAVAILABLE`. A exceção **não** dispensa nenhuma regra: a política continua `require_approval` (regra A4 e a classe `publication` da #011), com atribuição obrigatória, e ação crítica continua exigindo aprovação explícita.
3. **Catálogo (#022).** Só o perfil `claude-code/subscription_assisted` passa de `unverified` para `available`. Os outros 11 perfis continuam `unverified`. `metered_api` continua recusado (`paid_usage_unavailable`), e Nemotron continua bloqueado.
4. **Projetos.** Habilitação **por projeto**, desligada por padrão: o PO habilita um projeto (que precisa ter repositório vinculado) com uma operação de **configuração** (classe `configuration` da #011, 15 min, step-up), registrada na auditoria. Desabilitar é imediato e encerra as ordens abertas do projeto (entrada final `cancelled`).
5. **Canais e agentes.** O canal `simulated` não é ligado em produção. ChatGPT, Gemini e Nemotron continuam sem combinação liberada. Nenhum adaptador é registrado no servidor: o canal assistido não chama adaptador, só prepara o pacote e recebe a referência.
6. **Invariantes que não mudam:**
   - `REAL_EXECUTION_ENABLED = false as const`;
   - nenhum `child_process`, nenhuma rede a provedor, nenhuma credencial de provedor, nenhuma API paga;
   - nenhuma execução automática: o ACC nunca inicia o Claude Code, nem por fila, nem por agendamento, nem por workflow.
7. **Versão da política.** A mudança troca a versão da política (ex.: `2026-11-2x.1`), o que invalida pedidos pendentes da versão anterior (comportamento atual da #020/#028).
8. **Testes obrigatórios no PR 2:**
   - matriz completa (ação × agente × canal × modo × capacidade × componente × projeto), em que **só** as duas combinações com projeto habilitado ficam disponíveis;
   - fato ausente ou forjado pelo cliente → `UNAVAILABLE`;
   - catálogo com exatamente um perfil `available`;
   - `POLICY_ACTIONS` com `available: false` para as duas ações (teste estrutural);
   - nenhuma outra rota ou componente consegue usar a exceção;
   - desabilitar o projeto encerra as ordens.

**Mudanças futuras.** Qualquer alteração posterior do catálogo, das flags de `POLICY_ACTIONS`, da exceção, da lista de projetos habilitados por código ou das regras da política (outro agente, outro canal, `metered_api`, execução real) exige **autorização específica do PO, PR próprio, testes próprios e revisão independente**. Esta especificação não autoriza nenhuma delas.

## 11. Decisões pendentes do PO

| Id | Decisão | Recomendação |
|---|---|---|
| D-08.1 | O modo assistido (ACC não executa) pode avançar antes de encerrar #020/#021/#022? | Sim: o gate trata de execução de código pelo ACC. |
| D-08.2 | Nova capacidade `code.change` para a ordem. | Sim, só para `claude-code` no canal `assisted`. |
| D-08.3 | No PR 2, liberar **só** o fluxo assistido do Claude Code pela exceção fechada de §10.7: flags globais continuam `false`, um único perfil do catálogo passa a `available`, `REAL_EXECUTION_ENABLED` inalterado. | Sim, com a matriz de testes de §10.7. Qualquer mudança posterior exige nova autorização e testes próprios. |
| D-08.4 | Verificação do PR: item da fila (admissão #022 + aprovação por item, R3) ou leitura direta do servidor, fora da fila? | Leitura direta: é uma consulta do próprio ACC, sem agente e sem custo; ainda passa por política, barreira e kill switch. |
| D-08.5 | Janela para informar o PR: manter 24 h do gateway ou janela própria (ex.: 7 dias)? | Manter 24 h no PR 2; ampliar só se o uso mostrar necessidade. |
| D-08.6 | Manter o estado `awaiting_pr` (marca opcional) ou fundir com `delivered`? | Manter como marca opcional, sem persistência própria. |
| D-08.7 | Conformidade versionada por `headSha` em histórico somente de acréscimo (§5.2), **sem** alterar `HANDOFF_TRANSITIONS`: novo push invalida a conformidade anterior e exige nova verificação, sem reativar escopo nem reutilizar aprovação. | Sim. Limites propostos: 50 verificações por ordem, intervalo mínimo de 30 s. |
| D-08.8 | Estudar a alternativa 2 (GitHub Action com a assinatura) como passo seguinte. | Só depois do PR 2, com app próprio de permissões mínimas, `workflow_dispatch` disparado pelo PO e alteração de workflow revisada. |
| D-08.9 | Registrar qual plano da assinatura o PO usa. | Sim, só o nome do plano, para documentar os limites esperados. |
| D-08.10 | Ancestralidade (V6): só o REST compare como prova, ou acrescentar o percurso paginado de `Commit.history` como segunda prova positiva? | Só o REST compare. Sem prova → `needs_review`. |
| D-08.11 | Habilitação por projeto (desligada por padrão, operação de configuração com aprovação e step-up). | Sim. |

## 12. Registro de fontes

Consultadas em **2026-11-19**, leitura direta (D) das páginas oficiais. Citações e conclusões em `docs/evidence/issue008-pr1-sources.txt`. A1–A6 da #028 continuam valendo; abaixo, as relidas ou novas.

| Id | Fonte | Tipo |
|---|---|---|
| A2 | https://platform.claude.com/docs/en/about-claude/pricing (da #028, não relida) | D (2026-11-18) |
| A3 | https://code.claude.com/docs/en/iam | D |
| A4 | https://code.claude.com/docs/en/legal-and-compliance | D |
| A7 | https://code.claude.com/docs/en/headless | D |
| A8 | https://code.claude.com/docs/en/github-actions | D |
| A9 | https://code.claude.com/docs/en/agent-sdk/overview | D |
| A10 | https://code.claude.com/docs/en/sandboxing | D |
| GH1 | https://docs.github.com/en/billing/concepts/product-billing/github-actions | D |
| GH2 | https://docs.github.com/en/rest/commits/commits#compare-two-commits | D |
| GH3 | https://docs.github.com/en/graphql/reference/commits (`Comparison`, `ComparisonStatus`, `Commit.history`) | D |
| GH4 | https://docs.github.com/en/graphql/reference/git (`Ref.compare`, `Ref.target`) | D |

## 13. Implementação (PR 2) — diferenças em relação a esta especificação

Registro das diferenças, cada uma pela alternativa mais segura compatível com a especificação (detalhes no relatório do PR 2):

| Item | Especificação | Implementado | Motivo |
|---|---|---|---|
| Rota de liberação | `POST /api/claude-orders/:orderId/release` | `POST /api/claude-orders/:orderId/package` | O teste estrutural do servidor proíbe `release` em rotas POST (N9 da #011). A recusa foi mantida, não contornada. `/release` responde 405. |
| Estado inicial | `prepared` | `awaiting_approval` antes de `prepared` | Antes das aprovações não existe handoff: o escopo espera as duas aprovações. Projeção, sem persistência paralela. |
| Documentos GraphQL | um documento novo | dois: `PullRequestVerification` e `MainHead` | O SHA base precisa ser lido pelo servidor na preparação (`refs/heads/main`), antes de existir PR. Ambos são `query`, na allowlist. |
| Referências de dados | `issue`/`pull_request`/`task` | só `task` do mesmo projeto | Em produção o servidor só sabe resolver tarefas (não lê corpo de issue/PR). Recusa explícita (400) em vez de falha na liberação. |
| Formato inválido do PR | `handoff.rejected` | 400, sem mudar o estado | Um erro de digitação não encerra a ordem. Repositório diferente do da ordem continua rejeitando o handoff, como especificado. |
| Rejeição de aprovação | ordem recusada | nada liberado nem consumido; o gateway volta a pedir (pedido novo, pendente) | Comportamento existente da #028 (inalterado). O PO pode cancelar a ordem. |
| Leitura "atual" (R1) | conformidade vale para a leitura exibida | `verified` só com leitura da mesma cabeça há até 5 min, neste processo | A listagem não consulta o GitHub; sem leitura recente, a conformidade aparece desatualizada. |
| Barreira global inicial | — | bloqueia a criação de ordens em instalação nova (423) | Controle da #011 (N9) mantido. A habilitação por projeto (configuração) funciona. A liberação da barreira continua sem rota. |

