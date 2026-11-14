// Phase F actions through SweepersService: the bed (dump, load), tipping, the weighbridge, brushes,
// curbs and repair, lights / beacon / horn, jerry cans and refuelling, the garage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { loadKg } from '../../../src/modules/sweepers/debris/personal.ts';
import { KIND } from '../../../src/modules/sweepers/debris/tables.ts';
import { lmeEpoch, lmeRow } from '../../../src/modules/sweepers/economy/lme.ts';
import { receipt } from '../../../src/modules/sweepers/economy/payout.ts';
import { exceededCap } from '../../../src/modules/sweepers/logistics/placement.ts';
import { footprint } from '../../../src/modules/sweepers/logistics/shapes.ts';
import type { Structure } from '../../../src/modules/sweepers/logistics/shapes.ts';
import { BALA, CAP_NAMES, CAPS, LANDMARK_HOPPER, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import type { ScaleWeighedPayload } from '../../../src/modules/sweepers/types.ts';
import { VFLAG } from '../../../src/modules/sweepers/vehicles/tables.ts';
import type { VehicleUpdate } from '../../../src/modules/sweepers/vehicles/VehicleWorld.ts';
import { cellAt, paint, put } from './debrisSupport.ts';
import { code, load, ROOM } from './logisticsSupport.ts';
import { guest } from './support.ts';
import { EAST, NORTH, OFFICE, vworld, WEST } from './vehicleSupport.ts';
import { SweepersRoom } from '../../../src/modules/sweepers/SweepersRoom.ts';

type V = ReturnType<typeof vworld>;
const WB = cityLayout().landmarks.weighbridge;
const dump = (w: V) => w.service.playerAction('s1', { channelId: ROOM, kind: 'dump' });
const updates = (w: V): VehicleUpdate[] => w.events.of('vehicleUpdate').map(([, u]) => u as VehicleUpdate);
const lastRow = (w: V, id: number) => updates(w).flatMap((u) => u.v ?? []).filter((r) => r[0] === id).at(-1);
/** Ties a `kg` dust bag and picks it up; returns its id. */
const carryBag = (w: V, kg: number): number => {
  const tie = w.tieAt(20, -14, { dust: kg });
  w.act({ kind: 'pickup', id: tie.id });
  return tie.id;
};

test('bed: dump into the bed (bedFull at the cap), the hopper zone wins; load a carried bag (12-bag limit, kg cap, refusals)', () => {
  const w = vworld();
  const simson = w.buy(2);
  // Heading +x, the bed point is 1.6 m behind: (−1.6, −10).
  w.at(-1.6, -9);
  w.player.personal.pack = load({ dust: 12 });
  assert.deepEqual(dump(w), { bedKg: 12 });
  assert.equal(loadKg(simson.load), 12);
  simson.load = load({ dust: 450 });
  w.player.personal.pack = load({ dust: 1 });
  assert.equal(code(() => dump(w)), 'bedFull');
  simson.load = load({});
  // Load a bag.
  const id = carryBag(w, 5);
  w.at(-1.6, -7);
  assert.equal(code(() => w.vact({ kind: 'load', id: simson.id })), 'tooFar');
  w.at(-1.6, -9);
  assert.equal(code(() => w.vact({ kind: 'load', id: 9 })), 'unknownVehicle');
  assert.deepEqual(w.vact({ kind: 'load', id: simson.id }), { ok: true, bedKg: 5 });
  assert.deepEqual([w.player.carry, w.room.logistics.bags.has(id), simson.bags.length, simson.bags[0]?.tier], [0, false, 1, 0]);
  assert.equal(code(() => w.vact({ kind: 'load', id: simson.id })), 'notCarrying');
  simson.bags = Array.from({ length: 12 }, () => ({ tier: 0, tint: 0, load: load({ dust: 1 }) }));
  carryBag(w, 2);
  w.at(-1.6, -9);
  assert.equal(code(() => w.vact({ kind: 'load', id: simson.id })), 'bedFull');
  simson.bags = [];
  simson.load = load({ dust: 449 });
  assert.equal(code(() => w.vact({ kind: 'load', id: simson.id })), 'bedFull');
  simson.load = load({});
  w.player.carry = 0;
  w.enter(simson);
  assert.equal(code(() => w.vact({ kind: 'load', id: simson.id })), 'alreadySeated');
  // The hopper zone wins over a bed in reach.
  w.vact({ kind: 'exit' });
  w.park(simson, 14, 7.5, NORTH);
  w.at(14, 9);
  w.player.personal.pack = load({ dust: 3 });
  assert.deepEqual(dump(w), { hopperKg: 3 });
});

test('tip: into the landmark hopper (fill cap, bag queue) or onto the ground (spill + bags); refusals', () => {
  const w = vworld();
  const simson = w.buy(2);
  assert.equal(code(() => w.vact({ kind: 'tip' })), 'notDriver');
  w.enter(simson);
  assert.equal(code(() => w.vact({ kind: 'tip' })), 'bedEmpty');
  // Rear towards the hopper: bed point (14, 9.1) inside the intake.
  w.park(simson, 14, 7.5, NORTH);
  simson.load = load({ dust: 30 });
  simson.bags = [{ tier: 0, tint: 1, load: load({ dust: 5 }) }];
  const before = loadKg(w.room.logistics.bufferOf(LANDMARK_HOPPER) ?? load({}));
  simson.v = 1;
  assert.equal(code(() => w.vact({ kind: 'tip' })), 'vehicleMoving');
  simson.v = 0;
  assert.deepEqual(w.vact({ kind: 'tip' }), { ok: true, into: 'hopper', kg: 35 });
  assert.ok(Math.abs(loadKg(w.room.logistics.bufferOf(LANDMARK_HOPPER) ?? load({})) - before - 30) < 1e-9);
  assert.deepEqual([simson.bags.length, [...w.room.logistics.bags.values()].filter((b) => b.st === 3).map((b) => [b.tier, b.tint])], [0, [[0, 1]]]);
  simson.load = load({ dust: 10 });
  assert.equal(code(() => w.vact({ kind: 'tip' })), 'SWEEPERS_TOO_FAST');
  w.tick();
  assert.ok((lastRow(w, simson.id)?.[7] ?? 0) & VFLAG.tipping);
  // The hopper fills to 2 000 kg; the rest stays on the bed.
  w.clock.ms += 3_000;
  w.room.logistics.fillHopper(LANDMARK_HOPPER, load({ dust: 2_000 - loadKg(w.room.logistics.bufferOf(LANDMARK_HOPPER) ?? load({})) - 4 }));
  assert.deepEqual(w.vact({ kind: 'tip' }), { ok: true, into: 'hopper', kg: 4 });
  assert.ok(Math.abs(loadKg(simson.load) - 6) < 1e-9);
  // Onto the ground at the slot: a pile at the bed point, the bags just behind it.
  w.clock.ms += 3_000;
  w.park(simson, 0, -10, EAST);
  simson.bags = [{ tier: 1, tint: 0, load: load({ iron: 20 }) }];
  const bags = w.room.logistics.bags.size;
  assert.deepEqual(w.vact({ kind: 'tip' }), { ok: true, into: 'ground', kg: 26 });
  assert.deepEqual([loadKg(simson.load), simson.bags.length, w.room.logistics.bags.size], [0, 0, bags + 1]);
  const pile = [...w.room.debris.items.values()].find((i) => i.kind === KIND.pile && Math.hypot(i.x + 1.6, i.z + 10) < 1.5);
  assert.ok(pile, 'a pile at the bed point');
});

test('scale: a driven vehicle still 2 s on the weighbridge is weighed once (bed + bags, veh, 80/20 split); re-arms after moving; seated players and driverless vehicles skipped', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  w.park(simson, WB.x, WB.z, EAST);
  w.player.personal.pack = load({ copper: 1 });
  simson.load = load({ copper: 2, dust: 5 });
  simson.bags = [{ tier: BALA, tint: 2, load: load({ iron: 50 }) }];
  const containers = [{ load: load({ copper: 2, dust: 5 }), proc: 0 }, { load: load({ iron: 50 }), proc: 1 }];
  w.drive(WB.x, WB.z, EAST);
  w.events.clear();
  const funds = w.room.teamFunds;
  w.tick(1_900);
  assert.equal(w.events.of('scaleWeighed').length, 0);
  w.tick(100);
  const weighed = w.events.of('scaleWeighed').map(([, p]) => p as ScaleWeighedPayload);
  assert.equal(weighed.length, 1);
  const bill = receipt(containers, lmeRow(lmeEpoch(w.clock.ms)).pct);
  const [first] = weighed;
  assert.ok(first);
  assert.deepEqual(first.veh, { id: simson.id, type: 2, tareKg: 140 });
  assert.deepEqual([first.by, first.kgDg, first.total, first.scale], [w.player.id, bill.kgDg, bill.total, 0]);
  assert.equal(w.room.teamFunds, funds + first.team);
  assert.equal(first.team + first.each, bill.total);
  assert.deepEqual([loadKg(simson.load), simson.bags.length, loadKg(w.player.personal.pack)], [0, 0, 1]);
  w.tick();
  assert.equal(lastRow(w, simson.id)?.[8], 0);
  // Done until it moves > 0.15 m.
  simson.load = load({ dust: 5 });
  w.tick(2_500);
  assert.equal(w.events.of('scaleWeighed').length, 1);
  w.drive(WB.x + 0.3, WB.z, EAST);
  w.tick(2_100);
  assert.equal(w.events.of('scaleWeighed').length, 2);
  // No driver: nothing.
  simson.load = load({ dust: 5 });
  w.drive(WB.x + 0.6, WB.z, EAST);
  w.vact({ kind: 'exit' });
  w.player.personal.pack = load({});
  w.tick(2_500);
  assert.equal(w.events.of('scaleWeighed').length, 2);
});

