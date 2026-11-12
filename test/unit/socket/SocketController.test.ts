import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket } from 'socket.io';
import { SocketController } from '../../../src/core/socket/index.ts';
import type { SocketHandler } from '../../../src/core/socket/index.ts';
import { ForbiddenError, ValidationError } from '../../../src/core/errors/index.ts';
import { PayloadReader } from '../../../src/core/validation/index.ts';
import type { Logger } from '../../../src/core/logging/index.ts';
import { FakeSocket, captureLogger, flush } from './fakes.ts';

/** Controller that binds one event to the handler under test. */
class ProbeController extends SocketController {
  readonly #event: string;
  readonly #handler: SocketHandler;

  constructor(logger: Logger, event: string, handler: SocketHandler) {
    super(logger);
    this.#event = event;
    this.#handler = handler;
  }

  register(socket: Socket): void {
    this.listen(socket, this.#event, this.#handler);
  }
}

const setup = (handler: SocketHandler): { socket: FakeSocket; logs: ReturnType<typeof captureLogger>['logs'] } => {
  const { logger, logs } = captureLogger();
  const socket = new FakeSocket();
  new ProbeController(logger, 'probe', handler).register(socket.asSocket());
  return { socket, logs };
};

const ackSpy = (): { ack: (r: unknown) => void; calls: unknown[] } => {
  const calls: unknown[] = [];
  return { ack: (r) => calls.push(r), calls };
};

describe('payload and context', () => {
  test('passes first data arg as payload and exposes args/socket/event', () => {
    let seen: unknown[] = [];
    const { socket } = setup((payload, ctx) => {
      seen = [payload, ctx.args, ctx.event, ctx.socket.id, ctx.ack];
    });
    socket.receive('probe', { a: 1 }, 'second');
    assert.deepEqual(seen, [{ a: 1 }, [{ a: 1 }, 'second'], 'probe', 'sock-1', undefined]);
  });

  test('an ack passed as the only arg is not treated as payload', () => {
    let payload: unknown = 'unset';
    const { socket } = setup((p) => { payload = p; return { ok: true }; });
    const { ack, calls } = ackSpy();
    socket.receive('probe', ack);
    assert.equal(payload, undefined);
    assert.deepEqual(calls, [{ ok: true }]);
  });

  test('multi-arg events keep data args and strip the trailing ack', () => {
    let args: readonly unknown[] = [];
    const { socket } = setup((_p, ctx) => { args = ctx.args; });
    socket.receive('probe', 'getProfile', { id: 2 }, ackSpy().ack);
    assert.deepEqual(args, ['getProfile', { id: 2 }]);
  });
});

describe('ack on success', () => {
  test('a returned value is sent as the ack', () => {
    const { socket } = setup(() => ({ ok: true, n: 1 }));
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: true, n: 1 }]);
  });

  test('undefined return sends no ack', () => {
    const { socket } = setup(() => undefined);
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, []);
  });

  test('manual ctx.ack wins and the ack fires at most once', () => {
    const { socket } = setup((_p, ctx) => {
      ctx.ack?.({ manual: 1 });
      ctx.ack?.({ manual: 2 });
      return { returned: true };
    });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ manual: 1 }]);
  });

  test('a returned value without client ack is silently dropped', () => {
    const { socket, logs } = setup(() => ({ ok: true }));
    assert.doesNotThrow(() => socket.receive('probe', {}));
    assert.equal(logs.length, 0);
  });

  test('async handler resolves into the ack', async () => {
    const { socket } = setup(async () => ({ ok: true, async: true }));
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    await flush();
    assert.deepEqual(calls, [{ ok: true, async: true }]);
  });
});

