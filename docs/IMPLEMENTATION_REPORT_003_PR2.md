# Relatório de implementação — Issue #003, PR 2

**Autenticação do administrador e controle de acesso ao painel e à API**

| Item | Valor |
| --- | --- |
| Branch | `feature/003-auth`, criada a partir de `origin/main` `e3d44326` |
| Escopo | Login de administrador único, sessões, logout, proteção das rotas, CSRF, limite de tentativas. Sem RBAC, SSO, login social ou múltiplas organizações |
| Dependências novas | **Nenhuma** (scrypt e aleatoriedade de `node:crypto`) |
| Data | 14/11/2026 |

## 1. Diagnóstico (Fase 0)

- **Servidor:** `server/index.ts` → `createRequestHandler` (`server/http/app.ts`). Escuta só em loopback, valida `Host`/`Origin`/`Sec-Fetch-Site`, aceita só GET/HEAD, tem rate limit por IP e não responde a CORS. **Não havia** autenticação, cookies nem sessão: qualquer processo local lia `/api/status` e os snapshots.
- **Frontend:** `src/App.tsx` → `GitHubDataProvider` → `fetch` em `src/services/githubApi.ts`. O modo demonstração é só de dados fictícios do bundle.
- **CSRF:** não se aplicava (sem cookies e sem POST). Passa a se aplicar com sessão por cookie.
- **Modelo escolhido:** o mais simples que atende a diretriz. Administrador único configurado por ambiente, hash scrypt, sessão em memória do servidor e cookie `HttpOnly`. Não há alternativa substancialmente mais simples **e** segura: Basic Auth não tem logout real e reenvia a senha a cada requisição, e um token no navegador exporia segredo ao JavaScript.

## 2. Decisões técnicas

| Tema | Decisão |
| --- | --- |
| Conta | Um administrador: `ACC_ADMIN_EMAIL` + `ACC_ADMIN_PASSWORD_HASH`. `ACC_ADMIN_PASSWORD` (texto puro) é **recusado** na inicialização. Sem os dois valores, o servidor sobe, o login responde 503 e as rotas privadas respondem 401 |
| Hash | scrypt N=2^17, r=8, p=1 (OWASP), salt de 16 bytes, comparação em tempo constante. A configuração recusa N < 2^17. Formato `scrypt:N:r:p:salt:hash` sem `$` (seguro em `.env`). Gerado por `npm run auth:hash-password` (sem eco no terminal) |
| Sessão | Token aleatório de 256 bits no cookie; o servidor guarda só o SHA-256. Expira após 30 min de inatividade ou 8 h no total. **Uma única sessão administrativa ativa:** todo login bem-sucedido revoga qualquer sessão anterior, **inclusive de outro navegador ou dispositivo** (`maxSessions: 1` como defesa em profundidade). Login malsucedido não afeta a sessão ativa. Logout revoga no servidor |
| Cookie | `acc_session` com `Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`. Com `ACC_DEPLOYMENT=production`: `__Host-acc_session` com `Secure` |
| Tentativas | **Somente para o MVP local.** Antes de calcular o hash: 5 falhas por cliente ou 20 no total, em 15 min, bloqueiam por 15 min (429 + `Retry-After`). Risco de DoS e comportamento atrás de proxy na limitação 3. No máximo 2 verificações scrypt simultâneas (~128 MiB cada). E-mail desconhecido gasta o mesmo tempo que senha errada (hash fictício) e recebe a mesma resposta |
| Rotas | Públicas: `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout`. As demais exigem sessão. **Ordem de verificação**, para qualquer requisição: (1) método (405); (2) `Host`/`Origin`/`Sec-Fetch-Site` (403); (3) rate limit por IP (429); (4) autenticação (401); (5) só então as validações específicas da rota protegida (parâmetros 400, allowlist/escopo 404, rota inexistente 404). Assim o visitante não distingue rota, parâmetro nem repositório. Rotas de dados continuam GET/HEAD |
| CSRF | Nas rotas POST: `Origin` obrigatório e na allowlist (recusa `null`); `Sec-Fetch-Site`, se presente, só `same-origin`; corpo `application/json` (415 caso contrário); limite de 4 KiB por `Content-Length` ou contagem, com conexão encerrada no 413. O logout também valida o corpo (objeto JSON). Junto com `SameSite=Strict` e ausência de CORS. Sem token sincronizador: o par Origin + SameSite cobre o modelo same-origin |
| Escopo | A sessão carrega a lista de repositórios autorizados. `/api/status` filtra por ela e o snapshot responde 404 fora do escopo. O administrador recebe toda a allowlist do servidor |
| GitHub | Inalterado e somente leitura. A credencial do GitHub continua só no servidor. gh-cli segue restrito a `ACC_DEPLOYMENT=local` e **não** autentica usuários do ACC |
| Frontend | `AuthProvider` + tela de login. Sem sessão, nenhum dado do servidor é pedido. Um 401 durante o uso volta ao login com aviso. Logout no cabeçalho. Nada fica em `localStorage`/`sessionStorage` e o cookie não é legível pelo JS. Servidor inalcançável → modo demonstração (só dados fictícios) |
| Logs | Eventos `login_success`, `login_failure`, `login_locked`, `login_busy` e `logout`, sem e-mail, senha, hash nem cookie |

