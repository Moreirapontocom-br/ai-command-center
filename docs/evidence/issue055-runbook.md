# Issue #055 — exercício operacional real da ponte MCP (roteiro)

> **Estado: NÃO EXECUTADO.** O exercício real exige autorização **separada** do PO, depois da revisão técnica do PR. Tudo acontece na máquina do PO, com a configuração local da #008 (`C:\ACC`) e a assinatura do próprio PO para o Claude Code. Custo: R$ 0. Nenhuma API paga e nenhuma credencial da Anthropic passa pelo ACC.
>
> **Ações humanas, só do PO:**
> - editar o `.env.local`;
> - login;
> - criar a credencial da ponte (senha);
> - aprovar a ordem;
> - disponibilizá-la (senha);
> - abrir a sessão do Claude Code e digitar `/mcp__acc__next`;
> - confirmar o PR proposto (senha).
>
> **Ações do Claude Code (sessão do PO):** só o que as ferramentas MCP permitem: receber a ordem, alterar a branch designada, abrir o PR de teste e propor o PR.

## 0. Código exato (obrigatório antes de qualquer passo)

```powershell
git fetch origin
git switch feature/055-mcp-bridge
git status --short                          # só os arquivos NÃO versionados do PO (??); nada modificado
git rev-parse HEAD                          # IGUAL ao SHA aprovado na revisão técnica
git rev-parse origin/feature/055-mcp-bridge # idem
git diff --quiet HEAD; $LASTEXITCODE        # 0
npm ci                                      # instala o SDK fixado (@modelcontextprotocol/server 2.4.0)
```

- **Interrompa** se o SHA for diferente, se houver arquivo versionado modificado ou se o `git diff` não der 0. Registre a divergência e peça nova revisão.
- Não use `git clean`, `git stash -u` nem `git checkout -- .`: os arquivos não versionados do PO precisam ser preservados.

## 1. Configuração (sobre a da #008)

Partimos da configuração local que já funcionou na #008 (`docs/evidence/issue008-e2e.md` §1): `C:\ACC`, aprovações, gateway, `gh-cli` e barreira inicial já liberada. Com o **Bloco de Notas**, acrescente ao `.env.local`:

```
ACC_DEPLOYMENT=local
ACC_BRIDGE_ENABLED=true
```

Suba o servidor pela receita de `docs/GITHUB_INTEGRATION.md` (variável `GITHUB_TOKEN` vazia). Confira no log:

- `Ponte MCP local LIGADA (somente loopback; exige credencial criada pelo PO).` (`event: bridge_enabled`);
- **nenhum** `bridge_requires_gateway`.

## 2. Credencial da ponte

1. Painel → tarefa atribuída ao Claude Code → **Ordens para Claude Code**. O projeto já está habilitado (#008).
2. Seção **Ponte MCP local** → validade **1 dia** (suficiente para o exercício) → senha → **Criar credencial**.
3. Copie o comando exibido (uma única vez) e rode-o no **PowerShell, na pasta do repositório**:
   ```
   claude mcp add --transport http --scope local acc http://127.0.0.1:<porta>/mcp --header "Authorization: Bearer <token>"
   ```
4. Confira com `claude mcp list`: deve aparecer `acc: … (HTTP) - ✔ Connected`. **Não** use `claude mcp get acc` em tela compartilhada, porque ele mostra o token.
5. Confirme que nenhum arquivo do repositório mudou (`git status --short`: nenhum `.mcp.json`).

## 3. Caso A — fluxo completo pela ponte (conforme)

| Passo | Quem | Ação | Esperado |
|---|---|---|---|
| A1 | PO | Criar a ordem (objetivo e critérios simples, por exemplo um arquivo de teste em `docs/`) e aprovar `agent.invoke` + `data.send_external` | `Aguardando aprovações` → aprovações `approved` |
| A2 | PO | **Disponibilizar ao Claude Code** (senha) | Painel: "Disponibilizada ao Claude Code… aguardando o recebimento". O pacote NÃO aparece no navegador. |
| A3 | PO | Abrir o Claude Code no repositório e digitar `/mcp__acc__next` (em até ~15 min de A2, a validade do escopo) | O Claude Code chama `acc_list_orders` e `acc_claim_order`; o painel mostra "recebida em …" e o estado `Encaminhado — aguardando PR` |
| A4 | Claude Code | Trabalhar na branch designada, abrir o PR contra `main` e chamar `acc_report_pr` | Painel: "PR proposto: owner/repo#N (aguardando sua confirmação)". O PR **não** está vinculado. |
| A5 | PO | **Confirmar o PR proposto e verificar** (senha) | Vínculo + verificação na mesma ação. Com os checks verdes: `Verificado para o HEAD lido` e o HEAD exibido. |
| A6 | Claude Code | `acc_get_order_status` | `state: verified`, `verification.headSha` = HEAD do PR |

## 4. Caso B — recusas de segurança (sem efeito na ordem)

| Passo | Ação | Esperado |
|---|---|---|
| B1 | Com a ordem do caso A já disponibilizada, tentar **Liberar pacote** pela contingência manual (se aparecer) ou pela API | Recusado (`order_conflict`); nenhum pacote no navegador |
| B2 | No PowerShell, sem token: `Invoke-WebRequest -Method Post -Uri http://127.0.0.1:<porta>/mcp -ContentType application/json -Body '{}'` | 401 |
| B3 | Mesmo pedido com `-Headers @{ Origin = 'http://localhost:5173' }` | 403 |
| B4 | **Revogar a credencial da ponte** (senha) e pedir ao Claude Code `acc_get_order_status` | O Claude Code recebe falha de autenticação (401); a auditoria registra `claude_bridge.access` |
| B5 | Criar outra credencial (o comando novo substitui o registro: antes, `claude mcp remove acc -s local`) | `✔ Connected` de novo |

## 5. Encerramento e limpeza

1. Fechar o PR de teste **sem merge** e excluir a branch dele (como no PR #54 da #008).
2. Revogar a credencial usada (senha). Depois, `claude mcp remove acc -s local` na pasta do repositório.
3. Opcional: `ACC_BRIDGE_ENABLED=false` no `.env.local`.
4. Parar o servidor. No Windows, se o processo `node` filho continuar vivo, encerre-o pela porta (`Get-NetTCPConnection -LocalPort <porta>` → `Stop-Process`).

## 6. Evidências a registrar (sem token, senha nem pacote)

- SHA executado (§0) e versões: `claude --version`, `node -v`.
- Saída de `claude mcp list`, só a linha `acc`.
- Ids da ordem, da credencial (não o token), do recebimento e da proposta; número do PR de teste.
- Resultado da verificação: veredito, HEAD e regras com `pending`/`fail`.
- Eventos da auditoria (#006):
  - `claude_bridge.credential` (`created`/`revoked`);
  - `claude_order.offered`, `claude_order.claimed` (ator `agent:claude-code`), `claude_order.pr_proposed` e `claude_order.pr_confirmed`;
  - `claude_bridge.access` (recusas).
- Varredura antes de registrar: `node scripts/check-secrets.mjs tracked` e `git grep -nE "accb_[A-Za-z0-9_-]{43}"` sem resultado (o prefixo aparece no código; um token real, nunca).
