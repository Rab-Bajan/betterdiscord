// Phase D tables and placement (plan D.1, D.3): ports, every refusal and its order, foundation and
// base rules, delete rules, links on place and delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexAt } from '../../../src/modules/sweepers/hexGrid.ts';
import { footprint, worldPort } from '../../../src/modules/sweepers/logistics/shapes.ts';
import { BAG_TIERS, CAPS, rotYOf, STRUCT_TYPES, TYPE } from '../../../src/modules/sweepers/logistics/tables.ts';
import { parsePlaceStructure } from '../../../src/modules/sweepers/payloads.ts';
import { code, ROOM, world } from './logisticsSupport.ts';

test('tables: bag tiers, structure order, rotY and the ports of every type', () => {
  assert.deepEqual(BAG_TIERS.map((t) => [t.l, t.kg, t.cost, t.rupture, t.carry]), [[30, 20, 50, true, true], [60, 50, 150, false, true], [1000, 1000, 2500, false, false]]);
  assert.deepEqual(STRUCT_TYPES.map((t) => t.key), [
    'found2', 'found4', 'belt1', 'belt2', 'belt5', 'bendL', 'bendR', 'rampUp', 'rampDown', 'splitter', 'merger', 'hopper', 'packager', 'fence'
  ]);
  assert.deepEqual([0, 1, 2, 3].map(rotYOf), [0, -Math.PI / 2, Math.PI, Math.PI / 2]);
  // rot 1 faces +x: a belt5 at the origin feeds in from −x and out at +x.
  const belt = { x: 0, z: 0, rot: 1, lvl: 0, base: 0 };
  const spec = STRUCT_TYPES[TYPE.belt5];
  assert.ok(spec);
  assert.deepEqual(worldPort(belt, spec.ins[0] ?? spec.outs[0]!), { x: -2.5, z: 0, hx: 1, hz: 0, y: 0.35 });
  assert.deepEqual(worldPort(belt, spec.outs[0]!), { x: 2.5, z: 0, hx: 1, hz: 0, y: 0.35 });
  assert.deepEqual(footprint(TYPE.belt5, 0, 0, 1), { minX: -2.5, maxX: 2.5, minZ: -0.5, maxZ: 0.5 });
  const ramp = STRUCT_TYPES[TYPE.rampUp];
  assert.equal(worldPort({ ...belt, rot: 0 }, ramp!.outs[0]!).y, 0.35 + 0.9);
  assert.ok(Math.abs((ramp?.len ?? 0) - Math.sqrt(4.81)) < 1e-12);
  assert.equal(STRUCT_TYPES[TYPE.splitter]?.outs.length, 3);
  assert.equal(STRUCT_TYPES[TYPE.merger]?.ins.length, 2);
});

test('payload guard (rule 1): lattice, ±256, type range and lvl per type are VALIDATION_ERRORs', () => {
  const parse = (fields: Record<string, unknown>): string => code(() => parsePlaceStructure({ channelId: ROOM, type: 2, x: 0, z: 0, rot: 0, lvl: 0, ...fields }));
  assert.equal(parse({}), 'ok');
  assert.equal(parse({ x: 0.25 }), 'VALIDATION_ERROR');
  assert.equal(parse({ z: 256.5 }), 'VALIDATION_ERROR');
  assert.equal(parse({ type: STRUCT_TYPES.length }), 'VALIDATION_ERROR');
  assert.equal(parse({ rot: 4 }), 'VALIDATION_ERROR');
  assert.equal(parse({ type: TYPE.rampDown, lvl: 0 }), 'VALIDATION_ERROR');
  assert.equal(parse({ type: TYPE.found4, lvl: 1 }), 'VALIDATION_ERROR');
});

