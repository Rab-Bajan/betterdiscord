// Writes a JSON fixture of real MiskolcSweepers Phase C output (debris & tools) for the frontend
// guard tests: the Phase C parts of init_state, a join chunk burst, sweep acks and refusals, the
// deltas that follow, a tick row with the tool, personal updates, a purchase, a kick and a dump.
// Usage: node scripts/buildSweepersDebrisFixture.mjs [outFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/core/logging/Logger.ts';
import { AppError } from '../src/core/errors/AppError.ts';
import { SweepersService } from '../src/modules/sweepers/SweepersService.ts';
import { KIND, FLAG_STUCK, ITEM_KINDS, TOOLS, DISTRICT_PROFILES, JACKPOTS } from '../src/modules/sweepers/debris/tables.ts';
import { cityLayout } from '../src/modules/sweepers/city/cityLayout.ts';

// Without an argument it writes to the OS temp directory; pass the handoff / frontend fixture path explicitly.
const DEFAULT_OUT = path.join(os.tmpdir(), 'sweepers-c-debris-fixture.json');
const CHANNEL = 'hang-chill';
const out = path.resolve(process.argv[2] ?? DEFAULT_OUT);

const clock = { ms: 1_750_000_000_000, now() { return this.ms; } };
const rooms = new Map();
const store = {
  loadRoom: (id) => rooms.get(id) ?? null,
  loadPlayerStats: () => null,
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
  weather: record('miskolc:weather'),
  debrisUpdate: record('miskolc:debris_chunk_update'),
  personalUpdate: record('miskolc:personal_update')
};
const service = new SweepersService({
  store, events, clock, scheduler: () => () => undefined, logger: new Logger({ minLevel: 'error', sink: () => undefined })
});
const of = (event) => emitted.filter((e) => e.event === event).map((e) => e.payload);
/** The ack a refused handler sends (SocketController: `{ ok: false, error, code }`). */
const refusal = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
  throw new Error('expected a refusal');
};
const tick = () => { clock.ms += 84; service.tick(); };

service.join(CHANNEL, 'fixture-socket', { key: 'name:fixture', accountId: null, username: 'Fixture', avatarColor: '#7655F5' });
const init = of('miskolc:init_state')[0];
const joinBurst = of('miskolc:debris_chunk_update')[0];
const room = service.room(CHANNEL);
const player = [...room.players()][0];
let seq = 1;
const hit = (tool, alt, extra = {}) => ({ channelId: CHANNEL, seq: seq++, tool, alt, x: player.pose.x, z: player.pose.z, rotY: player.pose.rotY, ...extra });

// A WC-kefe stroke at the spawn point.
const sweepAck = service.sweepHit('fixture-socket', hit(0, false));
const tooFast = refusal(() => service.sweepHit('fixture-socket', hit(0, false)));
const before = emitted.length;
tick();
const afterSweep = emitted.slice(before);
const sweepDelta = afterSweep.find((e) => e.event === 'miskolc:debris_chunk_update')?.payload ?? null;
const personalAfterSweep = afterSweep.find((e) => e.event === 'miskolc:personal_update')?.payload ?? null;
clock.ms += 1000;
const tooFar = refusal(() => service.sweepHit('fixture-socket', hit(0, false, { x: player.pose.x + 5 })));
const notEquipped = refusal(() => service.sweepHit('fixture-socket', hit(3, false)));
const notOwnedSelect = refusal(() => service.playerAction('fixture-socket', { channelId: CHANNEL, kind: 'select', tool: 5 }));

// Buy the partvis at the MÉH workbench (starter grant 2 000 Ft) and equip it.
const notAtWorkbench = refusal(() => service.buyUpgrade('fixture-socket', { channelId: CHANNEL, item: 'tool', tier: 1 }));
const notAtKiosk = refusal(() => service.buyUpgrade('fixture-socket', { channelId: CHANNEL, item: 'beer' }));
const office = cityLayout().landmarks.office;
player.pose = { ...player.pose, x: office.x, z: office.z - 3 };
const notEnoughCash = refusal(() => service.buyUpgrade('fixture-socket', { channelId: CHANNEL, item: 'tool', tier: 2 }));
const buyAck = { ok: true, cash: service.buyUpgrade('fixture-socket', { channelId: CHANNEL, item: 'tool', tier: 1 }) };
service.playerAction('fixture-socket', { channelId: CHANNEL, kind: 'select', tool: 1 });
const selectAck = { ok: true };
const tickFrom = emitted.length;
tick();
const afterSelect = emitted.slice(tickFrom);
const tickSyncWithTool = afterSelect.find((e) => e.event === 'miskolc:tick_sync')?.payload ?? null;
const personalAfterBuy = afterSelect.find((e) => e.event === 'miskolc:personal_update')?.payload ?? null;

// Kick a loose can and pick one up by hand.
const can = [...room.debris.items.values()].find((i) => i.kind === KIND.can && (i.flags & FLAG_STUCK) === 0 && i.hex === 0);
let kickDelta = null;
let handAck = null;
if (can) {
  player.pose = { ...player.pose, x: can.x + 0.5, z: can.z };
  service.playerAction('fixture-socket', { channelId: CHANNEL, kind: 'kick', id: can.id, vx: -3, vz: 0 });
  const kickFrom = emitted.length;
  tick();
  kickDelta = emitted.slice(kickFrom).find((e) => e.event === 'miskolc:debris_chunk_update')?.payload ?? null;
  service.playerAction('fixture-socket', { channelId: CHANNEL, kind: 'select', tool: 7 });
  // The kicked can now rests at (can.x, can.z); stand 1 m east of it, facing west (dir(π/2) = (−1, 0)).
  player.pose = { ...player.pose, x: can.x + 1, z: can.z, rotY: Math.PI / 2 };
  clock.ms += 1000;
  handAck = service.sweepHit('fixture-socket', hit(7, false));
}
const dumpFrom = emitted.length;
const dumpAck = { ok: true };
service.playerAction('fixture-socket', { channelId: CHANNEL, kind: 'dump' });
tick();
const dumpDelta = emitted.slice(dumpFrom).find((e) => e.event === 'miskolc:debris_chunk_update')?.payload ?? null;
const emptyPack = refusal(() => service.playerAction('fixture-socket', { channelId: CHANNEL, kind: 'dump' }));
service.dispose();

const fixture = {
  description: 'Real backend output of MiskolcSweepers Phase C (debris gen 1). Regenerate from the backend repo with the explicit path: node scripts/buildSweepersDebrisFixture.mjs <out.json>',
  tables: { itemKinds: ITEM_KINDS, tools: TOOLS, districtProfiles: DISTRICT_PROFILES, jackpots: JACKPOTS },
  initState: { personal: init.personal, debris: init.debris, players: init.players, hexes: init.hexes },
  events: {
    joinBurst,
    sweepAck,
    sweepDelta,
    personalAfterSweep,
    tickSyncWithTool,
    personalAfterBuy,
    buyAck,
    selectAck,
    kickDelta,
    handAck,
    dumpAck,
    dumpDelta
  },
  refusals: { tooFast, tooFar, notEquipped, notOwnedSelect, notAtWorkbench, notAtKiosk, notEnoughCash, emptyPack }
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes; join burst ${Buffer.byteLength(JSON.stringify(joinBurst))} bytes, ${joinBurst.load.length} chunks)`);
