// Weighbridge payout (77, 79, 90): receipt lines per container and material, contamination, and the
// 80/20 split. Pure functions; money is integer Ft.
import type { Load } from '../debris/personal.ts';
import { CAN_KG, jackpotOf } from '../debris/tables.ts';
import { BALA_MULT, DIRTY_BULK_SHARE, DIRTY_PENALTY, jackpotMat, MAT, MATERIALS, PROC, REZ_COPPER_FT, WAGE_SHARE } from './tables.ts';

/** `[mat, proc, kgDg, ftPerKg, ft]`; for a jackpot (mat 5–7) `ftPerKg` is the Ft per piece. */
export type ReceiptLine = [number, number, number, number, number];

/** One weighed container: the player's pack, a bag. `proc` = its tier's receipt proc. */
export interface Container {
  load: Load;
  proc: number;
}

export interface Receipt {
  lines: ReceiptLine[];
  dirtyFt: number;
  total: number;
  kgDg: number;
}

const EPS = 1e-9;
const dg = (kg: number): number => Math.round(kg * 100);
const jackpotKg = (kind: number): number => jackpotOf(kind)?.kg ?? 0;

/** Ft/kg of `mat` in a `proc` container with the LME `pct` ([alu, iron, copper]). */
export function ftPerKg(mat: number, proc: number, pct: readonly number[]): number {
  const spec = MATERIALS[mat];
  if (!spec) return 0;
  const base = mat === MAT.copper && proc === PROC.rez ? REZ_COPPER_FT : spec.ftPerKg;
  const lme = spec.lme === null ? 1 : 1 + (pct[spec.lme] ?? 0) / 100;
  return Math.round(base * lme * (proc === PROC.bala ? BALA_MULT : 1));
}

/** The receipt of the weighed containers (E.2): lines summed per (mat, proc) ascending, contamination, total ≥ 0. */
export function receipt(containers: readonly Container[], pct: readonly number[]): Receipt {
  const sums = new Map<number, ReceiptLine>();
  let dirtyFt = 0;
  let kgDg = 0;
  const add = (mat: number, proc: number, kg: number, rate: number, ft: number): void => {
    const key = mat * 16 + proc;
    const line = sums.get(key) ?? [mat, proc, 0, rate, 0];
    line[2] += dg(kg);
    line[4] += ft;
    sums.set(key, line);
  };
  for (const { load, proc } of containers) {
    const kg = [load.dustG / 1000, load.seedG / 1000, (load.cans + load.crushed) * CAN_KG, load.ironG / 1000, load.copperG / 1000];
    let metalFt = 0;
    let totalKg = 0;
    kg.forEach((k, mat) => {
      totalKg += k;
      if (k <= EPS) return;
      const rate = ftPerKg(mat, proc, pct);
      const ft = Math.round(k * rate);
      if (mat >= MAT.can) metalFt += ft;
      add(mat, proc, k, rate, ft);
    });
    for (const kind of load.jackpots) {
      const mat = jackpotMat(kind);
      const spec = MATERIALS[mat];
      if (!spec) continue;
      const pieceKg = jackpotKg(kind);
      totalKg += pieceKg;
      add(mat, proc, pieceKg, spec.worth, spec.worth);
    }
    kgDg += dg(totalKg);
    const bulk = (kg[MAT.dust] ?? 0) + (kg[MAT.seed] ?? 0);
    const metal = (kg[MAT.can] ?? 0) + (kg[MAT.iron] ?? 0) + (kg[MAT.copper] ?? 0);
    if (metal > EPS && bulk >= DIRTY_BULK_SHARE * totalKg - EPS) dirtyFt -= Math.round(DIRTY_PENALTY * metalFt);
  }
  const lines = [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line);
  const total = Math.max(0, lines.reduce((s, l) => s + l[4], 0) + dirtyFt);
  return { lines, dirtyFt: dirtyFt + 0, total, kgDg };
}

/** 80/20 split (90): `each` to every connected player, the rest (incl. rounding) to the team. */
export function split(total: number, connected: number): { each: number; team: number } {
  const n = Math.max(1, connected);
  const each = Math.floor(Math.floor(WAGE_SHARE * total) / n);
  return { each, team: total - each * n };
}
