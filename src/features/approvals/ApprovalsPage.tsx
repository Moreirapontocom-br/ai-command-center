import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { approvalBindingDigest } from '../../../shared/approvalDigest.ts';
import { checkPresentation, type ApprovalPresentation } from '../../../shared/approvalPresentation.ts';
import {
  APPROVAL_HOLD_REASONS,
  type ApprovalAttemptStateName,
  type ApprovalClassName,
  type ApprovalDetail,
  type ApprovalHistoryResponse,
  type ApprovalHoldReason,
  type ApprovalListResponse,
  type ApprovalStateName,
  type ApprovalSummary,
  type PolicySubject,
} from '../../../shared/contracts.ts';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { ApiClientError } from '../../services/apiClient';
import {
  acknowledgeAttempt,
  addHold,
  approveApproval,
  changeRetention,
  confirmIdentity,
  fetchApproval,
  fetchApprovalHistory,
  fetchApprovals,
  purgeHistory,
  rejectApproval,
  removeHold,
  revokeApproval,
} from '../../services/approvalsApi';
import { useAuth } from '../auth/authContext';
import { ERROR_COPY, formatDateTime } from '../github/githubLabels';
import { AGENT_LABELS } from '../tasks/workLabels';

/** Estados com o nome técnico entre parênteses: aprovar NUNCA significa executar. */
const STATE_LABELS: Record<ApprovalStateName, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pendente (pending)', tone: 'warning' },
  approved: { label: 'Aprovada, não utilizada (approved)', tone: 'info' },
  rejected: { label: 'Rejeitada (rejected)', tone: 'danger' },
  withdrawn: { label: 'Retirada (withdrawn)', tone: 'neutral' },
  expired: { label: 'Expirada (expired)', tone: 'neutral' },
  superseded: { label: 'Substituída (superseded)', tone: 'neutral' },
  consumed: { label: 'Consumida — uso reservado (consumed)', tone: 'violet' },
  revoked: { label: 'Revogada (revoked)', tone: 'danger' },
};

const CLASS_LABELS: Record<ApprovalClassName, string> = {
  execution: 'Execução',
  configuration: 'Configuração',
  merge: 'Merge',
  publication: 'Publicação',
  cost: 'Custo',
};

const ATTEMPT_LABELS: Record<ApprovalAttemptStateName, string> = {
  reserved: 'Reservada (aguardando o componente)',
  succeeded: 'Uso registrado pelo componente (não indica execução real)',
  failed: 'Falhou (a aprovação não volta a valer)',
  indeterminate: 'Indeterminada — exige seu reconhecimento',
  acknowledged_by_owner: 'Reconhecida por você',
};

const HOLD_LABELS: Record<ApprovalHoldReason, string> = {
  incident: 'Incidente',
  security_review: 'Revisão de segurança',
  dispute: 'Contestação',
  legal: 'Obrigação legal',
};

const subjectLabel = (subject: PolicySubject) => (subject.kind === 'agent' ? `${AGENT_LABELS[subject.id]} (agente)` : `${subject.id} (pessoa)`);
const requesterLabel = (a: ApprovalSummary) => (a.requestedBy.kind === 'system' ? `Componente do servidor: ${a.requestedBy.id}` : `${a.requestedBy.id} (pessoa)`);
const deadlineOf = (a: ApprovalSummary) => (a.state === 'pending' ? a.pendingUntil : a.state === 'approved' ? a.validUntil : null);
const inputClass = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm';
const buttonClass = 'rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';

function useErrorHandler() {
  const { sessionLost } = useAuth();
  return useCallback(
    (error: unknown): ApiClientError => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      const clientError = error instanceof ApiClientError ? error : new ApiClientError('internal');
      if (clientError.code === 'unauthenticated') sessionLost();
      return clientError;
    },
    [sessionLost],
  );
}

function ErrorNotice({ error }: { error: ApiClientError }) {
  const copy = ERROR_COPY[error.code];
  return (
    <div role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
      <p className="font-semibold">{copy.title}</p>
      <p>{copy.description}</p>
    </div>
  );
}

