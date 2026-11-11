import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, consoleSink } from '../../../src/core/logging/index.ts';
import type { LogRecord } from '../../../src/core/logging/index.ts';

const capture = (): { records: LogRecord[]; sink: (r: LogRecord) => void } => {
  const records: LogRecord[] = [];
  return { records, sink: (r) => records.push(r) };
};

test('default minLevel is info: debug is dropped', () => {
  const { records, sink } = capture();
  const log = new Logger({ sink });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(records.map((r) => [r.level, r.message]), [['info', 'i'], ['warn', 'w'], ['error', 'e']]);
});

test('minLevel filters lower levels', () => {
  const { records, sink } = capture();
  const log = new Logger({ sink, minLevel: 'warn' });
  log.info('i');
  log.warn('w');
  assert.deepEqual(records.map((r) => r.level), ['warn']);
  assert.equal(log.isEnabled('error'), true);
  assert.equal(log.isEnabled('info'), false);
  assert.equal(new Logger({ sink, minLevel: 'debug' }).isEnabled('debug'), true);
});

test('records carry scope, args and time', () => {
  const { records, sink } = capture();
  const err = new Error('x');
  new Logger({ sink, scope: 'Chess' }).error('failed', err, { id: 1 });
  const [rec] = records;
  assert.ok(rec);
  assert.equal(rec.scope, 'Chess');
  assert.deepEqual(rec.args, [err, { id: 1 }]);
  assert.ok(rec.time instanceof Date);
});

test('child() nests scope and inherits sink and level', () => {
  const { records, sink } = capture();
  const root = new Logger({ sink, minLevel: 'debug' });
  const child = root.child('Socket').child('Chat');
  child.debug('hi');
  assert.equal(child.scope, 'Socket:Chat');
  assert.equal(child.minLevel, 'debug');
  assert.equal(records[0]?.scope, 'Socket:Chat');
  assert.equal(root.scope, '');
});

test('a throwing sink never propagates', () => {
  const log = new Logger({ sink: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => log.error('x'));
});

test('consoleSink prefixes scope and uses the matching console method', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const info = t.mock.method(console, 'info', () => {});
  consoleSink({ level: 'warn', scope: 'Voice', message: 'm', args: [1], time: new Date() });
  consoleSink({ level: 'info', scope: '', message: 'plain', args: [], time: new Date() });
  assert.deepEqual(warn.mock.calls[0]?.arguments, ['[Voice] m', 1]);
  assert.deepEqual(info.mock.calls[0]?.arguments, ['plain']);
});

test('default sink is console', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  new Logger({ scope: 'S' }).error('boom');
  assert.deepEqual(error.mock.calls[0]?.arguments, ['[S] boom']);
});
