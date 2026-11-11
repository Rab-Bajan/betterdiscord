import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomSessionManager } from '../../../src/core/session/index.ts';

interface Game { channelId: string; moves: number }

test('get/has/size on an empty manager', () => {
  const m = new RoomSessionManager<Game>();
  assert.equal(m.get('a'), undefined);
  assert.equal(m.has('a'), false);
  assert.equal(m.size, 0);
  assert.deepEqual(m.all(), []);
  assert.deepEqual(m.entries(), []);
});

test('getOrCreate builds once and then returns the stored session', () => {
  const m = new RoomSessionManager<Game>();
  let built = 0;
  const factory = (channelId: string): Game => { built++; return { channelId, moves: 0 }; };
  const first = m.getOrCreate('room', factory);
  first.moves = 3;
  const second = m.getOrCreate('room', factory);
  assert.equal(second, first);
  assert.equal(built, 1);
  assert.equal(first.channelId, 'room');
  assert.equal(m.has('room'), true);
});

test('getOrCreate keeps falsy sessions without rebuilding', () => {
  const m = new RoomSessionManager<number>();
  let built = 0;
  m.getOrCreate('a', () => { built++; return 0; });
  assert.equal(m.getOrCreate('a', () => { built++; return 5; }), 0);
  assert.equal(built, 1);
});

test('set replaces, delete reports existence, clear empties', () => {
  const m = new RoomSessionManager<Game>();
  m.set('a', { channelId: 'a', moves: 1 });
  m.set('a', { channelId: 'a', moves: 2 });
  m.set('b', { channelId: 'b', moves: 0 });
  assert.equal(m.get('a')?.moves, 2);
  assert.equal(m.size, 2);
  assert.equal(m.delete('a'), true);
  assert.equal(m.delete('a'), false);
  m.clear();
  assert.equal(m.size, 0);
});

test('entries/all are snapshots in insertion order', () => {
  const m = new RoomSessionManager<Game>();
  m.set('a', { channelId: 'a', moves: 1 });
  m.set('b', { channelId: 'b', moves: 2 });
  for (const [id] of m.entries()) m.delete(id);
  assert.equal(m.size, 0);
  m.set('x', { channelId: 'x', moves: 0 });
  m.set('y', { channelId: 'y', moves: 0 });
  assert.deepEqual(m.all().map((g) => g.channelId), ['x', 'y']);
  assert.deepEqual(m.entries().map(([id]) => id), ['x', 'y']);
});

test('toRecord produces the legacy getXSessions() shape', () => {
  const m = new RoomSessionManager<Game>();
  m.set('hang-chill', { channelId: 'hang-chill', moves: 4 });
  m.set('hang-gaming-1', { channelId: 'hang-gaming-1', moves: 0 });
  const record = m.toRecord((g, id) => ({ id, moves: g.moves }));
  assert.deepEqual(record, {
    'hang-chill': { id: 'hang-chill', moves: 4 },
    'hang-gaming-1': { id: 'hang-gaming-1', moves: 0 }
  });
  assert.deepEqual(new RoomSessionManager<Game>().toRecord((g) => g), {});
});

test('toRecord keeps a "__proto__" channelId as an own key', () => {
  const m = new RoomSessionManager<string>();
  m.set('__proto__', 'evil');
  const record = m.toRecord((s) => s);
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
  assert.deepEqual(Object.keys(record), ['__proto__']);
  assert.equal(Object.getOwnPropertyDescriptor(record, '__proto__')?.value, 'evil');
});
