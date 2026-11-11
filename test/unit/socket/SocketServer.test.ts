import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io';
import { SocketServer } from '../../../src/infrastructure/socket/index.ts';
import { SocketController } from '../../../src/core/socket/index.ts';
import type { InitialStateProvider, RoomStateProvider } from '../../../src/core/socket/index.ts';
import type { Logger } from '../../../src/core/logging/index.ts';
import { FakeSocket, captureLogger } from './fakes.ts';

/** Records the order in which controllers are registered on each socket. */
class OrderController extends SocketController {
  readonly #name: string;
  readonly #order: string[];

  constructor(logger: Logger, name: string, order: string[]) {
    super(logger);
    this.#name = name;
    this.#order = order;
  }

  register(socket: Socket): void {
    this.#order.push(`${this.#name}:${socket.id}`);
  }
}

class BrokenController extends SocketController {
  register(): void {
    throw new Error('register failed');
  }
}

const connect = (io: EventEmitter, id: string): FakeSocket => {
  const socket = new FakeSocket(id);
  io.emit('connection', socket.asSocket());
  return socket;
};

const initial = (state: Record<string, unknown>): InitialStateProvider => ({ getInitialState: () => state });
const room = (fn: RoomStateProvider['getRoomState']): RoomStateProvider => ({ getRoomState: fn });

describe('connection handling', () => {
  test('start() adds exactly one connection listener and cannot run twice', () => {
    const io = new EventEmitter();
    const { logger } = captureLogger();
    const server = new SocketServer(io, logger);
    server.addController(new OrderController(logger, 'a', [])).addController(new OrderController(logger, 'b', []));
    assert.equal(io.listenerCount('connection'), 0);
    server.start();
    assert.equal(io.listenerCount('connection'), 1);
    assert.throws(() => server.start(), /already started/);
    assert.equal(io.listenerCount('connection'), 1);
  });

  test('registers every controller per socket in registration order', () => {
    const io = new EventEmitter();
    const { logger } = captureLogger();
    const order: string[] = [];
    const server = new SocketServer(io, logger);
    for (const name of ['auth', 'voice', 'chat']) server.addController(new OrderController(logger, name, order));
    server.start();
    connect(io, 's1');
    connect(io, 's2');
    assert.deepEqual(order, ['auth:s1', 'voice:s1', 'chat:s1', 'auth:s2', 'voice:s2', 'chat:s2']);
  });

  test('a controller whose register throws is logged and the rest still register', () => {
    const io = new EventEmitter();
    const { logger, logs } = captureLogger();
    const order: string[] = [];
    new SocketServer(io, logger)
      .addController(new BrokenController(logger))
      .addController(new OrderController(logger, 'ok', order))
      .start();
    assert.doesNotThrow(() => connect(io, 's1'));
    assert.deepEqual(order, ['ok:s1']);
    assert.equal(logs[0]?.level, 'error');
    assert.match(logs[0]?.message ?? '', /BrokenController\.register failed/);
  });

  test('controllers added after start() apply to later connections', () => {
    const io = new EventEmitter();
    const { logger } = captureLogger();
    const order: string[] = [];
    const server = new SocketServer(io, logger);
    server.start();
    connect(io, 'early');
    server.addController(new OrderController(logger, 'late', order));
    connect(io, 'next');
    assert.deepEqual(order, ['late:next']);
  });
});

describe('buildInitialState', () => {
  test('is empty without providers', () => {
    const { logger } = captureLogger();
    assert.deepEqual(new SocketServer(new EventEmitter(), logger).buildInitialState(), {});
  });

  test('merges provider keys in order', () => {
    const { logger } = captureLogger();
    const server = new SocketServer(new EventEmitter(), logger)
      .addInitialStateProvider(initial({ channelMessages: { altalanos: [] } }))
      .addInitialStateProvider(initial({ chessSessions: { 'hang-chill': { status: 'waiting' } }, watchSessions: {} }));
    const state = server.buildInitialState();
    assert.deepEqual(state, {
      channelMessages: { altalanos: [] },
      chessSessions: { 'hang-chill': { status: 'waiting' } },
      watchSessions: {}
    });
    assert.deepEqual(Object.keys(state), ['channelMessages', 'chessSessions', 'watchSessions']);
  });

  test('is recomputed on every call (live state)', () => {
    const { logger } = captureLogger();
    let n = 0;
    const server = new SocketServer(new EventEmitter(), logger).addInitialStateProvider({ getInitialState: () => ({ n: ++n }) });
    assert.deepEqual(server.buildInitialState(), { n: 1 });
    assert.deepEqual(server.buildInitialState(), { n: 2 });
  });

  test('duplicate keys: last wins and a warning is logged', () => {
    const { logger, logs } = captureLogger();
    const state = new SocketServer(new EventEmitter(), logger)
      .addInitialStateProvider(initial({ k: 1 }))
      .addInitialStateProvider(initial({ k: 2 }))
      .buildInitialState();
    assert.deepEqual(state, { k: 2 });
    assert.equal(logs[0]?.level, 'warn');
    assert.match(logs[0]?.message ?? '', /"k" provided twice/);
  });

  test('a throwing provider is skipped and logged', () => {
    const { logger, logs } = captureLogger();
    const state = new SocketServer(new EventEmitter(), logger)
      .addInitialStateProvider({ getInitialState: () => { throw new Error('nope'); } })
      .addInitialStateProvider(initial({ ok: true }))
      .buildInitialState();
    assert.deepEqual(state, { ok: true });
    assert.equal(logs[0]?.level, 'error');
  });

  test('a "__proto__" key stays an own property', () => {
    const { logger } = captureLogger();
    const state = new SocketServer(new EventEmitter(), logger)
      .addInitialStateProvider(initial(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>))
      .buildInitialState();
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
    assert.deepEqual(Object.keys(state), ['__proto__']);
  });
});

describe('emitRoomState', () => {
  test('emits every provider event in provider order then event order', () => {
    const { logger } = captureLogger();
    const server = new SocketServer(new EventEmitter(), logger)
      .addRoomStateProvider(room((id) => [{ event: 'game:session-updated', payload: { channelId: id, state: null } }]))
      .addRoomStateProvider(room((id) => [
        { event: 'whiteboard:list', payload: [`${id}-board`] },
        { event: 'code:tree-data', payload: { root: id } }
      ]));
    const socket = new FakeSocket();
    server.emitRoomState(socket, 'hang-chill');
    assert.deepEqual(socket.emitted, [
      ['game:session-updated', { channelId: 'hang-chill', state: null }],
      ['whiteboard:list', ['hang-chill-board']],
      ['code:tree-data', { root: 'hang-chill' }]
    ]);
  });

  test('providers returning nothing emit nothing', () => {
    const { logger } = captureLogger();
    const socket = new FakeSocket();
    new SocketServer(new EventEmitter(), logger).addRoomStateProvider(room(() => [])).emitRoomState(socket, 'x');
    assert.deepEqual(socket.emitted, []);
  });

  test('a throwing provider is logged and later providers still emit', () => {
    const { logger, logs } = captureLogger();
    const socket = new FakeSocket();
    new SocketServer(new EventEmitter(), logger)
      .addRoomStateProvider(room(() => { throw new Error('broken'); }))
      .addRoomStateProvider(room(() => [{ event: 'watch:state', payload: null }]))
      .emitRoomState(socket, 'room-1');
    assert.deepEqual(socket.emitted, [['watch:state', null]]);
    assert.match(logs[0]?.message ?? '', /room state provider \(room-1\) failed/);
  });
});
