// Játékosonkénti delta-kódolás és látótér-szűrés. Az ellenséges entitás csak akkor kerül egy játékos tickjébe,
// ha a csapata látóterében van.
const { TICK_HZ } = require('./content');

const r2 = (v) => Math.round(v * 100) / 100;
const HP_EVERY = 5; // az életerő frissítése legfeljebb 2 Hz
const ST_EVERY = 5; // az állapot és a célpont frissítése legfeljebb 2 Hz
const SEG_EPS = 0.4;
const NODE_EVERY = 5;
const R_EVERY = 5;

function createView() {
  return { known: new Map(), nodes: new Map(), rSig: '', rTick: -99, pSig: '', lastSend: -99 };
}

const pausedSig = (p) => (p ? `${p.reason}|${p.untilMs}` : '');

// Kezdőállapot egy snapshot után: ami benne volt, azt a kliens ismeri
function resetView(match, idx, view, snapshot) {
  view.known.clear();
  view.nodes.clear();
  const tick = match.tick;
  for (const u of snapshot.units) {
    const e = match.units.get(u.i);
    view.known.set(u.i, unitRec(e, u, tick));
  }
  for (const b of snapshot.buildings) {
    const e = match.buildings.get(b.i);
    view.known.set(b.i, { seen: tick, hp: b.hp, hpT: tick, bp: b.bp, qVer: e.qVer, raVer: e.qVer });
  }
  for (const n of snapshot.nodes) view.nodes.set(n.i, { a: n.a, t: tick });
  view.rSig = JSON.stringify(snapshot.res);
  view.rTick = tick;
  view.pSig = pausedSig(snapshot.paused);
  view.lastSend = tick;
}

function unitRec(e, full, tick) {
  return {
    seen: tick, hp: full.hp, hpT: tick, st: full.st, c: full.c, ct: full.ct, tg: full.tg,
    sx: full.x, sy: full.y, stx: full.tx, sty: full.ty, sv: full.v, sT: tick, stT: tick
  };
}

function predicted(rec, tick) {
  const dist = (rec.sv * (tick - rec.sT)) / TICK_HZ;
  const dx = rec.stx - rec.sx;
  const dy = rec.sty - rec.sy;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6 || dist >= len) return [rec.stx, rec.sty];
  return [rec.sx + (dx / len) * dist, rec.sy + (dy / len) * dist];
}

function eventVisible(match, ev, p) {
  const v = ev.vis;
  if (v.all) return true;
  if (v.team !== undefined) return v.team === p.team;
  if (v.owner !== undefined) return v.owner === p.idx;
  if (v.pos) return v.pos.some(([x, y]) => match.tileVisible(p.team, x, y));
  return false;
}

// A játékos következő tickje, vagy null, ha nincs mit küldeni
function buildTick(match, idx, view) {
  const p = match.players[idx];
  const team = p.team;
  const tick = match.tick;
  const out = { t: tick };
  let any = false;
  const us = [];
  const bs = [];
  const xs = [];
  const known = view.known;

  for (const u of match.units.values()) {
    if (u.dead) continue;
    if (match.players[u.o].team !== team && !match.teamVisible(team, u)) continue;
    const rec = known.get(u.id);
    const full = match.unitFull(u);
    if (!rec) {
      us.push(full);
      known.set(u.id, unitRec(u, full, tick));
      continue;
    }
    rec.seen = tick;
    let d = null;
    const [px, py] = predicted(rec, tick);
    if (Math.abs(full.v - rec.sv) > 0.01 || Math.abs(full.tx - rec.stx) > SEG_EPS || Math.abs(full.ty - rec.sty) > SEG_EPS || Math.hypot(px - full.x, py - full.y) > 0.5) {
      d = { i: u.id, x: full.x, y: full.y, tx: full.tx, ty: full.ty, v: full.v };
      rec.sx = full.x; rec.sy = full.y; rec.stx = full.tx; rec.sty = full.ty; rec.sv = full.v; rec.sT = tick;
    }
    if (full.hp !== rec.hp && tick - rec.hpT >= HP_EVERY) { d = d || { i: u.id }; d.hp = full.hp; rec.hp = full.hp; rec.hpT = tick; }
    if ((full.st !== rec.st || full.tg !== rec.tg) && tick - rec.stT >= ST_EVERY) {
      d = d || { i: u.id };
      if (full.st !== rec.st) { d.st = full.st; rec.st = full.st; }
      if (full.tg !== rec.tg) { d.tg = full.tg; rec.tg = full.tg; }
      rec.stT = tick;
    }
    if (full.c !== rec.c) { d = d || { i: u.id }; d.c = full.c; rec.c = full.c; }
    if (full.ct !== rec.ct) { d = d || { i: u.id }; d.ct = full.ct; rec.ct = full.ct; }
    if (d) us.push(d);
  }

  for (const b of match.buildings.values()) {
    if (b.dead) continue;
    if (match.players[b.o].team !== team && !match.teamVisible(team, b)) continue;
    const rec = known.get(b.id);
    if (!rec) {
      bs.push(match.buildingFull(b));
      known.set(b.id, { seen: tick, hp: Math.max(1, Math.round(b.hp)), hpT: tick, bp: b.bpShown, qVer: b.qVer, raVer: b.raVer });
      continue;
    }
    rec.seen = tick;
    let d = null;
    const hp = Math.max(1, Math.round(b.hp));
    if (hp !== rec.hp && tick - rec.hpT >= HP_EVERY) { d = { i: b.id, hp }; rec.hp = hp; rec.hpT = tick; }
    if (b.bpShown !== rec.bp) { d = d || { i: b.id }; d.bp = b.bpShown; rec.bp = b.bpShown; }
    if (b.qVer !== rec.qVer) { d = d || { i: b.id }; d.q = b.qCache; d.ra = b.ra; rec.qVer = b.qVer; }
    if (d) bs.push(d);
  }

  for (const [id, rec] of known) {
    if (rec.seen !== tick) { xs.push(id); known.delete(id); }
  }

  const ns = [];
  for (const n of match.nodes.values()) {
    const a = Math.ceil(n.a);
    const rec = view.nodes.get(n.id);
    if (rec.a === a || tick - rec.t < NODE_EVERY) continue;
    if (!match.tileVisible(team, n.x, n.y)) continue;
    ns.push([n.id, a]);
    rec.a = a; rec.t = tick;
  }

  const r = match.resView(p);
  const sig = JSON.stringify(r);
  if (sig !== view.rSig && (tick - view.rTick >= R_EVERY || r.epoch !== JSON.parse(view.rSig).epoch)) {
    out.r = r; view.rSig = sig; view.rTick = tick; any = true;
  }
  const ps = pausedSig(match.paused);
  if (ps !== view.pSig) { out.p = match.paused ? { reason: match.paused.reason, untilMs: match.paused.untilMs } : null; view.pSig = ps; any = true; }

  const ev = [];
  for (const e of match.events) if (eventVisible(match, e, p)) ev.push(e.w);

  if (us.length) { out.u = us; any = true; }
  if (bs.length) { out.b = bs; any = true; }
  if (ns.length) { out.n = ns; any = true; }
  if (xs.length) { out.x = xs; any = true; }
  if (ev.length) { out.ev = ev; any = true; }

  if (!any) {
    if (tick - view.lastSend < TICK_HZ) return null;
  }
  view.lastSend = tick;
  return out;
}

module.exports = { createView, resetView, buildTick, r2 };
