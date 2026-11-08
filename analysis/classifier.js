// Lépésbesorolás: kizárólag Stockfish értékekből számolt, determinisztikus szabályok.
// Nincs véletlen, nincs "AI tipp": ugyanabból az engine-kimenetből mindig ugyanaz lesz az eredmény.
//
// Fogalmak:
//  - score: { cp } vagy { mate }, a LÉPŐ fél szemszögéből (pozitív = jó neki)
//  - nyerési esély (win%): az engine centipawn értékéből a lichess által használt logisztikus képlettel
//  - veszteség (loss): a legjobb lépés és a játszott lépés nyerési esélyének különbsége (százalékpont)
//  - CPL: centipawn veszteség a legjobb lépéshez képest (±1000 cp-ben levágva)

const CONFIG = {
  // Nyerési esély képlet meredeksége (lichess)
  WIN_CHANCE_K: 0.00368208,
  // Matt értéke centipawnban (a matt hosszát levonjuk, hogy a rövidebb matt "jobb")
  MATE_CP: 100000,
  // CPL levágása
  CPL_CAP: 1000,

  // Besorolási küszöbök a nyerési esély veszteségére (százalékpont), a Chess.com "várt pont" modelljét követve
  EXCELLENT_MAX_LOSS: 2,
  GOOD_MAX_LOSS: 5,
  INACCURACY_MAX_LOSS: 10,
  MISTAKE_MAX_LOSS: 20,
  // 20 fölött: Blunder

  // Ennyi veszteség alatt a lépést az engine legjobbjával egyenértékűnek tekintjük
  BEST_EQUIVALENT_LOSS: 0.3,

  // Nagyszerű (Great): egyetlen jó lépés – a második legjobb lépés ennyivel rosszabb nyerési esélyben
  GREAT_ONLY_MOVE_GAP: 12,
  // Nagyszerű/Zseniális csak akkor, ha a játszma nem dőlt már el
  DECIDED_WIN_PCT: 85,
  HOPELESS_WIN_PCT: 8,

  // Zseniális (Brilliant): anyagáldozat (bábuérték-egységben, gyalog = 1), ami mellett az állás jó marad
  BRILLIANT_MIN_SACRIFICE: 2, // pl. futó/huszár gyalogért, vagy bástya könnyű bábuért
  // Kényszerített mattot adó áldozat (pl. vezéráldozat) eldöntött állásban is zseniális, ha legalább ekkora
  BRILLIANT_MATING_SACRIFICE: 5,
  BRILLIANT_MIN_WIN_PCT_AFTER: 45,
  BRILLIANT_MAX_LOSS: 2,

  // Kihagyott nyerés (Missed Win): volt nyerő folytatás, de a játszott lépés után már nem nyert az állás
  MISSED_WIN_BEST_MIN_WIN_PCT: 75,
  MISSED_WIN_MIN_DROP: 15,
  // Ha az állás ennél rosszabb lett, az már Hiba/Baklövés (nem "kihagyott nyerés")
  MISSED_WIN_MIN_WIN_PCT_AFTER: 40,

  // Kihagyott taktika jelzése: ekkora anyagnyereségbeli különbség (bábuérték) és minimum veszteség mellett
  TACTIC_MIN_MATERIAL_GAIN: 2,
  TACTIC_MIN_LOSS: 5
};

const CLASSIFICATIONS = {
  brilliant: { id: 'brilliant', symbol: '!!', label: 'Zseniális' },
  great: { id: 'great', symbol: '!', label: 'Nagyszerű' },
  best: { id: 'best', symbol: '', label: 'Legjobb' },
  excellent: { id: 'excellent', symbol: '', label: 'Kiváló' },
  good: { id: 'good', symbol: '', label: 'Jó' },
  book: { id: 'book', symbol: '', label: 'Elmélet' },
  inaccuracy: { id: 'inaccuracy', symbol: '?!', label: 'Pontatlanság' },
  mistake: { id: 'mistake', symbol: '?', label: 'Hiba' },
  blunder: { id: 'blunder', symbol: '??', label: 'Baklövés' },
  'missed-win': { id: 'missed-win', symbol: '', label: 'Kihagyott nyerés' },
  'missed-mate': { id: 'missed-mate', symbol: '', label: 'Kihagyott matt' }
};

// ---------- Pontszám segédfüggvények ----------

const flip = (score) => (score.mate !== undefined ? { mate: -score.mate } : { cp: -score.cp });

// Egységes centipawn érték (a matt nagyon nagy szám, a rövidebb matt nagyobb)
function scoreToCp(score) {
  if (score.mate !== undefined) return Math.sign(score.mate) * (CONFIG.MATE_CP - Math.abs(score.mate));
  return score.cp;
}

const clampCp = (cp) => Math.max(-CONFIG.CPL_CAP, Math.min(CONFIG.CPL_CAP, cp));

// Nyerési esély 0..100 között. A matt a tartomány végére kerül (100% / 0%), a sima értéket ±1000 cp-ben vágjuk.
function winPercent(score) {
  const cp = score.mate !== undefined ? scoreToCp(score) : clampCp(score.cp);
  return 50 + 50 * (2 / (1 + Math.exp(-CONFIG.WIN_CHANCE_K * cp)) - 1);
}

