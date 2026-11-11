const test = require('node:test');
const assert = require('node:assert');
const C = require('../content');
const { makeMatch, stepN, own, ownB, rich, freeSpot } = require('./helpers');

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('tartalom: házneve korszaktól függ, nincs tiltott név, minden egység és épület teljes', () => {
  const c = C.getContent();
  assert.deepStrictEqual(c.buildings.house.names.map((n) => n.name), ['Viskó', 'Lakótelepi lakás']);
  assert.ok(!JSON.stringify(c).includes('Putri'));
  assert.strictEqual(c.epochs.length, 5);
  assert.deepStrictEqual(c.epochs.map((e) => e.name), ['Telepi Kezdet', 'Vasgyári Virágkor', 'Avasi Lakótelep', 'Miskolci Nagyváros', 'Cyber-Miskolc']);
  assert.deepStrictEqual(c.epochs[1].cost, { iron: 300, food: 200 });
  assert.strictEqual(c.epochs[1].researchTime, 45);
  assert.deepStrictEqual(c.units.scavenger.cost, { food: 50 });
  assert.strictEqual(c.units.scavenger.buildTime, 15);
  assert.deepStrictEqual(c.demolish, { maxRefund: 0.5, minRefund: 0.35, holdMs: 1500 });
  assert.ok(c.buildings.tavern.trains.includes('infiltrator'));
  assert.strictEqual(c.units.infiltrator.class, 'spy');
  assert.strictEqual(c.units.civilian, undefined);
  for (const [id, u] of Object.entries(c.units)) for (const f of ['name', 'description', 'cost', 'buildTime', 'epoch', 'producer', 'hp', 'attack', 'range', 'speed', 'armor', 'sight', 'class']) assert.ok(u[f] !== undefined, `${id}.${f}`);
  for (const [id, b] of Object.entries(c.buildings)) for (const f of ['name', 'description', 'cost', 'buildTime', 'epoch', 'hp', 'size']) assert.ok(b[f] !== undefined, `${id}.${f}`);
  for (const [id, u] of Object.entries(c.units)) assert.ok(c.buildings[u.producer].trains.includes(id), `${id} gyártó`);
});

test('ellenszerek: a szorzók pontosan érvényesülnek', () => {
  const m = makeMatch();
  const mk = (k, o = 0) => m.createUnit(o, k, 30, 30);
  const loss = (att, tgt) => { const before = tgt.hp; m.strike(att, tgt); return before - tgt.hp; };
  near(loss(mk('brawler'), mk('knife', 1)), 12 * 1.5); // nehéz > könnyű
  near(loss(mk('slingshot'), mk('brawler', 1)), 8 * 1.75 * 0.6); // lövész > nehéz (páncél 0.4)
  near(loss(mk('horseWagon'), mk('slingshot', 1)), 8 * 1.75); // gyors jármű > lövész
  near(loss(mk('knife'), mk('slingshot', 1)), 7 * 1.4); // könnyű > lövész
  near(loss(mk('knife'), mk('ram', 1)), 7 * 2 * 0.8); // könnyű közelharcos > ostrom (páncél 0.2)
  near(loss(mk('ram'), mk('horseWagon', 1)), 30 * 3); // ostrom > gyors jármű
  near(loss(mk('knife'), mk('knife', 1)), 7); // semleges
  near(loss(mk('knife'), mk('brawler', 1)), 7 * 0.6); // ellenszer nélkül, csak páncél
  assert.strictEqual(C.UNITS.brawler.armor, 0.4);
  assert.strictEqual(C.UNITS.brawler.speed, 2.1);
  const house = m.placeBuilding(1, 'house', 40, 40, true);
  near(loss(mk('ram'), house), 30 * 3); // ostrom > épület
  near(loss(mk('knife'), m.placeBuilding(1, 'house', 44, 40, true)), 7); // nem ostrom
});

