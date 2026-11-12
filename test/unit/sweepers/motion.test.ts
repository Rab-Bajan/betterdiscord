import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullBudget, MAX_BUDGET_SECONDS, MAX_SPEED, normaliseAngle, SPEED_TOLERANCE, validateMove } from '../../../src/modules/sweepers/motion.ts';
import type { Pose } from '../../../src/modules/sweepers/types.ts';

const pose = (x: number, z: number, extra: Partial<Pose> = {}): Pose => ({ x, y: 0, z, rotY: 0, state: 'WALK', ...extra });
const TOLERATED = MAX_SPEED * SPEED_TOLERANCE;

test('a move within the tolerated speed is accepted as sent', () => {
  // Budget spent: only the elapsed time counts.
  const budget = { metres: 0, at: 1000 };
  const result = validateMove(pose(0, 0), pose(TOLERATED * 0.1 - 0.01, 0, { rotY: 1, state: 'SPRINT' }), budget, 1100);
  assert.equal(result.corrected, false);
  assert.deepEqual(result.pose, pose(TOLERATED * 0.1 - 0.01, 0, { rotY: 1, state: 'SPRINT' }));
  assert.ok(result.budget.metres < 0.02 && result.budget.at === 1100);
});

test('a too fast move is rejected: position stays, rotation and state are taken, corrected', () => {
  const result = validateMove(pose(5, 5), pose(5 + TOLERATED * 0.1 + 0.5, 5, { rotY: 2, state: 'IDLE' }), { metres: 0, at: 0 }, 100);
  assert.equal(result.corrected, true);
  assert.deepEqual(result.pose, pose(5, 5, { rotY: 2, state: 'IDLE' }));
});

test('budget: bursts spend banked travel, a long pause never banks more than the cap', () => {
  const cap = TOLERATED * MAX_BUDGET_SECONDS;
  assert.equal(fullBudget(0).metres, cap);
  const afterPause = validateMove(pose(0, 0), pose(cap + 0.1, 0), { metres: 0, at: 0 }, 60_000);
  assert.equal(afterPause.corrected, true);
  // Two inputs arriving together (0 ms apart) after 100 ms of silence: together within budget.
  const first = validateMove(pose(0, 0), pose(0.4, 0), { metres: 0, at: 0 }, 100);
  const second = validateMove(first.pose, pose(0.8, 0), first.budget, 100);
  assert.equal(first.corrected, false);
  assert.equal(second.corrected, false);
  const third = validateMove(second.pose, pose(1.2, 0), second.budget, 100);
  assert.equal(third.corrected, true);
});

test('world bounds: x/z clamped to ±300, y to [0, 50]; clamping corrects', () => {
  const near = validateMove(pose(299.5, -299.5), { x: 300.5, y: 60, z: -300.5, rotY: 0, state: 'WALK' }, fullBudget(0), 0);
  assert.deepEqual(near.pose, { x: 300, y: 50, z: -300, rotY: 0, state: 'WALK' });
  assert.equal(near.corrected, true);
  const below = validateMove(pose(0, 0), { x: 0, y: -3, z: 0, rotY: 0, state: 'WALK' }, fullBudget(0), 0);
  assert.equal(below.pose.y, 0);
  assert.equal(below.corrected, true);
});

test('rotation is normalised to [0, 2π)', () => {
  assert.equal(normaliseAngle(0), 0);
  assert.ok(Math.abs(normaliseAngle(-Math.PI / 2) - 1.5 * Math.PI) < 1e-12);
  assert.ok(Math.abs(normaliseAngle(5 * Math.PI) - Math.PI) < 1e-12);
  assert.ok(normaliseAngle(2 * Math.PI) < 1e-12);
});
