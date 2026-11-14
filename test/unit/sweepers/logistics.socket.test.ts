// Phase D end to end through the real Application (127.0.0.1:<ephemeral>, isolated DB): join → sweep
// (at the spawn point, as the Phase C e2e) → walk to the office and buy a bag → tie_bag (a bag row at a valid point) → place a belt → pick up and throw the bag onto
// it → its CargoRow s advances along the belt. Phase E (spec 149 test 4, walking variant): a second guest
// with copper in the pack walks onto the weighbridge, stands 2 s → scale_weighed, economy.funds and the wage.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { Socket as ClientSocket } from 'socket.io-client';
import { SqliteDatabase } from '../../../src/infrastructure/database/index.ts';
import { DebrisWorld } from '../../../src/modules/sweepers/debris/DebrisWorld.ts';
import { HEX_CELLS } from '../../../src/modules/sweepers/hexGrid.ts';
import { spawnPose } from '../../../src/modules/sweepers/SweepersRoom.ts';
import type { LogisticsUpdate } from '../../../src/modules/sweepers/logistics/LogisticsWorld.ts';
import { TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import type { EconomyUpdate } from '../../../src/modules/sweepers/economy/Economy.ts';
import { lmeRow } from '../../../src/modules/sweepers/economy/lme.ts';
import { receipt } from '../../../src/modules/sweepers/economy/payout.ts';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { emptyLoad } from '../../../src/modules/sweepers/debris/personal.ts';
import type { PersonalStatePayload } from '../../../src/modules/sweepers/debris/personal.ts';
import { SweepersRepository } from '../../../src/modules/sweepers/SweepersRepository.ts';
import type { InitStatePayload, ScaleWeighedPayload, StructureSpawnedPayload } from '../../../src/modules/sweepers/types.ts';
import { TestApp, waitFor } from '../support/TestApp.ts';
import { paint } from './debrisSupport.ts';

const ROOM = 'hang-altalanos';
/** A spot 5.6 m from the MÉH office (inside the 8 m workbench radius). */
const SPOT = { x: 10, z: -4 };
const dbPath = process.env['SHARKVOIC_DB_PATH'] ?? '';
assert.ok(dbPath.startsWith(os.tmpdir()), 'must run on the isolated test DB');

let t: TestApp;
before(async () => { t = await TestApp.start(); });
after(async () => { await t.stop(); });

const ack = (client: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> =>
  client.timeout(2000).emitWithAck(event, payload) as Promise<Record<string, unknown>>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function seedWorld(): void {
  const world = DebrisWorld.generate(ROOM, HEX_CELLS.map(() => 100), 1);
  for (const id of [...world.items.keys()]) world.remove(id);
  const spawn = spawnPose(1);
  paint(world, spawn.x, spawn.z, 2.5, 0xf0);
  const database = new SqliteDatabase(dbPath);
  new SweepersRepository(database).saveRoom({ roomId: ROOM, state: { v: 3, debris: world.record() }, cleanliness: {}, teamFunds: 0, lastSaved: 1 }, [], null);
  database.close();
}

test('join → sweep → buy → tie_bag → place a belt → throw the bag onto it → its CargoRow s advances', async () => {
  seedWorld();
  const { client } = await t.joinAsGuest('SwBagger');
  const updates: LogisticsUpdate[] = [];
  client.on('miskolc:logistics_update', (u: LogisticsUpdate) => { updates.push(u); });
  const initP = waitFor<InitStatePayload>(client, 'miskolc:init_state');
  assert.deepEqual(await ack(client, 'miskolc:join_room', { channelId: ROOM }), { ok: true });
  const init = await initP;
  assert.deepEqual(init.logistics.structures, []);
  assert.equal(init.logistics.crane.job, null);
  assert.deepEqual(init.personal.bags, [10, 2, 1]);
  const self = init.players[0];
  assert.ok(self);
  const sweep = await ack(client, 'miskolc:sweep_hit', { channelId: ROOM, seq: 1, tool: 0, alt: 0, x: self.x, z: self.z, rotY: self.rotY });
  assert.equal(sweep['ok'], true);
  assert.ok((sweep['kg'] as number) > 0, JSON.stringify(sweep));

  // Walk to the spot at 6 m/s (the motion rules allow 7.2).
  let seq = 0;
  let x = self.x;
  let z = self.z;
  while (Math.hypot(SPOT.x - x, SPOT.z - z) > 1e-6) {
    const d = Math.hypot(SPOT.x - x, SPOT.z - z);
    const step = Math.min(0.6, d);
    x += ((SPOT.x - x) / d) * step;
    z += ((SPOT.z - z) / d) * step;
    client.emit('miskolc:player_input', { channelId: ROOM, seq: ++seq, x, y: 0, z, rotY: 0, state: 'WALK' });
    await sleep(100);
  }
  client.emit('miskolc:player_input', { channelId: ROOM, seq: ++seq, x, y: 0, z, rotY: 0, state: 'IDLE' });
  await sleep(200);

  const bought = await ack(client, 'miskolc:buy_upgrade', { channelId: ROOM, item: 'bag', tier: 0 });
  assert.deepEqual(bought, { ok: true, cash: 1950, teamFunds: 0 });

  const tied = await ack(client, 'miskolc:tie_bag', { channelId: ROOM, tier: 0 });
  assert.equal(tied['ok'], true, JSON.stringify(tied));
  const bagId = tied['id'] as number;
  assert.ok(Math.abs((tied['kg'] as number) - (sweep['kg'] as number)) < 0.01);
  assert.equal((await ack(client, 'miskolc:tie_bag', { channelId: ROOM, tier: 0 }))['code'], 'SWEEPERS_TOO_FAST');
  const row = await (async () => {
    for (let i = 0; i < 20; i++) {
      const found = updates.flatMap((u) => u.b ?? []).find((b) => b[0] === bagId);
      if (found) return found;
      await sleep(50);
    }
    return null;
  })();
  assert.ok(row, 'the bag row went out');
  assert.equal(row[3], 0, 'on the ground');
  assert.ok(Math.hypot(row[4] / 100 - SPOT.x, row[6] / 100 - (SPOT.z - 0.6)) < 0.3, JSON.stringify(row));

  const spawned = waitFor<StructureSpawnedPayload>(client, 'miskolc:structure_spawned');
  const placed = await ack(client, 'miskolc:place_structure', { channelId: ROOM, type: TYPE.belt5, x: 10, z: -7.5, rot: 0, lvl: 0 });
  assert.equal(placed['ok'], true, JSON.stringify(placed));
  const beltId = placed['id'] as number;
  assert.deepEqual((await spawned).row, [beltId, TYPE.belt5, 1000, -750, 0, 0, 0, 0]);
  assert.equal((await ack(client, 'miskolc:place_structure', { channelId: ROOM, type: TYPE.belt5, x: 10, z: -7.5, rot: 0, lvl: 0 }))['code'], 'SWEEPERS_REFUSED');

  assert.deepEqual(await ack(client, 'miskolc:logistics_action', { channelId: ROOM, kind: 'pickup', id: bagId }), { ok: true });
  const thrown = await ack(client, 'miskolc:logistics_action', { channelId: ROOM, kind: 'throw', power: 3, pitch: 0, rotY: 0 });
  assert.equal(thrown['into'], 'belt', JSON.stringify(thrown));
  // The belt's in port is at z = -5 heading -z: the landing s is -5 - z.
  const landedS = (-5 - (thrown['to'] as number[])[2]! / 100) * 1000;
  await sleep(400);
  const rows = updates.flatMap((u) => u.c ?? []).filter((c) => c[0] === bagId && c[4] === beltId);
  assert.ok(rows.length >= 1, JSON.stringify(rows));
  assert.deepEqual([rows[0]?.[1], rows[0]?.[7]], [1, 1], 'a moving bag cargo row');
  assert.ok((rows[0]?.[5] ?? 0) > landedS + 50, `s advances: landed ${landedS}, row ${JSON.stringify(rows[0])}`);
  // It rides to the open end and comes off past the belt's far end (z < -10).
  await sleep(3_500);
  const off = updates.flatMap((u) => u.b ?? []).filter((b) => b[0] === bagId).at(-1);
  assert.ok(off && off[3] === 0 && off[6] < -1_000, JSON.stringify(off));
  client.close();
});

test('Phase E: walk onto the weighbridge with copper, stand 2 s → scale_weighed = the formula, economy.funds +80 %, the wage', async () => {
  const pack = { ...emptyLoad(), copperG: 5_000 };
  const database = new SqliteDatabase(dbPath);
  new SweepersRepository(database).savePlayerStats({
    userId: 'name:swweigher', roomId: ROOM, stats: { cash: 0, toolTier: 0, backpackTier: 0, totalKg: 0 }, extra: { v: 4, starter: true, starterBags: true, pack }
  });
  database.close();
  const { client } = await t.joinAsGuest('SwWeigher');
  const economy: EconomyUpdate[] = [];
  const personal: PersonalStatePayload[] = [];
  client.on('miskolc:economy', (u: EconomyUpdate) => { economy.push(u); });
  client.on('miskolc:personal_update', (p: PersonalStatePayload) => { personal.push(p); });
  const initP = waitFor<InitStatePayload>(client, 'miskolc:init_state');
  assert.deepEqual(await ack(client, 'miskolc:join_room', { channelId: ROOM }), { ok: true });
  const init = await initP;
  assert.equal(init.personal.pack.copperG, 5_000);
  assert.equal(init.economy.funds, init.teamFunds);
  const self = init.players.find((p) => p.id === init.selfId);
  assert.ok(self);
  const wb = cityLayout().landmarks.weighbridge;
  const weighedP = waitFor<ScaleWeighedPayload>(client, 'miskolc:scale_weighed', () => true, 15_000);
  let seq = 0;
  let x = self.x;
  let z = self.z;
  while (Math.hypot(wb.x - x, wb.z - z) > 1e-6) {
    const d = Math.hypot(wb.x - x, wb.z - z);
    const step = Math.min(0.6, d);
    x += ((wb.x - x) / d) * step;
    z += ((wb.z - z) / d) * step;
    client.emit('miskolc:player_input', { channelId: ROOM, seq: ++seq, x, y: 0, z, rotY: 0, state: 'WALK' });
    await sleep(100);
  }
  const stoppedAt = Date.now();
  client.emit('miskolc:player_input', { channelId: ROOM, seq: ++seq, x, y: 0, z, rotY: 0, state: 'IDLE' });
  const sale = await weighedP;
  assert.ok(Date.now() - stoppedAt >= 1_900, 'not before 2 s of stillness');
  const bill = receipt([{ load: pack, proc: 0 }], lmeRow(sale.epoch).pct);
  assert.equal(sale.scale, 0);
  assert.equal(sale.by, init.selfId);
  assert.equal(sale.kgDg, 500);
  assert.equal(sale.total, bill.total);
  assert.deepEqual(sale.lines, bill.lines);
  assert.equal(sale.each, Math.floor(0.2 * bill.total), 'the other guest is in the grace window: one share');
  assert.equal(sale.team, bill.total - sale.each);
  await sleep(300);
  assert.equal(economy.map((u) => u.funds).filter((f) => f !== undefined).at(-1), init.teamFunds + sale.team);
  const last = personal.at(-1);
  assert.equal(last?.cash, sale.each);
  assert.equal(last?.pack.copperG, 0);
  client.close();
});