/**
 * Formulário de confirmação de identidade: a senha só serve para obter a prova de uso único no
 * servidor e é descartada logo em seguida (nunca é guardada no navegador).
 */
function ConfirmForm({ label, submitLabel, onConfirmed, disabled = false }: { label: string; submitLabel: string; onConfirmed: (proofId: string) => Promise<void>; disabled?: boolean }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
  const toError = useErrorHandler();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { proofId } = await confirmIdentity(password);
      setPassword('');
      await onConfirmed(proofId);
    } catch (caught) {
      setPassword('');
      setError(toError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form aria-label={label} onSubmit={submit} className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <label className="flex flex-col gap-1 text-sm text-slate-700">
        Confirme sua senha para {label.toLowerCase()}
        <input type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} disabled={disabled || busy} />
      </label>
      <button type="submit" className={buttonClass} disabled={disabled || busy || password === ''}>
        {busy ? 'Enviando…' : submitLabel}
      </button>
      {error && <ErrorNotice error={error} />}
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[12rem_1fr]">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="break-all text-sm text-slate-900">{children}</dd>
    </div>
  );
}

const PRESENTATION_ISSUE_COPY: Record<string, string> = {
  presentation_missing: 'o componente que pediu não entregou os parâmetros exatos',
  presentation_invalid: 'os parâmetros entregues estão incompletos ou em formato desconhecido',
  presentation_secret_like: 'os parâmetros contêm um valor com aparência de credencial e não são exibidos',
  presentation_unsupported: 'não há apresentação conhecida para este tipo de solicitação',
  presentation_mismatch: 'os parâmetros entregues não correspondem ao resumo registrado',
  binding_mismatch: 'o vínculo registrado não pôde ser conferido',
};

const listOrNone = (items: string[], none: string) => (items.length === 0 ? none : items.join(', '));

/**
 * Parâmetros exatos, somente leitura (correção R1). Renderiza a cópia VERIFICADA no navegador
 * (formato fechado, conferida contra o `paramsDigest`); todo campo do formato aparece aqui.
 */
