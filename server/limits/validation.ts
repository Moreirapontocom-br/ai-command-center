import { createHash } from 'node:crypto';
import { AGENT_IDS, POLICY_ACTIONS, type AgentRef, type PolicyAction } from '../../shared/contracts.ts';
import {
  HARD_CEILINGS,
  USAGE_MODES,
  type AdmissionRequestInput,
  type ControllerLimits,
  type HumanApproval,
  type UsageMode,
} from './contracts.ts';

/** Erro de validação: só um código (token), nunca o valor recebido. */
export class LimitsValidationError extends Error {
  name = 'LimitsValidationError';
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new LimitsValidationError(code);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;
export const REASON_TOKEN = /^[a-z0-9_]{1,48}$/;
const APPROVAL_ID = /^[A-Za-z0-9_:.-]{1,100}$/;
const HUMAN_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Recusa campos extras: o chamador não pode "declarar" gratuidade, saldo, aprovação etc. */
function exactKeys(value: Record<string, unknown>, keys: string[], code: string) {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(code);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(code);
}

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

export const isAgentId = (value: unknown): value is AgentRef => typeof value === 'string' && (AGENT_IDS as readonly string[]).includes(value);

export function parseAdmissionRequest(raw: unknown, limits: ControllerLimits): AdmissionRequestInput {
  if (!isPlainObject(raw)) return fail('invalid_request');
  exactKeys(
    raw,
    ['idempotencyKey', 'projectId', 'taskId', 'agentId', 'action', 'mode', 'durationSeconds', 'estimatedCostMinor', 'maxTokens'],
    'invalid_request',
  );
  if (typeof raw.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(raw.idempotencyKey)) fail('invalid_idempotency_key');
  if (typeof raw.projectId !== 'string' || !UUID.test(raw.projectId)) fail('invalid_project');
  if (typeof raw.taskId !== 'string' || !UUID.test(raw.taskId)) fail('invalid_task');
  if (!isAgentId(raw.agentId)) fail('invalid_agent');
  if (typeof raw.action !== 'string' || !Object.hasOwn(POLICY_ACTIONS, raw.action)) fail('invalid_action');
  if (!(USAGE_MODES as readonly unknown[]).includes(raw.mode)) fail('invalid_mode');
  if (!isInt(raw.durationSeconds, 1, limits.maxDurationSeconds)) fail('duration_out_of_limits');
  const mode = raw.mode as UsageMode;

  if (mode === 'metered_api') {
    // API: estimativa obrigatória (sem ela o custo é desconhecido) e teto de tokens conservador.
    if (raw.estimatedCostMinor === null) fail('cost_estimate_required');
    // Estimativa zero numa API cobrada é uma alegação de gratuidade do chamador: não é aceita.
    if (raw.estimatedCostMinor === 0) fail('free_claim_not_trusted');
    if (!isInt(raw.estimatedCostMinor, 1, HARD_CEILINGS.budgetMinor)) fail('invalid_cost_estimate');
    if (!isInt(raw.maxTokens, 1, limits.meteredApiTokenCeilingPerTask)) fail('tokens_out_of_limits');
  } else {
    // Assinatura/integração: sem quota de tokens fictícia e sem valores de consumo inventados.
    if (raw.maxTokens !== null) fail('tokens_not_applicable');
    if (raw.estimatedCostMinor !== null) fail('cost_not_applicable');
  }

  return {
    idempotencyKey: raw.idempotencyKey as string,
    projectId: raw.projectId as string,
    taskId: raw.taskId as string,
    agentId: raw.agentId as AgentRef,
    action: raw.action as PolicyAction,
    mode,
    durationSeconds: raw.durationSeconds as number,
    estimatedCostMinor: (raw.estimatedCostMinor as number | null) ?? null,
    maxTokens: (raw.maxTokens as number | null) ?? null,
  };
}

/** Impressão digital do pedido (sem aprovações): detecta reuso da mesma chave com outro conteúdo. */
export function requestFingerprint(input: AdmissionRequestInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function parseBudgetMap(value: unknown, keyOk: (key: string) => boolean): Record<string, number> {
  if (!isPlainObject(value)) return fail('invalid_limits');
  const out: Record<string, number> = {};
  for (const [key, amount] of Object.entries(value)) {
    if (!keyOk(key) || !isInt(amount, 0, HARD_CEILINGS.budgetMinor)) fail('invalid_limits');
    out[key] = amount as number;
  }
  return out;
}

/** Valida e normaliza limites propostos (ordem de chaves canônica, dentro dos tetos rígidos). */
export function parseLimits(raw: unknown): ControllerLimits {
  if (!isPlainObject(raw)) return fail('invalid_limits');
  exactKeys(raw, ['maxConcurrent', 'maxDurationSeconds', 'rateLimit', 'budget', 'meteredApiTokenCeilingPerTask'], 'invalid_limits');
  if (!isInt(raw.maxConcurrent, 1, HARD_CEILINGS.maxConcurrent)) fail('limit_out_of_bounds');
  if (!isInt(raw.maxDurationSeconds, 1, HARD_CEILINGS.maxDurationSeconds)) fail('limit_out_of_bounds');
  if (!isInt(raw.meteredApiTokenCeilingPerTask, 1, HARD_CEILINGS.meteredApiTokenCeilingPerTask)) fail('limit_out_of_bounds');
  const rate = raw.rateLimit;
  if (!isPlainObject(rate)) return fail('invalid_limits');
  exactKeys(rate, ['count', 'windowSeconds'], 'invalid_limits');
  if (!isInt(rate.count, 1, HARD_CEILINGS.rateLimitCount) || !isInt(rate.windowSeconds, 1, HARD_CEILINGS.rateLimitWindowSeconds)) {
    fail('limit_out_of_bounds');
  }
  const budget = raw.budget;
  if (!isPlainObject(budget)) return fail('invalid_limits');
  exactKeys(budget, ['globalMinor', 'perProjectMinor', 'perProviderMinor'], 'invalid_limits');
  if (!isInt(budget.globalMinor, 0, HARD_CEILINGS.budgetMinor)) fail('limit_out_of_bounds');
  const perProjectMinor = parseBudgetMap(budget.perProjectMinor, (key) => UUID.test(key));
  const perProviderMinor = parseBudgetMap(budget.perProviderMinor, isAgentId) as Partial<Record<AgentRef, number>>;
  const sortKeys = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    maxConcurrent: raw.maxConcurrent as number,
    maxDurationSeconds: raw.maxDurationSeconds as number,
    rateLimit: { count: rate.count as number, windowSeconds: rate.windowSeconds as number },
    budget: { globalMinor: budget.globalMinor as number, perProjectMinor: sortKeys(perProjectMinor), perProviderMinor: sortKeys(perProviderMinor) },
    meteredApiTokenCeilingPerTask: raw.meteredApiTokenCeilingPerTask as number,
  };
}

/** Impressão digital dos limites (alvo exato de uma aprovação `limits.change`). */
export function limitsFingerprint(limits: ControllerLimits): string {
  return `limits:${createHash('sha256').update(JSON.stringify(parseLimits(limits))).digest('hex')}`;
}

/** Valida o formato de uma aprovação humana (a checagem de alvo/validade/uso único é do controlador). */
export function parseHumanApproval(raw: unknown): HumanApproval {
  if (!isPlainObject(raw)) return fail('invalid_approval');
  exactKeys(raw, ['id', 'operation', 'target', 'approvedBy', 'approvedAt', 'expiresAt'], 'invalid_approval');
  if (typeof raw.id !== 'string' || !APPROVAL_ID.test(raw.id)) fail('invalid_approval');
  if (raw.operation !== 'limits.change' && raw.operation !== 'killswitch.release') fail('invalid_approval');
  if (typeof raw.target !== 'string' || raw.target.length > 100) fail('invalid_approval');
  const by = raw.approvedBy;
  if (!isPlainObject(by)) return fail('invalid_approval');
  exactKeys(by, ['kind', 'id'], 'invalid_approval');
  if (by.kind !== 'human' || typeof by.id !== 'string' || !HUMAN_ID.test(by.id)) fail('approver_not_human');
  // Um id de agente nunca vale como aprovador, mesmo rotulado como "human" (regra da #020).
  if (isAgentId(by.id)) fail('approver_not_human');
  if (typeof raw.approvedAt !== 'string' || typeof raw.expiresAt !== 'string') fail('invalid_approval');
  return raw as unknown as HumanApproval;
}
