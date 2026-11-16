import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createPasswordConfirmer, createStepUpRegistry } from './approvals/identity.ts';
import { createEnvKeyProvider, createFileKeyProvider } from './approvals/keyProvider.ts';
import { createMaintenanceScheduler } from './approvals/maintenance.ts';
import { createApprovalService } from './approvals/service.ts';
import { openApprovalStore, type ApprovalStore } from './approvals/store.ts';
import { ADMIN_USER_ID, createAuthService, DEFAULT_AUTH_LIMITS } from './auth/adminAuth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { CredentialError } from './auth/credentials.ts';
import { GH_CLI_ERROR_MESSAGE } from './auth/ghCli.ts';
import { createGraphQLClient } from './github/client.ts';
import { createRequestHandler } from './http/app.ts';
import { createConsoleLogger } from './logger.ts';
import { openProjectStore } from './projects/projectStore.ts';
import { DataFileError } from './storage/jsonFile.ts';
import { openTaskStore } from './tasks/taskStore.ts';
import { createAuditSequence, openAuditLog } from './audit/auditLog.ts';
import { createSnapshotService } from './snapshotService.ts';
import type { ApprovalsRuntime } from './http/approvalRoutes.ts';
import { DEFAULT_POLICY } from './policy/defaultPolicy.ts';

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
// Auditoria (Issue #006): sequência global compartilhada pelos três arquivos.
const sequence = createAuditSequence();
let projects;
let tasks;
let audit;
try {
  projects = await openProjectStore({ filePath: config.projectsFile, allowedRepositories: config.allowedRepositories, sequence });
  tasks = await openTaskStore({ filePath: config.tasksFile, sequence });
  audit = await openAuditLog({ filePath: config.auditFile, sequence });
} catch (error) {
  logger.log('error', error instanceof DataFileError ? error.message : 'Falha ao abrir os arquivos de dados.');
  process.exit(1);
}

// Aprovações humanas (Issue #011, PR 2). Qualquer problema deixa SÓ este subsistema indisponível
// (nega tudo); o restante do ACC, que não depende dele, continua funcionando. Caminhos e chaves
// nunca vão para o log: apenas o estado e o motivo-token.
let approvals: ApprovalsRuntime | null = null;
let approvalStore: ApprovalStore | null = null;
if (config.approvals.state === 'invalid') {
  logger.log('warn', 'Aprovações indisponíveis: configuração inválida.', { event: 'approvals_config_invalid', reason: config.approvals.reason });
} else if (config.approvals.state === 'disabled') {
  logger.log('warn', 'Aprovações não configuradas (ACC_APPROVALS_DIR, ACC_APPROVALS_ANCHOR_DIR e chave): subsistema indisponível.', { event: 'approvals_disabled' });
} else {
  const settings = config.approvals;
  const environment = { env: process.env };
  try {
    approvalStore = await openApprovalStore({
      approvalsDir: settings.approvalsDir,
      anchorDir: settings.anchorDir,
      keyProvider: settings.key.kind === 'env' ? createEnvKeyProvider(process.env) : createFileKeyProvider(settings.key.path, environment),
      environment,
      initialize: settings.initialize,
    });
    const identity = createStepUpRegistry({
      confirmers: [createPasswordConfirmer(config.admin ? { userId: ADMIN_USER_ID, passwordHash: config.admin.passwordHash } : null)],
    });
    const service = createApprovalService({ store: approvalStore, identity, policyVersion: DEFAULT_POLICY.version });
    approvals = { service, identity };
    const status = service.status();
    logger.log(status.state === 'available' ? 'info' : 'warn', 'Aprovações', {
      event: 'approvals_opened',
      state: status.state,
      reason: status.reason ?? 'none',
      // Indisponível: o ledger nem é lido (nada a informar além do motivo).
      globalBarrier: status.state === 'unavailable' ? null : service.barriers().durable.global !== null,
    });
    // Manutenção periódica sem execuções simultâneas (expiração, compactação, retenção).
    createMaintenanceScheduler({
      run: async () => {
        if (service.status().state === 'available') await service.sweep();
      },
      onError: (reason) => logger.log('warn', 'Falha na manutenção das aprovações', { event: 'approvals_maintenance_failed', reason }),
    });
  } catch {
    approvals = null;
    logger.log('error', 'Aprovações indisponíveis: falha ao abrir o armazenamento.', { event: 'approvals_open_failed' });
  }
}

const handler = createRequestHandler({ config, snapshots, auth, projects, tasks, audit, approvals, logger });
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

// Encerramento: libera o bloqueio de escritor único do armazenamento de aprovações.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (approvalStore?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}

server.listen(config.port, config.host, () => {
  logger.log('info', 'Servidor iniciado (GitHub somente leitura, acesso com login)', {
    url: `http://${config.host}:${config.port}`,
    authMode: config.credentials ? config.credentials.kind : 'nenhuma (modo demonstração)',
    repositories: config.allowedRepositories.join(', '),
    adminConfigured: auth.configured,
  });
});