function PresentationView({ presentation }: { presentation: ApprovalPresentation }) {
  switch (presentation.kind) {
    case 'sandbox': {
      const p = presentation.params;
      return (
        <dl className="space-y-2" aria-label="Parâmetros exatos">
          <Field label="Solicitação do sandbox">
            <code>{p.requestId}</code>
          </Field>
          <Field label="Projeto">
            <code>{p.projectId}</code>
          </Field>
          <Field label="Tarefa">
            <code>{p.taskId}</code>
          </Field>
          <Field label="Agente">{AGENT_LABELS[p.agentId as keyof typeof AGENT_LABELS] ?? p.agentId}</Field>
          <Field label="Workspace">
            <code>{p.workspace.id}</code> (exclusivo, sem acesso a caminhos do host)
          </Field>
          <Field label="Repositório">{p.git ? <code>{p.git.repository}</code> : 'Nenhum (sem código)'}</Field>
          {p.git && (
            <>
              <Field label="SHA base (somente leitura)">
                <code>{p.git.baseSha}</code>
              </Field>
              <Field label="Branch de trabalho">
                <code>{p.git.workBranch}</code> (main não gravável)
              </Field>
            </>
          )}
          <Field label="Rede">Negada por padrão; hosts liberados: {listOrNone(p.network.allow, 'nenhum')}</Field>
          <Field label="Escopos de credencial">{listOrNone(p.credentials.scopes, 'nenhum')}</Field>
          <Field label="Validade da credencial">{p.credentials.ttlSeconds} s</Field>
          <Field label="Segredos de produção">Negado</Field>
          <Field label="Banco de produção">Negado</Field>
          <Field label="Limites">
            tempo {p.limits.timeoutSeconds} s · CPU {p.limits.cpu} · memória {p.limits.memoryMb} MB · disco {p.limits.diskMb} MB
          </Field>
          <Field label="Entradas (não confiáveis)">
            {p.inputs.length === 0 ? (
              'Nenhuma'
            ) : (
              <ul>
                {p.inputs.map((i) => (
                  <li key={`${i.kind}:${i.ref}`}>
                    {i.kind}: <code>{i.ref}</code> (dado não confiável)
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </dl>
      );
    }
    case 'admission': {
      const p = presentation.params;
      return (
        <dl className="space-y-2" aria-label="Parâmetros exatos">
          <Field label="Ação admitida">
            <code>{p.action}</code>
          </Field>
          <Field label="Agente">{AGENT_LABELS[p.agentId as keyof typeof AGENT_LABELS] ?? p.agentId}</Field>
          <Field label="Tarefa">
            <code>{p.taskId}</code>
          </Field>
          <Field label="Projeto">
            <code>{p.projectId}</code>
          </Field>
          <Field label="Modo de uso">
            <code>{p.mode}</code>
          </Field>
          <Field label="Duração máxima">{p.durationSeconds} s</Field>
          <Field label="Custo estimado">{p.estimatedCostMinor === null ? 'Sem cobrança adicional informada' : `${p.estimatedCostMinor} (unidade monetária menor, reservado)`}</Field>
          <Field label="Teto de tokens">{p.maxTokens === null ? 'Não se aplica' : p.maxTokens}</Field>
        </dl>
      );
    }
    case 'approvals.retention_change':
      return (
        <dl className="space-y-2" aria-label="Parâmetros exatos">
          <Field label="Nova retenção">{presentation.params.days} dias</Field>
        </dl>
      );
    case 'approvals.history_purge':
      return (
        <dl className="space-y-2" aria-label="Parâmetros exatos">
          <Field label="Descartar histórico anterior a">{formatDateTime(presentation.params.before)}</Field>
        </dl>
      );
  }
}

function ApprovalDetailPanel({ approvalId, onChanged }: { approvalId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holdReason, setHoldReason] = useState<ApprovalHoldReason>('incident');
  const [holdNote, setHoldNote] = useState('');
  const toError = useErrorHandler();

  useEffect(() => {
    const controller = new AbortController();
    fetchApproval(approvalId, controller.signal)
      .then((r) => setDetail(r.approval))
      .catch((caught: unknown) => {
        try {
          setError(toError(caught));
        } catch {
          // requisição cancelada
        }
      });
    return () => controller.abort();
  }, [approvalId, toError]);

  if (error) return <ErrorNotice error={error} />;
  if (!detail) return <p role="status" className="text-sm text-slate-600">Carregando detalhes…</p>;

  // O navegador recalcula os resumos do que ESTÁ EXIBINDO; diferente do servidor → não aprova.
  // Correção R1: além do vínculo, os PARÂMETROS exatos precisam estar presentes, no formato
  // fechado esperado e reproduzir o `paramsDigest`. Um resumo coincidente sozinho não basta.
  let bindingOk: boolean;
  try {
    bindingOk = approvalBindingDigest(detail.binding) === detail.bindingDigest;
  } catch {
    bindingOk = false;
  }
  const check = bindingOk
    ? checkPresentation({ binding: detail.binding, bindingDigest: detail.bindingDigest, requestedBy: detail.requestedBy, presentation: detail.presentation })
    : null;
  const verified = check !== null && check.ok && detail.presentable && detail.presentationDigest === check.digest ? check : null;
  const issue = verified ? null : (detail.presentationIssue ?? (check === null ? 'binding_mismatch' : check.ok ? 'presentation_mismatch' : check.reason));
  const b = detail.binding;
  const after = (updated: ApprovalDetail, message: string) => {
    setDetail(updated);
    setNotice(message);
    onChanged();
  };

  return (
    <section aria-label="Detalhes da solicitação" className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Solicitação {detail.id}</h2>
        <Badge tone={STATE_LABELS[detail.state].tone}>{STATE_LABELS[detail.state].label}</Badge>
      </div>
      <dl className="space-y-2">
        <Field label="Projeto">{detail.projectName ? `${detail.projectName} (${b.projectId})` : (b.projectId ?? 'Sem projeto (instância)')}</Field>
        <Field label="Operação">
          <code>{b.action}</code> — classe {CLASS_LABELS[detail.class]}
        </Field>
        <Field label="Recurso">
          <code>
            {b.resource.type}:{b.resource.id}
          </code>
        </Field>
        <Field label="Sujeito">{subjectLabel(b.subject)}</Field>
        <Field label="Solicitante">{requesterLabel(detail)}</Field>
        <Field label="SHA">{b.target.sha ? <code>{b.target.sha}</code> : 'Não se aplica'}</Field>
        <Field label="Ref">{b.target.ref ? <code>{b.target.ref}</code> : 'Não se aplica'}</Field>
        <Field label="Parâmetros (resumo)">
          <code>{b.paramsDigest}</code>
        </Field>
        <Field label="Versão da política">
          <code>{b.policyVersion}</code>
        </Field>
        <Field label="Solicitada em">{formatDateTime(detail.requestedAt)}</Field>
        <Field label="Pedido expira em">{formatDateTime(detail.pendingUntil)}</Field>
        <Field label="Autorização válida até">{detail.validUntil ? formatDateTime(detail.validUntil) : 'Ainda não concedida'}</Field>
        <Field label="Resumo do vínculo">
          <code>{detail.bindingDigest}</code>
        </Field>
      </dl>

      <section aria-label="Parâmetros da operação" className="space-y-2 rounded-md border border-slate-200 p-3">
        <h3 className="text-sm font-semibold text-slate-900">Parâmetros exatos (somente leitura)</h3>
        {verified ? (
          <>
            <PresentationView presentation={verified.presentation} />
            <p role="status" className="text-xs text-emerald-800">
              Parâmetros conferidos: estes valores reproduzem o resumo dos parâmetros e o vínculo registrados no servidor.
            </p>
          </>
        ) : (
          <div role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
            Não foi possível apresentar e conferir os parâmetros exatos desta solicitação ({PRESENTATION_ISSUE_COPY[issue ?? 'presentation_invalid'] ?? 'motivo desconhecido'}). A
            aprovação está bloqueada; você pode rejeitá-la.
          </div>
        )}
      </section>

      <p className="text-xs text-slate-600">
        Aprovar autoriza somente esta operação exata, uma única vez, dentro do prazo. Não executa nada: a execução real está desligada nesta versão e capacidades
        indisponíveis continuam indisponíveis.
      </p>

      {notice && (
        <p role="status" className="text-sm font-medium text-slate-800">
          {notice}
        </p>
      )}

      {detail.state === 'pending' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <ConfirmForm
            label="Aprovar"
            submitLabel="Aprovar esta operação"
            disabled={verified === null}
            onConfirmed={async (proofId) => {
              if (!verified) return;
              after((await approveApproval(detail.id, approvalBindingDigest(detail.binding), verified.digest, proofId)).approval, 'Solicitação aprovada. Nada foi executado.');
            }}
          />
          {/* Rejeitar nunca depende da apresentação: um pedido incompleto pode ser recusado com segurança. */}
          <ConfirmForm
            label="Rejeitar"
            submitLabel="Rejeitar"
            onConfirmed={async (proofId) => after((await rejectApproval(detail.id, detail.bindingDigest, proofId)).approval, 'Solicitação rejeitada.')}
          />
        </div>
      )}
      {detail.state === 'approved' && (
        <ConfirmForm label="Revogar" submitLabel="Revogar aprovação" onConfirmed={async (proofId) => after((await revokeApproval(detail.id, proofId)).approval, 'Aprovação revogada.')} />
      )}

      {detail.attempts.length > 0 && (
        <section aria-label="Tentativas de uso" className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">Tentativas de uso</h3>
          <ul className="space-y-2">
            {detail.attempts.map((attempt) => (
              <li key={attempt.id} className="rounded-md border border-slate-200 p-2 text-sm">
                <p>
                  {ATTEMPT_LABELS[attempt.state]} — componente <code>{attempt.component}</code>, reservada em {formatDateTime(attempt.reservedAt)}
                  {attempt.reason && (
                    <>
                      {' '}
                      (motivo <code>{attempt.reason}</code>)
                    </>
                  )}
                </p>
                {attempt.state === 'indeterminate' && (
                  <ConfirmForm
                    label="Reconhecer tentativa"
                    submitLabel="Reconhecer (nada será repetido)"
                    onConfirmed={async (proofId) => {
                      await acknowledgeAttempt(attempt.id, proofId);
                      setDetail((await fetchApproval(detail.id)).approval);
                      setNotice('Tentativa reconhecida. Nada foi repetido.');
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Preservação de registros" className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Preservação de registros</h3>
        {detail.holds.length === 0 ? (
          <p className="text-xs text-slate-600">Sem preservação: os registros seguem a retenção configurada.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {detail.holds.map((hold) => (
              <li key={hold.id} className="space-y-1">
                <span>
                  {HOLD_LABELS[hold.reason]} desde {formatDateTime(hold.createdAt)}
                  {hold.note ? ` — ${hold.note}` : ''}
                </span>
                <ConfirmForm
                  label="Remover preservação"
                  submitLabel="Remover preservação"
                  onConfirmed={async (proofId) => {
                    await removeHold(hold.id, proofId);
                    setDetail((await fetchApproval(detail.id)).approval);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Motivo
            <select className={inputClass} value={holdReason} onChange={(e) => setHoldReason(e.target.value as ApprovalHoldReason)}>
              {APPROVAL_HOLD_REASONS.map((reason) => (
                <option key={reason} value={reason}>
                  {HOLD_LABELS[reason]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            Observação (opcional)
            <input className={inputClass} maxLength={200} value={holdNote} onChange={(e) => setHoldNote(e.target.value)} />
          </label>
        </div>
        <ConfirmForm
          label="Preservar registros"
          submitLabel="Preservar registros"
          onConfirmed={async (proofId) => {
            await addHold(detail.id, holdReason, holdNote.trim() === '' ? null : holdNote.trim(), proofId);
            setHoldNote('');
            setDetail((await fetchApproval(detail.id)).approval);
          }}
        />
      </section>
    </section>
  );
}

function HistorySection() {
  const [history, setHistory] = useState<ApprovalHistoryResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [days, setDays] = useState('');
  const [before, setBefore] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const toError = useErrorHandler();
  const reload = useCallback(() => {
    fetchApprovalHistory()
      .then((h) => {
        setHistory(h);
        setError(null);
      })
      .catch((caught: unknown) => setError(toError(caught)));
  }, [toError]);
  useEffect(reload, [reload]);

  if (error) return <ErrorNotice error={error} />;
  if (!history) return <p role="status" className="text-sm text-slate-600">Carregando histórico…</p>;
  const parsedDays = Number(days);
  const validDays = /^\d+$/.test(days) && parsedDays >= history.retentionLimits.min && parsedDays <= history.retentionLimits.max;
  const beforeIso = /^\d{4}-\d{2}-\d{2}$/.test(before) ? `${before}T00:00:00.000Z` : null;

  return (
    <section aria-label="Histórico de aprovações" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Histórico oficial</h2>
      <p className="text-xs text-slate-600">
        Retenção atual: {history.retentionDays} dias (permitido de {history.retentionLimits.min} a {history.retentionLimits.max}). Registros descartados deixam uma marca
        verificável.
      </p>
      {notice && <p role="status" className="text-sm text-slate-800">{notice}</p>}
      <ul className="divide-y divide-slate-100 text-sm">
        {history.items.map((item) =>
          item.kind === 'tombstone' ? (
            <li key={`t-${item.seq}`} className="py-1 text-slate-500">
              {item.purged} registro(s) descartado(s) pela retenção (seq. {item.firstSeq}–{item.seq})
            </li>
          ) : (
            <li key={item.seq} className="py-1">
              <span className="text-slate-500">{formatDateTime(item.at)}</span> <code>{item.event}</code>
              {item.action && (
                <>
                  {' '}
                  — <code>{item.action}</code>
                </>
              )}
              {item.reason && <span className="text-slate-600"> ({item.reason})</span>}
              <span className="text-slate-500"> · {item.actor.kind === 'human' ? item.actor.id : `sistema:${item.actor.id}`}</span>
            </li>
          ),
        )}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            Nova retenção (dias)
            <input className={inputClass} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <ConfirmForm
            label="Alterar retenção"
            submitLabel="Alterar retenção"
            disabled={!validDays}
            onConfirmed={async (proofId) => {
              await changeRetention(parsedDays, proofId);
              setDays('');
              setNotice('Retenção alterada.');
              reload();
            }}
          />
        </div>
        <div className="space-y-2">
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            Descartar registros anteriores a (AAAA-MM-DD, mínimo 30 dias atrás)
            <input className={inputClass} value={before} onChange={(e) => setBefore(e.target.value)} />
          </label>
          <ConfirmForm
            label="Descartar histórico"
            submitLabel="Descartar registros antigos"
            disabled={beforeIso === null}
            onConfirmed={async (proofId) => {
              await purgeHistory(beforeIso!, proofId);
              setBefore('');
              setNotice('Registros antigos descartados (exceto os preservados).');
              reload();
            }}
          />
        </div>
      </div>
    </section>
  );
}

type Load = { phase: 'loading' } | { phase: 'error'; error: ApiClientError } | { phase: 'ready'; data: ApprovalListResponse };

/** Aprovações humanas (Issue #011): lista, detalhes exatos, decisão com senha e histórico. */
export function ApprovalsPage() {
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const toError = useErrorHandler();

  const reload = useCallback(
    (signal?: AbortSignal) => {
      fetchApprovals(signal)
        .then((data) => setLoad({ phase: 'ready', data }))
        .catch((caught: unknown) => {
          try {
            setLoad({ phase: 'error', error: toError(caught) });
          } catch {
            // requisição cancelada
          }
        });
    },
    [toError],
  );
  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  if (load.phase === 'loading') return <p role="status" className="text-sm text-slate-600">Carregando aprovações…</p>;
  if (load.phase === 'error') return <ErrorNotice error={load.error} />;
  const { subsystem, approvals } = load.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Você é a autoridade final. Cada aprovação vale para uma única operação exata, por tempo limitado, e exige confirmação da sua senha. Aprovar não executa nada.
      </p>
      {subsystem.state !== 'available' && (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">Subsistema de aprovações {subsystem.state === 'degraded' ? 'degradado' : 'indisponível'}</p>
          <p>
            Nenhuma aprovação pode ser concedida ou usada{subsystem.reason ? ` (motivo: ${subsystem.reason})` : ''}.
          </p>
        </div>
      )}
      {subsystem.barriers.global && subsystem.state === 'available' && (
        <div role="status" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
          Bloqueio de emergência global ativo: aprovações de execução não podem ser concedidas nem usadas. Toda instalação nova começa assim; a liberação exige
          aprovação de configuração específica.
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" className={buttonClass} onClick={() => reload()}>
          Atualizar
        </button>
        <button type="button" className={buttonClass} onClick={() => setShowHistory((v) => !v)}>
          {showHistory ? 'Ocultar histórico' : 'Ver histórico'}
        </button>
      </div>
      {approvals.length === 0 ? (
        <p role="status" className="text-sm text-slate-600">Nenhuma solicitação de aprovação.</p>
      ) : (
        <ul aria-label="Solicitações de aprovação" className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {approvals.map((a) => {
            const deadline = deadlineOf(a);
            return (
              <li key={a.id} aria-label={`Solicitação ${a.action}`} className="flex flex-col gap-1 px-4 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p>
                    <code>{a.action}</code> · {a.projectName ?? (a.projectId ? a.projectId : 'Sem projeto')}
                  </p>
                  <p className="text-xs text-slate-600">
                    {requesterLabel(a)} · sujeito {subjectLabel(a.subject)} · solicitada em {formatDateTime(a.requestedAt)}
                    {deadline && ` · expira em ${formatDateTime(deadline)}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={STATE_LABELS[a.state].tone}>{STATE_LABELS[a.state].label}</Badge>
                  <button type="button" className={buttonClass} onClick={() => setSelected(a.id)}>
                    Ver detalhes
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {selected && <ApprovalDetailPanel key={selected} approvalId={selected} onChanged={() => reload()} />}
      {showHistory && <HistorySection />}
    </div>
  );
}
