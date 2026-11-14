// Writes a JSON fixture of real MiskolcSweepers Phase D output (bagging & logistics) for the frontend
// tests: the D.1 tables, the wire encodings, placement samples on the real layout (accepted, one per
// refusal code, with the full context each was judged in), init logistics, event samples, a 36-tick
// trace of a scripted network (hopper → belt5 → splitter → belts, via a merger and a packager), bag
// rows and a throw arc, and the acks and refusals of every D.4 event.
// Usage: node scripts/buildSweepersLogisticsFixture.mjs [outFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/core/logging/Logger.ts';
import { AppError } from '../src/core/errors/AppError.ts';
import { SweepersService } from '../src/modules/sweepers/SweepersService.ts';
import { cityLayout } from '../src/modules/sweepers/city/cityLayout.ts';
import { groundHeight } from '../src/modules/sweepers/geometry.ts';
import { hexAt } from '../src/modules/sweepers/hexGrid.ts';
import { KIND } from '../src/modules/sweepers/debris/tables.ts';
import { parseDeleteStructure, parseLogisticsAction, parsePlaceStructure, parseTieBag } from '../src/modules/sweepers/payloads.ts';
import { CRANE_LEGS, reservedRects } from '../src/modules/sweepers/logistics/placement.ts';
import { footprint, footprintSamples, worldPort } from '../src/modules/sweepers/logistics/shapes.ts';
import {
  BAG_TIERS, BELT_MPS, CAP_NAMES, CAPS, CARGO_PITCH_M, CRANE, LOT_GROUPS, STARTER_BAGS, STRUCT_TYPES, TINTS, TYPE, rotYOf,
  HOPPER_KG, HOPPER_BAG_QUEUE, HOPPER_EMIT_MS, PACKAGER_KG, PACKAGER_CYCLE_MS, PACKAGER_BAG_KG, PACKAGER_FLUSH_MS, JAM_MS, LOT_KG, WATTS_PER_M,
  LANDMARK_INTAKE_PAD_M, LANDMARK_INTAKE_TOP_M, HOPPER_INTAKE_TOP_M, TIE_CADENCE_MS, GRAVITY, THROW_STEP_S, THROW_MAX_STEPS, DROP_POWER, THROW_MAX_POWER,
  RUPTURE_SHARP_KG, RUPTURE_FALL_M, RUPTURE_CHANCE, STACK_MAX, STACK_SLIDE_M, FENCE_STOP_M, VALUE_FT_PER_KG
} from '../src/modules/sweepers/logistics/tables.ts';

const DEFAULT_OUT = path.join(os.tmpdir(), 'sweepers-d-logistics-fixture.json');
const CHANNEL = 'hang-chill';
const SOCKET = 'fixture-socket';
const out = path.resolve(process.argv[2] ?? DEFAULT_OUT);
const layout = cityLayout();
const ground = (x, z) => groundHeight(layout.heightfield, x, z);

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
  weather: record('miskolc:weather'),
  debrisUpdate: record('miskolc:debris_chunk_update'),
  personalUpdate: record('miskolc:personal_update'),
  structureSpawned: record('miskolc:structure_spawned'),
  logisticsUpdate: record('miskolc:logistics_update'),
  logisticsTelemetry: record('miskolc:logistics_telemetry')
};
const service = new SweepersService({
  store, events, clock, scheduler: () => () => undefined, logger: new Logger({ minLevel: 'error', sink: () => undefined })
});
const since = (from, event) => emitted.slice(from).filter((e) => e.event === event).map((e) => e.payload);
/** The ack a handler sends: the result, or `{ ok: false, error, code }` for a refusal / validation error. */
const ack = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
};
const tick = (ms = 84) => { clock.ms += ms; service.tick(); };

service.join(CHANNEL, SOCKET, { key: 'name:fixture', accountId: null, username: 'Fixture', avatarColor: '#7655F5' });
const init = emitted.find((e) => e.event === 'miskolc:init_state').payload;
const room = service.room(CHANNEL);
const player = [...room.players()][0];
const world = room.logistics;
const at = (x, z, rotY = 0) => { player.pose = { ...player.pose, x, y: ground(x, z), z, rotY }; };