test('Cigány asszony: drága, 3. korszakos kocsmai lövész, a fapapucs a közeli második ellenfélre pattan', () => {
  const def = C.UNITS.ciganyAsszony;
  assert.strictEqual(def.name, 'Cigány asszony');
  assert.strictEqual(def.producer, 'tavern');
  assert.ok(C.BUILDINGS.tavern.trains.includes('ciganyAsszony'));
  const total = (c) => Object.values(c).reduce((a, b) => a + b, 0);
  assert.ok(total(def.cost) >= 2.5 * total(C.UNITS.brawler.cost));
  const ranged = Object.values(C.UNITS).filter((u) => u.class === 'ranged' && u !== def);
  for (const u of ranged) assert.ok(def.attack / def.cooldown > u.attack / u.cooldown && def.hp > u.hp);

  const m = makeMatch();
  const p = m.players[0];
  rich(m, 0);
  const [x, y] = freeSpot(m, 0, 2);
  const tav = m.placeBuilding(0, 'tavern', x, y, true);
  p.epoch = 2;
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tav.id, unit: 'ciganyAsszony' }).ok, false);
  p.epoch = 3;
  const iron = p.res.iron;
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tav.id, unit: 'ciganyAsszony' }).ok, true);
  assert.strictEqual(p.res.iron, iron - def.cost.iron);

  p.epoch = 1;
  const a = m.createUnit(0, 'ciganyAsszony', 30, 30);
  const t = m.createUnit(1, 'knife', 35, 30);
  const t2 = m.createUnit(1, 'knife', 37, 30);
  const far = m.createUnit(1, 'knife', 35, 34);
  m.buildHash();
  m.events.length = 0;
  m.strike(a, t);
  near(t.maxHp - t.hp, 20);
  near(t2.maxHp - t2.hp, 20 * 0.5);
  assert.strictEqual(far.hp, far.maxHp);
  const proj = m.events.map((e) => e.w).filter((w) => w.e === 'proj');
  assert.deepStrictEqual(proj.map((w) => [w.k, w.rb, w.x, w.tx]), [['ciganyAsszony', undefined, 30, 35], ['ciganyAsszony', 1, 35, 37]]);
  m.events.length = 0;
  m.strike(m.createUnit(0, 'airgunner', 30, 30), t);
  assert.strictEqual(m.events.filter((e) => e.w.e === 'proj').length, 1); // más lövész nem pattint
});

test('korszak-szorzók és Vajda-aura módosítja a sebzést', () => {
  const m = makeMatch();
  m.players[0].epoch = 3;
  const a = m.createUnit(0, 'knife', 30, 30);
  const t = m.createUnit(1, 'knife', 30, 30);
  m.strike(a, t);
  near(t.maxHp - t.hp, 7 * 1.3);
  m.createUnit(1, 'elder', 30, 31);
  m.computeAuras();
  const t2 = m.createUnit(1, 'knife', 30, 30);
  m.strike(a, t2);
  near(t2.maxHp - t2.hp, 7 * 1.3 * 0.85);
});

test('gyűjtés és lerakodás: nyersanyag nő, statisztika számol, a MÉH telep csak vasat és rezet vesz át', () => {
  const m = makeMatch();
  const p = m.players[0];
  const s = own(m, 0, 'scavenger')[0];
  const node = m.findNode('iron', s.x, s.y, 60);
  assert.ok(node);
  const before = p.res.iron;
  assert.deepStrictEqual(m.command(0, { type: 'gather', unitIds: [s.id], target: { nodeId: node.id } }), { ok: true });
  stepN(m, 900);
  assert.ok(p.res.iron > before, `vas ${before} -> ${p.res.iron}`);
  assert.ok(p.stats.gathered >= p.res.iron - before);
  assert.ok(node.a < 2400);
  assert.ok([...m.nodes.values()].every((n) => n.a >= 1500 && n.a <= 3000));
  // lerakodó hely szerint
  const tc = ownB(m, 0, 'townCenter')[0];
  const [sx, sy] = freeSpot(m, 0, 2);
  const yard = m.placeBuilding(0, 'scrapYard', sx, sy, true);
  const u = own(m, 0, 'scavenger')[1];
  u.x = sx + 0.5; u.y = sy + 2.6; u.ct = 'iron';
  assert.strictEqual(m.findDropOff(u).id, yard.id);
  u.ct = 'food';
  assert.strictEqual(m.findDropOff(u).id, tc.id);
});

