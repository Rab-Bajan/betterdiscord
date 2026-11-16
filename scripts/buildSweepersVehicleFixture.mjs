// Writes a JSON fixture of real MiskolcSweepers Phase F output (vehicles) for the frontend tests: the F.1
// tables, the F.3 encodings, init_state.vehicles, vehicle_update samples (every flag, horn, hit), the acks
// and refusals of every F.4 case, a 24-tick drive trace, a vehicle weighing, tips into the hopper and onto
// the ground, a garage refuel trace and a persistence blob.
// Usage: node scripts/buildSweepersVehicleFixture.mjs [outFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALIGN_MAX, BED_BAGS, BED_REACH_M, bedLocal, CURB_COOLDOWN_MS, CURB_MPS, endOffsets, ENTER_REACH_EXTRA_M, EXIT_SIDE_M, fillerLocal, FUELS, GARAGE,
  HORN_COOLDOWN_MS, IDLE_STOP_MS, JERRYCAN, PUNCT_SPEED, PUNCTURE_CHANCE, REPAIR_FT, spawnSlot, STOPPED_MPS, TIP_MS, VEHICLE_CAP, VEHICLE_TYPES, VFLAG
} from '../src/modules/sweepers/vehicles/tables.ts';
import { BALA, CAP_NAMES, CAPS, LANDMARK_HOPPER, STRUCT_TYPES, TYPE } from '../src/modules/sweepers/logistics/tables.ts';
import { cityLayout } from '../src/modules/sweepers/city/cityLayout.ts';
import { Logger } from '../src/core/logging/Logger.ts';
import { AppError } from '../src/core/errors/AppError.ts';
import { SweepersService } from '../src/modules/sweepers/SweepersService.ts';
import { emptyLoad, loadKg } from '../src/modules/sweepers/debris/personal.ts';
import { parseBuyUpgrade, parsePlaceStructure, parseVehicleAction, parseVehicleDrive, parseVehicleEnter } from '../src/modules/sweepers/payloads.ts';
import { encodeVehicles } from '../src/modules/sweepers/vehicles/persist.ts';

const DEFAULT_OUT = path.join(os.tmpdir(), 'sweepers-f-vehicle-fixture.json');
const out = path.resolve(process.argv[2] ?? DEFAULT_OUT);

const tables = {
  vehicleTypes: VEHICLE_TYPES.map((t, type) => ({
    type, ...t, topMps: t.topKmh / 3.6, bed: bedLocal(type), filler: fillerLocal(type), ends: endOffsets(type), slot: spawnSlot(type)
  })),
  fuels: FUELS,
  shop: {
    vehicle: VEHICLE_TYPES.map((t, tier) => ({ item: 'vehicle', tier, ft: t.priceFt, name: t.name })),
    jerrycan: FUELS.map((fuel, tier) => ({ item: 'jerrycan', tier, fuel, ft: JERRYCAN.ft, l: JERRYCAN.l, name: JERRYCAN.name }))
  },
  garage: { type: TYPE.garage, ...STRUCT_TYPES[TYPE.garage], cap: CAPS.garages, capName: CAP_NAMES.garages, ...GARAGE },
  constants: {
    vehicleCap: VEHICLE_CAP, enterReachExtraM: ENTER_REACH_EXTRA_M, bedReachM: BED_REACH_M, stoppedMps: STOPPED_MPS, tipMs: TIP_MS, bedBags: BED_BAGS,
    curbMps: CURB_MPS, punctureChance: PUNCTURE_CHANCE, alignMax: ALIGN_MAX, curbCooldownMs: CURB_COOLDOWN_MS, punctSpeed: PUNCT_SPEED,
    hornCooldownMs: HORN_COOLDOWN_MS, idleStopMs: IDLE_STOP_MS, exitSideM: EXIT_SIDE_M, repairFt: REPAIR_FT
  },
  flags: VFLAG
};