// ---- placement samples (each with the context it was judged in) ----
const samples = [];
const context = () => ({
  pose: { x: player.pose.x, z: player.pose.z },
  unlocked: room.unlockedDistricts(),
  structures: [...world.structures.values()].sort((a, b) => a.id - b.id).map((s) => world.structRow(s)),
  groundBags: [...world.bags.values()].filter((b) => b.st === 0).map((b) => [Math.round(b.x * 100), Math.round(b.z * 100), BAG_TIERS[b.tier].r]),
  players: [...room.players()].map((p) => [Math.round(p.pose.x * 100), Math.round(p.pose.z * 100)])
});
const place = (name, request, pose) => {
  at(pose[0], pose[1]);
  const ctx = context();
  const payload = { channelId: CHANNEL, ...request };
  const result = ack(() => ({ ok: true, id: service.placeStructure(SOCKET, parsePlaceStructure(payload)) }));
  samples.push({ name, request, ...ctx, ack: result });
  return result;
};

const foundA = place('accepted: found4 on flat ground (top = ceil10(ground + 0.2))', { type: TYPE.found4, x: 0, z: -9, rot: 0, lvl: 0 }, [0, -4]);
place('accepted: found2 edge-adjacent to found4 (top snaps)', { type: TYPE.found2, x: 3, z: -10, rot: 0, lvl: 0 }, [0, -4]);
const beltOnFound = place('accepted: belt2 rot 1 on the found4 (base = its top)', { type: TYPE.belt2, x: 0, z: -9, rot: 1, lvl: 0 }, [0, -4]);
place('notFlat: belt1 partly on a foundation', { type: TYPE.belt1, x: 2, z: -7.5, rot: 1, lvl: 0 }, [0, -4]);
const ramp = place('accepted: rampUp on the ground', { type: TYPE.rampUp, x: 5, z: -6, rot: 0, lvl: 0 }, [0, -4]);
place('accepted: belt1 at lvl 2 on the ground', { type: TYPE.belt1, x: -3, z: -4, rot: 2, lvl: 2 }, [0, -4]);
place('blocked: overlaps another structure', { type: TYPE.belt1, x: 5, z: -6.5, rot: 0, lvl: 0 }, [0, -4]);
place('blocked: a layout collider (office container)', { type: TYPE.belt1, x: 15, z: -6.5, rot: 0, lvl: 0 }, [15, -10]);
place('blocked: a player stands in a blocking type (fence)', { type: TYPE.fence, x: 0, z: -2, rot: 0, lvl: 0 }, [0, -2]);
place('accepted: fence', { type: TYPE.fence, x: -3, z: -12, rot: 1, lvl: 0 }, [0, -4]);
place('tooFar: centre more than 10 m from the pose', { type: TYPE.belt1, x: -3, z: 9, rot: 0, lvl: 0 }, [0, -4]);
place('lockedDistrict: a sample beyond the centre hex', { type: TYPE.belt5, x: 32.5, z: 0, rot: 1, lvl: 0 }, [30, 0]);
place('reserved: the weighbridge pad + 1 m', { type: TYPE.belt1, x: 15, z: 0, rot: 0, lvl: 0 }, [12, 0]);
place('reserved: the crane working area', { type: TYPE.found2, x: -8, z: 0, rot: 0, lvl: 0 }, [-4, 0]);
place('reserved: within 1 m of the crane console', { type: TYPE.belt1, x: -3.5, z: -6, rot: 0, lvl: 0 }, [-2, -6]);
place('reserved: the landmark hopper footprint', { type: TYPE.belt1, x: 14, z: 12, rot: 0, lvl: 0 }, [14, 8]);
for (const [i, x] of [-3, 0, 3].entries()) place(`accepted: packager ${i + 1}`, { type: TYPE.packager, x, z: 9, rot: 0, lvl: 0 }, [0, 4]);
place('accepted: packager 4', { type: TYPE.packager, x: -3, z: 12, rot: 0, lvl: 0 }, [0, 4]);
place('buildLimit: a fifth packager', { type: TYPE.packager, x: 0, z: 12.5, rot: 0, lvl: 0 }, [0, 4]);
place('VALIDATION_ERROR: x not on the 0.5 m lattice', { type: TYPE.belt1, x: 0.25, z: -4, rot: 0, lvl: 0 }, [0, -4]);
place('VALIDATION_ERROR: lvl not valid for the type (rampDown at 0)', { type: TYPE.rampDown, x: 0, z: -4, rot: 0, lvl: 0 }, [0, -4]);

