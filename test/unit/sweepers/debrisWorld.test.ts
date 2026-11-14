// Phase C debris model: regions, cleanliness, generation, respawn, ids, deltas, persistence, caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  c10Of, DebrisWorld, DELTA_MAX_BYTES, FULL_LOAD_THRESHOLD, MAX_ITEMS_PER_HEX, MAX_ITEMS_PER_ROOM, RESPAWN_INTERVAL_MS
} from '../../../src/modules/sweepers/debris/DebrisWorld.ts';
import { CELLS_PER_CHUNK, debrisGrid } from '../../../src/modules/sweepers/debris/grid.ts';
import {
  arcRegion, coneRegion, inRegion, reducedLevel, regionArea, sectorRegion, sweepFraction
} from '../../../src/modules/sweepers/debris/regions.ts';
import { DEBRIS_GEN, KIND } from '../../../src/modules/sweepers/debris/tables.ts';
import { axialToWorld, HEX_CELLS, initialCleanliness } from '../../../src/modules/sweepers/hexGrid.ts';
import { cellAt, emptyWorld, paint, put } from './debrisSupport.ts';

const DEG = Math.PI / 180;
// dir(rotY) = (−sin, −cos): rotY 0 faces −z.
const at = (reach: number, deg: number): [number, number] => [-Math.sin(deg * DEG) * reach, -Math.cos(deg * DEG) * reach];

test('regions: arc / cone / hand membership and areas', () => {
  const arc = arcRegion(0, 0, 0, 1.2, 0.6);
  assert.ok(inRegion(arc, ...at(1.2, 0)));
  assert.ok(inRegion(arc, ...at(1.45, 0)), 'within w/2 outside the reach');
  assert.ok(!inRegion(arc, ...at(1.55, 0)));
  assert.ok(!inRegion(arc, ...at(0.85, 0)));
  assert.ok(inRegion(arc, ...at(1.2, 39)));
  assert.ok(!inRegion(arc, ...at(1.2, 41)));
  assert.ok(!inRegion(arc, ...at(1.2, 180)), 'behind');
  assert.ok(Math.abs(regionArea(arc) - 1.396 * 1.2 * 0.6) < 1e-12);
  const cone = coneRegion(0, 0, Math.PI / 2, 3.5);
  assert.ok(!inRegion(cone, ...at(0.2, 90)), 'closer than 0.3 m');
  assert.ok(inRegion(cone, ...at(3.5, 90)));
  assert.ok(inRegion(cone, ...at(2, 104)));
  assert.ok(!inRegion(cone, ...at(2, 106)));
  assert.ok(!inRegion(cone, ...at(3.6, 90)));
  assert.ok(Math.abs(regionArea(cone) - 0.2618 * (3.5 * 3.5 - 0.09)) < 1e-12);
  const hand = sectorRegion(0, 0, 0, 2);
  assert.ok(inRegion(hand, ...at(0.1, 0)) && inRegion(hand, ...at(2, -39)) && !inRegion(hand, ...at(2.1, 0)));
});

test('f / eff: L\' = floor(L·(1 − f·eff)) against hand-computed values', () => {
  // Tool 2 (0.85 m²/s, 0.5 s) on a dry cell: f = 0.425 · 1.15 / (1.396 · 1.2 · 0.9).
  const area = 1.396 * 1.2 * 0.9;
  const f = sweepFraction(0.85, 0.5, 1.15, area);
  assert.ok(Math.abs(f - 0.32417) < 1e-5);
  assert.equal(reducedLevel(15, f, 1), 10);
  assert.equal(reducedLevel(15, f, 0.5), 12, 'heavy slag');
  assert.equal(sweepFraction(10, 1, 1, 1), 1, 'f is capped at 1');
  assert.equal(reducedLevel(15, 1, 1), 0);
  assert.equal(reducedLevel(10, 0.3, 1), 7, 'an exact product never floors one level too far');
  assert.equal(reducedLevel(1, 0.4, 1), 0);
});

test('c10 derivation: floor(1000·(1 − M/Mref)) clamped; M = 0 is 100 %', () => {
  assert.equal(c10Of(0, 500), 1000);
  assert.equal(c10Of(250, 500), 500);
  assert.equal(c10Of(1.0001, 1000), 998);
  assert.equal(c10Of(600, 500), 0);
  const world = emptyWorld();
  assert.equal(world.c10(0), 1000);
  const mref = world.mrefOf(0);
  // Cells: dust level 15 everywhere in a 3 m disc; items count with max(mass, 1 kg); jackpots and buried copper not at all.
  paint(world, 3, 3, 3, 0xf0);
  put(world, KIND.can, 4, 4, 5);
  put(world, KIND.iron, 4.5, 4, 1000);
  put(world, KIND.copper, 5, 4, 300, 2);
  put(world, KIND.cauldron, 5.5, 4, 4500);
  const cells = world.massOf(0) - 1 - 10;
  assert.ok(cells > 0);
  assert.equal(world.c10(0), Math.floor(1000 * (1 - world.massOf(0) / mref)));
  assert.ok(Math.abs(world.massOf(0) - (cells + 11)) < 1e-9);
});

