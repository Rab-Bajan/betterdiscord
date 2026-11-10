const test = require('node:test');
const assert = require('node:assert');
const C = require('../content');
const { buildMult, SPECTATOR_ERROR } = require('../simulation');
const { createView, resetView, buildTick } = require('../view');
const { makeMatch, stepN, own, ownB, freeSpot } = require('./helpers');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const ffa3 = () => makeMatch({ players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }, { name: 'C', team: 2 }] });

test('építés csökkenő hozadékkal: 1 -> 1, 2 -> 1.7, 3 -> 2.2, utána +0.4', () => {
  near(buildMult(1), 1); near(buildMult(2), 1.7); near(buildMult(3), 2.2); near(buildMult(4), 2.6); near(buildMult(5), 3.0);
  const ticksWith = (n) => {
    const m = makeMatch();
    const [x, y] = freeSpot(m, 0, 2);
    const b = m.placeBuilding(0, 'house', x, y, false);
    const spots = [[x - 0.4, y + 0.5], [x + 0.5, y - 0.4], [x + 2.4, y + 1.5], [x + 1.5, y + 2.4]];
    for (let i = 0; i < n; i++) {
      const u = m.createUnit(0, 'builder', spots[i][0], spots[i][1]);
      assert.strictEqual(m.command(0, { type: 'repair', unitIds: [u.id], target: { entityId: b.id } }).ok, true);
    }
    let t = 0;
    while (!b.complete && t < 1000) { m.step(); t++; }
    return t;
  };
  const base = C.BUILDINGS.house.buildTime * C.TICK_HZ;
  const t1 = ticksWith(1);
  const t2 = ticksWith(2);
  const t3 = ticksWith(3);
  const t4 = ticksWith(4);
  assert.ok(Math.abs(t1 - base) <= 1, `1 építő: ${t1}`);
  assert.ok(Math.abs(t2 - base / 1.7) <= 1, `2 építő: ${t2}`);
  assert.ok(Math.abs(t3 - base / 2.2) <= 1, `3 építő: ${t3}`);
  assert.ok(Math.abs(t4 - base / 2.6) <= 1, `4 építő: ${t4}`);
  // javítás is a szorzóval gyorsul
  const repairGain = (n) => {
    const m = makeMatch();
    const [x, y] = freeSpot(m, 0, 2);
    const b = m.placeBuilding(0, 'house', x, y, true);
    b.hp = 10;
    const spots = [[x - 0.4, y + 0.5], [x + 0.5, y - 0.4]];
    for (let i = 0; i < n; i++) m.command(0, { type: 'repair', unitIds: [m.createUnit(0, 'builder', spots[i][0], spots[i][1]).id], target: { entityId: b.id } });
    stepN(m, 10);
    return b.hp - 10;
  };
  near(repairGain(2) / repairGain(1), 1.7, 1e-6);
});

