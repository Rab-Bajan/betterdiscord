// MiskolcSweepers Phase D tables (plan D.1). Protocol order = index: the client hard-codes the same
// tables and the D fixture pins them. Units: metres, kg, litres, ms.
import { CAN_KG, KIND } from '../debris/tables.ts';
import type { Load } from '../debris/personal.ts';

/** One bag tier (63). Mesh: `r` × `h` (a Big-Bag is a box of side 2·r). */
export interface BagTier {
  key: string;
  name: string;
  l: number;
  kg: number;
  cost: number;
  /** Can burst on a hard fall (64). */
  rupture: boolean;
  /** A player can carry it. */
  carry: boolean;
  r: number;
  h: number;
  colour: string;
  /** Stock cap in `PersonalState.bags`. */
  stockCap: number;
  /** Receipt `proc` (Phase E): 0 raw, 1 Fémbála, 2 rézköteg. */
  proc: number;
}

export const BAG_TIERS: readonly BagTier[] = Object.freeze([
  { key: 'kek', name: 'Standard Kék Szemeteszsák', l: 30, kg: 20, cost: 50, rupture: true, carry: true, r: 0.28, h: 0.6, colour: '#2F6FD6', stockCap: 99, proc: 0 },
  { key: 'fekete', name: 'Erősített Fekete Építési Zsák', l: 60, kg: 50, cost: 150, rupture: false, carry: true, r: 0.35, h: 0.8, colour: '#1C1C1C', stockCap: 99, proc: 0 },
  { key: 'bigbag', name: 'Nagyüzemi Big-Bag Konténer', l: 1000, kg: 1000, cost: 2_500, rupture: false, carry: false, r: 0.6, h: 1.2, colour: '#E8E2CF', stockCap: 9, proc: 0 },
  // Phase E processed goods (78/79): machine output only; not buyable or tie-able (cost 0, stockCap 0).
  { key: 'bala', name: 'Fémbála', l: 50, kg: 50, cost: 0, rupture: false, carry: true, r: 0.3, h: 0.6, colour: '#6E6A64', stockCap: 0, proc: 1 },
  { key: 'rez', name: 'Fényes vörösréz köteg', l: 8, kg: 20, cost: 0, rupture: false, carry: true, r: 0.3, h: 0.4, colour: '#C8743A', stockCap: 0, proc: 2 }
]);
export const BIG_BAG = 2;
/** Tiers 0..2 are bought and tied; 3 (bala) and 4 (rez) come out of machines. */
export const STOCK_TIERS = 3;
export const BALA = 3;
export const REZ = 4;
export const bagTier = (tier: number): BagTier => BAG_TIERS[tier] ?? BAG_TIERS[0] ?? {
  key: '', name: '', l: 0, kg: 0, cost: 0, rupture: false, carry: false, r: 0.3, h: 0.6, colour: '#000000', stockCap: 0, proc: 0
};

/** Bag tints: 0 = the tier colour; 1 bulk, 2 ferrous, 3 copper (packager bags and lots: group + 1). */
export const TINTS: readonly string[] = Object.freeze(['tier', '#8A8F96', '#B5452C', '#D9822B']);
/** Starter bag kit (lead default), paid once per stats row. */
export const STARTER_BAGS: readonly [number, number, number] = Object.freeze([10, 2, 1]);

/** Lot groups (69). */
export const LOT_GROUPS = Object.freeze(['bulk', 'ferrous', 'copper'] as const);
export const GROUP_BULK = 0;
export const GROUP_FERROUS = 1;
export const GROUP_COPPER = 2;

/** Group of a jackpot kind: the catalyst is ferrous, the cauldron and Lenin copper. */
export const jackpotGroup = (kind: number): number => (kind === KIND.catalyst ? GROUP_FERROUS : GROUP_COPPER);

/** Kg of one group in a load. */
export function groupKg(load: Load, group: number, jackpotKg: (kind: number) => number): number {
  const jackpots = load.jackpots.filter((k) => jackpotGroup(k) === group).reduce((s, k) => s + jackpotKg(k), 0);
  if (group === GROUP_BULK) return (load.dustG + load.seedG) / 1000;
  if (group === GROUP_FERROUS) return load.ironG / 1000 + (load.cans + load.crushed) * CAN_KG + jackpots;
  return load.copperG / 1000 + jackpots;
}

