// Phase B through the service (manual clock): init_state world fields, movement against the real
// city (walls, locked districts), district unlocks, the clock and weather broadcasts, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLayout } from '../../../src/modules/sweepers/city/cityLayout.ts';
import { DAY_MS, DAYLIGHT_MS } from '../../../src/modules/sweepers/dayClock.ts';
import type { ClockSync } from '../../../src/modules/sweepers/dayClock.ts';
import { SweepersError } from '../../../src/modules/sweepers/SweepersError.ts';
import { spawnPose } from '../../../src/modules/sweepers/SweepersRoom.ts';
import type { PlayerInput } from '../../../src/modules/sweepers/payloads.ts';
import type { DistrictUnlockedPayload, InitStatePayload, PlayerTickRow, TickSyncPayload } from '../../../src/modules/sweepers/types.ts';
import { freshWeather } from '../../../src/modules/sweepers/weather.ts';
import type { WeatherPayload } from '../../../src/modules/sweepers/weather.ts';
import { guest, makeService } from './support.ts';

const ROOM = 'hang-chill';
const lastInit = (log: unknown[][]): InitStatePayload => log.at(-1)?.[1] as InitStatePayload;

/** A service with Alice (short id 1) joined, plus a helper that walks her in legal steps. */
function withAlice() {
  const fixture = makeService();
  fixture.service.join(ROOM, 's1', guest('Alice'));
  let seq = 0;
  const pose = { ...spawnPose(1) };
  /** Sends one input 0.5 s after the previous one and returns her tick row. */
  const step = (x: number, z: number, y = 0): PlayerTickRow => {
    fixture.clock.ms += 500;
    const input: PlayerInput = { channelId: ROOM, seq: ++seq, x, y, z, rotY: 0, state: 'WALK' };
    fixture.service.input('s1', input);
    fixture.service.tick();
    const sync = fixture.events.of('tickSync').at(-1)?.[1] as TickSyncPayload;
    const row = sync.p.find(([id]) => id === 1);
    assert.ok(row, 'a row for Alice');
    return row;
  };
  /** Walks to (x, z) in steps of at most 4 m, asserting each is accepted. */
  const walkTo = (x: number, z: number): void => {
    for (;;) {
      const dist = Math.hypot(x - pose.x, z - pose.z);
      const t = Math.min(1, 4 / dist);
      const nx = pose.x + (x - pose.x) * t;
      const nz = pose.z + (z - pose.z) * t;
      const row = step(nx, nz);
      assert.equal(row[6], 0, `walking to ${nx.toFixed(1)}, ${nz.toFixed(1)} was corrected`);
      pose.x = nx;
      pose.z = nz;
      if (t === 1) return;
    }
  };
  return { ...fixture, step, walkTo, pose };
}

test('init_state carries the layout, the unlocks, lifetime revenue, the clock and the weather; clock follows on join', () => {
  const { events, clock } = withAlice();
  const init = lastInit(events.of('initState'));
  assert.equal(init.layout, cityLayout());
  assert.equal(init.layout.version, 1);
  assert.deepEqual(init.unlockedDistricts, [0]);
  assert.equal(init.lifetimeEarned, 0);
  assert.deepEqual(init.clock, { dayMs: DAY_MS, daylightMs: DAYLIGHT_MS, timeMs: 0, day: 1, serverTime: clock.ms });
  assert.deepEqual(init.weather, { kind: 'clear', untilServerTime: null });
  assert.deepEqual(events.of('clockTo'), [['s1', { timeMs: 0, day: 1, serverTime: clock.ms }]]);
  const order = events.log.map(([name]) => name);
  assert.ok(order.indexOf('clockTo') === order.indexOf('initState') + 1, 'clock right after init_state');
});