test('every D.3 refusal, and the order: reach → grid/district → reserved → caps → blocked → notFlat', () => {
  const locked = world(false);
  locked.at(30, 0);
  assert.equal(locked.tryPlace(TYPE.belt5, 32.5, 0, 1), 'lockedDistrict');
  locked.at(0, 0);
  assert.equal(locked.tryPlace(TYPE.belt5, 32.5, 0, 1), 'tooFar', 'reach is checked before the district');

  const w = world();
  let edge = 200;
  while (hexAt(edge + 0.5, 0)) edge += 0.5;
  w.at(edge - 3, 0);
  assert.equal(w.tryPlace(TYPE.belt5, edge, 0, 1), 'outOfGrid');
  w.at(12, 0);
  assert.equal(w.tryPlace(TYPE.belt1, 15, 0), 'reserved', 'weighbridge pad + 1 m');
  w.at(-4, 0);
  assert.equal(w.tryPlace(TYPE.found2, -8, 0), 'reserved', 'crane area');
  w.at(14, 8);
  assert.equal(w.tryPlace(TYPE.belt1, 14, 12), 'reserved', 'hopper footprint');
  w.at(15, -10);
  assert.equal(w.tryPlace(TYPE.belt1, 15, -6.5), 'blocked', 'office container');
  w.at(0, -2);
  assert.equal(w.tryPlace(TYPE.fence, 0, -2), 'blocked', 'a player stands in a blocking type');
  w.at(0, 4);
  for (const x of [-3, 0, 3, 6]) assert.equal(w.tryPlace(TYPE.packager, x, 9), 'ok');
  assert.equal(w.tryPlace(TYPE.packager, 0, 12.5), 'buildLimit');
  assert.equal(w.tryPlace(TYPE.packager, 0, 9), 'buildLimit', 'caps come before the overlap');
  w.at(14, 8);
  assert.equal(w.tryPlace(TYPE.packager, 14, 12), 'reserved', 'reserved comes before the caps');
  w.at(0, -4);
  assert.equal(w.tryPlace(TYPE.found4, 0, -9), 'ok');
  assert.equal(w.tryPlace(TYPE.belt1, 2, -7.5, 1), 'notFlat', 'partly on a foundation');
  assert.equal(w.tryPlace(TYPE.belt1, 0, -9), 'ok', 'fully on the foundation');
  assert.equal(w.tryPlace(TYPE.belt1, 0, -9), 'blocked', 'blocked comes before notFlat');
  assert.equal(w.tryPlace(TYPE.found2, 0, -9), 'blocked', 'a foundation never overlaps');
});

test('foundation and base rules: top = ceil10(max ground + 0.2), neighbour snap, non-foundations take the top', () => {
  const w = world();
  w.at(0, -4);
  const found = w.place(TYPE.found4, 0, -9);
  const top = w.logistics.structures.get(found)?.base;
  assert.equal(top, 0.2);
  const side = w.place(TYPE.found2, 3, -10);
  assert.equal(w.logistics.structures.get(side)?.base, top);
  const belt = w.place(TYPE.belt2, 0, -9, 1);
  assert.equal(w.logistics.structures.get(belt)?.base, top);
  const onGround = w.place(TYPE.belt1, -4, -4);
  assert.equal(w.logistics.structures.get(onGround)?.base, 0);
  // structure_spawned carries the row and the builder.
  const spawned = w.events.of('structureSpawned').at(-1)?.[1] as { row: number[]; by: number };
  assert.deepEqual(spawned, { row: [onGround, TYPE.belt1, -400, -400, 0, 0, 0, 0], by: w.player.id });
});

test('delete rules: unknown, reach, supportsStructures; cargo and buffers are dropped; neighbours relink', () => {
  const w = world();
  w.at(0, -4);
  const found = w.place(TYPE.found4, 0, -9);
  const belt = w.place(TYPE.belt2, 0, -9, 1);
  const del = (id: number): string => code(() => w.service.deleteStructure('s1', ROOM, id));
  assert.equal(del(999), 'unknownStructure');
  assert.equal(del(0), 'unknownStructure', 'the landmark hopper is not a structure');
  assert.equal(del(found), 'supportsStructures');
  w.at(0, 30);
  assert.equal(del(belt), 'tooFar');
  w.at(0, -4);

  // Links: a belt1 feeding a belt1 links; deleting the second turns the first into an open end.
  const a = w.place(TYPE.belt1, -4, -3);
  const b = w.place(TYPE.belt1, -4, -4);
  w.logistics.restoreCargo({ id: 500, kind: 0, sub: 0, tint: 1, node: a, s: 0.9, route: 0, waitMs: 0, load: { dustG: 5000, seedG: 0, cans: 0, crushed: 0, ironG: 0, copperG: 0, jackpots: [] } });
  w.tick();
  assert.equal(w.logistics.cargo.get(500)?.node, b, 'the lot crossed into the linked belt');
  // Deleting a node with cargo spills the lot at the node (debris appears), and the feeder relinks to open.
  const before = w.room.debris.items.size;
  assert.equal(del(b), 'ok');
  assert.equal(w.logistics.cargo.has(500), false);
  assert.ok(w.room.debris.items.size > before || [...w.room.debris.cells].some((c) => c > 0));
  w.logistics.restoreCargo({ id: 501, kind: 0, sub: 0, tint: 1, node: a, s: 0.9, route: 0, waitMs: 0, load: { dustG: 5000, seedG: 0, cans: 0, crushed: 0, ironG: 0, copperG: 0, jackpots: [] } });
  w.ticks(2);
  assert.equal(w.logistics.cargo.has(501), false, 'the open end spilled it');
  assert.equal(del(belt), 'ok');
  assert.equal(del(found), 'ok', 'free once the belt is gone');
  const update = w.events.of('logisticsUpdate').map(([, u]) => u as { sdel?: number[] }).flatMap((u) => u.sdel ?? []);
  w.tick();
  const sdel = [...update, ...w.events.of('logisticsUpdate').map(([, u]) => u as { sdel?: number[] }).flatMap((u) => u.sdel ?? [])];
  assert.ok([b, belt, found].every((id) => sdel.includes(id)), JSON.stringify(sdel));
  assert.equal(CAPS.structures, 256);
});
