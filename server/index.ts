import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { acquireInstanceLock, ADMIN_RECONCILE_PENDING, adminReleasePending } from './admin/instance.ts';
import { createPasswordConfirmer, createStepUpRegistry } from './approvals/identity.ts';
import { createEnvKeyProvider, createFileKeyProvider } from './approvals/keyProvider.ts';
import { createMaintenanceScheduler } from './approvals/maintenance.ts';
import { createApprovalService } from './approvals/service.ts';
import { openApprovalStore, type ApprovalStore } from './approvals/store.ts';
import { ADMIN_USER_ID, createAuthService, DEFAULT_AUTH_LIMITS } from './auth/adminAuth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { CredentialError } from './auth/credentials.ts';
import { GH_CLI_ERROR_MESSAGE } from './auth/ghCli.ts';
import { createGraphQLClient, createRestCompareClient } from './github/client.ts';
import { createPullRequestReader } from './github/prReader.ts';
import { createContentManager } from './gateway/content.ts';
import { createClaudeOrders, type ClaudeOrders } from './gateway/orders.ts';
import { createGateway } from './gateway/service.ts';
import { GATEWAY_CONTENT_KEY_DOMAIN, GATEWAY_KEY_DOMAIN, openGatewayStore, type GatewayStore } from './gateway/store.ts';
import { assistedProfileAvailable } from './limits/providers.ts';
import { openSealedBlobStore } from './storage/sealedBlobs.ts';
import { createRequestHandler } from './http/app.ts';
import { createConsoleLogger } from './logger.ts';
import { openProjectStore } from './projects/projectStore.ts';
import { DataFileError } from './storage/jsonFile.ts';
import { openTaskStore } from './tasks/taskStore.ts';
import { createAuditSequence, openAuditLog } from './audit/auditLog.ts';
import { createSnapshotService } from './snapshotService.ts';
import type { ApprovalsRuntime } from './http/approvalRoutes.ts';
import { DEFAULT_POLICY } from './policy/defaultPolicy.ts';
import { createBarrierGate, type BarrierAuthority } from './queue/barrierGate.ts';
import { openQueueStore, type QueueStore } from './queue/store.ts';
import { deriveSubkey, QUEUE_KEY_DOMAIN } from './storage/subkeys.ts';

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

// Lock de instância (Issue #008, P1 — R1): um único processo do ACC por `ACC_DATA_DIR`, obtido
// ANTES de abrir qualquer arquivo de dados. O comando local `admin:release-barrier` obtém o mesmo
// lock: o servidor não sobe com o comando ativo e o comando não roda com o servidor ativo.
const dataDir = dirname(config.auditFile);
let instanceLock;
try {
  instanceLock = await acquireInstanceLock(dataDir);
} catch {
  logger.log('error', 'Outra instância do ACC ou comando administrativo ativo (lock de instância). Veja docs/BARRIER_RELEASE.md.', { event: 'instance_locked' });
  process.exit(1);
}
const exitWithLockReleased = async (code: number): Promise<never> => {
  await instanceLock.release().catch(() => undefined);
  process.exit(code);
};

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
  await exitWithLockReleased(1);
}