test('movement in the real city: a wall corrects (slide), a locked district refuses, the unlock opens it', () => {
  const { service, events, step, walkTo, pose } = withAlice();
  // Into the LED display beside the weighbridge (z 4.15..4.45 at x 13.5..16.5).
  walkTo(15, 2.5);
  const wall = step(15, 6);
  assert.equal(wall[6], 1, 'corrected');
  assert.ok(wall[3] <= Math.round((4.15 - 0.35) * 100) + 1 && wall[3] > 250, `stopped before the display at z ${wall[3]} cm`);
  // Back onto the east lane and up to the edge of the centre hex (x = 34.64): Avas (district 1) is locked.
  pose.z = wall[3] / 100;
  walkTo(15, 1);
  walkTo(34, 1);
  const locked = step(35.5, 1);
  assert.equal(locked[6], 1);
  assert.deepEqual([locked[1], locked[3]], [3400, 100], 'stays where she was');
  // 25 000 Ft of lifetime revenue opens Avas: one event, the same step is now accepted.
  assert.deepEqual(service.addRevenue(ROOM, 25_000), [1]);
  assert.deepEqual(events.of('districtUnlocked'), [[ROOM, { district: 1, unlockedDistricts: [0, 1] } satisfies DistrictUnlockedPayload]]);
  const open = step(35.5, 1);
  assert.equal(open[6], 0);
  assert.equal(open[1], 3550);
  // The other districts stay closed; the centre and Avas are open.
  const world = service.room(ROOM)?.moveWorld;
  assert.ok(world);
  assert.equal(world.isOpen(-60, -60), false);
  assert.equal(world.isOpen(70, 0), true);
  assert.equal(world.isOpen(0, 0), true);
});

test("the room's movement rules read the city heightfield", () => {
  const { service } = withAlice();
  const world = service.room(ROOM)?.moveWorld;
  assert.ok(world);
  assert.equal(world.ground(0, 0), 0);
  assert.ok(world.ground(139, -95) > 25, 'the Avas summit');
});

test('addRevenue: accumulates, opens several districts at once, never re-announces; validation', () => {
  const { service, events } = withAlice();
  assert.deepEqual(service.addRevenue(ROOM, 10_000), []);
  assert.equal(service.room(ROOM)?.lifetimeEarned, 10_000);
  assert.deepEqual(service.addRevenue(ROOM, 170_000), [1, 2, 3]);
  const unlocked = events.of('districtUnlocked').map((args) => args[1] as DistrictUnlockedPayload);
  assert.deepEqual(unlocked.map((u) => u.district), [1, 2, 3]);
  assert.ok(unlocked.every((u) => JSON.stringify(u.unlockedDistricts) === '[0,1,2,3]'));
  assert.deepEqual(service.addRevenue(ROOM, 1), []);
  assert.deepEqual(service.addRevenue(ROOM, 169_999), [4, 5]);
  assert.equal(events.of('districtUnlocked').length, 5);
  assert.throws(() => service.addRevenue(ROOM, 0), RangeError);
  assert.throws(() => service.addRevenue(ROOM, Number.NaN), RangeError);
  assert.throws(() => service.addRevenue('hang-gaming-1', 100), SweepersError);
});

test('unlocks and lifetime revenue persist (saved at once) and load with the world', () => {
  const { service, store, clock, events } = withAlice();
  const saves = store.saves;
  service.addRevenue(ROOM, 80_000);
  assert.equal(store.saves, saves + 1, 'saved on unlock');
  assert.deepEqual(store.rooms.get(ROOM)?.state['unlockedDistricts'], [0, 1, 2]);
  assert.equal(store.rooms.get(ROOM)?.state['lifetimeEarned'], 80_000);
  // Leave, let the world unload, come back: the unlocks are restored.
  service.leave('s1');
  clock.ms += 121_000;
  service.tick();
  assert.equal(service.room(ROOM), undefined);
  service.join(ROOM, 's2', guest('Bob'));
  const init = lastInit(events.of('initState'));
  assert.deepEqual(init.unlockedDistricts, [0, 1, 2]);
  assert.equal(init.lifetimeEarned, 80_000);
});

