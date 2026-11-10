// MiskolcEmpire szimuláció: szerver-autoritatív, 10 Hz-es, időzítő nélküli és magozottan determinisztikus.
// Az EmpireMatch.step() pontosan egy tickkel lép előre.
const C = require('./content');
const { createRng } = require('./rng');
const { generateMap } = require('./map');
const { Pathfinder } = require('./pathfinding');

const { TICK_HZ, POP_CAP_MAX, MAX_UNIT_IDS, MAX_QUEUE, EPOCHS, COUNTERS, BUILDINGS, UNITS, DEMOLISH } = C;
const CELL = 8;
const PATH_BUDGET = 14000;
const GATHER_RATE = { iron: 0.7, copper: 0.6, food: 0.9, wood: 0.8 };
const SPAWN_CROWD_PENALTY = 64; // squared tiles, outweighs the far side of a town center
const START_RES = { iron: 200, copper: 100, food: 300, wood: 300 };
const COMBAT_REVEAL_TICKS = 5 * TICK_HZ; // a kém harc után ennyi ideig leleplezett
const SIPHON_RANGE = 1.5;
const SIPHON_TARGETS = new Set(['scrapYard', 'townCenter']);
const SIPHON_NOTICE_TICKS = 15 * TICK_HZ;
const SPY_RANGE = 14;
const SPECTATOR_ERROR = 'Megfigyelő módban nem adhatsz parancsot.';

// Összesített építési sebesség N építőnél: 1 -> 1, 2 -> 1.7, 3 -> 2.2, minden további +0.4
function buildMult(n) {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n === 2) return 1.7;
  return 2.2 + 0.4 * (n - 3);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => Number.isSafeInteger(v);
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;

const rectDist = (px, py, x0, y0, x1, y1) => Math.hypot(Math.max(x0 - px, px - x1, 0), Math.max(y0 - py, py - y1, 0));

class EmpireMatch {
  // players: [{ name, team, isAi, difficulty, color }]
  constructor({ seed = 1, players, createAi = null }) {
    this.seed = seed >>> 0;
    this.rng = createRng(this.seed ^ 0x9e3779b9);
    this.tick = 0;
    this.status = 'playing';
    this.winnerTeam = null;
    this.paused = null;
    this.nextId = 1;
    this.events = [];
    this.queued = [];
    this.units = new Map();
    this.buildings = new Map();
    this.nodes = new Map();
    this.pathQueue = [];
    this.vis = new Map();
    this.pingCd = new Map();
    this.inStep = false;

    const map = generateMap(this.seed, players.length);
    this.map = { w: map.w, h: map.h, tiles: map.tiles };
    this.w = map.w;
    this.h = map.h;
    this.blocked = new Uint8Array(this.w * this.h);
    for (let i = 0; i < map.tiles.length; i++) if (map.tiles[i] === 'w' || map.tiles[i] === 'x') this.blocked[i] = 1;
    this.pf = new Pathfinder(this.w, this.h, this.blocked);
    this.cw = Math.ceil(this.w / CELL);
    this.cells = Array.from({ length: this.cw * Math.ceil(this.h / CELL) }, () => []);

    for (const n of map.nodes) {
      const id = this.nextId++;
      this.nodes.set(id, { id, k: n.k, x: n.x, y: n.y, a: n.a });
      this.blocked[n.y * this.w + n.x] = 1;
    }

    this.players = players.map((p, idx) => ({
      idx, name: p.name, team: p.team, color: p.color || C.PLAYER_COLORS[idx], isAi: !!p.isAi, difficulty: p.difficulty || null,
      alive: true, connected: true, epoch: 1, res: { ...START_RES }, pop: 0, popCap: 0, research: null, researchPct: 0,
      spectator: false, siphonT: -999,
      stats: { unitsKilled: 0, buildingsDestroyed: 0, gathered: 0, unitsLost: 0, damageDealt: 0 }, gatherBonus: p.isAi && p.difficulty === 'hard' ? 1.25 : 1,
      startPos: map.starts[idx], heroes: [], taverns: []
    }));

    this.players.forEach((p) => {
      const [sx, sy] = p.startPos;
      const tc = this.placeBuilding(p.idx, 'townCenter', sx, sy, true);
      for (let i = 0; i < 5; i++) this.spawnUnitNear(p.idx, 'scavenger', tc);
      for (let i = 0; i < 2; i++) this.spawnUnitNear(p.idx, 'builder', tc);
      this.recomputePopCap(p);
    });

    this.ais = [];
    if (createAi) {
      for (const p of this.players) if (p.isAi) this.ais.push(createAi(this, p.idx, p.difficulty || 'medium'));
    }
    this.updateVision();
  }

  // ---------- Segédek ----------
  atkMult(p) { return EPOCHS[p.epoch - 1].attack; }
  hpMult(p) { return EPOCHS[p.epoch - 1].hp; }
  gatherMult(p) { return EPOCHS[p.epoch - 1].gather; }
  entity(id) { return this.units.get(id) || this.buildings.get(id) || null; }
  event(w, vis) { this.events.push({ w, vis }); }
  // Tickek között (parancsból) keletkező esemény a következő tickkel megy ki, különben a step() felülírná
  eventSoon(w, vis) { if (this.inStep) this.event(w, vis); else this.queued.push({ w, vis }); }
  // Két tick között érkező értesítés (pl. lekapcsolódás): a következő tickben megy ki
  notify(text) { this.queued.push({ w: { e: 'msg', text }, vis: { all: true } }); }
  // Szünet alatt nincs step, ezért itt vesszük elő a sorban álló eseményeket
  prepareIdle() { this.events = this.queued.splice(0); }

  canAfford(p, cost) { return Object.keys(cost).every((k) => p.res[k] >= cost[k]); }
  pay(p, cost) { for (const k of Object.keys(cost)) p.res[k] -= cost[k]; }
  refund(p, cost) { for (const k of Object.keys(cost)) p.res[k] += cost[k]; }

  recomputePopCap(p) {
    let cap = 0;
    for (const b of this.buildings.values()) if (!b.dead && b.o === p.idx && b.complete) cap += b.def.popCap || 0;
    p.popCap = Math.min(POP_CAP_MAX, cap);
  }

  buildingRect(b) { return [b.x, b.y, b.x + b.size, b.y + b.size]; }
  distToEntity(u, e) {
    if (e.size) return rectDist(u.x, u.y, e.x, e.y, e.x + e.size, e.y + e.size);
    return Math.hypot(u.x - e.x, u.y - e.y);
  }

  teamVisible(team, e) {
    const vis = this.vis.get(team);
    if (!vis) return false;
    if (e.size) {
      for (let yy = e.y; yy < e.y + e.size; yy++) for (let xx = e.x; xx < e.x + e.size; xx++) if (vis[yy * this.w + xx]) return true;
      return false;
    }
    return vis[Math.floor(e.y) * this.w + Math.floor(e.x)] === 1;
  }
  tileVisible(team, x, y) {
    const vis = this.vis.get(team);
    return !!vis && vis[Math.floor(y) * this.w + Math.floor(x)] === 1;
  }

