// Phase C through SweepersService / SweepersRoom: sweep_hit checks and fixed credit, interest and
// chunk bursts, personal updates, actions, the shop, Kofola, acid, the starter grant and persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { ChunkInterest, DROP_RADIUS_M, LOAD_RADIUS_M, TICK_MAX_CHUNKS } from '../../../src/modules/sweepers/debris/ChunkInterest.ts';
import { chunkCentre, debrisGrid } from '../../../src/modules/sweepers/debris/grid.ts';
import { parsePersonal, serialisePersonal } from '../../../src/modules/sweepers/debris/personal.ts';
import type { PersonalStatePayload } from '../../../src/modules/sweepers/debris/personal.ts';
import { KIND } from '../../../src/modules/sweepers/debris/tables.ts';
import { fullBudget, MAX_SPEED, SPEED_TOLERANCE, validateMove } from '../../../src/modules/sweepers/motion.ts';
import type { SweepHit } from '../../../src/modules/sweepers/payloads.ts';
import { SweepersError } from '../../../src/modules/sweepers/SweepersError.ts';
import { SweepersRepository } from '../../../src/modules/sweepers/SweepersRepository.ts';
import { NEW_PLAYER_STATS } from '../../../src/modules/sweepers/SweepersRoom.ts';
import type { DebrisChunkUpdate, PlayerTickRow, TickSyncPayload } from '../../../src/modules/sweepers/types.ts';
import { MISKOLC_STATS_JSON_MIGRATION, MISKOLC_SWEEPERS_MIGRATION } from '../../../src/infrastructure/database/schema/migrations.ts';
import { HEX_CELLS } from '../../../src/modules/sweepers/hexGrid.ts';
import { cellAt, put } from './debrisSupport.ts';
import { guest, makeService, OPEN_WORLD } from './support.ts';

const ROOM = 'hang-chill';
const TICK_MS = 84;

function joined(name = 'Alice', socket = 's1') {
  const t = makeService();
  t.service.join(ROOM, socket, guest(name));
  const room = t.service.room(ROOM);
  const player = room?.bySocket(socket);
  assert.ok(room && player);
  let seq = 0;
  const hit = (extra: Partial<SweepHit> = {}): SweepHit =>
    ({ channelId: ROOM, seq: ++seq, tool: player.personal.toolTier, alt: false, x: player.pose.x, z: player.pose.z, rotY: player.pose.rotY, ...extra });
  const tick = (ms = TICK_MS): void => { t.clock.ms += ms; t.service.tick(); };
  return { ...t, room, player, hit, tick };
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SweepersError) return `${err.code}:${err.message}`;
    throw err;
  }
  return 'ok';
};
const TOO_FAST = `${SweepersError.TOO_FAST_CODE}:Túl gyorsan próbálkozol, várj egy kicsit.`;
const REFUSED = (text: string): string => `${SweepersError.CODE}:${text}`;

test('sweep_hit checks in order: not in room, equipped tool, seq and cadence (silent), distance, locked district', () => {
  const { service, player, hit, clock, room } = joined();
  assert.equal(code(() => service.sweepHit('nobody', hit())), REFUSED('Nem vagy ebben a világban.'));
  assert.equal(code(() => service.sweepHit('s1', hit({ tool: 3 }))), REFUSED('Nem ez az eszköz van a kezedben.'));
  assert.equal(code(() => service.sweepHit('s1', hit())), 'ok');
  assert.equal(code(() => service.sweepHit('s1', hit())), TOO_FAST, 'before 0.8 × cadence');
  clock.ms += 400;
  assert.equal(code(() => service.sweepHit('s1', hit({ seq: 1 }))), TOO_FAST, 'stale seq');
  assert.equal(code(() => service.sweepHit('s1', hit())), 'ok', 'exactly 0.8 × 0.5 s later');
  clock.ms += 1000;
  assert.equal(code(() => service.sweepHit('s1', hit({ x: player.pose.x + 1.6 }))), REFUSED('Túl messze vagy ehhez.'));
  // Stand at the east edge of the centre hex: an origin 1.2 m further east is in locked Avas.
  player.pose = { ...player.pose, x: 34, z: 0 };
  clock.ms += 1000;
  assert.equal(code(() => service.sweepHit('s1', hit({ x: 35.2 }))), REFUSED('Ez a kerület még le van zárva.'));
  assert.deepEqual(room.unlockedDistricts(), [0]);
});

