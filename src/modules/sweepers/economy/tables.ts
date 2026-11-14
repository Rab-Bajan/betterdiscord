// MiskolcSweepers Phase E tables (plan E.1). Protocol order = index: the client hard-codes the same
// tables and the E fixture pins them. Money is integer Ft; units as before.
import { JACKPOTS, KIND } from '../debris/tables.ts';
import { UNLOCK_THRESHOLDS } from '../progression.ts';

/** One receipt material (77): `mat` index = position. `lme` is the LME series index, or null (LME-free). */
export interface MaterialSpec {
  key: string;
  name: string;
  /** Ft/kg; a jackpot's is 0 (it has a fixed `worth`). */
  ftPerKg: number;
  /** Ft per piece (jackpots only, else 0). */
  worth: number;
  lme: number | null;
}

const jackpotFt = (kind: number): number => JACKPOTS.find((j) => j.kind === kind)?.ft ?? 0;

export const MATERIALS: readonly MaterialSpec[] = Object.freeze([
  { key: 'dust', name: 'Por', ftPerKg: 2, worth: 0, lme: null },
  { key: 'seed', name: 'Napraforgóhéj', ftPerKg: 5, worth: 0, lme: null },
  { key: 'can', name: 'Alumínium doboz', ftPerKg: 35, worth: 0, lme: 0 },
  { key: 'iron', name: 'Ócskavas', ftPerKg: 90, worth: 0, lme: 1 },
  { key: 'copper', name: 'Vörösréz', ftPerKg: 2_200, worth: 0, lme: 2 },
  { key: 'cauldron', name: 'Rézüst', ftPerKg: 0, worth: jackpotFt(KIND.cauldron), lme: null },
  { key: 'catalyst', name: 'Katalizátor', ftPerKg: 0, worth: jackpotFt(KIND.catalyst), lme: null },
  { key: 'lenin', name: 'Bronz Lenin-fej', ftPerKg: 0, worth: jackpotFt(KIND.lenin), lme: null }
]);
export const MAT = Object.freeze({ dust: 0, seed: 1, can: 2, iron: 3, copper: 4 } as const);
/** A jackpot kind (5..7) is receipt mat 5..7. */
export const jackpotMat = (kind: number): number => kind;

/** Receipt `proc`: 0 raw, 1 Fémbála (every line × 1.45), 2 rézköteg (copper at 3 100 Ft/kg). */
export const PROC = Object.freeze({ raw: 0, bala: 1, rez: 2 } as const);
export const BALA_MULT = 1.45;
export const REZ_COPPER_FT = 3_100;

/** Contamination (77, DEFAULT): bulk ≥ 10 % of a metal-holding container costs 15 % of its metal lines. */
export const DIRTY_BULK_SHARE = 0.1;
export const DIRTY_PENALTY = 0.15;

/** 80/20 split (90, DEFAULT): 20 % wage pool shared equally by the connected players. */
export const WAGE_SHARE = 0.2;

/** Scales (76): stand still 2 s; moving more than 0.15 m re-arms. Scale 1 (crane pad) is 3 × 3 m. */
export const SCALE_STILL_MS = 2_000;
export const SCALE_ANCHOR_M = 0.15;
export const PAD_M = 3;

/** LME (87). Series 0 alu, 1 iron, 2 copper; names with the article. */
export const LME_EPOCH_MS = 900_000;
export const LME_STEPS: readonly number[] = Object.freeze([-25, -15, -10, -5, 0, 0, 5, 10, 15, 25]);
export const LME_SERIES = Object.freeze([
  { key: 'alu', name: 'az alumínium' },
  { key: 'iron', name: 'az ócskavas' },
  { key: 'copper', name: 'a vörösréz' }
]);
export const LME_HEADLINE_PCT = 15;

/** Power (82–84). Watts, watt-hours, litres. */
export const POWER = Object.freeze({
  solarPeakW: 18_000,
  generatorW: 25_000,
  dieselLPerHour: 3.5,
  tankL: 60,
  startDieselL: 20,
  batteryWh: 150_000,
  batteryMaxW: 15_000,
  wattsPerBeltM: 12,
  brownoutPf: 0.4,
  stepMs: 1_000
});
export const GENERATOR_REACH_M = 3;

/** Shop additions (85). */
export const GREASE_GUN_FT = 3_500;
export const DIESEL_CAN_FT = 5_000;
export const DIESEL_CAN_L = 20;
export const DIESEL_FULL_L = 59.5;
export const LICENSE_SHARE = 0.6;
/** Licence price of district 1..5 (0.6 × the B unlock threshold). */
export const licensePrice = (district: number): number => Math.round(LICENSE_SHARE * (UNLOCK_THRESHOLDS[district] ?? Infinity));
/** Team-paid `buy_upgrade` items. */
export const TEAM_ITEMS = Object.freeze(['blueprint', 'diesel', 'license'] as const);

/** Inspector (86). */
export const INSPECT_MS = 1_800_000;
export const QUOTA_BASE_KG: readonly number[] = Object.freeze([0, 2_000, 1_500, 2_500, 1_200, 1_000]);
/** The quota is full at this many connected players and scales down linearly below. */
export const QUOTA_FULL_PLAYERS = 4;
export const FINE_FT = 25_000;
export const effectiveQuota = (district: number, connected: number): number =>
  Math.round((QUOTA_BASE_KG[district] ?? 0) * Math.min(1, connected / QUOTA_FULL_PLAYERS));
