import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installProcessGuards } from '../../../src/app/index.ts';
import { Logger } from '../../../src/core/logging/index.ts';

test('guards log uncaughtException / unhandledRejection in the legacy console format', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const fakeProcess = new EventEmitter();
  installProcessGuards(new Logger().child('FATAL-GUARD'), fakeProcess as unknown as NodeJS.Process);
  const err = new Error('bad payload');
  fakeProcess.emit('uncaughtException', err);
  fakeProcess.emit('unhandledRejection', 'plain reason');
  assert.deepEqual(error.mock.calls.map((c) => c.arguments), [
    ['[FATAL-GUARD] uncaughtException:', err.stack],
    ['[FATAL-GUARD] unhandledRejection:', 'plain reason']
  ]);
});

test('guards duck-type `stack` like legacy (plain object with a stack, cross-realm errors)', (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const fakeProcess = new EventEmitter();
  installProcessGuards(new Logger().child('FATAL-GUARD'), fakeProcess as unknown as NodeJS.Process);
  fakeProcess.emit('uncaughtException', { stack: 'custom stack' });
  fakeProcess.emit('unhandledRejection', { stack: '' });
  fakeProcess.emit('unhandledRejection', null);
  assert.deepEqual(error.mock.calls.map((c) => c.arguments[1]), ['custom stack', { stack: '' }, null]);
});
