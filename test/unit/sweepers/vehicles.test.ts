// Phase F through SweepersService / SweepersRoom: tables and slots, buying, enter / exit, driving
// (speed, walls, nose, locked districts, seats, fuel), the reconnect grace and persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { groundHeight } from '../../../src/modules/sweepers/geometry.ts';
import { districtAt } from '../../../src/modules/sweepers/hexGrid.ts';
import { reservedRects } from '../../../src/modules/sweepers/logistics/placement.ts';
import { rectHitsCircle } from '../../../src/modules/sweepers/logistics/shapes.ts';
import { parseVehicleAction, parseVehicleEnter } from '../../../src/modules/sweepers/payloads.ts';
import { ROOM_STATE_VERSION } from '../../../src/modules/sweepers/roomState.ts';
import { SweepersRoom } from '../../../src/modules/sweepers/SweepersRoom.ts';
import { encodeVehicles } from '../../../src/modules/sweepers/vehicles/persist.ts';
import { endOffsets, spawnSlot, toWorld, topMps, VEHICLE_TYPES } from '../../../src/modules/sweepers/vehicles/tables.ts';
import type { VehicleUpdate } from '../../../src/modules/sweepers/vehicles/VehicleWorld.ts';
import { code, load, ROOM } from './logisticsSupport.ts';
import { guest } from './support.ts';
import { EAST, SOUTH, vworld, WEST } from './vehicleSupport.ts';

const LAYOUT = cityLayout();

test('tables: F.1 columns; every spawn slot body is collider-free, in district 0 and outside the reserved zones', () => {
  assert.deepEqual(VEHICLE_TYPES.map((t) => t.key), ['handcart', 'wheelbarrow', 'simson', 'lada', 'multicar', 'ifa']);
  assert.deepEqual(VEHICLE_TYPES.map((t) => [t.capKg, t.priceFt, t.seats.length]), [
    [120, 8_000, 1], [220, 14_000, 1], [450, 85_000, 1], [800, 240_000, 2], [1_800, 550_000, 2], [5_000, 1_200_000, 3]
  ]);
  assert.equal(topMps(0), 4.5);
  assert.ok(Math.abs(topMps(5) - 55 / 3.6) < 1e-12);
  const w = vworld(false);
  const reserved = reservedRects(LAYOUT);
  VEHICLE_TYPES.forEach((t, type) => {
    const slot = spawnSlot(type);
    assert.ok(w.vehicles.bodyClear(type, slot.x, slot.z, slot.rotY), t.key);
    for (const lz of [0, ...endOffsets(type)]) {
      const [ox, oz] = toWorld(slot.rotY, 0, lz);
      assert.equal(districtAt(slot.x + ox, slot.z + oz), 0);
      for (const r of reserved) assert.ok(!rectHitsCircle(r, slot.x + ox, slot.z + oz, t.r), `${t.key} in a reserved zone`);
    }
  });
});

test('buy: at the workbench from the team funds, once per type, spawns at its slot with a full tank', () => {
  const w = vworld();
  w.room.teamFunds = 80_000;
  assert.equal(code(() => w.service.buyUpgrade('s1', { channelId: ROOM, item: 'vehicle', tier: 2 })), 'notAtWorkbench');
  assert.equal(code(() => w.buy(2)), 'notEnoughTeamFunds');
  w.room.teamFunds = 100_000;
  const v = w.buy(2);
  assert.equal(w.room.teamFunds, 15_000);
  assert.deepEqual([v.x, v.z, v.fuelL, v.seats], [0, -10, 5, [0]]);
  w.room.teamFunds = 1e7;
  assert.equal(code(() => w.buy(2)), 'alreadyOwned');
  w.tick();
  const update = w.events.of('vehicleUpdate').at(-1)?.[1] as VehicleUpdate;
  assert.deepEqual(update.v, [[v.id, 2, 0, -1000, 49152, 0, 50, 0, 0, 0, 0, 0, 0]]);
  assert.equal(w.events.of('vehicleUpdate').length, 1);
  w.tick();
  assert.equal(w.events.of('vehicleUpdate').length, 1, 'unchanged rows are not re-sent');
});