const encodings = {
  VehicleRow: '[id, type, xCm, zCm, rot16, vCmS, fuelDl, flags, bedKgDg, bags, s0, s1, s2] — seats: short player id or 0 (unused seats 0)',
  flags: 'bits 0–1 lights (0 off, 1 low, 2 high), 2 beacon, 3 tipping, 4 punctured, 5 stalled, 6 corr (the driver snaps), 7 in a garage, 8–10 align (0..4)',
  HitRow: '[vehicleId, kind] — kind 0 curb hit (align +1), 1 curb hit that punctured a tyre',
  vehicleUpdate: '{ t, v?: VehicleRow[] (changed rows only), del?: id[], horn?: id[], hit?: HitRow[] }',
  local: 'local (x, z): forward = −z; world offset = (x·cos rotY + z·sin rotY, −x·sin rotY + z·cos rotY); seat y above the ground at the centre',
  bed: 'bed point local (0, +L/2 + 0.3) (wheelbarrow (0, −L/2 − 0.3)); filler neck (−W/2 − 0.3, +L/4); end circles (0, ±(L/2 − r)) with radius r',
  vehiclesBlob: 'state_json.vehicles = { v: 1, list: [id, type, xCm, zCm, rot16, fuelDl, align, punct 0|1, lights, beacon 0|1, LoadC, [tier, tint, LoadC][]][] }'
};

// ---- a real service ----
const layout = cityLayout();
const CHANNEL = 'hang-chill';
const SOCKET = 'fixture-socket';
const SOCKET2 = 'fixture-socket-2';
const clock = { ms: 1_750_000_000_000, now() { return this.ms; } };
const store = {
  loadRoom: () => null, loadPlayerStats: () => null, loadStructures: () => [], saveRoom: () => undefined, savePlayerStats: () => undefined
};
const emitted = [];
const record = (event) => (...args) => { emitted.push({ event, payload: args.find((a) => typeof a === 'object' && a !== null) }); };
const noop = () => undefined;
const events = {
  initState: record('miskolc:init_state'), tickSync: record('miskolc:tick_sync'), playerJoined: noop, playerLeft: noop, sessionUpdated: noop, kicked: noop,
  districtUnlocked: noop, clock: noop, clockTo: noop, weather: noop, debrisUpdate: noop, personalUpdate: record('miskolc:personal_update'),
  structureSpawned: record('miskolc:structure_spawned'), logisticsUpdate: record('miskolc:logistics_update'), logisticsTelemetry: noop,
  scaleWeighed: record('miskolc:scale_weighed'), inspection: noop, economy: record('miskolc:economy'), vehicleUpdate: record('miskolc:vehicle_update')
};
const service = new SweepersService({ store, events, clock, scheduler: () => () => undefined, logger: new Logger({ minLevel: 'error', sink: () => undefined }) });
const since = (from, event) => emitted.slice(from).filter((e) => e.event === event).map((e) => e.payload);
const ack = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AppError) return { ok: false, error: err.message, code: err.code };
    throw err;
  }
};
const tick = (ms = 84) => { clock.ms += ms; service.tick(); };
const load = (kg) => ({ ...emptyLoad(), dustG: (kg.dust ?? 0) * 1000, ironG: (kg.iron ?? 0) * 1000, copperG: (kg.copper ?? 0) * 1000 });

