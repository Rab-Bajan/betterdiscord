// Stockfish (WebAssembly build, npm "stockfish") futtatása Node gyerekfolyamatként, UCI protokollon.
// Egy példány egyszerre egy elemzést végez; a hívó felel a sorosításért.
const { spawn } = require('child_process');

const ENGINE_VARIANTS = {
  // Teljes NNUE hálóval (erősebb, ~100 MB wasm), egyszálú: nem kell SharedArrayBuffer
  full: 'single',
  // Kis háló (gyorsabb indulás, kicsit gyengébb)
  lite: 'lite-single'
};

function resolveEnginePath(variant) {
  const stockfish = require('stockfish');
  return stockfish.findEngine(ENGINE_VARIANTS[variant] || ENGINE_VARIANTS.full);
}

// "info depth 14 seldepth 20 multipv 2 score cp 31 nodes ... pv e2e4 e7e5" -> objektum
function parseInfo(line) {
  if (!line.startsWith('info ') || !line.includes(' pv ') || !line.includes(' score ')) return null;
  // Alsó/felső korlátos (nem végleges) értékeket kihagyjuk
  if (/\b(lowerbound|upperbound)\b/.test(line)) return null;

  const tokens = line.split(/\s+/);
  const info = { multipv: 1, pv: [] };
  for (let i = 1; i < tokens.length; i += 1) {
    switch (tokens[i]) {
      case 'depth': info.depth = Number(tokens[++i]); break;
      case 'seldepth': info.seldepth = Number(tokens[++i]); break;
      case 'multipv': info.multipv = Number(tokens[++i]); break;
      case 'nodes': info.nodes = Number(tokens[++i]); break;
      case 'time': info.time = Number(tokens[++i]); break;
      case 'score': {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        info.score = kind === 'mate' ? { mate: value } : { cp: value };
        break;
      }
      case 'pv':
        info.pv = tokens.slice(i + 1);
        i = tokens.length;
        break;
      default:
    }
  }
  return info.score ? info : null;
}

class UciEngine {
  constructor(child, name) {
    this.child = child;
    this.name = name;
    this.buffer = '';
    this.listeners = new Set();
    this.exited = false;
    this.busy = false;

    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.listeners.forEach((fn) => fn(line));
      }
    });
    child.stderr.on('data', () => {}); // a wasm futtató zaját nem naplózzuk
    child.on('exit', () => {
      this.exited = true;
      this.listeners.forEach((fn) => fn('__exit__'));
    });
  }

  static async start({ variant = 'full', hashMb = 64, threads = 1 } = {}) {
    const enginePath = resolveEnginePath(variant);
    const child = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    const engine = new UciEngine(child, 'Stockfish');

    child.on('error', () => { engine.exited = true; });

    const idLines = await engine.command('uci', /^uciok/, 20000, (line) => {
      if (line.startsWith('id name ')) engine.name = line.slice(8).trim();
    });
    void idLines;
    engine.send(`setoption name Threads value ${threads}`);
    engine.send(`setoption name Hash value ${hashMb}`);
    engine.send('setoption name UCI_AnalyseMode value true');
    await engine.command('isready', /^readyok/, 20000);
    return engine;
  }

  send(command) {
    if (!this.exited) this.child.stdin.write(`${command}\n`);
  }

  // Parancs küldése, majd a végmintának megfelelő sorig várakozás
  command(command, endPattern, timeoutMs, onLine) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Az engine nem válaszolt időben (${command}).`));
      }, timeoutMs);
      const listener = (line) => {
        if (line === '__exit__') {
          clearTimeout(timer);
          this.listeners.delete(listener);
          return reject(new Error('Az engine váratlanul leállt.'));
        }
        onLine?.(line);
        if (endPattern.test(line)) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
      this.send(command);
    });
  }

  async newGame() {
    this.send('ucinewgame');
    await this.command('isready', /^readyok/, 20000);
  }

  // Egy állás elemzése. Visszaad: { lines: [{ multipv, depth, score, pv }], bestmove }
  // A pontszámok az épp lépő fél szemszögéből értendők (UCI szabvány).
  async analyse(fen, { depth, movetimeMs, multipv = 3 } = {}) {
    if (this.busy) throw new Error('Az engine még dolgozik.');
    this.busy = true;
    try {
      this.send(`setoption name MultiPV value ${multipv}`);
      this.send(`position fen ${fen}`);

      const best = new Map(); // multipv -> legutóbbi (legmélyebb) info
      let goCommand = 'go';
      if (depth) goCommand += ` depth ${depth}`;
      if (movetimeMs) goCommand += ` movetime ${movetimeMs}`;
      if (!depth && !movetimeMs) goCommand += ' depth 14';

      // Biztonsági időkorlát: ha a keresés nem áll le, leállítjuk
      const guardMs = (movetimeMs || 0) * 4 + 60000;
      const bestLine = await this.command(goCommand, /^bestmove/, guardMs, (line) => {
        const info = parseInfo(line);
        if (!info) return;
        const current = best.get(info.multipv);
        if (!current || info.depth >= current.depth) best.set(info.multipv, info);
      }).catch((err) => {
        this.send('stop');
        throw err;
      });

      const lines = [...best.values()]
        .sort((a, b) => a.multipv - b.multipv)
        .map(({ multipv: index, depth: d, seldepth, score, pv, nodes }) => ({ multipv: index, depth: d, seldepth, score, pv, nodes }));
      const bestmove = bestLine.split(/\s+/)[1];
      return { lines, bestmove: bestmove && bestmove !== '(none)' ? bestmove : null };
    } finally {
      this.busy = false;
    }
  }

  // Futó keresés megszakítása
  stop() {
    this.send('stop');
  }

  quit() {
    if (this.exited) return;
    try {
      this.send('quit');
      this.child.kill();
    } catch {
      /* már leállt */
    }
    this.exited = true;
  }
}

module.exports = { UciEngine, parseInfo, ENGINE_VARIANTS };
