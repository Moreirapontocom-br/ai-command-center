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
import { APPROVED_DOCUMENTS, createGraphQLClient, GITHUB_GRAPHQL_ENDPOINT, isReadOnlyDocument } from './github/client.ts';
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

describe('superfície de escrita do servidor', () => {
  it('a única chamada de rede do servidor é a do cliente GraphQL', () => {
    expect(filesMatching(server, /\bfetch\(/)).toEqual(['server/github/client.ts']);
  });

  it('o único endpoint da API do GitHub é o GraphQL fixo', () => {
    expect(GITHUB_GRAPHQL_ENDPOINT).toBe('https://api.github.com/graphql');
    const apiUrls = server.flatMap((f) => f.code.match(/https?:\/\/api\.github\.com[^'"`\s]*/g) ?? []);
    expect(apiUrls).toEqual([GITHUB_GRAPHQL_ENDPOINT]);
    expect(filesMatching(server, /uploads\.github\.com|\/repos\/|\/user\//)).toEqual([]);
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

  it('rotas de negócio só aceitam GET e HEAD; POST existe apenas em login e logout (Issue #003, PR 2)', () => {
    expect([...POST_ROUTES]).toEqual(['/api/auth/login', '/api/auth/logout']);
    for (const path of ['/api/status', '/api/repos/a/b/snapshot', '/api/auth/session', '/api/qualquer']) {
      expect([...allowedMethods(path)]).toEqual(['GET', 'HEAD']);
    }
    for (const path of POST_ROUTES) expect([...allowedMethods(path)]).toEqual(['POST']);
    // Nenhum PUT/PATCH/DELETE em nenhuma rota, e a lista de POST é a única fonte de métodos de escrita.
    const app = server.find((f) => f.path === 'server/http/app.ts')!.code;
    expect(app).not.toMatch(/['"](?:PUT|PATCH|DELETE)['"]/);
    expect(app.match(/['"]POST['"]/g)).toHaveLength(1);
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

  it('um único ponto de rede; POST só para login/logout do ACC (Issue #003, PR 2)', () => {
    expect(filesMatching(frontend, /\bfetch\(/)).toEqual(['src/services/apiClient.ts']);
    expect(filesMatching(frontend, /method:\s*['"](?:PUT|PATCH|DELETE)/i)).toEqual([]);
    expect(filesMatching(frontend, /method:\s*['"]POST/)).toEqual(['src/services/apiClient.ts']);
    // Quem envia corpo (`post:`) é só o cliente de autenticação, e apenas para as rotas de login/logout.
    expect(filesMatching(frontend, /\bpost:\s/)).toEqual(['src/services/authApi.ts']);
    const authApi = frontend.find((f) => f.path === 'src/services/authApi.ts')!.code;
    const posted = [...authApi.matchAll(/requestJson\('([^']+)', \{ post:/g)].map((m) => m[1]);
    expect(posted.sort()).toEqual([...POST_ROUTES].sort());
  });

  it('não guarda sessão nem senha no navegador', () => {
    expect(filesMatching(frontend, /localStorage|sessionStorage|indexedDB|document\.cookie/)).toEqual([]);
  });
});