// tie_bag in a locked district (before the unlock below).
at(38, 0);
player.personal.pack = { dustG: 5_000, seedG: 0, cans: 0, crushed: 0, ironG: 0, copperG: 0, jackpots: [] };
const tieLocked = ack(() => service.tieBag(SOCKET, CHANNEL, 0));
player.personal.pack = { dustG: 0, seedG: 0, cans: 0, crushed: 0, ironG: 0, copperG: 0, jackpots: [] };

// Unlock every district (lifetime revenue), then the grid edge and the slopes.
service.addRevenue(CHANNEL, 1e12);
let edgeX = 200;
while (hexAt(edgeX + 0.5, 0)) edgeX += 0.5;
place('outOfGrid: a sample outside the 37 hexes', { type: TYPE.belt5, x: edgeX, z: 0, rot: 1, lvl: 0 }, [edgeX - 3, 0]);
/** First lattice point on the hill flank where `ok(spec)` holds for the placement result. */
const findSlope = (type, want) => {
  for (let r = 40; r <= 110; r += 2) {
    for (let a = 0; a < 360; a += 15) {
      const x = Math.round((139 + r * Math.cos((a * Math.PI) / 180)) * 2) / 2;
      const z = Math.round((-95 + r * Math.sin((a * Math.PI) / 180)) * 2) / 2;
      if (!hexAt(x, z)) continue;
      at(x, z + 3);
      const rect = footprint(type, x, z, 0);
      const g = footprintSamples(rect).map(([sx, sz]) => ground(sx, sz));
      const span = Math.max(...g) - Math.min(...g);
      if (!want(span)) continue;
      const res = ack(() => {
        const ok = service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type, x, z, rot: 0, lvl: 0 }));
        service.deleteStructure(SOCKET, CHANNEL, ok);
        return { ok: true };
      });
      if (res.ok || res.error.startsWith('Túl egyenetlen')) return { x, z, res };
    }
  }
  throw new Error('no slope found');
};
const steep = findSlope(TYPE.belt5, (span) => span > 0.35 && span < 0.75);
tick();
place('notFlat: ground max − min > 0.3 under a belt', { type: TYPE.belt5, x: steep.x, z: steep.z, rot: 0, lvl: 0 }, [steep.x, steep.z + 3]);
const slope = findSlope(TYPE.found4, (span) => span > 0.25 && span < 0.75);
tick();
place('accepted: found4 on a slope (top = ceil10(max ground + 0.2))', { type: TYPE.found4, x: slope.x, z: slope.z, rot: 0, lvl: 0 }, [slope.x, slope.z + 3]);
place('accepted: found4 edge-adjacent on the slope (snaps to the neighbour top within 0.5 m)', { type: TYPE.found4, x: slope.x + 4, z: slope.z, rot: 0, lvl: 0 }, [slope.x + 2, slope.z + 3]);
const cliff = findSlope(TYPE.found4, (span) => span > 0.85);
place('notFlat: found4 with ground max − min > 0.8', { type: TYPE.found4, x: cliff.x, z: cliff.z, rot: 0, lvl: 0 }, [cliff.x, cliff.z + 3]);

// ---- delete samples (rule 8) ----
at(0, -4);
const deletes = {
  unknownStructure: ack(() => { service.deleteStructure(SOCKET, CHANNEL, 0); return { ok: true }; }),
  supportsStructures: ack(() => { service.deleteStructure(SOCKET, CHANNEL, foundA.id); return { ok: true }; }),
  tooFar: (() => { at(0, 30); const r = ack(() => { service.deleteStructure(SOCKET, CHANNEL, ramp.id); return { ok: true }; }); at(0, -4); return r; })(),
  ok: ack(() => { service.deleteStructure(SOCKET, CHANNEL, beltOnFound.id); return { ok: true }; }),
  validation: ack(() => { parseDeleteStructure({ channelId: CHANNEL, id: -1 }); return { ok: true }; })
};


