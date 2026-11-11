import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { ConfigError, loadConfig } from './config.ts';
import { CredentialError } from './auth/credentials.ts';
import { GH_CLI_ERROR_MESSAGE } from './auth/ghCli.ts';
import { createGraphQLClient } from './github/client.ts';
import { createRequestHandler } from './http/app.ts';
import { createConsoleLogger } from './logger.ts';
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

const handler = createRequestHandler({ config, snapshots, logger });
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
  logger.log('info', 'Servidor somente leitura iniciado', {
    url: `http://${config.host}:${config.port}`,
    credential: config.credentials ? config.credentials.kind : 'nenhuma (modo demonstração)',
    repositories: config.allowedRepositories.join(', '),
  });
});
