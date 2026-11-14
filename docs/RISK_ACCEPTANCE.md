# Registro de riscos aceitos — AI Command Center

## RISK-001 — GHSA-g3hv-75wg-m249 (`minimatch`), somente dependências de desenvolvimento

| Campo | Registro |
| --- | --- |
| Advisory | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): DoS por amplificação de *globparts* em `minimatch` |
| Severidade | Moderada |
| Versões afetadas | `minimatch >= 7.0.0, < 11.0.1` (primeira corrigida: `11.0.1`; não há correção na linha 10.x) |
| Versão instalada | `minimatch@10.2.6` (uma única cópia, deduplicada) |
| Caminhos de dependência | `eslint@10.14.0 → minimatch@10.2.6`; `eslint@10.14.0 → @eslint/config-array@0.23.5 → minimatch`; `typescript-eslint@8.72.2 → @typescript-eslint/typescript-estree@8.72.2 → minimatch` |
| Achados do `npm audit` | 9 moderados, todos derivados desse único advisory (`eslint`, `@eslint/config-array`, 6 pacotes `@typescript-eslint/*`/`typescript-eslint` e o próprio `minimatch`) |
| `npm audit --omit=dev` | **0 vulnerabilidades** (13/11/2026) |
| Exposição | Só desenvolvimento local e CI (lint). Nada entra no bundle do navegador nem no servidor da API. Os padrões glob vêm da configuração versionada do próprio projeto (`eslint.config.js`), não de entrada externa |
| Controles existentes | Dependências de execução isentas (`--omit=dev` limpo); CI sem segredos, `permissions: contents: read`, actions fixadas por SHA; revisão de PR para qualquer mudança em `eslint.config.js`; Dependabot alerts ativado (13/11/2026) |
| Justificativa | Não havia correção compatível: `npm audit fix --force` rebaixaria `typescript-eslint` para 8.36.0 (mudança incompatível) e um `overrides` forçaria `minimatch` 11 fora da faixa declarada pelos mantenedores. Impacto real: no pior caso, lentidão do lint com padrão malicioso que só um colaborador com escrita poderia inserir |
| O que **não** foi feito | `npm audit fix --force`, rebaixamento do ESLint, `overrides` de `minimatch`, qualquer edição de relatórios para ocultar o achado |
| Decisão | Aceitação temporária aprovada pelo Product Owner (Issue #003) |
| Responsável | Product Owner (Moreirapontocom-br), com apoio do implementador para a reavaliação |
| Registrado em | 13/11/2026 |
| **Revisão obrigatória** | **13/12/2026** |

### Fato novo identificado em 13/11/2026 (não aplicado)

- `eslint@10.15.0` foi publicado e depende de `minimatch ^11.0.5` (corrigido). Um `npm audit fix` **sem** `--force` atualizaria o ESLint dentro da faixa `^10.14.0` e eliminaria os caminhos via `eslint` e `@eslint/config-array`.
- `typescript-eslint@8.72.2` (última versão publicada) ainda exige `minimatch ^10`; portanto o advisory **continua presente** mesmo após essa atualização.
- Não foi aplicado porque a decisão aprovada para esta issue é a aceitação documentada, sem alterar dependências. Recomenda-se decidir em issue própria.

### Roteiro da revisão de 13/12/2026

1. `npm outdated eslint typescript-eslint @eslint/config-array` e `npm view typescript-eslint dependencies` / `npm view @typescript-eslint/typescript-estree dependencies.minimatch`.
2. Se toda a cadeia já aceitar `minimatch >= 11.0.1`: atualizar em PR próprio (sem `--force`, sem `overrides`), rodar testes/lint/build e confirmar `npm audit` = 0. Encerrar este risco.
3. Se só parte aceitar: avaliar a atualização parcial (ex.: ESLint 10.15+) e decidir entre prorrogar a aceitação (nova data) ou aprovar `overrides` testado.
4. Confirmar sempre `npm audit --omit=dev` = 0 e consultar os alertas do Dependabot.
5. Registrar o resultado aqui, com data e decisão do PO.