// ---- the scripted network: landmark hopper → bendR → belt5 → splitter; bulk straight into a
// packager (→ belt1 → open end), copper left via a merger (→ belt2 → open end), ferrous right (belt1 → open end) ----
// The placement samples' packagers would hit the packager cap: clear them first.
for (const st of [...world.structures.values()]) if (st.type === TYPE.packager) world.remove(st.id);
tick();
const spawnedFrom = emitted.length;
at(17, 6);
const net = {};
for (const [key, request] of [
  ['bend', { type: TYPE.bendR, x: 14, z: 9.5, rot: 0, lvl: 0 }],
  ['belt5', { type: TYPE.belt5, x: 17, z: 9.5, rot: 1, lvl: 0 }],
  ['splitter', { type: TYPE.splitter, x: 20, z: 9.5, rot: 1, lvl: 0 }],
  ['ferrousBelt', { type: TYPE.belt1, x: 20, z: 10.5, rot: 2, lvl: 0 }],
  ['packager', { type: TYPE.packager, x: 21.5, z: 9.5, rot: 1, lvl: 0 }],
  ['packagerOut', { type: TYPE.belt1, x: 23, z: 9.5, rot: 1, lvl: 0 }],
  ['copperBelt', { type: TYPE.belt1, x: 20, z: 8.5, rot: 0, lvl: 0 }],
  ['merger', { type: TYPE.merger, x: 20, z: 7.5, rot: 3, lvl: 0 }],
  ['mergerOut', { type: TYPE.belt2, x: 18.5, z: 7.5, rot: 3, lvl: 0 }]
]) {
  const res = ack(() => ({ ok: true, id: service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, ...request })) }));
  if (!res.ok) throw new Error(`network piece ${key}: ${res.error}`);
  net[key] = res.id;
}
const structureSpawned = since(spawnedFrom, 'miskolc:structure_spawned');
const load = (kg) => ({ dustG: kg.dust * 1000, seedG: 0, cans: 0, crushed: 0, ironG: kg.iron * 1000, copperG: kg.copper * 1000, jackpots: [] });
world.fillHopper(0, load({ dust: 45, iron: 25, copper: 25 }));
at(17, 4);
const traceFrom = emitted.length;
const ticks = [];
for (let i = 0; i < 180; i++) {
  tick();
  if (ticks.length < 36 && world.cargo.size > 0) {
    ticks.push({ t: clock.ms, rows: [...world.cargo.values()].filter((c) => c.node !== 0).sort((a, b) => a.id - b.id).map((c) => world.cargoRow(c)) });
  }
}
const traceUpdates = since(traceFrom, 'miskolc:logistics_update');
// One entry per cargo life (ids are reused after a `del`): the nodes it visited, in order.
const routes = [];
const live = new Map();
for (const u of traceUpdates) {
  for (const row of u.c ?? []) {
    let life = live.get(row[0]);
    if (life && life.kind !== row[1]) {
      routes.push(life);
      life = undefined;
    }
    if (!life) live.set(row[0], life = { id: row[0], kind: row[1], sub: row[2], nodes: [] });
    if (life.nodes.at(-1) !== row[4]) life.nodes.push(row[4]);
  }
  for (const id of u.del ?? []) {
    if (live.has(id)) routes.push(live.get(id));
    live.delete(id);
  }
}
routes.push(...live.values());
const viaPackager = routes.find((r) => r.kind === 1 && r.nodes.includes(net.packager) && r.nodes.includes(net.packagerOut));
const viaMerger = routes.find((r) => r.nodes.includes(net.merger));
if (!viaPackager || !viaMerger) throw new Error(`trace did not cover the packager and the merger: ${JSON.stringify(routes)}`);
const initPopulated = room.initState(player, service.tickRate, clock.ms).logistics;
const packagedBag = [...traceUpdates].flatMap((u) => u.b ?? []).find((b) => b[2] !== 0);
if (!packagedBag) throw new Error('no tinted packager bag reached the ground');

// ---- D.4 events: acks and refusals ----
const ACKS = {};
const REFUSALS = {};
const fresh = () => { clock.ms += 2_000; };
const pack = (kg) => { player.personal.pack = load(kg); };
const act = (action) => ack(() => service.logisticsAction(SOCKET, parseLogisticsAction({ channelId: CHANNEL, ...action })));
const tieBag = (tier) => ack(() => service.tieBag(SOCKET, CHANNEL, parseTieBag({ channelId: CHANNEL, tier }).tier));
const buyBag = (tier, qty) => ack(() => ({ ok: true, cash: service.buyUpgrade(SOCKET, { channelId: CHANNEL, item: 'bag', tier, qty }) }));

