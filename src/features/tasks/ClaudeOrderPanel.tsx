import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ClaudeBridgeStatusView, ClaudeOrderListResponse, ClaudeOrderState, ClaudeOrderVerifyResponse, ClaudeOrderView } from '../../../shared/contracts.ts';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { ApiClientError } from '../../services/apiClient';
import { confirmIdentity } from '../../services/approvalsApi';
import {
  cancelClaudeOrder,
  confirmClaudeProposal,
  createBridgeCredential,
  createClaudeOrder,
  linkClaudePullRequest,
  listClaudeOrders,
  markClaudeForwarded,
  offerClaudeOrder,
  releaseClaudePackage,
  revokeBridgeCredential,
  setClaudeEnablement,
  verifyClaudePullRequest,
} from '../../services/claudeOrdersApi';
import { ERROR_COPY, formatDateTime } from '../github/githubLabels';

/**
 * Ordens para o Claude Code (Issue #008) — interface MÍNIMA do fluxo assistido. O ACC prepara,
 * registra e LÊ o PR; quem executa o Claude Code é a pessoa, fora do ACC. Nada aqui executa código.
 */

export const OUTSIDE_NOTICE = 'Executado fora do ACC; o ACC não comprovou isolamento nem autoria dos commits.';
export const MERGE_NOTICE = 'Checks verdes não autorizam merge.';

const STATE_LABELS: Record<ClaudeOrderState, string> = {
  awaiting_approval: 'Aguardando aprovações',
  prepared: 'Pacote preparado',
  delivered: 'Pacote liberado',
  awaiting_pr: 'Encaminhado — aguardando PR',
  pr_linked: 'PR vinculado (não verificado como conforme)',
  verified: 'Verificado para o HEAD lido',
  rejected: 'Rejeitada',
  expired: 'Expirada',
  cancelled: 'Cancelada',
};
const STATE_TONES: Record<ClaudeOrderState, BadgeTone> = {
  awaiting_approval: 'warning',
  prepared: 'info',
  delivered: 'info',
  awaiting_pr: 'info',
  pr_linked: 'warning',
  verified: 'success',
  rejected: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
};
const RULE_LABELS: Record<string, string> = {
  V1: 'Repositório e identidade estável',
  V2: 'PR existe no repositório autorizado',
  V3: 'Branch de origem = branch designada',
  V4: 'Não é de fork',
  V5: 'Base = main',
  V6: 'Ancestralidade do SHA base comprovada',
  V7: 'Aberto e não mesclado',
  V8: 'Quantidade de commits',
  V9: 'Proveniência declarada (não comprovada)',
  V10: 'Caminhos proibidos e lista completa',
  V11: 'Checks do HEAD',
  V12: 'HEAD estável durante a leitura',
  V13: 'Draft, mergeabilidade e revisão (informativo)',
};
const RESULT_LABELS: Record<string, string> = { ok: 'ok', pending: 'pendente', fail: 'falha', info: 'informativo' };
const VERDICT_LABELS: Record<string, string> = { conforming: 'conforme', needs_review: 'precisa de revisão', nonconforming: 'não conforme', cancelled: 'encerrada' };

const inputClass = 'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm';
const buttonClass = 'rounded-md border border-slate-300 bg-white px-3 py-1 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50';
const short = (sha: string | null) => (sha ? sha.slice(0, 12) : '—');
const newKey = () => `order-${globalThis.crypto.randomUUID()}`;

function ErrorText({ error }: { error: ApiClientError }) {
  const copy = ERROR_COPY[error.code];
  return (
    <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900">
      <span className="font-medium">{copy.title}:</span> {copy.description}
    </p>
  );
}