test('építés: nyersanyag fogy, az építő felhúzza, a lakosságkorlát nő', () => {
  const m = makeMatch();
  const p = m.players[0];
  const b = own(m, 0, 'builder')[0];
  const [x, y] = freeSpot(m, 0, 2);
  const woodBefore = p.res.wood;
  const capBefore = p.popCap;
  const r = m.command(0, { type: 'build', unitIds: [b.id], building: 'house', target: { x, y } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p.res.wood, woodBefore - C.BUILDINGS.house.cost.wood);
  const house = m.buildings.get(r.buildingId);
  assert.strictEqual(house.complete, false);
  assert.strictEqual(m.command(0, { type: 'build', unitIds: [b.id], building: 'house', target: { x, y } }).ok, false); // foglalt hely
  stepN(m, C.BUILDINGS.house.buildTime * 10 + 150);
  assert.strictEqual(house.complete, true);
  assert.strictEqual(p.popCap, capBefore + 8);
  // gyűjtő nem építhet, későbbi korszak épülete nem megy
  assert.strictEqual(m.command(0, { type: 'build', unitIds: [own(m, 0, 'scavenger')[0].id], building: 'house', target: { x: x + 5, y } }).ok, false);
  assert.strictEqual(m.command(0, { type: 'build', unitIds: [b.id], building: 'wall', target: { x: x + 9, y } }).ok, false);
});

test('képzés: sorba áll, kifizeti, lakosságkorlátnál megáll, lemondásnál visszatérít', () => {
  const m = makeMatch();
  const p = m.players[0];
  const tc = ownB(m, 0, 'townCenter')[0];
  const food = p.res.food;
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tc.id, unit: 'scavenger' }).ok, true);
  assert.strictEqual(p.res.food, food - 50);
  assert.strictEqual(p.pop, 8);
  assert.strictEqual(m.command(0, { type: 'cancel-train', buildingId: tc.id, index: 0 }).ok, true);
  assert.strictEqual(p.res.food, food);
  assert.strictEqual(p.pop, 7);
  m.command(0, { type: 'train', buildingId: tc.id, unit: 'scavenger' });
  const n = own(m, 0).length;
  stepN(m, C.UNITS.scavenger.buildTime * 10 + 5);
  assert.strictEqual(own(m, 0).length, n + 1);
  assert.strictEqual(p.pop, 8);
  rich(m, 0);
  // feltöltés a korlátig (15), a sor 5 hosszú
  let ok = 0;
  while (p.pop < p.popCap) { const r = m.command(0, { type: 'train', buildingId: tc.id, unit: 'builder' }); if (r.ok) ok++; else break; stepN(m, 150); }
  assert.strictEqual(p.pop, p.popCap);
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tc.id, unit: 'builder' }).ok, false);
  assert.ok(ok >= 1);
  // nem képezhető egység / későbbi korszak
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tc.id, unit: 'knife' }).ok, false);
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tc.id, unit: 'elder' }).ok, false);
});

test('a lakosságkorlát 100-nál megáll', () => {
  const m = makeMatch();
  for (let i = 0; i < 20; i++) { const [x, y] = freeSpot(m, 0, 2); m.placeBuilding(0, 'house', x, y, true); }
  m.recomputePopCap(m.players[0]);
  assert.strictEqual(m.players[0].popCap, 100);
});

test('korszakváltás: költség, kutatási idő, szorzók, élőerő skálázás', () => {
  const m = makeMatch();
  const p = m.players[0];
  Object.assign(p.res, { iron: 0, copper: 0, food: 0, wood: 0 });
  assert.strictEqual(m.command(0, { type: 'advance-epoch' }).ok, false); // nincs elég
  rich(m, 0);
  const s = own(m, 0, 'scavenger')[0];
  const hp = s.maxHp;
  assert.strictEqual(m.command(0, { type: 'advance-epoch' }).ok, true);
  assert.strictEqual(p.res.food, 5000 - 200);
  assert.strictEqual(p.res.iron, 5000 - 300);
  assert.strictEqual(m.command(0, { type: 'advance-epoch' }).ok, false); // már kutat
  stepN(m, 45 * 10 - 1);
  assert.strictEqual(p.epoch, 1);
  m.step();
  assert.strictEqual(p.epoch, 2);
  assert.strictEqual(p.research, null);
  near(s.maxHp, hp * 1.1, 1e-6);
  assert.strictEqual(m.gatherMult(p), 1.25);
  assert.strictEqual(m.command(0, { type: 'train', buildingId: ownB(m, 0, 'townCenter')[0].id, unit: 'builder' }).ok, true);
  // a korszak a magasabb szintű egység feltétele
  const [x, y] = freeSpot(m, 0, 2);
  const tav = m.placeBuilding(0, 'tavern', x, y, true);
  assert.strictEqual(m.command(0, { type: 'train', buildingId: tav.id, unit: 'brawler' }).ok, true);
});

