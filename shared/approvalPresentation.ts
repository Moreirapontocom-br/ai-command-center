import { canonicalJson, sha256Hex } from './approvalDigest.ts';
import { AGENT_IDS, POLICY_ACTIONS, type ApprovalBindingView } from './contracts.ts';

/**
 * Apresentação verificável dos parâmetros de uma aprovação (Issue #011, PR 2, correção R1).
 *
 * O `paramsDigest` do vínculo só prova a integridade; sozinho não mostra ao administrador O QUE
 * está sendo aprovado. Por isso o componente do SERVIDOR que pede a aprovação entrega também os
 * parâmetros exatos (`presentation`), num formato FECHADO por tipo. O núcleo só aceita a
 * apresentação se ela reproduzir o `paramsDigest` do vínculo; a interface exibe os parâmetros
 * (somente leitura), recalcula os dois resumos e, ao aprovar, envia o `presentationDigest`, que
 * prende o vínculo inteiro aos parâmetros exibidos.
 *
 * Regras (falha fechada):
 * - aprovar exige apresentação presente, no formato do tipo esperado para o solicitante e para a
 *   ação, coerente com o vínculo e com o resumo; qualquer falha → aprovação bloqueada;
 * - rejeitar nunca depende da apresentação (pedido incompleto pode ser recusado com segurança);
 * - um `paramsDigest` coincidente NÃO basta: sem os parâmetros apresentados não há aprovação;
 * - formatos fechados, só identificadores, números e valores de lista fechada: não há campo
 *   livre onde caiba um segredo; valores com aparência de credencial são recusados mesmo assim.
 *
 * Arquivo sem dependências do servidor: roda no navegador e no servidor (mesmo cálculo).
 */

export const PRESENTATION_KINDS = ['sandbox', 'admission', 'approvals.retention_change', 'approvals.history_purge'] as const;
export type ApprovalPresentationKind = (typeof PRESENTATION_KINDS)[number];

/** Espelhos das listas do servidor (um teste garante que são iguais às de `server/`). */
export const PRESENTATION_CREDENTIAL_SCOPES = ['repo.read', 'repo.write_work_branch'] as const;
export const PRESENTATION_USAGE_MODES = ['subscription_assisted', 'official_integration', 'metered_api'] as const;
export const PRESENTATION_INPUT_KINDS = ['issue', 'pull_request', 'task'] as const;
export const PRESENTATION_SANDBOX_MAX = { timeoutSeconds: 30 * 60, cpu: 2, memoryMb: 4096, diskMb: 10_240, networkHosts: 10, inputs: 20 } as const;
/** Tamanho máximo da apresentação canônica (bytes UTF-8). */
export const PRESENTATION_MAX_BYTES = 8192;

export interface SandboxPresentationParams {
  requestId: string;
  repository: string | null;
  network: { default: 'deny'; allow: string[] };
  credentials: {
    scopes: Array<(typeof PRESENTATION_CREDENTIAL_SCOPES)[number]>;
    ttlSeconds: number;
    productionSecrets: 'denied';
    productionDatabase: 'denied';
  };
  limits: { timeoutSeconds: number; cpu: number; memoryMb: number; diskMb: number };
  inputs: Array<{ kind: (typeof PRESENTATION_INPUT_KINDS)[number]; ref: string; trust: 'untrusted' }>;
}

export interface AdmissionPresentationParams {
  projectId: string;
  taskId: string;
  agentId: string;
  action: string;
  mode: (typeof PRESENTATION_USAGE_MODES)[number];
  durationSeconds: number;
  estimatedCostMinor: number | null;
  maxTokens: number | null;
}

export type ApprovalPresentation =
  | { kind: 'sandbox'; params: SandboxPresentationParams }
  | { kind: 'admission'; params: AdmissionPresentationParams }
  | { kind: 'approvals.retention_change'; params: { days: number } }
  | { kind: 'approvals.history_purge'; params: { before: string } };

/** Motivos (tokens) de uma apresentação inválida. Nunca contêm valores. */
export type PresentationIssue =
  | 'presentation_missing'
  | 'presentation_invalid'
  | 'presentation_secret_like'
  | 'presentation_unsupported'
  | 'presentation_mismatch';

