// Personal state of a player (plan C.5 PersonalState, C.6 stats_json). Internally masses are float
// grams and stamina float tenths; the wire form rounds them.
import { isPlainObject } from '../../../core/validation/isPlainObject.ts';
import type { PersonalStats } from '../types.ts';
import {
  ALWAYS_OWNED, CAN_KG, CAN_L, COPPER_L_PER_KG, CRUSHED_L, DUST_L_PER_KG, FUEL_TANK_ML, IRON_L_PER_KG, jackpotOf, PACK_KG, PACK_L,
  SEED_L_PER_KG, STAMINA_MAX, STARTER_GRANT_FT, TOOL_COUNT, toolOf, WIDTH_BONUS, HARD_EFF
} from './tables.ts';
import { BAG_TIERS, STARTER_BAGS } from '../logistics/tables.ts';

/** Contents of a tool buffer or the backpack (internal: float grams). */
export interface Load {
  dustG: number;
  seedG: number;
  cans: number;
  crushed: number;
  ironG: number;
  copperG: number;
  /** Jackpot kind indices 5..7. */
  jackpots: number[];
}

/** Wire form of a {@link Load}: whole grams, kg and L to 0.01. */
export interface LoadPayload extends Load {
  kg: number;
  l: number;
}

export type EffectName = 'stench' | 'beer' | 'kofola';
export type Effects = Partial<Record<EffectName, number>>;

/** A player's full personal state (server memory). */
export interface PersonalData extends PersonalStats {
  /** The one-time starter grant has been paid. */
  starter: boolean;
  /** Bit i = tool i owned. */
  owned: number;
  widthLvl: number;
  hardLvl: number;
  gloves: boolean;
  /** Durability permille of tools 1..3 (float). */
  dur: [number, number, number];
  fuelMl: number;
  /** Tenths, 0..1000 (float). */
  stamina: number;
  clogged: boolean;
  buf: Load;
  pack: Load;
  /** Effect end, server time (ms). */
  fx: Effects;
  /** Bag stock by tier (Phase D). */
  bags: [number, number, number];
  /** The one-time starter bag kit has been given. */
  starterBags: boolean;
  /** Zsírzóprés owned (Phase E, 89). */
  greaseGun: boolean;
}

/** `miskolc:personal_update` and `init_state.personal`. */
export interface PersonalStatePayload extends PersonalStats {
  owned: number;
  widthLvl: number;
  hardLvl: number;
  gloves: boolean;
  dur: [number, number, number];
  fuelMl: number;
  stamina: number;
  clogged: boolean;
  buf: LoadPayload;
  pack: LoadPayload;
  caps: { bufKg: number; packKg: number; packL: number };
  fx: Effects;
  /** Bag stock by tier (Phase D). */
  bags: [number, number, number];
  /** Zsírzóprés owned (Phase E). */
  greaseGun: boolean;
}

export const EFFECT_NAMES: readonly EffectName[] = Object.freeze(['stench', 'beer', 'kofola']);
export const STATS_JSON_VERSION = 4;

export const emptyLoad = (): Load => ({ dustG: 0, seedG: 0, cans: 0, crushed: 0, ironG: 0, copperG: 0, jackpots: [] });

export function loadKg(load: Load): number {
  const jackpots = load.jackpots.reduce((sum, kind) => sum + (jackpotOf(kind)?.kg ?? 0), 0);
  return (load.dustG + load.seedG + load.ironG + load.copperG) / 1000 + (load.cans + load.crushed) * CAN_KG + jackpots;
}

export function loadL(load: Load): number {
  const jackpots = load.jackpots.reduce((sum, kind) => sum + (jackpotOf(kind)?.l ?? 0), 0);
  return (load.dustG * DUST_L_PER_KG + load.seedG * SEED_L_PER_KG + load.ironG * IRON_L_PER_KG + load.copperG * COPPER_L_PER_KG) / 1000
    + load.cans * CAN_L + load.crushed * CRUSHED_L + jackpots;
}

export const isEmptyLoad = (load: Load): boolean => loadKg(load) <= 1e-9 && load.cans === 0 && load.crushed === 0 && load.jackpots.length === 0;

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;

export function loadPayload(load: Load): LoadPayload {
  return {
    dustG: Math.round(load.dustG), seedG: Math.round(load.seedG), cans: load.cans, crushed: load.crushed,
    ironG: Math.round(load.ironG), copperG: Math.round(load.copperG), jackpots: [...load.jackpots], kg: r2(loadKg(load)), l: r2(loadL(load))
  };
}