test('fixed credit: a use credits its cadence, never the elapsed time, so spamming gains nothing', () => {
  const fast = joined();
  const slow = joined();
  const ackFast = [fast.service.sweepHit('s1', fast.hit())];
  fast.clock.ms += 400;
  ackFast.push(fast.service.sweepHit('s1', fast.hit()));
  for (let i = 0; i < 5; i++) {
    fast.clock.ms += 50;
    assert.equal(code(() => fast.service.sweepHit('s1', fast.hit())), TOO_FAST);
  }
  const ackSlow = [slow.service.sweepHit('s1', slow.hit())];
  slow.clock.ms += 5_000;
  ackSlow.push(slow.service.sweepHit('s1', slow.hit()));
  assert.deepEqual(ackFast.map((a) => a.kg), ackSlow.map((a) => a.kg));
  assert.deepEqual(fast.player.personal.buf, slow.player.personal.buf);
  assert.ok((ackFast[0]?.kg ?? 0) > 0, 'the spawn point is dirty');
});

test('join burst: 32 nearest chunks at once, the rest of the 48 m disc within 8 ticks, ≤ 50 kB in all', () => {
  const t = makeService();
  const cleanliness: Record<string, number> = {};
  for (const cell of HEX_CELLS) cleanliness[String(cell.id)] = 0;
  t.store.rooms.set(ROOM, { roomId: ROOM, state: { v: 2 }, cleanliness, teamFunds: 0, lastSaved: 1 });
  t.service.join(ROOM, 's1', guest('Alice'));
  const burst = t.events.of('debrisUpdate')[0]?.[1] as DebrisChunkUpdate;
  assert.equal(burst.load?.length, 32);
  let bytes = JSON.stringify(burst).length;
  let ticks = 0;
  const player = t.service.room(ROOM)?.bySocket('s1');
  assert.ok(player);
  while (player.interest.pending > 0 && ticks < 20) {
    t.events.clear();
    t.clock.ms += TICK_MS;
    t.service.tick();
    ticks++;
    const update = t.events.of('debrisUpdate').find(([socket]) => socket === 's1')?.[1] as DebrisChunkUpdate | undefined;
    const load = update?.load ?? [];
    assert.ok(load.length <= TICK_MAX_CHUNKS);
    assert.ok(JSON.stringify(load).length <= 8_200, `${JSON.stringify(load).length} B in one tick`);
    bytes += JSON.stringify(load).length;
  }
  assert.ok(ticks <= 8, `${ticks} ticks`);
  assert.ok(bytes <= 50_000, `${bytes} B`);
  const pose = player.pose;
  for (const id of player.interest.known) {
    const c = chunkCentre(id);
    assert.ok(Math.hypot(c.x - pose.x, c.z - pose.z) <= LOAD_RADIUS_M);
  }
});

test('interest: recomputed only after > 4 m, dropped beyond 64 m, re-sent in full after > 32 changed cells', () => {
  const interest = new ChunkInterest(debrisGrid());
  interest.update(0, 0);
  const total = interest.pending;
  assert.ok(total > 80 && total < 140, `${total}`);
  const first = interest.take(TICK_MAX_CHUNKS, 8192, () => 300);
  assert.equal(first.length, TICK_MAX_CHUNKS);
  assert.equal(interest.take(100, 1000, () => 300).length, 3, 'byte cap');
  assert.equal(interest.take(100, 0, () => 300).length, 1, 'always at least one');
  while (interest.pending > 0) interest.take(100, Infinity, () => 1);
  assert.deepEqual(interest.update(3, 0), [], 'moved ≤ 4 m: nothing re-evaluated');
  const dropped = interest.update(100, 0);
  assert.ok(dropped.length > 0);
  for (const id of dropped) assert.ok(Math.hypot(chunkCentre(id).x - 100, chunkCentre(id).z) > DROP_RADIUS_M);
  for (const id of interest.known) assert.ok(Math.hypot(chunkCentre(id).x - 100, chunkCentre(id).z) <= DROP_RADIUS_M);
  // The > 32 rule reaches a socket that knows the chunk as a full `load`.
  const { room, player, tick, events } = joined();
  while (player.interest.pending > 0) tick();
  const index = cellAt(room.debris, player.pose.x, player.pose.z);
  const slot = index >> 8;
  for (let i = 0; i < 40; i++) room.debris.setCell(slot * 256 + i, 0x77);
  events.clear();
  tick();
  const update = events.of('debrisUpdate')[0]?.[1] as DebrisChunkUpdate;
  const chunkId = debrisGrid().liveChunks[slot];
  assert.ok(update.load?.some((l) => l.id === chunkId));
  assert.ok(!(update.cells ?? []).some((v, i) => i % 3 === 0 && v === chunkId));
});

