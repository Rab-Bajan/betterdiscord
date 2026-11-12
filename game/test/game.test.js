const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');
const { CHARACTERS, BATHROOM_ARENA } = require('../content');
const physics = require('../physics');
const { Match } = require('../simulation');
const { createGameStore } = require('../store');
const { xpForLevel, levelFromXp, xpForMatch, isRewardable, MAX_MATCH_XP } = require('../progression');
const { importFrontendModule } = require('../../test/support/frontendModule.cjs');

const openWorld = { bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50, height: 20 }, colliders: [], spawns: { soap: [[0, 0, 0]], grime: [[0, 0, -10]] } };
const makeMatch = (opts = {}, a = 'bar_trooper', b = 'mold_creeper') =>
  new Match({
    id: 'm1', world: openWorld, characters: CHARACTERS,
    roster: [{ key: 'a', username: 'A', team: 'soap', characterId: a }, { key: 'b', username: 'B', team: 'grime', characterId: b }],
    ...opts
  });
const input = (seq, over = {}) => ({ seq, mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ability: false, ...over });
const clearProtection = (m) => m.players.forEach((p) => { p.protectedUntil = 0; });

test('sebesség: a gyorsabb bemenet-küldés nem növeli a mozgást', () => {
  const run = (perTick) => {
    const m = makeMatch();
    let seq = 0;
    for (let t = 0; t < 30; t += 1) {
      for (let i = 0; i < perTick; i += 1) m.queueInput('a', input((seq += 1), { mz: 1 }));
      m.tick();
    }
    return Math.abs(m.players[0].z);
  };
  const normal = run(1);
  assert.ok(Math.abs(normal - CHARACTERS.bar_trooper.speed) < 0.3, `1 mp alatt ${normal}`);
  assert.ok(Math.abs(run(20) - normal) < 0.01);
});

test('a falon nem lehet átmenni', () => {
  const body = { x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, dashX: 0, dashZ: 0 };
  const world = { ...openWorld, colliders: [{ min: [-5, 0, -3], max: [5, 3, -2] }] };
  for (let i = 0; i < 120; i += 1) physics.stepMovement(body, { mx: 0, mz: 1, yaw: 0 }, 8, world, 1 / 30);
  assert.strictEqual(body.z, -2 + physics.BODY_RADIUS);
});

test('ugrás és gravitáció, fedezékre fel lehet állni', () => {
  const body = { x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, dashX: 0, dashZ: 0 };
  const world = { ...openWorld, colliders: [{ min: [-5, 0, -3], max: [5, 1, -1] }] };
  physics.stepMovement(body, { mx: 0, mz: 0, yaw: 0, jump: true }, 6, world, 1 / 30);
  assert.ok(body.y > 0);
  for (let i = 0; i < 9; i += 1) physics.stepMovement(body, { mx: 0, mz: 0, yaw: 0 }, 6, world, 1 / 30);
  assert.ok(body.y > 1.2, 'már a párkány fölött van');
  for (let i = 0; i < 9; i += 1) physics.stepMovement(body, { mx: 0, mz: 1, yaw: 0 }, 6, world, 1 / 30);
  for (let i = 0; i < 30; i += 1) physics.stepMovement(body, { mx: 0, mz: 0, yaw: 0 }, 6, world, 1 / 30);
  assert.strictEqual(body.y, 1);
});

test('a kliens előrejelzése pontosan egyezik a szerver mozgásával', async () => {
  const client = await importFrontendModule('movement');
  const make = () => ({ x: -30, y: 0, z: 2, vy: 0, kx: 3, kz: -2, onGround: true, dashTime: 0.1, dashX: 5, dashZ: 9 });
  const [a, b] = [make(), make()];
  for (let i = 0; i < 600; i += 1) {
    const inp = { mx: Math.sin(i / 17), mz: Math.cos(i / 23), yaw: i / 40, jump: i % 37 === 0, sprint: i % 50 < 25 };
    physics.stepMovement(a, inp, 6.5, BATHROOM_ARENA, 1 / 30);
    client.stepMovement(b, inp, 6.5, BATHROOM_ARENA, 1 / 30);
    assert.deepStrictEqual({ ...b }, { ...a }, `eltérés a(z) ${i}. lépésben`);
  }
});