test('bontás: visszatérítés teljes életerőnél, 30%-nál, befejezetlennél; idegen épület nem bontható', () => {
  const m = makeMatch();
  const p = m.players[0];
  const at = () => freeSpot(m, 0, 2);
  // teljes életerő: 50%
  let [x, y] = at();
  const house = m.placeBuilding(0, 'house', x, y, true);
  m.recomputePopCap(p);
  const cap = p.popCap;
  const wood = p.res.wood;
  const r1 = m.command(0, { type: 'demolish', buildingId: house.id });
  assert.deepStrictEqual(r1, { ok: true, refund: { wood: 30 } });
  assert.strictEqual(p.res.wood, wood + 30);
  assert.strictEqual(p.popCap, cap - 8);
  assert.strictEqual(m.command(0, { type: 'demolish', buildingId: house.id }).ok, false); // már bontva
  // az esemény a következő tickben megy ki: előbb 'demolish', aztán 'dead'
  m.step();
  const evs = m.events.map((e) => e.w).filter((w) => w.i === house.id);
  assert.deepStrictEqual(evs.map((w) => w.e), ['demolish', 'dead']);
  assert.deepStrictEqual(evs[0], { e: 'demolish', i: house.id, k: 'house', x: house.x, y: house.y, size: 2 });
  assert.strictEqual(m.buildings.has(house.id), false);
  assert.strictEqual(m.checkPlacement(house.x, house.y, 2), null, 'a telek felszabadult');
  // 30% életerő: r = 0.35 * 0.6 = 0.21
  [x, y] = at();
  const tower = m.placeBuilding(0, 'tower', x, y, true);
  tower.hp = tower.maxHp * 0.3;
  const r2 = m.command(0, { type: 'demolish', buildingId: tower.id });
  assert.deepStrictEqual(r2.refund, { wood: Math.floor(80 * 0.21), iron: Math.floor(100 * 0.21) });
  // 75% életerő: r = 0.35 + 0.15 * 0.5 = 0.425
  [x, y] = at();
  const bar = m.placeBuilding(0, 'barracks', x, y, true);
  bar.hp = bar.maxHp * 0.75;
  assert.deepStrictEqual(m.command(0, { type: 'demolish', buildingId: bar.id }).refund, { wood: Math.floor(150 * 0.425), iron: Math.floor(50 * 0.425) });
  // befejezetlen, 40%: r = 0.5 * 0.4 = 0.2
  [x, y] = at();
  const tav = m.placeBuilding(0, 'tavern', x, y, false);
  tav.bp = 40; tav.bpF = 40.5;
  assert.deepStrictEqual(m.command(0, { type: 'demolish', buildingId: tav.id }).refund, { wood: 24, iron: 8 });
  // ellenséges épület
  const foe = ownB(m, 1, 'townCenter')[0];
  const bad = m.command(0, { type: 'demolish', buildingId: foe.id });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(foe.dead, false);
  assert.strictEqual(m.command(0, { type: 'demolish', buildingId: '__proto__' }).ok, false);
  // sorban álló egység: a lakóhely felszabadul
  const tc = ownB(m, 0, 'townCenter')[0];
  [x, y] = at();
  m.placeBuilding(0, 'house', x, y, true);
  m.recomputePopCap(p);
  m.command(0, { type: 'train', buildingId: tc.id, unit: 'scavenger' });
  const pop = p.pop;
  [x, y] = at();
  const tv2 = m.placeBuilding(0, 'tavern', x, y, true);
  m.command(0, { type: 'train', buildingId: tv2.id, unit: 'knife' });
  assert.strictEqual(p.pop, pop + 1);
  m.command(0, { type: 'demolish', buildingId: tv2.id });
  m.step();
  assert.strictEqual(p.pop, pop);
});

// Közös helyzet: a 0. játékos gyűjtője (nem célzik automatikusan) a nyílt terepen, mellette az 1. játékos kéme
function spyScene() {
  const m = makeMatch();
  const watcher = m.createUnit(0, 'scavenger', 32, 20);
  const spy = m.createUnit(1, 'infiltrator', 33, 20);
  m.updateVision();
  return { m, watcher, spy };
}