service.join(CHANNEL, SOCKET, { key: 'name:fixture', accountId: null, username: 'Fixture', avatarColor: '#7655F5' });
service.join(CHANNEL, SOCKET2, { key: 'name:second', accountId: null, username: 'Second', avatarColor: '#55F576' });
const room = service.room(CHANNEL);
const player = room.bySocket(SOCKET);
const second = room.bySocket(SOCKET2);
room.vehicleChance = () => true;
const office = layout.landmarks.office;
const wb = layout.landmarks.weighbridge;
const EAST = -Math.PI / 2;
const NORTH = 0;
const at = (p, x, z, rotY = 0) => { p.pose = { ...p.pose, x, y: 0, z, rotY }; };
const park = (v, x, z, rotY) => { v.x = x; v.z = z; v.rotY = ((rotY % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); };
const ACKS = {};
const REFUSALS = {};
const buy = (request, socket = SOCKET) => ack(() => ({ ok: true, ...service.buyUpgrade(socket, parseBuyUpgrade({ channelId: CHANNEL, ...request })) }));
const enter = (id, seat, socket = SOCKET) => ack(() => ({ ok: true, seat: service.vehicleEnter(socket, parseVehicleEnter({ channelId: CHANNEL, id, seat })) }));
const vact = (body, socket = SOCKET) => ack(() => service.vehicleAction(socket, parseVehicleAction({ channelId: CHANNEL, ...body })));
let dseq = 0;
const drive = (x, z, rotY, socket = SOCKET) => ack(() => { service.vehicleDrive(socket, parseVehicleDrive({ channelId: CHANNEL, seq: ++dseq, x, y: 0, z, rotY })); return { ok: true }; });
const veh = (type) => [...room.vehicles.vehicles.values()].find((v) => v.type === type);

// ---- buy_upgrade (F.4) ----
at(player, 0, 0);
REFUSALS.buy_upgrade = { notAtWorkbench: buy({ item: 'vehicle', tier: 2 }) };
at(player, office.x, office.z + 3);
REFUSALS.buy_upgrade.notEnoughTeamFunds = buy({ item: 'vehicle', tier: 2 });
room.teamFunds = 5_000_000;
const buyFrom = emitted.length;
ACKS.buy_upgrade = { vehicle: buy({ item: 'vehicle', tier: 2 }) };
tick();
const boughtUpdate = since(buyFrom, 'miskolc:vehicle_update')[0] ?? null;
REFUSALS.buy_upgrade.alreadyOwned = buy({ item: 'vehicle', tier: 2 });
for (const tier of [0, 3, 4, 5]) buy({ item: 'vehicle', tier });
const jerryFrom = emitted.length;
ACKS.buy_upgrade.jerrycan = buy({ item: 'jerrycan', tier: 0 });
tick();
const jerryPersonal = since(jerryFrom, 'miskolc:personal_update').at(-1) ?? null;
REFUSALS.buy_upgrade.handsFull = buy({ item: 'jerrycan', tier: 1 });
player.personal.jerry = 0;
const simson = veh(2);
const lada = veh(3);
const cart = veh(0);
const ifa = veh(5);
tick();
const initVehicles = ack(() => room.initState(player, 12, clock.ms).vehicles);

// ---- vehicle_enter ----
REFUSALS.vehicle_enter = { unknownVehicle: enter(99, 0), validationSeat: enter(simson.id, 1) };
at(player, simson.x, simson.z + 3);
REFUSALS.vehicle_enter.tooFar = enter(simson.id, 0);
at(player, simson.x, simson.z + 1);
player.carry = 0;
player.personal.jerry = 2;
REFUSALS.vehicle_enter.handsFull = enter(simson.id, 0);
player.personal.jerry = 0;
simson.v = 1;
REFUSALS.vehicle_enter.vehicleMoving = enter(simson.id, 0);
simson.v = 0;
ACKS.vehicle_enter = { driver: enter(simson.id, 0) };
REFUSALS.vehicle_enter.alreadySeated = enter(lada.id, 0);
at(second, simson.x, simson.z + 1);
REFUSALS.vehicle_enter.seatTaken = enter(simson.id, 0, SOCKET2);
at(second, lada.x, lada.z + 1);
ACKS.vehicle_enter.passenger = enter(lada.id, 1, SOCKET2);
REFUSALS.vehicle_drive = { notDriver: drive(lada.x, lada.z, EAST, SOCKET2) };
REFUSALS.vehicle_action = { notDriver: vact({ kind: 'tip' }, SOCKET2) };
REFUSALS.sweep_hit = { driving: ack(() => service.sweepHit(SOCKET, { channelId: CHANNEL, seq: 1, tool: 0, alt: false, x: player.pose.x, z: player.pose.z, rotY: 0 })) };
ACKS.vehicle_action = { exitPassenger: vact({ kind: 'exit' }, SOCKET2) };
REFUSALS.vehicle_action.notSeated = vact({ kind: 'exit' }, SOCKET2);

// ---- lights, beacon, horn ----
const lampFrom = emitted.length;
ACKS.vehicle_action.lights = vact({ kind: 'lights', mode: 2 });
REFUSALS.vehicle_action.noBeacon = vact({ kind: 'beacon', on: true });
REFUSALS.vehicle_action.noHorn = vact({ kind: 'horn' });
REFUSALS.vehicle_action.bedEmpty = vact({ kind: 'tip' });
tick();
const lightsUpdate = since(lampFrom, 'miskolc:vehicle_update').at(-1) ?? null;
vact({ kind: 'exit' });
at(player, cart.x, cart.z + 1);
enter(cart.id, 0);
REFUSALS.vehicle_action.noLights = vact({ kind: 'lights', mode: 1 });
vact({ kind: 'exit' });
at(player, ifa.x, ifa.z + 1);
enter(ifa.id, 0);
const hornFrom = emitted.length;
ACKS.vehicle_action.beacon = vact({ kind: 'beacon', on: true });
ACKS.vehicle_action.horn = vact({ kind: 'horn' });
REFUSALS.vehicle_action.tooFastHorn = vact({ kind: 'horn' });
tick();
const hornUpdate = since(hornFrom, 'miskolc:vehicle_update').at(-1) ?? null;
ACKS.vehicle_action.exit = vact({ kind: 'exit' });

// ---- bed: dump, load ----
// Simson at its slot heading +x: bed point (−1.6, −10), filler neck (−0.65, −10.9).
at(player, -1.6, -9);
player.personal.pack = load({ copper: 3 });
ACKS.player_action = { dumpIntoBed: ack(() => ({ ok: true, ...service.playerAction(SOCKET, { channelId: CHANNEL, kind: 'dump' }) })) };
REFUSALS.vehicle_action.notCarrying = vact({ kind: 'load', id: simson.id });
const bagTie = (() => { at(player, 20, -14); clock.ms += 2_000; player.personal.pack = load({ dust: 10 }); return service.tieBag(SOCKET, CHANNEL, 0); })();
service.logisticsAction(SOCKET, { channelId: CHANNEL, kind: 'pickup', id: bagTie.id });
REFUSALS.vehicle_action.tooFar = vact({ kind: 'load', id: simson.id });
at(player, -1.6, -9);
ACKS.vehicle_action.load = vact({ kind: 'load', id: simson.id });
REFUSALS.vehicle_action.unknownVehicle = vact({ kind: 'load', id: 99 });
simson.bags.push(...Array.from({ length: 11 }, () => ({ tier: 0, tint: 0, load: load({ dust: 1 }) })));
const bag2 = (() => { at(player, 20, -14); clock.ms += 2_000; player.personal.pack = load({ dust: 2 }); return service.tieBag(SOCKET, CHANNEL, 0); })();
service.logisticsAction(SOCKET, { channelId: CHANNEL, kind: 'pickup', id: bag2.id });
at(player, -1.6, -9);
REFUSALS.vehicle_action.bedFull = vact({ kind: 'load', id: simson.id });
service.logisticsAction(SOCKET, { channelId: CHANNEL, kind: 'throw', power: 0, pitch: 0, rotY: 0 });
simson.bags.splice(1);

// ---- refuel, repair ----
at(player, -0.65, -10.9);
REFUSALS.vehicle_action.noJerryCan = vact({ kind: 'refuel', id: simson.id });
player.personal.jerry = 2;
REFUSALS.vehicle_action.wrongFuel = vact({ kind: 'refuel', id: simson.id });
player.personal.jerry = 1;
simson.fuelL = 1.5;
ACKS.vehicle_action.refuel = vact({ kind: 'refuel', id: simson.id });
player.personal.jerry = 1;
at(player, cart.x - 1, cart.z - 0.7);
REFUSALS.vehicle_action.noFuelTank = vact({ kind: 'refuel', id: cart.id });
player.personal.jerry = 0;
at(player, simson.x, simson.z + 1);
REFUSALS.vehicle_action.nothingToRepair = vact({ kind: 'repair', id: simson.id });

// ---- a 24-tick drive trace (84 ms ticks, one vehicle_drive per tick) ----
enter(simson.id, 0);
const trace = [];
const traceFrom = emitted.length;
const step = (phase, x, z, rotY) => {
  clock.ms += 84;
  const before = [simson.x, simson.z];
  const sent = [Math.round(x * 100), Math.round(z * 100)];
  drive(x, z, rotY);
  const from = emitted.length;
  service.tick();
  const update = since(from, 'miskolc:vehicle_update')[0] ?? null;
  trace.push({ phase, sent, from: before.map((m) => Math.round(m * 100)), row: update?.v?.find((r) => r[0] === simson.id) ?? null, update });
};
park(simson, 0, -10, Math.PI / 2);
clock.ms += 1_000;
for (let i = 1; i <= 5; i++) step('accepted', -0.672 * i, -10, Math.PI / 2);
simson.budget = { metres: 0, vertical: 1, at: clock.ms };
for (let i = 0; i < 2; i++) step('overSpeed', simson.x - 2.5, -10, Math.PI / 2);
park(simson, 13, -8.5, EAST);
for (let i = 0; i < 4; i++) step('wallSlide', simson.x + 0.6, simson.z + 0.3, EAST);
park(simson, 30, -2.6, NORTH);
step('curbApproach', 30, -2.6, NORTH);
step('curbHit', 30, -3.44, NORTH);
step('curbAfter', 30, -4.2, NORTH);
park(simson, 0, -14, Math.PI / 2);
simson.fuelL = 0.0004;
step('stallLastFuel', -0.6, -14, Math.PI / 2);
for (let i = 0; i < 3; i++) step('stalled', simson.x - 0.6, -14, Math.PI / 2);
for (let i = trace.length; i < 24; i++) {
  clock.ms += 84;
  const from = emitted.length;
  service.tick();
  const update = since(from, 'miskolc:vehicle_update')[0] ?? null;
  trace.push({ phase: 'idle', sent: null, from: null, row: update?.v?.find((r) => r[0] === simson.id) ?? null, update });
}
const hitUpdate = since(traceFrom, 'miskolc:vehicle_update').find((u) => u.hit) ?? null;
simson.fuelL = 5;

// ---- repair (after the curb) ----
vact({ kind: 'exit' });
at(player, simson.x, simson.z + 1);
room.teamFunds = 2_000;
REFUSALS.vehicle_action.notEnoughTeamFunds = vact({ kind: 'repair', id: simson.id });
room.teamFunds = 5_000_000;
simson.v = 1;
REFUSALS.vehicle_action.vehicleMoving = vact({ kind: 'repair', id: simson.id });
simson.v = 0;
ACKS.vehicle_action.repair = vact({ kind: 'repair', id: simson.id });

// ---- tip into the landmark hopper, then onto the ground ----
enter(simson.id, 0);
park(simson, 14, 7.5, NORTH);
simson.load = load({ dust: 30, iron: 5 });
simson.bags = [{ tier: 0, tint: 1, load: load({ dust: 8 }) }];
const tipFrom = emitted.length;
ACKS.vehicle_action.tipHopper = vact({ kind: 'tip' });
REFUSALS.vehicle_action.tooFastTip = (simson.load = load({ dust: 1 }), vact({ kind: 'tip' }));
tick();
const tipHopper = {
  ack: ACKS.vehicle_action.tipHopper, hopperKg: loadKg(room.logistics.bufferOf(LANDMARK_HOPPER) ?? emptyLoad()),
  vehicleUpdate: since(tipFrom, 'miskolc:vehicle_update').at(-1) ?? null, logisticsUpdate: since(tipFrom, 'miskolc:logistics_update').at(-1) ?? null
};
clock.ms += 3_000;
park(simson, 0, -10, EAST);
simson.load = load({ dust: 12, copper: 1 });
simson.bags = [{ tier: 1, tint: 0, load: load({ iron: 20 }) }];
const groundFrom = emitted.length;
ACKS.vehicle_action.tipGround = vact({ kind: 'tip' });
tick();
const tipGround = { ack: ACKS.vehicle_action.tipGround, logisticsUpdate: since(groundFrom, 'miskolc:logistics_update').at(-1) ?? null };
simson.v = 1;
REFUSALS.vehicle_action.vehicleMoving = vact({ kind: 'tip' });
simson.v = 0;

// ---- a vehicle weighing: bed load + a bala bag ----
clock.ms += 3_000;
park(simson, wb.x, wb.z, EAST);
simson.load = load({ copper: 2, dust: 5 });
simson.bags = [{ tier: BALA, tint: 2, load: load({ iron: 50 }) }];
drive(wb.x, wb.z, EAST);
const weighFrom = emitted.length;
for (let i = 0; i < 26; i++) tick();
const scaleWeighed = {
  payload: since(weighFrom, 'miskolc:scale_weighed')[0] ?? null,
  vehicleUpdate: since(weighFrom, 'miskolc:vehicle_update').find((u) => (u.v ?? []).some((r) => r[0] === simson.id && r[8] === 0)) ?? null,
  economy: since(weighFrom, 'miskolc:economy').find((u) => u.funds !== undefined) ?? null
};
vact({ kind: 'exit' });

// ---- garage: placed by D.3, refuels a stopped motor vehicle 2 L/s ----
at(player, -10, -8);
ACKS.place_structure = { garage: ack(() => ({ ok: true, id: service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type: TYPE.garage, x: -10, z: -14, rot: 1, lvl: 0 })) })) };
const garageSpawned = since(0, 'miskolc:structure_spawned').at(-1) ?? null;
park(lada, -10, -14, EAST);
lada.fuelL = 15;
room.teamFunds = 2_000;
const garage = [];
for (let i = 0; i < 4; i++) {
  const from = emitted.length;
  tick(1_000);
  garage.push({ fuelDl: Math.round(lada.fuelL * 10), teamFunds: room.teamFunds, row: room.vehicles.row(lada, clock.ms), vehicleUpdate: since(from, 'miskolc:vehicle_update')[0] ?? null });
}

