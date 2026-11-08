// REST végpontok a játszma-elemzéshez. A nehéz munka (Stockfish) a háttérben, feladatként fut;
// a kliens a haladást a GET /jobs/:id lekérdezésével követi.
const { importFromChessCom, ImportError } = require('./chessComImport');
const { parseGame } = require('./analyzer');
const { AnalysisJobManager, JobError, LIMITS } = require('./jobManager');

// Egyszerű, memóriabeli sebességkorlát kliensenként (a kimenő Chess.com kérések védelmére)
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

// Játszma rövid összefoglalója az importáló felületnek
function describeGame(pgn) {
  const { headers, history } = parseGame(pgn);
  return {
    white: { name: headers.White || 'Fehér', rating: Number(headers.WhiteElo) || null },
    black: { name: headers.Black || 'Fekete', rating: Number(headers.BlackElo) || null },
    result: headers.Result || '*',
    termination: headers.Termination || null,
    date: headers.UTCDate || headers.Date || null,
    time: headers.UTCTime || headers.StartTime || null,
    timeControl: headers.TimeControl || null,
    eco: headers.ECO || null,
    plies: history.length,
    moves: history.map((m) => m.san)
  };
}

function setupAnalysisRoutes(app, options = {}) {
  const manager = options.manager || new AnalysisJobManager();
  // A szerver leállásakor ne maradjon futó Stockfish folyamat
  process.once('exit', () => manager.shutdown());
  const allowImport = rateLimiter({ max: 20, windowMs: 60 * 1000 });
  const ownerOf = (req) => req.ip || 'anonymous';

  app.get('/api/analysis/config', (req, res) => {
    res.json({
      ok: true,
      limits: LIMITS,
      defaults: { depth: LIMITS.depth.default, multipv: LIMITS.multipv.default, engine: 'full' },
      exampleUrl: 'https://www.chess.com/analysis/game/live/186506919580/review?flip=true'
    });
  });

  // Importálás: Chess.com link VAGY beillesztett PGN
  app.post('/api/analysis/import', async (req, res) => {
    if (!allowImport(ownerOf(req))) {
      return res.status(429).json({ ok: false, code: 'RATE_LIMIT', error: 'Túl sok importálás. Várj egy percet.' });
    }
    const { url, pgn } = req.body || {};
    try {
      let imported;
      if (typeof pgn === 'string' && pgn.trim()) {
        if (pgn.length > LIMITS.maxPgnLength) throw new ImportError('PGN_TOO_LONG', 'A PGN túl hosszú.');
        imported = { pgn: pgn.trim(), source: 'pgn' };
      } else {
        imported = await importFromChessCom(url);
      }

      let game;
      try {
        game = describeGame(imported.pgn);
      } catch (err) {
        throw new ImportError('BAD_PGN', err.message);
      }
      res.json({ ok: true, source: imported.source, link: imported.url || null, pgn: imported.pgn, game });
    } catch (err) {
      if (err instanceof ImportError) {
        // A kliens ezzel tudja, hogy felajánlhatja a PGN beillesztést
        return res.status(err.code === 'RATE_LIMIT' ? 429 : 400).json({ ok: false, code: err.code, error: err.userMessage, canPastePgn: true });
      }
      console.error('[Analysis] Import hiba:', err);
      res.status(500).json({ ok: false, code: 'INTERNAL', error: 'Váratlan hiba az importálás közben.', canPastePgn: true });
    }
  });

  // Elemzés indítása
  app.post('/api/analysis/jobs', (req, res) => {
    const { pgn, depth, movetimeMs, multipv, engine } = req.body || {};
    try {
      const job = manager.submit({ pgn, settings: { depth, movetimeMs, multipv, engine }, owner: ownerOf(req) });
      res.status(202).json({ ok: true, jobId: job.id, ...manager.describe(job), result: undefined });
    } catch (err) {
      if (err instanceof JobError) return res.status(400).json({ ok: false, error: err.userMessage });
      console.error('[Analysis] Indítási hiba:', err);
      res.status(500).json({ ok: false, error: 'Váratlan hiba az elemzés indításakor.' });
    }
  });

  app.get('/api/analysis/jobs/:id', (req, res) => {
    const job = manager.get(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Az elemzés nem található (lejárt vagy nem létezik).' });
    res.json(manager.describe(job));
  });

  app.delete('/api/analysis/jobs/:id', (req, res) => {
    if (!manager.cancel(req.params.id)) return res.status(404).json({ ok: false, error: 'Az elemzés nem található.' });
    res.json({ ok: true });
  });

  return { manager };
}

module.exports = { setupAnalysisRoutes };
