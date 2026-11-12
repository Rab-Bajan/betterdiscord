import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PresenceService, UserRegistry } from '../../../src/modules/presence/index.ts';
import type { PresenceUser } from '../../../src/modules/presence/index.ts';
import { voiceChannels } from '../../../src/config/channels.ts';

interface LegacyState {
  users: Map<string, PresenceUser>;
  getVoiceChannelState(): unknown;
  getOnlineUsersList(): unknown;
  broadcastPresence(io: { emit(event: string, payload: unknown): void }): void;
}
// state.js is untyped CommonJS; LegacyState lists the members compared here.
const state = createRequire(import.meta.url)('../../../state.js') as LegacyState;

const user = (id: string, extra: Partial<PresenceUser> = {}): PresenceUser => ({
  id, accountId: null, username: `u-${id}`, avatarColor: '#7655F5', avatarUrl: null,
  voiceChannel: null, isMuted: false, isDeafened: false, ...extra
});

const recorder = (): { emitted: Array<[string, unknown]>; emit(event: string, payload: unknown): void } => {
  const emitted: Array<[string, unknown]> = [];
  return { emitted, emit: (event, payload) => { emitted.push([event, payload]); } };
};

const registry = new UserRegistry(state.users);
const presence = new PresenceService(registry, voiceChannels);

afterEach(() => state.users.clear());

describe('UserRegistry wraps the state.js Map (no copy)', () => {
  test('writes through the registry are visible to legacy code and vice versa', () => {
    registry.set('a', user('a'));
    assert.equal(state.users.get('a')?.username, 'u-a');
    state.users.set('b', user('b'));
    assert.equal(registry.get('b')?.username, 'u-b');
    assert.equal(registry.has('b'), true);
    assert.equal(registry.size, 2);
    assert.deepEqual([...registry.entries()].map(([id]) => id), ['a', 'b']);
    assert.deepEqual([...registry.values()].map((u) => u.id), ['a', 'b']);
    assert.equal(registry.delete('a'), true);
    assert.equal(registry.delete('a'), false);
    assert.equal(state.users.has('a'), false);
  });

  test('legacy in-place mutation is seen immediately', () => {
    state.users.set('m', user('m'));
    const legacyObj = state.users.get('m');
    if (legacyObj) legacyObj.voiceChannel = 'hang-chill';
    assert.equal(registry.get('m')?.voiceChannel, 'hang-chill');
  });
});

describe('PresenceService parity with state.js', () => {
  const populate = (): void => {
    state.users.set('s1', user('s1', { voiceChannel: 'hang-chill', isSpeaking: true, isMuted: true }));
    state.users.set('s2', user('s2', { accountId: 'acc-2', avatarUrl: '/uploads/x.png', isScreenSharing: true }));
    state.users.set('s3', user('s3', { voiceChannel: 'hang-chill', isCameraOn: true, speedTest: { ping: 5, download: 1.5, upload: 2, jitter: 1, testedAt: 1 } }));
    state.users.set('s4', user('s4', { voiceChannel: 'hang-gaming-1', isDeafened: true }));
    state.users.set('s5', user('s5', { voiceChannel: 'unknown-room' }));
    state.users.set('s6', user('s6', { accountId: '', avatarUrl: '' }));
  };

  test('empty registry', () => {
    assert.deepEqual(presence.getVoiceChannelState(), state.getVoiceChannelState());
    assert.deepEqual(presence.getOnlineUsersList(), state.getOnlineUsersList());
  });

  test('getVoiceChannelState: same channels, members, defaults and key order', () => {
    populate();
    const ours = presence.getVoiceChannelState();
    const legacy = state.getVoiceChannelState() as Record<string, unknown>;
    assert.deepEqual(ours, legacy);
    assert.deepEqual(Object.keys(ours), Object.keys(legacy));
    assert.deepEqual(ours['hang-chill']?.map((m) => m.id), ['s1', 's3']);
  });

  test('getOnlineUsersList: same entries and order', () => {
    populate();
    assert.deepEqual(presence.getOnlineUsersList(), state.getOnlineUsersList());
  });

  test('broadcastPresence emits the same events and payloads', () => {
    populate();
    const ours = recorder();
    const legacy = recorder();
    presence.broadcastPresence(ours);
    state.broadcastPresence(legacy);
    assert.deepEqual(ours.emitted, legacy.emitted);
    assert.deepEqual(ours.emitted.map(([e]) => e), ['users:updated', 'voice:states-updated']);
  });

  test('a voiceChannel named after an Object.prototype member is ignored (legacy would throw)', () => {
    state.users.set('p', user('p', { voiceChannel: 'toString' }));
    assert.throws(() => state.getVoiceChannelState(), TypeError);
    assert.deepEqual(presence.getVoiceChannelState(), { 'hang-altalanos': [], 'hang-gaming-1': [], 'hang-chill': [] });
  });
});
