// MiskolcSweepers Phase C tables (plan C.1). Protocol order = index: the client hard-codes the same
// tables and the C fixture pins them. Masses in kg unless the name says otherwise.

/** Bumped together with the layout version: a stored debris blob of another generation is regenerated. */
export const DEBRIS_GEN = 1;

/** Item kinds; the index is the protocol value of `ItemRow[1]`. */
export const ITEM_KINDS = Object.freeze(['can', 'iron', 'copper', 'pile', 'cabbage', 'cauldron', 'catalyst', 'lenin'] as const);
export type ItemKind = (typeof ITEM_KINDS)[number];

export const KIND = Object.freeze({ can: 0, iron: 1, copper: 2, pile: 3, cabbage: 4, cauldron: 5, catalyst: 6, lenin: 7 } as const);

/** `ItemRow` flags (`rf >> 8`). */
export const FLAG_STUCK = 1;
export const FLAG_BURIED = 2;

export const CAN_KG = 0.05;
export const CAN_L = 0.6;
export const CRUSHED_L = 0.12;
export const IRON_KG: readonly [number, number] = [2.5, 15];
export const COPPER_KG: readonly [number, number] = [1, 8];
export const CABBAGE_KG = 6;
export const CABBAGE_L = 40;
/** Litres per kg. */
export const DUST_L_PER_KG = 0.67;
export const SEED_L_PER_KG = 6.7;
export const IRON_L_PER_KG = 0.5;
export const COPPER_L_PER_KG = 0.3;
/** Dust / seed kg per m² at full dirt (before the district profile). */
export const DUST_KG_M2 = 1.6;
export const SEED_KG_M2 = 0.3;

/** Jackpots (42): fixed mass, volume and worth (Phase E). Keyed by kind index 5..7. */
export interface JackpotSpec {
  kind: number;
  name: string;
  kg: number;
  l: number;
  ft: number;
  /** Spawn weight. */
  weight: number;
}

export const JACKPOTS: readonly JackpotSpec[] = Object.freeze([
  { kind: KIND.cauldron, name: 'Rézüst', kg: 45, l: 80, ft: 120_000, weight: 0.4 },
  { kind: KIND.catalyst, name: 'Katalizátor', kg: 8, l: 6, ft: 85_000, weight: 0.45 },
  { kind: KIND.lenin, name: 'Bronz Lenin-fej', kg: 60, l: 40, ft: 150_000, weight: 0.15 }
]);
export const JACKPOT_CHANCE = 0.005;

export const jackpotOf = (kind: number): JackpotSpec | undefined => JACKPOTS.find((j) => j.kind === kind);

/** District profile (32) at full dirt. */
export interface DistrictProfile {
  dust: number;
  seed: number;
  cans: number;
  iron: number;
  copper: number;
  cabbage: number;
  /** Share of cans that are stuck between cobblestones. */
  stuck: number;
  /** Share of copper that is buried. */
  buried: number;
}

export const DISTRICT_PROFILES: readonly DistrictProfile[] = Object.freeze([
  { dust: 0.8, seed: 0.2, cans: 30, iron: 25, copper: 2, cabbage: 0, stuck: 0.15, buried: 0 },
  { dust: 0.6, seed: 1.0, cans: 120, iron: 4, copper: 1, cabbage: 0, stuck: 0, buried: 0 },
  { dust: 0.5, seed: 0.7, cans: 90, iron: 15, copper: 1, cabbage: 4, stuck: 0.15, buried: 0 },
  { dust: 1.0, seed: 0.1, cans: 25, iron: 45, copper: 6, cabbage: 0, stuck: 0, buried: 0.3 },
  { dust: 0.4, seed: 0.9, cans: 80, iron: 4, copper: 1, cabbage: 0, stuck: 0.15, buried: 0 },
  { dust: 0.3, seed: 0.5, cans: 50, iron: 3, copper: 2, cabbage: 0, stuck: 0, buried: 0.3 }
]);

export const profileOf = (district: number): DistrictProfile => DISTRICT_PROFILES[district] ?? DISTRICT_PROFILES[0] ?? {
  dust: 0, seed: 0, cans: 0, iron: 0, copper: 0, cabbage: 0, stuck: 0, buried: 0
};

/** Tool region shapes. */
export type RegionKind = 'arc' | 'cone' | 'hand';

/** One tool (46–52); id = index. */
export interface ToolSpec {
  id: number;
  name: string;
  /** Buffer capacity, kg (0: no buffer). */
  bufferKg: number;
  /** Head width, m (arc tools). */
  width: number;
  reach: number;
  region: RegionKind;
  /** Swept area per second, m² (0: does not sweep cells). */
  speed: number;
  /** Fixed time per use (LMB), s. */
  cadence: number;
  /** Stamina per use, tenths. */
  stamina: number;
  /** Ft; 0 = owned from the start. */
  cost: number;
}

