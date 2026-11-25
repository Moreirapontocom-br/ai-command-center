// @vitest-environment node
/**
 * Garantias estruturais de somente leitura. Estes testes leem o código-fonte e falham se alguém
 * abrir uma nova superfície de escrita: outro ponto de rede, outro subprocesso, outro endpoint do
 * GitHub, uma mutation GraphQL ou um método HTTP de escrita.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GH_AUTH_TOKEN_ARGS } from './auth/ghCli.ts';
import { allowedMethods, POST_ROUTES } from './http/app.ts';
import { APPROVED_DOCUMENTS, assertAllowedRestRequest, compareRequestUrl, createGraphQLClient, createRestCompareClient, GITHUB_GRAPHQL_ENDPOINT, GITHUB_REST_ORIGIN, isReadOnlyDocument } from './github/client.ts';
import { POLICY_ACTIONS } from '../shared/contracts.ts';
import { APPROVAL_TTL_MS } from './approvals/contracts.ts';
import { HANDOFF_TRANSITIONS } from './gateway/contracts.ts';
import { ASSISTED_AVAILABILITY } from './policy/engine.ts';
import { defaultProviderCatalog } from './limits/providers.ts';
import { REAL_EXECUTION_ENABLED } from './sandbox/contracts.ts';
import { RELEASABLE_REASONS } from './admin/releaseBarrier.ts';
import * as queries from './github/queries.ts';

function sources(dir: string): Array<{ path: string; code: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative('.', full).replaceAll('\\', '/'), code: readFileSync(full, 'utf8') }];
  });
}

const server = sources('server');
const frontend = sources('src');
const filesMatching = (files: typeof server, pattern: RegExp) => files.filter((f) => pattern.test(f.code)).map((f) => f.path);
/** Código sem comentários (documentação pode citar caminhos; só o código conta). */
const stripComments = (files: typeof server) => files.map((f) => ({ ...f, code: f.code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') }));

describe('superfície de escrita do servidor', () => {
  it('a única chamada de rede do servidor é a do cliente GraphQL', () => {
    expect(filesMatching(server, /\bfetch\(/)).toEqual(['server/github/client.ts']);
  });

  it('os únicos endpoints da API do GitHub são o GraphQL fixo e a comparação REST fechada (Issue #008)', () => {
    expect(GITHUB_GRAPHQL_ENDPOINT).toBe('https://api.github.com/graphql');
    expect(GITHUB_REST_ORIGIN).toBe('https://api.github.com');
    const apiUrls = server.flatMap((f) => f.code.match(/https?:\/\/api\.github\.com[^'"`\s]*/g) ?? []);
    expect(apiUrls.sort()).toEqual([GITHUB_REST_ORIGIN, GITHUB_GRAPHQL_ENDPOINT].sort());
    expect(filesMatching(server, /https?:\/\/api\.github\.com/)).toEqual(['server/github/client.ts']);
    expect(filesMatching(server, /uploads\.github\.com|\/user\//)).toEqual([]);
    // `/repos/` só no ÚNICO caminho REST montado, o da comparação (§6.4), dentro de client.ts.
    const code = stripComments(server);
    expect(filesMatching(code, /\/repos\//)).toEqual(['server/github/client.ts']);
    expect(code.find((f) => f.path === 'server/github/client.ts')!.code.match(/\/repos\//g)).toHaveLength(1);
    expect(code.find((f) => f.path === 'server/github/client.ts')!.code).toMatch(/\$\{GITHUB_REST_ORIGIN\}\/repos\/\$\{owner\}\/\$\{repo\}\/compare\/\$\{baseSha\}\.\.\.\$\{headSha\}\$\{REST_COMPARE_QUERY\}/);
    // Nenhum outro recurso REST (escrita, workflows, merges, refs, conteúdos) é citado no código.
    expect(filesMatching(code, /\/(?:pulls|merges|dispatches|git\/refs|contents|actions|hooks|statuses|check-runs|issues\/\d)/)).toEqual([]);
  });

  it('REST (Issue #008): só GET, caminho fechado com SHAs completos e só per_page=1 — recusa antes da rede', async () => {
    const sha = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    expect(compareRequestUrl('o', 'r', sha, sha2)).toBe(`https://api.github.com/repos/o/r/compare/${sha}...${sha2}?per_page=1`);
    for (const [owner, repo, base, head] of [
      ['o', 'r', 'abc', sha2],
      ['o', 'r', sha, 'HEAD'],
      ['o', 'r', sha.toUpperCase(), sha2],
      ['o/x', 'r', sha, sha2],
      ['o', '..', sha, sha2],
      ['o', 'r?x=1', sha, sha2],
      ['-o', 'r', sha, sha2],
    ]) {
      expect(() => compareRequestUrl(owner, repo, base, head)).toThrow();
    }
    const good = compareRequestUrl('o', 'r', sha, sha2);
    for (const [method, url] of [
      ['POST', good],
      ['PUT', good],
      ['PATCH', good],
      ['DELETE', good],
      ['GET', good.replace('per_page=1', 'per_page=100')],
      ['GET', `${good}&page=2`],
      ['GET', good.replace('?per_page=1', '')],
      ['GET', `${good}#x`],
      ['GET', good.replace('/compare/', '/merges/')],
      ['GET', good.replace('https://api.github.com', 'https://evil.example')],
      ['GET', good.replace('https://', 'https://user:pass@')],
      ['GET', `https://api.github.com/repos/o/r/pulls/1`],
    ]) {
      expect(() => assertAllowedRestRequest(method, url)).toThrow();
    }
    // Em execução: um único GET na URL exata, sem corpo e sem cookies.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createRestCompareClient({ credentials: { kind: 'fine-grained-token' as const, getAuthorizationHeader: async () => 'Bearer x' }, fetchImpl, timeoutMs: 1000 });
    await client.compare('o', 'r', sha, sha2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(good);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toMatch(/cookie/i);
    // Entrada inválida: recusa sem credencial nem rede.
    const credentials = { kind: 'gh-cli' as const, getAuthorizationHeader: vi.fn(async () => 'Bearer x') };
    const fetch2 = vi.fn();
    await expect(createRestCompareClient({ credentials, fetchImpl: fetch2, timeoutMs: 1000 }).compare('o', 'r', 'main', sha2)).rejects.toMatchObject({ code: 'internal', reason: 'rest_request_not_allowed' });
    expect(credentials.getAuthorizationHeader).not.toHaveBeenCalled();
    expect(fetch2).not.toHaveBeenCalled();
  });

  it('só o provedor gh-cli cria subprocessos, e sempre com os argumentos congelados', () => {
    expect(filesMatching(server, /node:child_process|from 'child_process'/)).toEqual(['server/auth/ghCli.ts']);
    const ghCli = server.find((f) => f.path === 'server/auth/ghCli.ts')!.code;
    expect(ghCli).not.toMatch(/\b(?:spawn|spawnSync|execSync|execFileSync|fork)\s*\(/);
    expect(ghCli.match(/\bexecFile\(/g)).toHaveLength(1);
    expect(ghCli.match(/\bexec\(/g)).toHaveLength(1);
    expect(ghCli).toContain('exec(file, GH_AUTH_TOKEN_ARGS, execOptions)');
    expect(ghCli).not.toMatch(/shell:\s*true/);
    expect([...GH_AUTH_TOKEN_ARGS]).toEqual(['auth', 'token', '--hostname', 'github.com']);
  });

  it('POST só em login/logout (Issue #003), projetos (Issue #004), tarefas (Issue #005) e decisões de aprovação (Issue #011); o resto é GET/HEAD', () => {
    expect([...POST_ROUTES]).toEqual([
      '/api/auth/login',
      '/api/auth/logout',
      '/api/projects',
      '/api/projects/active',
      '/api/projects/:id',
      '/api/projects/:id/tasks',
      '/api/projects/:id/tasks/:taskId',
      '/api/approvals/step-up',
      '/api/approvals/:id/approve',
      '/api/approvals/:id/reject',
      '/api/approvals/:id/revoke',
      '/api/approvals/owner-confirmations',
      '/api/approvals/attempts/:id/acknowledge',
      '/api/approvals/history/holds',
      '/api/approvals/history/holds/:id/remove',
      '/api/approvals/history/purge',
      // Issue #008 (PR 2): ordens do Claude Code no fluxo assistido.
      '/api/projects/:id/tasks/:taskId/claude-orders',
      '/api/projects/:id/claude-enablement',
      '/api/claude-orders/:orderId/package',
      '/api/claude-orders/:orderId/forwarded',
      '/api/claude-orders/:orderId/pr',
      '/api/claude-orders/:orderId/verify',
      '/api/claude-orders/:orderId/cancel',
    ]);
    // Nenhuma rota executa, admite, inicia sandbox, faz merge/deploy, mexe em limites ou no kill switch (N9).
    expect(POST_ROUTES.some((route) => /exec|run|sandbox|admission|admit|kill|barrier|release|limit|budget|quota|spend|merge|deploy|publish|secret|permission/.test(route))).toBe(false);
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const path of [
      '/api/status',
      '/api/repos/a/b/snapshot',
      `/api/projects/${id}/repositories/a/b/snapshot`,
      '/api/auth/session',
      '/api/audit',
      '/api/qualquer',
    ]) {
      expect([...allowedMethods(path)]).toEqual(['GET', 'HEAD']);
    }
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/projects/active']) {
      expect([...allowedMethods(path)]).toEqual(['POST']);
    }
    for (const path of ['/api/projects', `/api/projects/${id}`, `/api/projects/${id}/tasks`, `/api/projects/${id}/tasks/${id}`]) {
      expect([...allowedMethods(path)]).toEqual(['GET', 'HEAD', 'POST']);
    }
    // Issue #008: listagem só leitura; criação, habilitação e ações da ordem só POST.
    expect([...allowedMethods(`/api/projects/${id}/claude-orders`)]).toEqual(['GET', 'HEAD']);
    for (const path of [`/api/projects/${id}/tasks/${id}/claude-orders`, `/api/projects/${id}/claude-enablement`, ...['package', 'forwarded', 'pr', 'verify', 'cancel'].map((v) => `/api/claude-orders/${id}/${v}`)]) {
      expect([...allowedMethods(path)]).toEqual(['POST']);
    }
    expect([...allowedMethods(`/api/claude-orders/${id}/release`)]).toEqual(['GET', 'HEAD']);
    // Nenhum PUT/PATCH/DELETE em nenhuma rota; POST aparece uma única vez (constante WRITE_METHOD).
    const app = server.find((f) => f.path === 'server/http/app.ts')!.code;
    expect(app).not.toMatch(/['"](?:PUT|PATCH|DELETE)['"]/);
    expect(app.match(/['"]POST['"]/g)).toHaveLength(1);
  });

  it('políticas: sem rota de escrita, e o motor não grava nada nem usa I/O (Issue #020)', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect([...allowedMethods(`/api/projects/${id}/policy`)]).toEqual(['GET', 'HEAD']);
    expect(POST_ROUTES.some((route) => route.includes('policy'))).toBe(false);
    for (const path of ['server/policy/engine.ts', 'server/policy/defaultPolicy.ts']) {
      const code = server.find((f) => f.path === path)!.code;
      expect(code).not.toMatch(/node:fs|node:http|node:child_process|\bfetch\(|writeFile/);
    }
  });

  it('sandbox (Issue #021): sem execução real, sem I/O e sem rota HTTP', () => {
    const files = server.filter((f) => f.path.startsWith('server/sandbox/'));
    expect(files.map((f) => f.path).sort()).toEqual([
      'server/sandbox/contracts.ts',
      'server/sandbox/provider.ts',
      // Issue #012, PR 2: adaptador SIMULADO do executor da fila (só tipos de queue/ports.ts).
      'server/sandbox/queueExecutor.ts',
      'server/sandbox/service.ts',
      'server/sandbox/simulatedProvider.ts',
      'server/sandbox/validation.ts',
    ]);
    for (const file of files) {
      expect(file.code).not.toMatch(/node:child_process|node:fs|node:net|node:http|node:vm|node:worker_threads|\bfetch\(|\beval\(|new Function\(/);
    }
    expect(files.find((f) => f.path === 'server/sandbox/contracts.ts')!.code).toMatch(/REAL_EXECUTION_ENABLED = false as const/);
    // Nenhum código fora de server/sandbox usa o serviço (não há API de execução).
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/sandbox/')), /sandbox\/(service|simulatedProvider|provider)/)).toEqual([]);
    expect(POST_ROUTES.some((route) => /sandbox|exec|run/.test(route))).toBe(false);
  });

  it('limites (Issue #022): sem I/O, sem rede, sem execução, sem conectores de IA e sem rota HTTP', () => {
    const files = server.filter((f) => f.path.startsWith('server/limits/'));
    expect(files.map((f) => f.path).sort()).toEqual([
      'server/limits/contracts.ts',
      'server/limits/controller.ts',
      'server/limits/providers.ts',
      // Issue #012, PR 2: adaptador do controlador para a fila (só tipos de queue/ports.ts).
      'server/limits/queueAdmission.ts',
      'server/limits/simulatedApprovalVerifier.ts',
      'server/limits/validation.ts',
    ]);
    // O verificador SIMULADO nunca é o padrão: o controlador não o importa (sem verificador = negado).
    expect(files.find((f) => f.path === 'server/limits/controller.ts')!.code).not.toMatch(/simulatedApprovalVerifier/);
    for (const file of files) {
      expect(file.code).not.toMatch(/node:child_process|node:fs|node:net|node:http|node:https|node:vm|node:worker_threads|\bfetch\(|\beval\(|new Function\(/);
      // Não usa o sandbox (execução) nem credenciais/sessões de contas de IA.
      expect(file.code).not.toMatch(/sandbox\/(service|simulatedProvider|provider)|cookie|process\.env/i);
    }
    // Nenhum código fora de server/limits usa o controlador (não há API nem integração real ainda).
    // Issue #008: o servidor lê do catálogo SÓ se o perfil assistido está disponível (nunca o controlador).
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/limits/')), /limits\/(controller|providers|simulatedApprovalVerifier)/)).toEqual(['server/index.ts']);
    const index = server.find((f) => f.path === 'server/index.ts')!.code;
    expect(index).toMatch(/^import \{ assistedProfileAvailable \} from '\.\/limits\/providers\.ts';$/m);
    expect(index).not.toMatch(/limits\/(controller|simulatedApprovalVerifier|queueAdmission)|createLimitsController/);
    expect(POST_ROUTES.some((route) => /limit|budget|quota|kill|spend|admission/.test(route))).toBe(false);
  });

  it('aprovações (Issue #011): núcleo sem rede, sem execução e sem verificador simulado; ligado só pelos pontos revisados', () => {
    const files = server.filter((f) => f.path.startsWith('server/approvals/'));
    expect(files.map((f) => f.path).sort()).toEqual([
      'server/approvals/binding.ts',
      'server/approvals/canonical.ts',
      'server/approvals/contracts.ts',
      'server/approvals/documents.ts',
      'server/approvals/identity.ts',
      'server/approvals/keyProvider.ts',
      'server/approvals/lock.ts',
      'server/approvals/maintenance.ts',
      'server/approvals/paths.ts',
      'server/approvals/presentation.ts',
      'server/approvals/service.ts',
      'server/approvals/store.ts',
    ]);
    for (const file of files) {
      expect(file.code).not.toMatch(/node:child_process|node:net|node:http|node:https|node:vm|node:worker_threads|\bfetch\(|\beval\(|new Function\(/);
      // O núcleo não lê o ambiente (a configuração é injetada), não usa o sandbox nem o controlador
      // da #022 (só os TIPOS do contrato) e nunca o verificador simulado.
      expect(file.code).not.toMatch(/process\.env|sandbox\/(service|simulatedProvider|provider)|limits\/(controller|providers)|simulatedApprovalVerifier/);
    }
    // Só o módulo de identidade toca a verificação de senha (nenhum outro caminho cria prova humana).
    expect(filesMatching(files, /auth\/password|verifyPassword/)).toEqual(['server/approvals/identity.ts']);
    // O verificador entregue aos componentes é sempre o confiável.
    expect(files.find((f) => f.path === 'server/approvals/service.ts')!.code).toMatch(/kind: 'trusted' as const/);
    // PR 2: só estes pontos revisados usam o núcleo — a configuração/abertura do servidor, as rotas
    // de decisão do administrador e os componentes que pedem/consomem aprovações (#021/#022).
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/approvals/')), /approvals\/(service|store|identity|keyProvider|lock|paths|documents|binding|canonical|contracts|maintenance|presentation)/).sort()).toEqual([
      // Issue #008 (P1): o comando LOCAL de liberação da barreira inicial (nunca uma rota; N9 emendado).
      'server/admin/releaseBarrier.ts',
      // Issue #028 (I1): só o TIPO `ApprovalCoordinator` (pedido, reserva de uso único e resultado).
      'server/gateway/service.ts',
      'server/http/approvalRoutes.ts',
      'server/index.ts',
      'server/limits/controller.ts',
      'server/sandbox/service.ts',
    ]);
    expect(server.find((f) => f.path === 'server/gateway/service.ts')!.code).toMatch(/^import type \{ ApprovalCoordinator \} from '\.\.\/approvals\/service\.ts';$/m);
    // As rotas de aprovação não alcançam execução, sandbox, controlador nem verificador simulado.
    const routes = server.find((f) => f.path === 'server/http/approvalRoutes.ts')!.code;
    expect(routes).not.toMatch(/sandbox\/(service|simulatedProvider|provider)|limits\/(controller|providers|simulatedApprovalVerifier)|engageBarrier|releaseBarrier|recover\(|reserve\(|recordOutcome/);
    // A configuração do PO pela web cobre só retenção e descarte do histórico (nunca kill switch/limites).
    expect(routes).toMatch(/body\.operation !== 'approvals\.retention_change'/);
    // Nenhuma rota de aprovação aciona ou libera o kill switch, nem recupera o armazenamento (N9).
    expect(POST_ROUTES.filter((route) => route.startsWith('/api/approvals')).some((route) => /kill|barrier|release|recover|quarantine|limit|reserve|execute|step_up_bypass/.test(route))).toBe(false);
    // Nenhum código do servidor importa o verificador simulado nem o provedor simulado do sandbox.
    expect(filesMatching(server, /\/simulatedApprovalVerifier|\/simulatedProvider/)).toEqual([]);
  });

  it('auditoria é somente leitura pela API: nenhuma rota de escrita sob /api/audit (Issue #006)', () => {
    expect(POST_ROUTES.some((route) => route.startsWith('/api/audit'))).toBe(false);
    for (const path of ['/api/audit', '/api/audit/x']) expect([...allowedMethods(path)]).toEqual(['GET', 'HEAD']);
    const auditLog = server.find((f) => f.path === 'server/audit/auditLog.ts')!.code;
    // O registro só expõe adição e leitura.
    expect(auditLog).not.toMatch(/\b(?:remove|delete|update|edit|clear)\w*\s*\(/i);
  });

  it('projetos e tarefas gravam só no armazenamento local: sem GitHub, rede ou subprocesso (Issues #004/#005)', () => {
    const projectFiles = server.filter((f) => /^server\/(?:projects|tasks|storage|audit|policy)\//.test(f.path));
    expect(projectFiles.map((f) => f.path).sort()).toEqual([
      'server/audit/auditLog.ts',
      'server/audit/events.ts',
      'server/policy/defaultPolicy.ts',
      'server/policy/engine.ts',
      'server/projects/projectStore.ts',
      'server/projects/validation.ts',
      // Issue #012 (D7/U4/D2): primitivas compartilhadas extraídas das aprovações + motor do ledger assinado.
      'server/storage/canonical.ts',
      'server/storage/errors.ts',
      'server/storage/jsonFile.ts',
      'server/storage/lock.ts',
      'server/storage/paths.ts',
      // Issue #028 (P3): conteúdos cifrados (AES-256-GCM) com referência no ledger do dono.
      'server/storage/sealedBlobs.ts',
      'server/storage/signedLedger.ts',
      'server/storage/subkeys.ts',
      'server/tasks/taskStore.ts',
      'server/tasks/validation.ts',
    ]);
    for (const file of projectFiles) {
      expect(file.code).not.toMatch(/github\/client|github\/queries|snapshotService|\bfetch\(|child_process|node:net|node:http/);
    }
  });

  it('armazenamento compartilhado (Issue #012, D7): sem ambiente, rede, execução nem dependência de núcleos', () => {
    const files = server.filter((f) => f.path.startsWith('server/storage/'));
    for (const file of files) {
      expect(file.code).not.toMatch(/process\.env|node:child_process|node:net|node:http|node:https|node:vm|node:worker_threads|\bfetch\(|\beval\(|new Function\(/);
      // Primitivas genéricas: não conhecem aprovações, fila, sandbox nem controlador.
      expect(file.code).not.toMatch(/from '\.\.\/(approvals|queue|sandbox|limits)\//);
    }
  });

  it('fila (Issue #012, PR 1/PR 2): DORMENTE — sem rota, temporizador, execução real nem acesso às aprovações', () => {
    const files = server.filter((f) => f.path.startsWith('server/queue/'));
    expect(files.map((f) => f.path).sort()).toEqual([
      'server/queue/barrierGate.ts',
      'server/queue/classification.ts',
      'server/queue/contracts.ts',
      'server/queue/documents.ts',
      'server/queue/ports.ts',
      'server/queue/scheduler.ts',
      'server/queue/store.ts',
    ]);
    for (const file of files) {
      expect(file.code).not.toMatch(/process\.env|node:child_process|node:net|node:http|node:https|node:vm|node:worker_threads|\bfetch\(|\beval\(|new Function\(/);
      // Sem agendamento nem ciclo próprio neste PR.
      expect(file.code).not.toMatch(/\bsetInterval\(|\bsetTimeout\(|\bsetImmediate\(/);
      // A autoridade de barreira é INJETADA (interface estreita): a fila não importa o núcleo de
      // aprovações, o sandbox nem o controlador da #022.
      expect(file.code).not.toMatch(/approvals\/|sandbox\/(service|simulatedProvider|provider)|limits\/(controller|providers|simulatedApprovalVerifier)/);
    }
    // Só a inicialização do servidor usa a fila; nenhuma rota.
    // Issue #008 (P1): o comando local abre a fila e roda `reconcile()` (só pode ACIONAR barreiras).
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/queue/') && !f.path.startsWith('server/test/')), /queue\/(store|barrierGate|contracts|documents|classification)/).sort()).toEqual(['server/admin/releaseBarrier.ts', 'server/index.ts']);
    // PR 2 (Q7): o agendador NÃO é instanciado em produção — nenhum arquivo fora da fila o usa.
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/queue/')), /queue\/scheduler|createQueueScheduler|QueueScheduler/)).toEqual([]);
    expect(server.find((f) => f.path === 'server/index.ts')!.code).not.toMatch(/queue\/scheduler|createQueueScheduler|queueAdmission|queueExecutor|\.tick\(/);
    // As interfaces estreitas (`ports.ts`) só têm tipos e só os dois adaptadores as importam, por `import type`.
    expect(files.find((f) => f.path === 'server/queue/ports.ts')!.code).toMatch(/^import type /m);
    expect(files.find((f) => f.path === 'server/queue/ports.ts')!.code).not.toMatch(/^import \{|^export (const|function|class)/m);
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/queue/')), /queue\/ports/).sort()).toEqual([
      // Issue #028 (D6): executor do gateway e executor composto, só pelos TIPOS.
      'server/gateway/routingExecutor.ts',
      'server/gateway/service.ts',
      'server/limits/queueAdmission.ts',
      'server/sandbox/queueExecutor.ts',
    ]);
    // O serviço do gateway importa as portas só por tipo (as demais regras dele estão no bloco da #028:
    // ele usa o TIPO do coordenador de aprovações e um temporizador de prazo da invocação simulada).
    expect(server.find((f) => f.path === 'server/gateway/service.ts')!.code).toMatch(/^import type \{[^}]+\} from '\.\.\/queue\/ports\.ts';$/m);
    expect(server.find((f) => f.path === 'server/gateway/service.ts')!.code).not.toMatch(/from '\.\.\/queue\/(?!ports\.ts)/);
    for (const path of ['server/gateway/routingExecutor.ts', 'server/limits/queueAdmission.ts', 'server/sandbox/queueExecutor.ts']) {
      const code = server.find((f) => f.path === path)!.code;
      expect(code).toMatch(/^import type \{[^}]+\} from '\.\.\/queue\/ports\.ts';$/m);
      expect(code).not.toMatch(/from '\.\.\/queue\/(?!ports\.ts)/);
      expect(code).not.toMatch(/approvals\/|\bsetInterval\(|\bsetTimeout\(/);
    }
    // O adaptador do executor só aceita provedor simulado e recusa execução real.
    expect(server.find((f) => f.path === 'server/sandbox/queueExecutor.ts')!.code).toMatch(/REAL_EXECUTION_ENABLED \|\| options\.provider\.isolation !== 'simulated' \|\| options\.provider\.executesCode/);
    // R4 (revisão do PR 2): nenhum resultado de executor chega por produção. As rotas HTTP não
    // tocam a fila nem os adaptadores; ninguém fora dos módulos de origem cria os adaptadores;
    // nenhuma rota recebe resultados/relatos de execução.
    const httpFiles = server.filter((f) => f.path.startsWith('server/http/'));
    expect(filesMatching(httpFiles, /queue\/|queueAdmission|queueExecutor|onResult|engageKillSwitch/)).toEqual([]);
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/sandbox/')), /createSandboxQueueExecutor\(|from '[^']*sandbox\/queueExecutor/)).toEqual([]);
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/limits/')), /createQueueAdmissionPort\(|from '[^']*limits\/queueAdmission/)).toEqual([]);
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/queue/')), /\.onResult\(/)).toEqual([]);
    expect(POST_ROUTES.some((route) => /result|report|callback|webhook|executor|settle/.test(route))).toBe(false);
    expect(POST_ROUTES.some((route) => /queue|dispatch|enqueue|schedul|fila/.test(route))).toBe(false);
    // Execução real continua desligada.
    expect(server.find((f) => f.path === 'server/sandbox/contracts.ts')!.code).toMatch(/REAL_EXECUTION_ENABLED = false as const/);
  });
  it('Agent Gateway (Issues #028/#008): só o canal ASSISTIDO ligado — sem rede, credencial, ambiente, subprocesso, adaptador nem fila em produção', () => {
    const files = server.filter((f) => f.path.startsWith('server/gateway/'));
    expect(files.map((f) => f.path).sort()).toEqual([
      'server/gateway/adapters.ts',
      'server/gateway/content.ts',
      'server/gateway/contracts.ts',
      'server/gateway/documents.ts',
      // Issue #008: coordenador das ordens (porta de leitura injetada) e regras puras V1–V13.
      'server/gateway/orders.ts',
      'server/gateway/prVerification.ts',
      'server/gateway/routingExecutor.ts',
      'server/gateway/secretScan.ts',
      'server/gateway/service.ts',
      'server/gateway/store.ts',
    ]);
    // Issue #008: o gateway conhece o GitHub só pelos TIPOS das leituras (nunca o cliente, a consulta ou a credencial).
    expect(filesMatching(files, /from '\.\.\/github\//).sort()).toEqual(['server/gateway/orders.ts', 'server/gateway/prVerification.ts']);
    for (const path of ['server/gateway/orders.ts', 'server/gateway/prVerification.ts']) {
      const code = files.find((f) => f.path === path)!.code;
      expect(code).toMatch(/^import type \{[^}]+\} from '\.\.\/github\/prTypes\.ts';$/m);
      expect(code).not.toMatch(/from '[^']*(?:github\/(?:client|prReader|queries|normalize|errors)|auth\/|config)[^']*'/);
    }
    for (const file of files) {
      // Nenhuma rede, I/O direto, subprocesso, código dinâmico, ambiente, cookie ou sessão de conta de IA.
      expect(file.code).not.toMatch(/node:fs|node:child_process|node:net|node:http|node:https|node:dns|node:tls|node:vm|node:worker_threads|\bfetch\(|XMLHttpRequest|WebSocket|\beval\(|new Function\(|process\.env|document\.cookie|setCookie|set-cookie/i);
      // Nunca o controlador (#022), o sandbox (#021), o núcleo de aprovações em si, a fila em si nem os simulados de outros módulos.
      expect(file.code).not.toMatch(/limits\/(controller|providers|simulatedApprovalVerifier|queueAdmission)|sandbox\/(service|simulatedProvider|provider|queueExecutor)|approvals\/(store|identity|keyProvider|binding|presentation|documents|lock|paths|maintenance)|queue\/(scheduler|store|barrierGate|documents|classification)/);
    }
    // Adaptadores: só o tipo `simulated`; nenhum adaptador "official"/real é construído.
    const adapters = files.find((f) => f.path === 'server/gateway/adapters.ts')!.code;
    expect(adapters).toMatch(/kind: 'simulated'/);
    expect(adapters).not.toMatch(/kind: '(official|real|managed)'/);
    expect(files.find((f) => f.path === 'server/gateway/contracts.ts')!.code).toMatch(/readonly kind: 'simulated';/);
    // O executor composto recusa executores que não sejam simulados.
    expect(files.find((f) => f.path === 'server/gateway/routingExecutor.ts')!.code).toMatch(/gateway\.kind !== 'simulated' \|\| sandbox\.kind !== 'simulated'/);
    // Issue #008: só a inicialização do servidor e as rotas das ordens usam o gateway (nenhum outro módulo).
    expect(filesMatching(stripComments(server.filter((f) => !f.path.startsWith('server/gateway/'))), /gateway\/|createGateway|createRoutingExecutor|openGatewayStore/).sort()).toEqual([
      'server/http/app.ts',
      'server/http/claudeOrderRoutes.ts',
      'server/index.ts',
    ]);
    expect(server.find((f) => f.path === 'server/http/app.ts')!.code).toMatch(/^import type \{ ClaudeOrders \} from '\.\.\/gateway\/orders\.ts';$/m);
    // Em produção: NENHUM adaptador, nenhuma fila/executor/temporizador de invocação e nenhum simulado.
    const index = server.find((f) => f.path === 'server/index.ts')!.code;
    expect(index).toMatch(/createGateway\(\{[\s\S]*?adapters: \{\},/);
    expect(index).not.toMatch(/createSimulatedAdapters|createRoutingExecutor|gateway\/adapters|gateway\/routingExecutor|queue:\s|\.invoke\(|\.executor\b|engageKillSwitch|prepareHandoff|relayResult/);
    // As rotas só chamam o coordenador (nunca invocação, handoff genérico, ingestão ou kill switch).
    const routes = server.find((f) => f.path === 'server/http/claudeOrderRoutes.ts')!.code;
    expect(routes).not.toMatch(/\.invoke\(|prepareHandoff|relayResult|retryIngest|engageKillSwitch|readContent|deleteContent|createGateway|openGatewayStore|github\/(client|prReader)/);
    expect(routes).toMatch(/^import type \{ ClaudeOrders \} from '\.\.\/gateway\/orders\.ts';$/m);
    // Nenhuma rota HTTP do gateway, de invocação, handoff ou resultado.
    expect(POST_ROUTES.some((route) => /gateway|agent|invoke|handoff|relay|scope|content/.test(route))).toBe(false);
    // `.onResult(` continua só dentro da fila (o gateway entrega por `drain`).
    expect(filesMatching(files, /\.onResult\(/)).toEqual([]);
    // Execução real continua desligada.
    expect(server.find((f) => f.path === 'server/sandbox/contracts.ts')!.code).toMatch(/REAL_EXECUTION_ENABLED = false as const/);
  });

  it('Agent Gateway (Issue #028): conteúdo só cifrado pela primitiva de armazenamento; nada de conteúdo em logs', () => {
    const files = server.filter((f) => f.path.startsWith('server/gateway/'));
    // Nenhum arquivo do gateway registra log nem escreve no console.
    expect(filesMatching(files, /console\.|logger\.|\.log\(/)).toEqual([]);
    // A primitiva cifra com AES-256-GCM e não conhece gateway, aprovações, fila, sandbox nem controlador.
    const blobs = server.find((f) => f.path === 'server/storage/sealedBlobs.ts')!.code;
    expect(blobs).toMatch(/aes-256-gcm/);
    expect(blobs).not.toMatch(/gateway\/|approvals\/|queue\/|sandbox\/|limits\//);
  });
});

describe('Issue #008 — garantias estruturais do fluxo assistido', () => {
  it('flags globais continuam falsas; a exceção tem exatamente as duas combinações aprovadas (§10.7)', () => {
    expect(POLICY_ACTIONS['agent.invoke'].available).toBe(false);
    expect(POLICY_ACTIONS['data.send_external'].available).toBe(false);
    expect(ASSISTED_AVAILABILITY.map((e) => ({ ...e }))).toEqual([
      { action: 'agent.invoke', subject: 'agent:claude-code', channel: 'assisted', mode: 'subscription_assisted', capability: 'code.change', component: 'gateway' },
      { action: 'data.send_external', subject: 'agent:claude-code', channel: 'assisted', mode: 'subscription_assisted', capability: 'code.change', component: 'gateway' },
    ]);
    expect(Object.isFrozen(ASSISTED_AVAILABILITY)).toBe(true);
    // A exceção só é consultada pelo motor e alimentada só pelo gateway (fatos do servidor).
    expect(filesMatching(server, /assisted:\s*assisted|assistedFactsOf/).sort()).toEqual(['server/gateway/service.ts']);
    expect(filesMatching(server.filter((f) => f.path.startsWith('server/http/')), /assisted\b|ASSISTED_AVAILABILITY/)).toEqual([]);
  });

  it('REAL_EXECUTION_ENABLED, TTLs da #011, HANDOFF_TRANSITIONS e orçamento R$ 0 inalterados', () => {
    expect(REAL_EXECUTION_ENABLED).toBe(false);
    expect(server.find((f) => f.path === 'server/sandbox/contracts.ts')!.code).toMatch(/REAL_EXECUTION_ENABLED = false as const/);
    const MIN = 60 * 1000;
    expect({ ...APPROVAL_TTL_MS }).toEqual({ execution: 60 * MIN, configuration: 15 * MIN, merge: 15 * MIN, publication: 15 * MIN, cost: 15 * MIN });
    expect(structuredClone(HANDOFF_TRANSITIONS)).toEqual({
      prepared: ['awaiting_relay', 'expired', 'revoked'],
      awaiting_relay: ['relayed', 'rejected', 'expired', 'revoked'],
      relayed: ['validated', 'rejected', 'revoked'],
      validated: [],
      rejected: [],
      expired: [],
      revoked: [],
    });
    // Catálogo: exatamente um perfil disponível; API cobrada continua `metered` e indisponível.
    const catalog = defaultProviderCatalog();
    expect(catalog.filter((p) => p.status === 'available').map((p) => `${p.provider}/${p.mode}`)).toEqual(['claude-code/subscription_assisted']);
    expect(catalog.filter((p) => p.mode === 'metered_api').every((p) => p.status === 'unverified' && p.billing === 'metered')).toBe(true);
    expect(POLICY_ACTIONS['spend.create'].available).toBe(false);
  });

  it('nenhuma execução de agente, provedor de IA, SDK, credencial nova ou workflow do Claude Code', () => {
    const code = stripComments(server);
    // Nenhum subprocesso fora do gh-cli (já coberto) e nenhum no caminho da #008.
    for (const path of ['server/gateway/orders.ts', 'server/gateway/prVerification.ts', 'server/http/claudeOrderRoutes.ts', 'server/github/prReader.ts', 'server/github/prTypes.ts']) {
      expect(server.find((f) => f.path === path)!.code).not.toMatch(/child_process|(?<!\.)\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(|new Worker\(|node:vm/);
    }
    // Nenhum SDK/API de provedor, nenhuma variável de ambiente de provedor, nenhum host de IA.
    expect(filesMatching(code, /@anthropic-ai|anthropic\.com|api\.openai\.com|generativelanguage|integrate\.api\.nvidia|claude_agent_sdk|claude-agent-sdk/i)).toEqual([]);
    expect(filesMatching(code, /ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|NVIDIA_API_KEY/)).toEqual([]);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /anthropic|claude|openai|gemini|google-genai|langchain|nvidia/i.test(d))).toEqual([]);
    // Nenhum workflow executa o Claude Code nem foi criado para agentes.
    const workflows = readdirSync('.github/workflows').filter((f) => /\.ya?ml$/.test(f));
    for (const file of workflows) expect(readFileSync(join('.github/workflows', file), 'utf8')).not.toMatch(/claude-code-action|anthropics\/|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY/);
    // Nenhum documento GraphQL novo além dos dois de leitura da #008.
    expect(APPROVED_DOCUMENTS.size).toBe(3);
  });
});

describe('Issue #008, P1 — comando local de liberação da barreira global (N9 emendado)', () => {
  const admin = server.filter((f) => f.path.startsWith('server/admin/'));
  const code = (path: string) => stripComments(server).find((f) => f.path === path)!.code;
  const importsOf = (path: string) => [...code(path).matchAll(/^import (?:type )?[^;]*? from '([^']+)';$/gm)].map((m) => m[1]).sort();

  it('arquivos fixos; sem rede, subprocesso, HTTP, eval nem execução', () => {
    expect(admin.map((f) => f.path).sort()).toEqual([
      'server/admin/instance.ts',
      'server/admin/journal.ts',
      'server/admin/releaseBarrier.ts',
      'server/admin/releaseBarrierCli.ts',
      'server/admin/throttle.ts',
    ]);
    for (const file of admin) {
      expect(file.code).not.toMatch(/node:child_process|node:net|node:http|node:https|node:vm|node:worker_threads|\bfetch\(|\beval\(|new Function\(/);
      expect(file.code).not.toMatch(/from '\.\.\/(gateway|sandbox|limits|github|http)\//);
    }
  });

  it('lista FECHADA de importações do orquestrador e do terminal', () => {
    expect(importsOf('server/admin/releaseBarrier.ts')).toEqual([
      '../approvals/binding.ts',
      '../approvals/contracts.ts',
      '../approvals/documents.ts',
      '../approvals/identity.ts',
      '../approvals/keyProvider.ts',
      '../approvals/service.ts',
      '../approvals/store.ts',
      '../audit/auditLog.ts',
      '../audit/events.ts',
      '../auth/adminAuth.ts',
      '../config.ts',
      '../policy/defaultPolicy.ts',
      '../projects/projectStore.ts',
      '../queue/barrierGate.ts',
      '../queue/store.ts',
      '../storage/jsonFile.ts',
      '../storage/lock.ts',
      '../storage/subkeys.ts',
      '../tasks/taskStore.ts',
      './instance.ts',
      './journal.ts',
      './throttle.ts',
      'node:crypto',
      'node:fs/promises',
      'node:path',
    ]);
    expect(importsOf('server/admin/releaseBarrierCli.ts')).toEqual(['../auth/credentials.ts', '../config.ts', './releaseBarrier.ts', 'node:fs', 'node:path', 'node:url']);
    expect(importsOf('server/admin/instance.ts')).toEqual(['../storage/errors.ts', '../storage/lock.ts', './journal.ts', 'node:fs/promises']);
    expect(importsOf('server/admin/journal.ts')).toEqual(['../storage/jsonFile.ts', 'node:fs/promises', 'node:path']);
    expect(importsOf('server/admin/throttle.ts')).toEqual(['./journal.ts', 'node:path']);
  });

  it('nenhuma rota: POST_ROUTES sem liberação; nada em http/ importa admin/; o servidor só usa o lock e o diário', () => {
    expect(POST_ROUTES.some((route) => /kill|barrier|release|unlock|admin/.test(route))).toBe(false);
    expect(filesMatching(server.filter((f) => f.path.startsWith('server/http/')), /admin\//)).toEqual([]);
    expect(filesMatching(server.filter((f) => !f.path.startsWith('server/admin/')), /from '[^']*admin\//)).toEqual(['server/index.ts']);
    expect([...code('server/index.ts').matchAll(/from '(\.\/admin\/[^']+)'/g)].map((m) => m[1])).toEqual(['./admin/instance.ts']);
    expect(code('server/index.ts')).not.toMatch(/releaseBarrier|runBarrierRelease|releaseBarrierCli/);
    // Só o comando (e o núcleo, que a define) chama `releaseBarrier`.
    expect(filesMatching(stripComments(server).filter((f) => !f.path.startsWith('server/test/')), /\.releaseBarrier\(/)).toEqual(['server/admin/releaseBarrier.ts']);
  });

  it('lock de instância ANTES de abrir qualquer arquivo de dados no servidor; liberado depois de fechar os stores', () => {
    const index = code('server/index.ts');
    const lockAt = index.indexOf('await acquireInstanceLock(dataDir)');
    expect(lockAt).toBeGreaterThan(0);
    for (const open of ['openProjectStore(', 'openTaskStore(', 'openAuditLog(', 'openApprovalStore(', 'openQueueStore(', 'openGatewayStore(', 'openSealedBlobStore(']) {
      expect(index.indexOf(open)).toBeGreaterThan(lockAt);
    }
    expect(index).toMatch(/approvalStore\?\.close\(\)\]\)\s*\.then\(\(\) => instanceLock\.release\(\)\)/);
    // Diário pendente: as aprovações nem são abertas.
    expect(index.indexOf('adminReleasePending(dataDir)')).toBeLessThan(index.indexOf('openApprovalStore('));
  });

  it('tripwire #022: ninguém entrega `controllerKillSwitch` ao serviço de aprovações em produção', () => {
    for (const path of ['server/index.ts', 'server/admin/releaseBarrier.ts']) {
      const calls = code(path).match(/createApprovalService\(\{[^}]*\}\)/g) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call).not.toMatch(/controllerKillSwitch/);
    }
  });

  it('só initial_install é liberável; sem modo automático (nenhuma senha/frase fora do prompt)', () => {
    expect([...RELEASABLE_REASONS]).toEqual(['initial_install']);
    expect(Object.isFrozen(RELEASABLE_REASONS)).toBe(true);
    const orchestrator = code('server/admin/releaseBarrier.ts');
    expect(orchestrator).not.toMatch(/process\.env|process\.argv|ACC_[A-Z_]*PASSWORD|EXPECTED_LINEAGE/);
    // H3 = não: não existe variável de linhagem esperada em lugar nenhum do servidor.
    expect(filesMatching(server, /EXPECTED_LINEAGE/)).toEqual([]);
    const cli = code('server/admin/releaseBarrierCli.ts');
    expect(cli).not.toMatch(/--yes|--password|--force|readFileSync|createInterface/);
  });
});

describe('GraphQL somente leitura', () => {
  const exportedDocuments = Object.values(queries).filter(
    (value): value is string => typeof value === 'string' && /\{/.test(value),
  );

  it('todo documento exportado é uma query sem mutation/subscription', () => {
    expect(exportedDocuments.length).toBeGreaterThan(0);
    for (const document of exportedDocuments) expect(isReadOnlyDocument(document)).toBe(true);
  });

  it('a allowlist tem exatamente os documentos de queries.ts', () => {
    expect([...APPROVED_DOCUMENTS].sort()).toEqual([...exportedDocuments].sort());
  });

  it('nenhum arquivo do servidor declara uma operação mutation/subscription', () => {
    const withoutComments = server.map((f) => ({
      ...f,
      code: f.code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    }));
    expect(filesMatching(withoutComments, /[`'"]\s*(?:mutation|subscription)\b/)).toEqual([]);
  });

  it.each([
    'mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
    'mutation{createIssue(input:{repositoryId:"x",title:"y"}){issue{id}}}',
    `${queries.REPO_SNAPSHOT_QUERY} `,
    `# comentário\n${queries.REPO_SNAPSHOT_QUERY}`,
    'query { viewer { login } }',
  ])('recusa documento fora da allowlist sem obter credencial nem usar a rede (%#)', async (document) => {
    const credentials = { kind: 'gh-cli' as const, getAuthorizationHeader: vi.fn(async () => 'Bearer x') };
    const fetchImpl = vi.fn();
    const client = createGraphQLClient({ credentials, fetchImpl, timeoutMs: 1000 });
    await expect(client.query(document, {})).rejects.toMatchObject({ code: 'internal', reason: 'document_not_approved' });
    expect(credentials.getAuthorizationHeader).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('frontend', () => {
  it('nunca fala diretamente com a API do GitHub', () => {
    expect(filesMatching(frontend, /https?:\/\/api\.github\.com/)).toEqual([]);
  });

  it('um único ponto de rede; POST só para as rotas de escrita do próprio ACC', () => {
    expect(filesMatching(frontend, /\bfetch\(/)).toEqual(['src/services/apiClient.ts']);
    expect(filesMatching(frontend, /method:\s*['"](?:PUT|PATCH|DELETE)/i)).toEqual([]);
    expect(filesMatching(frontend, /method:\s*['"]POST/)).toEqual(['src/services/apiClient.ts']);
    // Quem envia corpo (`post:`) são só os clientes de autenticação, projetos, tarefas e aprovações.
    const writers = ['src/services/approvalsApi.ts', 'src/services/authApi.ts', 'src/services/claudeOrdersApi.ts', 'src/services/projectsApi.ts', 'src/services/tasksApi.ts'];
    expect(filesMatching(frontend, /\bpost:\s/)).toEqual(writers);
    const posted = writers.flatMap((path) => {
      const code = frontend.find((f) => f.path === path)!.code;
      return [...code.matchAll(/requestJson\(\s*(['`])([^'`]+)\1, \{ post:/g)].map((m) =>
        m[2]
          .replace('${encodeURIComponent(projectId)}', ':id')
          .replace('${encodeURIComponent(taskId)}', ':taskId')
          .replace('${encodeURIComponent(approvalId)}', ':id')
          .replace('${encodeURIComponent(attemptId)}', ':id')
          .replace('${encodeURIComponent(holdId)}', ':id')
          .replace('${encodeURIComponent(orderId)}', ':orderId'),
      );
    });
    expect(posted.sort()).toEqual([...POST_ROUTES].sort());
  });

  it('não guarda sessão nem senha no navegador', () => {
    expect(filesMatching(frontend, /localStorage|sessionStorage|indexedDB|document\.cookie/)).toEqual([]);
  });
});