test('lövés: tűzgyorsaságot a szerver korlátozza', () => {
  const m = makeMatch();
  clearProtection(m);
  let seq = 0;
  for (let t = 0; t < 30; t += 1) { m.queueInput('a', input((seq += 1), { fire: true })); m.tick(); clearProtection(m); }
  const expected = Math.ceil(1 / CHARACTERS.bar_trooper.fireCooldown);
  assert.ok(Math.abs(m.players[0].damage / CHARACTERS.bar_trooper.damage - expected) <= 1, `sebzés ${m.players[0].damage}`);
});

test('fal blokkolja a lövést, csapattárs nem sebezhető', () => {
  const walled = new Match({
    id: 'w', characters: CHARACTERS, world: { ...openWorld, colliders: [{ min: [-3, 0, -6], max: [3, 5, -5] }] },
    roster: [{ key: 'a', username: 'A', team: 'soap', characterId: 'bar_trooper' }, { key: 'b', username: 'B', team: 'grime', characterId: 'mold_creeper' }]
  });
  clearProtection(walled);
  walled.queueInput('a', input(1, { fire: true }));
  walled.tick();
  assert.strictEqual(walled.players[1].hp, 100);

  const mates = new Match({
    id: 'f', characters: CHARACTERS, world: { ...openWorld, spawns: { soap: [[0, 0, 0], [0, 0, -5]], grime: [[40, 0, 40]] } },
    roster: [{ key: 'a', username: 'A', team: 'soap', characterId: 'bar_trooper' }, { key: 'c', username: 'C', team: 'soap', characterId: 'bar_trooper' }, { key: 'b', username: 'B', team: 'grime', characterId: 'mold_creeper' }]
  });
  clearProtection(mates);
  mates.queueInput('a', input(1, { fire: true }));
  mates.tick();
  assert.strictEqual(mates.players[1].hp, 100);
});

test('újraéledési védelem alatt nincs sebzés', () => {
  const m = makeMatch();
  m.queueInput('a', input(1, { fire: true }));
  m.tick();
  assert.strictEqual(m.players[1].hp, 100);
});

test('képességek: visszatöltés, pajzs, roham, robbanás', () => {
  const m = makeMatch({}, 'bar_trooper', 'hairball_brute');
  clearProtection(m);
  m.players[1].z = -3;
  m.queueInput('a', input(1, { ability: true }));
  m.tick();
  const hpAfter = m.players[1].hp;
  assert.strictEqual(hpAfter, 170 - 25);
  assert.ok(m.players[1].kz < 0, 'a robbanás ellöki');
  m.queueInput('a', input(2, { ability: true }));
  m.tick();
  assert.strictEqual(m.players[1].hp, hpAfter, 'visszatöltés alatt nem sül el újra');

  m.queueInput('b', input(1, { ability: true }));
  m.tick();
  m.players[0].abilityReadyAt = 0;
  m.players[1].z = -3; m.players[1].x = 0;
  const before = m.players[1].hp;
  m.queueInput('a', input(3, { ability: true }));
  m.tick();
  assert.strictEqual(before - m.players[1].hp, 10, 'pajzs 60%-kal csökkent');

  const d = makeMatch({}, 'rinse_runner');
  d.queueInput('a', input(1, { ability: true }));
  d.tick();
  d.tick();
  d.tick();
  assert.ok(Math.abs(d.players[0].z) > 0.7, 'a roham gyorsan visz előre');
});

test('ölés, gólpassz, pontszám, újraéledés és győzelem', () => {
  const m = makeMatch({ scoreLimit: 2 });
  clearProtection(m);
  const [a, b] = m.players;
  b.hp = 10;
  m.damage(b, 14, a);
  assert.strictEqual(b.alive, false);
  assert.strictEqual(a.kills, 1);
  assert.strictEqual(b.deaths, 1);
  assert.strictEqual(m.score.soap, 1);
  for (let i = 0; i < 4 * 30 + 1; i += 1) m.tick();
  assert.strictEqual(b.alive, true);
  assert.strictEqual(b.hp, 100);
  clearProtection(m);
  b.hp = 1;
  m.damage(b, 14, a);
  assert.strictEqual(m.result.winner, 'soap');
  assert.strictEqual(m.result.reason, 'score');
});

