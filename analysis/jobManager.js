// Aszinkron elemzési feladatok: sor, haladás, megszakítás, ideiglenes tárolás.
// Egy feladat egy saját Stockfish folyamatot indít; egyszerre `concurrency` darab fut.
const crypto = require('crypto');
const { UciEngine } = require('./engine');
const { analyzeGame, parseGame } = require('./analyzer');

const LIMITS = {
  depth: { min: 6, max: 24, default: 14 },
  movetimeMs: { min: 50, max: 10000 },
  multipv: { min: 2, max: 5, default: 3 },
  maxPlies: 400,
  maxPgnLength: 200000,
  maxTotalMovetimeMs: 15 * 60 * 1000
};

class JobError extends Error {
  constructor(message) {
    super(message);
    this.userMessage = message;
  }
}

const clampInt = (value, { min, max }) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

// A kliens által küldött beállítások ellenőrzése és kiegészítése alapértékekkel
function normalizeSettings(input = {}) {
  const depth = input.depth != null && input.depth !== '' ? clampInt(input.depth, LIMITS.depth) : undefined;
  const movetimeMs = input.movetimeMs != null && input.movetimeMs !== '' && Number(input.movetimeMs) > 0
    ? clampInt(input.movetimeMs, LIMITS.movetimeMs)
    : undefined;
  return {
    // Ha egyik sincs megadva, az alapértelmezett mélységet használjuk
    depth: depth ?? (movetimeMs ? undefined : LIMITS.depth.default),
    movetimeMs,
    multipv: clampInt(input.multipv ?? LIMITS.multipv.default, LIMITS.multipv) ?? LIMITS.multipv.default,
    engine: input.engine === 'lite' ? 'lite' : 'full'
  };
}

class AnalysisJobManager {
  constructor({ concurrency = 1, maxQueue = 10, ttlMs = 60 * 60 * 1000, perOwnerLimit = 2 } = {}) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.ttlMs = ttlMs;
    this.perOwnerLimit = perOwnerLimit;
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.cache = new Map(); // kulcs -> { result, expires }

    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && now - job.finishedAt > this.ttlMs) this.jobs.delete(id);
    }
    for (const [key, entry] of this.cache) if (entry.expires < now) this.cache.delete(key);
  }

  cacheKey(pgn, settings) {
    return crypto.createHash('sha256').update(pgn).update(JSON.stringify(settings)).digest('hex');
  }

  // Új feladat. Hibát dob (JobError), ha a PGN hibás, túl nagy, vagy a sor tele van.
  submit({ pgn, settings: rawSettings, owner = 'anonymous' }) {
    if (typeof pgn !== 'string' || !pgn.trim()) throw new JobError('Nincs elemezhető PGN.');
    if (pgn.length > LIMITS.maxPgnLength) throw new JobError('A PGN túl hosszú.');

    let game;
    try {
      game = parseGame(pgn);
    } catch (err) {
      throw new JobError(err.message);
    }
    if (game.history.length > LIMITS.maxPlies) throw new JobError(`A játszma túl hosszú (legfeljebb ${LIMITS.maxPlies} fél-lépés elemezhető).`);

    const settings = normalizeSettings(rawSettings);
    if (settings.movetimeMs && (game.history.length + 1) * settings.movetimeMs > LIMITS.maxTotalMovetimeMs) {
      throw new JobError('A lépésenkénti idő túl nagy ehhez a játszmához. Csökkentsd az időt vagy a mélységet.');
    }

    const active = [...this.jobs.values()].filter((j) => j.owner === owner && (j.status === 'queued' || j.status === 'running'));
    if (active.length >= this.perOwnerLimit) throw new JobError('Már fut elemzésed. Várd meg a végét, vagy szakítsd meg.');
    if (this.queue.length >= this.maxQueue) throw new JobError('Az elemző most nagyon foglalt. Próbáld újra egy perc múlva.');

    const job = {
      id: crypto.randomBytes(9).toString('hex'),
      owner,
      status: 'queued',
      settings,
      pgn,
      total: game.history.length + 1,
      done: 0,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      cancelled: false,
      engine: null
    };

    // Ugyanaz a játszma ugyanazokkal a beállításokkal: azonnali eredmény
    const cached = this.cache.get(this.cacheKey(pgn, settings));
    if (cached && cached.expires > Date.now()) {
      Object.assign(job, { status: 'done', done: job.total, result: cached.result, finishedAt: Date.now(), cached: true });
      this.jobs.set(job.id, job);
      return job;
    }

    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return job;
  }

  pump() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job.cancelled) continue;
      this.running += 1;
      this.run(job).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  async run(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    try {
      job.engine = await UciEngine.start({ variant: job.settings.engine });
      const result = await analyzeGame({
        pgn: job.pgn,
        settings: job.settings,
        engine: job.engine,
        isCancelled: () => job.cancelled,
        onProgress: ({ done }) => { job.done = done; }
      });
      job.result = result;
      job.status = 'done';
      this.cache.set(this.cacheKey(job.pgn, job.settings), { result, expires: Date.now() + this.ttlMs });
    } catch (err) {
      if (job.cancelled || err.cancelled) {
        job.status = 'cancelled';
      } else {
        job.status = 'error';
        job.error = err.userMessage || 'Az elemzés közben hiba történt. Próbáld újra.';
        console.error('[Analysis] Hiba:', err.message);
      }
    } finally {
      job.finishedAt = Date.now();
      job.engine?.quit();
      job.engine = null;
    }
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status === 'queued') {
      job.cancelled = true;
      job.status = 'cancelled';
      job.finishedAt = Date.now();
    } else if (job.status === 'running') {
      job.cancelled = true;
      job.engine?.stop(); // a keresés azonnal megáll, a ciklus a következő állásnál kilép
    }
    return true;
  }

  // Állapot a kliensnek (az eredmény csak kész feladatnál)
  describe(job) {
    const elapsed = job.startedAt ? (Date.now() - job.startedAt) / 1000 : 0;
    const etaSeconds = job.status === 'running' && job.done > 1 ? Math.round((elapsed / job.done) * (job.total - job.done)) : null;
    return {
      ok: true,
      id: job.id,
      status: job.status,
      settings: job.settings,
      progress: { done: job.done, total: job.total, percent: Math.round((job.done / job.total) * 100), etaSeconds },
      queuePosition: job.status === 'queued' ? this.queue.indexOf(job) + 1 : null,
      cached: !!job.cached,
      error: job.error,
      ...(job.status === 'done' ? { result: job.result } : {})
    };
  }

  shutdown() {
    clearInterval(this.sweeper);
    for (const job of this.jobs.values()) {
      job.cancelled = true;
      job.engine?.quit();
    }
  }
}

module.exports = { AnalysisJobManager, JobError, normalizeSettings, LIMITS };
