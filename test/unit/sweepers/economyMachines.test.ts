// Phase E machines (plan E.2): stripper and baler (packager path), magnet and trommel (sorters, coins),
// jams, wear → smoke → grease, the blueprint rule, power demand and the pf speed knob.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKg } from '../../../src/modules/sweepers/debris/personal.ts';
import type { EconomyUpdate } from '../../../src/modules/sweepers/economy/Economy.ts';
import { rotate } from '../../../src/modules/sweepers/logistics/shapes.ts';
import { CAP_NAMES, CAPS, FLAG_SMOKE, GREASE_SHIFT, servicePoint, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import { code, load, world } from './logisticsSupport.ts';

type W = ReturnType<typeof world>;
let nextCargo = 2_000;
const lot = (w: W, node: number, s: number, kg = 10, sub = 0): number => {
  const id = nextCargo++;
  const contents = sub === 0 ? load({ dust: kg }) : sub === 1 ? load({ iron: kg }) : load({ copper: kg });
  assert.ok(w.logistics.restoreCargo({ id, kind: 0, sub, tint: sub + 1, node, s, route: 0, waitMs: 0, load: contents }));
  return id;
};

/** Feed belt1 at (4, −5) → the machine (2 × 2 at (4, −6.5), the trommel 2 × 4 at (4, −7.5)); every blueprint bought. */
function line(type: number) {
  const w = world();
  w.room.economy.bp = 0b1111;
  w.at(4, -2);
  const feed = w.place(TYPE.belt1, 4, -5);
  const machine = w.place(type, 4, type === TYPE.trommel ? -7.5 : -6.5);
  return { w, feed, machine };
}

/** Bags of `tier` emitted by `node` while running `n` ticks, with their emission times. */
function emissions(w: W, node: number, n: number, tier: number): Array<{ id: number; t: number; kg: number }> {
  const out: Array<{ id: number; t: number; kg: number }> = [];
  const seen = new Set<number>();
  for (let i = 0; i < n; i++) {
    w.tick();
    for (const c of w.logistics.cargo.values()) {
      if (c.node !== node || c.kind !== 1 || c.sub !== tier || seen.has(c.id) || !c.bag) continue;
      seen.add(c.id);
      out.push({ id: c.id, t: w.clock.ms, kg: loadKg(c.bag.load) });
    }
  }
  return out;
}

test('stripper: absorbs copper (bulk passes straight), a 20 kg rézköteg (tier 4, tint 3) per 10 s, idle flush; 100 kg buffer', () => {
  const { w, feed, machine } = line(TYPE.stripper);
  w.logistics.restoreBuffer(machine, load({ copper: 30 }));
  const bulk = lot(w, feed, 0.9, 10, 0);
  w.ticks(4);
  assert.equal(w.logistics.cargo.get(bulk)?.node, machine, 'a bulk lot rides through');
  const bags = emissions(w, machine, 300, 4);
  assert.equal(bags.length, 2, '30 kg → 20 kg after the first 10 s cycle, then the 10 kg flush after 10 s idle');
  assert.ok(Math.abs((bags[0]?.kg ?? 0) - 20) < 1e-9);
  assert.ok(Math.abs((bags[1]?.kg ?? 0) - 10) < 1e-9);
  assert.ok((bags[1]?.t ?? 0) - (bags[0]?.t ?? 0) >= 10_000);
  const ground = [...w.logistics.bags.values()].filter((b) => b.tier === 4);
  assert.ok(ground.length >= 1 && ground.every((b) => b.tint === 3));
  // Full batches: one per 10 s.
  w.logistics.restoreBuffer(machine, load({ copper: 60 }));
  const batches = emissions(w, machine, 400, 4);
  assert.equal(batches.length, 3);
  for (let i = 1; i < batches.length; i++) assert.ok((batches[i]?.t ?? 0) - (batches[i - 1]?.t ?? 0) >= 10_000);
  // A copper lot that does not fit the 100 kg buffer waits.
  w.logistics.restoreBuffer(machine, load({ copper: 95 }));
  const waiting = lot(w, feed, 0.95, 10, 2);
  w.ticks(3);
  assert.equal(w.logistics.cargo.get(waiting)?.node, feed);
});

test('baler: absorbs ferrous, a 50 kg Fémbála (tier 3, tint 2) per 8 s, never a partial bale', () => {
  const { w, machine } = line(TYPE.baler);
  w.logistics.restoreBuffer(machine, load({ iron: 130 }));
  const bales = emissions(w, machine, 300, 3);
  assert.equal(bales.length, 2, '130 kg → two bales, 30 kg stays');
  assert.ok(bales.every((b) => Math.abs(b.kg - 50) < 1e-9));
  assert.ok((bales[1]?.t ?? 0) - (bales[0]?.t ?? 0) >= 8_000);
  assert.ok(Math.abs(loadKg(w.logistics.bufferOf(machine) ?? load({})) - 30) < 1e-9);
  assert.ok([...w.logistics.bags.values()].filter((b) => b.tier === 3).every((b) => b.tint === 2));
});

test('magnet sends ferrous lots to the side; trommel screens bulk lots to the side and finds coins (injected chance)', () => {
  const { w, feed, machine } = line(TYPE.magnet);
  const ids = [lot(w, feed, 0.9, 5, 1), lot(w, feed, 0.2, 5, 2)];
  const routes = new Map<number, number>();
  for (let i = 0; i < 20; i++) {
    w.tick();
    for (const c of w.logistics.cargo.values()) if (c.node === machine) routes.set(c.id, c.route);
  }
  assert.deepEqual(ids.map((id) => routes.get(id)), [1, 0]);

  const t = line(TYPE.trommel);
  let draws: boolean[] = [true, true];
  t.w.room.logisticsChance = () => draws.shift() ?? false;
  const funds = t.w.room.teamFunds;
  const life = t.w.room.lifetimeEarned;
  const bulk = lot(t.w, t.feed, 0.9, 5, 0);
  t.w.events.clear();
  t.w.ticks(3);
  assert.equal(t.w.logistics.cargo.get(bulk)?.route, 1);
  assert.equal(t.w.room.teamFunds, funds + 50);
  assert.equal(t.w.room.lifetimeEarned, life + 50);
  const coins = t.w.events.of('economy').map(([, u]) => (u as EconomyUpdate).coins).find((c) => c !== undefined);
  assert.deepEqual(coins, [[t.machine, 50]]);
  draws = [true, false, true];
  lot(t.w, t.feed, 0.9, 5, 0);
  t.w.ticks(12);
  assert.equal(t.w.room.teamFunds, funds + 150, 'second coin: 100 Ft');
  // A screened lot that re-enters a trommel (series or a belt loop) never rolls again.
  const again = t.w.logistics.cargo.get(bulk);
  assert.ok(again?.screened);
  draws = [true, true, true, true];
  const from = t.w.logistics.nodes.get(t.machine);
  const to = t.w.logistics.nodes.get(t.feed);
  assert.ok(from && to);
  from.queue.splice(from.queue.indexOf(again), 1);
  to.queue.push(again);
  again.node = t.feed;
  again.s = 0.9;
  t.w.ticks(3);
  assert.equal(again.node, t.machine, 'it re-entered the trommel');
  assert.equal(t.w.room.teamFunds, funds + 150, 'no second roll for the same lot');
  draws = [];
  const copper = lot(t.w, t.feed, 0.9, 5, 2);
  t.w.ticks(12);
  assert.equal(t.w.logistics.cargo.get(copper)?.route, 0, 'copper goes straight, no roll');
  assert.equal(t.w.room.teamFunds, funds + 150);
});

test('a machine jams after 10 s of waiting; wear → smoking (timer × 0.5) → grease 4 points → reset; every grease refusal', () => {
  const { w, feed, machine } = line(TYPE.stripper);
  const outBelt = w.place(TYPE.belt1, 4, -8);
  const out = w.logistics.structures.get(outBelt);
  assert.ok(out);
  out.flags |= 1;
  lot(w, feed, 0.9, 10, 0);
  w.ticks(Math.floor(9_000 / 84));
  assert.equal(w.logistics.isJammed(machine), false);
  w.ticks(60);
  assert.equal(w.logistics.isJammed(machine), true);
  w.logistics.clearJam(machine);
  out.flags &= ~1;

  const st = w.logistics.structures.get(machine);
  assert.ok(st);
  assert.equal(code(() => w.act({ kind: 'grease', id: machine, point: 0 })), 'noGreaseGun');
  w.player.personal.greaseGun = true;
  assert.equal(code(() => w.act({ kind: 'grease', id: machine, point: 0 })), 'noGreaseNeeded');
  assert.equal(code(() => w.act({ kind: 'grease', id: feed, point: 0 })), 'unknownStructure');
  st.wear = 1_490;
  w.logistics.restoreBuffer(machine, load({ copper: 60 }));
  const first = emissions(w, machine, 130, 4);
  assert.equal(first.length, 1, 'clearJam reset the timer: one batch after 10 s');
  assert.ok((st.flags & FLAG_SMOKE) !== 0, 'smoking at 1 500 kg');
  assert.equal(w.logistics.structRow(st)[7] & FLAG_SMOKE, FLAG_SMOKE);
  const slow = emissions(w, machine, 300, 4);
  assert.ok(slow.length >= 1);
  assert.ok((slow[0]?.t ?? 0) - (first[0]?.t ?? 0) >= 20_000, 'the cycle takes twice as long');
  const corner = (point: number): [number, number] => {
    const [lx, lz] = servicePoint(TYPE.stripper, point);
    const [ox, oz] = rotate(st.rot, lx, lz);
    return [st.x + ox, st.z + oz];
  };
  w.at(4, -2);
  assert.equal(code(() => w.act({ kind: 'grease', id: machine, point: 0 })), 'notAtServicePoint');
  const results: unknown[] = [];
  for (const point of [0, 1, 2, 3]) {
    const [x, z] = corner(point);
    w.at(x + (point & 1 ? 0.5 : -0.5), z);
    results.push(w.act({ kind: 'grease', id: machine, point }));
    if (point === 0) assert.equal(code(() => w.act({ kind: 'grease', id: machine, point: 0 })), 'alreadyGreased');
    if (point < 3) assert.equal((st.flags >> GREASE_SHIFT) & 0b1111, (1 << (point + 1)) - 1);
  }
  assert.deepEqual(results, [{ ok: true, mask: 1, done: false }, { ok: true, mask: 3, done: false }, { ok: true, mask: 7, done: false }, { ok: true, mask: 15, done: true }]);
  assert.equal(st.wear, 0);
  assert.equal(st.flags & (FLAG_SMOKE | (0b1111 << GREASE_SHIFT)), 0);
  assert.equal(code(() => w.act({ kind: 'grease', id: machine, point: 1 })), 'noGreaseNeeded');
});

test('placement rule 5b (noBlueprint) after the caps; the machine cap; machines are colliders and jammable', () => {
  const w = world();
  w.at(4, -2);
  assert.equal(w.tryPlace(TYPE.baler, 4, -6.5), 'noBlueprint');
  w.room.economy.bp = 1 << (TYPE.baler - TYPE.stripper);
  assert.equal(w.tryPlace(TYPE.stripper, 4, -6.5), 'noBlueprint');
  assert.equal(w.tryPlace(TYPE.baler, 4, -6.5), 'ok');
  w.tick();
  assert.ok(w.logistics.colliders.near(4, -6.5, 0).some((c) => c.shape === 'box' && c.h === 2.4));
  w.room.economy.bp = 0b1111;
  // Free lattice spots near the pose until the cap is reached.
  let placed = 1;
  const spots: Array<[number, number]> = [];
  for (let x = -6; x <= 12; x += 2.5) for (let z = -12; z <= 8; z += 2.5) spots.push([x, z]);
  for (const [x, z] of spots) if (placed < CAPS.machines && w.tryPlace(TYPE.magnet, x, z) === 'ok') placed++;
  assert.equal(placed, CAPS.machines);
  assert.equal(spots.map(([x, z]) => w.tryPlace(TYPE.magnet, x, z)).filter((c) => c === 'ok').length, 0);
  assert.ok(spots.some(([x, z]) => w.tryPlace(TYPE.magnet, x, z) === 'buildLimit'));
  assert.equal(CAP_NAMES.machines, 'gép');
});

test('power: active machines draw their kW; pf scales belt s, machine timers and waitMs; a 60 s blackout jams nothing', () => {
  const { w, feed, machine } = line(TYPE.baler);
  assert.equal(w.logistics.machineDemandW(), 0, 'idle');
  w.logistics.restoreBuffer(machine, load({ iron: 60 }));
  assert.equal(w.logistics.machineDemandW(), 7_500);
  // Brownout factor straight on the world: belt s advances 0.4 × as far.
  const a = lot(w, feed, 0, 5, 2);
  w.logistics.tick(100, w.clock.ms, 0.4);
  assert.ok(Math.abs((w.logistics.cargo.get(a)?.s ?? 0) - 1.4 * 0.1 * 0.4) < 1e-9);
  // Blackout in the room: night (no solar), an empty battery, demand > 0.
  w.clock.ms += 1_500_000;
  w.room.economy.grid.battWh = 0;
  w.ticks(13);
  assert.equal(w.room.economy.grid.st, 2);
  const s = w.logistics.cargo.get(a)?.s;
  w.ticks(60, 1_000);
  assert.equal(w.logistics.cargo.get(a)?.s, s, 'nothing moves');
  assert.equal(w.logistics.cargo.get(a)?.waitMs, 0, 'and nothing waits');
  assert.equal(w.logistics.isJammed(machine), false);
  // Telemetry kW reports the grid demand: 12 W per belt metre plus the active baler.
  const office = w.room.initState(w.player, 12, w.clock.ms).layout.landmarks.office;
  w.at(office.x, office.z + 3);
  w.events.clear();
  w.act({ kind: 'telemetry', on: true });
  w.tick();
  const kW = (w.events.of('logisticsTelemetry')[0]?.[1] as { kW: number } | undefined)?.kW;
  assert.equal(kW, (12 * 1 + 7_500) / 1000);
});