/** Confirmação de identidade (senha → prova de uso único; a senha nunca é guardada). */
function Confirm({ label, submitLabel, onConfirmed, children }: { label: string; submitLabel: string; onConfirmed: (proofId: string) => Promise<void>; children?: ReactNode }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);
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
      setError(caught instanceof ApiClientError ? caught : new ApiClientError('internal'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form aria-label={label} onSubmit={submit} className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2">
      {children}
      <label className="flex flex-col gap-1 text-xs text-slate-700">
        Confirme sua senha para {label.toLowerCase()}
        <input type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
      </label>
      <button type="submit" className={buttonClass} disabled={busy || password === ''}>
        {busy ? 'Enviando…' : submitLabel}
      </button>
      {error && <ErrorText error={error} />}
    </form>
  );
}

const PROPOSAL_LABELS: Record<string, string> = { pending: 'aguardando sua confirmação', confirmed: 'confirmado e vinculado', closed: 'encerrado sem vínculo' };

/**
 * Ponte MCP local (Issue #055): credencial LOCAL do projeto (criação com aprovação de configuração e
 * step-up; revogação com step-up). O token aparece uma única vez, só nesta tela, e nunca é guardado
 * pelo navegador; o servidor guarda apenas o resumo dele.
 */
function BridgeSection({ projectId, bridge, onChange }: { projectId: string; bridge: ClaudeBridgeStatusView; onChange: () => void }) {
  const [command, setCommand] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [copied, setCopied] = useState(false);
  if (!bridge.enabled) {
    return <p className="text-xs text-slate-600">Ponte MCP local desligada neste servidor. O fluxo manual (copiar e colar) continua disponível como contingência.</p>;
  }
  const credential = bridge.credential;
  const active = credential?.state === 'active';
  return (
    <section aria-label="Ponte MCP local" className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/40 p-2 text-xs text-slate-700">
      <p>
        Ponte MCP local em <code>{bridge.endpoint}</code>. O Claude Code, aberto por você com a sua assinatura, recebe só as ordens que você disponibilizar; o PR proposto só é vinculado com a sua
        confirmação.
      </p>
      <p>
        Credencial da ponte:{' '}
        <strong>{active ? `ativa até ${formatDateTime(credential.expiresAt)}` : credential ? (credential.state === 'revoked' ? 'revogada' : 'vencida') : 'nenhuma'}</strong>
      </p>
      <Confirm
        label={active ? 'Gerar nova credencial da ponte (revoga a atual)' : 'Criar a credencial da ponte'}
        submitLabel="Criar credencial"
        onConfirmed={async (proofId) => {
          const created = await createBridgeCredential(projectId, days, proofId);
          setCopied(false);
          setCommand(created.command);
          onChange();
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-slate-700">
          Validade da credencial
          <select className={inputClass} value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30].map((d) => (
              <option key={d} value={d}>
                {d} dia(s)
              </option>
            ))}
          </select>
        </label>
      </Confirm>
      {command && (
        <div className="space-y-1">
          <p className="font-medium text-amber-900">Copie agora: o token não será mostrado de novo (o ACC guarda só o resumo dele). Rode o comando no terminal, na pasta do repositório.</p>
          <textarea aria-label="Comando do Claude Code" readOnly className="h-20 w-full rounded-md border border-slate-300 p-2 font-mono text-xs" value={command} />
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                void globalThis.navigator.clipboard?.writeText(command).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copiado' : 'Copiar comando'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setCommand(null)}>
              Ocultar
            </button>
          </div>
        </div>
      )}
      {active && (
        <Confirm
          label="Revogar a credencial da ponte"
          submitLabel="Revogar credencial"
          onConfirmed={async (proofId) => {
            await revokeBridgeCredential(projectId, credential.id, proofId);
            setCommand(null);
            onChange();
          }}
        />
      )}
    </section>
  );
}

