const test = require('node:test');
const assert = require('node:assert');
const { CHARACTERS, MAPS, NPCS } = require('../content');
const { Match } = require('../simulation');
const physics = require('../physics');
const { importFrontendModule } = require('../../test/support/frontendModule.cjs');

const roster = (n, teamOf = (i) => (i % 2 ? 'grime' : 'soap')) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, username: `P${i}`, team: teamOf(i), characterId: teamOf(i) === 'soap' ? 'bar_trooper' : 'mold_creeper', side: undefined }));
const make = (mode, map, n, extra = {}) => new Match({ id: mode, mode, world: MAPS[map], characters: CHARACTERS, roster: roster(n), rng: extra.rng || Math.random, timeLimit: extra.timeLimit || 600, options: extra.options || {}, scoreLimit: extra.scoreLimit || 30 });
const run = (m, seconds, each) => { for (let i = 0; i < seconds * m.tickRate && !m.result; i += 1) { each?.(i); m.tick(); } };
const noProtect = (m) => m.players.forEach((p) => { p.protectedUntil = 0; });

test('fertőzés: az áldozat átáll, minden túlélő elestével a fertőzöttek nyernek', () => {
  const m = make('infection', 'bathroom_arena', 5);
  const infected = m.players.filter((p) => p.side === 'infected');
  assert.strictEqual(infected.length, 1);
  assert.deepStrictEqual(infected[0].attackOverride.range, 3.6);
  noProtect(m);
  for (const p of m.players.filter((q) => q.side === 'survivor')) {
    m.damage(p, 9999, infected[0]);
    assert.strictEqual(p.side, 'infected');
  }
  assert.strictEqual(m.result.winner, 'infected');
  assert.strictEqual(m.result.reason, 'all_infected');
  assert.strictEqual(m.result.players.find((p) => p.key === infected[0].key).outcome, undefined);
});

test('fertőzés: lejáró időnél a túlélők nyernek, fertőzött nem sebezhet fertőzöttet', () => {
  const m = make('infection', 'bathroom_arena', 5, { timeLimit: 0.2 });
  const [a] = m.players.filter((p) => p.side === 'infected');
  const b = m.players.find((p) => p.side === 'survivor');
  b.side = 'infected';
  assert.strictEqual(m.isEnemy(a, b), false);
  b.side = 'survivor';
  run(m, 1);
  assert.strictEqual(m.result.winner, 'survivor');
});

test('túlélés: hullámok jönnek, a játékos földre kerül, E-vel felsegíthető', () => {
  const m = make('survival', 'bathroom_arena', 2, { rng: () => 0.4 });
  run(m, 5);
  assert.strictEqual(m.state.wave, 1);
  assert.ok(m.npcs.length >= 5);
  noProtect(m);
  const [a, b] = m.players;
  m.damage(a, 9999, null);
  assert.ok(a.downed && !a.alive);
  assert.strictEqual(m.result, null, 'csak az egyik esett el');
  b.x = a.x + 1; b.z = a.z;
  let seq = 0;
  for (let i = 0; i < 80 && a.downed; i += 1) { m.queueInput('k1', { seq: (seq += 1), mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ability: false, interact: true }); b.hp = 100; b.protectedUntil = 1e9; m.tick(); }
  assert.ok(a.alive, 'felsegítve');
  assert.strictEqual(b.counters.revives, 1);
});

test('túlélés: az ellenfelek támadnak, mindenki kiesésével vége, a rekord tárolva', () => {
  const m = make('survival', 'bathroom_arena', 1, { rng: () => 0.4 });
  run(m, 120);
  assert.ok(m.result, 'a tétlen játékost megölik');
  assert.strictEqual(m.result.reason, 'wiped');
  assert.ok(m.result.waves >= 1);
  assert.strictEqual(m.result.players[0].counters.survival_best, m.result.waves);
});

test('az ellenfelek megkerülik a hosszú falat', () => {
  const m = make('survival', 'bathroom_arena', 1, { rng: () => 0.4 });
  const [p] = m.players;
  Object.assign(p, { x: -33, z: 0, protectedUntil: 0, hp: 1e6 });
  const npc = m.spawnNpc('slime', -14, 0);
  m.state.nextWaveAt = 1e9;
  run(m, 15);
  assert.ok(Math.hypot(npc.x - p.x, npc.z - p.z) < 4, `helyzet: ${npc.x},${npc.z}`);
});

test('survival: a következő hullám csak a takarítás után indul', () => {
  const m = make('survival', 'bathroom_arena', 1, { rng: () => 0.4 });
  run(m, 5);
  m.players[0].protectedUntil = 1e9;
  run(m, 10);
  assert.strictEqual(m.state.wave, 1);
  for (const n of [...m.npcs]) m.damageNpc(n, 1e6, m.players[0]);
  assert.strictEqual(m.npcs.length, 0);
  run(m, 5);
  assert.strictEqual(m.state.wave, 2);
});

