// Writes a JSON fixture of real MiskolcSweepers Phase E output (machines & economy) for the frontend
// tests: the E.1 tables, the E.3 encodings, init_state.economy, economy / scale_weighed / inspection
// samples, StructRows with smoke and grease bits, the acks and refusals of every E.4 case, a 48-tick
// machine trace (magnet, trommel coin, stripper, baler) and the LME series of epochs 0..9.
// Usage: node scripts/buildSweepersEconomyFixture.mjs [outFile]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BALA_MULT, DIESEL_CAN_FT, DIESEL_CAN_L, DIESEL_FULL_L, DIRTY_BULK_SHARE, DIRTY_PENALTY, FINE_FT, GENERATOR_REACH_M, GREASE_GUN_FT,
  INSPECT_MS, LICENSE_SHARE, licensePrice, LME_EPOCH_MS, LME_HEADLINE_PCT, LME_SERIES, LME_STEPS, MATERIALS, PAD_M, POWER, PROC,
  QUOTA_BASE_KG, QUOTA_FULL_PLAYERS, REZ_COPPER_FT, SCALE_ANCHOR_M, SCALE_STILL_MS, TEAM_ITEMS, WAGE_SHARE
} from '../src/modules/sweepers/economy/tables.ts';
import {
  BAG_TIERS, CAP_NAMES, CAPS, COIN_CHANCE, COINS, CRANE, FLAG_BUSY, FLAG_JAM, FLAG_SMOKE, GREASE_SHIFT, MACHINES, MAINT_KG, PROCESSORS,
  SERVICE_REACH_M, servicePoint, SMOKE_RATE, STOCK_TIERS, STRUCT_TYPES, TYPE
} from '../src/modules/sweepers/logistics/tables.ts';
import { cityLayout } from '../src/modules/sweepers/city/cityLayout.ts';
import { Logger } from '../src/core/logging/Logger.ts';
import { AppError } from '../src/core/errors/AppError.ts';
import { SweepersService } from '../src/modules/sweepers/SweepersService.ts';
import { emptyLoad } from '../src/modules/sweepers/debris/personal.ts';
import { DAYLIGHT_MS } from '../src/modules/sweepers/dayClock.ts';
import { lmeRow } from '../src/modules/sweepers/economy/lme.ts';
import { PowerGrid } from '../src/modules/sweepers/economy/PowerGrid.ts';
import { parseBuyUpgrade, parseLogisticsAction, parsePlaceStructure } from '../src/modules/sweepers/payloads.ts';
import { rotate } from '../src/modules/sweepers/logistics/shapes.ts';

const DEFAULT_OUT = path.join(os.tmpdir(), 'sweepers-e-economy-fixture.json');
const out = path.resolve(process.argv[2] ?? DEFAULT_OUT);
const layout = cityLayout();