/** Sharp mass (64): iron plus 0.05 kg per can (cans stand in for broken bottles). */
export const sharpKg = (load: Load): number => load.ironG / 1000 + (load.cans + load.crushed) * 0.05;

/** A port in local coordinates: point, unit heading of travel, level change from the input level. */
export interface PortSpec {
  x: number;
  z: number;
  hx: number;
  hz: number;
  dl: number;
}

export type StructFamily =
  | 'found' | 'belt' | 'bendL' | 'bendR' | 'ramp' | 'splitter' | 'merger' | 'hopper' | 'packager' | 'fence' | 'stripper' | 'baler' | 'magnet' | 'trommel' | 'garage';

/** Collider rule of a type: foundation (top − ground), deck (highest deck − base), fixed height, or none. */
export type ColliderRule = { kind: 'found' } | { kind: 'deck' } | { kind: 'fixed'; h: number } | { kind: 'none' };

/** One structure type (65–73, 41). `w` × `d` in local x × z; `len` is the cargo path length (0: none). */
export interface StructSpec {
  key: string;
  name: string;
  family: StructFamily;
  w: number;
  d: number;
  lvlMin: number;
  lvlMax: number;
  ins: readonly PortSpec[];
  /** Splitter: index = route (0 straight, 1 left, 2 right). */
  outs: readonly PortSpec[];
  len: number;
  collider: ColliderRule;
}

const port = (x: number, z: number, hx: number, hz: number, dl = 0): PortSpec => ({ x, z, hx, hz, dl });
const RAMP_LEN = Math.sqrt(4.81);
const beltType = (key: string, name: string, d: number): StructSpec => ({
  key, name, family: 'belt', w: 1, d, lvlMin: 0, lvlMax: 2, ins: [port(0, d / 2, 0, -1)], outs: [port(0, -d / 2, 0, -1)], len: d, collider: { kind: 'deck' }
});