test('főellenség: fázisok, minták, játékosszámhoz skálázott élet, győzelem és hozzájárulás', () => {
  const m = make('boss', 'bathroom_arena', 3, { options: { bossId: 'hair_titan', difficulty: 'hard' }, rng: () => 0.5 });
  const b = m.state.bossNpc;
  assert.strictEqual(b.type, 'hair_titan');
  assert.strictEqual(b.maxHp, Math.round(NPCS.hair_titan.hp * 1.5 * 2.4));
  m.players.forEach((p) => { p.protectedUntil = 1e9; });
  run(m, 8);
  assert.ok(m.state.nextPatternAt > 5, 'minta lefutott');
  m.damageNpc(b, Math.round(b.maxHp * 0.4), m.players[0]);
  run(m, 0.1);
  assert.strictEqual(m.state.phase, 2);
  m.damageNpc(b, Math.round(b.maxHp * 0.3), m.players[1]);
  run(m, 0.1);
  assert.strictEqual(m.state.phase, 3);
  m.damageNpc(b, 1e9, m.players[0]);
  assert.strictEqual(m.result.winner, 'players');
  assert.strictEqual(m.result.players[0].counters.boss_kills, 1);
  assert.strictEqual(m.result.players[1].counters.titan_kills, 1);
  assert.strictEqual(m.result.players[2].counters.boss_kills, undefined, 'aki nem sebzett, nem kap ölést');
  assert.strictEqual(m.result.players[0].outcome, 'win');
});

test('főellenség: idő lejártával vereség', () => {
  const m = make('boss', 'bathroom_arena', 1, { timeLimit: 0.2 });
  m.players[0].protectedUntil = 1e9;
  run(m, 1);
  assert.strictEqual(m.result.winner, null);
  assert.strictEqual(m.result.players[0].outcome, 'loss');
});

test('veszélyzóna: élesedés előtt nem sebez, utána igen', () => {
  const m = make('boss', 'bathroom_arena', 1);
  const [p] = m.players;
  p.protectedUntil = 0;
  m.addHazard(p.x, p.z, 5, 0.5, 2, 0, 20);
  m.updateHazards();
  assert.strictEqual(p.hp, 100);
  m.time += 0.6;
  m.updateHazards();
  assert.strictEqual(p.hp, 80);
  m.updateHazards();
  assert.strictEqual(p.hp, 80, 'a robbanás csak egyszer sebez');
});

test('royale: mindenki ellenség, nincs újraéledés, helyezés és győztes', () => {
  const m = make('royale', 'drain_city', 4);
  noProtect(m);
  const [a, b, c, d] = m.players;
  assert.ok(m.isEnemy(a, b));
  m.damage(b, 9999, a);
  run(m, 6);
  assert.ok(b.eliminated && !b.alive, 'nem éled újra');
  assert.strictEqual(b.place, 4);
  m.damage(c, 9999, a);
  m.damage(d, 9999, a);
  assert.strictEqual(m.result.winner, a.side);
  assert.strictEqual(m.result.players[0].outcome, 'win');
  assert.strictEqual(a.place, 1);
});

test('royale: a zóna szűkül és sebez, a loot felvehető, jobb fegyver lecseréli a gyengébbet', () => {
  const m = make('royale', 'drain_city', 2, { rng: () => 0.3 });
  noProtect(m);
  const [a] = m.players;
  const before = m.state.zone.r;
  a.protectedUntil = 0;
  const weaponLoot = m.addPickup('smg', a.x, a.z);
  run(m, 0.1);
  assert.strictEqual(a.weapon.id, 'smg');
  assert.ok(!m.pickups.includes(weaponLoot));
  m.addPickup('pistol', a.x, a.z);
  run(m, 0.1);
  assert.strictEqual(a.weapon.id, 'smg', 'gyengébbre nem cserél');
  a.hp = 50;
  m.addPickup('medkit', a.x, a.z);
  run(m, 0.1);
  assert.strictEqual(a.hp, 100);
  a.protectedUntil = 1e9;
  run(m, 40);
  assert.ok(m.state.zone.r < before, 'szűkül');
  const z = m.state.zone;
  Object.assign(z, { r: 5, from: 5, to: 5 });
  a.x = z.x + 20; a.z = z.z; a.protectedUntil = 0; a.hp = 100;
  run(m, 2.1);
  assert.ok(a.hp < 100, 'a zónán kívül sebez');
});

