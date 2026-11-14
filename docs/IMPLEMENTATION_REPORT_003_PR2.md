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
| Sessão | Token aleatório de 256 bits no cookie; o servidor guarda só o SHA-256. Expira após 30 min de inatividade ou 8 h no total. Máximo de 10 sessões. Login sempre cria sessão nova e revoga a anterior enviada (rotação). Logout revoga no servidor |
| Cookie | `acc_session` com `Path=/; HttpOnly; SameSite=Strict; Max-Age=28800`. Com `ACC_DEPLOYMENT=production`: `__Host-acc_session` com `Secure` |
| Tentativas | Antes de calcular o hash: 5 falhas por cliente ou 20 no total, em 15 min, bloqueiam por 15 min (429 + `Retry-After`). No máximo 2 verificações scrypt simultâneas (~128 MiB cada). E-mail desconhecido gasta o mesmo tempo que senha errada (hash fictício) e recebe a mesma resposta |
| Rotas | Públicas: `GET /api/auth/session`, `POST /api/auth/login`, `POST /api/auth/logout`. **Todas** as demais exigem sessão e respondem 401 antes de qualquer validação; o visitante não distingue rota, parâmetro nem repositório. Rotas de dados continuam GET/HEAD |
| CSRF | Nas rotas POST: `Origin` obrigatório e na allowlist; `Sec-Fetch-Site` só `same-origin`; corpo `application/json` (415 caso contrário); limite de 4 KiB. Junto com `SameSite=Strict` e ausência de CORS. Sem token sincronizador: o par Origin + SameSite cobre o modelo same-origin |
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

- `npm test`: **336/336** (274 anteriores + 62 novos).
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
3. **Bloqueio global do login:** 20 falhas em 15 min bloqueiam o login de todos. Um atacante com acesso à porta pode atrasar o login legítimo. Isso protege a conta única contra força bruta distribuída. Atrás do proxy do Vite, todo cliente aparece como `127.0.0.1`, então o limite "por cliente" vale para todo o tráfego local.
4. Não há recuperação de senha nem MFA. A troca de senha é feita gerando um novo hash e reiniciando o servidor.
5. O custo do scrypt (~0,3–0,5 s e 128 MiB por login) é intencional. Com mais de 2 logins simultâneos, o servidor responde 429.

## 6. Configurar o primeiro administrador

1. Rode `npm run auth:hash-password`, digite a senha (12 a 256 caracteres; não aparece na tela) e confirme.
2. No `.env.local` (ignorado pelo Git), cole a linha `ACC_ADMIN_PASSWORD_HASH=…` e acrescente `ACC_ADMIN_EMAIL=<e-mail>`.
3. Reinicie `npm run server`. O log deve mostrar `"adminConfigured":true`.
4. Nunca coloque a senha em texto puro em arquivos, variáveis, commits ou mensagens. O hash também fica só no `.env.local`.

## 7. Pendências para aprovação humana

- **Implantação em nuvem** (limitação 2): exige decisão de arquitetura e de hospedagem. Não implementada.
- **Política de bloqueio global** (limitação 3): manter o trade-off atual ou ajustar os limites.
