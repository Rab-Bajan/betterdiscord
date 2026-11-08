const test = require('node:test');
const assert = require('node:assert');
const { sacrificeAmount, settledMaterialDelta, quietPoints, materialBalance } = require('../analyzer');
const { decodeTcn, parseChessComUrl, ImportError } = require('../chessComImport');
const { lookupOpening, isBookFen } = require('../openings');
const { Chess } = require('chess.js');

const ITALIAN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const RUY = 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5';

test('materialBalance: start position is level, a missing pawn shows up', () => {
  assert.strictEqual(materialBalance(new Chess(), 'w'), 0);
  const noPawn = new Chess('rnbqkbnr/ppp1pppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.strictEqual(materialBalance(noPawn, 'w'), 1);
  assert.strictEqual(materialBalance(noPawn, 'b'), -1);
});

test('quietPoints ignore captures (pending exchanges)', () => {
  const pts = quietPoints(ITALIAN, ['c4f7', 'e8f7', 'f3g5', 'f7g8'], 'w');
  assert.deepStrictEqual(pts.map((p) => p.ply), [3, 4]);
});

test('sacrificeAmount: bishop for a pawn that is not regained = 2', () => {
  // Bxf7+ Kxf7 Ng5+ Kg8: a fehér futót adott egy gyalogért
  assert.strictEqual(sacrificeAmount(ITALIAN, ['c4f7', 'e8f7', 'f3g5', 'f7g8'], 'w'), 2);
});

test('sacrificeAmount: an even trade is not a sacrifice', () => {
  // Bxc6 bxc6 d3 (a csere lezárult, az anyag kiegyenlített)
  assert.strictEqual(sacrificeAmount(RUY, ['a4c6', 'b7c6', 'd2d3', 'f8e7'], 'w'), 0);
});

test('sacrificeAmount: material that is won back over the line no longer counts as a big sacrifice', () => {
  // Bxf7+ Kxf7 Nxe5+ Ke8 Nxc6 dxc6 d3: a futóért 2 gyalog + huszár, de egy huszár is elveszik -> nettó 1 gyalog
  assert.strictEqual(sacrificeAmount(ITALIAN, ['c4f7', 'e8f7', 'f3e5', 'f7e8', 'e5c6', 'd7c6', 'd2d3'], 'w'), 1);
});

test('sacrificeAmount: losing a knight and a bishop for two pawns is a real (large) deficit', () => {
  assert.strictEqual(sacrificeAmount(ITALIAN, ['c4f7', 'e8f7', 'f3e5', 'c6e5', 'd2d4', 'e5g6'], 'w'), 4);
});

test('sacrificeAmount: a line with no quiet point after ply 2 is not a sacrifice', () => {
  assert.strictEqual(sacrificeAmount(ITALIAN, ['c4f7'], 'w'), 0);
  assert.strictEqual(sacrificeAmount(ITALIAN, [], 'w'), 0);
});

test('settledMaterialDelta: wins a pawn and the line settles', () => {
  const fen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  assert.strictEqual(settledMaterialDelta(fen, ['e4d5', 'g8f6'], 'w'), 1);
  assert.strictEqual(settledMaterialDelta(fen, ['e4d5', 'd8d5', 'b1c3'], 'w'), 0);
});

test('decodeTcn: castling and a promotion with capture', () => {
  // "mC" = e2e4 a Chess.com TCN-jében
  const [first] = decodeTcn('mC');
  assert.deepStrictEqual(first, { from: 'e2', to: 'e4' });
  assert.throws(() => decodeTcn('m'), ImportError);
  assert.throws(() => decodeTcn(''), ImportError);
});

test('parseChessComUrl: accepts every known URL shape', () => {
  const cases = {
    'https://www.chess.com/analysis/game/live/186506919580/review?flip=true': { type: 'live', id: '186506919580' },
    'https://www.chess.com/game/live/123': { type: 'live', id: '123' },
    'https://www.chess.com/live/game/123': { type: 'live', id: '123' },
    'https://www.chess.com/game/daily/456': { type: 'daily', id: '456' },
    'https://www.chess.com/analysis/game/daily/456': { type: 'daily', id: '456' },
    'www.chess.com/game/live/789?foo=bar': { type: 'live', id: '789' }
  };
  for (const [url, expected] of Object.entries(cases)) assert.deepStrictEqual(parseChessComUrl(url), expected, url);
});

test('parseChessComUrl: rejects foreign hosts, lookalikes and links without a game id', () => {
  for (const bad of ['', 'hello', 'https://evil.com/game/live/1', 'https://chess.com.evil.com/game/live/1', 'https://notchess.com/game/live/1', 'https://www.chess.com/member/hikaru', 'https://www.chess.com/game/live/abc']) {
    assert.throws(() => parseChessComUrl(bad), ImportError, bad);
  }
});

test('opening book: knows theory, names the Italian, rejects nonsense', () => {
  const c = new Chess();
  for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']) c.move(m);
  assert.strictEqual(lookupOpening(c.fen()).name, 'Italian Game: Giuoco Piano');
  const d = new Chess();
  for (const m of ['e4', 'e5', 'Qh5', 'Nc6', 'Qxe5']) d.move(m);
  assert.strictEqual(isBookFen(d.fen()), false);
});