test('royale: páncél előbb fogy, kilépés kiesést jelent', () => {
  const m = make('royale', 'drain_city', 3);
  noProtect(m);
  const [a, b] = m.players;
  a.armor = 20;
  m.damage(a, 30, b);
  assert.strictEqual(a.armor, 0);
  assert.strictEqual(a.hp, 90);
  m.abandon('k1');
  assert.ok(b.eliminated);
  assert.strictEqual(m.result, null);
});

const driveTo = (m, p, tx, tz) => {
  const wanted = Math.atan2(-(tx - p.x), -(tz - p.z));
  const diff = Math.atan2(Math.sin(wanted - p.heading), Math.cos(wanted - p.heading));
  return { mx: Math.max(-1, Math.min(1, -diff * 3)), mz: 1 };
};

test('verseny: rajtig nem indul, a körök csak sorban számítanak, célba érés sorrendje', () => {
  const m = make('racing', 'tub_ring', 2, { rng: () => 0.5 });
  const [a, b] = m.players;
  let seq = 0;
  m.queueInput('k0', { seq: (seq += 1), mx: 0, mz: 1, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ability: false, interact: false });
  m.tick();
  assert.strictEqual(a.speed, 0, 'rajt előtt áll');

  // Pályalevágás: csak a cél körül köröz, kört mégsem kap
  a.x = m.world.track.checkpoints[0][0]; a.z = m.world.track.checkpoints[0][1];
  run(m, 4);
  assert.strictEqual(a.lap, 0);

  run(m, 280, () => {
    const cp = m.world.track.checkpoints[a.checkpoint % 8];
    m.queueInput('k0', { seq: (seq += 1), ...driveTo(m, a, cp[0], cp[1]), yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ability: false, interact: false });
  });
  assert.ok(m.result, 'a verseny lezárult');
  assert.strictEqual(a.lap, 3, `körök: ${a.lap}`);
  assert.strictEqual(m.result.winner, a.side);
  assert.strictEqual(a.place, 1);
  assert.strictEqual(b.place, 2);
  assert.strictEqual(m.result.players[0].outcome, 'win');
  assert.strictEqual(m.result.players[0].counters.race_wins, 1);
  assert.strictEqual(m.result.players[1].outcome, 'loss');
});

test('verseny: tárgyak hatnak, akna megállít, nem lehet tárggyal lövöldözni', () => {
  const m = make('racing', 'tub_ring', 2, { rng: () => 0.1 });
  const [a, b] = m.players;
  m.time = 5; m.state.startAt = 0;
  a.item = 'boost';
  m.queueInput('k0', { seq: 1, mx: 0, mz: 1, yaw: 0, pitch: 0, jump: false, sprint: false, fire: true, ability: true, interact: false });
  m.tick();
  assert.ok(a.boostTime > 0);
  assert.strictEqual(a.item, null);
  assert.strictEqual(b.hp, 100, 'a verseny nem sebez');
  m.state.mines.push({ id: 1, x: b.x, z: b.z, owner: 0, armAt: 0 });
  m.tick();
  assert.ok(b.stunTime > 0);
  assert.strictEqual(m.state.mines.length, 0);
});

test('jármű: terepen lassabb, falnak ütközve lassul, a kliens másolata pontosan egyezik', async () => {
  const world = MAPS.tub_ring;
  const onRoad = { x: world.track.routes[0].points[0][0], y: 0, z: 0, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, dashX: 0, dashZ: 0, speed: 0, heading: 0, nitro: 0, boostTime: 0, stunTime: 0 };
  const off = { ...onRoad, x: 0, z: 0 };
  assert.ok(physics.onTrack(world.track, world.track.routes[0].points[0][0], world.track.routes[0].points[0][1]));
  assert.ok(!physics.onTrack(world.track, 0, 0));
  for (let i = 0; i < 90; i += 1) physics.stepVehicle(off, { mx: 0, mz: 1 }, world, 1 / 30);
  assert.ok(off.speed <= physics.VEHICLE.maxSpeed * physics.VEHICLE.offroad + 0.01);

  const client = await importFrontendModule('movement');
  const [x, z] = world.track.routes[0].points[3];
  const make2 = () => ({ x, y: 0, z, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, dashX: 0, dashZ: 0, speed: 3, heading: 1, nitro: 60, boostTime: 0.5, stunTime: 0.1 });
  const [a, b] = [make2(), make2()];
  for (let i = 0; i < 900; i += 1) {
    const inp = { mx: Math.sin(i / 30), mz: i % 200 < 170 ? 1 : -1, sprint: i % 90 < 30 };
    physics.stepVehicle(a, inp, world, 1 / 30);
    client.stepVehicle(b, inp, world, 1 / 30);
    assert.deepStrictEqual({ ...b }, { ...a }, `eltérés: ${i}`);
  }
});