  // A kém az adott csapat szemében civilnek látszik-e (álcázott). Saját csapatnak sosem az.
  disguisedTo(team, e) {
    if (!e || e.size || !e.def.stealth || e.dead) return false;
    if (this.players[e.o].team === team) return false;
    if (this.tick - e.combatT <= COMBAT_REVEAL_TICKS) return false;
    return !(e.trueSeen && e.trueSeen.has(team));
  }

  // Igazlátás: kész Őrtorony vagy Vajda Háza látókörében a kém leleplezett
  computeTrueSight() {
    for (const u of this.units.values()) {
      if (u.dead || !u.def.stealth) continue;
      const seen = u.trueSeen || (u.trueSeen = new Set());
      seen.clear();
      const ownTeam = this.players[u.o].team;
      for (const b of this.buildings.values()) {
        if (b.dead || !b.complete || (b.k !== 'tower' && b.k !== 'townCenter')) continue;
        const team = this.players[b.o].team;
        if (team === ownTeam || seen.has(team)) continue;
        if (Math.hypot(b.x + b.size / 2 - u.x, b.y + b.size / 2 - u.y) <= b.def.sight) seen.add(team);
      }
    }
  }

  // ---------- Entitások létrehozása ----------
  createUnit(owner, k, x, y) {
    const p = this.players[owner];
    const def = UNITS[k];
    const maxHp = def.hp * this.hpMult(p);
    const u = {
      id: this.nextId++, o: owner, k, def, x, y, hp: maxHp, maxHp, tx: x, ty: y, v: 0, st: 'idle', c: 0, ct: null,
      order: null, path: null, pi: 0, pathPending: false, goalSig: null, pathT: -99, cd: 0, dead: false, hitT: -99, aggro: null,
      combatT: -999, trueSeen: null
    };
    this.units.set(u.id, u);
    return u;
  }

  freeTileNear(px, py, rx = px, ry = py) {
    return this.pf.nearestFree(rx, ry, 10) || this.pf.nearestFree(px, py, 10) || [Math.floor(px), Math.floor(py)];
  }

  spawnPoint(b) {
    const goalX = b.ra ? b.ra[0] : b.x + b.size / 2;
    const goalY = b.ra ? b.ra[1] : b.y + b.size + 2;
    // Occupied tiles cost extra so new units fan out around the building instead of stacking.
    const occupancy = new Map();
    for (const u of this.units.values()) {
      if (u.dead) continue;
      const key = Math.floor(u.y) * this.w + Math.floor(u.x);
      occupancy.set(key, (occupancy.get(key) || 0) + 1);
    }
    let best = null;
    let bd = Infinity;
    for (let yy = b.y - 1; yy <= b.y + b.size; yy++) {
      for (let xx = b.x - 1; xx <= b.x + b.size; xx++) {
        const edge = xx === b.x - 1 || xx === b.x + b.size || yy === b.y - 1 || yy === b.y + b.size;
        if (!edge || !this.pf.isFree(xx, yy)) continue;
        const crowd = occupancy.get(yy * this.w + xx) || 0;
        const d = (xx + 0.5 - goalX) ** 2 + (yy + 0.5 - goalY) ** 2 + crowd * SPAWN_CROWD_PENALTY;
        if (d < bd) { bd = d; best = [xx, yy]; }
      }
    }
    return best || this.pf.nearestFree(b.x + b.size / 2, b.y + b.size / 2, 12) || [b.x, b.y];
  }

  spawnUnitNear(owner, k, b) {
    const [tx, ty] = this.spawnPoint(b);
    const u = this.createUnit(owner, k, tx + 0.5, ty + 0.5);
    this.players[owner].pop++;
    return u;
  }

  placeBuilding(owner, k, x, y, complete) {
    const def = BUILDINGS[k];
    const b = {
      id: this.nextId++, o: owner, k, def, x, y, size: def.size, hp: complete ? def.hp : Math.max(1, def.hp * 0.1), maxHp: def.hp,
      bp: complete ? 100 : 0, bpF: complete ? 100 : 0, complete: !!complete, q: [], ra: null, cd: 0, dead: false, hitT: -99, bpShown: complete ? 100 : 0, qVer: 0, qCache: [], raVer: 0,
      workT: -1, workN: 0
    };
    this.buildings.set(b.id, b);
    for (let yy = y; yy < y + b.size; yy++) for (let xx = x; xx < x + b.size; xx++) this.blocked[yy * this.w + xx] = 1;
    return b;
  }

  checkPlacement(x, y, size) {
    if (x < 0 || y < 0 || x + size > this.w || y + size > this.h) return 'A hely kívül esik a térképen.';
    for (let yy = y; yy < y + size; yy++) for (let xx = x; xx < x + size; xx++) if (this.blocked[yy * this.w + xx]) return 'Ide nem lehet építeni: útban van valami.';
    return null;
  }

  // AI is ezzel keresi a telket
  canPlace(owner, k, x, y) {
    return C.isBuildingId(k) && !this.checkPlacement(x, y, BUILDINGS[k].size);
  }

  // Az új épület alól kitoloncolja az egységeket, az érintett útvonalakat újratervezteti
  afterPlacement(b) {
    for (const u of this.units.values()) {
      if (u.dead) continue;
      const tx = Math.floor(u.x);
      const ty = Math.floor(u.y);
      if (tx >= b.x && tx < b.x + b.size && ty >= b.y && ty < b.y + b.size) {
        const free = this.pf.nearestFree(u.x, u.y, 8);
        if (free) { u.x = free[0] + 0.5; u.y = free[1] + 0.5; }
        u.path = null; u.goalSig = null; u.pathPending = false;
      } else if (u.path) {
        let px = u.x;
        let py = u.y;
        for (let i = u.pi; i < u.path.length; i += 2) {
          if (!this.pf.lineClear(px, py, u.path[i], u.path[i + 1])) { u.path = null; u.goalSig = null; u.pathPending = false; break; }
          px = u.path[i]; py = u.path[i + 1];
        }
      }
    }
  }

  // ---------- Parancsok ----------
  command(idx, cmd) {
    const p = this.players[idx];
    if (!p) return fail('Ismeretlen játékos.');
    if (this.status !== 'playing') return fail('A játék véget ért.');
    if (p.spectator) return fail(SPECTATOR_ERROR);
    if (!p.alive) return fail('Már kiestél a játékból.');
    if (this.paused) return fail('A játék szünetel.');
    if (!isObj(cmd) || typeof cmd.type !== 'string' || cmd.type.length > 24) return fail('Érvénytelen parancs.');
    const handler = COMMANDS.get(cmd.type);
    if (!handler) return fail('Ismeretlen parancstípus.');
    try {
      return handler(this, p, cmd);
    } catch (err) {
      return fail('Érvénytelen parancs.');
    }
  }

