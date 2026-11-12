import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CallRecordInput } from '../../../src/infrastructure/database/index.ts';
import { openMemory } from './support.ts';

function call(id: string, createdAt: number, extra: Partial<CallRecordInput> = {}): CallRecordInput {
  return {
    id,
    dmKey: 'a|b',
    callerAccountId: 'acc-a',
    callerUsername: 'Alice',
    calleeAccountId: 'acc-b',
    calleeUsername: 'Bob',
    status: 'ringing',
    createdAt,
    ...extra
  };
}

test('saveCall applies defaults for omitted optional fields', (t) => {
  const { calls, database } = openMemory(t);
  calls.saveCall(call('c1', 10));
  assert.deepEqual(database.connection.prepare('SELECT * FROM calls').all(), [
    {
      id: 'c1',
      dm_key: 'a|b',
      caller_account_id: 'acc-a',
      caller_username: 'Alice',
      callee_account_id: 'acc-b',
      callee_username: 'Bob',
      status: 'ringing',
      created_at: 10,
      answered_at: null,
      ended_at: null,
      duration_sec: 0,
      end_reason: null
    }
  ]);
});

test('saveCall replaces an existing call by id', (t) => {
  const { calls } = openMemory(t);
  calls.saveCall(call('c1', 10));
  calls.saveCall(call('c1', 10, { status: 'ended', answeredAt: 11, endedAt: 70, durationSec: 59, endReason: 'hangup' }));
  assert.deepEqual(calls.getCallHistory('a|b'), [
    { id: 'c1', callerUsername: 'Alice', calleeUsername: 'Bob', status: 'ended', createdAt: 10, durationSec: 59 }
  ]);
});

test('getCallHistory: newest first, per conversation, limit (default 50)', (t) => {
  const { calls } = openMemory(t);
  for (let i = 1; i <= 60; i++) calls.saveCall(call(`c${i}`, i));
  calls.saveCall(call('other', 5, { dmKey: 'x|y' }));
  const list = calls.getCallHistory('a|b');
  assert.equal(list.length, 50);
  assert.equal(list[0]?.id, 'c60');
  assert.equal(list[49]?.id, 'c11');
  assert.deepEqual(calls.getCallHistory('a|b', 2).map((c) => c.id), ['c60', 'c59']);
  assert.deepEqual(calls.getCallHistory('none'), []);
});

test('getCallHistory maps NULL duration to 0', (t) => {
  const { calls, database } = openMemory(t);
  calls.saveCall(call('c1', 1));
  database.connection.prepare('UPDATE calls SET duration_sec = NULL').run();
  assert.equal(calls.getCallHistory('a|b')[0]?.durationSec, 0);
});