export const ownsTool = (data: Pick<PersonalData, 'owned'>, tool: number): boolean => (data.owned & (1 << tool)) !== 0;

/** Buffer capacity of the equipped tool, kg. */
export const bufferCap = (data: PersonalData): number => toolOf(data.toolTier).bufferKg;
export const packCapKg = (data: PersonalData): number => PACK_KG[data.backpackTier] ?? PACK_KG[0] ?? 10;
export const packCapL = (data: PersonalData): number => PACK_L[data.backpackTier] ?? PACK_L[0] ?? 8;

/** Durability permille of a tool (1000 for tools that do not wear). */
export const durabilityOf = (data: PersonalData, tool: number): number => (tool >= 1 && tool <= 3 ? data.dur[tool - 1] ?? 1000 : 1000);

/** Effective head width of an arc tool (C.3): width upgrade for tools 0–3, halved below 20 % durability. */
export function headWidth(data: PersonalData, tool: number): number {
  const spec = toolOf(tool);
  const bonus = tool <= 3 ? WIDTH_BONUS[data.widthLvl] ?? 0 : 0;
  const worn = durabilityOf(data, tool) < 200 ? 0.5 : 1;
  return spec.width * (1 + bonus) * worn;
}

export const hardEff = (data: PersonalData): number => HARD_EFF[data.hardLvl] ?? 1;

export const effectActive = (data: PersonalData, name: EffectName, now: number): boolean => (data.fx[name] ?? 0) > now;

export function personalPayload(data: PersonalData, now: number): PersonalStatePayload {
  const fx: Effects = {};
  for (const name of EFFECT_NAMES) {
    const until = data.fx[name];
    if (until !== undefined && until > now) fx[name] = until;
  }
  return {
    cash: data.cash,
    toolTier: data.toolTier,
    backpackTier: data.backpackTier,
    totalKg: Math.round(data.totalKg * 1000) / 1000 + 0,
    owned: data.owned,
    widthLvl: data.widthLvl,
    hardLvl: data.hardLvl,
    gloves: data.gloves,
    dur: [Math.round(data.dur[0]), Math.round(data.dur[1]), Math.round(data.dur[2])],
    fuelMl: Math.round(data.fuelMl),
    stamina: Math.round(data.stamina),
    clogged: data.clogged,
    buf: loadPayload(data.buf),
    pack: loadPayload(data.pack),
    caps: { bufKg: bufferCap(data), packKg: packCapKg(data), packL: packCapL(data) },
    fx,
    bags: [...data.bags],
    greaseGun: data.greaseGun
  };
}

// ---- stats_json parsing (each field on its own, defaults and clamps) ----

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const intIn = (v: unknown, min: number, max: number, fallback: number): number =>
  (isNum(v) && Number.isInteger(v) && v >= min && v <= max ? v : fallback);
const numIn = (v: unknown, min: number, max: number, fallback: number): number => (isNum(v) ? Math.min(max, Math.max(min, v)) : fallback);
const MAX_G = 10_000_000;
const MAX_COUNT = 100_000;

function parseLoad(value: unknown): Load {
  if (!isPlainObject(value)) return emptyLoad();
  const jackpots = Array.isArray(value['jackpots'])
    ? value['jackpots'].filter((k): k is number => isNum(k) && jackpotOf(k) !== undefined).slice(0, 100)
    : [];
  return {
    dustG: numIn(value['dustG'], 0, MAX_G, 0),
    seedG: numIn(value['seedG'], 0, MAX_G, 0),
    cans: intIn(value['cans'], 0, MAX_COUNT, 0),
    crushed: intIn(value['crushed'], 0, MAX_COUNT, 0),
    ironG: numIn(value['ironG'], 0, MAX_G, 0),
    copperG: numIn(value['copperG'], 0, MAX_G, 0),
    jackpots
  };
}

const serialiseLoad = (load: Load): Load => ({ ...load, jackpots: [...load.jackpots] });

/** Result of {@link parsePersonal}. */
export interface ParsedPersonal {
  data: PersonalData;
  /** True when the starter grant or the starter bag kit was given by this load (the caller persists at once). */
  granted: boolean;
}