test('deltas and personal updates: the swept cells reach every socket; personal once per tick, stamina-only every 500 ms', () => {
  const { service, hit, tick, events, player } = joined();
  service.join(ROOM, 's2', guest('Bob'));
  while (player.interest.pending > 0) tick();
  events.clear();
  const ack = service.sweepHit('s1', hit());
  assert.ok(ack.kg > 0);
  tick();
  const updates = events.of('debrisUpdate');
  assert.ok(updates.some(([s, u]) => s === 's2' && ((u as DebrisChunkUpdate).cells ?? []).length > 0), 'peer sees the cells');
  const personal = events.of('personalUpdate');
  assert.deepEqual(personal.map(([s]) => s), ['s1']);
  const state = personal[0]?.[1] as PersonalStatePayload;
  assert.equal(state.stamina, 995);
  assert.ok(state.buf.kg > 0 && state.caps.bufKg === 0.5);
  events.clear();
  tick();
  assert.equal(events.of('personalUpdate').length, 0, 'nothing changed');
  // Regeneration starts 1 s after the use: IDLE +3/s; stamina-only updates at most every 500 ms.
  events.clear();
  for (let i = 0; i < 24; i++) tick();
  assert.equal(player.personal.stamina, 1000);
  const staminaUpdates = events.of('personalUpdate').length;
  assert.ok(staminaUpdates >= 1 && staminaUpdates <= 4, `${staminaUpdates}`);
});

test('tick rows carry the tool; select tips the buffer (overflow spilled), refuses unowned tools; dump; kick checks', () => {
  const { service, room, player, hit, tick, events } = joined();
  assert.equal(code(() => service.playerAction('s1', { channelId: ROOM, kind: 'select', tool: 3 })), REFUSED('Ez az eszköz még nincs meg neked.'));
  service.sweepHit('s1', hit());
  const buffered = player.personal.buf.dustG;
  assert.ok(buffered > 0);
  service.playerAction('s1', { channelId: ROOM, kind: 'select', tool: 7 });
  assert.equal(player.personal.buf.dustG, 0);
  assert.ok(Math.abs(player.personal.pack.dustG - buffered) < 1e-9);
  events.clear();
  tick();
  const row = (events.of('tickSync')[0]?.[1] as TickSyncPayload).p.find((r: PlayerTickRow) => r[0] === player.id);
  assert.equal(row?.length, 9);
  assert.equal(row?.[7], 7);
  // Overflow on a tool switch: the pack is full, so the buffer is dropped at the feet.
  player.personal.owned |= 1 << 3;
  service.playerAction('s1', { channelId: ROOM, kind: 'select', tool: 3 });
  player.personal.pack.ironG = 10_000;
  player.personal.buf.dustG = 2_000;
  const items = room.debris.itemCount;
  service.playerAction('s1', { channelId: ROOM, kind: 'select', tool: 0 });
  assert.equal(player.personal.buf.dustG, 0);
  assert.equal(room.debris.itemCount, items + 1, 'a pile at the feet');
  // Dump empties pack and buffer; then there is nothing to dump.
  service.playerAction('s1', { channelId: ROOM, kind: 'dump' });
  assert.equal(player.personal.pack.ironG, 0);
  assert.equal(code(() => service.playerAction('s1', { channelId: ROOM, kind: 'dump' })), REFUSED('Üres a hátizsák.'));
  // Kick: unknown item, too far, too fast (silent), accepted.
  const can = put(room.debris, KIND.can, player.pose.x + 0.8, player.pose.z, 5);
  assert.equal(code(() => service.playerAction('s1', { channelId: ROOM, kind: 'kick', id: 0x7fffffff, vx: 1, vz: 0 })), REFUSED('Ismeretlen tárgy.'));
  assert.equal(code(() => service.playerAction('s1', { channelId: ROOM, kind: 'kick', id: can.id, vx: 9.1, vz: 0 })), TOO_FAST);
  service.playerAction('s1', { channelId: ROOM, kind: 'kick', id: can.id, vx: 2, vz: 0 });
  assert.equal(code(() => service.playerAction('s1', { channelId: ROOM, kind: 'kick', id: can.id, vx: 2, vz: 0 })), REFUSED('Túl messze vagy ehhez.'));
  events.clear();
  tick();
  const kicked = events.of('debrisUpdate')[0]?.[1] as DebrisChunkUpdate;
  assert.equal(kicked.kicks?.[0]?.[0], can.id);
  assert.ok(kicked.add?.some((r) => r[0] === can.id), 'the rest position also goes out as a row');
});

