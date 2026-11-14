// Writes a JSON fixture of real MiskolcSweepers output (Phase B) for the frontend parser tests:
// the generated layout inside a real `miskolc:init_state`, plus one sample of each world event.
// Usage: node scripts/buildSweepersFixture.mjs [outFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/core/logging/Logger.ts';
import { SweepersService } from '../src/modules/sweepers/SweepersService.ts';
import { freshWeather } from '../src/modules/sweepers/weather.ts';

// Without an argument it writes to the OS temp directory; pass the frontend fixture path explicitly.
const DEFAULT_OUT = path.join(os.tmpdir(), 'sweepers-b-layout-fixture.json');
const CHANNEL = 'hang-chill';
const out = path.resolve(process.argv[2] ?? DEFAULT_OUT);

const clock = { ms: 1_750_000_000_000, now() { return this.ms; } };
const rooms = new Map();
const store = {
  loadRoom: (id) => rooms.get(id) ?? null,
  loadPlayerStats: () => null,
  loadStructures: () => [],
  saveRoom: (room) => { rooms.set(room.roomId, room); },
  savePlayerStats: () => undefined
};
const emitted = [];
const record = (event) => (...args) => { emitted.push({ event, payload: args.find((a) => typeof a === 'object' && a !== null) }); };
const events = {
  initState: record('miskolc:init_state'),
  tickSync: record('miskolc:tick_sync'),
  playerJoined: record('miskolc:player_joined'),
  playerLeft: record('miskolc:player_left'),
  sessionUpdated: () => undefined,
  kicked: record('miskolc:kicked'),
  districtUnlocked: record('miskolc:district_unlocked'),
  clock: record('miskolc:clock'),
  clockTo: record('miskolc:clock'),
  weather: record('miskolc:weather')
};
const service = new SweepersService({
  store, events, clock, scheduler: () => () => undefined, logger: new Logger({ minLevel: 'error', sink: () => undefined })
});

service.join(CHANNEL, 'fixture-socket', { key: 'name:fixture', accountId: null, username: 'Fixture', avatarColor: '#7655F5' });
const initState = emitted.find((e) => e.event === 'miskolc:init_state')?.payload;
const joinClock = emitted.find((e) => e.event === 'miskolc:clock')?.payload;
service.addRevenue(CHANNEL, 25_000);
const start = clock.ms;
clock.ms = start + freshWeather(CHANNEL).nextStart;
service.tick();
const of = (event) => emitted.filter((e) => e.event === event).map((e) => e.payload);
service.dispose();

const fixture = {
  description: 'Real backend output of MiskolcSweepers Phase B (layout v1). Regenerate from the backend repo with the explicit path: node scripts/buildSweepersFixture.mjs ../betterdiscord-frontend/tests/fixtures/sweepers-b-layout-fixture.json',
  initState,
  events: {
    clockOnJoin: joinClock,
    clockPeriodic: of('miskolc:clock').at(-1),
    weather: of('miskolc:weather').at(-1),
    districtUnlocked: of('miskolc:district_unlocked').at(-1)
  }
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes; layout ${Buffer.byteLength(JSON.stringify(initState.layout))} bytes)`);
