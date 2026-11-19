import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ClaudeOrderListResponse, ClaudeOrderState, ClaudeOrderVerifyResponse, ClaudeOrderView } from '../../../shared/contracts.ts';
import { Badge, type BadgeTone } from '../../components/ui/Badge';
import { ApiClientError } from '../../services/apiClient';
import { confirmIdentity } from '../../services/approvalsApi';
import {
  cancelClaudeOrder,
  createClaudeOrder,
  linkClaudePullRequest,
  listClaudeOrders,
  markClaudeForwarded,
  releaseClaudePackage,
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

function OrderCard({ order, onChange }: { order: ClaudeOrderView; onChange: () => void }) {
  const [pkg, setPkg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [reference, setReference] = useState(`${order.repository}#`);
  const [outcome, setOutcome] = useState<ClaudeOrderVerifyResponse['outcome'] | null>(null);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [busy, setBusy] = useState(false);
  const approved = order.approvals.every((a) => a.state === 'approved' || a.state === 'consumed');
  const canRelease = (order.state === 'awaiting_approval' && approved) || order.state === 'prepared' || order.state === 'delivered' || order.state === 'awaiting_pr';
  const canLink = order.state === 'delivered' || order.state === 'awaiting_pr';
  const canVerify = order.state === 'pr_linked' || order.state === 'verified';

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

      {canRelease && !order.closed && (
        <Confirm label="Liberar e copiar o pacote" submitLabel="Liberar pacote" onConfirmed={(proofId) => run(async () => setPkg((await releaseClaudePackage(order.orderId, proofId)).package))} />
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
      {order.state === 'delivered' && (
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void run(async () => void (await markClaudeForwarded(order.orderId)))}>
          Marcar como encaminhado ao Claude Code
        </button>
      )}
      {canLink && (
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
              <OrderCard key={order.orderId} order={order} onChange={load} />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
