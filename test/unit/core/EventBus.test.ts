import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../../src/core/events/index.ts';
import { Logger } from '../../../src/core/logging/index.ts';
import type { LogRecord } from '../../../src/core/logging/index.ts';

interface Events extends Record<string, unknown> {
  joined: { id: string };
  left: string;
}

const make = (): { bus: EventBus<Events>; logs: LogRecord[] } => {
  const logs: LogRecord[] = [];
  return { bus: new EventBus<Events>(new Logger({ sink: (r) => logs.push(r) })), logs };
};

test('delivers payloads to all handlers in subscription order', () => {
  const { bus } = make();
  const seen: string[] = [];
  bus.on('joined', (p) => { seen.push(`a:${p.id}`); });
  bus.on('joined', (p) => { seen.push(`b:${p.id}`); });
  bus.on('left', (p) => { seen.push(`left:${p}`); });
  bus.emit('joined', { id: 'x' });
  assert.deepEqual(seen, ['a:x', 'b:x']);
});

test('emit with no handlers is a no-op', () => {
  const { bus } = make();
  assert.doesNotThrow(() => bus.emit('left', 'nobody'));
  assert.equal(bus.listenerCount('left'), 0);
});

test('unsubscribe function removes only that subscription and is idempotent', () => {
  const { bus } = make();
  const seen: string[] = [];
  const offA = bus.on('left', () => { seen.push('a'); });
  bus.on('left', () => { seen.push('b'); });
  offA();
  offA();
  bus.emit('left', 'x');
  assert.deepEqual(seen, ['b']);
  assert.equal(bus.listenerCount('left'), 1);
});

test('off() removes every subscription of a handler', () => {
  const { bus } = make();
  let calls = 0;
  const h = (): void => { calls++; };
  bus.on('left', h);
  bus.once('left', h);
  bus.off('left', h);
  bus.emit('left', 'x');
  assert.equal(calls, 0);
  assert.equal(bus.listenerCount('left'), 0);
});

test('once() fires a single time', () => {
  const { bus } = make();
  const seen: string[] = [];
  bus.once('left', (p) => { seen.push(p); });
  bus.emit('left', '1');
  bus.emit('left', '2');
  assert.deepEqual(seen, ['1']);
});

test('once() unsubscribe before emit prevents delivery', () => {
  const { bus } = make();
  let called = false;
  const off = bus.once('left', () => { called = true; });
  off();
  bus.emit('left', 'x');
  assert.equal(called, false);
});

test('a once handler that re-emits does not run twice', () => {
  const { bus } = make();
  let calls = 0;
  bus.once('left', () => { calls++; bus.emit('left', 'again'); });
  bus.emit('left', 'x');
  assert.equal(calls, 1);
});

test('a throwing handler is logged and does not stop the others', () => {
  const { bus, logs } = make();
  const seen: string[] = [];
  bus.on('left', () => { throw new Error('bad'); });
  bus.on('left', (p) => { seen.push(p); });
  assert.doesNotThrow(() => bus.emit('left', 'x'));
  assert.deepEqual(seen, ['x']);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, 'error');
  assert.match(logs[0]?.message ?? '', /"left"/);
  assert.equal((logs[0]?.args[0] as Error).message, 'bad');
});

test('an async handler rejection is caught, logged and does not stop the others', async () => {
  const { bus, logs } = make();
  const seen: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    bus.on('left', async () => { throw new Error('async bad'); });
    bus.on('left', (p) => { seen.push(p); });
    bus.emit('left', 'x');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(seen, ['x']);
  assert.deepEqual(unhandled, []);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.level, 'error');
  assert.match(logs[0]?.message ?? '', /"left" threw/);
  assert.equal((logs[0]?.args[0] as Error).message, 'async bad');
});

test('a resolving async handler logs nothing', async () => {
  const { bus, logs } = make();
  bus.on('left', async () => {});
  bus.emit('left', 'x');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.length, 0);
});

test('handlers added during emit run on the next emit only', () => {
  const { bus } = make();
  const seen: string[] = [];
  bus.on('left', () => { bus.on('left', (p) => { seen.push(`late:${p}`); }); });
  bus.emit('left', '1');
  assert.deepEqual(seen, []);
  bus.emit('left', '2');
  assert.deepEqual(seen, ['late:2']);
});
