// Phase D bags (plan D.2, D.4): tie, throw arcs, stacking, rupture, bags vs C code, carrying,
// dump into the hopper, the crane and the bag shop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { loadKg } from '../../../src/modules/sweepers/debris/personal.ts';
import { ITEM_KINDS } from '../../../src/modules/sweepers/debris/tables.ts';
import { districtAt } from '../../../src/modules/sweepers/hexGrid.ts';
import { rectHitsCollider } from '../../../src/modules/sweepers/logistics/shapes.ts';
import { BAG_TIERS, CRANE, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import { guest } from './support.ts';
import { code, load, ROOM, world } from './logisticsSupport.ts';

test('tie: moveLoad limits per tier, check order, cadence, stock, room cap and Big-Bag fill without stock', () => {
  const w = world();
  w.at(4, 4);
  w.player.personal.pack = load({});
  assert.equal(code(() => w.tie(0)), 'emptyPack');
  w.player.personal.pack = load({ dust: 25 });
  const stock = [...w.player.personal.bags];
  const first = w.tie(0);
  assert.deepEqual({ ...first, id: 0 }, { ok: true, id: 0, tier: 0, kg: 20 });
  assert.ok(Math.abs(loadKg(w.player.personal.pack) - 5) < 1e-9, 'the rest stays in the pack');
  assert.equal(w.player.personal.bags[0], (stock[0] ?? 0) - 1);
  const bag = w.logistics.bags.get(first.id);
  assert.ok(bag && Math.hypot(bag.x - 4, bag.z - 3.4) < 0.7, 'in front of the player');
  w.clock.ms += 959;
  assert.equal(code(() => w.tie(0)), 'SWEEPERS_TOO_FAST', 'within 0.8 × 1.2 s');
  w.clock.ms += 1;
  w.player.personal.bags[1] = 0;
  assert.equal(code(() => w.tie(1)), 'noBags');
  w.player.personal.bags[1] = 1;
  w.player.personal.pack = load({ jackpots: [7] });
  assert.equal(code(() => w.tie(0)), 'bagTooSmall', 'a 60+ kg jackpot fits no 20 kg bag');
  assert.equal(w.player.personal.bags[1], 1, 'a refusal changes nothing');
  w.player.personal.pack = load({ iron: 70 });
  assert.equal(w.tie(1).kg, 50);

  // Big-Bag: a tier-2 tie within 2.5 m of a ground Big-Bag fills it and uses no stock.
  const big = w.tieAt(-8, -2, { dust: 30 }, 2);
  const bigStock = w.player.personal.bags[2];
  const fill = w.tieAt(-8, -2.5, { dust: 40 }, 2);
  assert.equal(fill.id, big.id);
  assert.equal(w.player.personal.bags[2], bigStock);
  assert.ok(Math.abs(loadKg(w.logistics.bags.get(big.id)?.load ?? load({})) - 70) < 1e-9);

  // Locked district and the room cap.
  const locked = world(false);
  locked.player.personal.pack = load({ dust: 5 });
  locked.at(38, 0);
  assert.notEqual(districtAt(38, 0), 0);
  assert.equal(code(() => locked.tie(0)), 'lockedDistrict');
  for (let i = 0; w.logistics.bags.size < 300; i++) w.logistics.restoreGroundBag({ id: 30_000 + i, tier: 0, tint: 0, x: -40 + (i % 20), z: 20 + Math.floor(i / 20), rot8: 0, load: load({ dust: 1 }) });
  assert.equal(code(() => w.tieAt(4, 4, { dust: 5 })), 'tooManyBags');
});

test('carry: pickup reach and tiers, handsFull on tie / pickup / sweep, notCarrying; the tick row carries the bag id', () => {
  const w = world();
  const a = w.tieAt(4, 4, { dust: 10 });
  const b = w.tieAt(6, 4, { dust: 10 });
  w.at(4, 7);
  assert.equal(code(() => w.act({ kind: 'pickup', id: a.id })), 'noBagNear');
  assert.equal(code(() => w.act({ kind: 'throw', power: 5, pitch: 0, rotY: 0 })), 'notCarrying');
  w.at(4, 4);
  assert.deepEqual(w.act({ kind: 'pickup', id: a.id }), { ok: true });
  assert.equal(w.player.carry, a.id);
  assert.equal(code(() => w.act({ kind: 'pickup', id: b.id })), 'handsFull');
  w.clock.ms += 2_000;
  w.player.personal.pack = load({ dust: 5 });
  assert.equal(code(() => w.tie(0)), 'handsFull');
  assert.equal(code(() => w.service.sweepHit('s1', { channelId: ROOM, seq: 99, tool: 0, alt: false, x: 4, z: 4, rotY: 0 })), 'handsFull');
  w.events.clear();
  w.tick();
  const sync = w.events.of('tickSync').at(-1)?.[1] as { p: number[][] };
  assert.equal(sync.p.find((row) => row[0] === w.player.id)?.length, 9);
  assert.equal(sync.p.find((row) => row[0] === w.player.id)?.[8], a.id);
  w.act({ kind: 'throw', power: 0, pitch: 0, rotY: 0 });
  const big = w.tieAt(-8, -2, { dust: 30 }, 2);
  assert.equal(code(() => w.act({ kind: 'pickup', id: big.id })), 'bigBagCrane');
});

test('carry survives a reconnect within the grace window; removal drops the bag at the last pose', () => {
  const w = world();
  const bag = w.tieAt(4, 4, { dust: 10 });
  w.act({ kind: 'pickup', id: bag.id });
  w.at(5, 2);
  w.service.disconnect('s1');
  w.clock.ms += 60_000;
  w.service.tick();
  w.service.join(ROOM, 's2', guest('Builder'));
  const back = w.room.bySocket('s2');
  assert.equal(back?.carry, bag.id);
  assert.equal(w.logistics.bags.get(bag.id)?.st, 1);
  w.service.disconnect('s2');
  w.clock.ms += 121_000;
  w.service.tick();
  const dropped = w.logistics.bags.get(bag.id);
  assert.equal(dropped?.st, 0);
  assert.ok(dropped && Math.hypot(dropped.x - 5, dropped.z - 1.5) < 0.6, `${dropped?.x},${dropped?.z}`);
});

test('throw arc: lands on the ground, stops at a collider, stops at a locked district, enters the hopper, lands on a belt', () => {
  const w = world();
  const carry = (x: number, z: number, rotY = 0): number => {
    const tied = w.tieAt(x, z, { dust: 10 }, 0, rotY);
    w.act({ kind: 'pickup', id: tied.id });
    return tied.id;
  };
  carry(4, 4);
  const ground = w.act({ kind: 'throw', power: 6, pitch: 0.5, rotY: 0 }) as { into: string; to: number[]; burst: boolean };
  assert.equal(ground.into, 'ground');
  assert.ok((ground.to[2] ?? 0) < 0 && !ground.burst, JSON.stringify(ground));
  w.events.clear();
  w.tick();
  const arc = (w.events.of('logisticsUpdate').at(-1)?.[1] as { arcs?: number[][] }).arcs?.[0];
  assert.ok(arc && arc.length === 9 && (arc[7] ?? 0) > (arc[2] ?? 0), 'an arc row with its apex');

  // The office container (box at (15, -6.6), 6 × 2.5, h 2.6): the bag stops at its wall.
  carry(15, -2);
  const wall = w.act({ kind: 'throw', power: 8, pitch: 0.2, rotY: 0 }) as { to: number[] };
  assert.ok((wall.to[2] ?? 0) / 100 > -5.35 + 0.05, `${wall.to}`);

  // Hopper: thrown from outside the intake zone into it.
  const into = carry(14, 17);
  assert.equal((w.act({ kind: 'throw', power: 4, pitch: 0.4, rotY: 0 }) as { into: string }).into, 'hopper');
  assert.equal(w.logistics.cargo.get(into)?.node, 0);

  // Onto a belt deck.
  w.at(4, -2);
  const belt = w.place(TYPE.belt5, 4, -7);
  carry(4, -2.5);
  assert.equal((w.act({ kind: 'throw', power: 3, pitch: 0, rotY: 0 }) as { into: string }).into, 'belt');
  assert.equal([...w.logistics.cargo.values()].filter((c) => c.node === belt).length, 1);

  // Locked district: the bag falls short of the first locked point.
  const l = world(false);
  const id = l.tieAt(33, 0, { dust: 5 }, 0, -Math.PI / 2).id;
  l.act({ kind: 'pickup', id });
  l.act({ kind: 'throw', power: 12, pitch: 0.3, rotY: -Math.PI / 2 });
  const b = l.logistics.bags.get(id);
  assert.ok(b && districtAt(b.x, b.z) === 0, `${b?.x}`);
});

test('stacking: bags pile up to the stack limit, then slide beside; rupture only for a sharp tier-0 bag on a long fall', () => {
  const w = world();
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) {
    const tied = w.tieAt(4, 4, { dust: 5 });
    w.act({ kind: 'pickup', id: tied.id });
    w.act({ kind: 'throw', power: 0, pitch: 0, rotY: 0 });
    ids.push(tied.id);
  }
  const bags = ids.map((id) => w.logistics.bags.get(id));
  assert.ok(bags.every((b) => b && b.st === 0));
  const [b0, b1, b2, b3] = bags;
  assert.ok(b0 && b1 && b2 && b3);
  assert.ok(b1.y > b0.y && b2.y > b1.y, 'stacked');
  assert.equal(b3.y, 0, 'the fourth slid beside the full stack');
  assert.ok(Math.hypot(b3.x - b0.x, b3.z - b0.z) >= 0.5);

  const throwHigh = (tier: number, kg: Parameters<typeof load>[0], chance: boolean) => {
    w.room.logisticsChance = () => chance;
    const tied = w.tieAt(-4, 6, kg, tier);
    w.act({ kind: 'pickup', id: tied.id });
    return { id: tied.id, ack: w.act({ kind: 'throw', power: 10, pitch: 1.2, rotY: Math.PI }) as { burst: boolean } };
  };
  const debris = (): number => w.room.debris.items.size + [...w.room.debris.cells].reduce((s, c) => s + c, 0);
  const before = debris();
  const burst = throwHigh(0, { iron: 16 }, true);
  assert.equal(burst.ack.burst, true);
  assert.equal(w.logistics.bags.has(burst.id), false);
  assert.ok(debris() > before, 'the contents spilled');
  w.events.clear();
  w.tick();
  assert.ok((w.events.of('logisticsUpdate').at(-1)?.[1] as { burst?: unknown[] }).burst?.length === 1);
  assert.equal(throwHigh(0, { iron: 16 }, false).ack.burst, false, 'the 40 % draw failed');
  assert.equal(throwHigh(0, { iron: 14, dust: 5 }, true).ack.burst, false, 'sharp mass ≤ 15 kg');
  w.player.personal.bags[1] = 5;
  assert.equal(throwHigh(1, { iron: 30 }, true).ack.burst, false, 'tier 1 never bursts');
  w.room.logisticsChance = () => true;
  const low = w.tieAt(-4, 6, { iron: 16 });
  w.act({ kind: 'pickup', id: low.id });
  assert.equal((w.act({ kind: 'throw', power: 0, pitch: 0, rotY: 0 }) as { burst: boolean }).burst, false, 'a drop is no long fall');
});

