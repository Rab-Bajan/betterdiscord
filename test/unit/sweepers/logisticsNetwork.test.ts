// Phase D network simulation (plan D.2): belt queues, links, open ends, splitter, merger, hopper,
// packager, jams, telemetry, fences, caps and the size budgets of init and logistics_update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadKg } from '../../../src/modules/sweepers/debris/personal.ts';
import { hexAt } from '../../../src/modules/sweepers/hexGrid.ts';
import { loadValue } from '../../../src/modules/sweepers/logistics/LogisticsWorld.ts';
import type { LogisticsUpdate } from '../../../src/modules/sweepers/logistics/LogisticsWorld.ts';
import { exceededCap } from '../../../src/modules/sweepers/logistics/placement.ts';
import { footprint } from '../../../src/modules/sweepers/logistics/shapes.ts';
import type { Structure } from '../../../src/modules/sweepers/logistics/shapes.ts';
import { CAP_NAMES, CAPS, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import { load, world } from './logisticsSupport.ts';

type W = ReturnType<typeof world>;
let nextCargo = 1_000;
const lot = (w: W, node: number, s: number, kg = 10, sub = 0, waitMs = 0): number => {
  const id = nextCargo++;
  const contents = sub === 0 ? load({ dust: kg }) : sub === 1 ? load({ iron: kg }) : load({ copper: kg });
  assert.ok(w.logistics.restoreCargo({ id, kind: 0, sub, tint: sub + 1, node, s, route: 0, waitMs, load: contents }));
  return id;
};
const sOf = (w: W, id: number): number => w.logistics.cargo.get(id)?.s ?? NaN;
const updates = (w: W): LogisticsUpdate[] => w.events.of('logisticsUpdate').map(([, u]) => u as LogisticsUpdate);
const jam = (w: W, id: number, on: boolean): void => {
  const st = w.logistics.structures.get(id);
  assert.ok(st);
  st.flags = on ? st.flags | 1 : st.flags & ~1;
};

test('belt queue: 1.4 m/s, 0.6 m pitch, transfer only into a free entry, a 1 s stall (and a 1 s step) never tunnels', () => {
  const w = world();
  w.at(4, -4);
  const a = w.place(TYPE.belt5, 4, -6);
  const split = w.place(TYPE.splitter, 4, -9);
  const head = lot(w, a, 1);
  const second = lot(w, a, 0);
  w.tick();
  assert.ok(Math.abs(sOf(w, head) - (1 + 1.4 * 0.084)) < 1e-9);
  assert.ok(Math.abs(sOf(w, second) - 1.4 * 0.084) < 1e-9);
  // Stall: the splitter is jammed, so the head waits at the end and the second keeps the pitch.
  jam(w, split, true);
  w.ticks(40);
  assert.equal(sOf(w, head), 5);
  assert.ok(Math.abs(sOf(w, second) - 4.4) < 1e-9);
  w.ticks(12);
  w.tick(1_000);
  assert.equal(sOf(w, head), 5, 'still on the belt after a 1 s step');
  assert.ok(sOf(w, head) - sOf(w, second) >= 0.6 - 1e-9);
  assert.equal(w.logistics.cargo.get(head)?.mv, 0);
  assert.ok((w.logistics.cargo.get(head)?.waitMs ?? 0) >= 1_000);
  jam(w, split, false);
  w.tick();
  assert.equal(w.logistics.cargo.get(head)?.node, split, 'the head transfers at s = 0');
  assert.equal(sOf(w, head), 0);
  w.tick();
  assert.equal(w.logistics.cargo.get(second)?.node, a, 'the second waits until the entry is free (s ≥ 0.6)');
  w.ticks(6);
  assert.equal(w.logistics.cargo.get(second)?.node, split);
  // Open end: lots spill as debris past the splitter's straight port.
  const items = w.room.debris.items.size;
  const cells = [...w.room.debris.cells].reduce((s, c) => s + c, 0);
  w.ticks(30);
  assert.equal(w.logistics.cargo.size, 0);
  assert.ok(w.room.debris.items.size > items || [...w.room.debris.cells].reduce((s, c) => s + c, 0) > cells);
});

test('splitter routes copper left, ferrous right, bulk and bags straight; merger alternates', () => {
  const w = world();
  w.at(4, -4);
  const feed = w.place(TYPE.belt1, 4, -5);
  const split = w.place(TYPE.splitter, 4, -6);
  const ids = [lot(w, feed, 1, 5, 2), lot(w, feed, 0.3, 5, 1)];
  const routes = new Map<number, number>();
  for (let i = 0; i < 30; i++) {
    w.tick();
    for (const c of w.logistics.cargo.values()) if (c.node === split) routes.set(c.id, c.route);
  }
  assert.deepEqual(ids.map((id) => routes.get(id)), [1, 2]);
  const bulk = lot(w, feed, 1, 5, 0);
  w.ticks(2);
  assert.equal(w.logistics.cargo.get(bulk)?.route, 0);

  // Merger rot 0 at (8, -5): fed from the left by a belt1 rot 1 and from the right by a belt1 rot 3.
  const merger = w.place(TYPE.merger, 8, -5);
  const left = w.place(TYPE.belt1, 7, -5, 1);
  const right = w.place(TYPE.belt1, 9, -5, 3);
  const leftIds = [lot(w, left, 1), lot(w, left, 0.35)];
  const rightIds = [lot(w, right, 1), lot(w, right, 0.35)];
  const entered: number[] = [];
  for (let i = 0; i < 60; i++) {
    w.tick();
    for (const c of w.logistics.cargo.values()) if (c.node === merger && !entered.includes(c.id)) entered.push(c.id);
  }
  assert.equal(entered.length, 4);
  const side = entered.map((id) => (leftIds.includes(id) ? 'L' : rightIds.includes(id) ? 'R' : '?'));
  assert.ok(side.join('') === 'LRLR' || side.join('') === 'RLRL', side.join(''));
});

test('hopper: queued bags first, then ≤ 20 kg lots round-robin bulk → ferrous → copper, one per 500 ms; lot cap', () => {
  const w = world();
  w.at(14, 4);
  const belt = w.place(TYPE.belt5, 14, 7.5);
  w.logistics.fillHopper(0, load({ dust: 45, iron: 30, copper: 3 }));
  for (const id of [7_001, 7_002]) assert.ok(w.logistics.restoreCargo({ id, kind: 1, sub: 0, tint: 0, node: 0, s: 0, route: 0, waitMs: 0, load: load({ dust: 5 }) }));
  const order: string[] = [];
  const times: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < 70; i++) {
    w.tick();
    for (const c of w.logistics.cargo.values()) {
      if (c.node !== belt || seen.has(c.id)) continue;
      seen.add(c.id);
      order.push(c.kind === 1 ? 'bag' : `lot${c.sub}:${loadKg(c.load)}`);
      times.push(w.clock.ms);
    }
  }
  assert.deepEqual(order.slice(0, 8), ['bag', 'bag', 'lot0:20', 'lot1:20', 'lot2:3', 'lot0:20', 'lot1:10', 'lot0:5']);
  for (let i = 1; i < times.length; i++) assert.ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= 500, `${times[i - 1]} → ${times[i]}`);

  // Lot cap: with 150 lots in the world the hopper keeps its contents.
  const w2 = world();
  w2.at(14, 4);
  const b2 = w2.place(TYPE.belt5, 14, 7.5);
  const parking = w2.logistics.add({ type: TYPE.belt5, x: 4, z: -6, rot: 0, lvl: 0 }, 0)?.id ?? 0;
  for (let i = 0; i < CAPS.lots; i++) lot(w2, parking, 0.01 * i, 1);
  jam(w2, parking, true);
  w2.logistics.fillHopper(0, load({ dust: 50 }));
  w2.ticks(20);
  assert.equal([...w2.logistics.cargo.values()].filter((c) => c.node === b2).length, 0);
});

