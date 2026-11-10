# Relatório de implementação — Issue #001

**Branch:** `feature/001-project-setup` · **Base:** `main` (commit vazio `chore: initialize repository`)
**Data:** 2026-11-10 · **Ambiente:** Windows 11, Node 24.18.1, npm 11.16.0

## Critérios de aceite

| Critério | Status | Evidência |
| --- | --- | --- |
| A aplicação inicia e executa o build | ✅ | `npm run dev` respondeu HTTP 200; `npm run build` concluído (`tsc -b` + `vite build`) |
| Testes automatizados passam | ✅ | 10/10 testes em 3 arquivos (`docs/evidence/vitest-output.txt`) |
| Lint sem erros | ✅ | `npm run lint`: 0 erros, 0 avisos |
| Interface funciona em desktop e mobile | ✅ | Capturas em 1440px e 390px (`docs/evidence/*.png`); gaveta mobile coberta por teste |
| Dados demonstrativos identificados como fictícios | ✅ | Aviso em todas as páginas, selo "Modo demonstração", prefixo `[Fictício]` (com teste) |
| Nenhuma credencial ou chave de API | ✅ | Varredura por `api_key`, `secret`, `token`, `password`, `sk-…`, `AIza…` sem ocorrências no código |
| Alterações apenas na branch da issue | ✅ | Nenhum commit de código na `main` |
| Nenhum merge sem aprovação | ✅ | PR aberto, sem merge |

## Saída do build

```
dist/index.html                   0.47 kB │ gzip:  0.30 kB
dist/assets/index-*.css          14.70 kB │ gzip:  3.88 kB
dist/assets/index-*.js          228.07 kB │ gzip: 71.37 kB
✓ built in ~200ms
```

## Cobertura dos testes

- `taskUtils.test.ts`: contagem por status (incluindo lista vazia) e tarefas abertas por agente.
- `TaskList.test.tsx`: renderização de título, agente, prioridade e status; estado vazio.
- `App.test.tsx`: página inicial e aviso fictício; os três agentes; navegação pela sidebar com `aria-current`; prefixo `[Fictício]`; abrir e fechar o menu mobile.

## Problemas encontrados durante a implementação

1. **Selo de status esticado no mobile:** detectado na captura de tela a 390px e corrigido (`self-start`).
2. **Captura mobile no Chrome headless:** a largura mínima da janela distorce o resultado; a verificação foi refeita dentro de um iframe de 390px.

## Pendências e riscos

- **`npm audit`: aviso moderado** (GHSA-g3hv-75wg-m249, `minimatch`): ver a análise detalhada na seção Review 01.
- **Versões muito recentes:** TypeScript 6, ESLint 10, Vite 8 e Vitest 5 funcionam juntos hoje, mas vale fixá-las caso surjam regressões.
- **Navegação sem URL:** a navegação por estado não preserva a seção ao recarregar nem tem deep links. Uma biblioteca de rotas depende de aprovação.
- **Proteção da `main`:** o repositório é privado no GitHub Free, e a API responde 403 ("Upgrade to GitHub Pro or make this repository public"). A regra de não alterar a `main` depende da disciplina do processo.

---

# Review 01: correções do PR #1

Commit revisado: `90d86a7`. Não houve commits novos entre a revisão e o início das correções.

## Correção 1: acessibilidade do menu mobile

| Requisito | Implementação |
| --- | --- |
| Nome acessível coerente com o estado | `aria-label` alterna entre "Abrir menu" e "Fechar menu"; `aria-expanded` e `aria-controls` mantidos |
| Escape fecha | Ouvinte de `keydown` no `document`, ativo só com a gaveta aberta |
| Foco volta ao botão | Efeito em `AppLayout` dispara sempre que o estado passa de aberto para fechado |
| Foco gerenciado na gaveta modal | `role="dialog"` com `aria-modal`; foco inicial no botão "Fechar menu"; ciclo de Tab e Shift+Tab; fundo com `inert` |
| Navegação e responsividade preservadas | Sem mudança no desktop; a gaveta fecha ao navegar e ao redimensionar para desktop |