test('harc: az egységek megölik egymást, a statisztika és a pop is számol', () => {
  const m = makeMatch();
  const a = [0, 1, 2, 3].map((i) => m.createUnit(0, 'brawler', 30 + i * 0.5, 30));
  const b = [0, 1].map((i) => m.createUnit(1, 'knife', 31 + i * 0.5, 31));
  m.players[0].pop += 4; m.players[1].pop += 2;
  m.vis.clear();
  m.updateVision();
  for (const u of a) m.command(0, { type: 'attack', unitIds: [u.id], target: { entityId: b[0].id } });
  stepN(m, 120);
  assert.ok(b[0].dead || !m.units.has(b[0].id));
  assert.ok(m.players[0].stats.unitsKilled >= 1);
  stepN(m, 300);
  assert.strictEqual(own(m, 1, 'knife').length, 0);
  assert.strictEqual(m.players[0].stats.unitsKilled, 2);
  assert.strictEqual(m.players[1].pop, 7);
});

test('torony automatikusan lő, a falrombolók épületet ledöntenek', () => {
  const m = makeMatch();
  const tower = m.placeBuilding(0, 'tower', 30, 30, true);
  const e = m.createUnit(1, 'knife', 33, 31);
  stepN(m, 120);
  assert.ok(e.hp < e.maxHp || e.dead);
  const target = m.placeBuilding(1, 'house', 20, 40, true);
  const rams = [0, 1, 2].map((i) => m.createUnit(0, 'ram', 20 + i, 42.5));
  m.updateVision();
  for (const r of rams) m.command(0, { type: 'attack', unitIds: [r.id], target: { entityId: target.id } });
  stepN(m, 300);
  assert.ok(target.dead || !m.buildings.has(target.id));
  assert.ok(m.players[0].stats.buildingsDestroyed >= 1);
  void tower;
});

test('kiesés és győzelem: csak a kerítés/fal nem számít, az utolsó csapat nyer', () => {
  const m = makeMatch();
  const tc = ownB(m, 1, 'townCenter')[0];
  m.placeBuilding(1, 'fence', 2, 2, true);
  m.damage(0, tc, 1e9);
  m.step();
  assert.strictEqual(m.players[1].alive, false);
  assert.strictEqual(m.status, 'ended');
  assert.strictEqual(m.winnerTeam, 0);
  assert.strictEqual(own(m, 1).length, 0);
  assert.deepStrictEqual(m.results().map((r) => r.won), [true, false]);
  assert.strictEqual(m.command(0, { type: 'stop', unitIds: [own(m, 0)[0].id] }).ok, false); // vége
});

test('feladás és FFA: az utolsó túlélő csapata győz, a szövetséges csapat együtt marad', () => {
  const ffa = makeMatch({ players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }, { name: 'C', team: 2 }] });
  assert.strictEqual(ffa.w, 88);
  assert.ok(ffa.resign(1));
  assert.strictEqual(ffa.status, 'playing');
  assert.ok(ffa.resign(2));
  assert.strictEqual(ffa.status, 'ended');
  assert.strictEqual(ffa.winnerTeam, 0);
  const tv = makeMatch({ players: [{ name: 'A', team: 0 }, { name: 'B', team: 1 }, { name: 'C', team: 0 }, { name: 'D', team: 1 }] });
  tv.resign(0);
  assert.strictEqual(tv.status, 'playing');
  tv.resign(2);
  assert.strictEqual(tv.status, 'ended');
  assert.strictEqual(tv.winnerTeam, 1);
});

test('köd: a látótéren kívüli ellenség sosem kerül a játékos tickjébe, a látótérbe lépő megjelenik', () => {
  const { createView, resetView, buildTick } = require('../view');
  const m = makeMatch();
  const view = createView();
  const snap = m.snapshot(0);
  resetView(m, 0, view, snap);
  const enemyIds = new Set([...own(m, 1), ...ownB(m, 1)].map((e) => e.id));
  assert.ok(snap.units.every((u) => u.o === 0) && snap.buildings.every((b) => b.o === 0));
  assert.strictEqual(JSON.stringify(snap).includes('Kettő') , true); // a játékoslista nem szivárgás
  for (let i = 0; i < 200; i++) {
    m.step();
    const t = buildTick(m, 0, view);
    if (!t) continue;
    for (const e of [...(t.u || []), ...(t.b || [])]) assert.ok(!enemyIds.has(e.i), 'ellenség a tickben');
    for (const ev of t.ev || []) assert.ok(!(ev.e === 'dead' && enemyIds.has(ev.i)));
  }
  // ellenséges felderítő a látótérbe sétál
  const spy = m.createUnit(1, 'knife', 14, 14);
  m.step();
  const t = buildTick(m, 0, view);
  assert.ok(t.u.some((u) => u.i === spy.id && u.o === 1 && u.k === 'knife'), 'a látótérben lévő ellenség teljes adattal megjelenik');
  // kisétál: x-ben távozik
  spy.x = 40; spy.y = 5;
  m.step();
  const t2 = buildTick(m, 0, view);
  assert.ok(t2.x.includes(spy.id));
  // az ellenség nem támadható látóterén kívül (azonosító-szondázás ellen)
  assert.strictEqual(m.command(0, { type: 'attack', unitIds: [own(m, 0)[0].id], target: { entityId: own(m, 1)[0].id } }).ok, false);
});