export const TOOLS: readonly ToolSpec[] = Object.freeze([
  { id: 0, name: 'Elhasznált WC-kefe', bufferKg: 0.5, width: 0.25, reach: 0.6, region: 'arc', speed: 0.08, cadence: 0.5, stamina: 5, cost: 0 },
  { id: 1, name: 'Háztartási partvis és lapát', bufferKg: 3.5, width: 0.6, reach: 1.2, region: 'arc', speed: 0.35, cadence: 0.5, stamina: 8, cost: 1_500 },
  { id: 2, name: 'Cirokseprű', bufferKg: 8, width: 0.9, reach: 1.2, region: 'arc', speed: 0.85, cadence: 0.5, stamina: 10, cost: 6_000 },
  { id: 3, name: 'Ipari piros utcaseprű', bufferKg: 18, width: 1.6, reach: 1.3, region: 'arc', speed: 1.8, cadence: 0.5, stamina: 14, cost: 22_000 },
  { id: 4, name: 'Kétütemű lombfúvó', bufferKg: 0, width: 0, reach: 7, region: 'cone', speed: 0, cadence: 0.25, stamina: 2.5, cost: 65_000 },
  { id: 5, name: 'Miskolc-Vakuum 3000', bufferKg: 45, width: 0, reach: 3.5, region: 'cone', speed: 2.4, cadence: 0.25, stamina: 2.5, cost: 140_000 },
  { id: 6, name: 'Mágneses gereblye & fémkereső', bufferKg: 25, width: 1.2, reach: 1.2, region: 'arc', speed: 0, cadence: 0.5, stamina: 8, cost: 220_000 },
  { id: 7, name: 'Kéz', bufferKg: 0, width: 0, reach: 2, region: 'hand', speed: 0, cadence: 0.33, stamina: 3, cost: 0 }
]);

export const TOOL_COUNT = TOOLS.length;
export const HAND = 7;
export const BLOWER = 4;
export const VACUUM = 5;
export const RAKE = 6;
/** Bits 0 (WC-kefe) and 7 (Kéz) are always owned. */
export const ALWAYS_OWNED = 0b1000_0001;

export const toolOf = (id: number): ToolSpec => TOOLS[id] ?? TOOLS[0] ?? {
  id: 0, name: '', bufferKg: 0, width: 0, reach: 0, region: 'arc', speed: 0, cadence: 1, stamina: 0, cost: 0
};

/** Alt (RMB) cadence, s, and stamina, tenths. */
export const ALT_CADENCE = 1;
export const SCOOP_STAMINA = 20;
export const BLOWER_ALT_STAMINA = 2.5;
export const VACUUM_ALT_STAMINA = 2.5;
export const CRUSH_STAMINA_PER_CAN = 5;
export const CRUSH_MAX = 10;
export const BLOWER_FUEL_ML = 5;
export const TURBO_FUEL_ML = 50;
export const FUEL_TANK_ML = 2_000;

/** Backpack (54) by level 0..4. */
export const PACK_KG: readonly number[] = Object.freeze([10, 25, 50, 100, 180]);
export const PACK_L: readonly number[] = Object.freeze([8, 30, 60, 120, 220]);
/** Cost of level 1..4 at index 0..3. */
export const PACK_COST: readonly number[] = Object.freeze([2_500, 9_000, 30_000, 85_000]);
/** Width (53) by level 0..5, tools 0–3. */
export const WIDTH_BONUS: readonly number[] = Object.freeze([0, 0.15, 0.3, 0.5, 0.75, 1.1]);
export const WIDTH_COST: readonly number[] = Object.freeze([3_000, 8_000, 20_000, 45_000, 90_000]);
/** Hardness (55) by level 0..3: heavy-slag efficiency and wear multipliers. */
export const HARD_EFF: readonly number[] = Object.freeze([1, 1.33, 1.67, 2]);
export const HARD_WEAR: readonly number[] = Object.freeze([1, 0.8, 0.6, 0.4]);
export const HARD_COST: readonly number[] = Object.freeze([5_000, 15_000, 40_000]);
export const GLOVES_COST = 2_500;
export const FUEL_COST = 600;
/** Repair price = this share of the tool's cost. */
export const REPAIR_SHARE = 0.1;

/** Refreshments (59): price, stamina gain (tenths; null = set to full) and effect length (ms). */
export interface Refreshment {
  name: string;
  cost: number;
  stamina: number | null;
  fx: 'beer' | 'kofola' | null;
  fxMs: number;
}

export const REFRESHMENTS = Object.freeze({
  beer: { name: 'Sör', cost: 450, stamina: 500, fx: 'beer', fxMs: 15_000 },
  kofola: { name: 'Kofola', cost: 350, stamina: 350, fx: 'kofola', fxMs: 45_000 },
  zsiros: { name: 'Zsíros kenyér', cost: 900, stamina: null, fx: null, fxMs: 0 }
} satisfies Record<string, Refreshment>);

export const STAMINA_MAX = 1_000;
export const KOFOLA_SPEED = 1.15;
export const STENCH_MS = 10_000;
/** Starter grant (user decision 2026-11-13). */
export const STARTER_GRANT_FT = 2_000;
