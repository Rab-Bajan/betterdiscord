import type { Logger } from '../core/logging/Logger.ts';

/** The slice of `process` the shutdown handlers use. */
export interface SignalSource {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
}

export interface ShutdownOptions {
  target?: SignalSource;
  exit?: (code: number) => void;
  /** Hard limit for a graceful stop before exiting anyway. */
  timeoutMs?: number;
}

/**
 * SIGTERM / SIGINT (systemd stop, Ctrl+C): run `stop` (module dispose, e.g. the final sweepers
 * save, then socket.io / HTTPS close) and exit 0. A stop that fails or takes longer than
 * `timeoutMs` still exits, so a restart is never held up.
 */
export function installShutdownHandlers(stop: () => Promise<void>, logger: Logger, options: ShutdownOptions = {}): void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const timeoutMs = options.timeoutMs ?? 5000;
  let stopping = false;
  const onSignal = (signal: string) => (): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal}: leállítás...`);
    const timer = setTimeout(() => {
      logger.warn(`A leállítás ${timeoutMs} ms alatt nem fejeződött be, kilépés.`);
      exit(0);
    }, timeoutMs);
    timer.unref();
    stop().catch((err: unknown) => logger.error('Leállítási hiba:', err)).finally(() => {
      clearTimeout(timer);
      exit(0);
    });
  };
  target.once('SIGTERM', onSignal('SIGTERM'));
  target.once('SIGINT', onSignal('SIGINT'));
}