function run(seed) {
  const m = makeMatch({ seed });
  const tc = ownB(m, 0, 'townCenter')[0];
  rich(m, 0);
  const log = [];
  const scav = own(m, 0, 'scavenger');
  const nodes = [...m.nodes.values()].filter((n) => n.k === 'wood');
  log.push(m.command(0, { type: 'gather', unitIds: scav.map((u) => u.id), target: { nodeId: nodes[0].id } }));
  log.push(m.command(0, { type: 'train', buildingId: tc.id, unit: 'builder' }));
  const [x, y] = freeSpot(m, 0, 2);
  log.push(m.command(0, { type: 'build', unitIds: [own(m, 0, 'builder')[0].id], building: 'barracks', target: { x, y } }));
  stepN(m, 300);
  log.push(m.command(0, { type: 'move', unitIds: scav.map((u) => u.id).slice(0, 3), target: { x: 30, y: 30 } }));
  const evs = [];
  for (let i = 0; i < 400; i++) { m.step(); evs.push(JSON.stringify(m.events.map((e) => e.w))); }
  return JSON.stringify({ log, snap: m.snapshot(0), evs, nodes: [...m.nodes.values()], t: m.tick });
}

test('determinizmus: azonos mag és parancsok azonos állapotot adnak, más mag mást', () => {
  assert.strictEqual(run(5), run(5));
  assert.notStrictEqual(run(5), run(6));
});

