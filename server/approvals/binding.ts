import { AGENT_IDS, type PolicySubject } from '../../shared/contracts.ts';
import { SHA_BOUND_ACTIONS } from '../policy/engine.ts';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { ApprovalError, classOf, type ApprovableAction, type ApprovalBinding, type ApprovalClass, type BarrierScope } from './contracts.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TOKEN = /^[A-Za-z0-9_:.#\-/]{1,200}$/;
export const REASON = /^[a-z0-9_]{1,64}$/;
const SHA = /^[0-9a-f]{40}$/;
const PARAMS = /^[A-Za-z0-9_:.-]{1,100}$/;
export const HUMAN_ID = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const COMPONENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const isAgentId = (id: string) => (AGENT_IDS as readonly string[]).includes(id);

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isPlain(value)) throw new ApprovalError('invalid_binding');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new ApprovalError('invalid_binding');
  return value;
}

function parseSubject(raw: unknown): PolicySubject {
  const s = exact(raw, ['kind', 'id']);
  if (s.kind === 'agent' && typeof s.id === 'string' && isAgentId(s.id)) return { kind: 'agent', id: s.id as PolicySubject['id'] } as PolicySubject;
  if (s.kind === 'human' && typeof s.id === 'string' && HUMAN_ID.test(s.id) && !isAgentId(s.id)) return { kind: 'human', id: s.id };
  throw new ApprovalError('invalid_binding');
}

/**
 * Valida o vínculo por completo (formato fechado, sem campos extras). Regras:
 * - ação aprovável (fora do catálogo, ou `repo.push_main`, → recusada);
 * - SHA obrigatório nas ações vinculadas a versão (`SHA_BOUND_ACTIONS` da #020);
 * - sujeito agente sempre dentro de um projeto.
 */
export function parseBinding(raw: unknown): ApprovalBinding {
  const b = exact(raw, ['action', 'projectId', 'resource', 'target', 'subject', 'paramsDigest', 'policyVersion']);
  if (typeof b.action !== 'string' || classOf(b.action) === null) throw new ApprovalError('action_not_approvable');
  const action = b.action as ApprovableAction;
  if (b.projectId !== null && (typeof b.projectId !== 'string' || !UUID.test(b.projectId))) throw new ApprovalError('invalid_binding');
  const resource = exact(b.resource, ['type', 'id']);
  if (typeof resource.type !== 'string' || !TOKEN.test(resource.type) || typeof resource.id !== 'string' || !TOKEN.test(resource.id)) {
    throw new ApprovalError('invalid_binding');
  }
  const target = exact(b.target, ['sha', 'ref']);
  if (target.sha !== null && (typeof target.sha !== 'string' || !SHA.test(target.sha))) throw new ApprovalError('invalid_binding');
  if (target.ref !== null && (typeof target.ref !== 'string' || !TOKEN.test(target.ref))) throw new ApprovalError('invalid_binding');
  if ((SHA_BOUND_ACTIONS as readonly string[]).includes(action) && target.sha === null) throw new ApprovalError('missing_sha');
  const subject = parseSubject(b.subject);
  if (subject.kind === 'agent' && b.projectId === null) throw new ApprovalError('invalid_binding');
  if (typeof b.paramsDigest !== 'string' || !PARAMS.test(b.paramsDigest)) throw new ApprovalError('invalid_binding');
  if (typeof b.policyVersion !== 'string' || !TOKEN.test(b.policyVersion)) throw new ApprovalError('invalid_binding');
  return {
    action,
    projectId: b.projectId as string | null,
    resource: { type: resource.type, id: resource.id },
    target: { sha: target.sha as string | null, ref: target.ref as string | null },
    subject,
    paramsDigest: b.paramsDigest,
    policyVersion: b.policyVersion,
  };
}

/** Resumo canônico do vínculo: o que o administrador confirma e o que o consumo exige. */
export function bindingDigest(binding: ApprovalBinding): string {
  return sha256Hex(`acc-approval-binding:v1\n${canonicalJson(binding)}`);
}

export function bindingClass(binding: ApprovalBinding): ApprovalClass {
  const cls = classOf(binding.action);
  if (cls === null) throw new ApprovalError('action_not_approvable');
  return cls;
}

/** Resumo canônico de parâmetros arbitrários (para operações internas de configuração). */
export function paramsDigestOf(kind: string, params: unknown): string {
  return `${kind}:${sha256Hex(canonicalJson(params))}`;
}

export function parseComponentId(id: unknown): string {
  if (typeof id !== 'string' || !COMPONENT_ID.test(id)) throw new ApprovalError('invalid_requester');
  return id;
}

export function scopeKey(scope: BarrierScope): string {
  return scope.kind === 'global' ? 'global' : `project:${scope.projectId}`;
}

export function parseScope(raw: unknown): BarrierScope {
  if (!isPlain(raw)) throw new ApprovalError('invalid_scope');
  if (raw.kind === 'global' && Object.keys(raw).length === 1) return { kind: 'global' };
  if (raw.kind === 'project' && Object.keys(raw).length === 2 && typeof raw.projectId === 'string' && UUID.test(raw.projectId)) {
    return { kind: 'project', projectId: raw.projectId };
  }
  throw new ApprovalError('invalid_scope');
}

/** O vínculo cai no escopo da barreira? (global: tudo; projeto: só o projeto). */
export function inScope(binding: ApprovalBinding, scope: BarrierScope): boolean {
  return scope.kind === 'global' || binding.projectId === scope.projectId;
}

export { isPlain };