test('packager: absorbs lots up to 200 kg, emits a 20 kg tier-1 tinted bag every 3 s; flushes a partial bag after 10 s idle', () => {
  const w = world();
  w.at(4, -2);
  const feed = w.place(TYPE.belt1, 4, -5);
  const pk = w.place(TYPE.packager, 4, -6.5);
  w.place(TYPE.belt1, 4, -8);
  assert.ok(w.logistics.restoreBuffer(pk, load({ iron: 185 })));
  const blocked = lot(w, feed, 0.9, 20, 0);
  w.ticks(3);
  assert.equal(w.logistics.cargo.get(blocked)?.node, feed, '185 + 20 > 200 kg: the lot waits');
  const bagTimes: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < 120; i++) {
    w.tick();
    for (const c of w.logistics.cargo.values()) {
      if (c.node === pk && c.kind === 1 && !seen.has(c.id)) {
        seen.add(c.id);
        bagTimes.push(w.clock.ms);
        assert.equal(c.sub, 1);
        assert.ok(c.bag && loadKg(c.bag.load) <= 20 + 1e-9);
      }
    }
  }
  assert.equal(w.logistics.cargo.has(blocked), false, 'absorbed once the buffer dropped below 180 kg');
  assert.ok(bagTimes.length >= 3);
  for (let i = 1; i < bagTimes.length; i++) assert.ok((bagTimes[i] ?? 0) - (bagTimes[i - 1] ?? 0) >= 3_000);
  const bag = [...w.logistics.bags.values()].find((b) => b.st === 0);
  assert.equal(bag?.tint, 2, 'ferrous dominant → tint 2');

  // A partial buffer (< 20 kg) is flushed after 10 s without input.
  const w2 = world();
  w2.at(4, -2);
  const pk2 = w2.place(TYPE.packager, 4, -6.5);
  w2.logistics.restoreBuffer(pk2, load({ dust: 7 }));
  w2.ticks(100);
  assert.equal(w2.logistics.bags.size, 0);
  w2.ticks(30);
  assert.equal(w2.logistics.bags.size, 1);
});