test('bags are not debris: no bag item kinds, tools and kicks never touch them, cleanliness ignores them', () => {
  assert.equal(ITEM_KINDS.length, 8);
  const w = world();
  const hex = 0;
  const mass = w.room.debris.massOf(hex);
  const bag = w.tieAt(4, 4, { dust: 10 });
  const row = w.logistics.bagRow(w.logistics.bags.get(bag.id)!);
  assert.equal(w.room.debris.massOf(hex), mass, 'the tied load left the pack, not the ground');
  w.at(4, 4);
  w.clock.ms += 2_000;
  w.service.sweepHit('s1', { channelId: ROOM, seq: 500, tool: 0, alt: false, x: 4, z: 3.5, rotY: 0 });
  // Kicks, the blower and the magnet act on debris items only; bags live in their own id space.
  w.ticks(30);
  assert.deepEqual(w.logistics.bagRow(w.logistics.bags.get(bag.id)!), row);
  assert.ok([...w.room.debris.items.values()].every((item) => item.kind < ITEM_KINDS.length));
});

test('dump into the hopper zone moves buffer + pack (hopperFull when nothing moved); outside it spills', () => {
  const w = world();
  w.at(14, 9);
  w.player.personal.pack = load({ dust: 12 });
  assert.deepEqual(w.service.playerAction('s1', { channelId: ROOM, kind: 'dump' }), { hopperKg: 12 });
  assert.ok(Math.abs(loadKg(w.logistics.bufferOf(0) ?? load({})) - 12) < 1e-9);
  w.logistics.fillHopper(0, load({ dust: 3_000 }));
  w.player.personal.pack = load({ dust: 1 });
  assert.equal(code(() => w.service.playerAction('s1', { channelId: ROOM, kind: 'dump' })), 'hopperFull');
  w.at(4, 4);
  assert.equal(w.service.playerAction('s1', { channelId: ROOM, kind: 'dump' }), null);
});