test('brushes: the Multicar sweeps cells, items and piles in a rect into the bed up to its cap; kg credit the driver and the inspector', () => {
  const w = vworld();
  const mc = w.buy(4);
  w.enter(mc);
  const debris = w.room.debris;
  assert.ok(paint(debris, 11.5, -10, 1.2, 0xf0) > 0);
  const can = put(debris, KIND.can, 11.5, -10.6, 5);
  const pile = put(debris, KIND.pile, 12, -9.6, 500);
  const iron = put(debris, KIND.iron, 12.2, -10, 800);
  const credit = w.room.economy.kg[0] ?? 0;
  const total = w.player.personal.totalKg;
  w.clock.ms += 1_000;
  w.cruise(mc, 10, 8, EAST);
  // eff 0.8 at f = 1: dust 15 → floor(15 × 0.2) = 3.
  assert.equal(debris.cells[cellAt(debris, 11.5, -10)], 3 << 4);
  assert.deepEqual([debris.items.has(can.id), debris.items.has(pile.id), debris.items.has(iron.id)], [false, false, false]);
  const kg = loadKg(mc.load);
  assert.ok(kg > 15, `bed ${kg}`);
  assert.ok(Math.abs((w.room.economy.kg[0] ?? 0) - credit - kg) < 1e-6);
  assert.ok(Math.abs(w.player.personal.totalKg - total - kg) < 1e-6);
  // At the cap nothing more is taken and nothing is pushed.
  paint(debris, 15, -10, 1.2, 0xf0);
  mc.load = load({ dust: 1_800 - 0.5 });
  w.cruise(mc, 10, 10, EAST);
  assert.ok(loadKg(mc.load) <= 1_800 + 1e-6);
  assert.ok((debris.cells[cellAt(debris, 15, -10)] ?? 0) > 0);
});

