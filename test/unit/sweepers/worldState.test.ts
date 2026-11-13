// Pure world-state pieces: unlock thresholds, the day/night clock, the weather scheduler and the
// state_json format (including Phase A rows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_MS, DAYLIGHT_MS, DayClock } from '../../../src/modules/sweepers/dayClock.ts';
import { unlockedFor } from '../../../src/modules/sweepers/progression.ts';
import { MAX_CLOCK_DAY, parseRoomState, ROOM_STATE_VERSION, serialiseRoomState } from '../../../src/modules/sweepers/roomState.ts';
import { freshWeather, MAX_CATCH_UP_MS, WeatherScheduler } from '../../../src/modules/sweepers/weather.ts';
import type { WeatherRecord } from '../../../src/modules/sweepers/weather.ts';

test('unlock thresholds by lifetime revenue: 25 000 / 75 000 / 180 000 / 350 000 (×2)', () => {
  assert.deepEqual(unlockedFor(0), [0]);
  assert.deepEqual(unlockedFor(24_999), [0]);
  assert.deepEqual(unlockedFor(25_000), [0, 1]);
  assert.deepEqual(unlockedFor(75_000), [0, 1, 2]);
  assert.deepEqual(unlockedFor(179_999.5), [0, 1, 2]);
  assert.deepEqual(unlockedFor(180_000), [0, 1, 2, 3]);
  assert.deepEqual(unlockedFor(350_000), [0, 1, 2, 3, 4, 5]);
});

test('day clock: 36 min days (24 light + 12 dark), runs with server time, day counter from 1', () => {
  assert.equal(DAY_MS, 36 * 60_000);
  assert.equal(DAYLIGHT_MS, 24 * 60_000);
  const clock = new DayClock({ timeMs: DAY_MS - 1000, day: 3 }, 50_000);
  assert.deepEqual(clock.read(50_000), { timeMs: DAY_MS - 1000, day: 3 });
  assert.deepEqual(clock.read(51_500), { timeMs: 500, day: 4 });
  assert.equal(clock.elapsed(50_000), 2 * DAY_MS + DAY_MS - 1000);
  assert.deepEqual(clock.state(51_500), { dayMs: DAY_MS, daylightMs: DAYLIGHT_MS, timeMs: 500, day: 4, serverTime: 51_500 });
  assert.deepEqual(clock.sync(51_500), { timeMs: 500, day: 4, serverTime: 51_500 });
  // A clock that is reloaded later resumes from where it was saved (it stood still while unloaded).
  const saved = clock.read(60_000);
  assert.deepEqual(new DayClock(saved, 9_000_000).read(9_000_000), saved);
});

/** Spells of a scheduler over `days` in-game days, sampled every in-game minute. */
function spells(record: WeatherRecord, days: number): Array<{ kind: string; start: number; end: number }> {
  const scheduler = new WeatherScheduler(record);
  const found: Array<{ kind: string; start: number; end: number }> = [];
  for (let t = 0; t <= days * DAY_MS; t += 60_000) {
    if (!scheduler.advance(t)) continue;
    const r = scheduler.record();
    if (r.kind !== 'clear' && r.until !== null) found.push({ kind: r.kind, start: t, end: r.until });
  }
  return found;
}