test('parancs-ellenőrzés: idegen egységek, rossz típusok, túl hosszú lista, prototípus-kulcsok', () => {
  const m = makeMatch();
  const mine = own(m, 0)[0];
  const foe = own(m, 1)[0];
  const tc = ownB(m, 0, 'townCenter')[0];
  const bad = (cmd, who = 0) => { const r = m.command(who, cmd); assert.strictEqual(r.ok, false, JSON.stringify(cmd)); assert.ok(typeof r.error === 'string' && r.error.length > 0); };
  bad({ type: 'move', unitIds: [foe.id], target: { x: 5, y: 5 } }); // idegen egység
  bad({ type: 'move', unitIds: [mine.id, foe.id], target: { x: 5, y: 5 } });
  bad({ type: 'move', unitIds: Array.from({ length: 61 }, (_, i) => i + 1), target: { x: 5, y: 5 } }); // túl sok
  bad({ type: 'move', unitIds: [], target: { x: 5, y: 5 } });
  bad({ type: 'move', unitIds: 'abc', target: { x: 5, y: 5 } });
  bad({ type: 'move', unitIds: { length: 1, 0: mine.id }, target: { x: 5, y: 5 } });
  bad({ type: 'move', unitIds: [1.5], target: { x: 5, y: 5 } });
  bad({ type: 'move', unitIds: ['__proto__'], target: { x: 5, y: 5 } });
  bad({ type: 'move', unitIds: [mine.id], target: { x: NaN, y: 5 } });
  bad({ type: 'move', unitIds: [mine.id], target: { x: Infinity, y: 5 } });
  bad({ type: 'move', unitIds: [mine.id], target: { x: 1e9, y: 5 } });
  bad({ type: 'move', unitIds: [mine.id], target: { x: '5', y: 5 } });
  bad({ type: 'move', unitIds: [mine.id], target: [5, 5] });
  bad({ type: 'move', unitIds: [mine.id] });
  for (const type of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'x'.repeat(100), 5, null, undefined, {}, []]) bad({ type, unitIds: [mine.id] });
  bad(null); bad('move'); bad([]); bad(undefined); bad(42);
  const builder = own(m, 0, 'builder')[0];
  for (const b of ['__proto__', 'constructor', 'toString', 'valueOf', 'prototype', '', 7, null, {}, ['house']]) bad({ type: 'build', unitIds: [builder.id], building: b, target: { x: 20, y: 20 } });
  for (const u of ['__proto__', 'constructor', 'toString', '', 3, null, {}]) bad({ type: 'train', buildingId: tc.id, unit: u });
  bad({ type: 'train', buildingId: '__proto__', unit: 'scavenger' });
  bad({ type: 'train', buildingId: foe.id, unit: 'scavenger' });
  bad({ type: 'train', buildingId: ownB(m, 1)[0].id, unit: 'scavenger' }); // ellenséges épület
  bad({ type: 'cancel-train', buildingId: tc.id, index: 0 });
  bad({ type: 'cancel-train', buildingId: tc.id, index: '__proto__' });
  bad({ type: 'cancel-train', buildingId: tc.id, index: -1 });
  bad({ type: 'attack', unitIds: [mine.id], target: { entityId: mine.id } }); // saját
  bad({ type: 'attack', unitIds: [mine.id], target: { entityId: '__proto__' } });
  bad({ type: 'attack', unitIds: [mine.id], target: { entityId: 99999 } });
  bad({ type: 'gather', unitIds: [mine.id], target: { nodeId: '__proto__' } });
  bad({ type: 'gather', unitIds: [mine.id], target: { nodeId: 123456 } });
  bad({ type: 'repair', unitIds: [builder.id], target: { entityId: ownB(m, 1)[0].id } });
  bad({ type: 'set-rally', buildingId: ownB(m, 1)[0].id, target: { x: 3, y: 3 } });
  bad({ type: 'ping', target: { x: -5, y: 3 } });
  bad({ type: 'move', unitIds: [mine.id], target: { x: 5, y: 5 } }, 7); // ismeretlen játékos
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
  // az érvényes parancsok továbbra is mennek, és a "__proto__" kulcsok a JSON-ból érkezve sem ártanak
  const sneaky = JSON.parse('{"type":"move","unitIds":[' + mine.id + '],"target":{"x":20,"y":20},"__proto__":{"owner":9},"constructor":{"prototype":{"x":1}}}');
  assert.strictEqual(m.command(0, sneaky).ok, true);
  assert.strictEqual(m.command(0, { type: 'ping', target: { x: 5, y: 5 } }).ok, true);
  assert.strictEqual(m.command(0, { type: 'ping', target: { x: 6, y: 6 } }).ok, false); // sebességkorlát
});

test('szünet alatt a szimuláció áll és a parancsok elutasítottak', () => {
  const m = makeMatch();
  m.paused = { reason: 'x', untilMs: 1 };
  const t = m.tick;
  m.step();
  assert.strictEqual(m.tick, t);
  assert.strictEqual(m.command(0, { type: 'advance-epoch' }).ok, false);
});

test('A* útkeresés: kikerüli a vizet, és a térkép összefüggő', () => {
  const { generateMap } = require('../map');
  const { Pathfinder } = require('../pathfinding');
  for (const n of [2, 3, 4]) {
    const map = generateMap(99 + n, n);
    assert.strictEqual(map.tiles.length, map.w * map.h);
    assert.ok(/^[gdrcwx]+$/.test(map.tiles));
    const blocked = new Uint8Array(map.w * map.h);
    for (let i = 0; i < blocked.length; i++) if (map.tiles[i] === 'w' || map.tiles[i] === 'x') blocked[i] = 1;
    const pf = new Pathfinder(map.w, map.h, blocked);
    const [a, b] = [map.starts[0], map.starts[map.starts.length - 1]];
    const path = pf.find(a[0] + 1, a[1] + 1, { x0: b[0] + 1, y0: b[1] + 1, x1: b[0] + 1, y1: b[1] + 1 }, 0, 20000);
    assert.ok(path && path.length >= 2);
    const end = [path[path.length - 2], path[path.length - 1]];
    assert.ok(Math.hypot(end[0] - (b[0] + 1.5), end[1] - (b[1] + 1.5)) < 1.5);
    let px = a[0] + 1; let py = a[1] + 1;
    for (let i = 0; i < path.length; i += 2) { assert.ok(pf.lineClear(px, py, path[i], path[i + 1])); px = path[i]; py = path[i + 1]; }
  }
});

test('starting units spawn on separate tiles', () => {
  const m = makeMatch();
  const tiles = new Set(own(m, 0).map((u) => `${Math.floor(u.x)},${Math.floor(u.y)}`));
  assert.equal(tiles.size, own(m, 0).length);
});