const tables = {
  materials: MATERIALS.map((m, mat) => ({ mat, ...m })),
  proc: PROC,
  balaMult: BALA_MULT,
  rezCopperFt: REZ_COPPER_FT,
  contamination: { bulkShare: DIRTY_BULK_SHARE, penalty: DIRTY_PENALTY },
  wageShare: WAGE_SHARE,
  bagTiers: BAG_TIERS.map((t, tier) => ({ tier, ...t })),
  stockTiers: STOCK_TIERS,
  machineTypes: STRUCT_TYPES.map((t, index) => ({ index, ...t })).filter((t) => t.index >= TYPE.stripper),
  machines: MACHINES.map((m) => ({ ...m, blueprintBit: m.type - TYPE.stripper, servicePoints: [0, 1, 2, 3].map((p) => servicePoint(m.type, p)) })),
  processors: PROCESSORS.map((p) => ({ ...p, litres: Number.isFinite(p.litres) ? p.litres : null })),
  maintenance: { maintKg: MAINT_KG, smokeRate: SMOKE_RATE, serviceReachM: SERVICE_REACH_M },
  flags: { jam: FLAG_JAM, busy: FLAG_BUSY, smoke: FLAG_SMOKE, greaseShift: GREASE_SHIFT },
  coins: { chance: COIN_CHANCE, values: COINS },
  caps: { machines: CAPS.machines, name: CAP_NAMES.machines },
  power: POWER,
  generator: { ...layout.landmarks.generator, reachM: GENERATOR_REACH_M },
  shop: {
    greaseGunFt: GREASE_GUN_FT, dieselCanFt: DIESEL_CAN_FT, dieselCanL: DIESEL_CAN_L, dieselFullL: DIESEL_FULL_L, licenseShare: LICENSE_SHARE,
    license: [1, 2, 3, 4, 5].map((district) => ({ district, ft: licensePrice(district) })), teamItems: TEAM_ITEMS
  },
  inspector: { intervalMs: INSPECT_MS, quotaBaseKg: QUOTA_BASE_KG, fullPlayers: QUOTA_FULL_PLAYERS, fineFt: FINE_FT },
  lme: { epochMs: LME_EPOCH_MS, steps: LME_STEPS, series: LME_SERIES, headlinePct: LME_HEADLINE_PCT },
  scales: {
    stillMs: SCALE_STILL_MS, anchorM: SCALE_ANCHOR_M,
    zones: [{ scale: 0, ...layout.landmarks.weighbridge }, { scale: 1, x: CRANE.targets[0].x, z: CRANE.targets[0].z, w: PAD_M, d: PAD_M, rotY: 0 }]
  }
};

const encodings = {
  StructRow: '[id, type, xCm, zCm, baseYCm, rot, lvl, flags] — flags bit 0 jammed, 1 busy, 2 smoking, bits 3–6 grease mask (bit 3 + point)',
  FillRow: '[nodeId, kgDg] — `pk` rows cover the packager (12), stripper (14) and baler (15) buffers',
  BagRow: '[id, tier, tint, st, xCm, yCm, zCm, rot8, kgDg] — tier 3 Fémbála (tint 2), tier 4 rézköteg (tint 3)',
  CargoRow: '[id, kind, sub, tint, node, sMm, route, mv, kgDg] — on a magnet / trommel route 0 = straight, 1 = side (+x)',
  ReceiptLine: '[mat, proc (0 raw, 1 bala, 2 rez), kgDg, ftPerKg, ft] — summed per (mat, proc), ascending; for mat 5–7 ftPerKg is the Ft per piece',
  GridRow: '{ st: 0 ok | 1 brownout | 2 blackout, pf: 1 | 0.4 | 0, solarW, genW, demandW, battWh, dieselDl (0.1 L), genOn }',
  LmeRow: '{ epoch, pct: [alu, iron, copper], until (server ms), msg }',
  InspRow: '{ at (server ms of the next visit), kg: int[6], quota: int[6] (effective for the connected count) }',
  CoinRow: '[nodeId, ft]',
  servicePoint: 'local (x, z) of point 0..3: 0 (−w/2, −d/2), 1 (+w/2, −d/2), 2 (−w/2, +d/2), 3 (+w/2, +d/2); world = structure centre + rotate(rot, x, z)'
};

// ---- a real service ----
const CHANNEL = 'hang-chill';
const SOCKET = 'fixture-socket';
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
  initState: record('miskolc:init_state'), tickSync: record('miskolc:tick_sync'), playerJoined: record('miskolc:player_joined'),
  playerLeft: record('miskolc:player_left'), sessionUpdated: () => undefined, kicked: record('miskolc:kicked'),
  districtUnlocked: record('miskolc:district_unlocked'), clock: () => undefined, clockTo: () => undefined, weather: () => undefined,
  debrisUpdate: () => undefined, personalUpdate: record('miskolc:personal_update'), structureSpawned: record('miskolc:structure_spawned'),
  logisticsUpdate: record('miskolc:logistics_update'), logisticsTelemetry: record('miskolc:logistics_telemetry'),
  scaleWeighed: record('miskolc:scale_weighed'), inspection: record('miskolc:inspection'), economy: record('miskolc:economy')
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
const ground = (x, z) => 0 * x * z;
const load = (kg) => ({ ...emptyLoad(), dustG: (kg.dust ?? 0) * 1000, ironG: (kg.iron ?? 0) * 1000, copperG: (kg.copper ?? 0) * 1000, cans: kg.cans ?? 0, jackpots: kg.jackpots ?? [] });

