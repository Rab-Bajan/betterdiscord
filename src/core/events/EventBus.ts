import { Logger } from '../logging/Logger.ts';

/** Handler for one event of an {@link EventBus}; a returned promise is not awaited, but its rejection is caught. */
export type EventHandler<T> = (payload: T) => void | Promise<void>;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as { then?: unknown }).then === 'function';

interface Listener<T> {
  handler: EventHandler<T>;
  once: boolean;
}

/**
 * Strongly typed, synchronous in-process event bus.
 *
 * Handlers run in subscription order. A throwing handler (or one whose
 * returned promise rejects) is logged and the remaining handlers still run:
 * one bad listener must not take down the rest.
 *
 * @example
 *   const bus = new EventBus<{ 'user:joined': { id: string } }>();
 *   const off = bus.on('user:joined', ({ id }) => ...);
 */
export class EventBus<TEvents extends Record<string, unknown>> {
  readonly #listeners = new Map<keyof TEvents, Listener<never>[]>();
  readonly #logger: Logger;

  constructor(logger: Logger = new Logger({ scope: 'EventBus' })) {
    this.#logger = logger;
  }

  /** Subscribes; returns an unsubscribe function. */
  on<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): () => void {
    return this.#add(event, { handler, once: false });
  }

  /** Subscribes for the next emission only; returns an unsubscribe function. */
  once<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): () => void {
    return this.#add(event, { handler, once: true });
  }

  /** Removes every subscription of `handler` (on and once) for `event`. */
  off<K extends keyof TEvents>(event: K, handler: EventHandler<TEvents[K]>): void {
    const list = this.#get(event).filter((listener) => listener.handler !== handler);
    this.#set(event, list);
  }

  /** Delivers `payload` to the current handlers of `event`. */
  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    const snapshot = this.#get(event);
    if (snapshot.some((listener) => listener.once)) this.#set(event, snapshot.filter((l) => !l.once));
    for (const listener of snapshot) this.#invoke(event, listener, payload);
  }

  /** Number of handlers currently subscribed to `event`. */
  listenerCount(event: keyof TEvents): number {
    return this.#get(event).length;
  }

  #invoke<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>, payload: TEvents[K]): void {
    const report = (err: unknown): void => this.#logger.error(`Handler for "${String(event)}" threw`, err);
    try {
      const result: unknown = listener.handler(payload);
      if (isThenable(result)) result.then(undefined, report);
    } catch (err) {
      report(err);
    }
  }

  #add<K extends keyof TEvents>(event: K, listener: Listener<TEvents[K]>): () => void {
    this.#set(event, [...this.#get(event), listener]);
    return () => this.#set(event, this.#get(event).filter((l) => l !== listener));
  }

  #get<K extends keyof TEvents>(event: K): Listener<TEvents[K]>[] {
    // Listeners are stored per key; the key guarantees the payload type.
    return (this.#listeners.get(event) ?? []) as Listener<TEvents[K]>[];
  }

  #set<K extends keyof TEvents>(event: K, list: Listener<TEvents[K]>[]): void {
    if (list.length === 0) this.#listeners.delete(event);
    else this.#listeners.set(event, list as Listener<never>[]);
  }
}