## 3. Arquivos principais

- **Novos:**
  - `server/auth/password.ts`, `sessions.ts`, `loginThrottle.ts`, `adminAuth.ts`, `hashPasswordCli.ts`;
  - `src/services/apiClient.ts`, `src/services/authApi.ts`;
  - `src/features/auth/AuthProvider.tsx`, `authContext.ts`, `LoginPage.tsx`;
  - testes: `server/auth/auth.test.ts`, `server/http/auth.test.ts`, `src/features/auth/Auth.test.tsx`; fixture `server/test/authFixtures.ts`.
- **Alterados:**
  - `server/http/app.ts`: rotas, autenticação, CSRF e escopo;
  - `server/config.ts`: administrador, cookie `Secure` em produção, VITE_ ampliado;
  - `server/index.ts`;
  - `shared/contracts.ts`, `server/github/errors.ts`: novos códigos 401/413/415/503;
  - `src/App.tsx`, `GitHubDataProvider.tsx`, `Header.tsx`, `githubApi.ts`, `githubLabels.ts`;
  - `README.md`, `.env.example`, `package.json` (script `auth:hash-password`).
- **Testes estruturais atualizados** (`server/security.test.ts`):
  - "só GET/HEAD" virou "rotas de negócio só GET/HEAD; POST **apenas** em `/api/auth/login` e `/api/auth/logout`; nenhum PUT/PATCH/DELETE";
  - no frontend: um único `fetch` (`apiClient.ts`), POST só pelo `authApi.ts` para essas duas rotas, e nenhum uso de armazenamento do navegador.

## 4. Verificação

Evidência: `docs/evidence/issue003-pr2-auth-checks.txt`, `issue003-pr2-login-1440.png` e `issue003-pr2-dashboard-1440.png`.

- `npm test`: **336/336** na entrega inicial (274 anteriores + 62 novos); **350/350** após a rodada final (seção 8).
- `lint`, `build`, `check:secrets` (dist), `check:csp`, varredura dos arquivos versionados e `npm audit --omit=dev`: OK, 0 vulnerabilidades.
- **Ponta a ponta com o servidor real** (gh-cli, dados reais do GitHub), via `vite preview` com a CSP de produção:
  - sem sessão: 401;
  - CSRF: 403 sem `Origin` ou com `Origin` externa, 415 com `text/plain`;
  - login válido: cookie `HttpOnly; SameSite=Strict`;
  - snapshot real: 200;
  - logout: o cookie antigo e o token reutilizado respondem 401;
  - após 5 falhas, até a senha certa recebe 429 com `Retry-After: 900`;
  - log sem senha, token, hash nem e-mail.
- **Chrome headless** sob a CSP de produção:
  - login → painel com dados reais → logout;
  - `document.cookie` vazio e armazenamento vazio;
  - 0 exceções, 0 erros de console (fora os 401 esperados) e 0 violações de CSP.
- **Defeito encontrado na validação e corrigido:** com a entrada redirecionada, `auth:hash-password` lia a senha como vazia (ordem `close`/`resolve`). Agora há teste para isso.

## 5. Limitações conhecidas

1. **Sessões em memória:** reiniciar o servidor encerra todas. Não há suporte a várias instâncias. Adequado ao MVP local de administrador único.
2. **Exposição fora do loopback continua bloqueada.** Uma implantação em nuvem ainda exige HTTPS/TLS, `Host` público configurável, origens configuráveis, HSTS e proxy confiável (o IP do cliente atrás de proxy; hoje `X-Forwarded-For` é ignorado de propósito). O cookie `Secure`/`__Host-` já fica pronto em `ACC_DEPLOYMENT=production`.
3. **Limite de tentativas: só para o MVP local. Risco de negação de serviço aceito.**
   - **DoS:** quem alcança a porta pode errar a senha de propósito. Com 5 falhas, bloqueia o próprio cliente; com 20, bloqueia **o login de todos** por 15 min. A sessão já ativa **não** é afetada, porque falhas não revogam sessões (há teste). O bloqueio fica em memória e termina ao reiniciar o servidor. Hoje o servidor só escuta em loopback, então apenas processos da própria máquina chegam à porta.
   - **Atrás de proxy:** o "cliente" é o endereço do socket. Pelo proxy do Vite (dev/preview), todo navegador aparece como `127.0.0.1`, e o limite por cliente vale para o tráfego local inteiro. `X-Forwarded-For` é ignorado de propósito: sem proxy confiável, o cliente controla esse cabeçalho e contornaria o limite.
   - **Antes de qualquer exposição à rede:** rever os dois limites, identificar o cliente real por um proxy confiável e considerar bloqueio progressivo por conta, CAPTCHA ou MFA.
