import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Collider, Heightfield, Surface } from '../../../src/modules/sweepers/city/layoutTypes.ts';
import {
  ColliderIndex, groundHeight, PLAYER_RADIUS, penetration, resolveCircle, surfaceAt, sweepCircle
} from '../../../src/modules/sweepers/geometry.ts';

const near = (actual: number, expected: number, eps = 1e-9): void => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`);

// 3 × 3 samples, 10 m apart from -10: heights in cm.
const field: Heightfield = { origin: -10, cell: 10, size: 3, heightsCm: [0, 100, 200, 0, 300, 600, 0, 0, 0] };

test('groundHeight: exact at samples, bilinear between, edge-extended outside', () => {
  near(groundHeight(field, -10, -10), 0);
  near(groundHeight(field, 0, -10), 1);
  near(groundHeight(field, 0, 0), 3);
  near(groundHeight(field, 10, 0), 6);
  // Halfway along x on the first row: (0 + 1) / 2; centre of the first cell: mean of its corners.
  near(groundHeight(field, -5, -10), 0.5);
  near(groundHeight(field, -5, -5), (0 + 1 + 0 + 3) / 4);
  // Bilinear, not nearest: a quarter into the upper-right cell.
  const tx = 0.25;
  const tz = 0.5;
  near(groundHeight(field, 2.5, -5), ((1 * (1 - tx) + 2 * tx) * (1 - tz) + (3 * (1 - tx) + 6 * tx) * tz));
  // Outside: clamped to the edge samples.
  near(groundHeight(field, 50, 0), 6);
  near(groundHeight(field, -50, -50), 0);
  near(groundHeight(field, 10, 10), 0);
});

const box = (x: number, z: number, w: number, d: number, rotY = 0, h = 2): Collider => ({ shape: 'box', x, z, w, d, h, rotY });
const cyl = (x: number, z: number, r: number, h = 2): Collider => ({ shape: 'cyl', x, z, r, h });

test('penetration: box faces, corners and rotation; cylinders; apart is null', () => {
  // A 2 × 2 box at the origin; the circle touches its +x face from 1.2 m.
  const pen = penetration(box(0, 0, 2, 2), 1.2, 0, PLAYER_RADIUS);
  assert.ok(pen);
  near(pen.nx, 1);
  near(pen.nz, 0);
  near(pen.depth, 0.15);
  assert.equal(penetration(box(0, 0, 2, 2), 1.4, 0, PLAYER_RADIUS), null);
  // Corner: pushed out diagonally.
  const corner = penetration(box(0, 0, 2, 2), 1.2, 1.2, PLAYER_RADIUS);
  assert.ok(corner);
  near(corner.nx, Math.SQRT1_2);
  near(corner.depth, PLAYER_RADIUS - Math.hypot(0.2, 0.2));
  // Centre inside: out through the nearest face.
  const inside = penetration(box(0, 0, 4, 2), 0.5, 0.8, PLAYER_RADIUS);
  assert.ok(inside);
  near(inside.nz, 1);
  near(inside.depth, 0.2 + PLAYER_RADIUS);
  // Rotated by 90°: local x (width 4) runs along world −z, so the box is 2 wide in x, 4 deep in z.
  const rotated = box(0, 0, 4, 2, Math.PI / 2);
  assert.equal(penetration(rotated, 1.5, 0, PLAYER_RADIUS), null);
  const alongZ = penetration(rotated, 0, 2.2, PLAYER_RADIUS);
  assert.ok(alongZ);
  near(alongZ.nz, 1, 1e-9);
  near(alongZ.depth, 0.15);
  // Cylinder.
  const c = penetration(cyl(5, 5, 1), 5, 6.2, PLAYER_RADIUS);
  assert.ok(c);
  near(c.nz, 1);
  near(c.depth, 0.15);
  assert.equal(penetration(cyl(5, 5, 1), 5, 6.4, PLAYER_RADIUS), null);
});

test('resolveCircle: pushed clear of blocking colliders, step-over ones (h <= 0.35) ignored', () => {
  const walls = [box(0, 0, 2, 2), cyl(0, 3, 0.5)];
  const out = resolveCircle(walls, 1.1, 0);
  assert.ok(out.hit);
  near(out.x, 1 + PLAYER_RADIUS);
  near(out.z, 0);
  const free = resolveCircle(walls, 3, 3);
  assert.deepEqual(free, { x: 3, z: 3, hit: false });
  const curb = box(0, 0, 10, 0.25, 0, 0.15);
  assert.deepEqual(resolveCircle([curb], 0, 0), { x: 0, z: 0, hit: false });
  // Wedged between a box and a cylinder: every collider is cleared.
  const wedged = resolveCircle(walls, 0.2, 1.6);
  for (const wall of walls) assert.equal(penetration(wall, wedged.x, wedged.z, PLAYER_RADIUS - 1e-6), null);
});

test('sweepCircle: clear paths pass unchanged, thin walls are never tunnelled, grazing is tolerated', () => {
  // A 0.2 m thick wall across x = 5, from z = -5 to 5.
  const index = new ColliderIndex([box(5, 0, 0.2, 10), box(5, 20, 0.2, 2, 0, 0.15)]);
  assert.deepEqual(sweepCircle(index, 0, 8, 10, 8), { x: 10, z: 8, hit: false });
  // 4 m in one input straight through the wall: stopped on the near side.
  const through = sweepCircle(index, 3, 0, 7, 0);
  assert.ok(through.hit);
  near(through.x, 5 - 0.1 - PLAYER_RADIUS, 1e-6);
  // Diagonal into the wall: slides along it.
  const slide = sweepCircle(index, 3, 0, 6, 2);
  assert.ok(slide.hit);
  assert.ok(slide.x <= 5 - 0.1 - PLAYER_RADIUS + 1e-6 && slide.z > 1.5, `slid to ${slide.x}, ${slide.z}`);
  // Walking along the wall face at exactly the player radius (client-side resolution) is not a hit.
  const face = 5 - 0.1 - PLAYER_RADIUS + 0.01;
  assert.deepEqual(sweepCircle(index, face, -3, face, 3), { x: face, z: 3, hit: false });
  // A step-over collider is not indexed at all.
  assert.deepEqual(sweepCircle(index, 3, 20, 7, 20), { x: 7, z: 20, hit: false });
  assert.equal(index.near(5, 20, 1).length, 0);
});

test('sweepCircle queries colliders within length + radius of the midpoint (review LOW-2)', () => {
  // A pure slide ends on the circle of radius length/2 around the midpoint (Thales), so no simple
  // behavioural case separates the radii; the query itself is pinned so a revert fails here.
  class RecordingIndex extends ColliderIndex {
    readonly radii: number[] = [];
    override near(x: number, z: number, radius: number): Collider[] {
      this.radii.push(radius);
      return super.near(x, z, radius);
    }
  }
  const index = new RecordingIndex([box(5, 0, 0.2, 10)]);
  sweepCircle(index, 3, 0, 6, 4);
  assert.deepEqual(index.radii, [5 + PLAYER_RADIUS]);
});

test('surfaceAt: dry outside every circle; the most severe overlapping surface wins', () => {
  const surfaces: Surface[] = [
    { kind: 'wet', shape: 'circle', x: 0, z: 0, r: 5 },
    { kind: 'mud', shape: 'circle', x: 2, z: 0, r: 2 },
    { kind: 'acid', shape: 'circle', x: 3, z: 0, r: 0.5 },
    { kind: 'grease', shape: 'circle', x: -10, z: 0, r: 1 }
  ];
  assert.equal(surfaceAt(surfaces, 0, 4), 'wet');
  assert.equal(surfaceAt(surfaces, 1, 0), 'mud');
  assert.equal(surfaceAt(surfaces, 3, 0.2), 'acid');
  assert.equal(surfaceAt(surfaces, -10.5, 0), 'grease');
  assert.equal(surfaceAt(surfaces, 0, 5.01), 'dry');
  assert.equal(surfaceAt([], 0, 0), 'dry');
});