test('enter: refusals in order, seat, pose from the seat, DRIVING_VEHICLE / PUSHING_CART; exit: driver side, out of colliders, corrected', () => {
  const w = vworld();
  const lada = w.buy(3);
  const cart = w.buy(0);
  assert.equal(code(() => w.service.vehicleEnter('s1', parseVehicleEnter({ channelId: ROOM, id: 99, seat: 0 }))), 'unknownVehicle');
  w.player.carry = 1;
  assert.equal(code(() => w.enter(lada)), 'handsFull');
  w.player.carry = 0;
  w.player.personal.jerry = 1;
  assert.equal(code(() => w.enter(lada)), 'handsFull');
  w.player.personal.jerry = 0;
  assert.equal(code(() => w.enter(lada, 2)), 'VALIDATION_ERROR');
  w.player.pose = { ...w.player.pose, x: lada.x, z: lada.z + 2.4 };
  assert.equal(code(() => w.service.vehicleEnter('s1', { channelId: ROOM, id: lada.id, seat: 0 })), 'tooFar');
  lada.v = 0.5;
  assert.equal(code(() => w.enter(lada)), 'vehicleMoving');
  lada.v = 0;
  assert.equal(w.enter(lada, 1), 1);
  assert.equal(w.player.pose.state, 'IDLE');
  // Passenger seat (+0.35, 0.8, −0.3) heading +x (local right = +z): world (4 + 0.3, 0.8, −10 + 0.35).
  assert.ok(Math.abs(w.player.pose.x - 4.3) < 1e-9 && Math.abs(w.player.pose.z + 9.65) < 1e-9 && Math.abs(w.player.pose.y - 0.8) < 1e-9);
  assert.equal(code(() => w.service.vehicleEnter('s1', { channelId: ROOM, id: cart.id, seat: 0 })), 'alreadySeated');
  w.service.join(ROOM, 's2', guest('Other'));
  assert.equal(code(() => w.enter(lada, 1, 's2')), 'seatTaken');
  assert.equal(w.enter(lada, 0, 's2'), 0);
  assert.equal(w.room.bySocket('s2')?.pose.state, 'DRIVING_VEHICLE');
  // Exit: local (−W/2 − 0.6, 0) = 1.4 m to the left of +x, i.e. z − 1.4.
  assert.deepEqual(w.vact({ kind: 'exit' }), { ok: true, x: 4, z: -11.4 });
  assert.deepEqual([w.player.vehicle, w.player.pose.state, w.player.corrected, lada.seats], [0, 'IDLE', true, [w.room.bySocket('s2')?.id, 0]]);
  assert.equal(code(() => w.vact({ kind: 'exit' })), 'notSeated');
  w.enter(cart);
  assert.equal(w.player.pose.state, 'PUSHING_CART');
  assert.equal(code(() => parseVehicleAction({ channelId: ROOM, kind: 'lights', mode: 3 })), 'VALIDATION_ERROR');
  assert.equal(code(() => parseVehicleEnter({ channelId: ROOM, id: 0, seat: 0 })), 'VALIDATION_ERROR');
});

test('drive: within top × 1.25 accepted, above refused (corr); punctured × 0.6; manual carts at 4.5 m/s; y = ground; seats follow; stale seq; notDriver', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  w.clock.ms += 1_000;
  assert.equal(w.cruise(simson, topMps(2) * 1.2, 30, WEST), 0);
  assert.ok(Math.abs(simson.v - topMps(2) * 1.2) < 1e-6);
  assert.equal(groundHeight(LAYOUT.heightfield, simson.x, simson.z) + 0.9, w.player.pose.y);
  assert.deepEqual([w.player.pose.rotY, w.player.pose.state], [WEST, 'DRIVING_VEHICLE']);
  /** With the bank empty one 50 ms step at `k` × `top` is accepted (true) or refused. */
  const step = (v: typeof simson, top: number, k: number): boolean => {
    v.budget = { metres: 0, vertical: 1, at: w.clock.ms };
    return w.cruise(v, top * k, 1, WEST) === 0;
  };
  w.park(simson, 0, -10, WEST);
  assert.deepEqual([step(simson, topMps(2), 1.24), step(simson, topMps(2), 1.26)], [true, false]);
  w.tick();
  const rows = (w.events.of('vehicleUpdate').map(([, u]) => (u as VehicleUpdate).v ?? []).flat());
  assert.ok(rows.some((r) => (r[7] & 64) !== 0), 'corr flag sent');
  // Stale seq: ignored.
  const before = simson.x;
  w.service.vehicleDrive('s1', { channelId: ROOM, seq: 1, x: before - 0.5, y: 0, z: simson.z, rotY: WEST });
  assert.equal(simson.x, before);
  // Punctured: 0.6 × top.
  simson.punct = true;
  assert.deepEqual([step(simson, topMps(2) * 0.6, 1.24), step(simson, topMps(2) * 0.6, 1.26)], [true, false]);
  // Manual cart: walking speed.
  w.vact({ kind: 'exit' });
  const cart = w.buy(0);
  w.enter(cart);
  assert.deepEqual([step(cart, 4.5, 1.24), step(cart, 4.5, 1.26)], [true, false]);
  // Not the driver.
  w.service.join(ROOM, 's2', guest('Other'));
  assert.equal(code(() => w.drive(0, 0, 0, 50, 's2')), 'notDriver');
});

