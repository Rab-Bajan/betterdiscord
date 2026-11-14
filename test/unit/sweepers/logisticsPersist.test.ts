// Phase D persistence (plan D.6): structure rows, the v4 `logistics` blob, corrupt rows, v3 → v4,
// orphan cargo into the hopper, stats_json v3 bags, and the SQLite replace in saveRoom's transaction.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { SqliteDatabase } from '../../../src/infrastructure/database/index.ts';
import { loadKg, parsePersonal, serialisePersonal, STATS_JSON_VERSION } from '../../../src/modules/sweepers/debris/personal.ts';
import type { WorldStructureRecord } from '../../../src/modules/sweepers/SweepersRepository.ts';
import { SweepersRepository } from '../../../src/modules/sweepers/SweepersRepository.ts';
import { NEW_PLAYER_STATS } from '../../../src/modules/sweepers/SweepersRoom.ts';
import { STARTER_BAGS, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import { load, ROOM, world } from './logisticsSupport.ts';

const dbPath = process.env['SHARKVOIC_DB_PATH'] ?? '';
assert.ok(dbPath.startsWith(os.tmpdir()), 'must run on the isolated test DB');
const database = new SqliteDatabase(dbPath);
after(() => database.close());

test('round trip: structures, links, cargo, buffers, ground and carried bags, the crane hook (SQLite)', () => {
  const a = world(true, { store: new SweepersRepository(database) });
  a.at(4, -2);
  const found = a.place(TYPE.found4, 9, -9);
  const onFound = a.place(TYPE.belt1, 9, -9);
  const feed = a.place(TYPE.belt1, 4, -5);
  const pk = a.place(TYPE.packager, 4, -6.5);
  const ground = a.tieAt(2, 2, { dust: 8 });
  const carried = a.tieAt(0, 3, { dust: 6 });
  a.act({ kind: 'pickup', id: carried.id });
  a.at(1, 3);
  a.tick();
  a.logistics.restoreBuffer(pk, load({ iron: 15 }));
  a.logistics.restoreCargo({ id: 900, kind: 0, sub: 2, tint: 3, node: feed, s: 0.25, route: 0, waitMs: 0, load: load({ copper: 2 }) });
  a.logistics.fillHopper(0, load({ dust: 33 }));
  a.logistics.setHook(-11, 0);
  const rows = [...a.logistics.structures.values()].map((s) => a.logistics.structRow(s));
  a.service.dispose();

  const b = world(false, { store: new SweepersRepository(database) });
  assert.deepEqual(b.room.loadWarnings, []);
  assert.equal(b.logistics.structures.get(onFound)?.base, b.logistics.structures.get(found)?.base);
  assert.equal(b.logistics.cargo.get(900)?.node, feed);
  assert.equal(b.logistics.cargo.get(900)?.s, 0.25);
  assert.ok(Math.abs(loadKg(b.logistics.bufferOf(pk) ?? load({})) - 15) < 1e-9);
  assert.ok(Math.abs(loadKg(b.logistics.bufferOf(0) ?? load({})) - 33) < 1e-9);
  assert.equal(b.logistics.bags.get(ground.id)?.st, 0);
  const dropped = b.logistics.bags.get(carried.id);
  assert.ok(dropped && dropped.st === 0 && Math.hypot(dropped.x - 1, dropped.z - 3) < 1e-9, 'a carried bag is stored at the carrier\'s feet');
  assert.deepEqual(b.logistics.hook, { x: -11, z: 0 });
  const geometry = (r: number[]): number[] => [...r.slice(0, 7), (r[7] ?? 0) & 1];
  assert.deepEqual([...b.logistics.structures.values()].map((s) => geometry(b.logistics.structRow(s))), rows.map(geometry));
  b.tick();
  // Links are rebuilt: the lot crosses into the packager and is absorbed.
  b.ticks(11);
  assert.equal(b.logistics.cargo.has(900), false);
  assert.ok(Math.abs(loadKg(b.logistics.bufferOf(pk) ?? load({})) - 17) < 1e-9);
  b.service.dispose();
});

test('corrupt structure rows are dropped one by one, with a warning each; placement and caps are re-checked in id order', () => {
  const w0 = world();
  const store = w0.store;
  const row = (n: number | string, type: string, x: number, z: number, config: Record<string, unknown> = { v: 1, rot: 0, lvl: 0 }): WorldStructureRecord =>
    ({ id: `${ROOM}:${n}`, roomId: ROOM, type, x, y: 99, z, rotY: 0, config });
  w0.service.dispose();
  store.structures.set(ROOM, [
    row(1, 'belt1', 4, -5),
    row(2, 'nope', 4, -7),
    row(3, 'belt1', 4.25, -7),
    row(3, 'belt1', 4, -9),
    row('x', 'belt1', 4, -11),
    row(70_000, 'belt1', 4, -11),
    row(4, 'belt1', 4, -5),
    row(5, 'belt1', 15, 0),
    row(6, 'found4', 6, -8, { v: 1, rot: 0, lvl: 1 }),
    row(7, 'belt2', 8, -12, { v: 1, rot: 9, lvl: 0 }),
    row(8, 'belt2', 8, -12, { v: 1, lvl: 0 })
  ]);
  const w = world(false, { store });
  assert.deepEqual([...w.logistics.structures.keys()].sort((a, b) => a - b), [1, 3, 8]);
  assert.equal(w.logistics.structures.get(1)?.base, 0, 'base y is recomputed, not trusted');
  assert.equal(w.room.loadWarnings.length, 8, w.room.loadWarnings.join('\n'));
});

test('v3 → v4: a v3 row loads with an empty network and saves as v4; orphan cargo goes into the hopper', () => {
  const w0 = world(false);
  const store = w0.store;
  w0.service.dispose();
  const v3 = store.rooms.get(ROOM);
  assert.ok(v3);
  const state: Record<string, unknown> = { ...v3.state, v: 3 };
  delete state['logistics'];
  store.rooms.set(ROOM, { ...v3, state });
  const w = world(false, { store });
  assert.equal(w.logistics.structures.size, 0);
  assert.equal(w.logistics.cargo.size, 0);
  w.service.dispose();
  assert.equal((store.rooms.get(ROOM)?.state as { v: number }).v, 4);

  const saved = store.rooms.get(ROOM);
  assert.ok(saved);
  const LoadC = (dustG: number) => [dustG, 0, 0, 0, 0, 0, []];
  const logistics = {
    v: 1, bags: [], hoppers: [], packagers: [], crane: { hook: [-850, 0] },
    cargo: [
      [1, 0, 0, 1, 42, 100, 0, 0, LoadC(7_000)],
      [2, 1, 0, 0, 42, 100, 0, 0, LoadC(3_000)],
      [3, 0, 0, 1, 0, -5, 0, 0, LoadC(1_000)],
      [4, 0, 0, 1, 0, 0, 0, 0, 'bad']
    ]
  };
  store.rooms.set(ROOM, { ...saved, state: { ...(saved.state as Record<string, unknown>), logistics } });
  const o = world(false, { store });
  assert.ok(Math.abs(loadKg(o.logistics.bufferOf(0) ?? load({})) - 8) < 1e-9, 'both orphan lots are in the hopper buffer');
  assert.equal(o.logistics.cargo.get(2)?.node, 0, 'the orphan bag is queued in the hopper');
  assert.equal(o.logistics.bags.get(2)?.st, 3);
  assert.equal(o.logistics.cargo.has(4), false);
  assert.ok(o.room.loadWarnings.includes('cargo row dropped'));
  o.service.dispose();
});

test('stats_json v3: bags parsed per field (clamped, default plus the one-time starter kit), round trip', () => {
  assert.equal(STATS_JSON_VERSION, 3);
  const fresh = parsePersonal({ ...NEW_PLAYER_STATS }, {}, 0);
  assert.deepEqual(fresh.data.bags, [...STARTER_BAGS]);
  assert.equal(fresh.granted, true);
  const clamped = parsePersonal({ ...NEW_PLAYER_STATS }, { v: 3, starter: true, starterBags: true, bags: [150, -1, 'x'] }, 0);
  assert.deepEqual(clamped.data.bags, [99, 0, 0]);
  assert.equal(clamped.granted, false);
  const v2 = parsePersonal({ ...NEW_PLAYER_STATS }, { v: 2, starter: true }, 0);
  assert.deepEqual(v2.data.bags, [...STARTER_BAGS], 'a v2 row gets the kit once');
  v2.data.bags[0] = 4;
  const again = parsePersonal({ ...NEW_PLAYER_STATS }, serialisePersonal(v2.data, 0), 0);
  assert.deepEqual(again.data.bags, [4, STARTER_BAGS[1], STARTER_BAGS[2]]);
  assert.equal(again.granted, false);
});

test('SQLite: saveRoom replaces the structure rows in its transaction; null leaves them unchanged', () => {
  const repo = new SweepersRepository(database);
  const rec = (n: number): WorldStructureRecord => ({ id: `tx:${n}`, roomId: 'tx', type: 'belt1', x: n, y: 0, z: 0, rotY: 0, config: { v: 1, rot: 0, lvl: 0 } });
  const room = { roomId: 'tx', state: { v: 4 }, cleanliness: {}, teamFunds: 0, lastSaved: 1 };
  repo.saveRoom(room, [], [rec(1), rec(2)]);
  repo.saveRoom(room, [], null);
  assert.deepEqual(repo.loadStructures('tx').map((r) => r.id), ['tx:1', 'tx:2']);
  repo.saveRoom(room, [], [rec(3)]);
  assert.deepEqual(repo.loadStructures('tx').map((r) => r.id), ['tx:3']);
  assert.throws(() => repo.saveRoom(room, [], [rec(4), { ...rec(5), config: { big: 1n } }]));
  assert.deepEqual(repo.loadStructures('tx').map((r) => r.id), ['tx:3'], 'a failed save rolls the delete back');
});

test('a failed save keeps the structure changes for the next save; a failed structure read never replaces the stored rows', () => {
  const w = world();
  const store = w.store;
  const realSave = store.saveRoom.bind(store);
  let failSave = true;
  store.saveRoom = (...args) => {
    if (failSave) throw new Error('SQLITE_BUSY');
    realSave(...args);
  };
  w.at(4, 6);
  w.place(TYPE.found2, 4, 4);
  w.tick(60_000);
  failSave = false;
  w.service.dispose();
  assert.equal(store.structures.get(ROOM)?.length, 1, 'the next save after a failed one writes the structure');

  let failRead = true;
  const realRead = store.loadStructures.bind(store);
  store.loadStructures = (roomId) => {
    if (failRead) throw new Error('disk');
    return realRead(roomId);
  };
  const o = world(true, { store });
  failRead = false;
  o.at(10, 12);
  o.place(TYPE.found2, 10, 10);
  o.service.dispose();
  assert.equal(store.structures.get(ROOM)?.length, 1);
  assert.equal(store.structures.get(ROOM)?.[0]?.x, 4, 'the stored rows survive a room that could not read them');
});

test('reload: a hopper or packager buffer whose node is gone goes into the landmark hopper buffer', () => {
  const w0 = world(false);
  const store = w0.store;
  w0.service.dispose();
  const saved = store.rooms.get(ROOM);
  assert.ok(saved);
  const LoadC = (dustG: number) => [dustG, 0, 0, 0, 0, 0, []];
  const logistics = { v: 1, bags: [], cargo: [], hoppers: [[900, LoadC(5_000)]], packagers: [[901, LoadC(2_000), 0, 0]], crane: { hook: [-850, 0] } };
  store.rooms.set(ROOM, { ...saved, state: { ...(saved.state as Record<string, unknown>), logistics } });
  const o = world(false, { store });
  assert.ok(Math.abs(loadKg(o.logistics.bufferOf(0) ?? load({})) - 7) < 1e-9, 'both orphan buffers are in the hopper');
  o.service.dispose();
});