test('curbs: 9.6 vs 9.8 m/s, 1 s cooldown, puncture with the injected chance, align cap 4; repair refusals, cost and reset', () => {
  const w = vworld();
  const lada = w.buy(3);
  w.enter(lada);
  w.room.vehicleChance = () => false;
  // The curb box along the east road: z −3.745..−3.495. From z −2.6 heading −z the body circle reaches it.
  // The server speed is the move over the time since the previous drive: a still drive first, then one 50 ms step.
  const hit = (d: number, wait = 1_000): void => {
    w.park(lada, 30, -2.6, NORTH);
    w.drive(30, -2.6, NORTH, wait);
    w.drive(30, -2.6 - d, NORTH);
  };
  hit(0.48);
  assert.equal(lada.align, 0);
  hit(0.49);
  assert.equal(lada.align, 1);
  hit(0.49, 0);
  assert.equal(lada.align, 1, 'cooldown');
  w.room.vehicleChance = () => true;
  hit(0.49);
  assert.deepEqual([lada.align, lada.punct], [2, true]);
  w.tick();
  const u = updates(w).at(-1);
  assert.deepEqual(updates(w).flatMap((x) => x.hit ?? []), [[lada.id, 0], [lada.id, 1]]);
  assert.ok(((u?.v?.[0]?.[7] ?? 0) & VFLAG.punct) !== 0 && (((u?.v?.[0]?.[7] ?? 0) >> VFLAG.alignShift) & 7) === 2);
  hit(0.49);
  hit(0.49);
  hit(0.49);
  assert.equal(lada.align, 4);
  // Repair.
  assert.equal(code(() => w.vact({ kind: 'repair', id: lada.id })), 'alreadySeated');
  w.vact({ kind: 'exit' });
  lada.v = 0;
  w.at(30, -8);
  assert.equal(code(() => w.vact({ kind: 'repair', id: lada.id })), 'tooFar');
  w.at(30, -4.5);
  lada.v = 1;
  assert.equal(code(() => w.vact({ kind: 'repair', id: lada.id })), 'vehicleMoving');
  lada.v = 0;
  w.room.teamFunds = 2_999;
  assert.equal(code(() => w.vact({ kind: 'repair', id: lada.id })), 'notEnoughTeamFunds');
  w.room.teamFunds = 5_000;
  assert.deepEqual(w.vact({ kind: 'repair', id: lada.id }), { ok: true, teamFunds: 2_000 });
  assert.deepEqual([lada.align, lada.punct], [0, false]);
  assert.equal(code(() => w.vact({ kind: 'repair', id: lada.id })), 'nothingToRepair');
});