test('clock: miskolc:clock to the world every 30 s; it advances while loaded and persists', () => {
  const { service, events, clock, store } = withAlice();
  const joinedAt = clock.ms;
  clock.ms += 29_000;
  service.tick();
  assert.equal(events.of('clock').length, 0);
  clock.ms += 1_000;
  service.tick();
  assert.deepEqual(events.of('clock'), [[ROOM, { timeMs: 30_000, day: 1, serverTime: joinedAt + 30_000 } satisfies ClockSync]]);
  clock.ms += 30_000;
  service.tick();
  assert.equal(events.of('clock').length, 2);
  // Through a whole day: day 2 begins at sunrise.
  clock.ms = joinedAt + DAY_MS + 5_000;
  service.tick();
  const last = events.of('clock').at(-1)?.[1] as ClockSync;
  assert.deepEqual([last.day, last.timeMs], [2, 5_000]);
  service.dispose();
  assert.deepEqual(store.rooms.get(ROOM)?.state['clock'], { timeMs: 5_000, day: 2 });
});

test('weather: changes are broadcast and land in init_state; a reloaded room continues its schedule', () => {
  const { service, events, clock, store } = withAlice();
  const joinedAt = clock.ms;
  const first = freshWeather(ROOM).nextStart;
  clock.ms = joinedAt + first - 1;
  service.tick();
  assert.equal(events.of('weather').length, 0);
  clock.ms = joinedAt + first;
  service.tick();
  const broadcast = (events.of('weather') as Array<[string, WeatherPayload]>)[0];
  assert.ok(broadcast);
  const [channel, payload] = broadcast;
  assert.equal(channel, ROOM);
  assert.ok(payload.kind !== 'clear' && payload.untilServerTime !== null);
  const length = payload.untilServerTime - clock.ms;
  assert.ok(length >= 0.25 * DAY_MS && length <= 0.5 * DAY_MS, `spell of ${length / DAY_MS} day`);
  service.join(ROOM, 's2', guest('Bob'));
  assert.deepEqual(lastInit(events.of('initState')).weather, payload);
  // Saved mid-spell and reloaded much later (it stood still while unloaded): the same spell resumes.
  service.dispose();
  const saved = store.rooms.get(ROOM);
  assert.ok(saved);
  const fresh = makeService();
  fresh.store.rooms.set(ROOM, saved);
  fresh.clock.ms = 50_000_000;
  fresh.service.join(ROOM, 'x1', guest('Cecil'));
  const resumed = lastInit(fresh.events.of('initState')).weather;
  assert.equal(resumed.kind, payload.kind);
  assert.equal(resumed.untilServerTime, fresh.clock.ms + (payload.untilServerTime - clock.ms));
  // Then it clears on schedule.
  fresh.clock.ms = resumed.untilServerTime ?? 0;
  fresh.service.tick();
  assert.deepEqual(fresh.events.of('weather').at(-1)?.[1], { kind: 'clear', untilServerTime: null });
});

test('a join that changes the weather sends the joiner init_state before miskolc:weather (review LOW-5)', () => {
  const { service, events, clock } = withAlice();
  clock.ms += freshWeather(ROOM).nextStart;
  events.clear();
  service.join(ROOM, 's2', guest('Bob'));
  const names = events.log.map(([name]) => name);
  const init = names.indexOf('initState');
  const weather = names.indexOf('weather');
  assert.ok(init >= 0 && weather >= 0, names.join(','));
  assert.ok(init < weather, `init_state first: ${names.join(',')}`);
  assert.notEqual(lastInit(events.of('initState')).weather.kind, 'clear', 'init_state already carries the new spell');
});

test('a Phase A room row (state_json { v: 1 }) still loads: defaults for the world state', () => {
  const { service, store, events } = makeService();
  const cleanliness: Record<string, number> = { 0: 77 };
  store.rooms.set(ROOM, { roomId: ROOM, state: { v: 1 }, cleanliness, teamFunds: 1234, lastSaved: 1 });
  service.join(ROOM, 's1', guest('Alice'));
  const init = lastInit(events.of('initState'));
  assert.equal(init.teamFunds, 1234);
  assert.equal(init.hexes[0]?.cleanliness, 77);
  assert.deepEqual(init.unlockedDistricts, [0]);
  assert.equal(init.lifetimeEarned, 0);
  assert.deepEqual([init.clock.day, init.clock.timeMs], [1, 0]);
  assert.deepEqual(init.weather, { kind: 'clear', untilServerTime: null });
  service.dispose();
  const state = store.rooms.get(ROOM)?.state;
  assert.equal(state?.['v'], 2);
  assert.deepEqual(state?.['weather'], freshWeather(ROOM));
});