  parseUnits(p, cmd) {
    const ids = cmd.unitIds;
    if (!Array.isArray(ids) || ids.length === 0) return { error: 'Nincs kijelölt egység.' };
    if (ids.length > MAX_UNIT_IDS) return { error: 'Túl sok kijelölt egység.' };
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      if (!isInt(id)) return { error: 'Érvénytelen egység azonosító.' };
      if (seen.has(id)) continue;
      seen.add(id);
      const u = this.units.get(id);
      if (!u || u.dead || u.o !== p.idx) return { error: 'Ez az egység nem a tiéd.' };
      out.push(u);
    }
    return { units: out };
  }

  parsePoint(t) {
    if (!isObj(t) || typeof t.x !== 'number' || typeof t.y !== 'number' || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return null;
    if (t.x < 0 || t.y < 0 || t.x >= this.w || t.y >= this.h) return null;
    return { x: t.x, y: t.y };
  }

  parseEntityId(t) {
    return isObj(t) && isInt(t.entityId) ? t.entityId : null;
  }

  ownBuilding(p, id) {
    const b = isInt(id) ? this.buildings.get(id) : null;
    return b && !b.dead && this.players[b.o].team === p.team && b.o === p.idx ? b : null;
  }

  // ---------- Útkeresés ----------
  setOrder(u, order) {
    u.order = order; u.path = null; u.goalSig = null; u.pathPending = false; u.aggro = null;
  }

  requestPath(u, sig, goal, reach, finalX, finalY) {
    if (u.goalSig === sig && (u.path || u.pathPending)) return;
    u.goalSig = sig;
    u.pathT = this.tick;
    u.path = null;
    // Gyors út: egyenes látótér a célig
    if (reach === 0 && finalX !== undefined && this.pf.lineClear(u.x, u.y, finalX, finalY)) {
      u.path = [finalX, finalY]; u.pi = 0; u.pathPending = false;
      return;
    }
    u.goal = { goal, reach, finalX, finalY };
    if (!u.pathPending) { u.pathPending = true; this.pathQueue.push(u.id); }
  }

  processPaths() {
    let budget = PATH_BUDGET;
    let n = 0;
    while (this.pathQueue.length && budget > 0 && n < 200) {
      const id = this.pathQueue.shift();
      n++;
      const u = this.units.get(id);
      if (!u || u.dead || !u.pathPending || !u.goal) continue;
      const { goal, reach, finalX, finalY } = u.goal;
      const path = this.pf.find(u.x, u.y, goal, reach);
      budget -= Math.max(1, this.pf.expanded);
      u.pathPending = false;
      if (!path) { u.goalSig = null; if (u.order && u.order.type === 'move') u.order = null; continue; }
      if (finalX !== undefined && reach === 0 && this.pf.isFree(Math.floor(finalX), Math.floor(finalY))) {
        path[path.length - 2] = finalX; path[path.length - 1] = finalY;
      }
      u.path = path; u.pi = 0;
    }
  }

  // Egy tickes mozgás az útvonalon. Igaz, ha még úton van.
  advance(u) {
    if (!u.path) { u.v = 0; u.tx = u.x; u.ty = u.y; return false; }
    let step = u.def.speed / TICK_HZ;
    while (step > 0 && u.path && u.pi < u.path.length) {
      const wx = u.path[u.pi];
      const wy = u.path[u.pi + 1];
      const dx = wx - u.x;
      const dy = wy - u.y;
      const d = Math.hypot(dx, dy);
      if (d <= step) {
        u.x = wx; u.y = wy; step -= d; u.pi += 2;
      } else {
        u.x += (dx / d) * step; u.y += (dy / d) * step; step = 0;
      }
    }
    if (u.pi >= u.path.length) {
      u.path = null; u.v = 0; u.tx = u.x; u.ty = u.y;
      return false;
    }
    u.v = u.def.speed; u.tx = u.path[u.pi]; u.ty = u.path[u.pi + 1];
    return true;
  }

  stopUnit(u) { u.path = null; u.v = 0; u.tx = u.x; u.ty = u.y; }

  // ---------- Lépés ----------
  step() {
    if (this.status !== 'playing' || this.paused) return;
    this.inStep = true;
    try { this.stepInner(); } finally { this.inStep = false; }
  }

  stepInner() {
    this.tick++;
    this.events = this.queued.splice(0);
    this.buildHash();
    this.computeAuras();
    this.processPaths();

    for (const ai of this.ais) {
      const p = this.players[ai.idx];
      if (p.alive) ai.think(this.tick);
    }

    for (const u of this.units.values()) if (!u.dead) this.stepUnit(u);
    for (const b of this.buildings.values()) if (!b.dead) this.stepBuilding(b);
    for (const p of this.players) if (p.alive) this.stepResearch(p);

    this.cleanup();
    this.checkEliminations();
    this.updateVision();
    if (this.tick % TICK_HZ === 0) this.refreshSlowViews();
  }

  buildHash() {
    for (const c of this.cells) c.length = 0;
    for (const u of this.units.values()) {
      if (u.dead) continue;
      const cx = Math.min(this.cw - 1, Math.max(0, Math.floor(u.x / CELL)));
      const cy = Math.min(Math.ceil(this.h / CELL) - 1, Math.max(0, Math.floor(u.y / CELL)));
      this.cells[cy * this.cw + cx].push(u);
    }
  }

  nearestEnemyUnit(team, x, y, r, preferMilitary) {
    const rows = Math.ceil(this.h / CELL);
    const x0 = Math.max(0, Math.floor((x - r) / CELL));
    const x1 = Math.min(this.cw - 1, Math.floor((x + r) / CELL));
    const y0 = Math.max(0, Math.floor((y - r) / CELL));
    const y1 = Math.min(rows - 1, Math.floor((y + r) / CELL));
    let best = null;
    let bs = Infinity;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        for (const e of this.cells[cy * this.cw + cx]) {
          if (e.dead || this.players[e.o].team === team || this.disguisedTo(team, e)) continue;
          const d = Math.hypot(e.x - x, e.y - y);
          if (d > r) continue;
          const score = d + (preferMilitary && e.def.class === 'worker' ? 3 : 0);
          if (score < bs) { bs = score; best = e; }
        }
      }
    }
    return best;
  }

  nearestEnemyBuilding(team, x, y, r) {
    let best = null;
    let bd = Infinity;
    for (const b of this.buildings.values()) {
      if (b.dead || this.players[b.o].team === team) continue;
      const d = rectDist(x, y, b.x, b.y, b.x + b.size, b.y + b.size);
      if (d <= r && d < bd) { bd = d; best = b; }
    }
    return best;
  }

  computeAuras() {
    for (const p of this.players) { p.heroes.length = 0; p.taverns.length = 0; }
    for (const u of this.units.values()) if (!u.dead && u.def.hero) this.players[u.o].heroes.push(u);
    for (const b of this.buildings.values()) if (!b.dead && b.complete && b.def.aura) this.players[b.o].taverns.push(b);
  }

  gatherRate(u, p) {
    let bonus = 1;
    for (const h of p.heroes) if (Math.hypot(h.x - u.x, h.y - u.y) <= h.def.aura.radius) { bonus += h.def.aura.gather; break; }
    for (const t of p.taverns) if (Math.hypot(t.x + 1 - u.x, t.y + 1 - u.y) <= t.def.aura.radius) { bonus += t.def.aura.gather; break; }
    return (GATHER_RATE[u.ct] || 0.7) * this.gatherMult(p) * bonus * p.gatherBonus / TICK_HZ;
  }

  stepUnit(u) {
    if (u.cd > 0) u.cd--;
    const o = u.order;
    if (!o) {
      u.st = 'idle'; u.v = 0; u.tx = u.x; u.ty = u.y;
      if (u.def.attack > 0 && u.def.class !== 'worker' && !u.def.stealth && (this.tick + u.id) % 5 === 0) this.autoAcquire(u);
      return;
    }
    switch (o.type) {
      case 'move': return this.doMove(u, o);
      case 'attack': return this.doAttack(u, o);
      case 'gather': return this.doGather(u, o);
      case 'build': return this.doBuild(u, o);
      case 'siphon': return this.doSiphon(u, o);
      default: u.order = null;
    }
  }

  doMove(u, o) {
    u.st = 'move';
    const tile = [Math.floor(o.x), Math.floor(o.y)];
    if (this.pf.isFree(tile[0], tile[1])) this.requestPath(u, `m${o.x},${o.y}`, { x0: tile[0], y0: tile[1], x1: tile[0], y1: tile[1] }, 0, o.x, o.y);
    else this.requestPath(u, `m${o.x},${o.y}`, { x0: tile[0], y0: tile[1], x1: tile[0], y1: tile[1] }, 1);
    if (this.advance(u)) return;
    if (!u.pathPending && !u.path) { u.order = null; u.st = 'idle'; u.goalSig = null; }
  }

  autoAcquire(u) {
    const p = this.players[u.o];
    const r = Math.max(u.def.range + 2, 7);
    let t = null;
    if (u.aggro) {
      const a = this.units.get(u.aggro);
      if (a && !a.dead && Math.hypot(a.x - u.x, a.y - u.y) <= r + 3) t = a;
      u.aggro = null;
    }
    if (!t) t = this.nearestEnemyUnit(p.team, u.x, u.y, r, true);
    if (!t) t = this.nearestEnemyBuilding(p.team, u.x, u.y, r);
    if (t) { u.order = { type: 'attack', target: t.id, auto: true, ox: u.x, oy: u.y }; u.goalSig = null; }
  }

  doAttack(u, o) {
    const p = this.players[u.o];
    const t = this.entity(o.target);
    if (!t || t.dead || this.players[t.o].team === p.team || !this.teamVisible(p.team, t) || this.disguisedTo(p.team, t)) { u.order = null; u.st = 'idle'; this.stopUnit(u); return; }
    if (o.auto && Math.hypot(t.x - o.ox, t.y - o.oy) > Math.max(u.def.range + 2, 7) + 6) { u.order = null; this.stopUnit(u); return; }
    u.st = 'attack';
    const d = this.distToEntity(u, t);
    const reach = u.def.range + (t.size ? 0.4 : 0.8);
    if (d <= reach) {
      this.stopUnit(u);
      if (u.cd <= 0) { this.strike(u, t); u.cd = Math.max(1, Math.round(u.def.cooldown * TICK_HZ)); }
      return;
    }
    // Üldözés: az útvonalat csak ritkán tervezzük újra
    const tx = Math.floor(t.x);
    const ty = Math.floor(t.y);
    const sig = `e${t.id}`;
    if (t.size) {
      this.requestPath(u, sig, { x0: t.x, y0: t.y, x1: t.x + t.size - 1, y1: t.y + t.size - 1 }, Math.max(1, Math.floor(u.def.range * 0.6)));
    } else {
      const stale = u.goalSig !== sig || (this.tick - u.pathT >= 10 && (u.chaseX !== tx || u.chaseY !== ty));
      if (stale) {
        u.chaseX = tx; u.chaseY = ty;
        u.goalSig = null;
        this.requestPath(u, sig, { x0: tx, y0: ty, x1: tx, y1: ty }, Math.floor(u.def.range * 0.6), t.x, t.y);
      }
    }
    this.advance(u);
  }

  // ---------- Sebzés ----------
  heroResist(owner, x, y) {
    for (const h of this.players[owner].heroes) if (Math.hypot(h.x - x, h.y - y) <= h.def.aura.radius) return h.def.aura.resist;
    return 0;
  }

  strike(a, t) {
    const isUnit = !t.size;
    const aDef = a.def;
    const p = this.players[a.o];
    const targetClass = isUnit ? t.def.class : 'building';
    const counter = (COUNTERS[aDef.class] && COUNTERS[aDef.class][targetClass]) || 1;
    const armor = isUnit ? Math.min(0.7, (t.def.armor || 0) + this.heroResist(t.o, t.x, t.y)) : 0;
    const dmg = Math.max(1, aDef.attack * this.atkMult(p) * counter * (1 - armor));
    if (aDef.range > 2) {
      this.event({ e: 'proj', a: a.id, x: r1(a.x), y: r1(a.y), tx: r1(isUnit ? t.x : t.x + t.size / 2), ty: r1(isUnit ? t.y : t.y + t.size / 2), k: a.k }, { pos: [[a.x, a.y], [t.x, t.y]] });
    }
    a.combatT = this.tick;
    this.damage(a.o, t, dmg, a.id);
  }

  damage(attackerOwner, t, dmg, attackerId = null) {
    if (t.dead) return;
    const ap = this.players[attackerOwner];
    if (ap) ap.stats.damageDealt += Math.min(dmg, Math.max(0, t.hp));
    if (!t.size) t.combatT = this.tick;
    t.hp -= dmg;
    const cx = t.size ? t.x + t.size / 2 : t.x;
    const cy = t.size ? t.y + t.size / 2 : t.y;
    if (this.tick - t.hitT >= 10) {
      t.hitT = this.tick;
      this.event({ e: 'hit', i: t.id }, { pos: [[cx, cy]] });
    }
    const victim = this.players[t.o];
    if ((this.tick - (victim.attackedT ?? -99)) >= 30) {
      victim.attackedT = this.tick;
      this.event({ e: 'attacked', x: r2(cx), y: r2(cy) }, { owner: t.o });
    }
    if (!t.size && !t.order && attackerId !== null) t.aggro = attackerId;
    if (t.hp <= 0) {
      this.kill(t);
      if (!t.size) victim.stats.unitsLost++;
      if (ap) { if (t.size) ap.stats.buildingsDestroyed++; else ap.stats.unitsKilled++; }
    }
  }

  kill(t) {
    if (t.dead) return;
    t.dead = true;
    const cx = t.size ? t.x + t.size / 2 : t.x;
    const cy = t.size ? t.y + t.size / 2 : t.y;
    this.event({ e: 'dead', i: t.id, x: r1(cx), y: r1(cy) }, { pos: [[cx, cy]] });
  }

  cleanup() {
    let popDirty = false;
    for (const [id, u] of this.units) {
      if (!u.dead) continue;
      this.units.delete(id);
      this.players[u.o].pop = Math.max(0, this.players[u.o].pop - 1);
    }
    for (const [id, b] of this.buildings) {
      if (!b.dead) continue;
      this.buildings.delete(id);
      for (let yy = b.y; yy < b.y + b.size; yy++) for (let xx = b.x; xx < b.x + b.size; xx++) this.blocked[yy * this.w + xx] = 0;
      const p = this.players[b.o];
      for (let i = 0; i < b.q.length; i++) p.pop = Math.max(0, p.pop - 1);
      popDirty = true;
    }
    if (popDirty) for (const p of this.players) this.recomputePopCap(p);
  }

  // ---------- Gyűjtés ----------
  findDropOff(u) {
    let best = null;
    let bd = Infinity;
    for (const b of this.buildings.values()) {
      if (b.dead || !b.complete || b.o !== u.o || !b.def.dropOff || !b.def.dropOff.includes(u.ct)) continue;
      const d = rectDist(u.x, u.y, b.x, b.y, b.x + b.size, b.y + b.size);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  findNode(kind, x, y, maxD) {
    let best = null;
    let bd = maxD;
    for (const n of this.nodes.values()) {
      if (n.k !== kind || n.a <= 0) continue;
      const d = Math.hypot(n.x + 0.5 - x, n.y + 0.5 - y);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  doGather(u, o) {
    const p = this.players[u.o];
    let node = this.nodes.get(o.node);
    if (o.phase === 'toNode' || o.phase === 'gathering') {
      if (!node || node.a <= 0) {
        const alt = node ? this.findNode(node.k, u.x, u.y, 22) : null;
        if (alt) { o.node = alt.id; node = alt; u.goalSig = null; o.phase = 'toNode'; }
        else if (u.c > 0) { o.phase = 'toDrop'; u.goalSig = null; }
        else { u.order = null; this.stopUnit(u); u.st = 'idle'; return; }
      }
    }
    if (o.phase === 'toNode') {
      u.st = 'gather';
      if (u.ct && u.ct !== node.k) { u.c = 0; }
      u.ct = node.k;
      const d = rectDist(u.x, u.y, node.x, node.y, node.x + 1, node.y + 1);
      if (d <= 1.3) { this.stopUnit(u); o.phase = 'gathering'; return; }
      this.requestPath(u, `n${node.id}`, { x0: node.x, y0: node.y, x1: node.x, y1: node.y }, 1);
      this.advance(u);
      if (!u.path && !u.pathPending) { u.goalSig = null; u.order = null; u.st = 'idle'; }
      return;
    }
    if (o.phase === 'gathering') {
      u.st = 'gather';
      u.ct = node.k;
      const cap = u.def.capacity || 10;
      const take = Math.min(this.gatherRate(u, p), node.a, cap - u.c);
      u.c += take;
      node.a -= take;
      if (node.a <= 0.0001) { node.a = 0; this.blocked[node.y * this.w + node.x] = 0; }
      if (u.c >= cap - 0.0001 || node.a <= 0) { o.phase = 'toDrop'; u.goalSig = null; }
      return;
    }
    // toDrop
    u.st = 'return';
    let drop = o.drop ? this.buildings.get(o.drop) : null;
    if (!drop || drop.dead) { drop = this.findDropOff(u); o.drop = drop ? drop.id : null; u.goalSig = null; }
    if (!drop) { this.stopUnit(u); return; }
    const d = rectDist(u.x, u.y, drop.x, drop.y, drop.x + drop.size, drop.y + drop.size);
    if (d <= 1.3) {
      this.stopUnit(u);
      const whole = Math.floor(u.c + 0.0001);
      p.res[u.ct] += whole;
      p.stats.gathered += whole;
      u.c = 0;
      o.phase = 'toNode'; o.drop = null; u.goalSig = null;
      return;
    }
    this.requestPath(u, `d${drop.id}`, { x0: drop.x, y0: drop.y, x1: drop.x + drop.size - 1, y1: drop.y + drop.size - 1 }, 1);
    this.advance(u);
  }

  // ---------- Építés és javítás ----------
  doBuild(u, o) {
    const b = this.buildings.get(o.target);
    if (!b || b.dead || (b.complete && b.hp >= b.maxHp - 0.01)) { u.order = null; u.st = 'idle'; this.stopUnit(u); return; }
    u.st = 'build';
    const d = rectDist(u.x, u.y, b.x, b.y, b.x + b.size, b.y + b.size);
    if (d > 1.4) {
      this.requestPath(u, `b${b.id}`, { x0: b.x, y0: b.y, x1: b.x + b.size - 1, y1: b.y + b.size - 1 }, 1);
      this.advance(u);
      if (!u.path && !u.pathPending) { u.goalSig = null; u.order = null; u.st = 'idle'; }
      return;
    }
    this.stopUnit(u);
    // Csökkenő hozadék: a tickben az n-edik építő csak buildMult(n) - buildMult(n-1) sebességet ad hozzá
    if (b.workT !== this.tick) { b.workT = this.tick; b.workN = 0; }
    b.workN++;
    const share = buildMult(b.workN) - buildMult(b.workN - 1);
    if (!b.complete) {
      b.bpF = Math.min(100, b.bpF + share * 100 / (b.def.buildTime * TICK_HZ));
      b.hp = Math.min(b.maxHp, b.hp + share * b.maxHp * 0.9 / (b.def.buildTime * TICK_HZ));
      if (b.bpF >= 100) {
        b.complete = true; b.bp = 100; b.bpShown = 100; b.hp = Math.max(b.hp, b.maxHp * 0.95);
        this.recomputePopCap(this.players[b.o]);
        this.event({ e: 'built', i: b.id }, { team: this.players[b.o].team });
      } else b.bp = Math.floor(b.bpF);
    } else {
      b.hp = Math.min(b.maxHp, b.hp + share * b.maxHp / (b.def.buildTime * TICK_HZ * 2));
    }
  }

  // ---------- Kém: dézsmálás ----------
  doSiphon(u, o) {
    const p = this.players[u.o];
    const b = this.buildings.get(o.target);
    if (!b || b.dead || this.players[b.o].team === p.team || !u.def.siphon) { u.order = null; u.st = 'idle'; this.stopUnit(u); return; }
    const d = rectDist(u.x, u.y, b.x, b.y, b.x + b.size, b.y + b.size);
    if (d > SIPHON_RANGE) {
      u.st = 'move';
      o.t = 0;
      this.requestPath(u, `s${b.id}`, { x0: b.x, y0: b.y, x1: b.x + b.size - 1, y1: b.y + b.size - 1 }, 1);
      this.advance(u);
      if (!u.path && !u.pathPending) { u.goalSig = null; u.order = null; u.st = 'idle'; }
      return;
    }
    this.stopUnit(u);
    u.st = 'siphon';
    o.t = (o.t || 0) + 1;
    const sp = u.def.siphon;
    if (o.t < sp.everySec * TICK_HZ) return;
    o.t = 0;
    const victim = this.players[b.o];
    const iron = Math.max(0, Math.min(sp.iron, Math.floor(victim.res.iron)));
    const copper = Math.max(0, Math.min(sp.copper, Math.floor(victim.res.copper)));
    victim.res.iron -= iron; victim.res.copper -= copper;
    p.res.iron += iron; p.res.copper += copper;
    if ((iron > 0 || copper > 0) && this.tick - victim.siphonT >= SIPHON_NOTICE_TICKS) {
      victim.siphonT = this.tick;
      this.event({ e: 'siphoned', text: 'Valaki dézsmálja a készleteidet a MÉH telepnél!', x: r2(b.x + b.size / 2), y: r2(b.y + b.size / 2) }, { owner: victim.idx });
    }
  }

  // ---------- Bontás ----------
  demolishRefund(b) {
    let r;
    if (!b.complete) r = DEMOLISH.maxRefund * (b.bp / 100);
    else {
      const f = Math.max(0, Math.min(1, b.hp / b.maxHp));
      r = f >= 0.5 ? DEMOLISH.minRefund + (DEMOLISH.maxRefund - DEMOLISH.minRefund) * ((f - 0.5) / 0.5) : DEMOLISH.minRefund * (f / 0.5);
    }
    const out = {};
    for (const k of Object.keys(b.def.cost)) out[k] = Math.floor(b.def.cost[k] * r + 1e-9);
    return out;
  }

  // ---------- Kémjelentés ----------
  spyReport(idx) {
    const me = this.players[idx];
    const out = [];
    if (!me || !me.alive) return out;
    for (const u of this.units.values()) {
      if (u.dead || u.o !== idx || !u.def.stealth) continue;
      let best = null;
      let bd = SPY_RANGE;
      for (const b of this.buildings.values()) {
        if (b.dead || this.players[b.o].team === me.team) continue;
        const d = rectDist(u.x, u.y, b.x, b.y, b.x + b.size, b.y + b.size);
        if (d <= bd) { bd = d; best = b; }
      }
      if (!best) continue;
      const v = this.players[best.o];
      let military = 0;
      for (const e of this.units.values()) if (!e.dead && e.o === v.idx && e.def.class !== 'worker') military++;
      out.push({
        unitId: u.id, victim: v.idx, name: v.name, color: v.color,
        res: { iron: Math.floor(v.res.iron), copper: Math.floor(v.res.copper), food: Math.floor(v.res.food), wood: Math.floor(v.res.wood) },
        epoch: v.epoch, research: v.research ? { epoch: v.research.epoch, pct: v.researchPct } : null, military
      });
    }
    return out;
  }

  // Megfigyelői összesítő (1 Hz)
  spectatorSummary() {
    const rows = this.players.map((p) => ({
      idx: p.idx, name: p.name, color: p.color, team: p.team, alive: p.alive, army: 0, workers: 0, buildings: 0, epoch: p.epoch,
      res: { iron: Math.floor(p.res.iron), copper: Math.floor(p.res.copper), food: Math.floor(p.res.food), wood: Math.floor(p.res.wood) }
    }));
    for (const u of this.units.values()) if (!u.dead) { if (u.def.class === 'worker') rows[u.o].workers++; else rows[u.o].army++; }
    for (const b of this.buildings.values()) if (!b.dead) rows[b.o].buildings++;
    return { elapsed: Math.floor(this.tick / TICK_HZ), players: rows };
  }

  // ---------- Épületek: képzés, torony ----------
  stepBuilding(b) {
    if (b.cd > 0) b.cd--;
    if (!b.complete) return;
    const p = this.players[b.o];
    if (b.q.length) {
      const item = b.q[0];
      item.t++;
      if (item.t >= item.total) {
        b.q.shift();
        const u = this.spawnUnitNear(b.o, item.u, b);
        p.pop--; // a sorban lévő hely már foglalt volt, a spawnUnitNear újra számolt
        if (b.ra) { u.order = { type: 'move', x: b.ra[0], y: b.ra[1] }; }
        this.touchQueue(b);
      }
    }
    if (b.def.attack && b.cd <= 0) {
      const t = this.nearestEnemyUnit(p.team, b.x + b.size / 2, b.y + b.size / 2, b.def.range, true);
      if (t) {
        this.event({ e: 'proj', a: b.id, x: r1(b.x + b.size / 2), y: r1(b.y + b.size / 2), tx: r1(t.x), ty: r1(t.y), k: b.k }, { pos: [[b.x, b.y], [t.x, t.y]] });
        this.damage(b.o, t, b.def.attack * this.atkMult(p) * (1 - Math.min(0.7, t.def.armor || 0)));
        b.cd = Math.round(b.def.cooldown * TICK_HZ);
      }
    }
  }

  stepResearch(p) {
    if (!p.research) return;
    p.research.left--;
    if (p.research.left > 0) return;
    const old = this.hpMult(p);
    p.epoch = p.research.epoch;
    p.research = null;
    p.researchPct = 0;
    const ratio = this.hpMult(p) / old;
    for (const u of this.units.values()) if (!u.dead && u.o === p.idx) { u.hp *= ratio; u.maxHp *= ratio; }
    this.event({ e: 'epoch', o: p.idx, n: p.epoch }, { all: true });
    this.event({ e: 'msg', text: `${p.name} új korszakba lépett: ${EPOCHS[p.epoch - 1].name}.` }, { all: true });
  }

  refreshSlowViews() {
    for (const p of this.players) {
      if (p.research) p.researchPct = Math.floor((1 - p.research.left / p.research.total) * 100);
    }
    for (const b of this.buildings.values()) {
      b.bpShown = b.complete ? 100 : Math.floor(b.bpF);
      if (b.q.length || b.qCache.length) this.touchQueue(b);
    }
  }

  touchQueue(b) {
    b.qVer++;
    b.qCache = this.qView(b);
  }

  qView(b) {
    return b.q.map((i) => ({ u: i.u, p: Math.min(99, Math.floor((i.t / i.total) * 100)) }));
  }

  // ---------- Kiesés, győzelem ----------
  checkEliminations() {
    for (const p of this.players) {
      if (!p.alive) continue;
      let has = false;
      for (const b of this.buildings.values()) if (!b.dead && b.o === p.idx && !b.def.barricade) { has = true; break; }
      if (!has) this.eliminate(p, 'elim');
    }
    if (this.status !== 'playing') return;
    const teams = new Set();
    for (const p of this.players) if (p.alive) teams.add(p.team);
    if (teams.size <= 1) {
      this.status = 'ended';
      this.winnerTeam = teams.size === 1 ? [...teams][0] : null;
    }
  }

  eliminate(p, why) {
    if (!p.alive) return;
    p.alive = false;
    p.spectator = !p.isAi;
    p.research = null;
    for (const u of this.units.values()) if (u.o === p.idx) { u.dead = true; }
    for (const b of this.buildings.values()) if (b.o === p.idx) { b.dead = true; }
    this.cleanup();
    p.pop = 0;
    this.eventSoon({ e: 'msg', text: why === 'resign' ? `${p.name} feladta a játékot.` : `${p.name} kiesett: nincs több épülete.` }, { all: true });
    this.eventSoon({ e: 'defeat', stats: this.statsView(p) }, { owner: p.idx });
  }

  statsView(p) {
    const s = p.stats;
    return { unitsLost: s.unitsLost, unitsKilled: s.unitsKilled, buildingsDestroyed: s.buildingsDestroyed, gathered: Math.floor(s.gathered), damageDealt: Math.floor(s.damageDealt) };
  }

  resign(idx) {
    const p = this.players[idx];
    if (!p || !p.alive || this.status !== 'playing') return false;
    this.eliminate(p, 'resign');
    this.checkEliminations();
    this.updateVision();
    return true;
  }

  results() {
    return this.players.map((p) => ({
      idx: p.idx, name: p.name, team: p.team, isAi: p.isAi, won: this.winnerTeam !== null && p.team === this.winnerTeam,
      unitsKilled: p.stats.unitsKilled, buildingsDestroyed: p.stats.buildingsDestroyed, gathered: Math.floor(p.stats.gathered),
      unitsLost: p.stats.unitsLost, damageDealt: Math.floor(p.stats.damageDealt)
    }));
  }

  // ---------- Látótér ----------
  updateVision() {
    const teams = new Set(this.players.map((p) => p.team));
    for (const t of teams) {
      let m = this.vis.get(t);
      if (!m) { m = new Uint8Array(this.w * this.h); this.vis.set(t, m); } else m.fill(0);
    }
    const stamp = (m, cx, cy, r) => {
      const y0 = Math.max(0, Math.floor(cy - r));
      const y1 = Math.min(this.h - 1, Math.floor(cy + r));
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy;
        const span = Math.sqrt(Math.max(0, r * r - dy * dy));
        const xa = Math.max(0, Math.floor(cx - span));
        const xb = Math.min(this.w - 1, Math.floor(cx + span));
        if (xb >= xa) m.fill(1, y * this.w + xa, y * this.w + xb + 1);
      }
    };
    for (const u of this.units.values()) if (!u.dead) stamp(this.vis.get(this.players[u.o].team), u.x, u.y, u.def.sight);
    for (const b of this.buildings.values()) if (!b.dead) stamp(this.vis.get(this.players[b.o].team), b.x + b.size / 2, b.y + b.size / 2, b.def.sight + b.size / 2);
    this.computeTrueSight();
  }

  // ---------- Pillanatkép ----------
  unitFull(u) {
    return {
      i: u.id, o: u.o, k: u.k, x: r2(u.x), y: r2(u.y), tx: r2(u.tx), ty: r2(u.ty), v: r2(u.v), hp: Math.max(1, Math.round(u.hp)), st: u.st,
      c: Math.floor(u.c), ct: u.ct || null, tg: u.order && u.order.target ? u.order.target : (u.order && u.order.node ? u.order.node : null)
    };
  }

  // A néző szemszögéből: az álcázott kém civilnek látszik (k: 'civilian', o: -1), a dézsmálás állapota rejtve
  unitFor(u, team, spectator) {
    const full = this.unitFull(u);
    if (!spectator && this.disguisedTo(team, u)) {
      full.k = 'civilian'; full.o = -1;
      if (full.st === 'siphon') full.st = 'idle';
      full.tg = null; full.c = 0; full.ct = null; // a célpont és a rakomány is leleplezné
    }
    return full;
  }

  buildingFull(b) {
    return { i: b.id, o: b.o, k: b.k, x: b.x, y: b.y, hp: Math.max(1, Math.round(b.hp)), bp: b.bpShown, q: b.qCache, ra: b.ra };
  }

  resView(p) {
    return {
      iron: Math.floor(p.res.iron), copper: Math.floor(p.res.copper), food: Math.floor(p.res.food), wood: Math.floor(p.res.wood),
      pop: p.pop, popCap: p.popCap, epoch: p.epoch, research: p.research ? { epoch: p.research.epoch, pct: p.researchPct } : null
    };
  }

  snapshot(idx) {
    const me = this.players[idx];
    const spec = !!me.spectator;
    const units = [];
    const buildings = [];
    for (const u of this.units.values()) if (!u.dead && (spec || this.players[u.o].team === me.team || this.teamVisible(me.team, u))) units.push(this.unitFor(u, me.team, spec));
    for (const b of this.buildings.values()) if (!b.dead && (spec || this.players[b.o].team === me.team || this.teamVisible(me.team, b))) buildings.push(this.buildingFull(b));
    const snap = {
      roomId: null, status: this.status, tick: this.tick, tickHz: TICK_HZ, you: { idx, team: me.team, spectator: spec },
      players: this.players.map((p) => ({ idx: p.idx, name: p.name, team: p.team, color: p.color, isAi: p.isAi, alive: p.alive, connected: p.connected, epoch: p.epoch, spectator: !!p.spectator })),
      map: this.map,
      nodes: [...this.nodes.values()].map((n) => ({ i: n.id, k: n.k, x: n.x, y: n.y, a: Math.ceil(n.a) })),
      units, buildings, res: this.resView(me), paused: this.paused, spy: this.spyReport(idx)
    };
    if (spec) snap.sv = this.spectatorSummary();
    return snap;
  }
}

// ---------- Parancs-kezelők ----------
const COMMANDS = new Map();

function formation(units, tx, ty) {
  const side = Math.ceil(Math.sqrt(units.length));
  return units.map((u, i) => ({ u, x: tx + ((i % side) - (side - 1) / 2) * 0.9, y: ty + (Math.floor(i / side) - (side - 1) / 2) * 0.9 }));
}

COMMANDS.set('move', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  const t = m.parsePoint(c.target);
  if (!t) return fail('Érvénytelen célpont.');
  for (const f of formation(r.units, t.x, t.y)) {
    const x = Math.min(m.w - 0.5, Math.max(0.5, f.x));
    const y = Math.min(m.h - 0.5, Math.max(0.5, f.y));
    let fx = x;
    let fy = y;
    if (!m.pf.isFree(Math.floor(x), Math.floor(y))) {
      const near = m.pf.nearestFree(x, y, 6);
      if (near) { fx = near[0] + 0.5; fy = near[1] + 0.5; } else { fx = t.x; fy = t.y; }
    }
    m.setOrder(f.u, { type: 'move', x: fx, y: fy });
  }
  return OK;
});

COMMANDS.set('stop', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  for (const u of r.units) { m.setOrder(u, null); m.stopUnit(u); }
  return OK;
});

