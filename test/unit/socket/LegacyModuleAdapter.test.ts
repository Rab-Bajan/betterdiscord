import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import { io as connectClient } from 'socket.io-client';
import { LegacyModuleAdapter, SocketServer, UnsupportedLegacyPatternError } from '../../../src/infrastructure/socket/index.ts';
import { FakeSocket, captureLogger } from './fakes.ts';

const makeAdapter = (name = 'mod'): { adapter: LegacyModuleAdapter; real: Server; logs: ReturnType<typeof captureLogger>['logs'] } => {
  const real = new Server();
  const { logger, logs } = captureLogger();
  return { adapter: new LegacyModuleAdapter(name, real, logger), real, logs };
};

describe('capturing connection listeners', () => {
  test('io.on / io.addListener / io.sockets.on for connection|connect are captured, not attached', () => {
    const { adapter, real } = makeAdapter();
    const order: string[] = [];
    adapter.io.on('connection', (s: Socket) => { order.push(`on:${s.id}`); });
    adapter.io.addListener('connect', (s: Socket) => { order.push(`add:${s.id}`); });
    adapter.io.sockets.on('connection', (s: Socket) => { order.push(`ns:${s.id}`); });
    assert.equal(adapter.listenerCount, 3);
    assert.equal(real.sockets.listenerCount('connection'), 0);
    adapter.register(new FakeSocket('s1').asSocket());
    assert.deepEqual(order, ['on:s1', 'add:s1', 'ns:s1']);
  });

  test('io.on returns the proxy so legacy chaining stays inside the adapter', () => {
    const { adapter } = makeAdapter();
    const returned = adapter.io.on('connection', () => {});
    assert.equal(returned, adapter.io);
  });

  test('a throwing listener is logged and the module\'s next listener still runs', () => {
    const { adapter, logs } = makeAdapter('chat');
    let second = false;
    adapter.io.on('connection', () => { throw new Error('boom'); });
    adapter.io.on('connection', () => { second = true; });
    adapter.register(new FakeSocket('s9').asSocket());
    assert.equal(second, true);
    assert.equal(logs[0]?.level, 'error');
    assert.match(logs[0]?.message ?? '', /\[chat\] connection listener failed \(socket s9\)/);
  });

  test('a non-function listener fails loudly', () => {
    const { adapter } = makeAdapter();
    assert.throws(() => adapter.io.on('connection', 'nope' as never), UnsupportedLegacyPatternError);
  });
});

describe('forwarding', () => {
  test('emit / to / in / sockets.sockets / sockets.setMaxListeners reach the real server', () => {
    const { adapter, real } = makeAdapter();
    assert.equal(adapter.io.sockets.sockets, real.sockets.sockets);
    assert.equal(adapter.io.engine, real.engine);
    assert.equal(typeof adapter.io.to('room').emit, 'function');
    assert.equal(typeof adapter.io.in('room').socketsLeave, 'function');
    assert.equal(adapter.io.emit('anything', 1), true);
    adapter.io.sockets.setMaxListeners(42);
    assert.equal(real.sockets.getMaxListeners(), 42);
  });

  test('non-connection listeners are forwarded to the real target', () => {
    const { adapter, real } = makeAdapter();
    const fn = (): void => {};
    adapter.io.on('new_namespace', fn);
    assert.equal(real.listenerCount('new_namespace'), 1);
    adapter.io.off('new_namespace', fn);
    assert.equal(real.listenerCount('new_namespace'), 0);
    adapter.io.sockets.on('custom', fn);
    assert.equal(real.sockets.listenerCount('custom'), 1);
  });
});

describe('chained and indirect access cannot bypass the capture', () => {
  const cases: Array<[string, (io: Server, fn: (s: Socket) => void) => unknown]> = [
    ["io.use(m).on('connection')", (io, fn) => io.use((_s, next) => next()).on('connection', fn)],
    ["io.on('x', f).on('connection')", (io, fn) => io.on('new_namespace', () => {}).on('connection', fn)],
    ["io.sockets.server.on('connection')", (io, fn) => io.sockets.server.on('connection', fn)],
    ["io.sockets.use(m).on('connection')", (io, fn) => io.sockets.use((_s, next) => next()).on('connection', fn)]
  ];
  for (const [pattern, use] of cases) {
    test(pattern, () => {
      const { adapter, real } = makeAdapter();
      const seen: string[] = [];
      use(adapter.io, (s) => { seen.push(s.id); });
      assert.equal(real.sockets.listenerCount('connection'), 0, 'must not reach the real namespace');
      assert.equal(adapter.listenerCount, 1);
      adapter.register(new FakeSocket('c1').asSocket());
      assert.deepEqual(seen, ['c1']);
    });
  }

  test('io.sockets.server is the Server proxy and io.sockets stays the namespace proxy', () => {
    const { adapter } = makeAdapter();
    assert.equal(adapter.io.sockets.server, adapter.io);
    assert.equal(adapter.io.sockets.server.sockets, adapter.io.sockets);
  });
});

describe('unsupported patterns fail at startup', () => {
  const cases: Array<[string, (io: Server) => unknown]> = [
    ["io.once('connection')", (io) => io.once('connection', () => {})],
    ["io.prependListener('connection')", (io) => io.prependListener('connection', () => {})],
    ["io.off('connection')", (io) => io.off('connection', () => {})],
    ["io.removeAllListeners()", (io) => io.removeAllListeners()],
    ["io.removeAllListeners('connection')", (io) => io.removeAllListeners('connection')],
    ["io.sockets.once('connect')", (io) => io.sockets.once('connect', () => {})],
    ["io.sockets.removeListener('connection')", (io) => io.sockets.removeListener('connection', () => {})],
    ['io.of()', (io) => io.of('/admin')]
  ];
  for (const [pattern, use] of cases) {
    test(pattern, () => {
      const { adapter } = makeAdapter('weird');
      assert.throws(() => use(adapter.io), (err: unknown) => {
        assert.ok(err instanceof UnsupportedLegacyPatternError);
        assert.match(err.message, /Legacy module "weird" uses unsupported io pattern/);
        return true;
      });
    });
  }
});

test('real socket.io: two legacy modules behind one connection listener, io.to() broadcasts work', async (t) => {
  const http = createServer();
  const io = new Server(http);
  const { logger } = captureLogger();
  const server = new SocketServer(io, logger);
  const order: string[] = [];
  for (const name of ['first', 'second']) {
    const adapter = new LegacyModuleAdapter(name, io, logger);
    // Legacy-style factory: attaches listeners on the io it is given and broadcasts through it.
    ((legacyIo: Server) => {
      legacyIo.on('connection', (socket) => {
        order.push(name);
        socket.on(`${name}:ping`, () => { legacyIo.to(socket.id).emit(`${name}:pong`, { from: name }); });
      });
    })(adapter.io);
    server.addController(adapter);
  }
  server.start();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const client = connectClient(`http://127.0.0.1:${(http.address() as AddressInfo).port}`, { transports: ['websocket'], forceNew: true });
  t.after(async () => { client.close(); await io.close(); });
  await new Promise<void>((resolve) => client.once('connect', resolve));
  const pong = new Promise((resolve) => client.once('second:pong', resolve));
  client.emit('second:ping');
  assert.deepEqual(await pong, { from: 'second' });
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(io.sockets.listenerCount('connection'), 1);
});
