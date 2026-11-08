// Teljes játszma elemzése: minden állást a Stockfish értékel, a besorolás ezekből számolódik.
const { Chess } = require('chess.js');
const { CONFIG, CLASSIFICATIONS, classifyMove, summarize, flip, scoreToCp } = require('./classifier');
const { lookupOpening, isBookFen } = require('./openings');

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const uciOf = (m) => `${m.from}${m.to}${m.promotion || ''}`;

// Anyagkülönbség a megadott szín szemszögéből (gyalog = 1)
function materialBalance(chess, color) {
  let balance = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (!square) continue;
      balance += (square.color === color ? 1 : -1) * PIECE_VALUE[square.type];
    }
  }
  return balance;
}

// UCI lépéssorozat lejátszása egy állásból (a lejátszható részig)
function playLine(fen, uciMoves, maxPlies) {
  const chess = new Chess(fen);
  const played = [];
  for (const uci of uciMoves.slice(0, maxPlies)) {
    let move;
    try {
      move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      move = null;
    }
    if (!move) break;
    played.push(move);
  }
  return { chess, played };
}

// "Nyugodt pontok": azok a fél-lépések, ahol a lépés nem ütés és nem előléptetés, vagyis a cserék lezárultak.
// Az anyagot csak itt mérjük, különben egy félbehagyott csere áldozatnak látszana.
// Visszaad: [{ ply, delta }] – a lépő anyagkülönbségének változása a kiinduló állapothoz képest.
function quietPoints(fen, uciMoves, mover, maxPlies = 10) {
  if (!uciMoves || uciMoves.length === 0) return [];
  const chess = new Chess(fen);
  const start = materialBalance(chess, mover);
  const points = [];
  for (let i = 0; i < Math.min(maxPlies, uciMoves.length); i += 1) {
    const uci = uciMoves[i];
    let move;
    try {
      move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      move = null;
    }
    if (!move) break;
    if (!move.captured && !move.promotion) points.push({ ply: i + 1, delta: materialBalance(chess, mover) - start });
  }
  return points;
}

// Áldozat nagysága (>= 0, gyalog = 1): az anyagveszteség, ami a vonal első ÉS utolsó nyugodt pontján is fennáll.
// Így a visszanyert anyag (csere) nem számít áldozatnak.
function sacrificeAmount(fen, uciMoves, mover) {
  const points = quietPoints(fen, uciMoves, mover).filter((p) => p.ply >= 2);
  if (points.length === 0) return 0;
  const first = -points[0].delta;
  const last = -points[points.length - 1].delta;
  return Math.max(0, Math.min(first, last));
}

// A vonal "lerendezett" anyagváltozása a lépő szemszögéből (az utolsó nyugodt ponton)
function settledMaterialDelta(fen, uciMoves, mover) {
  const points = quietPoints(fen, uciMoves, mover);
  if (points.length > 0) return points[points.length - 1].delta;
  if (!uciMoves || uciMoves.length === 0) return 0;
  const { chess } = playLine(fen, uciMoves, 10);
  return materialBalance(chess, mover) - materialBalance(new Chess(fen), mover);
}

// A vonal első néhány lépése SAN-ban (megjelenítéshez)
function lineToSan(fen, uciMoves, maxPlies = 8) {
  const { played } = playLine(fen, uciMoves, maxPlies);
  return played.map((m) => m.san);
}

// Végállás (matt, patt, döntetlen) értéke a soron lévő fél szemszögéből; null ha az engine-nek kell dolgozni
function terminalPosition(chess) {
  if (chess.isCheckmate()) return { terminal: 'checkmate', score: { mate: -1 } };
  if (chess.isStalemate() || chess.isInsufficientMaterial()) return { terminal: 'draw', score: { cp: 0 } };
  return null;
}

const toWhite = (score, turn) => (turn === 'w' ? score : flip(score));

