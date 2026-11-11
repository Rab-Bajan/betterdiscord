import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { textChannels, voiceChannels } from '../../../src/config/channels.ts';

const state = createRequire(import.meta.url)('../../../state.js') as { textChannels: unknown; voiceChannels: unknown };

test('channel definitions match state.js exactly', () => {
  assert.deepStrictEqual(structuredClone(textChannels), state.textChannels);
  assert.deepStrictEqual(structuredClone(voiceChannels), state.voiceChannels);
});

test('channel definitions are frozen', () => {
  assert.ok(Object.isFrozen(textChannels));
  assert.ok(Object.isFrozen(voiceChannels));
  assert.ok(textChannels.every(Object.isFrozen));
  assert.ok(voiceChannels.every(Object.isFrozen));
  assert.throws(() => (textChannels as unknown[]).push({}), TypeError);
});