test('jam at 10 s of waiting at a junction, clearJam ejects 1 m to the right; refusals in order', () => {
  const w = world();
  w.logistics.fillHopper(0, load({ dust: 2_000 }));
  w.at(11, 6);
  const feed = w.place(TYPE.belt1, 11, 8, 2);
  const split = w.place(TYPE.splitter, 11, 9, 2);
  const id = lot(w, feed, 0.9, 20);
  w.ticks(Math.floor(9_500 / 84));
  assert.equal(w.logistics.isJammed(split), false);
  w.ticks(24);
  assert.equal(w.logistics.isJammed(split), true);
  assert.equal(w.logistics.telemetry().jams, 1);
  assert.ok(updates(w).some((u) => (u.s ?? []).some((row) => row[0] === split && (row[7] & 1) === 1)));
  const s = w.logistics.cargo.get(id)?.s;
  w.ticks(3);
  assert.equal(w.logistics.cargo.get(id)?.s, s, 'a jammed node moves nothing');

  assert.equal(code(() => w.act({ kind: 'clearJam', id: feed })), 'notJammed');
  w.player.personal.toolTier = 4;
  assert.equal(code(() => w.act({ kind: 'clearJam', id: split })), 'needBroom');
  w.player.personal.toolTier = 0;
  w.at(11, 3);
  assert.equal(code(() => w.act({ kind: 'clearJam', id: split })), 'tooFar');
  w.at(11, 7);
  const debris = w.room.debris.items.size + [...w.room.debris.cells].reduce((a, c) => a + c, 0);
  assert.deepEqual(w.act({ kind: 'clearJam', id: split }), { ok: true });
  assert.equal(w.logistics.isJammed(split), false);
  assert.equal(w.logistics.cargo.has(id), false);
  assert.ok(w.room.debris.items.size + [...w.room.debris.cells].reduce((a, c) => a + c, 0) > debris);
});

