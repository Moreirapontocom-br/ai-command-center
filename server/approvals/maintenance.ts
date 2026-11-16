/**
 * Agendamento da manutenção do núcleo de aprovações (Issue #011, PR 2): expiração de pedidos e
 * aprovações, encerramento de recibos vencidos, compactação (N7) e retenção do histórico (D7).
 *
 * - Nunca há duas execuções simultâneas neste processo: um ciclo que encontra o anterior ainda em
 *   andamento é PULADO (não enfileirado). Entre processos, o bloqueio de escritor único do
 *   armazenamento já impede um segundo servidor sobre os mesmos arquivos.
 * - Falha de um ciclo não interrompe os próximos nem libera nada: a manutenção só restringe
 *   (expira, compacta, descarta). O erro vai para o log apenas como token.
 * - O temporizador não mantém o processo vivo (`unref`).
 */
export interface MaintenanceScheduler {
  /** Executa um ciclo agora (o mesmo controle de concorrência). `false` se já havia um em curso. */
  runOnce(): Promise<boolean>;
  stop(): void;
}

export const MAINTENANCE_INTERVAL_MS = 60_000;

export function createMaintenanceScheduler(options: {
  run: () => Promise<void>;
  intervalMs?: number;
  onError?: (code: string) => void;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}): MaintenanceScheduler {
  let running = false;
  let stopped = false;
  const schedule = options.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const cancel = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  async function runOnce(): Promise<boolean> {
    if (running || stopped) return false;
    running = true;
    try {
      await options.run();
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'maintenance_failed';
      options.onError?.(/^[a-z0-9_]{1,64}$/.test(code) ? code : 'maintenance_failed');
    } finally {
      running = false;
    }
    return true;
  }

  const handle = schedule(() => {
    void runOnce();
  }, options.intervalMs ?? MAINTENANCE_INTERVAL_MS);
  handle.unref?.();

  return {
    runOnce,
    stop() {
      stopped = true;
      cancel(handle);
    },
  };
}
