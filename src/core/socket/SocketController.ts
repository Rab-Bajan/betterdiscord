import type { Socket } from 'socket.io';
import { AppError } from '../errors/AppError.ts';
import { ValidationError } from '../errors/ValidationError.ts';
import type { Logger } from '../logging/Logger.ts';

/** Socket.IO acknowledgement callback. */
export type AckFn = (response: unknown) => void;

/** Ack body sent when a handler fails (legacy `{ ok: false, error }` shape). */
export interface AckFailure {
  ok: false;
  error: string;
  /** AppError code; absent for unexpected errors. */
  code?: string;
  /** Spread from `AppError.clientFields` (cannot replace `ok` or `error`). */
  [field: string]: unknown;
}

/** Everything a {@link SocketHandler} may need besides the payload. */
export interface HandlerContext {
  socket: Socket;
  event: string;
  /** All data arguments in order, ack excluded (for multi-arg events like `game:rpc`). */
  args: readonly unknown[];
  /** Ack callback guarded to fire at most once; `undefined` if the client sent none. */
  ack: AckFn | undefined;
}

/**
 * Event handler. `payload` is the first data argument, still untrusted.
 * A non-`undefined` return (or resolved) value is sent as the ack response
 * unless the handler already called `ctx.ack`.
 */
export type SocketHandler = (payload: unknown, ctx: HandlerContext) => unknown;

/**
 * Base for feature modules that bind socket events. Subclasses implement
 * {@link register} and bind events through {@link listen}, which guarantees
 * no handler error ever reaches socket.io or the process:
 *
 * - `AppError` (incl. `ValidationError`): acked as
 *   `{ ok: false, error, code, ...clientFields }` when the client sent an ack,
 *   otherwise logged at debug level.
 * - Any other error / rejection: logged at error level with the event name and
 *   acked as `{ ok: false, error: unexpectedErrorMessage }`.
 * - A throwing ack (e.g. socket.io failing to encode the response) is logged
 *   as `"<event>" ack failed`, on both the sync and the async path.
 *
 * Ack detection: the ack is the *last* argument when it is a function, no
 * matter how many data arguments precede it (`emit('x', a, b, cb)` acks).
 * Legacy handlers were positional (`(payload, ack)`), so an ack after extra
 * arguments was ignored there.
 */
export abstract class SocketController {
  /** Client-facing text for unexpected failures (internals are never sent). */
  protected readonly unexpectedErrorMessage: string = 'Váratlan hiba történt.';
  protected readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Binds this controller's events on a freshly connected socket. */
  abstract register(socket: Socket): void;

  /** Binds `handler` to `event` on `socket` with ack and error handling. */
  protected listen(socket: Socket, event: string, handler: SocketHandler): void {
    socket.on(event, (...raw: unknown[]) => {
      const ctx = this.#context(socket, event, raw);
      let result: unknown;
      try {
        result = handler(ctx.args[0], ctx);
      } catch (err) {
        this.#fail(ctx, err);
        return;
      }
      if (result instanceof Promise) {
        // Both callbacks contain their own errors, so this chain never rejects.
        result.then((value: unknown) => this.#reply(ctx, value), (err: unknown) => this.#fail(ctx, err));
      } else {
        this.#reply(ctx, result);
      }
    });
  }

  #context(socket: Socket, event: string, raw: unknown[]): HandlerContext {
    const last = raw.at(-1);
    if (typeof last !== 'function') return { socket, event, args: raw, ack: undefined };
    let sent = false;
    const ack: AckFn = (response) => {
      if (sent) return;
      sent = true;
      // The function came from socket.io as the client's ack callback.
      (last as AckFn)(response);
    };
    return { socket, event, args: raw.slice(0, -1), ack };
  }

  #reply(ctx: HandlerContext, value: unknown): void {
    if (value === undefined) return;
    try {
      ctx.ack?.(value);
    } catch (err) {
      this.logger.error(`"${ctx.event}" ack failed`, err);
    }
  }

  #fail(ctx: HandlerContext, err: unknown): void {
    try {
      if (err instanceof AppError) {
        this.#expected(ctx, err);
        return;
      }
      this.logger.error(`"${ctx.event}" handler failed (socket ${ctx.socket.id})`, err);
      ctx.ack?.({ ok: false, error: this.unexpectedErrorMessage } satisfies AckFailure);
    } catch (ackErr) {
      this.logger.error(`"${ctx.event}" failure ack threw`, ackErr);
    }
  }

  #expected(ctx: HandlerContext, err: AppError): void {
    const kind = err instanceof ValidationError ? 'Rejected payload' : 'Request refused';
    this.logger.debug(`${kind} for "${ctx.event}": ${err.message}`, err.details);
    const { ok: _ok, error: _error, ...extra } = err.clientFields ?? {};
    ctx.ack?.({ ok: false, error: err.message, code: err.code, ...extra } satisfies AckFailure);
  }
}