test('shop: location, level, ownership, cash, refreshments and the repair price', () => {
  const { service, player } = joined();
  const buy = (request: Parameters<typeof service.buyUpgrade>[1]): string => code(() => service.buyUpgrade('s1', request));
  const p = player.personal;
  assert.equal(p.cash, 2000, 'starter grant');
  assert.equal(buy({ channelId: ROOM, item: 'tool', tier: 1 }), REFUSED('Ezt csak a MÉH műhelyben veheted meg.'));
  assert.equal(buy({ channelId: ROOM, item: 'beer' }), REFUSED('Frissítőt a büfében vagy a MÉH irodában vehetsz.'));
  const office = cityLayout().landmarks.office;
  player.pose = { ...player.pose, x: office.x, z: office.z - 3 };
  assert.equal(buy({ channelId: ROOM, item: 'tool', tier: 2 }), REFUSED('Nincs elég pénzed: 6 000 Ft kell.'));
  assert.equal(service.buyUpgrade('s1', { channelId: ROOM, item: 'tool', tier: 1 }).cash, 500);
  assert.equal(p.toolTier, 0, 'bought, not equipped');
  assert.equal(buy({ channelId: ROOM, item: 'tool', tier: 1 }), REFUSED('Ez már megvan.'));
  p.cash = 1_000_000;
  assert.equal(buy({ channelId: ROOM, item: 'pack', level: 2 }), REFUSED('Közben változott a szinted, próbáld újra.'));
  assert.equal(buy({ channelId: ROOM, item: 'pack', level: 1 }), 'ok');
  assert.equal(p.backpackTier, 1);
  for (let level = 1; level <= 3; level++) assert.equal(buy({ channelId: ROOM, item: 'hard', level }), 'ok');
  assert.equal(buy({ channelId: ROOM, item: 'hard', level: 4 }), REFUSED('Ez már a legmagasabb szint.'));
  assert.equal(buy({ channelId: ROOM, item: 'repair', tier: 2 }), REFUSED('Ez az eszköz még nincs meg neked.'));
  assert.equal(buy({ channelId: ROOM, item: 'repair', tier: 1 }), REFUSED('Ez az eszköz nem szorul javításra.'));
  p.dur[0] = 500;
  const before = p.cash;
  assert.equal(buy({ channelId: ROOM, item: 'repair', tier: 1 }), 'ok');
  assert.deepEqual([before - p.cash, p.dur[0]], [150, 1000], '10 % of 1 500 Ft');
  assert.equal(buy({ channelId: ROOM, item: 'fuel' }), REFUSED('Tele a tartály.'));
  assert.equal(buy({ channelId: ROOM, item: 'gloves' }), 'ok');
  assert.equal(buy({ channelId: ROOM, item: 'gloves' }), REFUSED('Ez már megvan.'));
  p.stamina = 300;
  assert.equal(buy({ channelId: ROOM, item: 'beer' }), 'ok');
  assert.equal(p.stamina, 800);
  assert.ok((p.fx.beer ?? 0) > 0);
  assert.equal(buy({ channelId: ROOM, item: 'zsiros' }), 'ok');
  assert.equal(p.stamina, 1000);
  // Refreshments at a ticket kiosk (4 m), not further.
  const kiosk = cityLayout().buildings.find((b) => b.kind === 'ticket_kiosk');
  assert.ok(kiosk);
  player.pose = { ...player.pose, x: kiosk.x + 3.5, z: kiosk.z };
  assert.equal(buy({ channelId: ROOM, item: 'kofola' }), 'ok');
  player.pose = { ...player.pose, x: kiosk.x + 4.5, z: kiosk.z };
  assert.equal(buy({ channelId: ROOM, item: 'kofola' }), REFUSED('Frissítőt a büfében vagy a MÉH irodában vehetsz.'));
});