test('telemetry formulas, the 1 Hz push to subscribers near the office, fence factor, caps', () => {
  const w = world();
  w.at(4, -4);
  const belt = w.place(TYPE.belt5, 4, -6);
  lot(w, belt, 4.9, 10, 0);
  lot(w, belt, 4, 2, 2);
  let t = w.logistics.telemetry();
  assert.deepEqual(t, { kgMin: 0, loadPct: 24, kW: 0.06, ftHour: 0, beltM: 5, jams: 0 });
  const value = loadValue(load({ dust: 10 })) + loadValue(load({ copper: 2 }));
  w.ticks(20);
  t = w.logistics.telemetry();
  assert.equal(t.kgMin, 12);
  assert.equal(t.ftHour, Math.round(60 * value));
  w.ticks(61, 1_000);
  assert.equal(w.logistics.telemetry().kgMin, 0, 'the 60 s window rolled over');

  const office = w.room.initState(w.player, 12, w.clock.ms).layout.landmarks.office;
  w.at(office.x, office.z + 12);
  assert.equal(code(() => w.act({ kind: 'telemetry', on: true })), 'notAtTerminal');
  w.at(office.x, office.z + 3);
  w.events.clear();
  assert.deepEqual(w.act({ kind: 'telemetry', on: true }), { ok: true });
  w.ticks(25);
  assert.equal(w.events.of('logisticsTelemetry').length, 3, 'at once, then at 1 s and 2 s');
  w.at(office.x, office.z + 13);
  w.ticks(13);
  assert.equal(w.events.of('logisticsTelemetry').length, 3, 'dropped beyond 12 m');

  const hex = hexAt(-20, 10)?.id ?? -1;
  for (let i = 0; i < 15; i++) w.logistics.add({ type: TYPE.fence, x: -20 + (i % 3) * 0.5, z: 10 + Math.floor(i / 3) * 0.5, rot: 0, lvl: 0 }, 0);
  assert.ok(Math.abs(w.logistics.fenceFactor(hex) - 0.5) < 1e-9);
  assert.equal(w.room.debris.respawnFactor(hex), w.logistics.fenceFactor(hex));

  const st = (type: number, i: number): Structure => ({ id: i + 1, type, x: 0, z: 0, rot: 0, lvl: 0, base: 0, flags: 0, rect: footprint(type, 0, 0, 0) });
  assert.equal(exceededCap(Array.from({ length: 60 }, (_, i) => st(TYPE.belt5, i)), TYPE.belt1), CAP_NAMES.beltM);
  assert.equal(exceededCap(Array.from({ length: 59 }, (_, i) => st(TYPE.belt5, i)), TYPE.belt5), null);
  assert.equal(exceededCap(Array.from({ length: CAPS.structures }, (_, i) => st(TYPE.fence, i)), TYPE.found2), CAP_NAMES.structures);
  assert.equal(exceededCap(Array.from({ length: CAPS.junctions }, (_, i) => st(TYPE.merger, i)), TYPE.splitter), CAP_NAMES.junctions);
});

test('size: init logistics ≤ 30 kB at full caps; logistics_update ≤ 8 kB; ≤ 1 kB/tick mean over 60 s on a saturated network', () => {
  const w = world();
  const L = w.logistics;
  for (let i = 0; L.structures.size < CAPS.structures; i++) {
    const x = -120 + (i % 40) * 6;
    const z = -120 + Math.floor(i / 40) * 6;
    const type = [TYPE.belt1, TYPE.found4, TYPE.splitter, TYPE.fence][i % 4] ?? TYPE.belt1;
    L.add({ type, x, z, rot: 0, lvl: 0 }, 0);
  }
  const belts = [...L.structures.values()].filter((s) => s.type === TYPE.belt1).map((s) => s.id);
  for (let i = 0; i < CAPS.lots; i++) lot(w, belts[i % belts.length] ?? 1, (i % 2) * 0.5, 19.99, i % 3);
  for (let i = 0; L.bags.size < CAPS.bags; i++) L.restoreGroundBag({ id: 20_000 + i, tier: i % 3, tint: i % 4, x: 100 + (i % 20), z: -100 + Math.floor(i / 20), rot8: i % 256, load: load({ dust: 19.99 }) });
  const init = JSON.stringify(L.initPayload()).length;
  assert.ok(init <= 30_000, `${init} B`);
  for (const bag of L.bags.values()) L.touchBag(bag);
  const update = JSON.stringify(L.takeUpdate(1)).length;
  assert.ok(update <= 8_192, `${update} B`);
  assert.ok(L.takeUpdate(2), 'the rest carries over (FIFO)');

  // Saturated: hopper (2 000 kg mixed) → bendR → belt5 → splitter → three belts, one via a packager.
  const s = world();
  s.at(17, 6);
  s.place(TYPE.bendR, 14, 9.5);
  s.place(TYPE.belt5, 17, 9.5, 1);
  s.place(TYPE.splitter, 20, 9.5, 1);
  s.place(TYPE.belt1, 20, 10.5, 2);
  s.place(TYPE.packager, 21.5, 9.5, 1);
  s.place(TYPE.belt1, 23, 9.5, 1);
  s.place(TYPE.belt1, 20, 8.5, 0);
  s.logistics.fillHopper(0, load({ dust: 700, iron: 650, copper: 650 }));
  s.events.clear();
  const ticks = Math.round(60_000 / 84);
  s.ticks(ticks);
  const sizes = updates(s).map((u) => JSON.stringify(u).length);
  const mean = sizes.reduce((a, b) => a + b, 0) / ticks;
  assert.ok(Math.max(...sizes) <= 8_192);
  assert.ok(mean <= 1_024, `${mean.toFixed(0)} B/tick`);
  assert.ok(s.logistics.telemetry().kgMin > 100, 'the network was actually moving');
});

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { details?: { reason?: string }; code?: string }).details?.reason ?? (err as { code?: string }).code ?? String(err);
  }
  return 'ok';
}