4. Não há recuperação de senha nem MFA. A troca de senha é feita gerando um novo hash e reiniciando o servidor.
5. O custo do scrypt (~0,3–0,5 s e 128 MiB por login) é intencional. Com mais de 2 logins simultâneos, o servidor responde 429.

## 6. Configurar o primeiro administrador

1. Rode `npm run auth:hash-password`, digite a senha (12 a 256 caracteres; não aparece na tela) e confirme.
2. No `.env.local` (ignorado pelo Git), cole a linha `ACC_ADMIN_PASSWORD_HASH=…` e acrescente `ACC_ADMIN_EMAIL=<e-mail>`.
3. Reinicie `npm run server`. O log deve mostrar `"adminConfigured":true`.
4. Nunca coloque a senha em texto puro em arquivos, variáveis, commits ou mensagens. O hash também fica só no `.env.local`.

## 7. Pendências para aprovação humana

- **Implantação em nuvem** (limitação 2): exige decisão de arquitetura e de hospedagem. Não implementada.
- **Política de bloqueio** (limitação 3): mantida pelo PO para o MVP local; precisa ser revista antes da implantação em nuvem.

## 8. Rodada final de correções (revisão do PR #35)

| Item | Correção |
| --- | --- |
| Política de sessão divergente | O código anterior revogava só a sessão **enviada pelo mesmo navegador** e aceitava até 10 sessões. Agora há **uma única sessão administrativa ativa**: o login bem-sucedido chama `revokeAll()` antes de criar a nova sessão, e o padrão é `maxSessions: 1`. Login malsucedido não revoga nada |
| Testes de revogação entre navegadores | `server/http/auth.test.ts` ("sessão administrativa única"):<br>• B faz login sem nunca ter o cookie de A → A recebe 401 (com limpeza do cookie) em `/api/status` e no snapshot, e `/api/auth/session` mostra A como não autenticado; B continua válido<br>• login errado de outro cliente não derruba a sessão ativa<br>• logout do navegador já revogado não afeta a sessão ativa; logout da ativa encerra tudo; novo login continua possível<br>• a sessão ativa segue expirando por inatividade e por tempo absoluto<br>Também: `server/auth/singleSession.test.ts` (serviço e store) e um teste de que o bloqueio por falhas não derruba a sessão ativa |
| Ordem de validação | Comentário em `server/http/app.ts`, relatório e descrição do PR corrigidos: método, origem e rate limit vêm **antes** da autenticação; as validações específicas da rota protegida vêm **depois**. Teste novo comprova a ordem: 405, 403 e 429 sem sessão; 401 antes do 400/404; com sessão, 400/404 |
| Bloqueio de tentativas | Mantido, documentado como exclusivo do MVP local, com o risco de DoS e o comportamento atrás de proxy (limitação 3 e cabeçalho de `server/auth/loginThrottle.ts`) |
| Corpo JSON | Revisado:<br>• limite de 4 KiB por `Content-Length` e por contagem<br>• 413 agora responde `Connection: close` (o restante do corpo não é lido)<br>• o logout passou a validar o corpo (objeto JSON) com o mesmo limite<br>• testes novos para `__proto__`/`constructor` (400, sem poluição de protótipo), `Content-Length` acima do limite e `charset` aceito |
| CSRF | Revisado. Testes novos: `Origin: null` e `Sec-Fetch-Site: none` recusados (403) |
| Logs | Revisados: só metadados (`method`, `path`, `status`, `ms`, `event`). Teste novo envia senha em corpos recusados (JSON quebrado, campo extra, 413, `text/plain`, Origin externa, query string) e confirma que senha e e-mail não aparecem em respostas nem logs |
| Interface | O aviso ao voltar para o login agora cita "por exemplo, por um login em outro navegador" |

**Verificação:**
- `npm test`: **350/350** (+14 nesta rodada).
- `lint`, `build`, `check:secrets` (dist), `check:csp` e varredura dos arquivos versionados: OK.
- **Servidor real com dois "navegadores"** (cookie jars separados): A 200 → login de B → A 401 e B 200; login errado de C não derruba B; logout de A (revogado) não afeta B; logout de B → B 401; corpo de 100 KB → 413; log sem senha, cookie ou e-mail.
- Evidência: `docs/evidence/issue003-pr2-auth-checks.txt`, seção "Rodada final".