// Lichess pontossági képlet egy lépésre (a nyerési esély-veszteségből)
function moveAccuracy(winLoss) {
  const value = 103.1668 * Math.exp(-0.04354 * winLoss) - 3.1669;
  return Math.max(0, Math.min(100, value));
}

// ---------- Besorolás ----------

/**
 * @param {object} input
 * @param {boolean} input.playedIsBest   a játszott lépés az engine első vonala
 * @param {object}  input.bestScore      a legjobb vonal értéke (a lépő szemszögéből)
 * @param {object}  input.playedScore    a játszott lépés értéke (a lépő szemszögéből)
 * @param {object|null} input.secondScore a második legjobb vonal értéke (ha van)
 * @param {boolean} input.book           a lépés utáni állás elméleti (megnyitáskönyv)
 * @param {number}  input.sacrifice      anyagáldozat a lépés utáni engine-vonal alapján (>= 0, gyalog = 1)
 * @param {boolean} input.isRecapture    a lépés közvetlen visszaütés
 */
function classifyMove(input) {
  const { playedIsBest, bestScore, playedScore, secondScore = null, book = false, sacrifice = 0, isRecapture = false } = input;

  const winBest = winPercent(bestScore);
  const winPlayed = playedIsBest ? winBest : winPercent(playedScore);
  const winLoss = playedIsBest ? 0 : Math.max(0, winBest - winPlayed);
  const cpl = playedIsBest ? 0 : Math.max(0, clampCp(scoreToCp(bestScore)) - clampCp(scoreToCp(playedScore)));

  const result = { winBefore: winBest, winAfter: winPlayed, winLoss, cpl, accuracy: moveAccuracy(winLoss) };
  const done = (id) => ({ ...result, classification: id });

  if (book) return done('book');

  // Kihagyott matt: volt kényszerített matt a lépőnek, de a játszott lépés után már nincs
  if (!playedIsBest && bestScore.mate !== undefined && bestScore.mate > 0 && !(playedScore.mate !== undefined && playedScore.mate > 0)) {
    return done('missed-mate');
  }

  // Kihagyott nyerés
  if (
    !playedIsBest &&
    winBest >= CONFIG.MISSED_WIN_BEST_MIN_WIN_PCT &&
    winPlayed >= CONFIG.MISSED_WIN_MIN_WIN_PCT_AFTER &&
    winBest - winPlayed >= CONFIG.MISSED_WIN_MIN_DROP
  ) {
    return done('missed-win');
  }

  const equivalentToBest = playedIsBest || winLoss <= CONFIG.BEST_EQUIVALENT_LOSS;
  const nearBest = playedIsBest || winLoss <= CONFIG.BRILLIANT_MAX_LOSS;
  const undecided = winBest < CONFIG.DECIDED_WIN_PCT && winBest > CONFIG.HOPELESS_WIN_PCT;

  // Zseniális: valódi anyagáldozat, ami mellett az állás jó marad, és még nem eldöntött
  const matingSacrifice =
    bestScore.mate !== undefined && bestScore.mate > 0 && sacrifice >= CONFIG.BRILLIANT_MATING_SACRIFICE;
  if (
    nearBest &&
    sacrifice >= CONFIG.BRILLIANT_MIN_SACRIFICE &&
    winPlayed >= CONFIG.BRILLIANT_MIN_WIN_PCT_AFTER &&
    (winBest < CONFIG.DECIDED_WIN_PCT || matingSacrifice)
  ) {
    return done('brilliant');
  }

  if (equivalentToBest) {
    // Nagyszerű: egyetlen jó lépés (a második vonal sokkal rosszabb), nem puszta visszaütés
    const onlyMoveGap = secondScore ? winBest - winPercent(secondScore) : 0;
    if (secondScore && onlyMoveGap >= CONFIG.GREAT_ONLY_MOVE_GAP && undecided && !isRecapture) {
      return done('great');
    }
    return done('best');
  }

  if (winLoss <= CONFIG.EXCELLENT_MAX_LOSS) return done('excellent');
  if (winLoss <= CONFIG.GOOD_MAX_LOSS) return done('good');
  if (winLoss <= CONFIG.INACCURACY_MAX_LOSS) return done('inaccuracy');
  if (winLoss <= CONFIG.MISTAKE_MAX_LOSS) return done('mistake');
  return done('blunder');
}

// Kész játszma összegzése színenként
function summarize(moves) {
  const empty = () => ({
    accuracy: null,
    averageCpl: null,
    counts: Object.fromEntries(Object.keys(CLASSIFICATIONS).map((id) => [id, 0]))
  });
  const summary = { white: empty(), black: empty() };

  for (const color of ['white', 'black']) {
    const own = moves.filter((m) => m.color === color);
    if (own.length === 0) continue;
    own.forEach((m) => { summary[color].counts[m.classification] += 1; });
    summary[color].accuracy = own.reduce((sum, m) => sum + m.accuracy, 0) / own.length;
    summary[color].averageCpl = own.reduce((sum, m) => sum + m.cpl, 0) / own.length;
  }
  return summary;
}

module.exports = { CONFIG, CLASSIFICATIONS, classifyMove, summarize, winPercent, moveAccuracy, scoreToCp, clampCp, flip };