// Aprovações humanas (Issue #011, PR 2). Qualquer problema deixa SÓ este subsistema indisponível
// (nega tudo); o restante do ACC, que não depende dele, continua funcionando. Caminhos e chaves
// nunca vão para o log: apenas o estado e o motivo-token.
let approvals: ApprovalsRuntime | null = null;
let approvalStore: ApprovalStore | null = null;
// Liberação administrativa pendente (diário do comando local, R2): as aprovações ficam
// INDISPONÍVEIS (nega tudo) até o comando reconciliar; o restante do ACC sobe normalmente.
const releasePending = config.approvals.state === 'configured' && (await adminReleasePending(dataDir));
if (releasePending) {
  logger.log('warn', 'Aprovações indisponíveis: liberação administrativa pendente de reconciliação (npm run admin:release-barrier).', { event: 'approvals_unavailable', reason: ADMIN_RECONCILE_PENDING });
} else if (config.approvals.state === 'invalid') {
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

// Fila de execução (Issue #012, PR 1): fundação persistente DORMENTE. Nada é admitido, agendado
// nem despachado (sem rota, sem temporizador, sem executor). Ao abrir, o portão reenvia à
// autoridade de barreira (#011) os pedidos pendentes e, se a integridade da fila estiver em dúvida,
// aciona a barreira global. Caminhos e chaves nunca vão para o log.
let queueStore: QueueStore | null = null;
if (config.queue.state === 'invalid') {
  logger.log('warn', 'Fila indisponível: configuração inválida.', { event: 'queue_config_invalid', reason: config.queue.reason });
} else if (config.queue.state === 'configured' && config.approvals.state === 'configured') {
  const settings = config.approvals;
  const environment = { env: process.env };
  const keyProvider = settings.key.kind === 'env' ? createEnvKeyProvider(process.env) : createFileKeyProvider(settings.key.path, environment);
  // A MESMA autoridade vai para o armazenamento (confirma remoções de pedidos, R2) e para o portão.
  const service = approvals?.service ?? null;
  const authority: BarrierAuthority | null = service
    ? { status: () => service.status(), barriers: () => service.barriers(), engage: (input) => service.engageBarrier(input) }
    : null;
  try {
    queueStore = await openQueueStore({
      authority,
      queueDir: config.queue.queueDir,
      anchorDir: settings.anchorDir,
      approvalsDir: settings.approvalsDir,
      environment,
      initialize: config.queue.initialize,
      loadKey: async () => {
        const master = await keyProvider.load();
        try {
          return deriveSubkey(master.key, QUEUE_KEY_DOMAIN);
        } finally {
          master.key.fill(0); // Cópia local da chave principal: descartada após a derivação.
        }
      },
    });
    const gate = createBarrierGate({ authority, store: queueStore });
    const reconciled = await gate.reconcile();
    const status = queueStore.status();
    const decision = gate.check(null);
    logger.log(status.state === 'available' ? 'info' : 'warn', 'Fila de execução (dormente)', {
      event: 'queue_opened',
      state: status.state,
      reason: status.reason ?? 'none',
      openedAs: queueStore.openedAs() ?? 'none',
      barriersConfirmed: reconciled.confirmed,
      barriersFailed: reconciled.failed,
      blocked: decision.open ? 'no' : decision.reason,
    });
  } catch {
    logger.log('error', 'Fila indisponível: falha ao abrir o armazenamento.', { event: 'queue_open_failed' });
  }
}

// Agent Gateway (Issue #008, PR 2): SÓ o canal ASSISTIDO do Claude Code. Nenhum adaptador é
// registrado (o canal assistido não chama provedor), não há fila, executor nem temporizador de
// invocação, e `REAL_EXECUTION_ENABLED` continua `false`. O ACC prepara a ordem, a pessoa usa o
// Claude Code FORA do ACC e o ACC só LÊ o PR no GitHub (somente leitura, credencial da #002).
let claudeOrders: { orders: ClaudeOrders; status: () => { state: string; reason: string | null } } | null = null;
let gatewayStore: GatewayStore | null = null;
if (config.gateway.state === 'invalid') {
  logger.log('warn', 'Agent Gateway indisponível: configuração inválida.', { event: 'gateway_config_invalid', reason: config.gateway.reason });
} else if (config.gateway.state === 'configured' && config.approvals.state === 'configured' && approvals && projects && tasks) {
  const settings = config.approvals;
  const gatewaySettings = config.gateway;
  const environment = { env: process.env };
  const keyProvider = settings.key.kind === 'env' ? createEnvKeyProvider(process.env) : createFileKeyProvider(settings.key.path, environment);
  const subkey = (domain: string) => async () => {
    const master = await keyProvider.load();
    try {
      return deriveSubkey(master.key, domain);
    } finally {
      master.key.fill(0); // Cópia local da chave principal: descartada após a derivação.
    }
  };
  const runtime = approvals;
  const projectStore = projects;
  const taskStore = tasks;
  try {
    const queueDir = config.queue.state === 'configured' ? [config.queue.queueDir] : [];
    const store = await openGatewayStore({
      gatewayDir: gatewaySettings.gatewayDir,
      anchorDir: settings.anchorDir,
      separateFrom: [gatewaySettings.contentDir, settings.approvalsDir, ...queueDir],
      environment,
      loadKey: subkey(GATEWAY_KEY_DOMAIN),
      initialize: gatewaySettings.initialize,
    });
    gatewayStore = store;
    const blobs = await openSealedBlobStore({ dir: gatewaySettings.contentDir, environment, loadKey: subkey(GATEWAY_CONTENT_KEY_DOMAIN), separateFrom: [gatewaySettings.gatewayDir, settings.anchorDir, settings.approvalsDir, ...queueDir] });
    const service = runtime.service;
    const verifier = service.verifierFor('gateway');
    const gateway = createGateway({
      store,
      content: createContentManager({ store, blobs }),
      adapters: {},
      projects: projectStore,
      tasks: taskStore,
      // Só referências a TAREFAS do mesmo projeto, resolvidas aqui (dado não confiável no pacote).
      resolveData: ({ ownerId, projectId, kind, ref }) => {
        if (kind !== 'task') return null;
        const task = taskStore.get(ownerId, projectId, ref);
        return task ? `Tarefa: ${task.title}\n\n${task.description}` : null;
      },
      approvals: { request: (i) => service.request(i), reserve: (i) => service.reserve(i), recordOutcome: (i) => service.recordOutcome(i), confirmOwner: (i) => service.confirmOwner(i) },
      approvalVerifier: { id: verifier.id, kind: verifier.kind, verifyGrant: (grant) => verifier.verifyGrant(grant), verify: (approval) => verifier.verify(approval) },
      identity: { consume: (proofId, ctx) => runtime.identity.consume(proofId, ctx) },
      // Barreira/kill switch da #011 (o mesmo ledger que as aprovações). Qualquer dúvida = bloqueado.
      barriers: {
        blocked: (projectId) => {
          const status = service.status();
          if (status.state !== 'available') return `authority_${status.state}`;
          const b = service.barriers();
          if (b.durable.global !== null) return 'global_barrier';
          if (b.volatile.includes('global')) return 'volatile_barrier';
          if (Object.hasOwn(b.durable.projects, projectId) && b.durable.projects[projectId] != null) return 'project_barrier';
          if (b.volatile.includes(`project:${projectId}`)) return 'volatile_barrier';
          return null;
        },
      },
      // Catálogo da #022: só `claude-code/subscription_assisted` disponível (D-08.3).
      assistedProfileAvailable: () => assistedProfileAvailable(),
    });
    // Leitura do GitHub com a MESMA credencial somente leitura da #002 (sem credencial → verificação indisponível).
    const reader = config.credentials
      ? createPullRequestReader({
          graphql: createGraphQLClient({ credentials: config.credentials, timeoutMs: config.requestTimeoutMs }),
          rest: createRestCompareClient({ credentials: config.credentials, timeoutMs: config.requestTimeoutMs }),
          allowedRepositories: config.allowedRepositories,
        })
      : null;
    const orders = createClaudeOrders({
      gateway,
      reader,
      approvalsFor: (ownerId, scopeId) =>
        service.status().state === 'unavailable'
          ? []
          : service
              .list(ownerId)
              .filter((a) => a.binding.resource.type === 'gateway_scope' && a.binding.resource.id === scopeId)
              .map((a) => ({ id: a.id, action: a.binding.action, state: a.state })),
    });
    claudeOrders = { orders, status: () => store.status() };
    createMaintenanceScheduler({
      run: async () => {
        if (store.status().state === 'available') await gateway.sweep();
      },
      onError: (reason) => logger.log('warn', 'Falha na manutenção do gateway', { event: 'gateway_maintenance_failed', reason }),
    });
    logger.log(store.status().state === 'available' ? 'info' : 'warn', 'Agent Gateway (somente canal assistido do Claude Code)', {
      event: 'gateway_opened',
      state: store.status().state,
      reason: store.status().reason ?? 'none',
      githubReader: reader ? 'configured' : 'none',
    });
  } catch {
    claudeOrders = null;
    logger.log('error', 'Agent Gateway indisponível: falha ao abrir o armazenamento.', { event: 'gateway_open_failed' });
  }
} else if (config.gateway.state === 'configured') {
  logger.log('warn', 'Agent Gateway indisponível: exige aprovações configuradas.', { event: 'gateway_requires_approvals' });
}

const handler = createRequestHandler({ config, snapshots, auth, projects, tasks, audit, approvals, claudeOrders, logger });
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
    await exitWithLockReleased(1);
  }
  logger.log(
    'warn',
    'Modo gh-cli (somente desenvolvimento local): o token do GitHub CLI costuma ter permissões amplas, ' +
      'inclusive de escrita. O servidor continua restrito a leitura, loopback e consultas aprovadas.',
  );
}

// Encerramento: libera os bloqueios de escritor único (aprovações e fila) e, por último, o lock de
// instância (depois de fechar todos os armazenamentos).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void Promise.allSettled([gatewayStore?.close(), queueStore?.close(), approvalStore?.close()])
      .then(() => instanceLock.release())
      .finally(() => process.exit(0));
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