const clanRoster = () => [
  { key: 'a0', username: 'A', team: 'soap', side: 'a', characterId: 'bar_trooper' },
  { key: 'b0', username: 'B', team: 'grime', side: 'b', characterId: 'mold_creeper' }
];
const clan = () => new Match({ id: 'c', mode: 'clan_wars', world: MAPS.fortress, characters: CHARACTERS, roster: clanRoster(), timeLimit: 600 });

test('klánháború: a mag lerombolása győzelem, saját szerkezet nem lőhető', () => {
  const m = clan();
  const [a] = m.players;
  const core = m.structures.find((s) => s.id === 'core_b');
  m.damageStructure(core, 100, a);
  assert.strictEqual(core.hp, 2400);
  a.x = 41; a.y = 0; a.z = 0; a.yaw = -Math.PI / 2; a.pitch = 0;
  m.fire(a);
  assert.strictEqual(core.hp, 2400 - a.stats.damage, 'lövéssel is sebezhető');
  const own = m.structures.find((s) => s.id === 'core_a');
  a.x = -41; a.yaw = Math.PI / 2; m.time = 99; a.nextFireAt = 0;
  m.fire(a);
  assert.strictEqual(own.hp, 2500);
  m.damageStructure(core, 1e6, a);
  assert.strictEqual(m.result.winner, 'a');
  assert.strictEqual(m.result.reason, 'core_destroyed');
  assert.strictEqual(m.result.players[0].counters.clan_war_wins, 1);
});

test('klánháború: pont-elfoglalás, nyersanyag, ostrom-bónusz, tornyok lőnek, a pontok tartása nyer', () => {
  const m = clan();
  const [a, b] = m.players;
  a.protectedUntil = 1e9;
  b.protectedUntil = 1e9;
  const nodes = m.state.nodes;
  a.x = nodes[0].x; a.z = nodes[0].z;
  run(m, 4.2);
  assert.strictEqual(nodes[0].owner, 'a');
  assert.ok(a.counters.nodes_captured >= 1);
  run(m, 2.2);
  assert.ok(m.state.resources.a > 0);
  m.state.resources.a = 99;
  run(m, 1.1);
  assert.ok(m.time < m.state.siegeUntil.a, 'az ostrom elindult');
  const core = m.structures.find((s) => s.id === 'core_b');
  m.damageStructure(core, 100, a);
  assert.strictEqual(core.hp, 2500 - 150, 'ostrommal 1.5x');

  b.protectedUntil = 0; b.hp = 100; b.x = -38; b.z = -6;
  run(m, 2);
  assert.ok(b.hp < 100, 'a torony lő');
  b.protectedUntil = 1e9;
  nodes.forEach((n) => { n.owner = 'a'; });
  m.players.forEach((p) => { p.protectedUntil = 1e9; });
  b.x = 50; b.z = 25;
  run(m, 62);
  assert.strictEqual(m.result.winner, 'a');
  assert.strictEqual(m.result.reason, 'objectives');
});

test('klánháború: idő lejártakor a több életű mag nyer', () => {
  const m = new Match({ id: 'c', mode: 'clan_wars', world: MAPS.fortress, characters: CHARACTERS, roster: clanRoster(), timeLimit: 0.2 });
  m.structures.find((s) => s.id === 'core_a').hp = 100;
  m.players.forEach((p) => { p.protectedUntil = 1e9; });
  run(m, 1);
  assert.strictEqual(m.result.winner, 'b');
});

test('káosz esemény: véletlen, kikapcsolható, duplázza a tűzgyorsaságot', () => {
  const m = make('team_deathmatch', 'bathroom_arena', 2, { rng: () => 0 });
  m.tick();
  assert.ok(m.chaosUntil > 0);
  assert.ok(m.chaosSeen);
  const [a] = m.players;
  m.time = m.chaosUntil - 1;
  a.nextFireAt = 0;
  m.fire(a);
  assert.ok(Math.abs(a.nextFireAt - (m.time + a.stats.fireCooldown / 2)) < 1e-6);
  const off = make('team_deathmatch', 'bathroom_arena', 2, { rng: () => 0, options: { chaos: false } });
  off.tick();
  assert.strictEqual(off.chaosUntil, 0);
});

test('minden pályán a kezdőpontok szabadok és a pályán belül vannak', () => {
  for (const [id, world] of Object.entries(MAPS)) {
    for (const spots of Object.values(world.spawns)) {
      for (const [x, , z] of spots) {
        assert.ok(x > world.bounds.minX && x < world.bounds.maxX && z > world.bounds.minZ && z < world.bounds.maxZ, `${id} ${x},${z}`);
        for (const c of world.colliders) assert.ok(!(x > c.min[0] && x < c.max[0] && z > c.min[2] && z < c.max[2]), `${id} ütközik: ${x},${z}`);
      }
    }
  }
});
