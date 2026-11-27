import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AuditAction, AuditOutcome } from '../../shared/contracts.ts';
import { API_SECURITY_HEADERS } from '../../shared/securityHeaders.ts';
import type { AuditLog } from '../audit/auditLog.ts';
import { BRIDGE_NEXT_PROMPT, type BridgeOrders } from '../gateway/bridge.ts';
import { BRIDGE_LIMITS, BRIDGE_TOKEN } from '../gateway/contracts.ts';
import type { Logger } from '../logger.ts';

/**
 * Ponte MCP local (Issue #055): endpoint Streamable HTTP SEM ESTADO, só JSON (sem SSE), no MESMO
 * listener loopback do ACC, com o SDK oficial do MCP. Pipeline PRÓPRIO, separado do administrativo,
 * nesta ordem:
 *
 * 1. ponte desligada (padrão) → 404, como se a rota não existisse;
 * 2. método: só `POST` (GET/DELETE/SSE → 405);
 * 3. `Host` exatamente loopback:porta (DNS rebinding) → 403;
 * 4. QUALQUER `Origin`/`Sec-Fetch-*` → 403 (o Claude Code não os envia; navegadores sim);
 * 5. bloqueio temporário após falhas de autenticação → 429;
 * 6. `Content-Type: application/json` → 415;
 * 7. `Authorization: Bearer accb_…` → credencial ativa pelo RESUMO do token → 401;
 * 8. limite por credencial → 429; corpo ≤ 16 KiB → 413; só um objeto JSON-RPC (sem lote) → 400;
 * 9. versão do protocolo conferida pelo SDK; resposta ≤ 512 KiB.
 *
 * Cookie de sessão do administrador NÃO autentica aqui (nunca é lido), e o token da ponte não
 * autentica nas rotas administrativas. Token, corpo e pacote NUNCA vão para log nem auditoria.
 * Nada aqui executa código, inicia processo, chama provedor de IA ou escreve no GitHub.
 */

