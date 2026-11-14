# Issue #021: sandboxes e isolamento (camada preparatória)

Branch `feature/021-sandbox-isolation`, criada a partir da `main` em `079a8618c9d824e05631db5cfafd038833e7a747` (merge do PR #40, com CI e Main audit verdes).

**Execução real: DESABILITADA.** Nenhum código de usuário ou de agente é executado. Nada de Docker foi instalado e nenhum serviço de nuvem foi contratado.

## 1. O que foi implementado (`server/sandbox/`)

| Arquivo | Conteúdo |
| --- | --- |
| `contracts.ts` | Contratos tipados: solicitação, especificação, registro, os 7 estados (`requested`, `authorized`, `running`, `completed`, `cancelled`, `expired`, `failed`), as transições, os escopos de credencial e os limites. Também define `REAL_EXECUTION_ENABLED = false as const`: não há configuração por ambiente, e mudar isso exige PR |
| `validation.ts` | Validação estrita, com tudo negado salvo o previsto. Cobre ids, repositório e SHA, branch de trabalho, workspace lógico, rede, credenciais, limites e entradas externas |
| `provider.ts` | Interface abstrata `SandboxProvider` (`prepare`, `start`, `stop`, `destroy`). Cada provedor declara o isolamento que oferece (`simulated`, `container`, `microvm` ou `managed`) e se executa código |
| `simulatedProvider.ts` | Adaptador **simulado**, só para testes: guarda chamadas em memória e injeta falhas. **Não é uma sandbox**: não executa nada nem isola nada |
| `service.ts` | Ciclo de vida: solicitar → autorizar → iniciar → resultado, com cancelamento, expiração e descarte |

Regras do serviço:

- **Política da #020 em cada solicitação e autorização.** A ação avaliada é `sandbox.execute`, o sujeito é o agente, o recurso é a tarefa e o alvo é o SHA base mais a branch de trabalho.
  - No catálogo real a capacidade está **indisponível**, então o resultado é `UNAVAILABLE` e nada é criado.
  - Com um catálogo de teste, a política padrão exige aprovação. Uma `ApprovalGrant` exata autoriza, e o serviço registra o consumo (uso único).
  - A invariante da #020 vale aqui: agente sem a tarefa atribuída é sempre negado.
- **Isolamento lógico:**
  - cada registro pertence a dono, projeto, tarefa e agente; operar com outro dono ou projeto responde `not_found`;
  - tarefa concluída ou cancelada não abre sandbox;
  - o repositório precisa estar vinculado ao projeto.
- **Valores derivados pelo servidor, nunca escolhidos pelo chamador:**
  - workspace `ws-<id>`, exclusivo e sem acesso a caminhos do host (`hostPathAccess: 'none'`);
  - branch de trabalho `acc/<agente>/<tarefa>-<execução>`, com `mainWritable: false` e qualquer branch protegida recusada (`main`, `master`, `HEAD`…);
  - rede `default: 'deny'`;
  - credenciais apenas por **escopo** (`repo.read`, `repo.write_work_branch`), com validade igual ao tempo limite e `productionSecrets`/`productionDatabase` marcados como `denied`.
- **Pedidos recusados na validação:**
  - rede: host com curinga, porta ou URL; IPs, incluindo `169.254.169.254`; `localhost`; hosts de metadados;
  - credenciais: escopos de segredos ou de produção;
  - limites acima de 30 min, 2 CPU, 4 GiB de RAM ou 10 GiB de disco;
  - campos extras, como uma branch escolhida, um caminho do host ou um comando.
- **Entradas externas:** referências a issues, PRs e tarefas são sempre marcadas `untrusted`. Elas não alteram política, branch, rede nem limites, e texto livre não é aceito como referência.
- **Prazos e falhas:**
  - a solicitação expira se não for autorizada em 1 h, e a execução expira no tempo limite;
  - `authorize()` e `start()` verificam o prazo antes de avançar, sem depender de `expireOverdue()`: o que venceu passa a `expired` (com descarte, se houver workspace), a operação é recusada com `expired` e a aprovação não é consumida. `start()` verifica de novo após o preparo e outra vez após `provider.start()`, antes de passar a `running`. Se a autorização venceu durante essa chamada, o registro passa a `expired`, o provedor é parado e o workspace é descartado, sem renovar o prazo;
  - `report()` verifica o tempo limite de execução antes de aceitar o resultado. Se ele venceu (inclusive no instante exato), o registro passa a `expired` com motivo `timeout`, o provedor é parado, o workspace é descartado e o resultado é recusado com `expired`. Resultado atrasado nunca sobrescreve um estado terminal;
  - **limitação:** a camada não interrompe uma chamada pendente ao provedor (`prepare`/`start`). A verificação ocorre quando a chamada retorna, e `cancel`/`expireOverdue` sobre o mesmo registro aguardam na fila até lá. Um provedor que nunca responda manteria o registro bloqueado. Tempo limite por chamada e interrupção forçada dependem do provedor real (#031) e não são garantidos aqui;
  - operações sobre o mesmo registro são serializadas (fila por id), então expiração, autorização, início, resultado e cancelamento não se intercalam durante chamadas ao provedor;
  - cancelar ou expirar para a execução e descarta o workspace;
  - falha do provedor leva a `failed`, com o código salvo apenas como token;
  - falha no descarte marca `cleanup: 'pending'`, sem fingir que limpou.
- **Sem segredos:** a mensagem do provedor nunca vai para registros nem logs, e as especificações só guardam nomes de escopo.
- **Sem API pública:** nenhuma rota HTTP usa o serviço, o que é verificado por teste estrutural. Atribuir uma tarefa a um agente continua sem iniciar nada.
- **Sem persistência:** os registros ficam em memória, porque não há execução a retomar. Persistência, filas e quotas ficam para #012 e #022.

## 2. Opções de isolamento comparadas

| Critério | Containers Docker (locais) | Sandbox gerenciada na nuvem (microVM) | GitHub Actions (runner efêmero) | Git worktree + processo | VM de nuvem por tarefa |
| --- | --- | --- | --- | --- | --- |
| Isolamento real | Médio: kernel compartilhado; melhora com rootless, seccomp, gVisor ou Kata | **Alto**: uma microVM por execução (classe Firecracker) | Alto: VM descartável por job | **Nenhum**: mesmo usuário, disco, rede e credenciais | Alto: hipervisor |
| Filesystem | Volume por execução, somente leitura fora dele | Disco próprio e descartável | Disco próprio e descartável | Acesso a todo o disco do usuário | Disco próprio |
| Rede | Pode ser negada por padrão (`--network none` ou egress filtrado) | Em geral com controle de egress (varia por fornecedor) | **Egress aberto** por padrão, difícil de restringir em runners hospedados | Rede do host | Firewall configurável |
| Credenciais | Injetadas por execução; risco de vazamento para o host | Injetadas por execução; descartadas com a VM | `GITHUB_TOKEN` com permissões por job, secrets em environments com revisores | Expõe todas as credenciais locais | Injetadas por execução (exige operação) |
| Claude Code e outros agentes | Compatível (CLI em Linux) | Compatível (CLI em Linux, modo headless) | Compatível, inclusive com a Action oficial do Claude Code | Compatível | Compatível |
| Cancelamento e descarte | Simples (`docker rm -f`) | Nativo (destruir a VM) | Cancelar o job; o runner é descartado | Manual, sem garantia | Destruir a VM (mais lento) |
| Custo fixo | Zero (Docker Engine é gratuito; Docker Desktop tem licença paga acima de certos portes) | Zero ou baixo (planos gratuitos ou créditos iniciais) | Zero | Zero | Zero no nível gratuito; depois, por hora |
| Custo variável (ordem de grandeza) | Máquina própria | Por segundo de uso: alguns centavos de US$ por vCPU-hora | Gratuito em repositório público; repositório privado tem cota mensal gratuita de minutos | — | Por hora de VM |
| Orçamento adicional zero | Sim, mas depende do notebook, contrariando a V2 | **Sim no início** (créditos e planos gratuitos), dentro de quotas | Sim | Sim | Sim, de forma limitada |
| Dependência externa | Nenhuma | Fornecedor da sandbox | GitHub; só serve para projetos com GitHub | Nenhuma | Provedor de nuvem |
| Observações | Bom para testar o adaptador localmente | Alvo natural da V2: nuvem, efêmera, isolada por tarefa | **Em repositório público, os logs são públicos**; não serve para dados privados nem para projetos sem GitHub | **Não é isolamento de segurança.** Separa diretórios de trabalho, nada mais | Mais operação, boot lento |

> **Valores de custo:** são ordens de grandeza conhecidas até a data deste relatório, **não verificados nesta sessão**. A #031 deve confirmar preços, limites e termos de uso de cada fornecedor antes de qualquer contratação. O custo dominante tende a ser o **uso de modelos** (API), tratado na #022, e não a sandbox. Assinatura não equivale a acesso por API (#026).

## 3. Recomendação técnica

1. **Alvo:** uma **sandbox gerenciada em nuvem baseada em microVM**, efêmera por execução, com controle de egress e injeção de credenciais temporárias, implementada como um novo `SandboxProvider`. A escolha do fornecedor fica para a #031: prova de conceito em plano gratuito, teste de isolamento entre projetos, de prompt injection e de custo máximo. Começa com **orçamento adicional zero**, dentro de créditos gratuitos e com quotas da #022.
2. **Docker local:** apenas para desenvolver e testar o adaptador. Não é o executor de produção, porque contraria a V2 (sem depender do notebook) e oferece isolamento mais fraco.
3. **GitHub Actions:** opção de custo zero **somente** para tarefas de código em repositórios GitHub **sem dados privados nos logs**, e com o egress aberto aceito explicitamente pelo PO. Não é recomendada como padrão.
4. **Git worktree:** pode organizar diretórios **dentro** de uma sandbox real, mas **nunca** é fronteira de segurança.

## 4. Garantias efetivas e garantias planejadas

| Garantia | Estado |
| --- | --- |
| Sem execução real; sem API que execute comandos | **Efetiva** (constante no código e teste estrutural) |
| Negação por padrão e política da #020 em toda solicitação e autorização | **Efetiva** no serviço |
| Isolamento **lógico** por dono, projeto, tarefa e agente; aprovação de uso único | **Efetiva** no serviço (em memória) |
| Branch dedicada derivada; main e branches protegidas recusadas | **Efetiva** na especificação. A escrita real depende do provedor; o ruleset da `main` já protege o GitHub |
| Validação de caminhos, rede, escopos e limites; entrada externa não confiável | **Efetiva** na validação |
| Logs e registros sem segredos | **Efetiva** no serviço (testada com token canário) |
| Workspace exclusivo sem acesso ao filesystem do host | **Planejada**: só descrita na especificação, depende do provedor real |
| Rede negada por padrão e egress só por allowlist | **Planejada**: depende do provedor real |
| Credenciais mínimas e temporárias; bloqueio de segredos e banco de produção | **Planejada**: exige um intermediário de credenciais e o provedor real |
| Descarte garantido, sem propagação entre projetos | **Planejada**: a simulação testa a lógica, não o isolamento |
| Quotas, orçamento e kill switch | **Planejada** (#022) |

## 5. Testes

- `server/sandbox/sandbox.test.ts`, 87 testes:
  - execução desabilitada: catálogo real dá `UNAVAILABLE` e o provedor nunca é chamado; provedor que executa código é recusado;
  - política da #020: aprovação exata, uso único e aprovações inválidas (SHA, tarefa, agente, autoaprovação, expirada); agente não atribuído; tarefa inativa;
  - isolamento entre donos e projetos e repositório não vinculado;
  - workspace e branch exclusivos, main nunca gravável, entrada não confiável;
  - 21 tipos de solicitação malformada (caminhos, comandos, branch escolhida, curingas, IP de metadados, localhost, escopos proibidos, limites);
  - branches protegidas e workspaces inválidos;
  - matriz de estados, fluxo completo, transições proibidas, cancelamento, expiração, falhas do provedor e descarte pendente;
  - ausência de segredos e cópias defensivas.
  - prazos (R1): `authorize`/`start` vencidos e no limite (1 ms antes), prazo da aprovação menor que a janela, prazo que vence durante o preparo, e concorrência (dois `start`, `cancel` durante o preparo, `expireOverdue` contra `start`/`authorize`, `authorize` × `cancel`);
  - rodada final: `report` 1 ms antes, no instante e depois do vencimento (`completed` e `failed`), resultado atrasado após `expireOverdue`, `report` × `expireOverdue` × `cancel`; vencimento durante `provider.start()` (sem renovar o prazo), retorno 1 ms antes do prazo, e `cancel`/`expireOverdue` concorrentes durante `provider.start()`.
- `server/security.test.ts`: `server/sandbox` não usa `child_process`, `fs`, rede, `vm`, `worker_threads`, `eval` nem `Function`. Nenhum código fora do módulo usa o serviço, e não há rota de execução.

## 6. Decisões que precisam do Product Owner

1. **Executor:** aprovar a classe de executor recomendada (sandbox gerenciada em microVM) e autorizar a #031 a fazer a prova de conceito, sem custos e sem contratação.
2. **GitHub Actions:** decidir se ele pode ser usado como alternativa de custo zero, apesar de logs públicos neste repositório público e do egress aberto. Recomendação: **não**, salvo para tarefas sem nenhum dado privado.
3. **Allowlist de rede inicial:** por exemplo, apenas a API do modelo e `github.com` para o repositório vinculado.
4. **Credenciais de modelo:** onde ficarão a chave e a cobrança da API usada pelos agentes, já que assinatura não equivale a API (#026). Nenhum valor é pago sem orçamento aprovado (#022).
5. **Liberação da execução:** quando ativar `REAL_EXECUTION_ENABLED`. Só depois do provedor real, da #011 (aprovações persistidas) e da #022 (quotas e kill switch).
