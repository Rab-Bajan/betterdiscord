import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABOVE_GROUND_LIMIT, fullBudget, MAX_BUDGET_SECONDS, MAX_SPEED, MAX_VERTICAL_SPEED, normaliseAngle, SPEED_TOLERANCE, validateMove, VERTICAL_BANK
} from '../../../src/modules/sweepers/motion.ts';
import type { MotionBudget, MoveWorld } from '../../../src/modules/sweepers/motion.ts';
import type { Pose } from '../../../src/modules/sweepers/types.ts';
import { OPEN_WORLD } from './support.ts';

const pose = (x: number, z: number, extra: Partial<Pose> = {}): Pose => ({ x, y: 0, z, rotY: 0, state: 'WALK', ...extra });
const TOLERATED = MAX_SPEED * SPEED_TOLERANCE;
const spent = (at: number): MotionBudget => ({ metres: 0, vertical: 0, at });

test('a move within the tolerated speed is accepted as sent', () => {
  // Budget spent: only the elapsed time counts.
  const result = validateMove(pose(0, 0), pose(TOLERATED * 0.1 - 0.01, 0, { rotY: 1, state: 'SPRINT' }), spent(1000), 1100, OPEN_WORLD);
  assert.equal(result.corrected, false);
  assert.deepEqual(result.pose, pose(TOLERATED * 0.1 - 0.01, 0, { rotY: 1, state: 'SPRINT' }));
  assert.ok(result.budget.metres < 0.02 && result.budget.at === 1100);
});

test('a too fast move is rejected: position stays, rotation and state are taken, corrected', () => {
  const result = validateMove(pose(5, 5), pose(5 + TOLERATED * 0.1 + 0.5, 5, { rotY: 2, state: 'IDLE' }), spent(0), 100, OPEN_WORLD);
  assert.equal(result.corrected, true);
  assert.deepEqual(result.pose, pose(5, 5, { rotY: 2, state: 'IDLE' }));
});

test('budget: bursts spend banked travel, a long pause never banks more than the cap', () => {
  const cap = TOLERATED * MAX_BUDGET_SECONDS;
  assert.equal(fullBudget(0).metres, cap);
  assert.equal(fullBudget(0).vertical, VERTICAL_BANK);
  const afterPause = validateMove(pose(0, 0), pose(cap + 0.1, 0), spent(0), 60_000, OPEN_WORLD);
  assert.equal(afterPause.corrected, true);
  // Two inputs arriving together (0 ms apart) after 100 ms of silence: together within budget.
  const first = validateMove(pose(0, 0), pose(0.4, 0), spent(0), 100, OPEN_WORLD);
  const second = validateMove(first.pose, pose(0.8, 0), first.budget, 100, OPEN_WORLD);
  assert.equal(first.corrected, false);
  assert.equal(second.corrected, false);
  const third = validateMove(second.pose, pose(1.2, 0), second.budget, 100, OPEN_WORLD);
  assert.equal(third.corrected, true);
});

test('world bounds: x/z clamped to ±300; clamping corrects', () => {
  const near = validateMove(pose(299.5, -299.5), { x: 300.5, y: 0, z: -300.5, rotY: 0, state: 'WALK' }, fullBudget(0), 0, OPEN_WORLD);
  assert.deepEqual(near.pose, { x: 300, y: 0, z: -300, rotY: 0, state: 'WALK' });
  assert.equal(near.corrected, true);
});

test('y band: feet stay within [ground - 0.05, ground + 1.2]', () => {
  const hill: MoveWorld = { ...OPEN_WORLD, ground: (x) => x };
  // Standing 3 m up the slope (ground 3): a jump to 1 m above ground is fine.
  const start = pose(3, 0, { y: 3 });
  const jump = validateMove(start, pose(3, 0, { y: 4 }), fullBudget(0), 200, hill);
  assert.equal(jump.corrected, false);
  assert.equal(jump.pose.y, 4);
  // Floating 2 m up is pulled down to the band top, sinking below the ground is pushed up.
  const fly = validateMove(start, pose(3, 0, { y: 5 }), fullBudget(0), 1000, hill);
  assert.equal(fly.corrected, true);
  assert.equal(fly.pose.y, 3 + ABOVE_GROUND_LIMIT);
  const sink = validateMove(start, pose(3, 0, { y: 2.5 }), fullBudget(0), 1000, hill);
  assert.equal(sink.corrected, true);
  assert.equal(sink.pose.y, 3 - 0.05);
  // The legacy absolute clamp to [0, 50] still applies on top.
  const below = validateMove(pose(0, 0), { x: 0, y: -3, z: 0, rotY: 0, state: 'WALK' }, fullBudget(0), 0, OPEN_WORLD);
  assert.equal(below.pose.y, 0);
  assert.equal(below.corrected, true);
});