function OrderCard({ order, bridge, onChange }: { order: ClaudeOrderView; bridge: ClaudeBridgeStatusView; onChange: () => void }) {
  const [pkg, setPkg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reference, setReference] = useState(`${order.repository}#`);
  const [outcome, setOutcome] = useState<ClaudeOrderVerifyResponse['outcome'] | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [verificationError, setVerificationError] = useState<ApiClientError | null>(null);
  const [busy, setBusy] = useState(false);
  const approved = order.approvals.every((a) => a.state === 'approved' || a.state === 'consumed');
  // Issue #055: ordem disponibilizada à ponte nunca é liberada pelo canal manual (e vice-versa).
  const viaBridge = order.bridge !== null;
  const bridgeReady = bridge.enabled && bridge.credential?.state === 'active';
  const releasedManually = !viaBridge && (order.state === 'delivered' || order.state === 'awaiting_pr');
  const canOffer = bridgeReady && !viaBridge && !order.closed && ((order.state === 'awaiting_approval' && approved) || order.state === 'prepared');
  const canRelease = !viaBridge && ((order.state === 'awaiting_approval' && approved) || order.state === 'prepared' || order.state === 'delivered' || order.state === 'awaiting_pr');
  const canLink = order.state === 'delivered' || order.state === 'awaiting_pr';
  const canVerify = order.state === 'pr_linked' || order.state === 'verified';
  const proposal = order.bridge?.proposal ?? null;
  const canConfirm = proposal !== null && proposal.status === 'pending' && canLink;
  // Fluxo manual = CONTINGÊNCIA quando a ponte está pronta ou a ordem já está nela.
  const manualAsContingency = (bridgeReady || viaBridge) && !releasedManually;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChange();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught : new ApiClientError('internal'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li aria-label={`Ordem ${order.orderId}`} className="space-y-2 rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATE_TONES[order.state]}>{STATE_LABELS[order.state]}</Badge>
        {order.stateReason && <span className="text-xs text-slate-500">({order.stateReason})</span>}
        <span className="text-xs text-slate-500">criada em {formatDateTime(order.createdAt)}</span>
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-xs text-slate-700 sm:grid-cols-2">
        <div>
          <dt className="inline font-medium">Repositório: </dt>
          <dd className="inline break-all">{order.repository}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Branch: </dt>
          <dd className="inline break-all">
            <code>{order.workBranch}</code>
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">SHA base: </dt>
          <dd className="inline">
            <code title={order.baseSha}>{short(order.baseSha)}</code>
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Resumo do objetivo: </dt>
          <dd className="inline">
            <code title={order.inputDigest}>{order.inputDigest.slice(0, 12)}</code> ({order.criteriaCount} critério(s))
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Aprovações: </dt>
          <dd className="inline">{order.approvals.map((a) => `${a.action}: ${a.state}`).join(' · ')}</dd>
        </div>
        {order.scope.validUntil && (
          <div>
            <dt className="inline font-medium">Pacote liberável até: </dt>
            <dd className="inline">{formatDateTime(order.scope.validUntil)}</dd>
          </div>
        )}
        {order.package && (
          <div>
            <dt className="inline font-medium">Resumo do pacote: </dt>
            <dd className="inline">
              <code title={order.package.digest}>{order.package.digest.slice(0, 12)}</code>
              {order.package.relayDeadline && ` · PR até ${formatDateTime(order.package.relayDeadline)}`}
            </dd>
          </div>
        )}
        {order.pullRequest && (
          <div>
            <dt className="inline font-medium">PR: </dt>
            <dd className="inline">
              <a href={order.pullRequest.url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                {order.pullRequest.reference}
              </a>
            </dd>
          </div>
        )}
      </dl>
      {order.state === 'awaiting_approval' && !approved && <p className="text-xs text-amber-800">Aprove ou rejeite as duas solicitações na página Aprovações (agent.invoke e data.send_external).</p>}

      {order.bridge && (
        <div aria-label="Ponte MCP da ordem" className="space-y-1 rounded-md border border-emerald-200 bg-emerald-50/40 p-2 text-xs text-slate-700">
          <p>
            Disponibilizada ao Claude Code em {formatDateTime(order.bridge.offeredAt)} ·{' '}
            {order.bridge.claim ? `recebida em ${formatDateTime(order.bridge.claim.at)}` : 'aguardando o recebimento pelo Claude Code (/mcp__acc__next)'}
          </p>
          {proposal && (
            <p>
              PR proposto:{' '}
              <a href={proposal.url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                {proposal.reference}
              </a>{' '}
              ({PROPOSAL_LABELS[proposal.status]}, {formatDateTime(proposal.proposedAt)}; {order.bridge.proposals}/{order.bridge.maxProposals} propostas)
            </p>
          )}
        </div>
      )}
      {canOffer && (
        <Confirm label="Disponibilizar ao Claude Code (ponte MCP)" submitLabel="Disponibilizar ao Claude Code" onConfirmed={(proofId) => run(async () => void (await offerClaudeOrder(order.orderId, proofId)))} />
      )}
      {canConfirm && (
        <Confirm
          label="Confirmar o PR proposto e verificar"
          submitLabel={busy ? 'Verificando…' : 'Confirmar PR e verificar'}
          onConfirmed={(proofId) =>
            run(async () => {
              const result = await confirmClaudeProposal(order.orderId, proposal.id, proofId);
              setOutcome(result.outcome);
              setVerificationError(result.verificationError ? new ApiClientError(result.verificationError) : null);
            })
          }
        >
          <p className="text-xs text-slate-700">
            O PR <strong>{proposal.reference}</strong> foi proposto pelo Claude Code. Confirmar o vincula à ordem e inicia a verificação somente leitura. {MERGE_NOTICE}
          </p>
        </Confirm>
      )}
      {verificationError && (
        <div className="space-y-1">
          <p className="text-xs text-slate-700">PR vinculado; a verificação não foi concluída agora. Verifique de novo em seguida.</p>
          <ErrorText error={verificationError} />
        </div>
      )}

      {manualAsContingency ? (
        canRelease || (canLink && !order.closed) ? (
          <details className="rounded-md border border-slate-200 p-2 text-xs">
            <summary className="cursor-pointer text-slate-600">Contingência: fluxo manual</summary>
            <div className="mt-2 space-y-2">
              {canRelease && !order.closed && (
                <Confirm label="Liberar e copiar o pacote" submitLabel="Liberar pacote" onConfirmed={(proofId) => run(async () => setPkg((await releaseClaudePackage(order.orderId, proofId)).package))} />
              )}
              {canLink && (
                <Confirm label="Informar o PR" submitLabel="Vincular PR" onConfirmed={(proofId) => run(async () => void (await linkClaudePullRequest(order.orderId, reference.trim(), proofId)))}>
                  <label className="flex flex-col gap-1 text-xs text-slate-700">
                    PR gerado (owner/repo#N)
                    <input className={inputClass} value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
                  </label>
                </Confirm>
              )}
            </div>
          </details>
        ) : null
      ) : (
        canRelease &&
        !order.closed && <Confirm label="Liberar e copiar o pacote" submitLabel="Liberar pacote" onConfirmed={(proofId) => run(async () => setPkg((await releaseClaudePackage(order.orderId, proofId)).package))} />
      )}
      {pkg !== null && (
        <div className="space-y-1">
          <textarea aria-label="Pacote da ordem" readOnly className="h-40 w-full rounded-md border border-slate-300 p-2 font-mono text-xs" value={pkg} />
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                void globalThis.navigator.clipboard?.writeText(pkg).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copiado' : 'Copiar pacote'}
            </button>
            <button type="button" className={buttonClass} onClick={() => setPkg(null)}>
              Ocultar
            </button>
          </div>
        </div>
      )}
      {order.state === 'delivered' && !viaBridge && (
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(async () => void (await markClaudeForwarded(order.orderId)))}>
          Marcar como encaminhado ao Claude Code
        </button>
      )}
      {canLink && !manualAsContingency && (
        <Confirm label="Informar o PR" submitLabel="Vincular PR" onConfirmed={(proofId) => run(async () => void (await linkClaudePullRequest(order.orderId, reference.trim(), proofId)))}>
          <label className="flex flex-col gap-1 text-xs text-slate-700">
            PR gerado (owner/repo#N)
            <input className={inputClass} value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} />
          </label>
        </Confirm>
      )}
      {canVerify && (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setOutcome((await verifyClaudePullRequest(order.orderId)).outcome);
            })
          }
        >
          {busy ? 'Verificando…' : 'Verificar PR (somente leitura)'}
        </button>
      )}
      {order.verification.latest && (
        <p className="text-xs text-slate-700">
          Última verificação #{order.verification.latest.seq}: <strong>{VERDICT_LABELS[order.verification.latest.verdict]}</strong> para o HEAD{' '}
          <code>{short(order.verification.latest.headSha)}</code> em {formatDateTime(order.verification.latest.checkedAt)}
          {order.verification.staleReason === 'not_rechecked' && ' — desatualizada: verifique de novo para confirmar o HEAD atual.'}
          {order.verification.staleReason === 'head_changed' && ' — desatualizada: o PR recebeu commits novos.'}
          {order.verification.current && ' — vale só para este HEAD, lido há menos de 5 min; commits novos exigem nova verificação.'}
          {` (${order.verification.used}/${order.verification.max})`}
        </p>
      )}
      {outcome && (
        <div className="space-y-1 rounded-md border border-slate-200 p-2 text-xs">
          <p>
            Resultado: <strong>{VERDICT_LABELS[outcome.verdict]}</strong> para o HEAD <code>{short(outcome.headSha)}</code>
            {outcome.created ? '' : ' (igual à verificação anterior; nada novo gravado)'}
          </p>
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>Regra</th>
                <th>Resultado</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {outcome.rules.map((r) => (
                <tr key={r.rule}>
                  <td>
                    {r.rule} — {RULE_LABELS[r.rule] ?? r.rule}
                  </td>
                  <td>{RESULT_LABELS[r.result] ?? r.result}</td>
                  <td>{r.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            Checks: {outcome.checks.state ?? 'sem checks'}
            {outcome.checks.failing.length > 0 && ` · falhando: ${outcome.checks.failing.join(', ')}`}
            {outcome.checks.pending.length > 0 && ` · pendentes: ${outcome.checks.pending.join(', ')}`}
          </p>
          <p>
            Commits: {outcome.commits.total}
            {outcome.commits.truncated && ' (exibindo só os primeiros 100)'} · autores declarados: {[...new Set(outcome.commits.authors.map((a) => a.author ?? 'desconhecido'))].join(', ') || '—'}
          </p>
          {outcome.files.forbidden.length > 0 && <p>Caminhos que exigem revisão: {outcome.files.forbidden.join(', ')}</p>}
          {outcome.alerts.includes('merged_outside_flow') && <p className="font-medium text-rose-800">Alerta: o PR foi mesclado fora do fluxo do ACC.</p>}
          <p>
            Estado: {outcome.state.isDraft ? 'draft' : 'pronto para revisão'} · mergeável: {outcome.state.mergeable ?? '—'} · revisão: {outcome.state.reviewDecision ?? '—'}
          </p>
        </div>
      )}
      {order.history.length > 0 && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer">Histórico de verificações ({order.history.length})</summary>
          <ol className="mt-1 space-y-0.5">
            {[...order.history].reverse().map((h) => (
              <li key={h.id}>
                #{h.seq} — {VERDICT_LABELS[h.verdict]} — HEAD <code>{short(h.headSha)}</code> — {formatDateTime(h.checkedAt)}
                {h.closes && ' (final)'}
              </li>
            ))}
          </ol>
        </details>
      )}
      {!order.closed && <Confirm label="Cancelar a ordem" submitLabel="Cancelar ordem" onConfirmed={(proofId) => run(async () => void (await cancelClaudeOrder(order.orderId, proofId)))} />}
      {error && <ErrorText error={error} />}
    </li>
  );
}

/** Painel recolhível da tarefa atribuída ao Claude Code. */
export function ClaudeOrderPanel({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ClaudeOrderListResponse | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [objective, setObjective] = useState('');
  const [criteria, setCriteria] = useState('');
  const [repository, setRepository] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    listClaudeOrders(projectId)
      .then((body) => {
        setData(body);
        setError(null);
      })
      .catch((caught: unknown) => setError(caught instanceof ApiClientError ? caught : new ApiClientError('internal')));
  }, [projectId]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (objective.trim() === '' || busy) return;
    setBusy(true);
    setError(null);
    try {
      const acceptanceCriteria = criteria
        .split('\n')
        .map((c) => c.trim())
        .filter((c) => c !== '');
      await createClaudeOrder(projectId, taskId, { idempotencyKey: newKey(), objective, acceptanceCriteria });
      setObjective('');
      setCriteria('');
      load();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught : new ApiClientError('internal'));
    } finally {
      setBusy(false);
    }
  }

  const orders = data?.orders.filter((o) => o.taskId === taskId) ?? [];
  return (
    <details className="rounded-md border border-indigo-200 bg-indigo-50/40 p-2 text-sm" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer font-medium text-indigo-900">Ordens para Claude Code (fluxo assistido)</summary>
      <div className="mt-2 space-y-2">
        <p className="rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
          {OUTSIDE_NOTICE} {MERGE_NOTICE}
        </p>
        {error && <ErrorText error={error} />}
        {data && data.gateway.state !== 'available' && <p className="text-xs text-slate-600">O Agent Gateway não está configurado ou está indisponível neste servidor.</p>}
        {data && data.gateway.state === 'available' && !data.enablement.enabled && (
          <Confirm
            label="Habilitar o Claude Code neste projeto"
            submitLabel="Habilitar"
            onConfirmed={async (proofId) => {
              await setClaudeEnablement(projectId, { enabled: true, repository: repository || data.linkableRepositories[0], proofId });
              load();
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-slate-700">
              Repositório vinculado ao projeto
              <select className={inputClass} value={repository || data.linkableRepositories[0] || ''} onChange={(e) => setRepository(e.target.value)}>
                {data.linkableRepositories.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </Confirm>
        )}
        {data && data.enablement.enabled && (
          <>
            <p className="text-xs text-slate-700">
              Habilitado neste projeto para <code>{data.enablement.repository}</code>.
            </p>
            <BridgeSection projectId={projectId} bridge={data.bridge} onChange={load} />
            <form aria-label="Preparar ordem para Claude Code" onSubmit={create} className="space-y-2">
              <label className="flex flex-col gap-1 text-xs text-slate-700">
                Objetivo (tratado como dado, não como instrução)
                <textarea className={inputClass} value={objective} maxLength={4000} onChange={(e) => setObjective(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-700">
                Critérios de aceite (um por linha, até 20)
                <textarea className={inputClass} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
              </label>
              <button type="submit" className={buttonClass} disabled={busy || objective.trim() === ''}>
                Preparar ordem para Claude Code
              </button>
            </form>
            <Confirm
              label="Desabilitar o Claude Code neste projeto"
              submitLabel="Desabilitar (encerra as ordens abertas)"
              onConfirmed={async (proofId) => {
                await setClaudeEnablement(projectId, { enabled: false, proofId });
                load();
              }}
            />
          </>
        )}
        {orders.length > 0 && (
          <ul className="space-y-2" aria-label="Ordens da tarefa">
            {orders.map((order) => (
              <OrderCard key={order.orderId} order={order} bridge={data!.bridge} onChange={load} />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
