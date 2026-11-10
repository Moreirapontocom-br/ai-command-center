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

- **`npm audit`: aviso moderado** (GHSA-g3hv-75wg-m249, `minimatch`) herdado de `eslint`/`typescript-eslint`. Afeta só o ambiente de desenvolvimento e não entra no bundle. O `audit fix --force` rebaixaria o ESLint para a v9 (mudança incompatível), então não foi aplicado.
- **Versões muito recentes:** TypeScript 6, ESLint 10, Vite 8 e Vitest 5 funcionam juntos hoje, mas vale fixá-las caso surjam regressões.
- **Navegação sem URL:** a navegação por estado não preserva a seção ao recarregar nem tem deep links. Uma biblioteca de rotas depende de aprovação.
- **Teste visual da gaveta mobile aberta:** foi validado por teste automatizado (atributos ARIA), sem captura de tela.
- **Proteção da `main`:** depende da configuração do repositório remoto (ver PR).