/**
 * The personal state of a stored row: the four v1 columns (`stats`) plus `stats_json` (`extra`, null
 * for a v1 row). Every field is parsed on its own with a default; values are clamped to range; an
 * equipped tool that is not owned becomes 0. Pays the one-time starter grant when `starter` is not true.
 */
export function parsePersonal(stats: PersonalStats, extra: Record<string, unknown> | null, now: number): ParsedPersonal {
  const json = extra ?? {};
  const owned = (intIn(json['owned'], 0, 0xff, 0) | ALWAYS_OWNED) & 0xff;
  const durRaw = Array.isArray(json['dur']) ? json['dur'] : [];
  const fx: Effects = {};
  const fxRaw = isPlainObject(json['fx']) ? json['fx'] : {};
  for (const name of EFFECT_NAMES) {
    const remaining = fxRaw[name];
    if (isNum(remaining) && remaining > 0) fx[name] = now + Math.min(remaining, 3_600_000);
  }
  const toolTier = intIn(stats.toolTier, 0, TOOL_COUNT - 1, 0);
  const bagsRaw = Array.isArray(json['bags']) ? json['bags'] : [];
  const bagStock = (tier: number): number => Math.min(BAG_TIERS[tier]?.stockCap ?? 0, intIn(bagsRaw[tier], 0, MAX_COUNT, 0));
  const data: PersonalData = {
    cash: isNum(stats.cash) ? Math.max(0, Math.round(stats.cash)) : 0,
    toolTier: (owned & (1 << toolTier)) !== 0 ? toolTier : 0,
    backpackTier: intIn(stats.backpackTier, 0, PACK_KG.length - 1, 0),
    totalKg: isNum(stats.totalKg) && stats.totalKg > 0 ? stats.totalKg : 0,
    starter: json['starter'] === true,
    owned,
    widthLvl: intIn(json['widthLvl'], 0, WIDTH_BONUS.length - 1, 0),
    hardLvl: intIn(json['hardLvl'], 0, HARD_EFF.length - 1, 0),
    gloves: json['gloves'] === true,
    dur: [numIn(durRaw[0], 0, 1000, 1000), numIn(durRaw[1], 0, 1000, 1000), numIn(durRaw[2], 0, 1000, 1000)],
    fuelMl: numIn(json['fuelMl'], 0, FUEL_TANK_ML, FUEL_TANK_ML),
    stamina: numIn(json['stamina'], 0, STAMINA_MAX, STAMINA_MAX),
    clogged: json['clogged'] === true,
    buf: parseLoad(json['buf']),
    pack: parseLoad(json['pack']),
    fx,
    bags: [bagStock(0), bagStock(1), bagStock(2)],
    starterBags: json['starterBags'] === true,
    greaseGun: json['greaseGun'] === true
  };
  let granted = false;
  if (!data.starter) {
    data.cash += STARTER_GRANT_FT;
    data.starter = true;
    granted = true;
  }
  if (!data.starterBags) {
    const kit = (t: number): number => Math.min(BAG_TIERS[t]?.stockCap ?? 0, (data.bags[t] ?? 0) + (STARTER_BAGS[t] ?? 0));
    data.bags = [kit(0), kit(1), kit(2)];
    data.starterBags = true;
    granted = true;
  }
  return { data, granted };
}

/** `stats_json` of a personal state; effects are stored as remaining ms (server time does not survive a restart). */
export function serialisePersonal(data: PersonalData, now: number): Record<string, unknown> {
  const fx: Record<string, number> = {};
  for (const name of EFFECT_NAMES) {
    const until = data.fx[name];
    if (until !== undefined && until > now) fx[name] = until - now;
  }
  return {
    v: STATS_JSON_VERSION,
    starter: data.starter,
    owned: data.owned,
    widthLvl: data.widthLvl,
    hardLvl: data.hardLvl,
    gloves: data.gloves,
    dur: [...data.dur],
    fuelMl: data.fuelMl,
    stamina: data.stamina,
    buf: serialiseLoad(data.buf),
    pack: serialiseLoad(data.pack),
    clogged: data.clogged,
    fx,
    bags: [...data.bags],
    starterBags: data.starterBags,
    greaseGun: data.greaseGun
  };
}

/** The four v1 columns of a personal state. */
export const v1Stats = (data: PersonalData): PersonalStats => ({
  cash: data.cash, toolTier: data.toolTier, backpackTier: data.backpackTier, totalKg: data.totalKg
});
