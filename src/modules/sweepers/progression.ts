// District unlocks (spec 25): a district opens once the team's lifetime revenue reaches its threshold.

/** Lifetime revenue (Ft) at which each district opens; district 0 is always open. */
export const UNLOCK_THRESHOLDS: Readonly<Record<number, number>> = Object.freeze({
  0: 0,
  1: 25_000,
  2: 75_000,
  3: 180_000,
  4: 350_000,
  5: 350_000
});

export const DISTRICT_IDS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5]);

/** The districts open at `lifetimeEarned` Ft, ascending. */
export function unlockedFor(lifetimeEarned: number): number[] {
  return DISTRICT_IDS.filter((d) => lifetimeEarned >= (UNLOCK_THRESHOLDS[d] ?? Infinity));
}
