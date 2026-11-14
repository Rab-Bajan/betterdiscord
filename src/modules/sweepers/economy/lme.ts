// The LME ticker (87): a global, deterministic market. Each 15-minute epoch draws one step per series
// from a mulberry32 seeded by the epoch and series; nothing is persisted and every room sees the same.
import { hashString, Rng } from '../random.ts';
import { LME_EPOCH_MS, LME_HEADLINE_PCT, LME_SERIES, LME_STEPS } from './tables.ts';

/** `LmeRow` (E.3). */
export interface LmeRow {
  epoch: number;
  /** % per series: [alu, iron, copper]. */
  pct: [number, number, number];
  /** Server ms when the epoch ends. */
  until: number;
  msg: string;
}

export const lmeEpoch = (now: number): number => Math.floor(now / LME_EPOCH_MS);

/** % change of `series` (0 alu, 1 iron, 2 copper) in `epoch`. */
export function lmePct(series: number, epoch: number): number {
  const draw = new Rng(hashString(`lme:${epoch}:${series}`)).next();
  return LME_STEPS[Math.floor(draw * LME_STEPS.length)] ?? 0;
}

/** Price factor of `series` in `epoch`. */
export const lmeFactor = (series: number, epoch: number): number => 1 + lmePct(series, epoch) / 100;

/** The headline: the series with the largest |pct| (ties: copper > iron > alu). */
export function lmeHeadline(pct: readonly number[]): string {
  let best = 2;
  for (let s = 1; s >= 0; s--) if (Math.abs(pct[s] ?? 0) > Math.abs(pct[best] ?? 0)) best = s;
  const p = pct[best] ?? 0;
  const name = LME_SERIES[best]?.name ?? '';
  if (p >= LME_HEADLINE_PCT) return `LME TŐZSDEREPÜLÉS: Megugrott ${name} iránti kereslet! Ár: +${p}%!`;
  if (p <= -LME_HEADLINE_PCT) return `LME ZUHANÁS: Beesett ${name} ára! Ár: −${-p}%!`;
  return 'LME: nyugodt piac.';
}

export function lmeRow(epoch: number): LmeRow {
  const pct: [number, number, number] = [lmePct(0, epoch), lmePct(1, epoch), lmePct(2, epoch)];
  return { epoch, pct, until: (epoch + 1) * LME_EPOCH_MS, msg: lmeHeadline(pct) };
}
