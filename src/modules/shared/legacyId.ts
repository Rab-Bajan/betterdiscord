/** Clock and randomness used for generated ids, injectable for tests. */
export interface IdSource {
  now: () => number;
  random: () => number;
}

/** Default id source: `Date.now` and `Math.random`, read at call time (so test mocks apply). */
export const defaultIdSource: IdSource = { now: () => Date.now(), random: () => Math.random() };

/**
 * Legacy id format `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, length)}`
 * (e.g. `acc_…_6`, `dm_…_9`, `rep_…_6`).
 */
export function legacyId(prefix: string, randomLength: number, source: IdSource = defaultIdSource): string {
  return `${prefix}_${source.now()}_${source.random().toString(36).substring(2, 2 + randomLength)}`;
}