// tie_bag
at(4, 4, 0);
fresh();
player.personal.pack = load({ dust: 0, iron: 0, copper: 0 });
REFUSALS.tie_bag = { emptyPack: tieBag(0) };
pack({ dust: 25, iron: 0, copper: 0 });
const personalFrom = emitted.length;
ACKS.tie_bag = tieBag(0);
REFUSALS.tie_bag.tooFast = tieBag(0);
tick();
const personalUpdate = since(personalFrom, 'miskolc:personal_update').at(-1);
const tiedRow = world.bagRow(world.bags.get(ACKS.tie_bag.id));
fresh();
player.personal.bags[1] = 0;
REFUSALS.tie_bag.noBags = tieBag(1);
player.personal.bags[1] = 2;
player.personal.pack = { ...load({ dust: 0, iron: 0, copper: 0 }), jackpots: [KIND.lenin] };
REFUSALS.tie_bag.bagTooSmall = tieBag(0);
REFUSALS.tie_bag.lockedDistrict = tieLocked;
REFUSALS.tie_bag.validation = ack(() => parseTieBag({ channelId: CHANNEL, tier: 3 }));

// pickup + throw (ground, belt, hopper, drop), handsFull, notCarrying, noBagNear, bigBagCrane
at(4, 4, 0);
REFUSALS.pickup = { noBagNear: (() => { at(4, 9); const r = act({ kind: 'pickup', id: ACKS.tie_bag.id }); at(4, 4, 0); return r; })() };
ACKS.pickup = act({ kind: 'pickup', id: ACKS.tie_bag.id });
REFUSALS.pickup.handsFull = act({ kind: 'pickup', id: ACKS.tie_bag.id });
REFUSALS.tie_bag.handsFull = tieBag(0);
let seq = 1_000;
REFUSALS.sweep_hit = { handsFull: ack(() => service.sweepHit(SOCKET, { channelId: CHANNEL, seq: seq++, tool: 0, alt: false, x: 4, z: 4, rotY: 0 })) };
tick();
const carryTick = since(emitted.length - 40, 'miskolc:tick_sync').at(-1);
const throwFrom = emitted.length;
ACKS.throw = { ground: act({ kind: 'throw', power: 6, pitch: 0.5, rotY: 0 }) };
tick();
const throwUpdate = since(throwFrom, 'miskolc:logistics_update').at(-1);
REFUSALS.throw = { notCarrying: act({ kind: 'throw', power: 6, pitch: 0.5, rotY: 0 }) };
REFUSALS.throw.validation = ack(() => parseLogisticsAction({ channelId: CHANNEL, kind: 'throw', power: 13, pitch: 0, rotY: 0 }));
const thrownId = ACKS.throw.ground.id;
const thrown = world.bags.get(thrownId);
at(thrown.x, thrown.z + 1, 0);
act({ kind: 'pickup', id: thrownId });
at(19, 11.5, 0);
ACKS.throw.belt = act({ kind: 'throw', power: 3, pitch: 0, rotY: 0 });
if (ACKS.throw.belt.into !== 'belt') throw new Error(`belt throw landed in ${ACKS.throw.belt.into}`);
tick();
at(world.bagPosition(thrown).x, world.bagPosition(thrown).z + 0.5, 0);
act({ kind: 'pickup', id: thrownId });
at(14, 17, 0);
ACKS.throw.hopper = act({ kind: 'throw', power: 4, pitch: 0.4, rotY: 0 });
pack({ dust: 5, iron: 0, copper: 0 });
fresh();
at(4, 4, 0);
const dropped = tieBag(0);
act({ kind: 'pickup', id: dropped.id });
ACKS.throw.drop = act({ kind: 'throw', power: 0.5, pitch: 0, rotY: 0 });
at(-6, 0, 0);
pack({ dust: 30, iron: 0, copper: 0 });
fresh();
const bigBag = tieBag(2);
REFUSALS.pickup.bigBagCrane = act({ kind: 'pickup', id: bigBag.id });

// crane
REFUSALS.crane = { notAtCrane: act({ kind: 'crane', bag: bigBag.id, to: 1 }) };
at(CRANE.console.x, CRANE.console.z + 0.5, 0);
REFUSALS.crane.notInCraneArea = act({ kind: 'crane', bag: dropped.id, to: 1 });
const craneFrom = emitted.length;
ACKS.crane = act({ kind: 'crane', bag: bigBag.id, to: 1 });
REFUSALS.crane.craneBusy = act({ kind: 'crane', bag: bigBag.id, to: 2 });
tick();
const craneUpdate = since(craneFrom, 'miskolc:logistics_update').at(-1);
for (let i = 0; i < 300 && world.craneJob; i++) tick();
const craneDone = since(craneFrom, 'miskolc:logistics_update').find((u) => u.crane === null) ?? null;
REFUSALS.crane.craneTargetBusy = act({ kind: 'crane', bag: bigBag.id, to: 1 });