test('lights / beacon / horn per type, driver only, horn cooldown 1.5 s', () => {
  const w = vworld();
  const cart = w.buy(0);
  const simson = w.buy(2);
  const lada = w.buy(3);
  const ifa = w.buy(5);
  assert.equal(code(() => w.vact({ kind: 'lights', mode: 1 })), 'notDriver');
  w.enter(cart);
  assert.equal(code(() => w.vact({ kind: 'lights', mode: 1 })), 'noLights');
  w.vact({ kind: 'exit' });
  w.enter(simson);
  assert.equal(code(() => w.vact({ kind: 'beacon', on: true })), 'noBeacon');
  assert.deepEqual(w.vact({ kind: 'lights', mode: 2 }), { ok: true });
  w.vact({ kind: 'exit' });
  w.enter(lada);
  assert.equal(code(() => w.vact({ kind: 'horn' })), 'noHorn');
  w.vact({ kind: 'beacon', on: true });
  w.vact({ kind: 'exit' });
  w.service.join(ROOM, 's2', guest('Other'));
  w.enter(ifa, 1, 's2');
  assert.equal(code(() => w.vact({ kind: 'horn' }, 's2')), 'notDriver');
  w.enter(ifa);
  assert.deepEqual(w.vact({ kind: 'horn' }), { ok: true });
  assert.equal(code(() => w.vact({ kind: 'horn' })), 'SWEEPERS_TOO_FAST');
  w.clock.ms += 1_500;
  w.vact({ kind: 'horn' });
  w.tick();
  const u = updates(w).at(-1);
  assert.deepEqual(u?.horn, [ifa.id, ifa.id]);
  const flags = (id: number): number => lastRow(w, id)?.[7] ?? -1;
  assert.deepEqual([flags(simson.id) & 3, flags(lada.id) & VFLAG.beacon], [2, VFLAG.beacon]);
});

test('jerry can: bought from the team funds into empty hands; refuel +10 L (cap, wrong fuel, no tank, reach); handsFull while held', () => {
  const w = vworld();
  const simson = w.buy(2);
  const cart = w.buy(0);
  const buyCan = (tier: number) => {
    w.at(OFFICE.x - 5, OFFICE.z + 2.6);
    return w.service.buyUpgrade('s1', { channelId: ROOM, item: 'jerrycan', tier });
  };
  const funds = w.room.teamFunds;
  assert.equal(buyCan(0).teamFunds, funds - 4_000);
  assert.equal(w.player.personal.jerry, 1);
  assert.equal(code(() => buyCan(0)), 'handsFull');
  w.at(4, 4);
  assert.equal(code(() => w.service.sweepHit('s1', { channelId: ROOM, seq: 1, tool: 0, alt: false, x: 4, z: 4, rotY: 0 })), 'handsFull');
  assert.equal(code(() => w.act({ kind: 'pickup', id: 1 })), 'handsFull');
  assert.equal(code(() => w.enter(simson)), 'handsFull');
  // Filler neck of the Simson heading +x: local (−0.9, 0.65) → (−0.65, −10.9).
  w.at(-0.65, -13);
  assert.equal(code(() => w.vact({ kind: 'refuel', id: simson.id })), 'tooFar');
  w.at(-0.65, -10.9);
  simson.fuelL = 1;
  assert.deepEqual(w.vact({ kind: 'refuel', id: simson.id }), { ok: true, fuelL: 5 });
  assert.equal(w.player.personal.jerry, 0);
  assert.equal(code(() => w.vact({ kind: 'refuel', id: simson.id })), 'noJerryCan');
  buyCan(1);
  w.at(-0.65, -10.9);
  assert.equal(code(() => w.vact({ kind: 'refuel', id: simson.id })), 'wrongFuel');
  w.park(cart, -0.65, -12.5, EAST);
  // The cart's filler point: local (−0.7, 0.35) → (−1, −13.2).
  w.at(-1, -13.2);
  assert.equal(code(() => w.vact({ kind: 'refuel', id: cart.id })), 'noFuelTank');
  w.player.personal.jerry = 0;
  carryBag(w, 2);
  assert.equal(code(() => buyCan(0)), 'handsFull');
});

