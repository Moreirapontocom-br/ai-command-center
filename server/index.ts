import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createAuthService, DEFAULT_AUTH_LIMITS } from './auth/adminAuth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { CredentialError } from './auth/credentials.ts';
import { GH_CLI_ERROR_MESSAGE } from './auth/ghCli.ts';
import { createGraphQLClient } from './github/client.ts';
import { createRequestHandler } from './http/app.ts';
import { createConsoleLogger } from './logger.ts';
import { openProjectStore } from './projects/projectStore.ts';
import { DataFileError } from './storage/jsonFile.ts';
import { openTaskStore } from './tasks/taskStore.ts';
import { createSnapshotService } from './snapshotService.ts';

const logger = createConsoleLogger();

// Carrega `.env.local` (ignorado pelo Git) sem dependências externas. Variáveis já definidas no
// ambiente têm precedência.
for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError || error instanceof CredentialError) {
    logger.log('error', error.message);
    process.exit(1);
  }
  throw error;
}

const snapshots = config.credentials
  ? createSnapshotService({
      client: createGraphQLClient({ credentials: config.credentials, timeoutMs: config.requestTimeoutMs }),
      cacheTtlMs: config.cacheTtlMs,
      minRefreshIntervalMs: config.minRefreshIntervalMs,
    })
  : null;

const auth = createAuthService({
  admin: config.admin,
  // Administrador único: acesso a todos os repositórios da allowlist do servidor.
  scope: config.allowedRepositories,
  secureCookie: config.secureCookie,
  ...DEFAULT_AUTH_LIMITS,
});
if (!auth.configured) {
  logger.log(
    'warn',
    'Nenhum administrador configurado: o login está indisponível e as rotas privadas responderão 401. ' +
      'Defina ACC_ADMIN_EMAIL e ACC_ADMIN_PASSWORD_HASH (npm run auth:hash-password).',
  );
}

// Projetos (Issue #004) e tarefas (Issue #005): arquivos locais validados na abertura.
// Corrompido → o servidor não inicia (e o arquivo não é sobrescrito).
let projects;
let tasks;
try {
  projects = await openProjectStore({ filePath: config.projectsFile, allowedRepositories: config.allowedRepositories });
  tasks = await openTaskStore({ filePath: config.tasksFile });
} catch (error) {
  logger.log('error', error instanceof DataFileError ? error.message : 'Falha ao abrir os arquivos de dados.');
  process.exit(1);
}

const handler = createRequestHandler({ config, snapshots, auth, projects, tasks, logger });
const server = createServer((req, res) => {
  void handler(req, res);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

if (config.credentials?.kind === 'gh-cli') {
  // Falha cedo se o `gh` não estiver instalado/autenticado. O token obtido fica só no cache do
  // provedor; nada dele é registrado.
  try {
    await config.credentials.getAuthorizationHeader();
  } catch {
    logger.log('error', GH_CLI_ERROR_MESSAGE);
    process.exit(1);
  }
  logger.log(
    'warn',
    'Modo gh-cli (somente desenvolvimento local): o token do GitHub CLI costuma ter permissões amplas, ' +
      'inclusive de escrita. O servidor continua restrito a leitura, loopback e consultas aprovadas.',
  );
}

server.listen(config.port, config.host, () => {
  logger.log('info', 'Servidor iniciado (GitHub somente leitura, acesso com login)', {
    url: `http://${config.host}:${config.port}`,
    authMode: config.credentials ? config.credentials.kind : 'nenhuma (modo demonstração)',
    repositories: config.allowedRepositories.join(', '),
    adminConfigured: auth.configured,
  });
});