test('generation: φ = (100 − C₀)/100 reproduces C₀ within ±2, deterministically, in bounded time', () => {
  for (const c0 of [HEX_CELLS.map(initialCleanliness), HEX_CELLS.map(() => 0), HEX_CELLS.map(() => 50), HEX_CELLS.map(() => 75)]) {
    const started = performance.now();
    const world = DebrisWorld.generate('gen-room', c0, 1);
    assert.ok(performance.now() - started < 1_000, 'generation stays fast (target < 50 ms)');
    for (const cell of HEX_CELLS) {
      const c = world.c10(cell.id) / 10;
      assert.ok(Math.abs(c - (c0[cell.id] ?? 0)) <= 2, `hex ${cell.id}: ${c} vs ${c0[cell.id]}`);
    }
    assert.ok(world.itemCount <= MAX_ITEMS_PER_ROOM);
  }
  const a = DebrisWorld.generate('same', HEX_CELLS.map(initialCleanliness), 1).record();
  const b = DebrisWorld.generate('same', HEX_CELLS.map(initialCleanliness), 99).record();
  assert.deepEqual(a, b, 'generation depends on the room id only');
  assert.notDeepEqual(DebrisWorld.generate('other', HEX_CELLS.map(initialCleanliness), 1).record().cells, a.cells);
});

test('memory: one byte per live cell (≈ 640 kB per room), dead cells are 0', () => {
  const grid = debrisGrid();
  const world = DebrisWorld.generate('mem', HEX_CELLS.map(() => 0), 1);
  assert.equal(world.cells.length, grid.liveChunks.length * CELLS_PER_CHUNK);
  assert.ok(world.cells.length <= 800_000, `${world.cells.length} B`);
  assert.ok(grid.liveChunks.length > 2_000 && grid.liveChunks.length < 4_096);
  for (let i = 0; i < world.cells.length; i++) if ((grid.cellHex[i] ?? -1) < 0) assert.equal(world.cells[i], 0);
});

test('respawn: +3..7 % of Mref per hex, capped at Mref, M = 0 locked, one hex per tick, no catch-up', () => {
  const world = DebrisWorld.generate('respawn', HEX_CELLS.map(() => 50), 7);
  for (const cell of HEX_CELLS.slice(0, 12)) {
    const before = world.massOf(cell.id);
    world.respawnHex(cell.id);
    const share = (world.massOf(cell.id) - before) / world.mrefOf(cell.id);
    assert.ok(share >= 0.03 - 0.002 && share <= 0.07 + 0.002, `hex ${cell.id}: ${share}`);
  }
  const full = DebrisWorld.generate('respawn-full', HEX_CELLS.map(() => 1), 7);
  for (const cell of HEX_CELLS.slice(0, 6)) {
    full.respawnHex(cell.id);
    assert.ok(full.massOf(cell.id) <= full.mrefOf(cell.id) * 1.002, 'capped at Mref');
  }
  const empty = emptyWorld();
  empty.respawnHex(0);
  assert.equal(empty.massOf(0), 0, 'a clean hex stays clean');
  // Timer: an hour in one step still queues one cycle; then one hex per tick.
  const timed = DebrisWorld.generate('respawn-timer', HEX_CELLS.map(() => 50), 3);
  const masses = HEX_CELLS.map((c) => timed.massOf(c.id));
  timed.tickRespawn(3_600_000);
  assert.equal(timed.respawnInMs, RESPAWN_INTERVAL_MS);
  const changed = (): number => HEX_CELLS.filter((c) => timed.massOf(c.id) !== masses[c.id]).length;
  assert.equal(changed(), 1);
  for (let i = 1; i < HEX_CELLS.length; i++) timed.tickRespawn(83);
  assert.equal(changed(), HEX_CELLS.length);
  const settled = HEX_CELLS.map((c) => timed.massOf(c.id));
  for (let i = 0; i < 50; i++) timed.tickRespawn(83);
  assert.deepEqual(HEX_CELLS.map((c) => timed.massOf(c.id)), settled, 'nothing more until the next interval');
});

test('item ids: hexId << 16 | index, per-hex counter, lowest free index after 0xFFFF', () => {
  const world = emptyWorld();
  const centre = axialToWorld(HEX_CELLS[5] ?? { q: 0, r: 0 });
  const first = put(world, KIND.can, centre.x + 2, centre.z, 5);
  const second = put(world, KIND.can, centre.x + 3, centre.z, 5);
  assert.equal(first.id >>> 16, 5);
  assert.equal((second.id & 0xffff) - (first.id & 0xffff), 1);
  world.remove(first.id);
  world.setNextIndex(5, 0xffff);
  assert.equal(put(world, KIND.can, centre.x + 4, centre.z, 5).id, (5 << 16) | 0xffff);
  assert.equal(put(world, KIND.can, centre.x + 5, centre.z, 5).id, first.id, 'reuses the lowest free index');
  // A moved item keeps its id.
  world.update(second, { x: 0, z: 3 });
  assert.equal(world.items.get(second.id)?.hex, 0);
});