test('crane: refusals in order, duration = path / 1 m/s + 2 × 1.5 s, the bag ends at the target, the area is clear of layout colliders', () => {
  for (const c of cityLayout().colliders) assert.ok(!rectHitsCollider(CRANE.area, c), JSON.stringify(c));
  const w = world();
  const big = w.tieAt(-8, -2, { dust: 30 }, 2);
  const small = w.tieAt(4, 4, { dust: 3 });
  const crane = (bag: number, to: number) => w.act({ kind: 'crane', bag, to });
  assert.equal(code(() => crane(big.id, 1)), 'notAtCrane');
  w.at(CRANE.console.x, CRANE.console.z + 0.5);
  assert.equal(code(() => crane(small.id, 1)), 'notInCraneArea');
  const bag = w.logistics.bags.get(big.id);
  assert.ok(bag);
  const hook = w.logistics.hook;
  const target = CRANE.targets[1] ?? { x: 0, z: 0 };
  const expected = Math.round((Math.hypot(bag.x - hook.x, bag.z - hook.z) + Math.hypot(target.x - bag.x, target.z - bag.z)) * 1000 + 3_000);
  assert.deepEqual(crane(big.id, 1), { ok: true, durMs: expected });
  assert.equal(code(() => crane(big.id, 0)), 'craneBusy');
  w.ticks(Math.floor(expected / 84) - 1);
  assert.ok(w.logistics.craneJob);
  w.ticks(3);
  assert.equal(w.logistics.craneJob, null);
  assert.deepEqual([bag.st, bag.x, bag.z], [0, target.x, target.z]);
  assert.deepEqual(w.logistics.hook, target);
  assert.equal(code(() => crane(big.id, 1)), 'craneTargetBusy');
});

