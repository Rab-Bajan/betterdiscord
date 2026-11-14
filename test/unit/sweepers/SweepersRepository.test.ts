// Persistence round-trip on the per-run isolated SQLite file (test/support/isolatedDb.cjs).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { SqliteDatabase } from '../../../src/infrastructure/database/index.ts';
import { SweepersRepository } from '../../../src/modules/sweepers/SweepersRepository.ts';
import { HEX_CELLS } from '../../../src/modules/sweepers/hexGrid.ts';
import type { InitStatePayload } from '../../../src/modules/sweepers/types.ts';
import { account, guest, makeService } from './support.ts';

const dbPath = process.env['SHARKVOIC_DB_PATH'] ?? '';
assert.ok(dbPath.startsWith(os.tmpdir()), 'must run on the isolated test DB');
const database = new SqliteDatabase(dbPath);
after(() => database.close());

test('rooms, player stats and structures upsert and load', () => {
  const repo = new SweepersRepository(database);
  assert.equal(repo.loadRoom('r1'), null);
  assert.equal(repo.loadPlayerStats('acc:a', 'r1'), null);
  repo.saveRoom({ roomId: 'r1', state: { v: 1 }, cleanliness: { 0: 35, 1: 12.5 }, teamFunds: 10, lastSaved: 5 },
    [{ userId: 'acc:a', roomId: 'r1', stats: { cash: 3, toolTier: 1, backpackTier: 0, totalKg: 1.25 }, extra: { v: 2, starter: true } }]);
  repo.saveRoom({ roomId: 'r1', state: { v: 1 }, cleanliness: { 0: 40, 1: 12.5 }, teamFunds: 99, lastSaved: 6 }, []);
  assert.deepEqual(repo.loadRoom('r1'), { roomId: 'r1', state: { v: 1 }, cleanliness: { 0: 40, 1: 12.5 }, teamFunds: 99, lastSaved: 6 });
  assert.deepEqual(repo.loadPlayerStats('acc:a', 'r1'), { stats: { cash: 3, toolTier: 1, backpackTier: 0, totalKg: 1.25 }, extra: { v: 2, starter: true } });
  assert.equal(repo.loadPlayerStats('acc:a', 'r2'), null, 'stats are per room');

  repo.upsertStructure({ id: 'st1', roomId: 'r1', type: 'conveyor', x: 1, y: 0, z: 2, rotY: 0.5, config: { len: 3 } });
  repo.upsertStructure({ id: 'st1', roomId: 'r1', type: 'conveyor', x: 4, y: 0, z: 2, rotY: 0.5, config: { len: 4 } });
  assert.deepEqual(repo.loadStructures('r1'), [{ id: 'st1', roomId: 'r1', type: 'conveyor', x: 4, y: 0, z: 2, rotY: 0.5, config: { len: 4 } }]);
  assert.deepEqual(repo.loadStructures('r2'), []);
});

test('corrupt JSON columns read as empty', () => {
  database.connection.prepare('INSERT INTO miskolc_rooms VALUES (?, ?, ?, ?, ?)').run('bad', '{oops', '[1,2]', null, null);
  assert.deepEqual(new SweepersRepository(database).loadRoom('bad'), { roomId: 'bad', state: {}, cleanliness: {}, teamFunds: 0, lastSaved: 0 });
});

test('service round trip: a world saved on unload comes back with the next load', () => {
  const first = makeService({ store: new SweepersRepository(database) });
  first.service.join('hang-chill', 's1', account('acc-x', 'Xena'));
  first.service.join('hang-chill', 's2', guest('Guest'));
  const room = first.service.room('hang-chill');
  assert.ok(room);
  room.teamFunds = 1234;
  const xena = [...room.players()].find((p) => p.username === 'Xena');
  assert.ok(xena);
  Object.assign(xena.personal, { cash: 50, toolTier: 3, backpackTier: 2, totalKg: 7.5, owned: 0b10001001 });
  first.service.disconnect('s1');
  first.service.disconnect('s2');
  first.clock.ms += 120_000;
  first.service.tick();
  assert.equal(first.service.room('hang-chill'), undefined, 'unloaded');

  const second = makeService({ store: new SweepersRepository(database) });
  second.service.join('hang-chill', 's9', account('acc-x', 'Xena'));
  const init = second.events.of('initState').at(-1)?.[1] as InitStatePayload;
  assert.equal(init.teamFunds, 1234);
  const { cash, toolTier, backpackTier, totalKg, owned } = init.personal;
  assert.deepEqual({ cash, toolTier, backpackTier, totalKg, owned }, { cash: 50, toolTier: 3, backpackTier: 2, totalKg: 7.5, owned: 0b10001001 });
  assert.equal(init.hexes.length, HEX_CELLS.length);
  assert.ok(Math.abs((init.hexes[0]?.cleanliness ?? 0) - 35) <= 2);
  // The guest got the starter grant on its first load; it was persisted at once.
  assert.equal(new SweepersRepository(database).loadPlayerStats('name:guest', 'hang-chill')?.stats.cash, 2000);
});