export const STRUCT_TYPES: readonly StructSpec[] = Object.freeze([
  { key: 'found2', name: 'Betonalap 2×2', family: 'found', w: 2, d: 2, lvlMin: 0, lvlMax: 0, ins: [], outs: [], len: 0, collider: { kind: 'found' } },
  { key: 'found4', name: 'Betonalap 4×4', family: 'found', w: 4, d: 4, lvlMin: 0, lvlMax: 0, ins: [], outs: [], len: 0, collider: { kind: 'found' } },
  beltType('belt1', 'Görgős szalag 1 m', 1),
  beltType('belt2', 'Görgős szalag 2 m', 2),
  beltType('belt5', 'Görgős szalag 5 m', 5),
  {
    key: 'bendL', name: 'Kanyarelem (balra)', family: 'bendL', w: 1, d: 1, lvlMin: 0, lvlMax: 2,
    ins: [port(0, 0.5, 0, -1)], outs: [port(-0.5, 0, -1, 0)], len: Math.PI / 4, collider: { kind: 'deck' }
  },
  {
    key: 'bendR', name: 'Kanyarelem (jobbra)', family: 'bendR', w: 1, d: 1, lvlMin: 0, lvlMax: 2,
    ins: [port(0, 0.5, 0, -1)], outs: [port(0.5, 0, 1, 0)], len: Math.PI / 4, collider: { kind: 'deck' }
  },
  {
    key: 'rampUp', name: 'Emelkedő rámpa', family: 'ramp', w: 1, d: 2, lvlMin: 0, lvlMax: 1,
    ins: [port(0, 1, 0, -1)], outs: [port(0, -1, 0, -1, 1)], len: RAMP_LEN, collider: { kind: 'deck' }
  },
  {
    key: 'rampDown', name: 'Lejtő rámpa', family: 'ramp', w: 1, d: 2, lvlMin: 1, lvlMax: 2,
    ins: [port(0, 1, 0, -1)], outs: [port(0, -1, 0, -1, -1)], len: RAMP_LEN, collider: { kind: 'deck' }
  },
  {
    key: 'splitter', name: 'Válogató elágazás', family: 'splitter', w: 1, d: 1, lvlMin: 0, lvlMax: 2,
    ins: [port(0, 0.5, 0, -1)], outs: [port(0, -0.5, 0, -1), port(-0.5, 0, -1, 0), port(0.5, 0, 1, 0)], len: 1, collider: { kind: 'deck' }
  },
  {
    key: 'merger', name: 'Összefolyó idom', family: 'merger', w: 1, d: 1, lvlMin: 0, lvlMax: 2,
    ins: [port(-0.5, 0, 1, 0), port(0.5, 0, -1, 0)], outs: [port(0, -0.5, 0, -1)], len: 1, collider: { kind: 'deck' }
  },
  { key: 'hopper', name: 'Garat', family: 'hopper', w: 4, d: 4, lvlMin: 0, lvlMax: 0, ins: [], outs: [port(0, -2, 0, -1)], len: 0, collider: { kind: 'none' } },
  {
    key: 'packager', name: 'Zsákoló automata', family: 'packager', w: 2, d: 2, lvlMin: 0, lvlMax: 0,
    ins: [port(0, 1, 0, -1)], outs: [port(0, -1, 0, -1)], len: 2, collider: { kind: 'fixed', h: 2.2 }
  },
  { key: 'fence', name: 'Kerítéselem 2 m', family: 'fence', w: 2, d: 0.2, lvlMin: 0, lvlMax: 0, ins: [], outs: [], len: 0, collider: { kind: 'fixed', h: 1.1 } },
  // Phase E machines (78–81): outs[0] straight, outs[1] the side exit heading +x.
  {
    key: 'stripper', name: 'Kábelnyúzó masina', family: 'stripper', w: 2, d: 2, lvlMin: 0, lvlMax: 0,
    ins: [port(0, 1, 0, -1)], outs: [port(0, -1, 0, -1)], len: 2, collider: { kind: 'fixed', h: 1.6 }
  },
  {
    key: 'baler', name: 'Hidraulikus hulladékbálázó', family: 'baler', w: 2, d: 2, lvlMin: 0, lvlMax: 0,
    ins: [port(0, 1, 0, -1)], outs: [port(0, -1, 0, -1)], len: 2, collider: { kind: 'fixed', h: 2.4 }
  },
  {
    key: 'magnet', name: 'Mágneses dobosztályozó', family: 'magnet', w: 2, d: 2, lvlMin: 0, lvlMax: 0,
    ins: [port(0, 1, 0, -1)], outs: [port(0, -1, 0, -1), port(1, 0, 1, 0)], len: 2, collider: { kind: 'fixed', h: 1.8 }
  },
  {
    key: 'trommel', name: 'Forgódobos salakrostáló', family: 'trommel', w: 2, d: 4, lvlMin: 0, lvlMax: 0,
    ins: [port(0, 2, 0, -1)], outs: [port(0, -2, 0, -1), port(1, 0, 1, 0)], len: 4, collider: { kind: 'fixed', h: 2.2 }
  },
  // Phase F (105): a drive-in pad; the roof and posts are visual only.
  { key: 'garage', name: 'Garázsállás', family: 'garage', w: 4, d: 8, lvlMin: 0, lvlMax: 0, ins: [], outs: [], len: 0, collider: { kind: 'none' } }
]);

export const TYPE = Object.freeze({
  found2: 0, found4: 1, belt1: 2, belt2: 3, belt5: 4, bendL: 5, bendR: 6, rampUp: 7, rampDown: 8, splitter: 9, merger: 10, hopper: 11, packager: 12, fence: 13,
  stripper: 14, baler: 15, magnet: 16, trommel: 17, garage: 18
} as const);
export const STRUCT_TYPE_COUNT = STRUCT_TYPES.length;
export const structSpec = (type: number): StructSpec => STRUCT_TYPES[type] ?? STRUCT_TYPES[0] ?? beltType('', '', 1);
/** Types 2–10 carry cargo on a deck (belt path for telemetry and caps). */
export const isBeltLike = (type: number): boolean => type >= TYPE.belt1 && type <= TYPE.merger;
export const isFoundation = (type: number): boolean => type === TYPE.found2 || type === TYPE.found4;
/** Machine types 14–17 (Phase E): blueprint bit = type − 14. */
export const FIRST_MACHINE = TYPE.stripper;
export const isMachine = (type: number): boolean => type >= TYPE.stripper && type <= TYPE.trommel;
/** Jammable nodes (72): splitter, merger, packager and the machines. */
export const isJunction = (type: number): boolean => type === TYPE.splitter || type === TYPE.merger || type === TYPE.packager || isMachine(type);
/** Nodes whose cargo picks an out port on entry (`route` = out index). */
export const isRouted = (type: number): boolean => type === TYPE.splitter || type === TYPE.magnet || type === TYPE.trommel;

