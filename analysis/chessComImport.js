// Chess.com játék importálása URL alapján.
//
// A Chess.com nem ad PGN-t közvetlenül a játék oldalához. Az alábbi stratégiát használjuk:
//  1) A játék azonosítóját az URL-ből kinyerjük (élő és levelezési játék is).
//  2) A https://www.chess.com/callback/{live|daily}/game/{id} végpont JSON-ja tartalmazza a fejléceket,
//     a TCN-kódolt lépéslistát és a lépésenkénti órát -> ebből PGN-t építünk.
//  3) Ha a callback elárulja a játékosokat és a hónapot, a nyilvános archívum API-ból
//     (api.chess.com/pub/player/{név}/games/{év}/{hónap}) megpróbáljuk a hivatalos PGN-t is
//     (pontos fejlécek, órák). Ha ez nem sikerül, a TCN-ből épített PGN is teljes értékű.
//  4) Ha az egész nem elérhető (privát/törölt játék, hálózati hiba), érthető hibát adunk,
//     és a felhasználó PGN-t is beilleszthet.
const { Chess } = require('chess.js');

const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'betterdc-game-analysis/1.0 (+chess review tool)';

class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.userMessage = message;
  }
}

// ---------- URL feldolgozás ----------

// Elfogadott alakok (élő és levelezési):
//  /analysis/game/live/123/review   /game/live/123   /live/game/123   /live#g=123
//  /analysis/game/daily/123         /game/daily/123  /daily/game/123
function parseChessComUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new ImportError('EMPTY_URL', 'Illessz be egy Chess.com játék linket.');

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ImportError('INVALID_URL', 'Ez nem érvényes link.');
  }

  // Csak a Chess.com saját domainjei (SSRF ellen: más hoszt sosem kerül lekérésre)
  const host = url.hostname.toLowerCase();
  if (host !== 'chess.com' && !host.endsWith('.chess.com')) {
    throw new ImportError('NOT_CHESS_COM', 'Csak chess.com játék linkek támogatottak.');
  }

  const text = `${url.pathname}${url.hash}`;
  let match =
    text.match(/\/(?:analysis\/)?game\/(live|daily)\/(\d+)/i) ||
    text.match(/\/(live|daily)\/game\/(\d+)/i) ||
    text.match(/\/(live)#g=(\d+)/i);
  if (!match) {
    throw new ImportError(
      'NO_GAME_ID',
      'Nem találtam játékazonosítót a linkben. Példa: https://www.chess.com/game/live/123456789'
    );
  }
  return { type: match[1].toLowerCase(), id: match[2] };
}

// ---------- Hálózat ----------

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- TCN dekódolás ----------

// A Chess.com tömör lépéskódolása: lépésenként 2 karakter (honnan, hova), 64 mező + promóciós kódok.
const TCN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!?{~}(^)[_]@#$,./&-*++=';
const TCN_PROMOTIONS = 'qnrbkp';

const squareName = (index) => 'abcdefgh'[index % 8] + (Math.floor(index / 8) + 1);

function decodeTcn(tcn) {
  if (typeof tcn !== 'string' || tcn.length === 0 || tcn.length % 2 !== 0) {
    throw new ImportError('BAD_MOVES', 'A játék lépéslistája hibás vagy hiányos.');
  }
  const moves = [];
  for (let i = 0; i < tcn.length; i += 2) {
    const from = TCN_ALPHABET.indexOf(tcn[i]);
    let to = TCN_ALPHABET.indexOf(tcn[i + 1]);
    if (from < 0 || to < 0 || from > 63) {
      throw new ImportError('BAD_MOVES', 'A játék lépéslistája nem dekódolható.');
    }
    let promotion;
    if (to > 63) {
      promotion = TCN_PROMOTIONS[Math.floor((to - 64) / 3)];
      to = from + (from < 16 ? -8 : 8) + ((to - 1) % 3) - 1;
    }
    moves.push({ from: squareName(from), to: squareName(to), ...(promotion ? { promotion } : {}) });
  }
  return moves;
}

// ---------- PGN építés ----------

const pad = (n, w = 2) => String(n).padStart(w, '0');

// Egy óra érték (tizedmásodperc) -> h:mm:ss.d
function formatClock(deci) {
  const total = Math.max(0, Math.round(deci));
  const h = Math.floor(total / 36000);
  const m = Math.floor((total % 36000) / 600);
  const s = Math.floor((total % 600) / 10);
  return `${h}:${pad(m)}:${pad(s)}.${total % 10}`;
}