test('drive: slides along a wall, the nose stops at a wall, a locked district is refused, a stalled motor refuses, fuel burns per metre', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  // Office box bottom face z = −7.85; heading +x with a drift into it: the centre slides at z = −7.85 − r.
  w.park(simson, 13, -8.5, EAST);
  w.clock.ms += 1_000;
  w.drive(13.5, -8.2, EAST);
  assert.ok(Math.abs(simson.x - 13.5) < 0.02 && Math.abs(simson.z - (-7.85 - 0.6)) < 0.02, `${simson.x},${simson.z}`);
  // Heading +z towards the face: the centre circle clears, the nose (1.25 ahead for the Lada) would not.
  w.vact({ kind: 'exit' });
  const lada = w.buy(3);
  w.enter(lada);
  w.park(lada, 15, -10, SOUTH);
  w.clock.ms += 1_000;
  w.drive(15, -9.7, SOUTH);
  assert.deepEqual([lada.x, lada.z, lada.corrected], [15, -10, true]);
  // Fuel: L/km per metre moved.
  w.park(lada, 0, -14, WEST);
  lada.fuelL = 10;
  w.clock.ms += 1_000;
  w.drive(-0.5, -14, WEST);
  assert.ok(Math.abs(lada.fuelL - (10 - 0.5 * 2 / 1000)) < 1e-12);
  lada.fuelL = 0;
  w.drive(-1, -14, WEST);
  assert.deepEqual([lada.x, lada.v], [-0.5, 0]);
  w.tick();
  const row = (w.events.of('vehicleUpdate').at(-1)?.[1] as VehicleUpdate).v?.find((r) => r[0] === lada.id);
  assert.ok(row && (row[7] & 32) !== 0, 'stalled flag');

  // Only district 0 open: a move across its edge is refused.
  const l = vworld(false);
  const s = l.buy(2);
  l.enter(s);
  let edge = -10;
  while (districtAt(edge, -26) === 0) edge -= 0.1;
  l.park(s, edge + 1.5, -26, WEST);
  l.clock.ms += 1_000;
  l.drive(edge - 0.5, -26, WEST);
  assert.equal(s.x, edge + 1.5);
});

test('lifecycle: the seat is kept through the reconnect grace and freed after it; a driver disconnect stops the vehicle; idle → v 0 after 500 ms', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  w.clock.ms += 1_000;
  w.cruise(simson, 8, 4, WEST);
  w.tick(400);
  assert.ok(simson.v > 0);
  w.tick(100);
  assert.equal(simson.v, 0);
  w.cruise(simson, 8, 2, WEST);
  w.service.disconnect('s1');
  assert.equal(simson.v, 0);
  w.service.join(ROOM, 's1b', guest('Builder'));
  assert.equal(w.player.vehicle, simson.id);
  assert.equal(simson.seq, -1);
  w.service.disconnect('s1b');
  w.tick(120_000);
  assert.deepEqual(simson.seats, [0]);
  assert.equal(w.player.vehicle, 0);
});

test('seated player_input: seq and heading taken, the position ignored; a passenger WALK becomes IDLE', () => {
  const w = vworld();
  const lada = w.buy(3);
  w.enter(lada, 1);
  const pose = w.player.pose;
  w.service.input('s1', { channelId: ROOM, seq: 5, x: 50, y: 3, z: 50, rotY: 1, state: 'WALK' });
  assert.deepEqual([w.player.pose.x, w.player.pose.z, w.player.pose.rotY, w.player.pose.state, w.player.lastSeq], [pose.x, pose.z, 1, 'IDLE', 5]);
});