describe('errors', () => {
  test('ValidationError from a PayloadReader is acked with message and code', () => {
    const { socket, logs } = setup((p) => new PayloadReader(p).requireString('channelId'));
    const { ack, calls } = ackSpy();
    socket.receive('probe', null, ack);
    assert.deepEqual(calls, [{ ok: false, error: 'Érvénytelen adat.', code: 'VALIDATION_ERROR' }]);
    assert.deepEqual(logs.map((l) => l.level), ['debug']);
    assert.deepEqual(logs[0]?.args, [{ field: 'channelId', reason: 'missing', message: '"channelId" is required.' }]);
  });

  test('ValidationError without ack is swallowed (debug only)', () => {
    const { socket, logs } = setup(() => { throw new ValidationError('bad'); });
    assert.doesNotThrow(() => socket.receive('probe', 'garbage'));
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'debug');
    assert.match(logs[0]?.message ?? '', /Rejected payload for "probe": bad/);
  });

  test('other AppErrors expose their message to the client', () => {
    const { socket, logs } = setup(() => { throw new ForbiddenError('Nincs jogosultságod ehhez.'); });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: false, error: 'Nincs jogosultságod ehhez.', code: 'FORBIDDEN' }]);
    assert.match(logs[0]?.message ?? '', /Request refused/);
  });

  test('clientFields are spread into the failure ack; details are not', () => {
    const { socket } = setup(() => {
      throw new ForbiddenError('Ehhez be kell jelentkezned.', { accountId: null }, { needsLogin: true });
    });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: false, error: 'Ehhez be kell jelentkezned.', code: 'FORBIDDEN', needsLogin: true }]);
  });

  test('clientFields cannot overwrite ok or error', () => {
    const { socket } = setup(() => {
      throw new ForbiddenError('real', undefined, { ok: true, error: 'forged', extra: 1 });
    });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: false, error: 'real', code: 'FORBIDDEN', extra: 1 }]);
  });

  test('sync unexpected error is logged with event name and acked generically', () => {
    const { socket, logs } = setup(() => { throw new TypeError('secret internals'); });
    const { ack, calls } = ackSpy();
    assert.doesNotThrow(() => socket.receive('probe', {}, ack));
    assert.deepEqual(calls, [{ ok: false, error: 'Váratlan hiba történt.' }]);
    assert.equal(logs[0]?.level, 'error');
    assert.match(logs[0]?.message ?? '', /"probe" handler failed \(socket sock-1\)/);
    assert.equal((logs[0]?.args[0] as Error).message, 'secret internals');
  });

  test('async rejection is caught, logged and acked', async () => {
    const { socket, logs } = setup(async () => { throw new Error('db down'); });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    await flush();
    assert.deepEqual(calls, [{ ok: false, error: 'Váratlan hiba történt.' }]);
    assert.equal(logs[0]?.level, 'error');
  });

  test('async ValidationError is acked like a sync one', async () => {
    const { socket } = setup(async () => { throw new ValidationError('nope'); });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    await flush();
    assert.deepEqual(calls, [{ ok: false, error: 'nope', code: 'VALIDATION_ERROR' }]);
  });

  test('error after a manual ack does not ack twice', () => {
    const { socket, logs } = setup((_p, ctx) => {
      ctx.ack?.({ ok: true });
      throw new Error('late');
    });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: true }]);
    assert.equal(logs[0]?.level, 'error');
  });

  test('a throwing client ack is contained', () => {
    const { socket, logs } = setup(() => { throw new Error('first'); });
    const badAck = (): void => { throw new Error('ack broke'); };
    assert.doesNotThrow(() => socket.receive('probe', {}, badAck));
    assert.deepEqual(logs.map((l) => l.level), ['error', 'error']);
  });

  test('a success ack that throws (sync path) is logged as "ack failed", not as handler failure', () => {
    const { socket, logs } = setup(() => ({ ok: true }));
    const badAck = (): void => { throw new RangeError('Maximum call stack size exceeded'); };
    assert.doesNotThrow(() => socket.receive('probe', {}, badAck));
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, 'error');
    assert.equal(logs[0]?.message, '"probe" ack failed');
    assert.equal((logs[0]?.args[0] as Error).name, 'RangeError');
  });

  test('a success ack that throws (async path) is logged and causes no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { socket, logs } = setup(async () => ({ ok: true }));
      const badAck = (): void => { throw new Error('ack serialization failed'); };
      socket.receive('probe', {}, badAck);
      await flush();
      await flush();
      assert.equal(logs.length, 1);
      assert.equal(logs[0]?.message, '"probe" ack failed');
      assert.equal((logs[0]?.args[0] as Error).message, 'ack serialization failed');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    assert.deepEqual(unhandled, []);
  });

  test('non-Error throwables are handled', () => {
    const { socket, logs } = setup(() => { throw 'string thrown'; });
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: false, error: 'Váratlan hiba történt.' }]);
    assert.equal(logs[0]?.args[0], 'string thrown');
  });

  test('subclasses can override the unexpected-error message', () => {
    class English extends ProbeController {
      protected override readonly unexpectedErrorMessage = 'Unexpected error.';
    }
    const { logger } = captureLogger();
    const socket = new FakeSocket();
    new English(logger, 'probe', () => { throw new Error('x'); }).register(socket.asSocket());
    const { ack, calls } = ackSpy();
    socket.receive('probe', {}, ack);
    assert.deepEqual(calls, [{ ok: false, error: 'Unexpected error.' }]);
  });
});