test('caps: 250 spawned items per hex and 6 000 per room; player mass (place) is never skipped', () => {
  const world = emptyWorld();
  const centre = axialToWorld(HEX_CELLS[7] ?? { q: 0, r: 0 });
  let spawned = 0;
  for (let i = 0; i < 300; i++) if (world.spawn(KIND.can, centre.x + (i % 20) * 0.5 - 5, centre.z + Math.floor(i / 20) * 0.5 - 4, 5, 0, 0)) spawned++;
  assert.equal(spawned, MAX_ITEMS_PER_HEX);
  assert.ok(world.place(KIND.can, centre.x, centre.z + 5, 5, 0, 0), 'a dump goes over the cap');
  let total = world.itemCount;
  for (const cell of HEX_CELLS) {
    const c = axialToWorld(cell);
    for (let i = 0; i < 260 && total < MAX_ITEMS_PER_ROOM + 10; i++) {
      if (world.spawn(KIND.can, c.x + (i % 20) * 0.5 - 5, c.z + Math.floor(i / 20) * 0.5 - 7, 5, 0, 0)) total = world.itemCount;
    }
  }
  assert.ok(world.itemCount <= MAX_ITEMS_PER_ROOM + 1, `${world.itemCount}`);
  assert.equal(world.spawn(KIND.can, 3, 3, 5, 0, 0), null);
});

test('deltas: > 32 changed cells of a chunk go out as a full load; the 8 kB cap carries the rest over FIFO', () => {
  const world = emptyWorld();
  const many = paint(world, 3.75, 3.75, 2.2, 0x11);
  assert.ok(many > FULL_LOAD_THRESHOLD);
  const few = paint(world, -100, 60, 1, 0x22);
  assert.ok(few > 0 && few <= FULL_LOAD_THRESHOLD);
  const first = world.takeDeltas();
  assert.ok(first.reload.length >= 1);
  const reloaded = new Set(first.reload);
  for (let i = 0; i < first.cells.length; i += 3) assert.ok(!reloaded.has(first.cells[i] ?? -1), 'no triplets for a reloaded chunk');
  assert.equal(first.cells.length, few * 3);
  // Thousands of small changes spread over many chunks (≤ 32 each): capped, then carried over.
  const spread = emptyWorld();
  let changed = 0;
  for (let x = -150; x < 150 && changed < 3000; x += 8) {
    for (let z = -150; z < 150 && changed < 3000; z += 8) {
      const index = cellAt(spread, x + 0.25, z + 0.25);
      if (index < 0 || (spread.grid.cellHex[index] ?? -1) < 0) continue;
      spread.setCell(index, 0x33);
      changed++;
    }
  }
  const batches: number[][] = [];
  for (let i = 0; i < 20; i++) {
    const d = spread.takeDeltas();
    const size = JSON.stringify({ t: 1_750_000_000_000, cells: d.cells, add: d.add, del: d.del, kicks: d.kicks, hx: d.hx }).length;
    assert.ok(size <= DELTA_MAX_BYTES, `${size} B`);
    if (d.cells.length === 0) break;
    batches.push(d.cells);
  }
  assert.ok(batches.length > 1, 'needed several ticks');
  assert.equal(batches.reduce((s, b) => s + b.length, 0), changed * 3, 'nothing lost');
});

test('persistence: v3 record round-trips; corrupt or foreign records are refused (regenerate)', () => {
  const world = DebrisWorld.generate('persist', HEX_CELLS.map(initialCleanliness), 1);
  put(world, KIND.pile, 3, 3, 1200, 0, 300);
  const record = JSON.parse(JSON.stringify(world.record())) as Record<string, unknown>;
  const restored = DebrisWorld.restore(record, 2);
  assert.ok(restored);
  assert.deepEqual(restored.record(), world.record());
  for (const cell of HEX_CELLS) assert.equal(restored.c10(cell.id), world.c10(cell.id));
  const pile = [...restored.items.values()].find((i) => i.kind === KIND.pile);
  assert.deepEqual([pile?.massDg, pile?.seedDg], [1200, 300]);
  // Re-encoding only when something changed.
  assert.equal(restored.record().items, restored.record().items, 'same encoded rows, not re-encoded');
  restored.setCell(cellAt(restored, 3.25, 3.25), 0x55);
  assert.notEqual(restored.record().cells, world.record().cells, 're-encoded after a change');
  assert.equal(DebrisWorld.restore({ ...record, gen: DEBRIS_GEN + 1 }, 1), null);
  assert.equal(DebrisWorld.restore({ ...record, cells: 'not deflate data!!' }, 1), null);
  assert.equal(DebrisWorld.restore({ ...record, cells: Buffer.from('short').toString('base64') }, 1), null);
  assert.equal(DebrisWorld.restore({ ...record, items: [[1, 99, 0, 0, 0, 5]] }, 1), null);
  assert.equal(DebrisWorld.restore({ ...record, next: [1, 2] }, 1), null);
  assert.equal(DebrisWorld.restore('nope', 1), null);
  assert.equal(DebrisWorld.restore(null, 1), null);
});
