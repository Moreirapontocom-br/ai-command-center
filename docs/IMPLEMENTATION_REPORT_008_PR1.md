# Issue #008 — PR 1: Especificação da integração supervisionada com Claude Code (relatório)

> **PR exclusivamente documental.** Nenhum código, contrato, política, catálogo, workflow ou frontend alterado.
> Merge **não** autorizado. PR 2 **não** iniciado. Nenhuma integração real, credencial, gasto ou chamada a provedor.

| Item | Valor |
|---|---|
| Base | `origin/main` `5ac983abaeb80418da6113a98f6346c75f118ffc` (merge do PR #48) |
| Branch | `feature/008-claude-assisted-spec` |
| Execução real | `REAL_EXECUTION_ENABLED = false` (inalterado) |
| Gateway | dormente, sem rotas (inalterado) |
| Catálogo de provedores | todos `unverified` (inalterado) |
| Custo | R$ 0 |

## 1. Verificação inicial

- `git fetch`; `origin/main` = `5ac983a…` (igual à referência); PR #48 é ancestral.
- Nenhum arquivo versionado modificado. Três arquivos **não versionados** preexistentes não foram tocados nem incluídos.
- Lidas as issues #008, #011, #012, #020, #021, #022, #028 e #031, e os contratos de `server/gateway`, `server/approvals`, `server/github`, `server/sandbox` e `shared/approvalPresentation.ts`.

## 2. Arquivos

| Arquivo | Conteúdo |
|---|---|
| `docs/CLAUDE_CODE_ASSISTED.md` | Especificação: arquitetura (A), ordem de trabalho (B), aprovações (C), estados (D), verificação do PR (E), segurança (F), custos e provedores (G), dependências (H), plano do PR 2 e decisões D-08.1–D-08.9. |
| `docs/evidence/issue008-pr1-sources.txt` | Fontes oficiais lidas em 2026-11-19, com citações e conclusões. |
| `docs/evidence/issue008-pr1-checks.txt` | Verificações locais. |
| `docs/AGENT_GATEWAY.md` | Uma linha em §3.4 apontando para a nova especificação. |

## 3. Arquitetura (resumo)

A ordem de trabalho **é** um handoff do canal `assisted` do gateway (#028): mesmo escopo (`GatewayScope`), mesmo ledger assinado, mesmo pacote cifrado (`sealedBlobs`), mesmas aprovações (`agent.invoke` + `data.send_external`, TTLs da #011 inalterados). O PO executa o Claude Code fora do ACC, com a própria assinatura. O resultado deixa de ser um texto colado e passa a ser uma **referência de PR**, que um verificador novo confere por leitura no GitHub (regras V1–V13). Os estados pedidos (`prepared → delivered → awaiting_pr → pr_linked → verified`, mais `rejected`/`expired`/`cancelled`) são uma projeção dos estados do handoff, sem persistência paralela. O ACC nunca escreve no GitHub e nunca faz merge.

## 4. Principais conclusões das fontes (2026-11-19)

- Uso do Claude Code pelo próprio assinante (Pro/Max/Ultra): permitido; o ACC não pode coletar nem intermediar credenciais.
- Agent SDK / modo `--bare` / servidor acionando o Claude Code: orientação oficial é chave de API → custo → bloqueado; com assinatura, não esclarecido → bloqueado.
- GitHub Action oficial aceita token da assinatura; runners padrão são gratuitos em repositório público. Fica como alternativa futura (D-08.8), fora deste escopo.
- No Windows nativo o Claude Code roda comandos sem sandbox: o ACC não pode afirmar isolamento.

## 5. Dependências

#003, #005, #006, #011, #012, #028 fechadas. #020, #021, #022, #031 abertas e não alteradas. Execução real continua bloqueada (gate da #008, #031, `REAL_EXECUTION_ENABLED`, R$ 0). O modo assistido depende da leitura do gate pelo PO (D-08.1).

## 6. Verificações

Ver `docs/evidence/issue008-pr1-checks.txt`: lint e build ok; varreduras de segredos limpas; testes 1210/1211 localmente, com a única falha sendo a conhecida `scripts/main-audit.test.mjs` (CRLF no Windows, workflow inalterado). Resultado da CI registrado no PR.

## 7. Revisão complementar (R1–R3), sobre `f9b9d1f`

| Item | Correção | Onde |
|---|---|---|
| R1 — verificado e novos pushes | A proposta de alterar `HANDOFF_TRANSITIONS` foi retirada. O handoff só chega a `validated`, que passa a significar "referência aceita", e é terminal como antes. A conformidade fica num **histórico de verificações somente de acréscimo**, versionado por `headSha` (`seq`, `supersedes`, digests das evidências). Um novo push invalida a conformidade anterior e exige nova verificação. Verificar é leitura do ACC: não reativa escopo, não consome nem reutiliza aprovação. Falha eliminatória ou revogação grava uma entrada final (`order_closed`). Nada é apagado. | `CLAUDE_CODE_ASSISTED.md` §5 (5.1–5.3), D-08.7, §10.1, §10.4, §10.5 |
| R2 — ancestralidade do SHA | V6 reescrita com critério de prova completo: REST compare `baseSha...headSha` com `status=ahead`, `behind_by=0`, `ahead_by≥1`, `base_commit` = `merge_base_commit` = `baseSha` e `headSha` confirmado antes e depois (V12). `Ref.compare` (GraphQL) foi descartado como prova, porque a base é um ref. A seção documenta limites (250 commits, 300 arquivos, `per_page`), paginação, concorrência, respostas incompletas, 404/422/401/403/5xx e a permissão não documentada. Regra geral: sem prova → `needs_review`, nunca `conforming`. Confirmado por 7 leituras públicas, sem custo. | §6.1–6.4, D-08.10, evidências GH2–GH4 |
| R3 — disponibilidade e política | D-08.3 reescrita. As flags globais de `agent.invoke` e `data.send_external` continuam `false`. Uma exceção fechada no código revisado cobre só ação × `agent:claude-code` × `assisted` × `subscription_assisted` × `code.change` × `gateway` × projeto habilitado, com fatos vindos do servidor. A política continua `require_approval`. Um único perfil do catálogo fica `available`. A habilitação é por projeto (D-08.11). O canal `simulated` não é ligado em produção. `REAL_EXECUTION_ENABLED` continua `false` e não há execução automática. Mudanças futuras exigem autorização e testes próprios. | §10.7, D-08.3, D-08.11, §8, §9 |

## 8. Fora deste PR

Implementação (PR 2), rotas, ativação do gateway, mudança de catálogo/política, workflow, credenciais, merge e outras issues.
