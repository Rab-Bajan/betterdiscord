import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputRateLimiter } from '../../../src/modules/sweepers/InputRateLimiter.ts';

test('burst of 10, then 30 per second, per socket', () => {
  let now = 0;
  const limiter = new InputRateLimiter(30, 10, () => now);
  const burst = Array.from({ length: 15 }, () => limiter.take('a'));
  assert.equal(burst.filter(Boolean).length, 10);
  assert.equal(limiter.take('b'), true, 'buckets are per socket');
  now += 100; // 3 tokens
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a'), limiter.take('a')], [true, true, true, false]);
  now += 60_000;
  assert.equal(Array.from({ length: 20 }, () => limiter.take('a')).filter(Boolean).length, 10, 'never more than the burst');
  let accepted = 0;
  for (let i = 0; i < 1000; i++) { now += 10; if (limiter.take('a')) accepted++; } // 100/s offered for 10 s
  assert.ok(accepted >= 299 && accepted <= 301, String(accepted));
  limiter.forget('a');
  assert.equal(limiter.take('a'), true);
});