/** Machine power and blueprint (E.1): kW while active, blueprint price (team funds). */
export interface MachineSpec {
  type: number;
  kW: number;
  blueprintFt: number;
}
export const MACHINES: readonly MachineSpec[] = Object.freeze([
  { type: TYPE.stripper, kW: 3.5, blueprintFt: 40_000 },
  { type: TYPE.baler, kW: 7.5, blueprintFt: 60_000 },
  { type: TYPE.magnet, kW: 1.5, blueprintFt: 25_000 },
  { type: TYPE.trommel, kW: 3.0, blueprintFt: 30_000 }
]);
export const machineOf = (type: number): MachineSpec | undefined => MACHINES[type - FIRST_MACHINE];

/**
 * Buffer machines (packager family, 73/78/79): `absorbs` the whole lot ('all') or one group's
 * non-jackpot fields; every `cycleMs` with ≥ `batchKg` buffered it emits an `outTier` bag of `batchKg`
 * (≤ `litres`); `flushMs` (null: never) flushes a partial one after that long without input.
 * `tint` null = the dominant group + 1.
 */
export interface ProcessorSpec {
  type: number;
  absorbs: 'all' | number;
  bufKg: number;
  batchKg: number;
  cycleMs: number;
  outTier: number;
  litres: number;
  flushMs: number | null;
  tint: number | null;
  /** Wears (89): smokes at `MAINT_KG`. */
  wears: boolean;
}
export const PROCESSORS: readonly ProcessorSpec[] = Object.freeze([
  { type: TYPE.packager, absorbs: 'all', bufKg: 200, batchKg: 20, cycleMs: 3_000, outTier: 1, litres: 60, flushMs: 10_000, tint: null, wears: false },
  { type: TYPE.stripper, absorbs: GROUP_COPPER, bufKg: 100, batchKg: 20, cycleMs: 10_000, outTier: 4, litres: 8, flushMs: 10_000, tint: GROUP_COPPER + 1, wears: true },
  // A bale is pressed: no litre limit.
  { type: TYPE.baler, absorbs: GROUP_FERROUS, bufKg: 200, batchKg: 50, cycleMs: 8_000, outTier: 3, litres: Infinity, flushMs: null, tint: GROUP_FERROUS + 1, wears: true }
]);
export const processorOf = (type: number): ProcessorSpec | undefined => PROCESSORS.find((p) => p.type === type);

/** Maintenance (89): smoking at 1 500 kg processed, timers × 0.5; 4 service points at the footprint corners. */
export const MAINT_KG = 1_500;
export const SMOKE_RATE = 0.5;
export const SERVICE_REACH_M = 1.5;
/** Service point `point` in local (x, z): 0 (−w/2, −d/2), 1 (+w/2, −d/2), 2 (−w/2, +d/2), 3 (+w/2, +d/2). */
export const servicePoint = (type: number, point: number): [number, number] => {
  const spec = structSpec(type);
  return [((point & 1) === 0 ? -1 : 1) * (spec.w / 2), (point < 2 ? -1 : 1) * (spec.d / 2)];
};
/** `StructRow[7]` flag bits: 0 jammed, 1 busy, 2 smoking, 3–6 grease mask. */
export const FLAG_JAM = 1;
export const FLAG_BUSY = 2;
export const FLAG_SMOKE = 4;
export const GREASE_SHIFT = 3;
export const GREASE_ALL = 0b1111;

