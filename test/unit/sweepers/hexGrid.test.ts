import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  axialDistance, axialToWorld, districtOf, GRID_RADIUS, HEX_CELLS, HEX_OUTER_RADIUS, hexAt, initialCleanliness, worldToAxial
} from '../../../src/modules/sweepers/hexGrid.ts';

const INNER_RADIUS = (HEX_OUTER_RADIUS * Math.sqrt(3)) / 2;

test('37 cells, ids in spiral order: centre 0, ring 1 = 1..6, ring 2 = 7..18, ring 3 = 19..36', () => {
  assert.equal(HEX_CELLS.length, 37);
  HEX_CELLS.forEach((cell, index) => assert.equal(cell.id, index));
  assert.deepEqual({ q: HEX_CELLS[0]?.q, r: HEX_CELLS[0]?.r }, { q: 0, r: 0 });
  const ringOf = HEX_CELLS.map((c) => axialDistance(c));
  assert.deepEqual(ringOf.slice(1, 7), Array(6).fill(1));
  assert.deepEqual(ringOf.slice(7, 19), Array(12).fill(2));
  assert.deepEqual(ringOf.slice(19), Array(18).fill(3));
  assert.equal(new Set(HEX_CELLS.map((c) => `${c.q},${c.r}`)).size, 37);
  assert.ok(HEX_CELLS.every((c) => axialDistance(c) <= GRID_RADIUS));
});

test('axialToWorld: pointy-top layout, neighbours 2 × inner radius apart', () => {
  assert.deepEqual(axialToWorld({ q: 0, r: 0 }), { x: 0, z: 0 });
  const east = axialToWorld({ q: 1, r: 0 });
  assert.ok(Math.abs(east.x - 2 * INNER_RADIUS) < 1e-9 && east.z === 0);
  const south = axialToWorld({ q: 0, r: 1 });
  assert.ok(Math.abs(south.x - INNER_RADIUS) < 1e-9 && Math.abs(south.z - 60) < 1e-9);
});

test('worldToAxial / hexAt invert axialToWorld, also off-centre inside the hex', () => {
  for (const cell of HEX_CELLS) {
    const { x, z } = axialToWorld(cell);
    assert.deepEqual(worldToAxial(x, z), { q: cell.q, r: cell.r });
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      assert.equal(hexAt(x + Math.cos(a) * (INNER_RADIUS - 0.5), z + Math.sin(a) * (INNER_RADIUS - 0.5))?.id, cell.id);
    }
  }
  assert.equal(hexAt(0, 0)?.id, 0);
  assert.equal(hexAt(1000, 0), null);
  assert.equal(hexAt(0, 4 * 60), null);
});

test('districts: centre is 0, ring hexes split into five 72° sectors (1..5), all populated', () => {
  assert.equal(districtOf({ q: 0, r: 0 }), 0);
  assert.equal(HEX_CELLS.filter((c) => c.district === 0).length, 1);
  const counts = [0, 0, 0, 0, 0, 0];
  for (const cell of HEX_CELLS) {
    counts[cell.district] = (counts[cell.district] ?? 0) + 1;
    if (cell.district === 0) continue;
    const { x, z } = axialToWorld(cell);
    const degrees = ((Math.atan2(z, x) * 180) / Math.PI + 360) % 360;
    assert.equal(cell.district, 1 + Math.floor((degrees + 1e-6) / 72), `hex ${cell.id} at ${degrees}°`);
  }
  assert.equal(counts.reduce((a, b) => a + b, 0), 37);
  assert.ok(counts.slice(1).every((n) => n >= 6), JSON.stringify(counts));
  // East (0°) starts district 1.
  assert.equal(districtOf({ q: 1, r: 0 }), 1);
});

test('initial cleanliness: centre 35, others 10..25, deterministic', () => {
  for (const cell of HEX_CELLS) {
    const value = initialCleanliness(cell);
    assert.equal(value, initialCleanliness(cell));
    assert.ok(Number.isInteger(value));
    if (cell.district === 0) assert.equal(value, 35);
    else assert.ok(value >= 10 && value <= 25, `hex ${cell.id}: ${value}`);
  }
  assert.ok(new Set(HEX_CELLS.slice(1).map(initialCleanliness)).size > 3, 'values vary per hex');
});