service.join(CHANNEL, SOCKET, { key: 'name:fixture', accountId: null, username: 'Fixture', avatarColor: '#7655F5' });
const initEconomy = emitted.find((e) => e.event === 'miskolc:init_state').payload.economy;
const room = service.room(CHANNEL);
const player = [...room.players()][0];
const world = room.logistics;
const at = (x, z, rotY = 0) => { player.pose = { ...player.pose, x, y: ground(x, z), z, rotY }; room.afterInput(player, clock.ms); };
const office = layout.landmarks.office;
const gen = layout.landmarks.generator;
const wb = layout.landmarks.weighbridge;
const pad = CRANE.targets[0];

// ---- E.4: buy_upgrade ----
const buy = (request) => ack(() => ({ ok: true, ...service.buyUpgrade(SOCKET, parseBuyUpgrade({ channelId: CHANNEL, ...request })) }));
const ACKS = {};
const REFUSALS = {};
at(0, 0);
REFUSALS.buy_upgrade = { notAtWorkbench: buy({ item: 'blueprint', tier: 0 }) };
at(office.x, office.z + 3);
REFUSALS.buy_upgrade.notEnoughTeamFunds = buy({ item: 'blueprint', tier: 0 });
room.teamFunds = 500_000;
const fundsFrom = emitted.length;
ACKS.buy_upgrade = { blueprint: buy({ item: 'blueprint', tier: 0 }) };
REFUSALS.buy_upgrade.alreadyOwned = buy({ item: 'blueprint', tier: 0 });
for (const tier of [1, 2, 3]) buy({ item: 'blueprint', tier });
ACKS.buy_upgrade.diesel = buy({ item: 'diesel' });
ACKS.buy_upgrade.diesel2 = buy({ item: 'diesel' });
REFUSALS.buy_upgrade.tankFull = buy({ item: 'diesel' });
const unlockFrom = emitted.length;
ACKS.buy_upgrade.license = buy({ item: 'license', tier: 1 });
const licenseUnlocked = since(unlockFrom, 'miskolc:district_unlocked');
REFUSALS.buy_upgrade.alreadyUnlocked = buy({ item: 'license', tier: 1 });
player.personal.cash = 1_000;
REFUSALS.buy_upgrade.notEnoughCash = buy({ item: 'grease' });
player.personal.cash = 10_000;
ACKS.buy_upgrade.grease = buy({ item: 'grease' });
REFUSALS.buy_upgrade.greaseOwned = buy({ item: 'grease' });
REFUSALS.buy_upgrade.validationBlueprint = buy({ item: 'blueprint', tier: 4 });
REFUSALS.buy_upgrade.validationLicense = buy({ item: 'license', tier: 0 });
REFUSALS.buy_upgrade.validationBagTier = buy({ item: 'bag', tier: 3 });
tick();
const personalUpdate = since(fundsFrom, 'miskolc:personal_update').at(-1);
const fundsUpdate = since(fundsFrom, 'miskolc:economy').at(-1);
service.addRevenue(CHANNEL, 1e12);
room.teamFunds = 500_000;

// ---- E.4: generator ----
const act = (action) => ack(() => service.logisticsAction(SOCKET, parseLogisticsAction({ channelId: CHANNEL, ...action })));
at(0, 0);
REFUSALS.generator = { notAtGenerator: act({ kind: 'generator', on: true }) };
at(gen.x, gen.z + 1.5);
const diesel = room.economy.grid.dieselL;
room.economy.grid.dieselL = 0;
REFUSALS.generator.noDiesel = act({ kind: 'generator', on: true });
room.economy.grid.dieselL = diesel;
ACKS.generator = { on: act({ kind: 'generator', on: true }), off: act({ kind: 'generator', on: false }) };
REFUSALS.generator.validation = act({ kind: 'generator' });