COMMANDS.set('attack', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  const id = m.parseEntityId(c.target);
  const t = id === null ? null : m.entity(id);
  if (!t || t.dead || m.players[t.o].team === p.team || !m.teamVisible(p.team, t) || m.disguisedTo(p.team, t)) return fail('Érvénytelen célpont.');
  const siphon = t.size && SIPHON_TARGETS.has(t.k);
  // A kém támadási parancsa MÉH telepre vagy Vajda Házára dézsmálássá alakul
  for (const u of r.units) m.setOrder(u, siphon && u.def.siphon ? { type: 'siphon', target: t.id, t: 0 } : { type: 'attack', target: t.id });
  return OK;
});

COMMANDS.set('siphon', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  const id = m.parseEntityId(c.target);
  const t = id === null ? null : m.buildings.get(id);
  if (!t || t.dead || m.players[t.o].team === p.team || !SIPHON_TARGETS.has(t.k) || !m.teamVisible(p.team, t)) return fail('Érvénytelen célpont.');
  const spies = r.units.filter((u) => u.def.siphon);
  if (!spies.length) return fail('Csak a Vándor Kém tud dézsmálni.');
  for (const u of spies) m.setOrder(u, { type: 'siphon', target: t.id, t: 0 });
  return OK;
});

COMMANDS.set('demolish', (m, p, c) => {
  const b = m.ownBuilding(p, c.buildingId);
  if (!b) return fail('Érvénytelen épület.');
  const refund = m.demolishRefund(b);
  m.refund(p, refund);
  const cx = b.x + b.size / 2;
  const cy = b.y + b.size / 2;
  m.eventSoon({ e: 'demolish', i: b.id, k: b.k, x: b.x, y: b.y, size: b.size }, { pos: [[cx, cy]] });
  b.dead = true;
  m.eventSoon({ e: 'dead', i: b.id, x: r1(cx), y: r1(cy) }, { pos: [[cx, cy]] });
  m.recomputePopCap(p);
  return { ok: true, refund };
});