test('persistence: v4 without vehicles → none; round trip keeps loads, bags, damage, fuel, lights; corrupt rows dropped; a blocked row moves to its slot', () => {
  const w = vworld();
  const fresh = new SweepersRoom(ROOM, null, w.room.record(w.clock.ms), w.clock.ms);
  assert.equal(fresh.vehicles.vehicles.size, 0);
  const lada = w.buy(3);
  w.park(lada, -2, -14, WEST);
  Object.assign(lada, { fuelL: 7.3, align: 2, punct: true, lights: 2, beacon: true, load: load({ dust: 30, copper: 2 }) });
  lada.bags.push({ tier: 1, tint: 2, load: load({ iron: 40 }) });
  const rec = w.room.record(w.clock.ms);
  assert.equal(rec.state['v'], ROOM_STATE_VERSION);
  assert.equal(ROOM_STATE_VERSION, 4);
  const back = new SweepersRoom(ROOM, null, JSON.parse(JSON.stringify(rec)), w.clock.ms);
  assert.deepEqual(encodeVehicles(back.vehicles), encodeVehicles(w.vehicles));
  assert.deepEqual(back.loadWarnings, []);
  const restored = back.vehicles.get(lada.id);
  assert.deepEqual([restored.seats, restored.v, restored.tipUntil], [[0, 0], 0, 0]);
  // Corrupt rows dropped, a row inside the office moved to its slot.
  const blob = encodeVehicles(w.vehicles) as { v: number; list: unknown[][] };
  const good = blob.list[0] ?? [];
  const list = [
    [...good.slice(0, 2), 1500, -660, ...good.slice(4)],
    [2, 3, ...good.slice(2)],
    [3, 9, ...good.slice(2)],
    [4, 2, 0, 0, 0, 10, 0, 0, 0, 0, [1, 0, 0, 0, 0, 0, 'x'], []],
    [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, [500_000, 0, 0, 0, 0, 0, []], []]
  ];
  const state = { ...rec.state, vehicles: { v: 1, list } };
  const loaded = new SweepersRoom(ROOM, null, { ...rec, state }, w.clock.ms);
  assert.deepEqual([...loaded.vehicles.vehicles.keys()], [lada.id]);
  const moved = loaded.vehicles.get(lada.id);
  assert.deepEqual([moved.x, moved.z, moved.align], [4, -10, 2]);
  assert.deepEqual(loaded.loadWarnings, [`vehicle ${lada.id} moved to its slot`, 'vehicle row dropped', 'vehicle row dropped', 'vehicle row dropped', 'vehicle row dropped']);
  assert.deepEqual(new SweepersRoom(ROOM, null, { ...rec, state: { ...rec.state, vehicles: 'junk' } }, 0).loadWarnings, ['invalid vehicles blob']);
});

test('vehicle_update: a corrected row goes out every tick it is corrected, even when unchanged', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  simson.fuelL = 0;
  w.tick();
  w.events.clear();
  for (let i = 0; i < 2; i++) {
    w.drive(-1, -10, EAST);
    w.tick();
  }
  const rows = w.events.of('vehicleUpdate').map(([, u]) => (u as VehicleUpdate).v?.[0]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r !== undefined && (r[7] & 64) !== 0 && r[2] === 0));
});

test('exit / enter vs walls (review M2): a blocked driver side exits on the passenger side; both blocked → exitBlocked (still seated); no entering through a wall', () => {
  const w = vworld();
  const cart = w.buy(0);
  const enterFrom = (x: number, z: number) => {
    w.at(x, z);
    return w.service.vehicleEnter('s1', { channelId: ROOM, id: cart.id, seat: 0 });
  };
  // Heading −x the driver side is +z: the office face (z −7.85) is in the way, so the player gets out at z −10.
  w.park(cart, 15, -9, WEST);
  enterFrom(15, -10);
  assert.deepEqual(w.vact({ kind: 'exit' }), { ok: true, x: 15, z: -10 });
  // Between the south wall (z −18) and a fence (z −20.5): neither side is free. A stalled Simson there
  // (every drive refused) still lets its driver out at the rear or the front (review N1).
  w.at(-2, -21);
  w.place(13, -2, -20.5);
  w.tick();
  const simson = w.buy(2);
  w.park(simson, -2, -19.2, EAST);
  simson.fuelL = 0;
  w.at(-2, -19.6);
  w.service.vehicleEnter('s1', { channelId: ROOM, id: simson.id, seat: 0 });
  const out = w.vact({ kind: 'exit' });
  assert.ok('x' in out && (Math.abs(out.x - (-2 - 1.9)) < 1e-6 || Math.abs(out.x - (-2 + 1.9)) < 1e-6) && Math.abs(out.z + 19.2) < 1e-6, JSON.stringify(out));
  w.park(simson, 0, -10, EAST);
  // With fences at both ends too, the cart has no way out.
  w.at(-2, -22);
  w.place(13, -3.5, -19.5, 1);
  w.place(13, -0.5, -19.5, 1);
  w.tick();
  w.park(cart, -2, -19.2, EAST);
  enterFrom(-2, -19.9 + 0.3);
  assert.equal(code(() => w.vact({ kind: 'exit' })), 'exitBlocked');
  assert.equal(w.player.vehicle, cart.id);
  w.room.vehicles.unseat(w.player);
  // The cart north of the south wall, the player south of it, 1.6 m apart: within reach, but not through the wall.
  w.park(cart, -2, -17.3, EAST);
  assert.equal(code(() => enterFrom(-2, -18.9)), 'tooFar');
  assert.equal(enterFrom(-2, -16.5), 0);
});