test('garage: type 18 placed by D.3 (cap 6 garázs); a stopped motor vehicle inside refuels 2 L/s at 400 Ft/L until the funds run out', () => {
  const w = vworld();
  w.at(-10, -8);
  w.place(TYPE.garage, -10, -12, 1);
  const six: Structure[] = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1, type: TYPE.garage, x: 0, z: 0, rot: 0, lvl: 0, base: 0, flags: 0, wear: 0, rect: footprint(TYPE.garage, 0, 0, 0)
  }));
  assert.equal(exceededCap(six, TYPE.garage), CAP_NAMES.garages);
  assert.equal(exceededCap(six.slice(1), TYPE.garage), null);
  const simson = w.buy(2);
  w.park(simson, -10, -12, EAST);
  simson.fuelL = 1;
  w.room.teamFunds = 1_000;
  w.tick(1_000);
  assert.deepEqual([simson.fuelL, w.room.teamFunds], [3, 200]);
  w.tick(1_000);
  assert.deepEqual([simson.fuelL, w.room.teamFunds], [3, 200]);
  assert.ok((lastRow(w, simson.id)?.[7] ?? 0) & VFLAG.garage);
  w.room.teamFunds = 10_000;
  w.tick(1_000);
  w.tick(1_000);
  assert.deepEqual([simson.fuelL, w.room.teamFunds], [5, 9_200]);
});

test('review H1: a bed filled exactly to its cap with fractional grams survives save and reload', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.player.personal.pack = { ...load({}), dustG: 300_000.6, seedG: 100_000.6, ironG: 49_998.8 };
  w.vehicles.dumpInto(simson, w.player.personal);
  assert.ok(w.vehicles.freeKg(simson) < 1e-6);
  const back = new SweepersRoom(ROOM, null, JSON.parse(JSON.stringify(w.room.record(w.clock.ms))), w.clock.ms);
  assert.deepEqual(back.loadWarnings, []);
  assert.ok(Math.abs(loadKg(back.vehicles.get(simson.id).load) - 450) < 0.01);
});

test('review M1: a ground tip keeps the room bag cap; the bags that do not fit stay on the bed and kg counts what landed', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  while (w.room.logistics.bagCount < CAPS.bags - 1) w.room.logistics.newBag(0, load({ dust: 1 }), 20, -14, 0, 0, -1);
  simson.load = load({ dust: 10 });
  simson.bags = [{ tier: 0, tint: 0, load: load({ dust: 5 }) }, { tier: 0, tint: 0, load: load({ dust: 7 }) }];
  assert.deepEqual(w.vact({ kind: 'tip' }), { ok: true, into: 'ground', kg: 15 });
  assert.deepEqual([w.room.logistics.bagCount, simson.bags.length, loadKg(simson.bags[0]?.load ?? load({}))], [CAPS.bags, 1, 7]);
  w.clock.ms += 3_000;
  assert.deepEqual(w.vact({ kind: 'tip' }), { ok: true, into: 'ground', kg: 0 });
  assert.equal(simson.bags.length, 1);
});

test('review M3: no structure over a parked vehicle body (centre or end circles); a built-over empty slot refuses the purchase', () => {
  const w = vworld();
  const lada = w.buy(3);
  w.park(lada, 0, -14, EAST);
  w.at(0, -18);
  // The fence clears the centre circle (1.55 m away) but touches the rear end circle at (−1.25, −14) r 0.8.
  assert.equal(w.tryPlace(TYPE.fence, -2.5, -14.5), 'blocked');
  assert.equal(w.tryPlace(TYPE.fence, -2.5, -15.5), 'ok');
  w.at(0, -6);
  w.place(TYPE.fence, 0, -10);
  w.tick();
  assert.equal(code(() => w.buy(2)), 'slotBlocked');
});

test('review L1: drives at the 30/s limit report the real speed (1/30 s floor)', () => {
  const w = vworld();
  const simson = w.buy(2);
  w.enter(simson);
  w.drive(simson.x, simson.z, WEST, 1_000);
  for (let i = 0; i < 6; i++) w.drive(simson.x - 10 / 30, simson.z, WEST, 1_000 / 30);
  assert.ok(Math.abs(simson.v - 10) < 1e-6, String(simson.v));
});