// dump into the hopper, hopperFull, the jam and clearJam
at(14, 9, 0);
pack({ dust: 10, iron: 0, copper: 0 });
ACKS.dump = ack(() => ({ ok: true, hopperKg: service.playerAction(SOCKET, { channelId: CHANNEL, kind: 'dump' }) }));
service.deleteStructure(SOCKET, CHANNEL, net.bend);
world.fillHopper(0, load({ dust: 2_000, iron: 0, copper: 0 }));
pack({ dust: 10, iron: 0, copper: 0 });
REFUSALS.dump = { hopperFull: ack(() => ({ ok: true, hopperKg: service.playerAction(SOCKET, { channelId: CHANNEL, kind: 'dump' }) })) };
at(11, 6, 0);
const feed = service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type: TYPE.belt1, x: 11, z: 8, rot: 2, lvl: 0 }));
const jamSplitter = service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type: TYPE.splitter, x: 11, z: 9, rot: 2, lvl: 0 }));
REFUSALS.clearJam = { notJammed: act({ kind: 'clearJam', id: jamSplitter }) };
world.restoreCargo({ id: 4_000, kind: 0, sub: 0, tint: 1, node: feed, s: 0, route: 0, waitMs: 0, load: load({ dust: 20, iron: 0, copper: 0 }) });
for (let i = 0; i < 140 && !world.isJammed(jamSplitter); i++) tick();
if (!world.isJammed(jamSplitter)) throw new Error('the splitter did not jam');
const jamUpdate = since(emitted.length - 6, 'miskolc:logistics_update').at(-1);
player.personal.toolTier = 4;
REFUSALS.clearJam.needBroom = act({ kind: 'clearJam', id: jamSplitter });
player.personal.toolTier = 0;
at(11, 3, 0);
REFUSALS.clearJam.tooFar = act({ kind: 'clearJam', id: jamSplitter });
at(11, 7, 0);
ACKS.clearJam = act({ kind: 'clearJam', id: jamSplitter });

// telemetry (1 Hz push while subscribed)
const office = layout.landmarks.office;
at(office.x, office.z + 12, 0);
REFUSALS.telemetry = { notAtTerminal: act({ kind: 'telemetry', on: true }) };
at(office.x, office.z + 3, 0);
const telemetryFrom = emitted.length;
ACKS.telemetry = { on: act({ kind: 'telemetry', on: true }) };
for (let i = 0; i < 13; i++) tick();
const telemetry = since(telemetryFrom, 'miskolc:logistics_telemetry');
ACKS.telemetry.off = act({ kind: 'telemetry', on: false });

// buy_upgrade bag
at(layout.landmarks.office.x, layout.landmarks.office.z + 3, 0);
player.personal.cash = 10_000;
ACKS.buy_bag = buyBag(0, 5);
player.personal.bags[0] = 99;
REFUSALS.buy_bag = { bagStockFull: buyBag(0, 1) };

// tooManyBags at the room cap
player.personal.bags[0] = 5;
for (let i = 0; world.bags.size < CAPS.bags; i++) world.restoreGroundBag({ id: 10_000 + i, tier: 0, tint: 0, x: -40 + (i % 20), z: 20 + Math.floor(i / 20), rot8: 0, load: load({ dust: 1, iron: 0, copper: 0 }) });
at(4, 4, 0);
pack({ dust: 5, iron: 0, copper: 0 });
fresh();
REFUSALS.tie_bag.tooManyBags = tieBag(0);

const logisticsEvents = {
  structureSpawned,
  logisticsUpdate: { throw: throwUpdate, crane: craneUpdate, craneDone, jam: jamUpdate },
  logisticsTelemetry: telemetry[0] ?? null,
  personalUpdate,
  tickSyncCarry: carryTick
};

