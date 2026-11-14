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
}

export const BAG_TIERS: readonly BagTier[] = Object.freeze([
  { key: 'kek', name: 'Standard Kék Szemeteszsák', l: 30, kg: 20, cost: 50, rupture: true, carry: true, r: 0.28, h: 0.6, colour: '#2F6FD6', stockCap: 99 },
  { key: 'fekete', name: 'Erősített Fekete Építési Zsák', l: 60, kg: 50, cost: 150, rupture: false, carry: true, r: 0.35, h: 0.8, colour: '#1C1C1C', stockCap: 99 },
  { key: 'bigbag', name: 'Nagyüzemi Big-Bag Konténer', l: 1000, kg: 1000, cost: 2_500, rupture: false, carry: false, r: 0.6, h: 1.2, colour: '#E8E2CF', stockCap: 9 }
]);
export const BIG_BAG = 2;
export const bagTier = (tier: number): BagTier => BAG_TIERS[tier] ?? BAG_TIERS[0] ?? {
  key: '', name: '', l: 0, kg: 0, cost: 0, rupture: false, carry: false, r: 0.3, h: 0.6, colour: '#000000', stockCap: 0
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

export type StructFamily = 'found' | 'belt' | 'bendL' | 'bendR' | 'ramp' | 'splitter' | 'merger' | 'hopper' | 'packager' | 'fence';

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
  { key: 'fence', name: 'Kerítéselem 2 m', family: 'fence', w: 2, d: 0.2, lvlMin: 0, lvlMax: 0, ins: [], outs: [], len: 0, collider: { kind: 'fixed', h: 1.1 } }
]);

export const TYPE = Object.freeze({
  found2: 0, found4: 1, belt1: 2, belt2: 3, belt5: 4, bendL: 5, bendR: 6, rampUp: 7, rampDown: 8, splitter: 9, merger: 10, hopper: 11, packager: 12, fence: 13
} as const);
export const STRUCT_TYPE_COUNT = STRUCT_TYPES.length;
export const structSpec = (type: number): StructSpec => STRUCT_TYPES[type] ?? STRUCT_TYPES[0] ?? beltType('', '', 1);
/** Types 2–10 carry cargo on a deck (belt path for telemetry and caps). */
export const isBeltLike = (type: number): boolean => type >= TYPE.belt1 && type <= TYPE.merger;
export const isFoundation = (type: number): boolean => type === TYPE.found2 || type === TYPE.found4;
export const isJunction = (type: number): boolean => type === TYPE.splitter || type === TYPE.merger || type === TYPE.packager;

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
  structures: 256, foundations: 96, beltM: 300, junctions: 24, hoppers: 4, packagers: 4, fences: 64, bags: 300, lots: 150
});
/** `{what}` of the `buildLimit` refusal. */
export const CAP_NAMES = Object.freeze({
  structures: 'épületelem', foundations: 'betonalap', beltM: 'szalaghossz', junctions: 'elágazás/idom', hoppers: 'garat', packagers: 'zsákoló', fences: 'kerítés'
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