export const BRIDGE_ROUTE = '/mcp';
const BRIDGE_METHOD = 'POST';
const SERVER_INFO = { name: 'acc-bridge', version: '1.0.0' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[a-z0-9_]{1,64}$/;

/** Motivo interno → código entregue ao agente (tokens fixos; nunca mensagens ou valores). */
export function bridgeToolCode(code: string): string {
  const map: Record<string, string> = {
    not_found: 'not_found',
    bridge_unauthorized: 'unauthorized',
    bridge_disabled: 'unavailable',
    already_claimed: 'already_claimed',
    claim_replay_expired: 'claim_replay_expired',
    idempotency_conflict: 'idempotency_conflict',
    claim_invalid: 'claim_invalid',
    order_closed: 'order_closed',
    scope_revoked: 'order_closed',
    invalid_transition: 'order_closed',
    handoff_expired: 'order_expired',
    scope_expired: 'claim_window_elapsed',
    scope_not_active: 'order_closed',
    pr_reference_invalid: 'pr_reference_invalid',
    repository_not_allowed: 'repository_not_allowed',
    secret_detected: 'secret_detected',
    proposal_limit: 'proposal_limit',
    pr_already_linked: 'pr_already_linked',
    invalid_request: 'invalid_arguments',
    project_not_enabled: 'project_not_enabled',
    task_not_active: 'task_not_active',
    agent_not_assigned: 'policy_denied',
    policy_denied: 'policy_denied',
    capability_unavailable: 'policy_denied',
    policy_version_mismatch: 'policy_denied',
    clock_regression: 'unavailable',
  };
  if (Object.hasOwn(map, code)) return map[code];
  if (/^store_|^content_|^change_rejected$/.test(code)) return 'unavailable';
  if (/_barrier$|^authority_|kill|^barrier_|^killswitch/.test(code)) return 'blocked';
  return 'internal';
}

export interface McpBridgeDeps {
  /** `null`: ponte desligada (padrão) ou gateway indisponível → a rota responde 404. */
  bridge: BridgeOrders | null;
  port: number;
  audit?: AuditLog | null;
  logger: Logger;
  now?: () => number;
}

class BridgeHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, headers: Record<string, string> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function createMcpBridge(deps: McpBridgeDeps) {
  const now = deps.now ?? Date.now;
  /** Falhas de autenticação recentes (todas as credenciais): janela deslizante em memória. */
  let failures: number[] = [];
  const perCredential = new Map<string, number[]>();

  function send(res: ServerResponse, status: number, body: string | null, headers: Record<string, string> = {}) {
    res.writeHead(status, {
      ...(body !== null ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) } : {}),
      'Cache-Control': 'no-store',
      ...API_SECURITY_HEADERS,
      ...headers,
    });
    res.end(body ?? undefined);
  }
  const rpcError = (code: string) => JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: code }, id: null });

  async function audit(action: AuditAction, outcome: AuditOutcome, input: { ownerId: string | null; projectId: string | null; orderId: string | null; credentialId: string | null; context: Record<string, string | boolean | null> }) {
    if (!deps.audit) return;
    try {
      await deps.audit.append({
        action,
        actor: input.credentialId ? { kind: 'agent', id: 'claude-code' } : { kind: 'system', id: 'anonymous' },
        ownerId: input.ownerId,
        projectId: input.projectId,
        resource: input.orderId ? { type: 'claude_order', id: input.orderId } : { type: 'route', id: 'mcp' },
        outcome,
        context: { ...input.context, ...(input.credentialId ? { credential: input.credentialId } : {}) },
      });
    } catch {
      deps.logger.log('error', 'Falha ao gravar evento de auditoria', { event: 'audit_write_failed', action });
    }
  }

  function pruneFailures() {
    const limit = now() - BRIDGE_LIMITS.authFailureWindowMs;
    failures = failures.filter((t) => t > limit);
  }
  function lockedFor(): number | null {
    pruneFailures();
    if (failures.length < BRIDGE_LIMITS.authFailuresBeforeLock) return null;
    return Math.max(1, Math.ceil((failures[0] + BRIDGE_LIMITS.authFailureWindowMs - now()) / 1000));
  }
  function hitCredential(credentialId: string): boolean {
    const limit = now() - 60_000;
    const list = (perCredential.get(credentialId) ?? []).filter((t) => t > limit);
    if (list.length >= BRIDGE_LIMITS.requestsPerMinute) {
      perCredential.set(credentialId, list);
      return false;
    }
    list.push(now());
    perCredential.set(credentialId, list);
    return true;
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > BRIDGE_LIMITS.maxRequestBytes) throw new BridgeHttpError(413, 'payload_too_large', { Connection: 'close' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > BRIDGE_LIMITS.maxRequestBytes) throw new BridgeHttpError(413, 'payload_too_large', { Connection: 'close' });
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Erro do gateway → resultado de ferramenta com código fixo (o agente nunca vê detalhes internos). */
  function toolError(error: unknown) {
    const raw = (error as { code?: unknown })?.code;
    const internal = typeof raw === 'string' && TOKEN.test(raw) ? raw : 'internal';
    const code = bridgeToolCode(internal);
    if (code === 'internal') deps.logger.log('error', 'Falha na ponte MCP', { event: 'bridge_tool_error', reason: internal });
    return { code, result: { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] } };
  }
  const ok = (value: unknown, extra: string[] = []) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...extra.map((text) => ({ type: 'text' as const, text }))] });

  /** Servidor MCP de UMA requisição, preso à credencial já autenticada (modo sem estado do SDK). */
  function buildServer(bridge: BridgeOrders, digest: string, identity: { credentialId: string; ownerId: string; projectId: string }) {
    const server = new McpServer(SERVER_INFO, { capabilities: { tools: {}, prompts: {} } });
    const orderId = z.string().regex(UUID);
    const idempotencyKey = z.string().regex(IDEMPOTENCY_KEY);
    const base = { ownerId: identity.ownerId, projectId: identity.projectId, credentialId: identity.credentialId };

    server.registerTool(
      'acc_list_orders',
      {
        title: 'Listar ordens do ACC',
        description: 'Lista as ordens que o PO disponibilizou ao Claude Code neste projeto (sem o pacote). Somente leitura.',
        inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        try {
          return ok(bridge.list(digest));
        } catch (error) {
          return toolError(error).result;
        }
      },
    );

    server.registerTool(
      'acc_claim_order',
      {
        title: 'Receber uma ordem do ACC',
        description:
          'Recebe (uma única vez, de forma atômica) o pacote autorizado de uma ordem disponibilizada. Use uma idempotencyKey nova; se a resposta se perder, repita com a MESMA chave em até 15 minutos.',
        inputSchema: z.object({ orderId, idempotencyKey }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const { audit: facts, result } = await bridge.claim(digest, args);
          await audit('claude_order.claimed', 'success', { ...base, orderId: facts.orderId, context: { replay: facts.replay } });
          const { package: text, ...meta } = result;
          return ok(meta, [text]);
        } catch (error) {
          const { code, result } = toolError(error);
          await audit('claude_order.claimed', code === 'internal' || code === 'unavailable' ? 'failure' : 'blocked', { ...base, orderId: typeof args.orderId === 'string' && UUID.test(args.orderId) ? args.orderId : null, context: { reason: code } });
          return result;
        }
      },
    );

    server.registerTool(
      'acc_report_pr',
      {
        title: 'Propor o PR produzido',
        description:
          'Propõe ao ACC o PR aberto para a ordem (formato owner/repo#N, do repositório da ordem). NÃO vincula: só a confirmação do PO no ACC, com step-up, vincula e inicia a verificação somente leitura.',
        inputSchema: z.object({ orderId, claimId: z.string().regex(UUID), pullRequest: z.string().min(3).max(256), idempotencyKey }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          const { audit: facts, result } = await bridge.report(digest, args);
          await audit('claude_order.pr_proposed', 'success', { ...base, orderId: facts.orderId, context: { replay: facts.replay } });
          return ok(result);
        } catch (error) {
          const { code, result } = toolError(error);
          await audit('claude_order.pr_proposed', code === 'internal' || code === 'unavailable' ? 'failure' : 'blocked', { ...base, orderId: typeof args.orderId === 'string' && UUID.test(args.orderId) ? args.orderId : null, context: { reason: code } });
          return result;
        }
      },
    );

    server.registerTool(
      'acc_get_order_status',
      {
        title: 'Situação de uma ordem do ACC',
        description: 'Situação da ordem: recebimento, PR proposto/vinculado e o resultado da última verificação somente leitura (para o HEAD consultado).',
        inputSchema: z.object({ orderId }).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args) => {
        try {
          return ok(bridge.status(digest, args.orderId));
        } catch (error) {
          return toolError(error).result;
        }
      },
    );

    server.registerPrompt('next', { title: 'Próxima ordem do ACC', description: 'Recebe a próxima ordem disponibilizada pelo ACC, executa o trabalho e propõe o PR.' }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: BRIDGE_NEXT_PROMPT } }],
    }));
    return server;
  }

  async function authFailure(reason: string): Promise<never> {
    failures.push(now());
    await audit('claude_bridge.access', 'blocked', { ownerId: null, projectId: null, orderId: null, credentialId: null, context: { reason } });
    throw new BridgeHttpError(401, 'unauthorized');
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const bridge = deps.bridge;
        if (!bridge) throw new BridgeHttpError(404, 'not_found');
        if (req.method !== BRIDGE_METHOD) throw new BridgeHttpError(405, 'method_not_allowed', { Allow: BRIDGE_METHOD });
        const hosts = [`127.0.0.1:${deps.port}`, `localhost:${deps.port}`, `[::1]:${deps.port}`];
        if (!hosts.includes((req.headers.host ?? '').toLowerCase())) throw new BridgeHttpError(403, 'forbidden_host');
        if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-mode'] !== undefined) throw new BridgeHttpError(403, 'forbidden_origin');
        const locked = lockedFor();
        if (locked !== null) throw new BridgeHttpError(429, 'too_many_requests', { 'Retry-After': String(locked) });
        const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw new BridgeHttpError(415, 'unsupported_media_type');
        const version = req.headers['mcp-protocol-version'];
        if (version !== undefined && (typeof version !== 'string' || !PROTOCOL_VERSION.test(version))) throw new BridgeHttpError(400, 'bad_request');

        const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
        if (!match || !BRIDGE_TOKEN.test(match[1])) await authFailure('unauthenticated');
        const digest = sha256(match![1]);
        let identity: ReturnType<BridgeOrders['authenticate']>;
        try {
          identity = bridge.authenticate(digest);
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          if (code === 'bridge_unauthorized') return await authFailure('unauthenticated');
          throw new BridgeHttpError(503, 'unavailable');
        }
        if (!hitCredential(identity.credentialId)) throw new BridgeHttpError(429, 'too_many_requests', { 'Retry-After': '60' });

        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          throw new BridgeHttpError(400, 'parse_error');
        }
        // Um único objeto JSON-RPC por requisição (lotes não são aceitos).
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BridgeHttpError(400, 'invalid_request');

        const server = buildServer(bridge, digest, identity);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: BRIDGE_LIMITS.maxRequestBytes });
        try {
          await server.connect(transport);
          const headers: Record<string, string> = { 'content-type': 'application/json', accept: typeof req.headers.accept === 'string' ? req.headers.accept : '' };
          if (typeof version === 'string') headers['mcp-protocol-version'] = version;
          const request = new Request(`http://127.0.0.1:${deps.port}${BRIDGE_ROUTE}`, { method: BRIDGE_METHOD, headers, body: raw });
          const response = await transport.handleRequest(request, { parsedBody: parsed });
          const text = response.status === 202 ? '' : await response.text();
          if (Buffer.byteLength(text) > BRIDGE_LIMITS.maxResponseBytes) throw new BridgeHttpError(500, 'response_too_large');
          const contentType = response.headers.get('content-type');
          if (text === '') send(res, response.status, null);
          else if (contentType && contentType.startsWith('application/json')) send(res, response.status, text);
          else throw new BridgeHttpError(500, 'internal');
        } finally {
          await server.close().catch(() => undefined);
        }
      } catch (error) {
        const e = error instanceof BridgeHttpError ? error : new BridgeHttpError(500, 'internal');
        if (!(error instanceof BridgeHttpError)) deps.logger.log('error', 'Erro interno na ponte MCP', { event: 'bridge_internal', error: error instanceof Error ? error.name : 'unknown' });
        if (!res.headersSent) send(res, e.status, rpcError(e.code), e.headers);
      }
    },
  };
}

export type McpBridge = ReturnType<typeof createMcpBridge>;
