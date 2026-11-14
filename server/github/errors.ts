import type { ApiErrorCode } from '../../shared/contracts.ts';

/**
 * Motivo interno de um erro, para diagnóstico nos logs do servidor. NUNCA é enviado ao navegador
 * (a resposta HTTP usa apenas `code` e a mensagem fixa), pois poderia revelar se um repositório
 * existe ou qual credencial está em uso.
 */
export type IntegrationErrorReason =
  | 'http_403'
  | 'graphql_forbidden'
  | 'graphql_not_found'
  | 'credential_unavailable'
  | 'credential_rejected_after_renewal'
  | 'document_not_approved';

/**
 * Erro normalizado da integração. A mensagem é sempre um texto fixo definido aqui — nunca o corpo
 * devolvido pelo GitHub — para não refletir dados inesperados (ou segredos) ao navegador.
 */
export class IntegrationError extends Error {
  readonly code: ApiErrorCode;
  readonly resetAt: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly reason: IntegrationErrorReason | undefined;

  constructor(
    code: ApiErrorCode,
    options: { resetAt?: string; retryAfterSeconds?: number; cause?: unknown; reason?: IntegrationErrorReason } = {},
  ) {
    super(ERROR_MESSAGES[code], { cause: options.cause });
    this.name = 'IntegrationError';
    this.code = code;
    this.resetAt = options.resetAt;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.reason = options.reason;
  }
}

export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  missing_credentials: 'Nenhuma credencial do GitHub está configurada no servidor.',
  unauthorized: 'O GitHub recusou a credencial configurada (inválida, expirada ou revogada).',
  forbidden: 'A credencial não tem permissão de leitura para este repositório.',
  not_found: 'Recurso não encontrado ou não autorizado neste servidor.',
  rate_limited: 'Limite de requisições da API do GitHub atingido.',
  too_many_requests: 'Muitas requisições a este servidor. Aguarde e tente novamente.',
  network: 'Não foi possível conectar à API do GitHub.',
  timeout: 'A API do GitHub não respondeu dentro do tempo limite.',
  upstream_invalid: 'A API do GitHub devolveu dados em formato inesperado.',
  upstream_error: 'A API do GitHub está indisponível no momento.',
  bad_request: 'Parâmetros inválidos.',
  method_not_allowed: 'Método não permitido para este recurso.',
  forbidden_origin: 'Origem da requisição não autorizada.',
  unauthenticated: 'Sessão ausente, expirada ou encerrada. Faça login.',
  invalid_credentials: 'E-mail ou senha inválidos.',
  auth_not_configured: 'Nenhum administrador está configurado neste servidor.',
  unsupported_media_type: 'Envie os dados como application/json.',
  payload_too_large: 'Corpo da requisição muito grande.',
  repository_not_allowed: 'Repositório não autorizado neste servidor.',
  project_limit_reached: 'Limite de projetos atingido.',
  internal: 'Erro interno do servidor.',
};

export const ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  missing_credentials: 503,
  unauthorized: 502,
  forbidden: 502,
  not_found: 404,
  rate_limited: 429,
  too_many_requests: 429,
  network: 502,
  timeout: 504,
  upstream_invalid: 502,
  upstream_error: 502,
  bad_request: 400,
  method_not_allowed: 405,
  forbidden_origin: 403,
  unauthenticated: 401,
  invalid_credentials: 401,
  auth_not_configured: 503,
  unsupported_media_type: 415,
  payload_too_large: 413,
  repository_not_allowed: 422,
  project_limit_reached: 409,
  internal: 500,
};