**Defeitos adicionais encontrados e corrigidos:**
- Com a gaveta fechada no mobile, os botões da sidebar, fora da tela, continuavam acessíveis pelo Tab. Agora a gaveta fechada fica `invisible`.
- Na primeira versão da correção, um teste em navegador real mostrou que o foco inicial falhava: com a transição de `visibility`, a gaveta continuava `hidden` no primeiro quadro. Agora a visibilidade só é animada ao fechar.

## Correção 2: integração contínua

`.github/workflows/ci.yml`:
- **Disparo:** `pull_request` para a `main` e `workflow_dispatch`.
- **Etapas:** `npm ci`, `npm test`, `npm run lint` e `npm run build`.
- **Node:** matriz 22.x e 24.x, alinhada a `engines`.
- **Segurança:** `permissions: contents: read`, actions fixadas por SHA (checkout v7.0.1, setup-node v7.1.0), `persist-credentials: false`, nenhum segredo.

## Correção 3: dependências e segurança (GHSA-g3hv-75wg-m249)

| Item | Resultado |
| --- | --- |
| Pacote e faixa afetada | `minimatch` `>= 7.0.0, < 11.0.1` (severidade média; DoS por amplificação de globparts; publicado em 2026-10-30) |
| Primeira versão corrigida | `11.0.1`. Não existe versão corrigida na linha 10.x: a última é 10.2.6, a versão instalada |
| Quem introduz | `eslint@10.14.0` (`minimatch ^10.2.6`), `@eslint/config-array@0.23.5` (`^10.2.4`) e `@typescript-eslint/typescript-estree@8.72.2` (`^10.2.2`). Todos já estão na versão mais recente publicada |
| Correção compatível pela semver | **Não existe.** Todos os dependentes exigem `^10`, e `npm audit` só oferece rebaixar para `eslint@9.39.5` e `typescript-eslint@8.36.0` (`--force`, mudança incompatível): **não aplicado** |
| Exposição real | Só no ambiente de desenvolvimento e no CI; não entra no bundle. Os padrões glob processados vêm da configuração do próprio projeto, não de entrada externa |
| Alternativa testada (não aplicada) | `overrides: { "minimatch": "^11.0.1" }` numa cópia isolada: `npm audit` = 0 vulnerabilidades; lint, testes e build OK; o ESLint continua ignorando `dist/` e detectando erros em `src/`. **Não aplicado**, porque força uma versão maior fora da faixa declarada pelos mantenedores do ESLint e depende de aprovação |

**Recomendação:** abrir uma issue futura para (a) aplicar o `overrides` acima, se aprovado, ou (b) aguardar o ESLint e o `typescript-eslint` aceitarem `minimatch` 11 e então atualizar, removendo qualquer override.

## Correção 4: testes

Novos testes em `src/components/layout/AppLayout.test.tsx` (10 casos):
- nome acessível e `aria-expanded`;
- ausência de diálogo com a gaveta fechada;
- foco inicial na gaveta;
- Escape com retorno de foco;
- botão interno com retorno de foco;
- overlay com retorno de foco;
- ciclo de Tab e Shift+Tab;
- `inert` no fundo só com a gaveta aberta;
- navegação pela gaveta;
- fechamento ao mudar para o layout desktop.

O teste existente do menu em `App.test.tsx` passou a validar também a navegação.

Para confirmar que os testes novos detectam falhas, eles foram executados contra os componentes do commit `90d86a7`: **9 de 10 falharam**. O único que passou verifica uma ausência que já era verdadeira antes.

O jsdom não aplica CSS nem `inert` de forma real. Por isso, os mesmos comportamentos também foram verificados no Chrome 157 via DevTools Protocol, com 13 de 13 checks aprovados (`docs/evidence/browser-a11y-check.txt` e `docs/evidence/drawer-open-mobile-390.png`). O script usado não faz parte do repositório.

Resultado local: **20 de 20 testes** em 4 arquivos (`docs/evidence/vitest-output.txt`), lint sem erros nem avisos, e build concluído.
