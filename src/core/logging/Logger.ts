/** Severity levels, lowest first. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One log entry as delivered to a {@link LogSink}. */
export interface LogRecord {
  level: LogLevel;
  /** Scope chain joined by `:`; empty string for the root logger. */
  scope: string;
  message: string;
  /** Extra values (errors, objects) passed after the message. */
  args: readonly unknown[];
  time: Date;
}

/** Destination for log records (console, file, test capture...). */
export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  scope?: string;
  /** Records below this level are dropped. Default `info`. */
  minLevel?: LogLevel;
  sink?: LogSink;
}

/** Default sink: `[scope] message ...args` on the matching console method. */
export const consoleSink: LogSink = (record) => {
  const prefix = record.scope ? `[${record.scope}] ` : '';
  console[record.level](`${prefix}${record.message}`, ...record.args);
};

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

/** Small leveled logger with scoped children and an injectable sink. */
export class Logger {
  readonly scope: string;
  readonly minLevel: LogLevel;
  readonly #sink: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.scope = options.scope ?? '';
    this.minLevel = options.minLevel ?? 'info';
    this.#sink = options.sink ?? consoleSink;
  }

  /** Child logger sharing sink and level; scope becomes `parent:prefix`. */
  child(prefix: string): Logger {
    const scope = this.scope ? `${this.scope}:${prefix}` : prefix;
    return new Logger({ scope, minLevel: this.minLevel, sink: this.#sink });
  }

  /** True when a record at `level` would be emitted. */
  isEnabled(level: LogLevel): boolean {
    return rank(level) >= rank(this.minLevel);
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, args);
  }

  /** Emits a record if enabled. A throwing sink never propagates to the caller. */
  log(level: LogLevel, message: string, args: readonly unknown[] = []): void {
    if (!this.isEnabled(level)) return;
    try {
      this.#sink({ level, scope: this.scope, message, args, time: new Date() });
    } catch {
      // Logging must never break the code path that logs; nothing sensible left to report to.
    }
  }
}