test('bag shop: buy at the workbench, bagStockFull at the cap; personal_update carries the stock', () => {
  const w = world();
  const office = cityLayout().landmarks.office;
  w.at(office.x, office.z + 3);
  w.player.personal.cash = 1_000;
  const before = w.player.personal.bags[1] ?? 0;
  assert.equal(w.service.buyUpgrade('s1', { channelId: ROOM, item: 'bag', tier: 1, qty: 1 }).cash, 1_000 - (BAG_TIERS[1]?.cost ?? 0));
  w.events.clear();
  w.tick();
  const personal = w.events.of('personalUpdate').at(-1)?.[1] as { bags: number[] };
  assert.equal(personal.bags[1], before + 1);
  w.player.personal.bags[0] = 99;
  assert.equal(code(() => w.service.buyUpgrade('s1', { channelId: ROOM, item: 'bag', tier: 0, qty: 1 })), 'bagStockFull');
});

test('deleting the foundation under a 2- or 3-stack lowers it in order: y ascending, no on-cycle, the top bag pickable', () => {
  for (const height of [2, 3]) {
    const w = world();
    w.at(4, 6);
    const found = w.place(TYPE.found2, 4, 4);
    const ids = Array.from({ length: height }, (_, i) => 40_000 + i);
    for (const id of ids) assert.ok(w.logistics.restoreGroundBag({ id, tier: 0, tint: 0, x: 4, z: 4, rot8: 0, load: load({ dust: 2 }) }));
    w.service.deleteStructure('s1', ROOM, found);
    const bags = ids.map((id) => w.logistics.bags.get(id)!);
    const h = BAG_TIERS[0]!.h;
    assert.deepEqual(bags.map((b) => Math.round(b.y * 100) / 100), ids.map((_, i) => Math.round(i * h * 100) / 100));
    assert.deepEqual(bags.map((b) => b.on), [0, ...ids.slice(0, -1)]);
    w.at(4, 5);
    assert.deepEqual(w.act({ kind: 'pickup', id: ids.at(-1)! }), { ok: true });
  }
});

test('taking the bottom bag of a 3-stack lowers the other two onto the ground in order, no on-cycle', () => {
  const w = world();
  const ids = [40_100, 40_101, 40_102];
  for (const id of ids) assert.ok(w.logistics.restoreGroundBag({ id, tier: 0, tint: 0, x: 6, z: 6, rot8: 0, load: load({ dust: 2 }) }));
  w.logistics.pickUp(w.logistics.bags.get(ids[0]!)!, w.player.id);
  const rest = ids.slice(1).map((id) => w.logistics.bags.get(id)!);
  const h = BAG_TIERS[0]!.h;
  assert.deepEqual(rest.map((b) => Math.round(b.y * 100) / 100), [0, Math.round(h * 100) / 100]);
  assert.deepEqual(rest.map((b) => b.on), [0, ids[1]]);
  assert.equal(w.logistics.onTop(rest[1]!), true);
});