// ---- place_structure: machines, noBlueprint, machine cap ----
const place = (type, x, z, rot = 0) => ack(() => ({ ok: true, id: service.placeStructure(SOCKET, parsePlaceStructure({ channelId: CHANNEL, type, x, z, rot, lvl: 0 })) }));
at(-3, -2);
const bp = room.economy.bp;
room.economy.bp = 0;
at(-3, -10);
REFUSALS.place_structure = { noBlueprint: place(TYPE.stripper, 0, -12.5) };
at(-3, -2);
room.economy.bp = bp;
const spawnFrom = emitted.length;
const net = {};
for (const [key, type, x, z, rot] of [
  ['feed', TYPE.belt1, 0, -5, 0], ['magnet', TYPE.magnet, 0, -6.5, 0], ['baler', TYPE.baler, 2, -6.5, 1],
  ['trommel', TYPE.trommel, 0, -9.5, 0], ['stripper', TYPE.stripper, 0, -12.5, 0]
]) {
  if (key === 'stripper') at(-3, -10);
  const res = place(type, x, z, rot);
  if (!res.ok) throw new Error(`network piece ${key}: ${res.error}`);
  net[key] = res.id;
}
const structureSpawned = since(spawnFrom, 'miskolc:structure_spawned');
const capProbe = [];
at(-4, 6);
for (let x = -10; x <= 2 && Object.keys(net).length + capProbe.length < CAPS.machines; x += 2.5) {
  for (let z = 2; z <= 12 && Object.keys(net).length - 1 + capProbe.length < CAPS.machines; z += 2.5) {
    const r = place(TYPE.magnet, x, z);
    if (r.ok) capProbe.push(r.id);
  }
}
REFUSALS.place_structure.buildLimit = (() => {
  for (let x = -10; x <= 2; x += 2.5) for (let z = 2; z <= 12; z += 2.5) {
    const r = place(TYPE.magnet, x, z);
    if (!r.ok && r.error.startsWith('Elérted az építési korlátot')) return r;
  }
  return null;
})();
for (const id of capProbe) world.remove(id);
tick();

// ---- the 48-tick machine trace (250 ms ticks): magnet side, trommel coin, stripper → rez, baler 8 s ----
at(0, -20);
for (let i = 0; i < 44; i++) tick(250);
room.logisticsChance = () => true;
// The cycle timer is full after the warm-up: the first bale goes at once, the second 8 s later.
world.restoreBuffer(net.baler, load({ iron: 100 }), 8_000, 0);
const lot = (id, sub, s, kg) => world.restoreCargo({ id, kind: 0, sub, tint: sub + 1, node: net.feed, s, route: 0, waitMs: 0, load: sub === 0 ? load({ dust: kg }) : sub === 1 ? load({ iron: kg }) : load({ copper: kg }) });
lot(4_001, 1, 0.9, 10);
lot(4_002, 0, 0.3, 8);
const traceFrom = emitted.length;
const ticks = [];
let copperIn = false;
for (let i = 0; i < 48; i++) {
  if (i === 6 && !copperIn) copperIn = lot(4_003, 2, 0.5, 20);
  tick(250);
  ticks.push({ t: clock.ms, rows: [...world.cargo.values()].filter((c) => c.node !== 0).sort((a, b) => a.id - b.id).map((c) => world.cargoRow(c)) });
}
const traceUpdates = since(traceFrom, 'miskolc:logistics_update');
const traceEconomy = since(traceFrom, 'miskolc:economy');
const coinsUpdate = traceEconomy.find((u) => u.coins) ?? null;
if (!coinsUpdate) throw new Error('no trommel coin in the trace');
const routes = {};
for (const tk of ticks) for (const r of tk.rows) if (r[4] === net.magnet || r[4] === net.trommel) routes[`${r[0]}@${r[4]}`] = r[6];
const emittedBags = traceUpdates.flatMap((u) => u.c ?? []).filter((c) => c[1] === 1 && (c[2] === 3 || c[2] === 4));
if (!emittedBags.some((c) => c[2] === 4) || emittedBags.filter((c) => c[2] === 3).length < 2) throw new Error(`trace bags ${JSON.stringify(emittedBags)}`);
room.logisticsChance = () => false;
const pkRows = traceUpdates.flatMap((u) => u.pk ?? []);

