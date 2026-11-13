// Guards of the Phase C client payloads: sweep_hit, player_action, buy_upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../../../src/core/errors/ValidationError.ts';
import { parseBuyUpgrade, parsePlayerAction, parseSweepHit } from '../../../src/modules/sweepers/payloads.ts';

const invalid = (fn: () => unknown): void => assert.throws(fn, (err: unknown) => err instanceof ValidationError);

test('sweep_hit: seq uint, tool 0..7, alt 0|1, finite coordinates', () => {
  const ok = { channelId: ' hang-chill ', seq: 3, tool: 7, alt: 1, x: 1.5, z: -2, rotY: 0.25 };
  assert.deepEqual(parseSweepHit(ok), { channelId: 'hang-chill', seq: 3, tool: 7, alt: true, x: 1.5, z: -2, rotY: 0.25 });
  assert.equal(parseSweepHit({ ...ok, alt: 0 }).alt, false);
  for (const bad of [{ tool: 8 }, { tool: -1 }, { tool: 1.5 }, { alt: true }, { alt: 2 }, { seq: -1 }, { x: Number.NaN }, { z: '1' }, { rotY: Infinity }, { x: 2e6 }]) {
    invalid(() => parseSweepHit({ ...ok, ...bad }));
  }
  invalid(() => parseSweepHit(null));
  invalid(() => parseSweepHit([ok]));
});

test('player_action: select / kick / dump, nothing else', () => {
  assert.deepEqual(parsePlayerAction({ channelId: 'c', kind: 'select', tool: 4 }), { channelId: 'c', kind: 'select', tool: 4 });
  assert.deepEqual(parsePlayerAction({ channelId: 'c', kind: 'kick', id: 0x250003, vx: -2, vz: 1 }), { channelId: 'c', kind: 'kick', id: 0x250003, vx: -2, vz: 1 });
  assert.deepEqual(parsePlayerAction({ channelId: 'c', kind: 'dump', extra: 1 }), { channelId: 'c', kind: 'dump' });
  invalid(() => parsePlayerAction({ channelId: 'c', kind: 'select' }));
  invalid(() => parsePlayerAction({ channelId: 'c', kind: 'select', tool: 8 }));
  invalid(() => parsePlayerAction({ channelId: 'c', kind: 'kick', id: -1, vx: 0, vz: 0 }));
  invalid(() => parsePlayerAction({ channelId: 'c', kind: 'kick', id: 1, vx: 5000, vz: 0 }));
  invalid(() => parsePlayerAction({ channelId: 'c', kind: 'bag' }));
  invalid(() => parsePlayerAction({ kind: 'dump' }));
});

test('buy_upgrade: tier required for tool (1..6) and repair (1..3), level for width / pack / hard', () => {
  assert.deepEqual(parseBuyUpgrade({ channelId: 'c', item: 'tool', tier: 6 }), { channelId: 'c', item: 'tool', tier: 6 });
  assert.deepEqual(parseBuyUpgrade({ channelId: 'c', item: 'repair', tier: 3 }), { channelId: 'c', item: 'repair', tier: 3 });
  assert.deepEqual(parseBuyUpgrade({ channelId: 'c', item: 'width', level: 1 }), { channelId: 'c', item: 'width', level: 1 });
  assert.deepEqual(parseBuyUpgrade({ channelId: 'c', item: 'kofola', tier: 99 }), { channelId: 'c', item: 'kofola' });
  for (const bad of [
    { item: 'tool' }, { item: 'tool', tier: 0 }, { item: 'tool', tier: 7 }, { item: 'repair', tier: 4 }, { item: 'pack' },
    { item: 'hard', level: 0 }, { item: 'cheat' }, { item: 5 }
  ]) invalid(() => parseBuyUpgrade({ channelId: 'c', ...bad }));
});
