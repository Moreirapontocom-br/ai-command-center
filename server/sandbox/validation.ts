import { AGENT_IDS } from '../../shared/contracts.ts';
import {
  CREDENTIAL_SCOPES,
  SANDBOX_LIMITS,
  type SandboxRequestInput,
  type UntrustedInput,
} from './contracts.ts';

/**
 * Validação da solicitação de sandbox (Issue #021). Tudo é recusado salvo o que está
 * explicitamente previsto. Mensagens são tokens fixos: nunca repetem o valor recebido.
 */

export class SandboxValidationError extends Error {
  name = 'SandboxValidationError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Hostname DNS em minúsculas, sem porta, sem curinga. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const INPUT_REF = /^[A-Za-z0-9._/#:-]{1,200}$/;

/** Branches protegidas que um sandbox nunca pode usar como branch de trabalho. */
const PROTECTED_BRANCHES = new Set(['main', 'master', 'head', 'trunk', 'develop', 'production', 'release']);
/** Destinos de rede sempre proibidos, mesmo que a política futura os liste. */
const FORBIDDEN_HOST = /(^|\.)(localhost|local|internal|metadata\.google\.internal)$|^metadata\./;

const fail = (code: string): never => {
  throw new SandboxValidationError(code);
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string) {
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every((key) => present.includes(key))) fail(code);
}

/**
 * Branch de trabalho DERIVADA pelo servidor: `acc/<agente>/<tarefa>-<execução>`. Nunca vem do
 * chamador. A verificação abaixo é defesa extra (também usada para validar specs de provedores).
 */
export function workBranchFor(agentId: string, taskId: string, requestId: string): string {
  return assertWorkBranch(`acc/${agentId}/${taskId.slice(0, 8)}-${requestId.slice(0, 8)}`);
}

export function assertWorkBranch(branch: string): string {
  const pattern = /^acc\/[a-z0-9-]{1,32}\/[0-9a-f]{8}-[0-9a-f]{8}$/;
  if (typeof branch !== 'string' || !pattern.test(branch)) fail('invalid_work_branch');
  const parts = branch.toLowerCase().split('/');
  if (parts.some((part) => PROTECTED_BRANCHES.has(part))) fail('protected_branch');
  return branch;
}

/**
 * Id lógico de workspace: o provedor real mapeia para um local isolado. Nunca é um caminho do
 * host: recusa separadores, `..`, letras de unidade, NUL, `~` e qualquer caractere fora do padrão.
 */
export function assertWorkspaceId(id: string): string {
  if (typeof id !== 'string' || !/^ws-[0-9a-f]{32}$/.test(id)) fail('invalid_workspace');
  return id;
}

/** Recusa qualquer coisa que pareça caminho de arquivo (para contratos que recebam nomes). */
export function isSafeLogicalName(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9._-]{1,64}$/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..')
  );
}

function parseHost(host: unknown): string {
  if (typeof host !== 'string') return fail('invalid_network_host');
  if (host.trim() !== host || !HOSTNAME.test(host)) fail('invalid_network_host');
  if (FORBIDDEN_HOST.test(host)) fail('forbidden_network_host');
  return host;
}

function parseInput(value: unknown): UntrustedInput {
  if (!isPlainObject(value)) return fail('invalid_input');
  exactKeys(value, ['kind', 'ref'], 'invalid_input');
  if (!['issue', 'pull_request', 'task'].includes(value.kind as string)) fail('invalid_input');
  if (typeof value.ref !== 'string' || !INPUT_REF.test(value.ref) || value.ref.includes('..')) fail('invalid_input');
  return { kind: value.kind as UntrustedInput['kind'], ref: value.ref as string };
}

export function parseSandboxRequest(raw: unknown): SandboxRequestInput {
  if (!isPlainObject(raw)) return fail('invalid_request');
  exactKeys(
    raw,
    ['projectId', 'taskId', 'agentId', 'repository', 'baseSha', 'networkAllowlist', 'credentialScopes', 'limits', 'inputs'],
    'invalid_request',
  );
  if (typeof raw.projectId !== 'string' || !UUID.test(raw.projectId)) fail('invalid_project');
  if (typeof raw.taskId !== 'string' || !UUID.test(raw.taskId)) fail('invalid_task');
  if (typeof raw.agentId !== 'string' || !(AGENT_IDS as readonly string[]).includes(raw.agentId)) fail('invalid_agent');

  const repository = raw.repository;
  const baseSha = raw.baseSha;
  if ((repository === null) !== (baseSha === null)) fail('invalid_git');
  if (repository !== null && (typeof repository !== 'string' || !REPOSITORY.test(repository))) fail('invalid_git');
  if (baseSha !== null && (typeof baseSha !== 'string' || !SHA.test(baseSha))) fail('invalid_git');

  if (!Array.isArray(raw.networkAllowlist) || raw.networkAllowlist.length > SANDBOX_LIMITS.maxNetworkHosts) fail('invalid_network');
  const hosts = (raw.networkAllowlist as unknown[]).map(parseHost);
  if (new Set(hosts).size !== hosts.length) fail('invalid_network');

  if (!Array.isArray(raw.credentialScopes)) fail('invalid_credentials');
  const scopes = raw.credentialScopes as unknown[];
  for (const scope of scopes) if (!(CREDENTIAL_SCOPES as readonly unknown[]).includes(scope)) fail('forbidden_credential_scope');
  if (new Set(scopes).size !== scopes.length) fail('invalid_credentials');
  if (scopes.includes('repo.write_work_branch') && repository === null) fail('invalid_credentials');

  if (!isPlainObject(raw.limits)) return fail('invalid_limits');
  exactKeys(raw.limits, ['timeoutSeconds', 'cpu', 'memoryMb', 'diskMb'], 'invalid_limits');
  const within = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;
  const { timeoutSeconds, cpu, memoryMb, diskMb } = raw.limits;
  if (
    !within(timeoutSeconds, SANDBOX_LIMITS.maxTimeoutSeconds) ||
    !within(cpu, SANDBOX_LIMITS.maxCpu) ||
    !within(memoryMb, SANDBOX_LIMITS.maxMemoryMb) ||
    !within(diskMb, SANDBOX_LIMITS.maxDiskMb)
  ) {
    fail('invalid_limits');
  }

  if (!Array.isArray(raw.inputs) || raw.inputs.length > 20) fail('invalid_input');
  return {
    projectId: raw.projectId as string,
    taskId: raw.taskId as string,
    agentId: raw.agentId as SandboxRequestInput['agentId'],
    repository: repository as string | null,
    baseSha: baseSha as string | null,
    networkAllowlist: hosts,
    credentialScopes: scopes as SandboxRequestInput['credentialScopes'],
    limits: { timeoutSeconds: timeoutSeconds as number, cpu: cpu as number, memoryMb: memoryMb as number, diskMb: diskMb as number },
    inputs: (raw.inputs as unknown[]).map(parseInput),
  };
}