test('Kofola: the movement budget ×1.15 on the server while the effect lasts', () => {
  const start = { x: 0, y: 0, z: 0, rotY: 0, state: 'SPRINT' as const };
  const distance = 0.5 * MAX_SPEED * SPEED_TOLERANCE * 1.1;
  const requested = { ...start, x: distance };
  const budget = { ...fullBudget(0), metres: 0 };
  assert.equal(validateMove(start, requested, budget, 500, OPEN_WORLD).corrected, true);
  assert.equal(validateMove(start, requested, budget, 500, OPEN_WORLD, 1.15).corrected, false);
  const { room, player, clock } = joined();
  assert.equal(room.speedFactor(player, clock.ms), 1);
  player.personal.fx.kofola = clock.ms + 45_000;
  assert.equal(room.speedFactor(player, clock.ms), 1.15);
  assert.equal(room.speedFactor(player, clock.ms + 45_000), 1, 'expired');
});

test('acid: −20 stamina on an accepted input on acid, at most once per 3 s', () => {
  const { room, player, clock } = joined();
  const acid = cityLayout().surfaces.find((s) => s.kind === 'acid');
  assert.ok(acid);
  player.pose = { ...player.pose, x: acid.x, z: acid.z };
  room.afterInput(player, clock.ms);
  assert.equal(player.personal.stamina, 800);
  room.afterInput(player, clock.ms + 2_999);
  assert.equal(player.personal.stamina, 800);
  room.afterInput(player, clock.ms + 3_000);
  assert.equal(player.personal.stamina, 600);
  player.pose = { ...player.pose, x: 3, z: 3 };
  room.afterInput(player, clock.ms + 9_000);
  assert.equal(player.personal.stamina, 600, 'dry ground');
});

test('starter grant: new row, v1 row, already granted row, reload, duplicate guests — paid once per stats row', () => {
  const t = makeService();
  t.store.stats.set(`name:veteran|${ROOM}`, { stats: { cash: 77, toolTier: 2, backpackTier: 1, totalKg: 3 }, extra: null });
  t.store.stats.set(`name:granted|${ROOM}`, { stats: { cash: 77, toolTier: 0, backpackTier: 0, totalKg: 0 }, extra: { v: 2, starter: true } });
  t.service.join(ROOM, 'a', guest('Newbie'));
  t.service.join(ROOM, 'b', guest('Veteran'));
  t.service.join(ROOM, 'c', guest('Granted'));
  const cash = (socket: string): number | undefined => t.service.room(ROOM)?.bySocket(socket)?.personal.cash;
  assert.deepEqual([cash('a'), cash('b'), cash('c')], [2000, 2077, 77]);
  assert.equal(t.store.stats.get(`name:newbie|${ROOM}`)?.extra?.['starter'], true, 'persisted at once');
  assert.equal(t.store.stats.get(`name:veteran|${ROOM}`)?.stats.cash, 2077);
  // The v1 row's equipped tool 2 is not owned (no stats_json): it falls back to 0.
  assert.equal(t.service.room(ROOM)?.bySocket('b')?.personal.toolTier, 0);
  t.service.leave('a');
  t.service.join(ROOM, 'a2', guest('Newbie'));
  assert.equal(cash('a2'), 2000, 'a reload pays nothing');
  // A second live guest with the same name gets its own record but shares the stats row.
  t.service.join(ROOM, 'a3', guest('Newbie'));
  assert.equal(cash('a3'), 2000);
  t.service.dispose();
  assert.equal(t.store.stats.get(`name:newbie|${ROOM}`)?.stats.cash, 2000);
});