test('vertical budget: |Δy| <= 6 m/s × dt + 1 m banked (review LOW-2)', () => {
  // A fresh budget: 1 m banked + 6 m/s × 0.02 s; a hop straight to the band top (1.2 m) is cut.
  const hop = validateMove(pose(0, 0), pose(0, 0, { y: 1.2 }), fullBudget(0), 20, OPEN_WORLD);
  assert.equal(hop.corrected, true);
  assert.ok(Math.abs(hop.pose.y - (VERTICAL_BANK + MAX_VERTICAL_SPEED * 0.02)) < 1e-9, `y ${hop.pose.y}`);
  assert.equal(hop.budget.vertical, 0);
  // Bank spent: only the elapsed time counts (0.05 s → 0.3 m), in both directions.
  const up = validateMove(pose(0, 0), pose(0, 0, { y: 1.2 }), spent(0), 50, OPEN_WORLD);
  assert.ok(Math.abs(up.pose.y - 0.3) < 1e-9 && up.corrected);
  const down = validateMove(pose(0, 0, { y: 1.2 }), pose(0, 0), spent(0), 50, OPEN_WORLD);
  assert.ok(Math.abs(down.pose.y - 0.9) < 1e-9 && down.corrected);
  // The bank refills up to 1 m and never beyond.
  assert.equal(validateMove(pose(0, 0), pose(0, 0), spent(0), 60_000, OPEN_WORLD).budget.vertical, VERTICAL_BANK);
  // A real jump (0.82 m apex, ~4 m/s take-off) sampled at 20 Hz is never cut.
  let current = pose(0, 0);
  let budget = fullBudget(0);
  for (let i = 1; i <= 16; i++) {
    const t = i * 0.05;
    const y = Math.max(0, 4.01 * t - 4.9 * t * t);
    const result = validateMove(current, pose(0, 0, { y }), budget, i * 50, OPEN_WORLD);
    assert.equal(result.corrected, false, `jump sample ${i}`);
    current = result.pose;
    budget = result.budget;
  }
  // Climbing a 40 % slope at sprint speed stays inside the budget too.
  const slope: MoveWorld = { ...OPEN_WORLD, ground: (x) => x * 0.4 };
  current = pose(0, 0);
  budget = fullBudget(0);
  for (let i = 1; i <= 20; i++) {
    const x = i * MAX_SPEED * 0.05;
    const result = validateMove(current, pose(x, 0, { y: x * 0.4 }), budget, i * 50, slope);
    assert.equal(result.corrected, false, `step ${i}`);
    current = result.pose;
    budget = result.budget;
  }
});

test('locked district: the position is refused and the player stays', () => {
  const fenced: MoveWorld = { ...OPEN_WORLD, isOpen: (x) => x < 10 };
  const result = validateMove(pose(9, 0), pose(10.5, 0, { rotY: 1 }), fullBudget(0), 100, fenced);
  assert.equal(result.corrected, true);
  assert.deepEqual(result.pose, pose(9, 0, { rotY: 1 }));
  assert.equal(validateMove(pose(8, 0), pose(9.5, 0), fullBudget(0), 100, fenced).corrected, false);
});

test('locked district: a move between two open points that clips a locked corner is refused', () => {
  // A small locked patch around (2, 0.8), the path's middle: start and end are both open.
  const corner: MoveWorld = { ...OPEN_WORLD, isOpen: (x, z) => !(x > 1.6 && x < 2.4 && z > 0.6 && z < 1) };
  assert.equal(corner.isOpen(0, 0) && corner.isOpen(4, 1.6), true);
  const result = validateMove(pose(0, 0), pose(4, 1.6), fullBudget(0), 500, corner);
  assert.equal(result.corrected, true);
  assert.deepEqual(result.pose, pose(0, 0));
  // The same move with nothing locked on its path is accepted.
  assert.equal(validateMove(pose(0, 0), pose(4, -1.6), fullBudget(0), 500, corner).corrected, false);
});

test('colliders: a swept hit takes the slid position and corrects; a push into a locked district is refused', () => {
  const wall: MoveWorld = { ...OPEN_WORLD, sweep: (_fx, _fz, _tx, tz) => ({ x: 4.65, z: tz, hit: true }) };
  const result = validateMove(pose(4, 0), pose(5.5, 0.5), fullBudget(0), 100, wall);
  assert.equal(result.corrected, true);
  assert.deepEqual([result.pose.x, result.pose.z], [4.65, 0.5]);
  const lockedBehind: MoveWorld = { ...wall, isOpen: (x) => x !== 4.65 };
  assert.deepEqual(validateMove(pose(4, 0), pose(5.5, 0.5), fullBudget(0), 100, lockedBehind).pose, pose(4, 0));
});

test('rotation is normalised to [0, 2π)', () => {
  assert.equal(normaliseAngle(0), 0);
  assert.ok(Math.abs(normaliseAngle(-Math.PI / 2) - 1.5 * Math.PI) < 1e-12);
  assert.ok(Math.abs(normaliseAngle(5 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(normaliseAngle(2 * Math.PI) < 1e-12);
});
