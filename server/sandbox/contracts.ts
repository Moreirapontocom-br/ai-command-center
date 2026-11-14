import type { AgentRef } from '../../shared/contracts.ts';

/**
 * Contratos de sandbox (Issue #021) — camada PREPARATÓRIA, independente de fornecedor.
 *
 * IMPORTANTE: estes tipos DESCREVEM as garantias exigidas de um provedor real (workspace exclusivo,
 * rede negada por padrão, credenciais mínimas e temporárias…). Descrever não é garantir: nenhuma
 * dessas garantias existe em produção até que um provedor real, aprovado pelo PO (#031), as
 * implemente e seja testado. Execução real está DESABILITADA no código (`REAL_EXECUTION_ENABLED`).
 */

/** Execução real desligada. Mudar exige PR aprovado pelo PO; não há configuração por ambiente. */
export const REAL_EXECUTION_ENABLED = false as const;

export const SANDBOX_STATES = ['requested', 'authorized', 'running', 'completed', 'cancelled', 'expired', 'failed'] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

export const TERMINAL_STATES: readonly SandboxState[] = ['completed', 'cancelled', 'expired', 'failed'];

/** Transições permitidas. Estados terminais não têm saída (sandbox descartada não "renasce"). */
export const SANDBOX_TRANSITIONS: Readonly<Record<SandboxState, readonly SandboxState[]>> = {
  requested: ['authorized', 'cancelled', 'expired', 'failed'],
  authorized: ['running', 'cancelled', 'expired', 'failed'],
  running: ['completed', 'failed', 'cancelled', 'expired'],
  completed: [],
  cancelled: [],
  expired: [],
  failed: [],
};

/** Escopos de credencial que um provedor real poderá emitir (temporários, por execução). */
export const CREDENTIAL_SCOPES = ['repo.read', 'repo.write_work_branch'] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

/** Limites máximos aceitos (conservadores). Quotas e orçamento são da Issue #022. */
export const SANDBOX_LIMITS = {
  maxTimeoutSeconds: 30 * 60,
  maxCpu: 2,
  maxMemoryMb: 4096,
  maxDiskMb: 10_240,
  maxNetworkHosts: 10,
  /** Prazo para uma solicitação ser autorizada antes de expirar. */
  approvalWindowSeconds: 60 * 60,
} as const;

/** Entrada externa (issue, PR, tarefa): SEMPRE não confiável; nunca altera política nem limites. */
export interface UntrustedInput {
  kind: 'issue' | 'pull_request' | 'task';
  /** Referência, nunca o conteúdo. O conteúdo é tratado como dado, não como instrução. */
  ref: string;
}

/** O que o chamador (servidor, em nome de um agente) pode pedir. Nada de caminhos, comandos ou branch livres. */
export interface SandboxRequestInput {
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  /** Repositório vinculado ao projeto (quando houver código) e o SHA base, somente leitura. */
  repository: string | null;
  baseSha: string | null;
  /** Hosts de rede além do padrão (nenhum). Cada um precisa estar permitido pela política futura. */
  networkAllowlist: string[];
  credentialScopes: CredentialScope[];
  limits: { timeoutSeconds: number; cpu: number; memoryMb: number; diskMb: number };
  inputs: UntrustedInput[];
}

/**
 * Especificação entregue ao provedor. Derivada pelo servidor: o workspace é um id lógico (o
 * provedor decide onde fica, isolado), a branch é dedicada e gerada, e a rede é negada por padrão.
 */
export interface SandboxSpec {
  requestId: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  workspace: { id: string; exclusive: true; hostPathAccess: 'none' };
  git: { repository: string; baseSha: string; workBranch: string; mainWritable: false } | null;
  network: { default: 'deny'; allow: string[] };
  credentials: { scopes: CredentialScope[]; ttlSeconds: number; productionSecrets: 'denied'; productionDatabase: 'denied' };
  limits: SandboxRequestInput['limits'];
  inputs: Array<UntrustedInput & { trust: 'untrusted' }>;
}

export interface SandboxRecord {
  id: string;
  ownerId: string;
  projectId: string;
  taskId: string;
  agentId: AgentRef;
  state: SandboxState;
  spec: SandboxSpec;
  createdAt: string;
  updatedAt: string;
  /** Prazo do estado atual (autorização ou execução). */
  deadline: string;
  /** Aprovação consumida ao autorizar (uso único). */
  approvalId: string | null;
  /** Motivo do estado final, como token (nunca mensagem do provedor). */
  reason: string | null;
  /** `pending` quando o descarte do workspace falhou e precisa ser refeito. */
  cleanup: 'not_needed' | 'done' | 'pending';
  history: Array<{ at: string; from: SandboxState | null; to: SandboxState; reason: string | null }>;
}
