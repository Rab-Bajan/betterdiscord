import type { Server, Socket } from 'socket.io';
import { SocketController } from '../../core/socket/SocketController.ts';
import type { Logger } from '../../core/logging/Logger.ts';

/** A legacy `io.on('connection', fn)` listener. */
export type ConnectionListener = (socket: Socket) => void;

/** Events that mean "a socket connected" on a socket.io Server or Namespace. */
const CONNECTION_EVENTS = new Set<string | symbol>(['connection', 'connect']);

/** Ways of adding a listener that the adapter captures (same semantics as `on`). */
const CAPTURING_METHODS = new Set<string | symbol>(['on', 'addListener']);

/**
 * Listener-related methods that cannot be reproduced through the adapter
 * when used for connection events (ordering or removal semantics would
 * silently change), so they fail at startup instead.
 */
const REJECTED_FOR_CONNECTION = new Set<string | symbol>([
  'once', 'prependListener', 'prependOnceListener', 'off', 'removeListener', 'removeAllListeners'
]);

/** Members of the Server that would bypass the adapter entirely. */
const REJECTED_SERVER_MEMBERS = new Set<string | symbol>(['of']);

/** Thrown at startup when a legacy module uses an `io` pattern the adapter cannot reproduce. */
export class UnsupportedLegacyPatternError extends Error {
  constructor(moduleName: string, pattern: string) {
    super(`Legacy module "${moduleName}" uses unsupported io pattern: ${pattern}`);
    this.name = 'UnsupportedLegacyPatternError';
  }
}

/**
 * Runs an unmodified legacy socket module behind the single
 * {@link SocketServer} connection listener.
 *
 * {@link LegacyModuleAdapter.io} is a proxy of the real socket.io Server to
 * pass to the legacy factory. Every member is forwarded to the real Server
 * (functions bound to it, so `io.to(...)`, `io.emit(...)`, `io.in(...)`,
 * `io.sockets.sockets`, `io.engine`... behave exactly as before), except:
 *
 * - `io.on/addListener('connection'|'connect', fn)` and the same calls on
 *   `io.sockets` are captured instead of attached; {@link register} replays
 *   them for each socket, in the order the module attached them.
 * - `once`/`prepend*`/`off`/`removeListener`/`removeAllListeners` for a
 *   connection event, and `io.of(...)`, throw {@link UnsupportedLegacyPatternError}.
 *   None is used by the legacy code today; failing at startup keeps a future
 *   use from silently bypassing the adapter.
 *
 * Return values and properties that are the real Server or main Namespace
 * (chaining such as `io.use(m).on(...)`, back-references such as
 * `io.sockets.server`) are mapped back to the proxies, so those paths cannot
 * bypass the capture.
 *
 * Each captured listener runs in its own try/catch: a throwing listener is
 * logged and the module's next listener still runs.
 */
export class LegacyModuleAdapter extends SocketController {
  /** Name used in logs and errors (e.g. `chat`). */
  readonly moduleName: string;
  /** Proxy to hand to the legacy factory instead of the real Server. */
  readonly io: Server;
  readonly #listeners: ConnectionListener[] = [];
  /** Real object -> its proxy (the Server and its main Namespace). */
  readonly #proxies = new Map<object, object>();

  constructor(moduleName: string, io: Server, logger: Logger) {
    super(logger);
    this.moduleName = moduleName;
    this.io = this.#proxyServer(io);
  }

  /** Number of connection listeners the module attached. */
  get listenerCount(): number {
    return this.#listeners.length;
  }

  /** Replays the captured connection listeners for `socket`, in attach order. */
  register(socket: Socket): void {
    for (const listener of this.#listeners) {
      try {
        listener(socket);
      } catch (err) {
        this.logger.error(`[${this.moduleName}] connection listener failed (socket ${socket.id})`, err);
      }
    }
  }

  #proxyServer(io: Server): Server {
    const proxy: Server = new Proxy(io, {
      get: (target, prop) => {
        if (REJECTED_SERVER_MEMBERS.has(prop)) throw this.#unsupported(`io.${String(prop)}()`);
        return this.#trap(target, prop, 'io');
      }
    });
    this.#proxies.set(io, proxy);
    const sockets = new Proxy(io.sockets, { get: (target, prop) => this.#trap(target, prop, 'io.sockets') });
    this.#proxies.set(io.sockets, sockets);
    return proxy;
  }

  /**
   * Maps the real Server / main Namespace back to their proxies, so chained
   * calls (`io.use(m).on(...)`, `io.on('x', f).on(...)`) and back-references
   * (`io.sockets.server`) never escape to the unwrapped objects.
   */
  #wrap(value: unknown): unknown {
    return typeof value === 'object' && value !== null ? (this.#proxies.get(value) ?? value) : value;
  }

  /** Shared get-trap: capture/reject listener methods, forward everything else to the real target. */
  #trap(target: object, prop: string | symbol, label: string): unknown {
    const value: unknown = Reflect.get(target, prop, target);
    if (typeof value !== 'function') return this.#wrap(value);
    const forward = (args: unknown[]): unknown => this.#wrap(Reflect.apply(value, target, args));
    if (!CAPTURING_METHODS.has(prop) && !REJECTED_FOR_CONNECTION.has(prop)) return (...args: unknown[]) => forward(args);
    return (...args: unknown[]): unknown => {
      const [event, listener] = args;
      const pattern = `${label}.${String(prop)}(${event === undefined ? '' : `'${String(event)}'`})`;
      const touchesConnection = CONNECTION_EVENTS.has(event as string | symbol) ||
        (prop === 'removeAllListeners' && args.length === 0);
      if (!touchesConnection) return forward(args);
      if (!CAPTURING_METHODS.has(prop)) throw this.#unsupported(pattern);
      this.#capture(listener, pattern);
      return this.#wrap(target);
    };
  }

  #capture(listener: unknown, pattern: string): void {
    if (typeof listener !== 'function') throw this.#unsupported(`${pattern} without a listener function`);
    // A connection listener receives the connected Socket (socket.io's own typing).
    this.#listeners.push(listener as ConnectionListener);
  }

  #unsupported(pattern: string): UnsupportedLegacyPatternError {
    return new UnsupportedLegacyPatternError(this.moduleName, pattern);
  }
}