COMMANDS.set('gather', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  const id = isObj(c.target) && isInt(c.target.nodeId) ? c.target.nodeId : null;
  const n = id === null ? null : m.nodes.get(id);
  if (!n || n.a <= 0) return fail('Érvénytelen nyersanyag-lelőhely.');
  const workers = r.units.filter((u) => u.def.capacity);
  if (!workers.length) return fail('Csak a Vasgyűjtők tudnak gyűjteni.');
  for (const u of workers) {
    if (u.ct && u.ct !== n.k) u.c = 0;
    m.setOrder(u, { type: 'gather', node: n.id, phase: 'toNode', drop: null });
  }
  return OK;
});

COMMANDS.set('build', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  if (!C.isBuildingId(c.building)) return fail('Ismeretlen épülettípus.');
  const def = BUILDINGS[c.building];
  const t = m.parsePoint(c.target);
  if (!t) return fail('Érvénytelen építési hely.');
  const builders = r.units.filter((u) => u.def.builds);
  if (!builders.length) return fail('Csak az Építő Mesterek tudnak építeni.');
  if (def.epoch > p.epoch) return fail('Ehhez egy későbbi korszak kell.');
  const x = Math.floor(t.x);
  const y = Math.floor(t.y);
  const bad = m.checkPlacement(x, y, def.size);
  if (bad) return fail(bad);
  if (!m.canAfford(p, def.cost)) return fail('Nincs elég nyersanyag.');
  m.pay(p, def.cost);
  const b = m.placeBuilding(p.idx, c.building, x, y, false);
  m.afterPlacement(b);
  for (const u of builders) m.setOrder(u, { type: 'build', target: b.id });
  return { ok: true, buildingId: b.id };
});

