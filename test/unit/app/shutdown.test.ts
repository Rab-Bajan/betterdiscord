import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installShutdownHandlers } from '../../../src/app/shutdown.ts';
import { Logger } from '../../../src/core/logging/Logger.ts';

const quiet = (): Logger => new Logger({ minLevel: 'error', sink: () => undefined });
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('SIGTERM runs stop once, then exits 0; a second signal is ignored', async () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  let stops = 0;
  installShutdownHandlers(async () => { stops++; }, quiet(), { target, exit: (code) => exits.push(code) });
  target.emit('SIGTERM');
  target.emit('SIGINT');
  await nextTurn();
  assert.equal(stops, 1);
  assert.deepEqual(exits, [0]);
});

test('a failing stop still exits 0', async () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  installShutdownHandlers(() => Promise.reject(new Error('boom')), quiet(), { target, exit: (code) => exits.push(code) });
  target.emit('SIGINT');
  await nextTurn();
  assert.deepEqual(exits, [0]);
});

test('a hanging stop exits after the timeout', async () => {
  const target = new EventEmitter();
  const exits: number[] = [];
  installShutdownHandlers(() => new Promise<void>(() => undefined), quiet(), { target, exit: (code) => exits.push(code), timeoutMs: 20 });
  target.emit('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(exits, [0]);
});