// ---- review fixes: exit blocked on both sides, a built-over slot ----
room.teamFunds = 5_000_000;
at(player, -2, -21);
service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type: TYPE.fence, x: -2, z: -20.5, rot: 0, lvl: 0 }));
// Fences at both ends too: driver side, passenger side, rear and front are all blocked.
at(player, -2, -22);
for (const x of [-3.5, -0.5]) service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type: TYPE.fence, x, z: -19.5, rot: 1, lvl: 0 }));
tick();
park(cart, -2, -19.2, EAST);
at(player, -2, -19.6);
enter(cart.id, 0);
REFUSALS.vehicle_action.exitBlocked = vact({ kind: 'exit' });
room.vehicles.unseat(player);
at(player, -4, -6);
service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type: TYPE.fence, x: -4, z: -10, rot: 0, lvl: 0 }));
tick();
at(player, office.x, office.z + 3);
REFUSALS.buy_upgrade.slotBlocked = buy({ item: 'vehicle', tier: 1 });

// ---- persistence ----
const persistence = encodeVehicles(room.vehicles);

const fixture = {
  description: 'Real backend output of MiskolcSweepers Phase F (vehicles). Regenerate from the backend repo: node scripts/buildSweepersVehicleFixture.mjs <out.json>',
  milestone: 'M4 (full)',
  tables,
  encodings,
  initState: { vehicles: initVehicles },
  vehicleUpdate: {
    bought: boughtUpdate, lights: lightsUpdate, horn: hornUpdate, hit: hitUpdate,
    /** Not emitted by Phase F (no selling): the shape only. */
    delShape: { t: 0, del: [simson.id] }
  },
  personalUpdate: { jerry: jerryPersonal },
  trace: {
    note: '24 ticks of 84 ms; a drive tick sends one vehicle_drive then ticks. `sent` / `from` in cm; `row` the VehicleRow of that tick\'s vehicle_update (null: unchanged, not sent); the vehicle is teleported between phases; overSpeed starts with an empty budget',
    ticks: trace
  },
  tip: { hopper: tipHopper, ground: tipGround },
  scaleWeighed,
  garage: { spawned: garageSpawned, steps: garage },
  persistence,
  acks: { ...ACKS, vehicle_drive: { ok: true } },
  /** The wire refusal ack `{ ok: false, error, code }`; each key is the F.8 / D.8 reason, `validation*` a guard failure, `tooFast*` SWEEPERS_TOO_FAST. */
  refusals: REFUSALS
};
service.dispose();

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
