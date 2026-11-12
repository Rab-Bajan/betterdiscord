import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHESS_ERRORS, ChessService } from '../../../src/modules/chess/ChessService.ts';
import type { ChessPlayer } from '../../../src/modules/chess/types.ts';

const p = (id: string): ChessPlayer => ({ id, username: id.toUpperCase(), avatarColor: '#111' });
const setup = () => {
  const changed: string[] = [];
  const chess = new ChessService((id) => { changed.push(id); }, () => 42);
  return { chess, changed };
};
/** A playing game: a is white, b is black. */
const playing = () => {
  const s = setup();
  s.chess.start('r', p('a'), 'white');
  const session = s.chess.get('r');
  assert.ok(session);
  s.chess.join(session, p('b'));
  return { ...s, session };
};

test('start seats the preferred colour; a second start spectates', () => {
  const { chess } = setup();
  assert.equal(chess.start('r', p('a'), 'black'), true);
  assert.equal(chess.start('r', p('c'), 'white'), false);
  assert.equal(chess.start('r', p('a'), 'white'), false);
  const snap = chess.snapshotOf('r');
  assert.equal(snap?.black?.id, 'a');
  assert.equal(snap?.white, null);
  assert.deepEqual(snap?.spectators.map((s) => s.id), ['c']);
  assert.equal(snap?.status, 'waiting');
  assert.equal(snap?.createdAt, 42);
  assert.equal(chess.get(5), undefined);
});

test('join fills seats then spectates; the game starts with two players', () => {
  const { chess, session } = playing();
  assert.equal(session.status, 'playing');
  assert.equal(chess.join(session, p('a')), false);
  assert.equal(chess.join(session, p('c')), false);
  assert.deepEqual(session.spectators.map((s) => s.id), ['c']);
});

test('move: turn order, legality via chess.js, checkmate', () => {
  const { chess, session } = playing();
  assert.throws(() => chess.move(session, 'b', 'e7', 'e5', 'q'), { message: CHESS_ERRORS.notYourTurn });
  assert.throws(() => chess.move(session, 'a', 'e2', 'e5', 'q'), /Invalid move/);
  assert.throws(() => chess.move(session, 'a', 5, 'e4', 'q'), { message: CHESS_ERRORS.invalidMove });
  chess.move(session, 'a', 'f2', 'f3', 'q');
  chess.move(session, 'b', 'e7', 'e5', '');
  chess.move(session, 'a', 'g2', 'g4', 'q');
  chess.move(session, 'b', 'd8', 'h4', 'q');
  assert.equal(session.status, 'checkmate');
  assert.equal(session.winner, 'black');
  assert.deepEqual(session.lastMove, { from: 'd8', to: 'h4', san: 'Qh4#', piece: 'q', color: 'b', captured: null });
  assert.equal(session.history.length, 4);
  assert.throws(() => chess.move(session, 'a', 'a2', 'a3', 'q'), { message: CHESS_ERRORS.notPlaying });
  assert.throws(() => chess.move(undefined, 'a', 'a2', 'a3', 'q'), { message: CHESS_ERRORS.notPlaying });
});

test('resign, rematch swaps colours, stop', () => {
  const { chess, session } = playing();
  assert.equal(chess.resign(session, 'c'), false);
  assert.equal(chess.resign(session, 'b'), true);
  assert.deepEqual([session.status, session.winner, session.reason], ['resigned', 'white', 'resignation']);
  assert.equal(chess.resign(session, 'a'), false);
  chess.rematch(session);
  assert.deepEqual([session.white?.id, session.black?.id, session.status, session.history.length], ['b', 'a', 'playing', 0]);
  chess.stop('r');
  assert.equal(chess.snapshotOf('r'), null);
});

test('leave frees seats and closes empty games', () => {
  const { chess, session } = playing();
  chess.start('other', p('a'), 'white');
  assert.deepEqual(chess.leave('a'), [{ channelId: 'r', closed: false }, { channelId: 'other', closed: true }]);
  assert.equal(session.status, 'waiting');
  assert.deepEqual(chess.leave('b'), [{ channelId: 'r', closed: true }]);
  assert.deepEqual(chess.snapshots(), {});
});

test('admin edits run on a copy and go live only when valid', () => {
  const { chess, changed, session } = playing();
  assert.throws(() => chess.admin.setTurn('r', 'x'), /Érvénytelen sor/);
  assert.throws(() => chess.admin.setTurn('nincs', 'w'), /Nincs aktív sakk parti/);
  assert.equal(chess.admin.setTurn('r', 'b').turn, 'b');
  assert.throws(() => chess.admin.putPiece('r', 'z9', null), /Érvénytelen mező/);
  assert.throws(() => chess.admin.putPiece('r', 'e4', { type: 'x', color: 'w' }), /Érvénytelen bábu/);
  assert.throws(() => chess.admin.putPiece('r', 'd4', { type: 'k', color: 'w' }), /második király/);
  assert.match(chess.admin.putPiece('r', 'e4', { type: 'q', color: 'w' }).fen, /4Q3/);
  assert.throws(() => chess.admin.forceMove('r', 'e5', 'e6', true), /Nincs bábu a\(z\) e5 mezőn/);
  const moved = chess.admin.forceMove('r', 'h2', 'h6', false);
  assert.equal(moved.turn, 'b');
  assert.deepEqual(session.lastMove, { san: 'h2→h6*', from: 'h2', to: 'h6', color: 'w', piece: 'p', captured: null });
  const before = session.chess.fen();
  assert.throws(() => chess.admin.forceMove('r', 'd1', 'e8', true), /Invalid FEN/);
  assert.equal(session.chess.fen(), before);
  assert.deepEqual(changed, ['r', 'r', 'r']);
});