test('weather: seeded per room, a smog or drizzle spell every 2–3 days lasting 0.25–0.5 day', () => {
  assert.deepEqual(freshWeather('hang-chill'), freshWeather('hang-chill'));
  assert.notDeepEqual(freshWeather('hang-chill'), freshWeather('hang-gaming-1'));
  const fresh = freshWeather('hang-chill');
  assert.equal(fresh.kind, 'clear');
  assert.equal(fresh.until, null);
  assert.ok(fresh.nextStart >= 2 * DAY_MS && fresh.nextStart <= 3 * DAY_MS);
  const list = spells(fresh, 60);
  assert.ok(list.length >= 19 && list.length <= 30, `${list.length} spells in 60 days`);
  for (const [i, s] of list.entries()) {
    assert.ok(s.kind === 'smog' || s.kind === 'drizzle');
    const length = s.end - s.start;
    // Sampled every minute: the start is seen up to a minute late.
    assert.ok(length >= 0.25 * DAY_MS - 60_000 && length <= 0.5 * DAY_MS, `spell ${i} lasts ${length / DAY_MS} day`);
    const next = list[i + 1];
    if (next) {
      const gap = next.start - s.start;
      assert.ok(gap >= 2 * DAY_MS - 60_000 && gap <= 3 * DAY_MS + 60_000, `gap ${gap / DAY_MS} day`);
    }
  }
  assert.ok(new Set(list.map((s) => s.kind)).size === 2, 'both kinds occur');
  // Deterministic: the same record gives the same spells; a persisted mid-way record continues them.
  assert.deepEqual(spells(fresh, 60), list);
  const scheduler = new WeatherScheduler(fresh);
  scheduler.advance(10 * DAY_MS);
  const resumed = new WeatherScheduler(scheduler.record());
  const original = new WeatherScheduler(scheduler.record());
  for (let t = 10 * DAY_MS; t < 20 * DAY_MS; t += 3_600_000) {
    resumed.advance(t);
    original.advance(t);
  }
  assert.deepEqual(resumed.record(), original.record());
});

test('weather: a long jump in time catches up in one advance; payload end in server time', () => {
  const scheduler = new WeatherScheduler(freshWeather('hang-chill'));
  assert.deepEqual(scheduler.payload(0, 5000), { kind: 'clear', untilServerTime: null });
  const start = freshWeather('hang-chill').nextStart;
  assert.equal(scheduler.advance(start - 1), false);
  assert.equal(scheduler.advance(start), true);
  const r = scheduler.record();
  assert.ok(r.until !== null && r.kind !== 'clear');
  assert.deepEqual(scheduler.payload(start + 1000, 70_000), { kind: r.kind, untilServerTime: 70_000 + (r.until - start - 1000) });
  assert.equal(scheduler.advance(start + 1), false, 'no change mid-spell');
  // 40 days later: it has moved on through many spells and reports whatever the state is now.
  scheduler.advance(start + 40 * DAY_MS);
  const later = scheduler.record();
  assert.ok(later.nextStart > start + 40 * DAY_MS || later.until !== null);
});

test('weather and clock: a corrupt or huge stored time is bounded (review LOW-4)', () => {
  // The clock rejects an absurd day or a time of day outside [0, DAY_MS).
  assert.deepEqual(parseRoomState({ clock: { timeMs: 0, day: MAX_CLOCK_DAY } }, 'r').clock, { timeMs: 0, day: MAX_CLOCK_DAY });
  assert.deepEqual(parseRoomState({ clock: { timeMs: 0, day: MAX_CLOCK_DAY + 1 } }, 'r').clock, { timeMs: 0, day: 1 });
  assert.deepEqual(parseRoomState({ clock: { timeMs: 1e9, day: 1e9 } }, 'r').clock, { timeMs: 0, day: 1 });
  assert.deepEqual(parseRoomState({ clock: { timeMs: DAY_MS, day: 3 } }, 'r').clock, { timeMs: 0, day: 1 });
  // The scheduler skips arithmetically: a jump of a billion days takes a handful of iterations.
  const scheduler = new WeatherScheduler(freshWeather('hang-chill'));
  const elapsed = 1e9 * DAY_MS;
  const started = performance.now();
  scheduler.advance(elapsed);
  assert.ok(performance.now() - started < 1000, 'bounded catch-up');
  const r = scheduler.record();
  assert.ok(r.nextStart > elapsed && r.nextStart <= elapsed + 3 * DAY_MS, 'next spell within one gap');
  assert.ok(r.until === null || (r.until > elapsed && r.until <= elapsed + 0.5 * DAY_MS));
  // Within the bound the schedule is unchanged: catching up 5 days in one go equals ticking through them.
  const stepped = new WeatherScheduler(freshWeather('room-x'));
  const jumped = new WeatherScheduler(freshWeather('room-x'));
  assert.ok(5 * DAY_MS < MAX_CATCH_UP_MS);
  for (let t = 0; t <= 5 * DAY_MS; t += 60_000) stepped.advance(t);
  jumped.advance(5 * DAY_MS);
  assert.deepEqual(jumped.record(), stepped.record());
});

