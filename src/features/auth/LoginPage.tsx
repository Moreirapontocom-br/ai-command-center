import { useId, useState, type FormEvent } from 'react';
import type { ApiClientError } from '../../services/apiClient';
import { useAuth } from './authContext';

function errorMessage(error: ApiClientError): string {
  switch (error.code) {
    case 'invalid_credentials':
      return 'E-mail ou senha inválidos.';
    case 'too_many_requests': {
      const minutes = Math.max(1, Math.ceil((error.retryAfterSeconds ?? 60) / 60));
      return `Muitas tentativas. Tente novamente em ${minutes} min.`;
    }
    case 'auth_not_configured':
      return 'Nenhum administrador está configurado no servidor.';
    case 'server_unreachable':
      return 'Servidor indisponível. Verifique se `npm run server` está em execução.';
    default:
      return 'Não foi possível entrar. Tente novamente.';
  }
}

const inputClass =
  'mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:bg-slate-100';

export function LoginPage({ authConfigured, sessionExpired }: { authConfigured: boolean; sessionExpired: boolean }) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailId = useId();
  const passwordId = useId();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const failure = await signIn(email, password);
    // A senha nunca permanece no estado depois de uma tentativa.
    setPassword('');
    setSubmitting(false);
    if (failure) setError(errorMessage(failure));
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-center text-xl font-semibold text-slate-900">AI Command Center</h1>
        <p className="mt-1 text-center text-sm text-slate-600">Acesso restrito ao administrador.</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm" noValidate>
          {sessionExpired && !error && (
            <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Sua sessão expirou ou foi encerrada (por exemplo, por um login em outro navegador). Entre novamente.
            </p>
          )}
          {!authConfigured && (
            <div role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <p className="font-medium">Administrador não configurado.</p>
              <p className="mt-1">
                No servidor, gere o hash com <code>npm run auth:hash-password</code> e defina{' '}
                <code>ACC_ADMIN_EMAIL</code> e <code>ACC_ADMIN_PASSWORD_HASH</code> no <code>.env.local</code>.
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {error}
            </p>
          )}
          <div>
            <label htmlFor={emailId} className="block text-sm font-medium text-slate-700">
              E-mail
            </label>
            <input
              id={emailId}
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={!authConfigured || submitting}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={passwordId} className="block text-sm font-medium text-slate-700">
              Senha
            </label>
            <input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!authConfigured || submitting}
              className={inputClass}
            />
          </div>
          <button
            type="submit"
            disabled={!authConfigured || submitting || email === '' || password === ''}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </main>
  );
}
