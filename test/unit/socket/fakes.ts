import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io';
import { Logger } from '../../../src/core/logging/index.ts';
import type { LogRecord } from '../../../src/core/logging/index.ts';

/** Minimal stand-in for a socket.io Socket: EventEmitter + id + recorded emits. */
export class FakeSocket extends EventEmitter {
  readonly id: string;
  readonly emitted: Array<[string, unknown]> = [];

  constructor(id = 'sock-1') {
    super();
    this.id = id;
  }

  /** Records outgoing emits (socket.io semantics) instead of firing local listeners. */
  override emit(event: string, ...args: unknown[]): boolean {
    this.emitted.push([event, args[0]]);
    return true;
  }

  /** Simulates the client sending `event` with `args`. */
  receive(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners(event)) (listener as (...a: unknown[]) => void)(...args);
  }

  /** Typed view for APIs that expect a socket.io Socket; only on/emit/id are used. */
  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

export const captureLogger = (): { logger: Logger; logs: LogRecord[] } => {
  const logs: LogRecord[] = [];
  return { logger: new Logger({ minLevel: 'debug', sink: (r) => logs.push(r) }), logs };
};

/** Resolves after pending promise callbacks have run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
