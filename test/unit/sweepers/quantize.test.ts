import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePose, fromRot16, stateIndex, toCm, toRot16 } from '../../../src/modules/sweepers/quantize.ts';
import { PLAYER_ANIM_STATES } from '../../../src/modules/sweepers/types.ts';

test('toCm rounds to whole centimetres (no -0)', () => {
  assert.equal(toCm(1.234), 123);
  assert.equal(toCm(1.235), 124);
  assert.equal(toCm(-2.5), -250);
  assert.ok(Object.is(toCm(-0.001), 0));
});

test('toRot16: round(rotY / 2π × 65536) & 0xffff, wraps', () => {
  assert.equal(toRot16(0), 0);
  assert.equal(toRot16(Math.PI), 32768);
  assert.equal(toRot16(Math.PI / 2), 16384);
  assert.equal(toRot16(2 * Math.PI), 0);
  assert.equal(toRot16(-Math.PI / 2), 49152);
  for (const rad of [0.1, 1, 2.5, 6.2]) assert.ok(Math.abs(fromRot16(toRot16(rad)) - rad) < (Math.PI * 2) / 65536);
});

test('state index follows the protocol order', () => {
  assert.deepEqual(PLAYER_ANIM_STATES, ['IDLE', 'WALK', 'SPRINT', 'SWEEPING_ARCS', 'HOLDING_BAG', 'OPERATING_VACUUM', 'DRIVING_VEHICLE', 'PUSHING_CART']);
  assert.equal(stateIndex('IDLE'), 0);
  assert.equal(stateIndex('PUSHING_CART'), 7);
});

test('encodePose: [id, xCm, yCm, zCm, rot16, stateIdx, corr, tool, carry]', () => {
  assert.deepEqual(encodePose(7, { x: 1.006, y: 0.5, z: -3.333, rotY: Math.PI, state: 'SPRINT' }, true), [7, 101, 50, -333, 32768, 2, 1, 0, 0]);
  assert.deepEqual(encodePose(1, { x: 0, y: 0, z: 0, rotY: 0, state: 'IDLE' }, false, 5), [1, 0, 0, 0, 0, 0, 0, 5, 0]);
  assert.deepEqual(encodePose(1, { x: 0, y: 0, z: 0, rotY: 0, state: 'HOLDING_BAG' }, false, 0, 42), [1, 0, 0, 0, 0, 4, 0, 0, 42]);
});