test('kém álcája: az ellenség civilnek látja, nem támadható, a torony leleplezi', () => {
  const { m, watcher, spy } = spyScene();
  assert.ok(m.teamVisible(0, spy));
  assert.strictEqual(m.disguisedTo(0, spy), true);
  assert.strictEqual(m.disguisedTo(1, spy), false);
  const view = createView();
  const snap = m.snapshot(0);
  const inSnap = snap.units.find((u) => u.i === spy.id);
  assert.strictEqual(inSnap.k, 'civilian');
  assert.strictEqual(inSnap.o, -1);
  assert.ok(!JSON.stringify(snap.units).includes('infiltrator'));
  resetView(m, 0, view, snap);
  // a saját csapat a valódi egységet látja
  assert.strictEqual(m.snapshot(1).units.find((u) => u.i === spy.id).k, 'infiltrator');
  // nem támadható, az automatikus célzás és a torony figyelmen kívül hagyja
  assert.strictEqual(m.command(0, { type: 'attack', unitIds: [watcher.id], target: { entityId: spy.id } }).ok, false);
  assert.strictEqual(m.nearestEnemyUnit(0, 32, 20, 5, true), null);
  const guard = m.createUnit(0, 'knife', 32, 21);
  m.step();
  assert.strictEqual(guard.order, null, 'az automatikus célzás nem kapja el');
  guard.dead = true;
  // torony épül a közelben -> leleplezés, a teljes rekord újra kimegy
  const tower = m.placeBuilding(0, 'tower', 31, 22, true);
  m.step();
  assert.strictEqual(m.disguisedTo(0, spy), false);
  const t = buildTick(m, 0, view);
  const rec = t.u.find((u) => u.i === spy.id);
  assert.strictEqual(rec.k, 'infiltrator');
  assert.strictEqual(rec.o, 1);
  assert.ok('x' in rec && 'hp' in rec, 'teljes rekord');
  assert.strictEqual(m.command(0, { type: 'attack', unitIds: [watcher.id], target: { entityId: spy.id } }).ok, true);
  // torony eltűnik -> újra álcázott, a teljes civil rekord megy ki
  m.setOrder(watcher, null);
  tower.dead = true;
  m.step();
  assert.strictEqual(m.disguisedTo(0, spy), true);
  const t2 = buildTick(m, 0, view);
  const rec2 = t2.u.find((u) => u.i === spy.id);
  assert.strictEqual(rec2.k, 'civilian');
  assert.strictEqual(rec2.o, -1);
  // harc után 5 mp-ig leleplezett
  m.damage(0, spy, 1, watcher.id);
  assert.strictEqual(m.disguisedTo(0, spy), false);
  stepN(m, 5 * C.TICK_HZ);
  assert.strictEqual(m.disguisedTo(0, spy), false);
  m.step();
  assert.strictEqual(m.disguisedTo(0, spy), true);
});

test('dézsmálás: 3 mp-enként 5 vas és 2 réz, a készlet korlátoz, a figyelmeztetés legfeljebb 15 mp-enként', () => {
  const m = makeMatch();
  const tc = ownB(m, 1, 'townCenter')[0];
  const spy = m.createUnit(0, 'infiltrator', tc.x - 0.5, tc.y + 1.5);
  m.updateVision();
  const me = m.players[0];
  const victim = m.players[1];
  Object.assign(me.res, { iron: 0, copper: 0 });
  Object.assign(victim.res, { iron: 100, copper: 100 });
  // sima támadás MÉH telepre / Vajda Házára dézsmálássá alakul
  assert.strictEqual(m.command(0, { type: 'attack', unitIds: [spy.id], target: { entityId: tc.id } }).ok, true);
  assert.strictEqual(spy.order.type, 'siphon');
  assert.strictEqual(m.command(0, { type: 'siphon', unitIds: [own(m, 0, 'scavenger')[0].id], target: { entityId: tc.id } }).ok, false);
  assert.strictEqual(m.command(0, { type: 'siphon', unitIds: [spy.id], target: { entityId: ownB(m, 0, 'townCenter')[0].id } }).ok, false);
  const notices = [];
  const run = (n) => { for (let i = 0; i < n; i++) { m.step(); for (const e of m.events) if (e.w.e === 'siphoned') notices.push({ t: m.tick, e }); } };
  run(3 * C.TICK_HZ);
  assert.strictEqual(me.res.iron, 5);
  assert.strictEqual(me.res.copper, 2);
  assert.strictEqual(victim.res.iron, 95);
  assert.strictEqual(victim.res.copper, 98);
  assert.strictEqual(notices.length, 1);
  assert.deepStrictEqual(notices[0].e.vis, { owner: 1 });
  assert.strictEqual(notices[0].e.w.text, 'Valaki dézsmálja a készleteidet a MÉH telepnél!');
  assert.strictEqual(spy.st, 'siphon');
  assert.strictEqual(m.disguisedTo(1, spy), false, 'a Vajda Háza igazlátása leleplezi');
  assert.ok(spy.combatT < 0, 'a dézsmálás nem számít harcnak');
  run(12 * C.TICK_HZ);
  assert.strictEqual(me.res.iron, 25);
  assert.strictEqual(notices.length, 1, '15 mp-en belül nincs újabb figyelmeztetés');
  run(3 * C.TICK_HZ);
  assert.strictEqual(notices.length, 2);
  // a készlet korlátoz
  Object.assign(victim.res, { iron: 3, copper: 1 });
  const before = { ...me.res };
  run(3 * C.TICK_HZ);
  assert.strictEqual(me.res.iron - before.iron, 3);
  assert.strictEqual(me.res.copper - before.copper, 1);
  assert.strictEqual(victim.res.iron, 0);
  assert.strictEqual(victim.res.copper, 0);
});

