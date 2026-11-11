// Szabályalapú MI. Ugyanazt a parancs-útvonalat használja, mint az emberi játékos (match.command).
const { BUILDINGS, UNITS, EPOCHS, MAX_UNIT_IDS } = require('./content');

const PARAMS = {
  easy: { every: 30, scavengers: 9, builders: 2, wave: 18, maxEpoch: 3, towers: 0, extraProd: 0, houseBuffer: 3 },
  medium: { every: 15, scavengers: 13, builders: 2, wave: 17, maxEpoch: 4, towers: 1, extraProd: 1, houseBuffer: 4 },
  hard: { every: 6, scavengers: 13, builders: 2, wave: 12, maxEpoch: 5, towers: 2, extraProd: 2, houseBuffer: 5 }
};
const GATHER_WEIGHT = { food: 1.6, wood: 1.1, iron: 0.6, copper: 0.4 };

class AiController {
  constructor(match, idx, difficulty) {
    this.m = match;
    this.idx = idx;
    this.params = PARAMS[difficulty] || PARAMS.medium;
    this.attacking = false;
    this.offset = idx % this.params.every;
  }

  think(tick) {
    if ((tick + this.offset) % this.params.every !== 0) return;
    const m = this.m;
    const me = m.players[this.idx];
    if (!me.alive) return;
    const mine = { workers: [], builders: [], army: [], hero: false };
    for (const u of m.units.values()) {
      if (u.dead || u.o !== this.idx) continue;
      if (u.k === 'scavenger') mine.workers.push(u);
      else if (u.k === 'builder') mine.builders.push(u);
      else { mine.army.push(u); if (u.def.hero) mine.hero = true; }
    }
    const blds = { all: [], done: new Map(), count: new Map(), tc: null };
    for (const b of m.buildings.values()) {
      if (b.dead || b.o !== this.idx) continue;
      blds.all.push(b);
      blds.count.set(b.k, (blds.count.get(b.k) || 0) + 1);
      if (b.complete) { if (!blds.done.has(b.k)) blds.done.set(b.k, []); blds.done.get(b.k).push(b); }
    }
    blds.tc = (blds.done.get('townCenter') || [])[0] || null;
    this.economy(me, mine, blds);
    this.construction(me, mine, blds);
    this.production(me, mine, blds);
    this.epoch(me, mine, blds);
    this.military(me, mine, blds);
  }

  cmd(c) { return this.m.command(this.idx, c); }

  economy(me, mine, blds) {
    const m = this.m;
    // Eloszlás a jelenlegi gyűjtők szerint
    const counts = { food: 0, wood: 0, iron: 0, copper: 0 };
    for (const u of mine.workers) if (u.order && u.order.type === 'gather') { const n = m.nodes.get(u.order.node); if (n) counts[n.k]++; }
    const idle = mine.workers.filter((u) => !u.order);
    const byNode = new Map();
    for (const u of idle) {
      // Azt gyűjtjük, amiből a legkevesebb van (a már úton lévő gyűjtőket is beszámítva)
      let kind = 'food';
      let best = Infinity;
      for (const k of Object.keys(GATHER_WEIGHT)) {
        const score = (me.res[k] + counts[k] * 60) / GATHER_WEIGHT[k];
        if (score < best) { best = score; kind = k; }
      }
      const home = blds.tc || { x: u.x, y: u.y, size: 0 };
      const node = m.findNode(kind, home.x + home.size / 2, home.y + home.size / 2, 60) || m.findNode(kind, u.x, u.y, 200);
      if (!node) continue;
      counts[kind]++;
      if (!byNode.has(node.id)) byNode.set(node.id, []);
      byNode.get(node.id).push(u.id);
    }
    for (const [nodeId, ids] of byNode) this.cmd({ type: 'gather', unitIds: ids, target: { nodeId } });
  }