// ---- grease: smoking and mask bits ----
const stripper = world.structures.get(net.stripper);
const corner = (point) => {
  const [lx, lz] = servicePoint(TYPE.stripper, point);
  const [ox, oz] = rotate(stripper.rot, lx, lz);
  return [stripper.x + ox, stripper.z + oz];
};
const greaseAt = (point) => { const [x, z] = corner(point); at(x + (point & 1 ? 0.5 : -0.5), z); };
greaseAt(0);
REFUSALS.grease = { unknownStructure: act({ kind: 'grease', id: net.magnet, point: 0 }), noGreaseNeeded: act({ kind: 'grease', id: net.stripper, point: 0 }) };
player.personal.greaseGun = false;
REFUSALS.grease.noGreaseGun = act({ kind: 'grease', id: net.stripper, point: 0 });
player.personal.greaseGun = true;
stripper.wear = 1_495;
world.restoreBuffer(net.stripper, load({ copper: 20 }));
const smokeFrom = emitted.length;
for (let i = 0; i < 160 && (stripper.flags & 4) === 0; i++) tick();
const smokeRow = since(smokeFrom, 'miskolc:logistics_update').flatMap((u) => u.s ?? []).find((r) => r[0] === net.stripper && (r[7] & 4) !== 0) ?? null;
at(0, -20);
REFUSALS.grease.notAtServicePoint = act({ kind: 'grease', id: net.stripper, point: 0 });
greaseAt(0);
ACKS.grease = [act({ kind: 'grease', id: net.stripper, point: 0 })];
REFUSALS.grease.alreadyGreased = act({ kind: 'grease', id: net.stripper, point: 0 });
greaseAt(1);
ACKS.grease.push(act({ kind: 'grease', id: net.stripper, point: 1 }));
const greasedRow = world.structRow(stripper);
const greaseFrom = emitted.length;
tick();
const greaseUpdate = since(greaseFrom, 'miskolc:logistics_update').at(-1) ?? null;
greaseAt(2);
ACKS.grease.push(act({ kind: 'grease', id: net.stripper, point: 2 }));
greaseAt(3);
ACKS.grease.push(act({ kind: 'grease', id: net.stripper, point: 3 }));
const resetRow = world.structRow(stripper);
REFUSALS.grease.validation = act({ kind: 'grease', id: net.stripper, point: 4 });

// ---- scale_weighed: the pack on the weighbridge; the crane pad with a bala, a rez bundle and a contaminated bag ----
player.personal.pack = load({ copper: 3, iron: 4, cans: 20 });
at(wb.x, wb.z);
const weighFrom = emitted.length;
for (let i = 0; i < 30; i++) tick();
const weighPack = since(weighFrom, 'miskolc:scale_weighed')[0] ?? null;
const weighPackEconomy = since(weighFrom, 'miskolc:economy').find((u) => u.funds !== undefined) ?? null;
const weighPackPersonal = since(weighFrom, 'miskolc:personal_update').at(-1) ?? null;
world.restoreGroundBag({ id: 9_001, tier: 3, tint: 2, x: pad.x - 0.8, z: pad.z, rot8: 0, load: load({ iron: 50 }) });
world.restoreGroundBag({ id: 9_002, tier: 4, tint: 3, x: pad.x + 0.8, z: pad.z, rot8: 0, load: load({ copper: 20 }) });
world.restoreGroundBag({ id: 9_003, tier: 1, tint: 0, x: pad.x + 0.8, z: pad.z, rot8: 0, load: load({ dust: 3, iron: 10, copper: 1 }) });
at(pad.x, pad.z + 1);
const padFrom = emitted.length;
for (let i = 0; i < 30; i++) tick();
const weighPad = since(padFrom, 'miskolc:scale_weighed')[0] ?? null;
const weighPadUpdate = since(padFrom, 'miskolc:logistics_update').find((u) => u.del) ?? null;
if (!weighPack || !weighPad || weighPad.dirtyFt >= 0) throw new Error('weighings missing');

