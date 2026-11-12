import type { Socket } from 'socket.io';
import type { Logger } from '../../core/logging/Logger.ts';
import type { SocketController } from '../../core/socket/SocketController.ts';
import type { InitialStateProvider, RoomStateProvider } from '../../core/socket/SocketStateProviders.ts';

/** The slice of a socket.io `Server` this class uses (a real `Server` satisfies it). */
export interface ConnectionSource {
  on(event: 'connection', listener: (socket: Socket) => void): unknown;
}

/** The slice of a socket.io `Socket` needed to push room state. */
export interface EmitTarget {
  readonly id: string;
  emit(event: string, ...args: unknown[]): unknown;
}

/**
 * Owns the single `io.on('connection')` listener (replacing one per legacy
 * handler) and the registries that tie feature modules together:
 * controllers (bound per socket, in registration order), initial-state
 * providers (`init:data`) and room-state providers (voice room join).
 * It never creates or listens on an HTTP server itself.
 */
export class SocketServer {
  readonly #io: ConnectionSource;
  readonly #logger: Logger;
  readonly #controllers: SocketController[] = [];
  readonly #initialState: InitialStateProvider[] = [];
  readonly #roomState: RoomStateProvider[] = [];
  #started = false;

  constructor(io: ConnectionSource, logger: Logger) {
    this.#io = io;
    this.#logger = logger;
  }

  /** Adds a controller; it is bound on every socket that connects afterwards. */
  addController(controller: SocketController): this {
    this.#controllers.push(controller);
    return this;
  }

  addInitialStateProvider(provider: InitialStateProvider): this {
    this.#initialState.push(provider);
    return this;
  }

  addRoomStateProvider(provider: RoomStateProvider): this {
    this.#roomState.push(provider);
    return this;
  }

  /** Attaches the one connection listener. Throws if called twice. */
  start(): void {
    if (this.#started) throw new Error('SocketServer already started');
    this.#started = true;
    this.#io.on('connection', (socket) => this.#onConnection(socket));
  }

  /**
   * Merges every provider's keys in registration order (later wins on a
   * duplicate key, which is logged). A throwing provider is skipped.
   */
  buildInitialState(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    for (const provider of this.#initialState) {
      const part = this.#safely('initial state provider', () => provider.getInitialState());
      if (part) this.#merge(state, part);
    }
    return state;
  }

  /**
   * Emits each room-state provider's events to `socket`, providers and events
   * in order. A throwing provider is logged and the next one still runs.
   */
  emitRoomState(socket: EmitTarget, channelId: string): void {
    for (const provider of this.#roomState) {
      this.#safely(`room state provider (${channelId})`, () => {
        for (const { event, payload } of provider.getRoomState(channelId)) socket.emit(event, payload);
      });
    }
  }

  #onConnection(socket: Socket): void {
    for (const controller of this.#controllers) {
      this.#safely(`${controller.constructor.name}.register`, () => controller.register(socket));
    }
  }

  #merge(target: Record<string, unknown>, part: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(part)) {
      if (Object.hasOwn(target, key)) this.#logger.warn(`init:data key "${key}" provided twice; last one wins`);
      Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }

  #safely<T>(label: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.#logger.error(`${label} failed`, err);
      return undefined;
    }
  }
}
