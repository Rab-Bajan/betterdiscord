import type { Logger } from '../core/logging/Logger.ts';

// Legacy duck-typing (`err && err.stack ? err.stack : err`): also covers cross-realm Errors.
const describe = (reason: unknown): unknown =>
  typeof reason === 'object' && reason !== null && 'stack' in reason && reason.stack ? reason.stack : reason;

/**
 * Legacy server.js guards: a malformed client payload must not take the whole
 * server down. Logs `[FATAL-GUARD] uncaughtException: <stack>` (and the
 * unhandledRejection equivalent) instead of crashing.
 *
 * @param logger scoped `FATAL-GUARD` by the caller so the console line matches legacy
 */
export function installProcessGuards(logger: Logger, target: NodeJS.Process = process): void {
  target.on('uncaughtException', (err) => logger.error('uncaughtException:', describe(err)));
  target.on('unhandledRejection', (reason) => logger.error('unhandledRejection:', describe(reason)));
}