export class PresentationError extends Error {
  name = 'PresentationError';
  readonly code: PresentationIssue;
  constructor(code: PresentationIssue) {
    super(code);
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const INPUT_REF = /^[A-Za-z0-9._/#:-]{1,200}$/;
/** Aparência de credencial (defesa extra): tokens do GitHub, chaves de API, AWS, Slack, PEM. */
const SECRET_LIKE = /(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_|sk-[A-Za-z0-9_-]{8,}|sk_(live|test)_|AKIA[0-9A-Z]{12,}|xox[abprs]-|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/;

const fail = (code: PresentationIssue = 'presentation_invalid'): never => {
  throw new PresentationError(code);
};

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlain(value)) fail();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) fail();
  return record;
}

const int = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value as number;
};
const str = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== 'string' || !pattern.test(value)) fail();
  if (SECRET_LIKE.test(value as string)) fail('presentation_secret_like');
  return value as string;
};
const oneOf = <T extends string>(value: unknown, list: readonly T[]): T => {
  if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) fail();
  return value as T;
};
const literal = <T extends string>(value: unknown, expected: T): T => {
  if (value !== expected) fail();
  return expected;
};
function uniqueList<T>(value: unknown, max: number, item: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail();
  const out = (value as unknown[]).map(item);
  if (new Set(out.map((v) => canonicalJson(v))).size !== out.length) fail();
  return out;
}

function parseSandbox(raw: unknown): SandboxPresentationParams {
  const p = exact(raw, ['requestId', 'repository', 'network', 'credentials', 'limits', 'inputs']);
  const network = exact(p.network, ['default', 'allow']);
  const credentials = exact(p.credentials, ['scopes', 'ttlSeconds', 'productionSecrets', 'productionDatabase']);
  const limits = exact(p.limits, ['timeoutSeconds', 'cpu', 'memoryMb', 'diskMb']);
  const max = PRESENTATION_SANDBOX_MAX;
  return {
    requestId: str(p.requestId, UUID),
    repository: p.repository === null ? null : str(p.repository, REPOSITORY),
    network: {
      default: literal(network.default, 'deny'),
      allow: uniqueList(network.allow, max.networkHosts, (h) => str(h, HOSTNAME)),
    },
    credentials: {
      scopes: uniqueList(credentials.scopes, PRESENTATION_CREDENTIAL_SCOPES.length, (s) => oneOf(s, PRESENTATION_CREDENTIAL_SCOPES)),
      ttlSeconds: int(credentials.ttlSeconds, 1, max.timeoutSeconds),
      productionSecrets: literal(credentials.productionSecrets, 'denied'),
      productionDatabase: literal(credentials.productionDatabase, 'denied'),
    },
    limits: {
      timeoutSeconds: int(limits.timeoutSeconds, 1, max.timeoutSeconds),
      cpu: int(limits.cpu, 1, max.cpu),
      memoryMb: int(limits.memoryMb, 1, max.memoryMb),
      diskMb: int(limits.diskMb, 1, max.diskMb),
    },
    inputs: uniqueList(p.inputs, max.inputs, (raw) => {
      const i = exact(raw, ['kind', 'ref', 'trust']);
      const ref = str(i.ref, INPUT_REF);
      if (ref.includes('..')) fail();
      return { kind: oneOf(i.kind, PRESENTATION_INPUT_KINDS), ref, trust: literal(i.trust, 'untrusted') };
    }),
  };
}

function parseAdmission(raw: unknown): AdmissionPresentationParams {
  const p = exact(raw, ['projectId', 'taskId', 'agentId', 'action', 'mode', 'durationSeconds', 'estimatedCostMinor', 'maxTokens']);
  const mode = oneOf(p.mode, PRESENTATION_USAGE_MODES);
  const metered = mode === 'metered_api';
  // Mesmas regras da admissão (#022): custo e tokens só em API cobrada, e então obrigatórios.
  const estimatedCostMinor = metered ? int(p.estimatedCostMinor, 1, Number.MAX_SAFE_INTEGER) : p.estimatedCostMinor === null ? null : fail();
  const maxTokens = metered ? int(p.maxTokens, 1, Number.MAX_SAFE_INTEGER) : p.maxTokens === null ? null : fail();
  if (typeof p.action !== 'string' || !Object.hasOwn(POLICY_ACTIONS, p.action)) fail();
  return {
    projectId: str(p.projectId, UUID),
    taskId: str(p.taskId, UUID),
    agentId: oneOf(p.agentId, AGENT_IDS),
    action: p.action as string,
    mode,
    durationSeconds: int(p.durationSeconds, 1, 7 * 24 * 60 * 60),
    estimatedCostMinor,
    maxTokens,
  };
}

/**
 * Valida a apresentação no formato FECHADO do tipo e devolve uma cópia nova (só os campos
 * conhecidos). Qualquer campo extra/ausente, tipo errado ou valor fora da lista → erro.
 */