COMMANDS.set('repair', (m, p, c) => {
  const r = m.parseUnits(p, c);
  if (r.error) return fail(r.error);
  const id = m.parseEntityId(c.target);
  const b = id === null ? null : m.ownBuilding(p, id);
  if (!b) return fail('Érvénytelen épület.');
  const builders = r.units.filter((u) => u.def.builds);
  if (!builders.length) return fail('Csak az Építő Mesterek tudnak javítani.');
  for (const u of builders) m.setOrder(u, { type: 'build', target: b.id });
  return OK;
});

COMMANDS.set('train', (m, p, c) => {
  const b = m.ownBuilding(p, c.buildingId);
  if (!b || !b.complete) return fail('Érvénytelen épület.');
  if (!C.isUnitId(c.unit)) return fail('Ismeretlen egységtípus.');
  const def = UNITS[c.unit];
  if (!b.def.trains || !b.def.trains.includes(c.unit)) return fail('Ez az épület nem képezi ezt az egységet.');
  if (def.epoch > p.epoch) return fail('Ehhez egy későbbi korszak kell.');
  if (b.q.length >= MAX_QUEUE) return fail('Tele van a sor.');
  if (p.pop >= p.popCap) return fail('Elfogyott a lakóhely.');
  if (def.hero) {
    let n = 0;
    for (const u of m.units.values()) if (!u.dead && u.o === p.idx && u.k === c.unit) n++;
    for (const bb of m.buildings.values()) if (bb.o === p.idx) for (const i of bb.q) if (i.u === c.unit) n++;
    if (n > 0) return fail('Vajdából csak egy lehet.');
  }
  if (!m.canAfford(p, def.cost)) return fail('Nincs elég nyersanyag.');
  m.pay(p, def.cost);
  p.pop++;
  b.q.push({ u: c.unit, t: 0, total: def.buildTime * TICK_HZ });
  m.touchQueue(b);
  return OK;
});