test('personal state: v1 defaults, clamping, owned tool rule, load → save → load stable', () => {
  const { data, granted } = parsePersonal({ ...NEW_PLAYER_STATS }, null, 0);
  assert.equal(granted, true);
  assert.deepEqual(
    { owned: data.owned, widthLvl: data.widthLvl, hardLvl: data.hardLvl, gloves: data.gloves, dur: data.dur, fuelMl: data.fuelMl, stamina: data.stamina, clogged: data.clogged },
    { owned: 0b10000001, widthLvl: 0, hardLvl: 0, gloves: false, dur: [1000, 1000, 1000], fuelMl: 2000, stamina: 1000, clogged: false }
  );
  const odd = parsePersonal({ cash: 5, toolTier: 9, backpackTier: 7, totalKg: -1 }, {
    starter: true, owned: 0b0100, widthLvl: 99, hardLvl: -1, gloves: 'yes', dur: [5000, -3, 'x'], fuelMl: 1e9, stamina: -5,
    buf: { dustG: -10, cans: 2.5, jackpots: [5, 9] }, fx: { kofola: 2000, beer: -1 }
  }, 100).data;
  assert.deepEqual([odd.toolTier, odd.backpackTier, odd.totalKg, odd.owned], [0, 0, 0, 0b10000101]);
  assert.deepEqual([odd.widthLvl, odd.hardLvl, odd.gloves, odd.dur, odd.fuelMl, odd.stamina], [0, 0, false, [1000, 0, 1000], 2000, 0]);
  assert.deepEqual([odd.buf.dustG, odd.buf.cans, odd.buf.jackpots], [0, 0, [5]]);
  assert.deepEqual(odd.fx, { kofola: 2100 });
  odd.pack.ironG = 1234;
  const saved = JSON.parse(JSON.stringify(serialisePersonal(odd, 500))) as Record<string, unknown>;
  const again = parsePersonal({ cash: odd.cash, toolTier: odd.toolTier, backpackTier: odd.backpackTier, totalKg: odd.totalKg }, saved, 500);
  assert.equal(again.granted, false);
  assert.deepEqual(again.data, odd);
});

test('stats_json migration: idempotent; a v1 row (NULL stats_json) loads with extra null', () => {
  const db = new Database(':memory:');
  MISKOLC_SWEEPERS_MIGRATION.apply(db);
  db.prepare('INSERT INTO miskolc_player_stats VALUES (?, ?, ?, ?, ?, ?)').run('name:old', 'r', 9, 1, 0, 2.5);
  MISKOLC_STATS_JSON_MIGRATION.apply(db);
  MISKOLC_STATS_JSON_MIGRATION.apply(db);
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('miskolc_player_stats') as Array<{ name: string }>;
  assert.equal(columns.filter((c) => c.name === 'stats_json').length, 1);
  const repo = new SweepersRepository({ connection: db });
  assert.deepEqual(repo.loadPlayerStats('name:old', 'r'), { stats: { cash: 9, toolTier: 1, backpackTier: 0, totalKg: 2.5 }, extra: null });
  db.close();
});

test('room persistence: v2 → v3, v3 round trip (cells and items), a corrupt blob regenerates', () => {
  const first = makeService();
  const cleanliness: Record<string, number> = { 0: 40 };
  first.store.rooms.set(ROOM, { roomId: ROOM, state: { v: 2, lifetimeEarned: 0 }, cleanliness, teamFunds: 0, lastSaved: 1 });
  first.service.join(ROOM, 's1', guest('Alice'));
  const room = first.service.room(ROOM);
  assert.ok(room);
  const marker = put(room.debris, KIND.iron, 3, 3, 777);
  first.service.dispose();
  const stored = first.store.rooms.get(ROOM);
  assert.equal(stored?.state['v'], 4);
  assert.ok(Math.abs((stored?.cleanliness['0'] ?? 0) - 40) <= 2);
  const debris = stored?.state['debris'];
  assert.ok(typeof debris === 'object' && debris !== null);

  const second = makeService({ store: first.store });
  second.service.join(ROOM, 's1', guest('Alice'));
  const restored = second.service.room(ROOM)?.debris;
  assert.equal(restored?.items.get(marker.id)?.massDg, 777);
  assert.equal(restored?.record().cells, room.debris.record().cells);

  const corrupt = makeService();
  corrupt.store.rooms.set(ROOM, { roomId: ROOM, state: { ...stored?.state, debris: { ...debris, cells: '!!!' } }, cleanliness, teamFunds: 0, lastSaved: 1 });
  corrupt.service.join(ROOM, 's1', guest('Alice'));
  const regenerated = corrupt.service.room(ROOM)?.debris;
  assert.equal(regenerated?.items.has(marker.id) && regenerated.items.get(marker.id)?.massDg === 777, false);
  assert.ok(Math.abs((regenerated?.c10(0) ?? 0) / 10 - 40) <= 2, 'from the stored cleanliness');
});

test('respawn runs on loaded room time only: a long gap between ticks credits at most 1 s', () => {
  const { room, tick } = joined();
  const before = room.debris.respawnInMs;
  tick(3_600_000);
  assert.equal(before - room.debris.respawnInMs, 1_000);
});