function parseGame(pgn) {
  const loader = new Chess();
  try {
    loader.loadPgn(pgn);
  } catch {
    throw new Error('A PGN nem olvasható be. Ellenőrizd, hogy teljes és szabályos-e.');
  }
  const headers = loader.getHeaders();
  const history = loader.history({ verbose: true });
  if (history.length === 0) throw new Error('A PGN nem tartalmaz lépéseket.');

  // Órák a {[%clk h:mm:ss.d]} megjegyzésekből, állás (fen) szerint
  const clockByFen = new Map();
  for (const { fen, comment } of loader.getComments()) {
    const m = String(comment).match(/\[%clk\s+(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\]/);
    if (m) clockByFen.set(fen, Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  }
  const startFen = history[0].before;
  return { headers, history, startFen, clockByFen };
}

/**
 * @param {object} options
 * @param {string} options.pgn
 * @param {{depth?:number, movetimeMs?:number, multipv:number}} options.settings
 * @param {object} options.engine  UciEngine példány
 * @param {(p:{done:number,total:number,ply:number})=>void} [options.onProgress]
 * @param {()=>boolean} [options.isCancelled]
 */
async function analyzeGame({ pgn, settings, engine, onProgress, isCancelled = () => false }) {
  const { headers, history, startFen, clockByFen } = parseGame(pgn);
  const total = history.length + 1; // minden állás: a kiinduló + minden lépés utáni

  // 1) Állások listája
  const fens = [startFen, ...history.map((m) => m.after)];
  const analyses = new Array(total);
  const cache = new Map(); // azonos állás ismétlődésekor nem számolunk újra
  const searchOptions = { depth: settings.depth, movetimeMs: settings.movetimeMs, multipv: settings.multipv };

  await engine.newGame();
  for (let i = 0; i < total; i += 1) {
    if (isCancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    const key = fens[i].split(' ').slice(0, 4).join(' ');
    const turn = fens[i].split(' ')[1];
    const chess = new Chess(fens[i]);
    const terminal = terminalPosition(chess);

    if (terminal) {
      analyses[i] = { fen: fens[i], turn, terminal: terminal.terminal, lines: [{ multipv: 1, score: terminal.score, pv: [], depth: 0 }] };
    } else if (cache.has(key)) {
      analyses[i] = { ...cache.get(key), fen: fens[i] };
    } else {
      const { lines, bestmove } = await engine.analyse(fens[i], searchOptions);
      if (lines.length === 0) throw new Error('Az engine nem adott értékelést az egyik álláshoz.');
      analyses[i] = { fen: fens[i], turn, terminal: null, lines, bestmove };
      cache.set(key, analyses[i]);
    }
    onProgress?.({ done: i + 1, total, ply: i });
  }

  // 2) Lépések besorolása
  const openingNames = [];
  const moves = history.map((move, index) => {
    const ply = index + 1;
    const before = analyses[index];
    const after = analyses[ply];
    const mover = move.color; // 'w' | 'b'
    const uci = uciOf(move);

    const bestLine = before.lines[0];
    const bestUci = bestLine.pv[0] || before.bestmove || uci;
    const playedLine = before.lines.find((l) => l.pv[0] === uci) || null;
    const playedIsBest = uci === bestUci;
    const secondLine = before.lines[1] || null;

    // A játszott lépés értéke a lépő szemszögéből. Ha a lépés a többvonalas keresés része,
    // ugyanabból a keresésből vesszük (összehasonlítható mélység); különben a következő állás értékelése.
    let playedScore;
    if (playedIsBest) playedScore = bestLine.score;
    else if (playedLine) playedScore = playedLine.score;
    else if (after.terminal === 'checkmate') playedScore = { mate: 1 }; // a lépő mattot adott
    else playedScore = flip(after.lines[0].score);

    const prev = index > 0 ? history[index - 1] : null;
    const isRecapture = !!(move.captured && prev && prev.captured && prev.to === move.to);
    const book = isBookFen(move.after);
    const opening = lookupOpening(move.after);
    if (opening) openingNames.push({ ply, ...opening });

    // Áldozat: csak akkor értelmezzük, ha a lépés az engine vonalai között van (van hozzá vonal)
    const sacrificeLine = playedLine ? playedLine.pv : null;
    const sacrifice = sacrificeLine ? sacrificeAmount(before.fen, sacrificeLine, mover) : 0;

    const result = classifyMove({
      playedIsBest,
      bestScore: bestLine.score,
      playedScore,
      secondScore: secondLine ? secondLine.score : null,
      book,
      sacrifice,
      isRecapture
    });

    // Kihagyott taktika: a legjobb vonal érdemben több anyagot nyer, vagy mattot ad
    let missedTactic = null;
    if (!playedIsBest && result.classification !== 'book' && result.winLoss >= CONFIG.TACTIC_MIN_LOSS) {
      if (bestLine.score.mate !== undefined && bestLine.score.mate > 0) {
        missedTactic = { type: 'mate', mateIn: bestLine.score.mate };
      } else {
        const bestGain = settledMaterialDelta(before.fen, bestLine.pv, mover);
        const continuation = after.terminal ? [] : after.lines[0].pv;
        const playedGain = settledMaterialDelta(before.fen, [uci, ...continuation], mover);
        if (bestGain - playedGain >= CONFIG.TACTIC_MIN_MATERIAL_GAIN) {
          missedTactic = { type: 'material', gain: bestGain - playedGain };
        }
      }
    }

    const bestSan = lineToSan(before.fen, [bestUci], 1)[0] || null;
    const clock = clockByFen.get(move.after);

    return {
      ply,
      moveNumber: Math.ceil(ply / 2),
      color: mover === 'w' ? 'white' : 'black',
      san: move.san,
      uci,
      from: move.from,
      to: move.to,
      piece: move.piece,
      captured: move.captured || null,
      fen: move.after,
      classification: result.classification,
      symbol: CLASSIFICATIONS[result.classification].symbol,
      cpl: Math.round(result.cpl),
      winLoss: Number(result.winLoss.toFixed(2)),
      accuracy: Number(result.accuracy.toFixed(2)),
      winBefore: Number(result.winBefore.toFixed(2)),
      winAfter: Number(result.winAfter.toFixed(2)),
      // értékek FEHÉR szemszögéből (a grafikonhoz), a lépő szemszögű értékek mellett
      evalBefore: toWhite(bestLine.score, before.turn),
      evalAfter: toWhite(after.lines[0].score, after.turn),
      playedScore,
      best: {
        uci: bestUci,
        san: bestSan,
        score: bestLine.score,
        line: lineToSan(before.fen, bestLine.pv, 8)
      },
      alternatives: before.lines.slice(1).map((l) => ({
        uci: l.pv[0],
        san: lineToSan(before.fen, [l.pv[0]], 1)[0] || null,
        score: l.score
      })),
      isRecapture,
      sacrifice,
      missedTactic,
      clock: clock !== undefined ? clock : null
    };
  });

  // 3) Összegzés
  const white = headers.White || 'Fehér';
  const black = headers.Black || 'Fekete';
  const lastOpening = openingNames.length ? openingNames[openingNames.length - 1] : null;

  return {
    headers,
    players: {
      white: { name: white, rating: Number(headers.WhiteElo) || null },
      black: { name: black, rating: Number(headers.BlackElo) || null }
    },
    result: headers.Result || '*',
    termination: headers.Termination || null,
    date: headers.UTCDate || headers.Date || null,
    time: headers.UTCTime || headers.StartTime || null,
    timeControl: headers.TimeControl || null,
    opening: lastOpening ? { eco: lastOpening.eco, name: lastOpening.name, lastBookPly: lastOpening.ply } : null,
    startFen,
    positions: analyses.map((a, ply) => ({
      ply,
      fen: a.fen,
      eval: toWhite(a.lines[0].score, a.turn),
      terminal: a.terminal
    })),
    moves,
    summary: summarize(moves),
    engine: {
      name: engine.name,
      depth: settings.depth || null,
      movetimeMs: settings.movetimeMs || null,
      multipv: settings.multipv,
      reachedDepth: Math.min(...analyses.filter((a) => !a.terminal).map((a) => a.lines[0].depth))
    }
  };
}

module.exports = { analyzeGame, parseGame, sacrificeAmount, settledMaterialDelta, quietPoints, materialBalance, scoreToCp };