COMMANDS.set('cancel-train', (m, p, c) => {
  const b = m.ownBuilding(p, c.buildingId);
  if (!b) return fail('Érvénytelen épület.');
  if (!isInt(c.index) || c.index < 0 || c.index >= b.q.length) return fail('Érvénytelen sorszám.');
  const [item] = b.q.splice(c.index, 1);
  m.refund(p, UNITS[item.u].cost);
  p.pop = Math.max(0, p.pop - 1);
  m.touchQueue(b);
  return OK;
});

COMMANDS.set('advance-epoch', (m, p) => {
  if (p.research) return fail('Már folyik egy korszakváltás.');
  if (p.epoch >= EPOCHS.length) return fail('Már a legmagasabb korszakban vagy.');
  let hasTc = false;
  for (const b of m.buildings.values()) if (!b.dead && b.o === p.idx && b.k === 'townCenter' && b.complete) { hasTc = true; break; }
  if (!hasTc) return fail('Korszakváltáshoz Vajda Háza kell.');
  const next = EPOCHS[p.epoch];
  if (!m.canAfford(p, next.cost)) return fail('Nincs elég nyersanyag.');
  m.pay(p, next.cost);
  p.research = { epoch: next.id, left: next.researchTime * TICK_HZ, total: next.researchTime * TICK_HZ };
  p.researchPct = 0;
  return OK;
});

COMMANDS.set('set-rally', (m, p, c) => {
  const b = m.ownBuilding(p, c.buildingId);
  if (!b) return fail('Érvénytelen épület.');
  const t = m.parsePoint(c.target);
  if (!t) return fail('Érvénytelen célpont.');
  b.ra = [r2(t.x), r2(t.y)];
  b.qVer++;
  return OK;
});

COMMANDS.set('ping', (m, p, c) => {
  const t = m.parsePoint(c.target);
  if (!t) return fail('Érvénytelen célpont.');
  if (m.tick - (m.pingCd.get(p.idx) ?? -99) < 10) return fail('Lassabban pingelj.');
  m.pingCd.set(p.idx, m.tick);
  m.eventSoon({ e: 'ping', x: r2(t.x), y: r2(t.y), o: p.idx }, { team: p.team });
  return OK;
});

module.exports = { EmpireMatch, GATHER_RATE, START_RES, buildMult, SPECTATOR_ERROR };
