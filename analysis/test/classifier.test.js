const test = require('node:test');
const assert = require('node:assert');
const { classifyMove, winPercent, moveAccuracy, summarize, scoreToCp } = require('../classifier');

const t = (name, fn) => test(name, fn);
const base = (o) => classifyMove({ playedIsBest: false, bestScore: { cp: 0 }, playedScore: { cp: 0 }, ...o });

t('winPercent: 0cp = 50%, symmetric, monotonic', () => {
  assert.strictEqual(Math.round(winPercent({ cp: 0 })), 50);
  assert.ok(Math.abs(winPercent({ cp: 300 }) + winPercent({ cp: -300 }) - 100) < 1e-9);
  assert.ok(winPercent({ cp: 100 }) < winPercent({ cp: 200 }));
  assert.strictEqual(Math.round(winPercent({ cp: 200 })), 68);
});
t('mate is ~100% / 0%', () => { assert.ok(winPercent({ mate: 3 }) > 99.99); assert.ok(winPercent({ mate: -3 }) < 0.01); });
t('shorter mate scores higher than longer mate (CPL is capped, so no loss)', () => { assert.ok(scoreToCp({ mate: 2 }) > scoreToCp({ mate: 6 })); assert.ok(scoreToCp({ mate: -6 }) > scoreToCp({ mate: -2 })); });

t('best move: loss 0, class best', () => {
  const r = classifyMove({ playedIsBest: true, bestScore: { cp: 30 }, playedScore: { cp: 30 } });
  assert.strictEqual(r.classification, 'best'); assert.strictEqual(r.cpl, 0); assert.strictEqual(r.winLoss, 0);
});
t('excellent (loss <= 2)', () => assert.strictEqual(base({ bestScore: { cp: 50 }, playedScore: { cp: 35 } }).classification, 'excellent'));
t('good (loss <= 5)', () => assert.strictEqual(base({ bestScore: { cp: 50 }, playedScore: { cp: 0 } }).classification, 'good'));
t('inaccuracy (loss <= 10)', () => assert.strictEqual(base({ bestScore: { cp: 50 }, playedScore: { cp: -50 } }).classification, 'inaccuracy'));
t('mistake (loss <= 20)', () => assert.strictEqual(base({ bestScore: { cp: 50 }, playedScore: { cp: -150 } }).classification, 'mistake'));
t('blunder (loss > 20)', () => assert.strictEqual(base({ bestScore: { cp: 50 }, playedScore: { cp: -400 } }).classification, 'blunder'));
t('cpl is capped and never negative', () => {
  assert.strictEqual(base({ bestScore: { cp: 20 }, playedScore: { cp: 90 } }).cpl, 0);
  assert.strictEqual(base({ bestScore: { cp: 900 }, playedScore: { cp: -900 } }).cpl, 1800);
});

t('book overrides everything', () => assert.strictEqual(base({ bestScore: { cp: 50 }, playedScore: { cp: -400 }, book: true }).classification, 'book'));

t('missed mate: had mate in 3, played quiet move', () =>
  assert.strictEqual(base({ bestScore: { mate: 3 }, playedScore: { cp: 400 } }).classification, 'missed-mate'));
t('not a missed mate if the played move also mates', () =>
  assert.notStrictEqual(base({ bestScore: { mate: 2 }, playedScore: { mate: 4 } }).classification, 'missed-mate'));
t('missed mate takes precedence over blunder', () =>
  assert.strictEqual(base({ bestScore: { mate: 1 }, playedScore: { cp: -800 } }).classification, 'missed-mate'));

t('missed win: winning (+500) -> only slightly better (+80)', () =>
  assert.strictEqual(base({ bestScore: { cp: 500 }, playedScore: { cp: 80 } }).classification, 'missed-win'));
t('winning -> losing is a blunder, not missed win', () =>
  assert.strictEqual(base({ bestScore: { cp: 500 }, playedScore: { cp: -300 } }).classification, 'blunder'));
t('already-equal position never gives missed win', () =>
  assert.notStrictEqual(base({ bestScore: { cp: 40 }, playedScore: { cp: -100 } }).classification, 'missed-win'));

t('great: best move, second best far worse, undecided', () => {
  const r = classifyMove({ playedIsBest: true, bestScore: { cp: 20 }, playedScore: { cp: 20 }, secondScore: { cp: -400 } });
  assert.strictEqual(r.classification, 'great');
});
t('not great when alternatives are fine', () =>
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 20 }, playedScore: { cp: 20 }, secondScore: { cp: 5 } }).classification, 'best'));
t('not great for a plain recapture', () =>
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 20 }, playedScore: { cp: 20 }, secondScore: { cp: -400 }, isRecapture: true }).classification, 'best'));
t('not great when game is already decided', () =>
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 900 }, playedScore: { cp: 900 }, secondScore: { cp: -400 } }).classification, 'best'));

t('brilliant: best move + real sacrifice + still good', () =>
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 60 }, playedScore: { cp: 60 }, sacrifice: 3 }).classification, 'brilliant'));
t('no brilliant without sacrifice', () =>
  assert.notStrictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 60 }, playedScore: { cp: 60 }, sacrifice: 0 }).classification, 'brilliant'));
t('no brilliant when already crushing', () =>
  assert.notStrictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 1200 }, playedScore: { cp: 1200 }, sacrifice: 5 }).classification, 'brilliant'));
t('no brilliant when sacrifice leaves a bad position', () =>
  assert.notStrictEqual(base({ bestScore: { cp: 60 }, playedScore: { cp: -250 }, sacrifice: 5 }).classification, 'brilliant'));

t('accuracy: 100 for no loss, falls with loss', () => {
  assert.ok(moveAccuracy(0) > 99.9); assert.ok(moveAccuracy(10) < moveAccuracy(2)); assert.ok(moveAccuracy(80) >= 0);
});
t('deterministic: same input -> same output', () => {
  const i = { bestScore: { cp: 120 }, playedScore: { cp: -40 }, secondScore: { cp: -10 } };
  assert.deepStrictEqual(base(i), base(i));
});
t('summarize counts and averages per color', () => {
  const s = summarize([
    { color: 'white', classification: 'best', accuracy: 100, cpl: 0 },
    { color: 'white', classification: 'blunder', accuracy: 20, cpl: 400 },
    { color: 'black', classification: 'good', accuracy: 90, cpl: 10 }
  ]);
  assert.strictEqual(s.white.accuracy, 60); assert.strictEqual(s.white.averageCpl, 200);
  assert.strictEqual(s.white.counts.blunder, 1); assert.strictEqual(s.black.counts.good, 1);
});
t('brilliant: sacrificing a minor piece for a pawn (2) counts, a pawn gambit (1) does not', () => {
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 40 }, playedScore: { cp: 40 }, sacrifice: 2 }).classification, 'brilliant');
  assert.notStrictEqual(classifyMove({ playedIsBest: true, bestScore: { cp: 40 }, playedScore: { cp: 40 }, sacrifice: 1 }).classification, 'brilliant');
});
t('brilliant: queen sacrifice into a forced mate even when decided', () =>
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { mate: 3 }, playedScore: { mate: 3 }, sacrifice: 8 }).classification, 'brilliant'));
t('mate without a big sacrifice is just best', () =>
  assert.strictEqual(classifyMove({ playedIsBest: true, bestScore: { mate: 3 }, playedScore: { mate: 3 }, sacrifice: 1 }).classification, 'best'));