/** Trommel coins (80, DEFAULT): a screened bulk lot finds one with 25 %: 50 Ft (60 %), 100 (30 %), 200 (10 %). */
export const COIN_CHANCE = 0.25;
export const COINS: ReadonlyArray<{ ft: number; p: number }> = Object.freeze([{ ft: 50, p: 0.6 }, { ft: 100, p: 0.3 }, { ft: 200, p: 0.1 }]);

/** rot 0..3 → three.js rotY (−rot·π/2 normalised to (−π, π]). */
export function rotYOf(rot: number): number {
  const r = (-rot * Math.PI) / 2;
  return (r <= -Math.PI ? r + 2 * Math.PI : r) + 0;
}

/** Deck height above the base at level `lvl`. */
export const deckOffset = (lvl: number): number => 0.35 + 0.9 * lvl;

/** Constants (67–73). */
export const BELT_MPS = 1.4;
export const CARGO_PITCH_M = 0.6;
export const LOT_KG = 20;
export const HOPPER_KG = 2_000;
export const HOPPER_BAG_QUEUE = 20;
export const HOPPER_EMIT_MS = 500;
export const PACKAGER_KG = 200;
export const PACKAGER_CYCLE_MS = 3_000;
export const PACKAGER_BAG_KG = 20;
export const PACKAGER_FLUSH_MS = 10_000;
export const JAM_MS = 10_000;
export const WATTS_PER_M = 12;
/** Landmark hopper: node id 0, intake = footprint + 1.5 m up to ground + 4.5; buildable: footprint up to ground + 0.5. */
export const LANDMARK_HOPPER = 0;
export const LANDMARK_INTAKE_PAD_M = 1.5;
export const LANDMARK_INTAKE_TOP_M = 4.5;
export const HOPPER_INTAKE_TOP_M = 0.5;

/** Gantry crane (74): a fixed rig in the "Big-Bag udvar". */
export const CRANE = Object.freeze({
  area: { minX: -12.5, maxX: -4.5, minZ: -5, maxZ: 5 },
  legR: 0.3,
  legH: 6,
  hookMps: 1,
  liftMs: 1_500,
  console: { x: -4, z: -5.6 },
  consoleReachM: 2.5,
  targets: [{ x: -8.5, z: 0 }, { x: -11, z: -3.5 }, { x: -11, z: 3.5 }, { x: -6, z: -3.5 }, { x: -6, z: 3.5 }],
  /** Mérlegplató pad (target 0), 3×3. */
  padM: 3,
  targetClearM: 0.9
});

/** Room caps (lead default). */
export const CAPS = Object.freeze({
  structures: 256, foundations: 96, beltM: 300, junctions: 24, hoppers: 4, packagers: 4, fences: 64, bags: 300, lots: 150, machines: 8, garages: 6
});
/** `{what}` of the `buildLimit` refusal. */
export const CAP_NAMES = Object.freeze({
  structures: 'épületelem', foundations: 'betonalap', beltM: 'szalaghossz', junctions: 'elágazás/idom', hoppers: 'garat', packagers: 'zsákoló', fences: 'kerítés',
  machines: 'gép', garages: 'garázs'
});

/** Bag handling (61, 62, 64). */
export const TIE_CADENCE_MS = 1_200;
export const BIG_BAG_FILL_M = 2.5;
export const THROW_MAX_POWER = 12;
export const DROP_POWER = 1;
export const GRAVITY = 9.81;
export const THROW_STEP_S = 0.05;
export const THROW_MAX_STEPS = 60;
export const RUPTURE_SHARP_KG = 15;
export const RUPTURE_FALL_M = 1.5;
export const RUPTURE_CHANCE = 0.4;
export const STACK_MAX = 3;
export const STACK_SLIDE_M = 0.6;
export const PICKUP_REACH_M = 2;
export const PICKUP_HEIGHT_M = 2.2;
export const CLEAR_JAM_REACH_M = 2;
export const TELEMETRY_ON_M = 8;
export const TELEMETRY_OFF_M = 12;
/** Fencing (41): 60 m of fence in a hex stops its respawn. */
export const FENCE_STOP_M = 60;

/** C.1 value (Ft/kg) for the telemetry estimate; jackpots at their fixed worth. */
export const VALUE_FT_PER_KG = Object.freeze({ dust: 2, seed: 5, can: 35, iron: 90, copper: 2_200 });