test('idő lejártakor döntetlen vagy a vezető nyer', () => {
  const m = makeMatch({ timeLimit: 0.1 });
  for (let i = 0; i < 4; i += 1) m.tick();
  assert.strictEqual(m.result.winner, null);
  assert.strictEqual(m.result.reason, 'time');
});

test('ha egy csapat elfogy, a meccs abandoned', () => {
  const m = makeMatch();
  m.abandon('b');
  assert.strictEqual(m.result.reason, 'abandoned');
  assert.strictEqual(m.result.winner, 'soap');
});

test('XP és szintek', () => {
  assert.strictEqual(xpForLevel(1), 0);
  assert.strictEqual(levelFromXp(0), 1);
  assert.strictEqual(levelFromXp(xpForLevel(5)), 5);
  assert.strictEqual(levelFromXp(xpForLevel(5) - 1), 4);
  assert.strictEqual(levelFromXp(1e12), 100);
  assert.strictEqual(xpForMatch({ kills: 2, assists: 1, damage: 350 }, 'win'), 80 + 20 + 4 + 3);
  assert.strictEqual(xpForMatch({ kills: 1e6, assists: 0, damage: 0 }, 'win'), MAX_MATCH_XP);
});

const resultOf = (over = {}) => ({
  matchId: 'r1', winner: 'soap', reason: 'score', score: { soap: 30, grime: 2 }, durationS: 120,
  players: [
    { i: 0, key: 'acc:1', username: 'A', team: 'soap', characterId: 'bar_trooper', kills: 3, deaths: 1, assists: 0, damage: 100, connected: true, activeShare: 1 },
    { i: 1, key: 'acc:2', username: 'B', team: 'grime', characterId: 'mold_creeper', kills: 1, deaths: 3, assists: 0, damage: 50, connected: true, activeShare: 1 }
  ],
  ...over
});
const accounts = new Map([['acc:1', '1'], ['acc:2', '2']]);

test('jutalom feltételei: rövid, elhagyott, tétlen ellenfél nem jutalmaz', () => {
  const r = resultOf();
  assert.ok(isRewardable(r, r.players[0]));
  assert.ok(!isRewardable(resultOf({ durationS: 10 }), r.players[0]));
  assert.ok(!isRewardable(resultOf({ reason: 'abandoned' }), r.players[0]));
  const idle = resultOf();
  idle.players[1].activeShare = 0.1;
  assert.ok(!isRewardable(idle, idle.players[0]), 'tétlen ellenfél ellen nem farmolható');
});

test('mentés: tartós, és ugyanaz a meccs nem jutalmaz kétszer', () => {
  const store = createGameStore(new Database(':memory:'));
  const first = store.recordMatch(resultOf(), 'room', accounts);
  assert.strictEqual(first.rewards[0].xp, 80 + 30 + 1);
  const xp = store.getProfile('1').xp;
  const second = store.recordMatch(resultOf(), 'room', accounts);
  assert.strictEqual(second.duplicate, true);
  const p = store.getProfile('1');
  assert.strictEqual(p.xp, xp);
  assert.strictEqual(p.matches, 1);
  assert.strictEqual(p.wins, 1);
  assert.strictEqual(store.getProfile('2').losses, 1);
});

test('mentés: részleges hiba esetén semmi sem kerül be', () => {
  const db = new Database(':memory:');
  const store = createGameStore(db);
  const bad = resultOf();
  bad.players[1].username = null; // NOT NULL hibát okoz a második játékosnál
  assert.throws(() => store.recordMatch(bad, 'room', accounts));
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM game_matches').get().c, 0);
  assert.strictEqual(store.getProfile('1').xp, 0);
});

test('vendég nem kap jutalmat', () => {
  const store = createGameStore(new Database(':memory:'));
  const { rewards } = store.recordMatch(resultOf(), 'room', new Map([['acc:1', '1']]));
  assert.ok(rewards[0]);
  assert.strictEqual(rewards[1], undefined);
});
