# Issue #028 — PR 1: Agent Gateway Specification (relatório de implementação)

> **PR exclusivamente documental.** Nenhum código, política, contrato, catálogo, workflow ou frontend alterado.
> Merge **não** autorizado. PR 2 **não** iniciado. Nenhuma integração real, credencial, gasto ou chamada de API.

| Item | Valor |
|---|---|
| Base | `origin/main` `f25aa492434c60f56424f23ac5d3e1efe3ddfde2` (merge do PR #46) |
| Branch | `feature/028-gateway-spec` |
| Decisões aplicadas | D1–D9 (aprovadas pelo PO) |
| Execução real | `REAL_EXECUTION_ENABLED = false` (inalterado) |
| Catálogo de provedores | todos os perfis `unverified` (inalterado) |
| Custo | R$ 0 |

## 1. Verificação inicial

- `git fetch`; `origin/main` = `f25aa49…` (igual ao SHA esperado).
- Árvore de trabalho: nenhum arquivo versionado modificado. Dois arquivos **não versionados** preexistentes (`docs/evidence/issue002-review-validation.txt`, `documenta_o_t_cnica_initial_issue_001.md`) **não** foram tocados nem incluídos.
- Branch criada com `git switch -c feature/028-gateway-spec origin/main` + `git branch --unset-upstream`.

## 2. Arquivos (somente os quatro autorizados)

| Arquivo | Conteúdo |
|---|---|
| `docs/AGENT_GATEWAY.md` | Especificação: objetivo e limites, princípios, matriz dos 4 provedores × 3 modos, contratos `AgentTaskRequest`/`AgentTaskResult`, taxonomia de erros, autorização, credenciais e isolamento, fluxo assistido, fila e executores, persistência, auditoria, I1–I9, plano de testes, D1–D9, auditoria D8, fontes. |
| `docs/IMPLEMENTATION_REPORT_028_PR1.md` | Este relatório. |
| `docs/evidence/issue028-pr1-sources.txt` | Registro de cada fonte: URL, data, método (D/B), citações curtas e conclusão. |
| `docs/evidence/issue028-pr1-checks.txt` | Comandos e resultados das verificações. |

## 3. Pesquisa

- 24 identificadores de fonte, todos em domínios oficiais dos provedores, consultados em 2026-11-18.
- 16 fontes lidas diretamente (D); 8 com conteúdo obtido do resultado de busca restrita ao domínio oficial (B), porque `openai.com` e `help.openai.com` retornaram HTTP 403 para leitura direta ou a página não foi aberta. Fontes (B) têm confiança média e devem ser relidas antes de qualquer ativação (pendência P7).
- Os termos do trial da NVIDIA (PDF) foram lidos extraindo o texto localmente, com um script no diretório temporário da sessão (fora do repositório).
- Fóruns apareceram nas buscas e foram **rejeitados** como prova; itens que dependiam só deles ficaram "não comprovado".

## 4. Resumo da matriz

| Provedor | `subscription_assisted` | `official_integration` | `metered_api` |
|---|---|---|---|
| ChatGPT | Assistido manual (automação da interface proibida pelos termos) | não comprovado → bloqueado | Bloqueado (R$ 0); tier Free condicionado a geografia, não presumido |
| Claude | Assistido manual (o ACC não pode usar nem guardar credenciais de assinatura) | Claude Code hospedado exige Commercial Terms → decisão da #008/#031 | Bloqueado (R$ 0); sem camada gratuita comprovada |
| Gemini | Assistido manual (assinatura não inclui API; revisão humana no app) | não comprovado → bloqueado | Bloqueado (R$ 0); tier Free **proibido** para dados privados (termos) |
| Nemotron | Não aplicável (sem assinatura) | Bloqueado | Trial proibido para dados de projetos (não produção; conteúdo usado para treinar); opcional |

Nenhum perfil mudou de status: todos continuam `unverified`.

## 5. Critérios da Issue #028 cobertos por este PR

| Critério | Cobertura no PR 1 |
|---|---|
| Matriz comprovada de acesso, autenticação, quotas, termos, custos e retenção | §3 da especificação + registro de fontes (lacunas marcadas "não comprovado") |
| Contrato comum de entrada/saída, proveniência, capacidades, timeout e erros | §4–§5 (especificado; implementação no PR 2) |
| Fluxo assistido explícito | §8 (especificado; núcleo no PR 2/3) |
| Testes de indisponibilidade, limite gratuito, falhas; sem acesso cruzado a credenciais | §13 (lista nominal; implementação no PR 2) |
| Nemotron opcional | §3.6, §5 |

## 6. Incompatibilidades e auditoria D8

- **I1** (aprovação por tarefa × uso único da #011) e **I4** (espera humana × vagas da fila) ficam **pendentes de decisão técnica antes do PR 2**. I2, I3 e I5–I9 estão registradas com proposta (§12 da especificação). Nenhuma foi resolvida no código.
- **#020**: núcleo atendido; pendente: políticas por projeto e verificação antes do envio externo. **Mantida aberta.**
- **#022**: parcial; pendentes: alertas ao usuário, retry/backoff configuráveis e persistência dos limites. **Mantida aberta.**

## 7. Verificações

Detalhes em `docs/evidence/issue028-pr1-checks.txt`.

| Verificação | Resultado |
|---|---|
| Diff contra `origin/main` | Só os 4 arquivos de `docs/` |
| Código, políticas, contratos, catálogo, workflows | Inalterados (diff vazio fora de `docs/`) |
| Varredura de segredos (`tracked`, `history`, `staged`, `commits`, `dist/`) | Nenhuma credencial |
| ESLint | 0 problemas |
| TypeScript (`tsc -p tsconfig.server.json`) + build | ok |
| CSP do build | ok |
| Testes | 1156 de 1157; a única falha é `scripts/main-audit.test.mjs`, **falha local conhecida e preexistente** no Windows (`core.autocrlf=true` faz o checkout dos workflows com CRLF; nenhum workflow alterado; passa na CI Linux, mesma situação registrada nos relatórios 012 PR1/PR2) |
| Conferência documental | 24 IDs com registro e linha na tabela de fontes; D1–D9 e I1–I9 presentes |

## 8. Riscos residuais

- A matriz reflete 2026-11-18; termos e preços mudam (revisão a cada 90 dias, P8).
- Fontes (B) não foram lidas diretamente (P7).
- Interpretação de A4 (Claude Code com a credencial do próprio PO) não está resolvida (P4).
- Áreas não pesquisadas ficaram "não comprovado" (P6): Vertex AI, integrações oficiais da OpenAI, assinatura NVIDIA, localização de dados e LGPD.

## 9. Conclusão

O PR 1 entrega a especificação e a matriz comprovada na data, sem alterar o sistema. O PR 2 depende das decisões sobre I1 e I4 e de nova autorização do PO. Pronto para revisão independente; **não** pronto para merge sem a aprovação explícita do PO.
