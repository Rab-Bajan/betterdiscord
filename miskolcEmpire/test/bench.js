// Mérés: node miskolcEmpire/test/bench.js
// 1) 2 játékos x 60 mozgó és harcoló egység: az empire:tick sávszélessége kliensenként
// 2) 4 játékos x 100 egység: step() ideje
const { EmpireMatch } = require('../simulation');
const { createView, resetView, buildTick } = require('../view');

const OVERHEAD = Buffer.byteLength('42["empire:tick",]'); // Socket.IO csomagkeret
const KINDS = ['knife', 'slingshot', 'brawler', 'airgunner', 'horseWagon', 'grinder', 'lada', 'ram'];

function fill(m, n, perPlayer, spread) {
  const centre = [m.w / 2, m.h / 2];
  for (const p of m.players) {
    const have = [...m.units.values()].filter((u) => u.o === p.idx && u.def.class !== 'worker' && u.k !== 'builder').length;
    for (let i = have; i < perPlayer; i++) {
      const tc = [...m.buildings.values()].find((b) => b.o === p.idx);
      const a = (i / perPlayer) * Math.PI * 2;
      const u = m.createUnit(p.idx, KINDS[i % KINDS.length], tc.x + 1.5 + Math.cos(a) * 3, tc.y + 1.5 + Math.sin(a) * 3);
      if (!m.pf.isFree(Math.floor(u.x), Math.floor(u.y))) { const f = m.pf.nearestFree(u.x, u.y, 6); u.x = f[0] + 0.5; u.y = f[1] + 0.5; }
      p.pop++;
      m.setOrder(u, { type: 'move', x: centre[0] + (Math.random() - 0.5) * spread, y: centre[1] + (Math.random() - 0.5) * spread });
    }
  }
}

// Determinisztikus "véletlen" a mérés ismételhetőségéért
let seed = 12345;
Math.random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function bandwidth() {
  const m = new EmpireMatch({ seed: 5, players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }] });
  for (const p of m.players) for (let i = 0; i < 5; i++) { /* a kezdő gyűjtők a bázison gyűjtenek */ }
  for (const p of m.players) {
    const nodes = [...m.nodes.values()];
    for (const u of [...m.units.values()].filter((x) => x.o === p.idx && x.k === 'scavenger')) {
      const n = nodes.filter((q) => q.k === 'wood').sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
      m.command(p.idx, { type: 'gather', unitIds: [u.id], target: { nodeId: n.id } });
    }
  }
  const views = m.players.map((p) => { const v = createView(); resetView(m, p.idx, v, m.snapshot(p.idx)); return v; });
  const TICKS = 3000;
  const bytes = [0, 0];
  const msgs = [0, 0];
  const perSecond = [[], []];
  let sec = [0, 0];
  let peak = [0, 0];
  let alive = [];
  for (let t = 1; t <= TICKS; t++) {
    if (t % 10 === 1) fill(m, 0, 60, 8);
    // újracélzás: a tétlen egységek támadják a legközelebbi látható ellenséget (mint egy játékos)
    if (t % 15 === 0) {
      for (const p of m.players) {
        const foes = [...m.units.values()].filter((e) => e.o !== p.idx && m.teamVisible(p.team, e));
        const mine = [...m.units.values()].filter((u) => u.o === p.idx && !u.order && u.def.class !== 'worker' && u.k !== 'builder');
        for (const u of mine) {
          const f = foes.sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
          if (f) m.command(p.idx, { type: 'attack', unitIds: [u.id], target: { entityId: f.id } });
          else m.command(p.idx, { type: 'move', unitIds: [u.id], target: { x: m.w / 2 + (Math.random() - 0.5) * 20, y: m.h / 2 + (Math.random() - 0.5) * 20 } });
        }
      }
    }
    m.step();
    for (let i = 0; i < 2; i++) {
      const tk = buildTick(m, i, views[i]);
      if (tk) { const n = Buffer.byteLength(JSON.stringify(tk)) + OVERHEAD; bytes[i] += n; msgs[i]++; sec[i] += n; }
    }
    if (t % 10 === 0) { for (let i = 0; i < 2; i++) { perSecond[i].push(sec[i]); peak[i] = Math.max(peak[i], sec[i]); sec[i] = 0; } }
    if (t % 600 === 0) alive.push(`${t}:${[...m.units.values()].filter((u) => u.def.class !== 'worker').length}`);
    if (m.status !== 'playing') break;
  }
  const secs = TICKS / 10;
  const kills = m.players.map((p) => p.stats.unitsKilled);
  return {
    seconds: secs, avgBytesPerSec: bytes.map((b) => Math.round(b / secs)), peakBytesPerSec: peak, ticksSentPerSec: msgs.map((n) => +(n / secs).toFixed(2)),
    avgBytesPerMsg: bytes.map((b, i) => Math.round(b / msgs[i])), kills, combatUnitsAt: alive.join(' '), status: m.status
  };
}

function stepTime() {
  const m = new EmpireMatch({ seed: 8, players: [0, 1, 2, 3].map((i) => ({ name: `P${i}`, team: i })) });
  fill(m, 0, 100, 40);
  const views = m.players.map((p) => { const v = createView(); resetView(m, p.idx, v, m.snapshot(p.idx)); return v; });
  for (const p of m.players) m.players[p.idx].res = { iron: 9999, copper: 9999, food: 9999, wood: 9999 };
  const steps = [];
  const ticks = [];
  for (let t = 1; t <= 2500 && m.status === 'playing'; t++) {
    if (t % 10 === 1) fill(m, 0, 100, 40);
    if (t % 15 === 0) {
      for (const p of m.players) {
        const foes = [...m.units.values()].filter((e) => !e.dead && m.players[e.o].team !== p.team && m.teamVisible(p.team, e));
        const mine = [...m.units.values()].filter((u) => u.o === p.idx && !u.order && u.def.class !== 'worker' && u.k !== 'builder');
        for (const u of mine) {
          const f = foes[(u.id * 7) % Math.max(1, foes.length)];
          if (f) m.command(p.idx, { type: 'attack', unitIds: [u.id], target: { entityId: f.id } });
          else m.command(p.idx, { type: 'move', unitIds: [u.id], target: { x: 4 + Math.random() * (m.w - 8), y: 4 + Math.random() * (m.h - 8) } });
        }
      }
    }
    const t0 = process.hrtime.bigint();
    m.step();
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < 4; i++) buildTick(m, i, views[i]);
    const t2 = process.hrtime.bigint();
    steps.push(Number(t1 - t0) / 1e6);
    ticks.push(Number(t2 - t1) / 1e6);
  }
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { avg: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), p99: +s[Math.floor(s.length * 0.99)].toFixed(3), worst: +s[s.length - 1].toFixed(3) }; };
  const units = m.units.size;
  return { ticksMeasured: steps.length, unitsAtEnd: units, stepMs: stat(steps), buildTickAllPlayersMs: stat(ticks), status: m.status };
}

console.log('SÁVSZÉLESSÉG (2 játékos x 60 egység, mozog és harcol, JSON bájt + keret):');
console.log(JSON.stringify(bandwidth(), null, 1));
console.log('LÉPÉSIDŐ (4 játékos x 100 egység):');
console.log(JSON.stringify(stepTime(), null, 1));