test('state_json: a weather record from another timeline is replaced by a fresh schedule (review LOW-A)', () => {
  const smog = (until: number, nextStart: number) => ({ kind: 'smog', until, nextStart, rng: 7 });
  // The clock is rejected (day 2e6) and resets to day 1: the old spell (ending at day 2e6 + 0.25) goes too.
  const day2e6 = (2e6 - 1) * DAY_MS;
  const reset = parseRoomState({ clock: { timeMs: 0, day: 2e6 }, weather: smog(day2e6 + 0.25 * DAY_MS, day2e6 + 2.5 * DAY_MS) }, 'r');
  assert.deepEqual(reset.clock, { timeMs: 0, day: 1 });
  assert.deepEqual(reset.weather, freshWeather('r'));
  // A valid clock with a far-future next spell: a fresh schedule starting from the current game time.
  const elapsed = 9 * DAY_MS + 1000;
  const shifted = parseRoomState({ clock: { timeMs: 1000, day: 10 }, weather: { kind: 'clear', until: null, nextStart: elapsed + 50 * DAY_MS, rng: 7 } }, 'r');
  assert.deepEqual(shifted.weather, { ...freshWeather('r'), nextStart: freshWeather('r').nextStart + elapsed });
  // A consistent spell (ends within 0.5 day, next within 3 days) is kept as stored.
  const kept = smog(elapsed + 0.5 * DAY_MS, elapsed + 3 * DAY_MS);
  assert.deepEqual(parseRoomState({ clock: { timeMs: 1000, day: 10 }, weather: kept }, 'r').weather, kept);
});

test('state_json: a Phase A row ({ v: 1 }) or garbage loads as defaults; v2 round-trips', () => {
  const defaults = { lifetimeEarned: 0, unlockedDistricts: [0], clock: { timeMs: 0, day: 1 }, weather: freshWeather('room-1') };
  assert.deepEqual(parseRoomState({ v: 1 }, 'room-1'), defaults);
  assert.deepEqual(parseRoomState({}, 'room-1'), defaults);
  assert.deepEqual(parseRoomState({
    v: 2, lifetimeEarned: -5, unlockedDistricts: 'all', clock: { timeMs: 'noon', day: 0 }, weather: { kind: 'snow', until: null, nextStart: 1, rng: 1 }
  }, 'room-1'), defaults);
  // A spell without an end (or clear with one) is inconsistent: reset.
  assert.deepEqual(parseRoomState({ weather: { kind: 'smog', until: null, nextStart: 1, rng: 1 } }, 'room-1').weather, freshWeather('room-1'));

  const world = {
    lifetimeEarned: 80_000,
    unlockedDistricts: [0, 1, 2],
    clock: { timeMs: 123_456, day: 7 },
    weather: { kind: 'drizzle' as const, until: 9_000_000, nextStart: 12_000_000, rng: 42 }
  };
  const stored = JSON.parse(JSON.stringify(serialiseRoomState(world))) as Record<string, unknown>;
  assert.equal(stored['v'], ROOM_STATE_VERSION);
  assert.deepEqual(parseRoomState(stored, 'room-1'), world);
  // Unlocks are kept even when the lifetime total alone would not reach them; unknown ids are dropped.
  assert.deepEqual(parseRoomState({ lifetimeEarned: 30_000, unlockedDistricts: [4, 9, 'x', 1] }, 'r').unlockedDistricts, [0, 1, 4]);
});