function escapeHeader(value) {
  return String(value).replace(/\\'/g, "'").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildPgnFromCallback(game, id, type) {
  const headers = { ...(game.pgnHeaders || {}) };
  const moves = decodeTcn(game.moveList);

  // Lépések lejátszása: validálás + SAN előállítás
  const start = game.initialSetup || headers.FEN;
  const chess = start ? new Chess(start) : new Chess();
  const sans = [];
  for (const move of moves) {
    // A levelezési játékoknál a sánc "király az (azonos színű) bástyára lép" alakban van kódolva
    const mover = chess.get(move.from);
    const target = chess.get(move.to);
    if (mover && mover.type === 'k' && target && target.type === 'r' && target.color === mover.color) {
      move.to = (move.to.charCodeAt(0) > move.from.charCodeAt(0) ? 'g' : 'c') + move.from[1];
    }

    let result;
    try {
      result = chess.move(move);
    } catch {
      result = null;
    }
    if (!result) throw new ImportError('BAD_MOVES', 'A játék lépéslistája szabálytalan lépést tartalmaz.');
    sans.push(result.san);
  }

  const clocks = typeof game.moveTimestamps === 'string' ? game.moveTimestamps.split(',').map(Number) : [];
  const startsWithWhite = !start || start.split(' ')[1] !== 'b';

  const body = [];
  sans.forEach((san, i) => {
    const whiteMove = startsWithWhite ? i % 2 === 0 : i % 2 === 1;
    const number = Math.floor((startsWithWhite ? i : i + 1) / 2) + 1;
    let text = '';
    if (whiteMove) text += `${number}. `;
    else if (i === 0) text += `${number}... `;
    text += san;
    if (Number.isFinite(clocks[i])) text += ` {[%clk ${formatClock(clocks[i])}]}`;
    body.push(text);
  });

  const result = headers.Result || '*';
  const order = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', 'ECO', 'WhiteElo', 'BlackElo', 'TimeControl', 'EndTime', 'Termination', 'SetUp', 'FEN'];
  const merged = { Event: 'Chess.com', Site: 'Chess.com', Round: '-', ...headers, Link: `https://www.chess.com/game/${type}/${id}` };
  const names = [...order, ...Object.keys(merged).filter((k) => !order.includes(k))].filter((k) => merged[k] !== undefined && merged[k] !== '');
  const headerText = names.map((k) => `[${k} "${escapeHeader(merged[k])}"]`).join('\n');
  return `${headerText}\n\n${body.join(' ')} ${result}\n`;
}

// ---------- Hivatalos PGN az archívum API-ból (opcionális javítás) ----------

async function tryOfficialPgn(game, id, type) {
  const headers = game.pgnHeaders || {};
  const white = headers.White;
  const dateMatch = String(headers.Date || '').match(/^(\d{4})\.(\d{2})\./);
  if (!white || !dateMatch) return null;

  // A játék vége UTC-ben határozza meg a hónapot (hónaphatárnál a fejléc dátuma eltérhet)
  const months = new Set([`${dateMatch[1]}/${dateMatch[2]}`]);
  if (game.endTime) {
    const d = new Date(game.endTime * 1000);
    months.add(`${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}`);
  }

  for (const month of months) {
    const res = await fetchJson(`https://api.chess.com/pub/player/${encodeURIComponent(String(white).toLowerCase())}/games/${month}`);
    if (!res.ok) continue;
    const found = (res.data.games || []).find((g) => typeof g.url === 'string' && g.url.endsWith(`/${type}/${id}`));
    if (found && found.pgn) return found.pgn;
  }
  return null;
}

// ---------- Fő belépési pont ----------

// Visszaad: { pgn, source: 'chess.com-official' | 'chess.com-callback', gameId, type, url }
async function importFromChessCom(input) {
  const { type, id } = parseChessComUrl(input);
  const res = await fetchJson(`https://www.chess.com/callback/${type}/game/${id}`);

  if (!res.ok) {
    if (res.status === 404) {
      throw new ImportError('NOT_FOUND', 'A játék nem található. Lehet, hogy törölték, vagy hibás a link. Beillesztheted a PGN-t is.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ImportError('PRIVATE', 'A játék nem érhető el nyilvánosan (privát vagy védett). Töltsd le a PGN-t a Chess.com-ról, és illeszd be.');
    }
    throw new ImportError(
      'UNAVAILABLE',
      res.error === 'timeout'
        ? 'A Chess.com nem válaszolt időben. Próbáld újra később, vagy illeszd be a PGN-t.'
        : 'A Chess.com most nem érhető el innen. Próbáld újra később, vagy illeszd be a PGN-t.'
    );
  }

  const game = res.data && res.data.game;
  if (!game || !game.moveList) {
    throw new ImportError('NO_MOVES', 'Ehhez a játékhoz nem érhetők el a lépések (még folyamatban van, vagy privát). Illeszd be a PGN-t.');
  }
  if (game.type && game.type !== 'chess') {
    throw new ImportError('UNSUPPORTED_VARIANT', 'Csak a normál sakk játékok elemezhetők.');
  }
  if (game.isFinished === false) {
    throw new ImportError('NOT_FINISHED', 'A játék még folyamatban van. Az elemzés a befejezett játékokhoz érhető el.');
  }

  const callbackPgn = buildPgnFromCallback(game, id, type); // hiba esetén ImportError
  let pgn = callbackPgn;
  let source = 'chess.com-callback';

  const official = await tryOfficialPgn(game, id, type);
  if (official) {
    // A hivatalos PGN-t csak akkor fogadjuk el, ha ugyanazt a lépéssort tartalmazza
    try {
      const a = new Chess();
      a.loadPgn(official);
      const b = new Chess();
      b.loadPgn(callbackPgn);
      if (a.history().join(' ') === b.history().join(' ')) {
        pgn = official;
        source = 'chess.com-official';
      }
    } catch {
      /* marad a callback PGN */
    }
  }

  return { pgn, source, gameId: id, type, url: `https://www.chess.com/game/${type}/${id}` };
}

module.exports = { importFromChessCom, parseChessComUrl, decodeTcn, buildPgnFromCallback, ImportError };