test('kémjelentés: a tickben ~1 Hz-en és a snapshotban, a végén egyszer üres lista', () => {
  const m = makeMatch();
  const tc = ownB(m, 1, 'townCenter')[0];
  const spy = m.createUnit(0, 'infiltrator', tc.x - 8, tc.y + 1);
  m.createUnit(1, 'knife', tc.x + 5, tc.y + 5);
  m.updateVision();
  const v = m.players[1];
  const report = m.spyReport(0);
  assert.strictEqual(report.length, 1);
  assert.deepStrictEqual(report[0], {
    unitId: spy.id, victim: 1, name: v.name, color: v.color,
    res: { iron: Math.floor(v.res.iron), copper: Math.floor(v.res.copper), food: Math.floor(v.res.food), wood: Math.floor(v.res.wood) },
    epoch: 1, research: null, military: 1
  });
  assert.deepStrictEqual(m.snapshot(0).spy, report);
  assert.deepStrictEqual(m.snapshot(1).spy, []);
  const view = createView();
  resetView(m, 0, view, m.snapshot(0));
  const spyTicks = [];
  for (let i = 0; i < 25; i++) { m.step(); const t = buildTick(m, 0, view); if (t && t.spy) spyTicks.push(m.tick); }
  assert.ok(spyTicks.length >= 2 && spyTicks.every((t) => t % C.TICK_HZ === 0), `spy ticks: ${spyTicks}`);
  // kutatás látszik
  v.research = { epoch: 2, left: 100, total: 200 }; v.researchPct = 50;
  assert.deepStrictEqual(m.spyReport(0)[0].research, { epoch: 2, pct: 50 });
  v.research = null;
  // eltávolodik: egyszer spy: [], utána semmi
  spy.x = 30; spy.y = 30;
  const after = [];
  for (let i = 0; i < 30; i++) { m.step(); const t = buildTick(m, 0, view); if (t && t.spy) after.push(t.spy); }
  assert.deepStrictEqual(after, [[]]);
});