const fixture = {
  description: 'Real backend output of MiskolcSweepers Phase D (bagging & logistics). Regenerate from the backend repo with the explicit path: node scripts/buildSweepersLogisticsFixture.mjs <out.json>',
  tables: {
    bagTiers: BAG_TIERS,
    tints: TINTS,
    starterBags: STARTER_BAGS,
    lotGroups: LOT_GROUPS,
    structTypes: STRUCT_TYPES.map((t, i) => ({ ...t, index: i, rotY: [0, 1, 2, 3].map(rotYOf) })),
    rotY: [0, 1, 2, 3].map(rotYOf),
    caps: CAPS,
    capNames: CAP_NAMES,
    crane: { ...CRANE, legs: CRANE_LEGS },
    reserved: { rects: reservedRects(layout), console: { ...CRANE.console, r: 1 } },
    constants: {
      beltMps: BELT_MPS, cargoPitchM: CARGO_PITCH_M, lotKg: LOT_KG, hopperKg: HOPPER_KG, hopperBagQueue: HOPPER_BAG_QUEUE, hopperEmitMs: HOPPER_EMIT_MS,
      packagerKg: PACKAGER_KG, packagerCycleMs: PACKAGER_CYCLE_MS, packagerBagKg: PACKAGER_BAG_KG, packagerFlushMs: PACKAGER_FLUSH_MS, jamMs: JAM_MS,
      wattsPerM: WATTS_PER_M, landmarkIntakePadM: LANDMARK_INTAKE_PAD_M, landmarkIntakeTopM: LANDMARK_INTAKE_TOP_M, hopperIntakeTopM: HOPPER_INTAKE_TOP_M,
      tieCadenceMs: TIE_CADENCE_MS, gravity: GRAVITY, throwStepS: THROW_STEP_S, throwMaxSteps: THROW_MAX_STEPS, dropPower: DROP_POWER,
      throwMaxPower: THROW_MAX_POWER, ruptureSharpKg: RUPTURE_SHARP_KG, ruptureFallM: RUPTURE_FALL_M, ruptureChance: RUPTURE_CHANCE, stackMax: STACK_MAX,
      stackSlideM: STACK_SLIDE_M, fenceStopM: FENCE_STOP_M, valueFtPerKg: VALUE_FT_PER_KG
    },
    landmarkHopper: { node: 0, ...layout.landmarks.hopper, out: worldPort({ x: layout.landmarks.hopper.x, z: layout.landmarks.hopper.z, rot: 0, lvl: 0, base: ground(14, 10) }, { x: 0, z: -2, hx: 0, hz: -1, dl: 0 }) }
  },
  encodings: {
    StructRow: '[id, type, xCm, zCm, baseYCm, rot, lvl, flags] — flags bit 0 jammed, bit 1 packager busy; a foundation\'s baseYCm is its top',
    BagRow: '[id, tier, tint, st, xCm, yCm, zCm, rot8, kgDg] — st 0 ground (y = bottom), 1 carried (xyz 0), 2 crane (xyz = job target)',
    CargoRow: '[id, kind (0 lot, 1 bag), sub (lot group | bag tier), tint, node, sMm, route (0 straight, 1 left, 2 right), mv, kgDg]',
    ArcRow: '[id, fxCm, fyCm, fzCm, txCm, tyCm, tzCm, apexYCm, durMs]',
    BurstRow: '[id, xCm, zCm]',
    FillRow: '[nodeId, kgDg]',
    CraneJob: '{ bag, fx, fz, tx, tz, t0, durMs } (cm, server ms)',
    PlayerTickRow: '[id, xCm, yCm, zCm, rot16, stateIdx, corr, tool, carry]',
    footprintSamples: 'D.3 rules 3 and 7 sample x in [minX + 0.01, every k·0.5 strictly inside, maxX − 0.01] (same for z), z-major then x ascending; rule 3 stops at the first failing sample'
  },
  placement: { samples, deletes },
  initState: { atJoin: init.logistics, afterTrace: initPopulated },
  network: { pieces: net, structures: [...world.structures.values()].sort((a, b) => a.id - b.id).map((st) => world.structRow(st)) },
  trace: { note: 'ticks: the first 36 consecutive 84 ms ticks with cargo (every CargoRow on a node); updates: every logistics_update of the 180-tick run; routes: one entry per cargo life { id, kind, sub, nodes } (ids are reused after a del)', ticks, updates: traceUpdates, routes },
  bags: { tinted: packagedBag, tied: tiedRow, arc: throwUpdate?.arcs?.[0] ?? null },
  events: logisticsEvents,
  acks: ACKS,
  refusals: REFUSALS
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`);
service.dispose();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes; ${samples.length} placement samples)`);
for (const s of samples) console.log(s.ack.ok ? 'ok ' : `${s.ack.code} ${s.ack.error}`, '|', s.name);
console.log(JSON.stringify(deletes));
