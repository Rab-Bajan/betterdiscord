import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STROKES, WhiteboardService } from '../../../src/modules/whiteboard/WhiteboardService.ts';
import type { PresenceUser } from '../../../src/modules/presence/UserRegistry.ts';

const user = (voiceChannel: string | null, username = 'Alice'): PresenceUser => ({
  id: `sock-${username}`, accountId: null, username, avatarColor: '#111', avatarUrl: null,
  voiceChannel, isMuted: false, isDeafened: false
});
const ids = { now: () => 1_700_000_000_000, random: () => 0.123456789 };

test('create: only a member of the channel, legacy id and default title', () => {
  const boards = new WhiteboardService(ids);
  assert.equal(boards.create(user('hang-chill'), 'hang-gaming-1', 'x'), null);
  assert.equal(boards.create(undefined, 'hang-chill', 'x'), null);
  assert.equal(boards.create(user(null), null, 'x'), null);
  const board = boards.create(user('hang-chill'), 'hang-chill', '');
  assert.deepEqual(board, {
    id: `board_1700000000000_${(0.123456789).toString(36).substring(2, 7)}`,
    title: 'Alice Rajztáblája', creatorId: 'sock-Alice', creatorName: 'Alice', createdAt: 1_700_000_000_000, strokeCount: 0
  });
  const other = new WhiteboardService({ now: ids.now, random: () => 0.987654321 });
  assert.equal(other.create(user('hang-chill'), 'hang-chill', '  Terv ')?.title, 'Terv');
  assert.equal(boards.create(user('hang-chill'), 'hang-chill', 'same id')?.title, 'same id');
  // Same clock and randomness give the same id: the board is replaced, as in legacy.
  assert.deepEqual(boards.getBoardList('hang-chill').map((b) => b.title), ['same id']);
  assert.deepEqual(boards.getBoardList('nincs'), []);
});

test('find is open to anyone; findEditable requires membership', () => {
  const boards = new WhiteboardService(ids);
  const summary = boards.create(user('hang-chill'), 'hang-chill', 'T');
  assert.ok(summary);
  assert.equal(boards.find('hang-chill', summary.id)?.title, 'T');
  assert.equal(boards.find('hang-chill', 7), undefined);
  assert.equal(boards.findEditable(user('gaming'), 'hang-chill', summary.id), undefined);
  assert.equal(boards.findEditable(user('hang-chill', 'Bob'), 'hang-chill', summary.id)?.id, summary.id);
});

test('draw keeps at most MAX_STROKES (oldest dropped); clear and delete', () => {
  const boards = new WhiteboardService(ids);
  const summary = boards.create(user('r'), 'r', 'T');
  assert.ok(summary);
  const board = boards.find('r', summary.id);
  assert.ok(board);
  for (let i = 0; i <= MAX_STROKES; i++) boards.draw(board, i);
  assert.equal(board.strokes.length, MAX_STROKES);
  assert.equal(board.strokes[0], 1);
  assert.equal(boards.getBoardList('r')[0]?.strokeCount, MAX_STROKES);
  boards.clear(board);
  assert.deepEqual(boards.find('r', summary.id)?.strokes, []);
  boards.delete('r', summary.id);
  assert.deepEqual(boards.getBoardList('r'), []);
});