test('megfigyelő: feladás után szűretlen nézet, sv összesítő, defeat esemény, parancs elutasítva', () => {
  const m = ffa3();
  const view = createView();
  resetView(m, 1, view, m.snapshot(1));
  // statisztika: a B egysége sebez és elesik
  const a = m.createUnit(0, 'knife', 30, 30);
  const b = m.createUnit(1, 'knife', 30.5, 30);
  m.strike(b, a);
  m.damage(0, b, 1e6, a.id);
  assert.strictEqual(m.players[1].stats.unitsLost, 1);
  near(m.players[1].stats.damageDealt, 7);
  assert.ok(m.resign(1));
  assert.strictEqual(m.status, 'playing');
  assert.strictEqual(m.players[1].spectator, true);
  assert.strictEqual(m.players[1].alive, false);
  const r = m.command(1, { type: 'ping', target: { x: 5, y: 5 } });
  assert.deepStrictEqual(r, { ok: false, error: SPECTATOR_ERROR });
  assert.strictEqual(SPECTATOR_ERROR, 'Megfigyelő módban nem adhatsz parancsot.');
  // snapshot: minden látszik, a kém valódi alakjában
  const spy = m.createUnit(2, 'infiltrator', 44, 44);
  m.updateVision();
  const snap = m.snapshot(1);
  assert.deepStrictEqual(snap.you, { idx: 1, team: 1, spectator: true });
  assert.strictEqual(snap.players[1].spectator, true);
  assert.strictEqual(snap.players[0].spectator, false);
  const all = [...m.units.values()].filter((u) => !u.dead).length;
  assert.strictEqual(snap.units.length, all);
  assert.strictEqual(snap.buildings.length, [...m.buildings.values()].filter((x) => !x.dead).length);
  assert.ok(snap.units.some((u) => u.o === 0) && snap.units.some((u) => u.o === 2));
  assert.strictEqual(snap.units.find((u) => u.i === spy.id).k, 'infiltrator');
  assert.ok(snap.sv && snap.sv.players.length === 3);
  // tickek: defeat esemény, majd sv 1 Hz-en, ellenséges egységek szűrés nélkül
  let defeat = null;
  const svTicks = [];
  const seen = new Set();
  for (let i = 0; i < 25; i++) {
    m.step();
    const t = buildTick(m, 1, view);
    if (!t) continue;
    for (const e of t.ev || []) if (e.e === 'defeat') defeat = e;
    for (const u of t.u || []) seen.add(u.i);
    if (t.sv) svTicks.push(t);
  }
  assert.ok(defeat, 'defeat esemény');
  assert.deepStrictEqual(Object.keys(defeat.stats).sort(), ['buildingsDestroyed', 'damageDealt', 'gathered', 'unitsKilled', 'unitsLost']);
  assert.strictEqual(defeat.stats.unitsLost, 1);
  assert.strictEqual(defeat.stats.damageDealt, 7);
  assert.ok(svTicks.length >= 2 && svTicks.every((t) => t.t % C.TICK_HZ === 0));
  const sv = svTicks[0].sv;
  assert.strictEqual(typeof sv.elapsed, 'number');
  assert.deepStrictEqual(Object.keys(sv.players[0]).sort(), ['alive', 'army', 'buildings', 'color', 'epoch', 'idx', 'name', 'res', 'team', 'workers']);
  assert.strictEqual(sv.players[1].alive, false);
  assert.strictEqual(sv.players[1].buildings, 0);
  assert.ok(sv.players[0].workers >= 7 && sv.players[2].army >= 1);
  for (const u of m.units.values()) assert.ok(seen.has(u.id), `a megfigyelő nem kapta meg: ${u.id}`);
  // a többi játékos nem kap defeat eseményt, a results tartalmazza az új mezőket
  const res = m.results();
  assert.strictEqual(res[1].unitsLost, 1);
  assert.strictEqual(res[1].damageDealt, 7);
  assert.strictEqual(m.players[0].spectator, false);
});

test('kiesés épületvesztéssel: az ember megfigyelő lesz, az MI nem; az MI nem omlik össze kémtől', () => {
  const m = makeMatch({ ai: true, players: [{ name: 'Gép', team: 0, isAi: true, difficulty: 'hard' }, { name: 'Ember', team: 1 }, { name: 'Harmadik', team: 2 }] });
  const human = m.players[1];
  const spy = m.createUnit(1, 'infiltrator', 40, 40);
  for (let i = 0; i < 300; i++) m.step();
  void spy;
  for (const b of ownB(m, 1)) m.damage(0, b, 1e9);
  m.step();
  assert.strictEqual(human.alive, false);
  assert.strictEqual(human.spectator, true);
  assert.ok(m.events.some((e) => e.w.e === 'defeat' && e.vis.owner === 1));
  for (const b of ownB(m, 0)) m.damage(2, b, 1e9);
  m.step();
  assert.strictEqual(m.players[0].spectator, false);
  assert.strictEqual(m.status, 'ended');
  assert.strictEqual(m.winnerTeam, 2);
});