// ---- inspection with a fine ----
room.economy.kg[1] = 600;
room.economy.kg[2] = 100;
room.economy.inspInMs = 300;
const inspFrom = emitted.length;
tick(500);
const inspection = since(inspFrom, 'miskolc:inspection')[0] ?? null;
const inspEconomy = since(inspFrom, 'miskolc:economy').at(-1) ?? null;

// ---- grid states (the real PowerGrid at hand-picked inputs) and economy samples ----
const gridOk = new PowerGrid(100_000, 20, true);
gridOk.step(1_000, DAYLIGHT_MS / 2, 9_000);
const gridBrownout = new PowerGrid(40_000, 0, false);
gridBrownout.step(1_000, DAYLIGHT_MS + 1, 16_500);
const gridBlackout = new PowerGrid(0, 0, false);
gridBlackout.step(1_000, DAYLIGHT_MS + 1, 600);
room.economy.grid.battWh = 0;
clock.ms += DAYLIGHT_MS;
const blackFrom = emitted.length;
for (let i = 0; i < 14; i++) tick();
const blackoutEconomy = since(blackFrom, 'miskolc:economy').find((u) => u.grid && u.grid.st === 2) ?? null;
// The next LME epoch is pushed once.
clock.ms = (Math.floor(clock.ms / LME_EPOCH_MS) + 1) * LME_EPOCH_MS;
const lmeFrom = emitted.length;
tick();
const lmeEconomy = since(lmeFrom, 'miskolc:economy').find((u) => u.lme) ?? null;

const fixture = {
  description: 'Real backend output of MiskolcSweepers Phase E (machines & economy). Regenerate from the backend repo: node scripts/buildSweepersEconomyFixture.mjs <out.json>',
  tables,
  encodings,
  initState: { economy: initEconomy },
  economy: {
    grid: { ok: gridOk.row(), brownout: gridBrownout.row(), blackout: gridBlackout.row() },
    lme: { up: lmeRow(5), down: lmeRow(2), calm: lmeRow(0) },
    lmeSeries: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((e) => lmeRow(e)),
    updates: { funds: fundsUpdate, coins: coinsUpdate, blackout: blackoutEconomy, lme: lmeEconomy, inspection: inspEconomy, afterWeighing: weighPackEconomy }
  },
  scaleWeighed: { pack: weighPack, pad: weighPad, padLogisticsUpdate: weighPadUpdate, personalAfterPack: weighPackPersonal },
  inspection,
  structures: { spawned: structureSpawned, network: net, smoking: smokeRow, greased: greasedRow, greaseUpdate, reset: resetRow, pk: pkRows.slice(0, 12) },
  trace: { note: '48 ticks of 250 ms: every CargoRow on a node; updates: every logistics_update; economy: every miskolc:economy; routes `${id}@${node}` → route', tickMs: 250, ticks, updates: traceUpdates, economy: traceEconomy, routes },
  events: { personalUpdate, districtUnlockedByLicense: licenseUnlocked },
  acks: ACKS,
  /** The wire refusal ack `{ ok: false, error, code }`; each key is the E.8 / C.8 reason, `validation*` a guard failure. */
  refusals: REFUSALS
};
service.dispose();

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(fixture)}\n`);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
