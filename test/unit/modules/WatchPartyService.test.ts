import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WatchPartyService } from '../../../src/modules/watchParty/WatchPartyService.ts';

const clock = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};
const media = { url: 'u', videoId: 'dQw4w9WgXcQ', title: 'Klip' };

test('start: YouTube ids only, legacy defaults', () => {
  const c = clock();
  const watch = new WatchPartyService(c.now);
  assert.equal(watch.start('r', 'Alice', { ...media, videoId: 'short' }), null);
  assert.equal(watch.start('r', 'Alice', { ...media, videoId: undefined }), null);
  assert.deepEqual(watch.start('r', 'Alice', { url: undefined, videoId: 'dQw4w9WgXcQ', title: '' }), {
    active: true, channelId: 'r', service: 'youtube', url: '', videoId: 'dQw4w9WgXcQ', title: 'YouTube Videó',
    isPlaying: true, currentTime: 0, lastUpdated: 1_000_000, startedBy: 'Alice', updatedBy: 'Alice', serverTime: 1_000_000
  });
});

test('live position advances only while playing', () => {
  const c = clock();
  const watch = new WatchPartyService(c.now);
  watch.start('r', 'Alice', media);
  c.advance(1500);
  assert.equal(watch.getSession('r')?.currentTime, 1.5);
  const paused = watch.control('r', 'pause', undefined, 'Bob');
  assert.deepEqual(paused?.sync, { action: 'pause', currentTime: 1.5, timestamp: 1_001_500, triggeredBy: 'Bob' });
  c.advance(5000);
  assert.equal(watch.getSession('r')?.currentTime, 1.5);
  assert.equal(watch.getSession('r')?.updatedBy, 'Bob');
});

test('control: explicit valid time wins, invalid falls back; play/pause flags; unknown channel', () => {
  const c = clock();
  const watch = new WatchPartyService(c.now);
  watch.start('r', 'Alice', media);
  assert.equal(watch.control('r', 'pause', 42, 'A')?.state.currentTime, 42);
  assert.equal(watch.control('r', 'play', -3, 'A')?.state.currentTime, 42);
  assert.equal(watch.control('r', 'seek', Number.NaN, 'A')?.state.isPlaying, true);
  assert.equal(watch.control('nincs', 'play', 1, 'A'), null);
});

test('sessions snapshot, stop, countdown and unknown ids', () => {
  const c = clock();
  const watch = new WatchPartyService(c.now);
  watch.start('a', 'Alice', media);
  watch.start('b', 'Bob', media);
  assert.deepEqual(Object.keys(watch.getSessions()), ['a', 'b']);
  watch.stop('a');
  assert.equal(watch.getSession('a'), null);
  assert.equal(watch.getSession(5), null);
  assert.equal(watch.countdownTarget(), 1_003_000);
});
