// Phase C end to end through the real Application (127.0.0.1:<ephemeral>, isolated DB): join → chunk
// burst (≤ 50 kB for the whole 48 m disc) → sweep_hit → ack + delta → an `hx` crossing; the sweep
// bucket; buy_upgrade and player_action acks.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { Socket as ClientSocket } from 'socket.io-client';
import { SqliteDatabase } from '../../../src/infrastructure/database/index.ts';
import { DebrisWorld } from '../../../src/modules/sweepers/debris/DebrisWorld.ts';
import { dustKg } from '../../../src/modules/sweepers/debris/grid.ts';
import { HEX_CELLS } from '../../../src/modules/sweepers/hexGrid.ts';
import { SweepersRepository } from '../../../src/modules/sweepers/SweepersRepository.ts';
import { spawnPose } from '../../../src/modules/sweepers/SweepersRoom.ts';
import type { DebrisChunkUpdate, InitStatePayload } from '../../../src/modules/sweepers/types.ts';
import { TestApp, waitFor } from '../support/TestApp.ts';
import { paint } from './debrisSupport.ts';

const ROOM = 'hang-gaming-1';
const dbPath = process.env['SHARKVOIC_DB_PATH'] ?? '';
assert.ok(dbPath.startsWith(os.tmpdir()), 'must run on the isolated test DB');

let t: TestApp;
before(async () => { t = await TestApp.start(); });
after(async () => { await t.stop(); });

const ack = (client: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> =>
  client.timeout(2000).emitWithAck(event, payload) as Promise<Record<string, unknown>>;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Stores a clean world whose centre hex holds dirt only around the first spawn point plus just
 * enough elsewhere that its mass sits a hair above 1 % of Mref: c10 989, so one stroke crosses into 99 %.
 */
function seedWorld(): number {
  const world = DebrisWorld.generate(ROOM, HEX_CELLS.map(() => 100), 1);
  for (const id of [...world.items.keys()]) world.remove(id);
  const spawn = spawnPose(1);
  paint(world, spawn.x, spawn.z, 2.5, 0xf0);
  const boundary = world.mrefOf(0) * 0.01;
  const perLevel = dustKg(1, 0);
  for (const index of world.grid.hexCells[0] ?? []) {
    if (world.massOf(0) > boundary) break;
    if ((world.cells[index] ?? 0) !== 0) continue;
    const missing = boundary - world.massOf(0);
    const level = Math.min(15, Math.floor(missing / perLevel) + 1);
    world.setCell(index, level << 4);
  }
  assert.equal(world.c10(0), 989);
  const database = new SqliteDatabase(dbPath);
  new SweepersRepository(database).saveRoom({ roomId: ROOM, state: { v: 3, debris: world.record() }, cleanliness: {}, teamFunds: 0, lastSaved: 1 }, []);
  database.close();
  return world.massOf(0) - boundary;
}

test('join → burst ≤ 50 kB → sweep_hit → ack + cells delta → hx crossing; bucket; shop and action acks', async () => {
  const margin = seedWorld();
  assert.ok(margin > 0 && margin < 0.03, `${margin}`);
  const { client } = await t.joinAsGuest('SwDebris');
  const updates: DebrisChunkUpdate[] = [];
  client.on('miskolc:debris_chunk_update', (u: DebrisChunkUpdate) => { updates.push(u); });
  const initP = waitFor<InitStatePayload>(client, 'miskolc:init_state');
  assert.deepEqual(await ack(client, 'miskolc:join_room', { channelId: ROOM }), { ok: true });
  const init = await initP;
  assert.deepEqual(init.debris, { gen: 1, origin: -256, chunkM: 8, cellM: 0.5, n: 64, loadM: 48 });
  assert.equal(init.personal.cash, 2000);
  assert.equal(init.hexes[0]?.cleanliness, 98.9);
  assert.equal(init.players[0]?.tool, 0);
  await sleep(1_000);
  const first = updates[0];
  assert.equal(first?.load?.length, 32, 'the first message is the 32-chunk burst');
  const loaded = updates.reduce((n, u) => n + (u.load?.length ?? 0), 0);
  const bytes = updates.reduce((n, u) => n + JSON.stringify(u).length, 0);
  assert.ok(loaded > 100 && loaded < 130, `${loaded} chunks`);
  assert.ok(bytes <= 50_000, `${bytes} B`);

  const self = init.players[0];
  assert.ok(self);
  const crossing = waitFor<DebrisChunkUpdate>(client, 'miskolc:debris_chunk_update', (u) => (u.hx ?? []).some(([hex]) => hex === 0));
  const personal = waitFor<Record<string, unknown>>(client, 'miskolc:personal_update');
  const hit = { channelId: ROOM, seq: 1, tool: 0, alt: 0, x: self.x, z: self.z, rotY: self.rotY };
  const sweep = await ack(client, 'miskolc:sweep_hit', hit);
  assert.equal(sweep['ok'], true);
  assert.equal(sweep['seq'], 1);
  assert.ok(typeof sweep['kg'] === 'number' && sweep['kg'] > margin, JSON.stringify(sweep));
  const delta = await crossing;
  assert.ok((delta.cells ?? []).length > 0 && (delta.cells ?? []).length % 3 === 0);
  const hx = (delta.hx ?? []).find(([hex]) => hex === 0);
  assert.ok(hx && hx[1] >= 990, JSON.stringify(delta.hx));
  assert.equal((await personal)['stamina'], 995);

  // Bucket (8/s, burst 8): a burst of 10 more is refused silently, by cadence first, then by the bucket.
  const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => ack(client, 'miskolc:sweep_hit', { ...hit, seq: 2 + i })));
  assert.ok(codes.every((c) => c['ok'] === false));
  assert.ok(codes.some((c) => c['code'] === 'SWEEPERS_TOO_FAST'));
  assert.ok(codes.filter((c) => c['code'] === 'SWEEPERS_RATE_LIMITED').length >= 2, JSON.stringify(codes.map((c) => c['code'])));
  assert.equal((await ack(client, 'miskolc:sweep_hit', { ...hit, seq: 50, tool: 9 }))['code'], 'VALIDATION_ERROR');

  assert.deepEqual(await ack(client, 'miskolc:buy_upgrade', { channelId: ROOM, item: 'tool', tier: 1 }), {
    ok: false, error: 'Ezt csak a MÉH műhelyben veheted meg.', code: 'SWEEPERS_REFUSED'
  });
  assert.equal((await ack(client, 'miskolc:buy_upgrade', { channelId: ROOM, item: 'tool' }))['code'], 'VALIDATION_ERROR');
  assert.deepEqual(await ack(client, 'miskolc:player_action', { channelId: ROOM, kind: 'select', tool: 7 }), { ok: true });
  assert.deepEqual(await ack(client, 'miskolc:player_action', { channelId: ROOM, kind: 'dump' }), { ok: true });
  assert.equal((await ack(client, 'miskolc:player_action', { channelId: ROOM, kind: 'fly' }))['code'], 'VALIDATION_ERROR');
  client.close();
});