  freeSite(blds, size) {
    const m = this.m;
    const tc = blds.tc || blds.all[0];
    if (!tc) return null;
    const cx = tc.x + tc.size / 2;
    const cy = tc.y + tc.size / 2;
    const dir = [cx < m.w / 2 ? 1 : -1, cy < m.h / 2 ? 1 : -1];
    for (let r = 4; r < 20; r++) {
      for (let k = 0; k < 16; k++) {
        const ang = ((k + (r % 2) * 0.5) / 16) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r * (dir[0] > 0 ? 1 : 1) - size / 2);
        const y = Math.round(cy + Math.sin(ang) * r - size / 2);
        if (!m.checkPlacement(x, y, size) && this.roomAround(x, y, size)) return [x, y];
      }
    }
    return null;
  }

  // Hagyjon járható rést az épületek körül
  roomAround(x, y, size) {
    const m = this.m;
    for (let yy = y - 1; yy <= y + size; yy++) for (let xx = x - 1; xx <= x + size; xx++) {
      if (xx < 0 || yy < 0 || xx >= m.w || yy >= m.h) return false;
      if (m.blocked[yy * m.w + xx] && !(xx >= x && xx < x + size && yy >= y && yy < y + size)) {
        // szomszédos épület: csak a saját élére engedünk 1 mezőnyi hézagot
        if (xx === x - 1 || xx === x + size || yy === y - 1 || yy === y + size) return false;
      }
    }
    return true;
  }

  tryBuild(me, mine, blds, type) {
    const def = BUILDINGS[type];
    if (def.epoch > me.epoch || !this.m.canAfford(me, def.cost)) return false;
    const builders = mine.builders.filter((u) => !u.order || (u.order.type !== 'build'));
    if (!builders.length) return false;
    const site = this.freeSite(blds, def.size);
    if (!site) return false;
    const builder = builders[0];
    const r = this.cmd({ type: 'build', unitIds: [builder.id], building: type, target: { x: site[0], y: site[1] } });
    if (r.ok) { blds.count.set(type, (blds.count.get(type) || 0) + 1); builder.order = builder.order || {}; return true; }
    return false;
  }

  // Kész viskó fejlesztése (egy egyszerre); a szabad építő besegít
  tryUpgrade(me, mine, blds, type) {
    if (blds.all.some((b) => b.k === type && b.up)) return false;
    for (const b of blds.all) {
      if (b.k !== type || !b.complete) continue;
      const next = this.m.nextUpgrade(b);
      if (!next || (next.epoch || 1) > me.epoch || !this.m.canAfford(me, next.cost)) continue;
      const free = mine.builders.find((u) => !u.order);
      return this.cmd({ type: 'upgrade', buildingId: b.id, ...(free ? { unitIds: [free.id] } : {}) }).ok;
    }
    return false;
  }

  construction(me, mine, blds) {
    const p = this.params;
    // Befejezetlen épületek folytatása
    const unfinished = blds.all.filter((b) => !b.complete);
    for (const b of unfinished) {
      const working = mine.builders.some((u) => u.order && u.order.type === 'build' && u.order.target === b.id);
      const free = mine.builders.find((u) => !u.order);
      if (!working && free) this.cmd({ type: 'repair', unitIds: [free.id], target: { entityId: b.id } });
    }
    const has = (t) => blds.count.get(t) || 0;
    const queued = blds.all.reduce((n, b) => n + b.q.length, 0);
    const houseNeeded = me.popCap < 100 && me.pop + queued * 0 >= me.popCap - p.houseBuffer && !unfinished.some((b) => b.k === 'house');
    // sok viskó mellett inkább fejleszt, különben épít, és ha építeni nem tud, fejleszt
    if (houseNeeded && has('house') >= 3 && this.tryUpgrade(me, mine, blds, 'house')) return;
    if (houseNeeded && this.tryBuild(me, mine, blds, 'house')) return;
    if (houseNeeded && this.tryUpgrade(me, mine, blds, 'house')) return;
    if (me.popCap - me.pop <= p.houseBuffer + 2 && has('house') === 0 && this.tryBuild(me, mine, blds, 'house')) return;
    if (mine.workers.length >= 8 && me.res.wood >= 160 && has('scrapYard') < 1 && this.tryBuild(me, mine, blds, 'scrapYard')) return;
    if (has('barracks') < 1 && this.tryBuild(me, mine, blds, 'barracks')) return;
    if (has('tavern') < 1 && this.tryBuild(me, mine, blds, 'tavern')) return;
    const rich = me.res.wood >= 250 && me.res.food >= 120 && mine.army.length >= 6;
    if (has('workshop') < 1 && me.epoch >= 2 && mine.army.length >= 6 && this.tryBuild(me, mine, blds, 'workshop')) return;
    if (!rich) return;
    if (p.extraProd >= 1 && has('barracks') < 2 && this.tryBuild(me, mine, blds, 'barracks')) return;
    if (has('tower') < p.towers && me.epoch >= 2 && this.tryBuild(me, mine, blds, 'tower')) return;
    if (p.extraProd >= 2 && has('tavern') < 2 && this.tryBuild(me, mine, blds, 'tavern')) return;
    if (p.extraProd >= 2 && has('workshop') < 2 && me.epoch >= 3 && this.tryBuild(me, mine, blds, 'workshop')) return;
    if (me.popCap < 100 && me.popCap - me.pop <= 12 && !unfinished.some((b) => b.k === 'house')) this.tryBuild(me, mine, blds, 'house');
  }

  train(me, b, unit) {
    const def = UNITS[unit];
    if (def.epoch > me.epoch || !this.m.canAfford(me, def.cost)) return false;
    return this.cmd({ type: 'train', buildingId: b.id, unit }).ok;
  }

  production(me, mine, blds) {
    const p = this.params;
    const tc = blds.tc;
    if (tc && tc.q.length < 2) {
      const builders = mine.builders.length + tc.q.filter((i) => i.u === 'builder').length;
      const workers = mine.workers.length + tc.q.filter((i) => i.u === 'scavenger').length;
      if (builders < p.builders) this.train(me, tc, 'builder');
      else if (workers < Math.min(p.scavengers, 9 + mine.army.length)) this.train(me, tc, 'scavenger');
      else if (!mine.hero && me.epoch >= 3 && p !== PARAMS.easy && !tc.q.some((i) => i.u === 'elder')) this.train(me, tc, 'elder');
    }
    const list = (k) => blds.done.get(k) || [];
    const mix = this.m.tick;
    for (const b of list('barracks')) if (b.q.length < 2) this.train(me, b, me.epoch >= 2 && (mix + b.id) % 3 !== 0 ? 'airgunner' : 'slingshot');
    for (const b of list('tavern')) {
      if (b.q.length >= 2) continue;
      // Az asszony csak réztartalékból jön, hogy a korszakváltásra is maradjon
      if ((mix + b.id) % 4 === 0 && me.res.copper >= 250 && this.train(me, b, 'ciganyAsszony')) continue;
      this.train(me, b, me.epoch >= 2 && (mix + b.id) % 2 === 0 ? 'brawler' : 'knife');
    }
    for (const b of list('workshop')) {
      if (b.q.length >= 2) continue;
      const roll = (mix / this.params.every + b.id) % 5 | 0;
      const pick = roll === 0 ? 'ram' : roll === 1 ? 'grinder' : me.epoch >= 4 ? 'lada' : 'horseWagon';
      if (!this.train(me, b, pick)) this.train(me, b, me.epoch >= 3 ? 'grinder' : 'horseWagon');
    }
  }

  epoch(me, mine) {
    const p = this.params;
    if (me.research || me.epoch >= Math.min(5, p.maxEpoch) || mine.army.length < 8 + me.epoch * 4) return;
    const next = EPOCHS[me.epoch];
    if (this.m.canAfford(me, next.cost)) this.cmd({ type: 'advance-epoch' });
  }

  military(me, mine, blds) {
    const m = this.m;
    const army = mine.army.filter((u) => u.def.class !== 'worker');
    if (!army.length) { this.attacking = false; return; }
    const p = this.params;
    const tc = blds.tc || blds.all[0];
    if (!tc) return;
    const rally = { x: Math.min(m.w - 2, Math.max(2, (tc.x + tc.size / 2) + (tc.x < m.w / 2 ? 6 : -6))), y: Math.min(m.h - 2, Math.max(2, (tc.y + tc.size / 2) + (tc.y < m.h / 2 ? 6 : -6))) };
    const gathered = army.filter((u) => Math.hypot(u.x - rally.x, u.y - rally.y) < 9).length;
    if (!this.attacking && army.length >= p.wave && gathered >= army.length * 0.7) this.attacking = true;
    if (this.attacking && army.length < Math.ceil(p.wave / 3)) this.attacking = false;

    // Védelem: ha ellenség van a bázis közelében, az egész sereg odamegy
    const cx = tc.x + tc.size / 2;
    const cy = tc.y + tc.size / 2;
    const threat = m.nearestEnemyUnit(me.team, cx, cy, 16, true);
    const free = (u) => !u.order || u.order.type === 'move' || u.order.auto;
    const idleArmy = army.filter((u) => !u.order);
    if (threat && !this.attacking) {
      this.send(army.filter(free), { type: 'attack', target: { entityId: threat.id } });
      return;
    }
    if (!this.attacking) {
      // Gyülekező a bázis előtt
      const far = idleArmy.filter((u) => Math.hypot(u.x - rally.x, u.y - rally.y) > 6);
      this.send(far, { type: 'move', target: rally });
      return;
    }
    // Támadás: a legközelebbi látható ellenséges egység vagy épület, különben az ellenséges bázis
    let gx = 0;
    let gy = 0;
    for (const u of army) { gx += u.x; gy += u.y; }
    gx /= army.length; gy /= army.length;
    let target = null;
    let bd = Infinity;
    const consider = (e, cxx, cyy, bias) => {
      if (e.dead || m.players[e.o].team === me.team || !m.teamVisible(me.team, e) || m.disguisedTo(me.team, e)) return;
      const d = Math.hypot(cxx - gx, cyy - gy) + bias;
      if (d < bd) { bd = d; target = e; }
    };
    for (const e of m.units.values()) consider(e, e.x, e.y, e.def.class === 'worker' ? 4 : 0);
    for (const e of m.buildings.values()) consider(e, e.x + e.size / 2, e.y + e.size / 2, e.def.barricade ? 12 : 2);
    if (target) {
      this.send(army.filter((u) => free(u) && !(u.order && u.order.target === target.id)), { type: 'attack', target: { entityId: target.id } });
    } else {
      let enemy = null;
      let ed = Infinity;
      for (const q of m.players) {
        if (!q.alive || q.team === me.team) continue;
        const d = Math.hypot(q.startPos[0] - gx, q.startPos[1] - gy);
        if (d < ed) { ed = d; enemy = q; }
      }
      if (enemy) this.send(army.filter((u) => !u.order), { type: 'move', target: { x: enemy.startPos[0] + 1.5, y: enemy.startPos[1] + 1.5 } });
    }
  }

  send(units, base) {
    for (let i = 0; i < units.length; i += MAX_UNIT_IDS) {
      const ids = units.slice(i, i + MAX_UNIT_IDS).map((u) => u.id);
      if (ids.length) this.cmd({ ...base, unitIds: ids });
    }
  }
}

function createAi(match, idx, difficulty) { return new AiController(match, idx, difficulty); }

module.exports = { AiController, createAi, PARAMS };