export function parsePresentation(raw: unknown): ApprovalPresentation {
  if (raw === undefined || raw === null) fail('presentation_missing');
  const p = exact(raw, ['kind', 'params']);
  const kind = oneOf(p.kind, PRESENTATION_KINDS);
  let presentation: ApprovalPresentation;
  switch (kind) {
    case 'sandbox':
      presentation = { kind, params: parseSandbox(p.params) };
      break;
    case 'admission':
      presentation = { kind, params: parseAdmission(p.params) };
      break;
    case 'approvals.retention_change': {
      const params = exact(p.params, ['days']);
      presentation = { kind, params: { days: int(params.days, 1, 100 * 365) } };
      break;
    }
    case 'approvals.history_purge': {
      const params = exact(p.params, ['before']);
      const before = typeof params.before === 'string' ? params.before : fail();
      const ms = Date.parse(before);
      if (!Number.isFinite(ms) || new Date(ms).toISOString() !== before) fail();
      presentation = { kind, params: { before } };
      break;
    }
  }
  let size: number;
  try {
    size = new TextEncoder().encode(canonicalJson(presentation)).length;
  } catch {
    return fail();
  }
  if (size > PRESENTATION_MAX_BYTES) fail();
  return presentation;
}

/**
 * Tipo de apresentação que o SERVIDOR espera para o pedido (nunca o que o chamador declara).
 * `null` = sem apresentação conhecida para este pedido → nunca aprovável.
 */
export function expectedPresentationKind(binding: Pick<ApprovalBindingView, 'action'>, requestedBy: { kind: 'system' | 'human'; id: string }): ApprovalPresentationKind | null {
  if (requestedBy.kind === 'system' && requestedBy.id === 'sandbox') return binding.action === 'sandbox.execute' ? 'sandbox' : null;
  if (requestedBy.kind === 'system' && requestedBy.id === 'limits') return Object.hasOwn(POLICY_ACTIONS, binding.action) ? 'admission' : null;
  if (requestedBy.kind === 'human' && (binding.action === 'approvals.retention_change' || binding.action === 'approvals.history_purge')) return binding.action;
  return null;
}

/** Coerência da apresentação com os demais campos do vínculo (além do resumo dos parâmetros). */
function consistent(binding: ApprovalBindingView, p: ApprovalPresentation): boolean {
  switch (p.kind) {
    case 'sandbox':
      // Sem repositório não há SHA; com repositório, o SHA é obrigatório.
      return binding.action === 'sandbox.execute' && binding.subject.kind === 'agent' && (p.params.repository === null) === (binding.target.sha === null);
    case 'admission': {
      const a = p.params;
      const actionOk = a.action === binding.action || (binding.action === 'spend.create' && a.mode === 'metered_api');
      return (
        actionOk &&
        binding.projectId === a.projectId &&
        binding.resource.type === 'task' &&
        binding.resource.id === a.taskId &&
        binding.subject.kind === 'agent' &&
        binding.subject.id === a.agentId
      );
    }
    case 'approvals.retention_change':
    case 'approvals.history_purge':
      return binding.action === p.kind && binding.subject.kind === 'human' && binding.projectId === null;
  }
}

/** Resumo dos parâmetros exatamente como o servidor calcula (`paramsDigestOf`). */
export function presentationParamsDigest(presentation: ApprovalPresentation, sha256: (text: string) => string = sha256Hex): string {
  return `${presentation.kind}:${sha256(canonicalJson(presentation.params))}`;
}

/** Resumo que prende o vínculo inteiro (pelo `bindingDigest`) aos parâmetros apresentados. */
export function approvalPresentationDigest(bindingDigest: string, presentation: ApprovalPresentation, sha256: (text: string) => string = sha256Hex): string {
  return sha256(`acc-approval-presentation:v1\n${canonicalJson({ bindingDigest, kind: presentation.kind, params: presentation.params })}`);
}

export type PresentationCheck = { ok: true; presentation: ApprovalPresentation; digest: string } | { ok: false; reason: PresentationIssue };

/**
 * Verificação completa: formato fechado, tipo esperado, coerência com o vínculo e igualdade do
 * resumo dos parâmetros. `sha256` permite ao servidor usar `node:crypto` (o navegador usa o local).
 */
export function checkPresentation(
  input: { binding: ApprovalBindingView; bindingDigest: string; requestedBy: { kind: 'system' | 'human'; id: string }; presentation: unknown },
  sha256: (text: string) => string = sha256Hex,
): PresentationCheck {
  try {
    const presentation = parsePresentation(input.presentation);
    const expected = expectedPresentationKind(input.binding, input.requestedBy);
    if (expected === null) return { ok: false, reason: 'presentation_unsupported' };
    if (presentation.kind !== expected || !consistent(input.binding, presentation)) return { ok: false, reason: 'presentation_mismatch' };
    if (presentationParamsDigest(presentation, sha256) !== input.binding.paramsDigest) return { ok: false, reason: 'presentation_mismatch' };
    return { ok: true, presentation, digest: approvalPresentationDigest(input.bindingDigest, presentation, sha256) };
  } catch (error) {
    return { ok: false, reason: error instanceof PresentationError ? error.code : 'presentation_invalid' };
  }
}
