// Tool regions (plan C.3), shared math that the client copies for prediction. Pure functions only.
// dir(rotY) = (−sin rotY, −cos rotY): the three.js camera forward.

export const ARC_HALF_ANGLE = (40 * Math.PI) / 180;
export const CONE_HALF_ANGLE = (15 * Math.PI) / 180;
export const CONE_MIN_M = 0.3;
/** 80° in radians, rounded as in the plan. */
export const ARC_AREA_FACTOR = 1.396;
export const CONE_AREA_FACTOR = 0.2618;

export interface Region {
  kind: 'arc' | 'cone' | 'sector';
  ox: number;
  oz: number;
  rotY: number;
  reach: number;
  /** Arc head width (arc only). */
  width: number;
  /** Half angle (cone / sector), radians. */
  halfAngle: number;
  /** Minimum distance (cone). */
  minD: number;
}

export const dirOf = (rotY: number): { x: number; z: number } => ({ x: -Math.sin(rotY), z: -Math.cos(rotY) });

/** |a − b| wrapped to [0, π]. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/** Angle of the direction (x, z) in the same frame as `dirOf`: dirOf(angleOf(x, z)) ∥ (x, z). */
export const angleOf = (x: number, z: number): number => Math.atan2(-x, -z);

export const arcRegion = (ox: number, oz: number, rotY: number, reach: number, width: number): Region =>
  ({ kind: 'arc', ox, oz, rotY, reach, width, halfAngle: ARC_HALF_ANGLE, minD: 0 });

export const coneRegion = (ox: number, oz: number, rotY: number, reach: number, halfAngle = CONE_HALF_ANGLE, minD = CONE_MIN_M): Region =>
  ({ kind: 'cone', ox, oz, rotY, reach, width: 0, halfAngle, minD });

/** The hand: anything within `reach` in the 80° arc. */
export const sectorRegion = (ox: number, oz: number, rotY: number, reach: number): Region =>
  ({ kind: 'sector', ox, oz, rotY, reach, width: 0, halfAngle: ARC_HALF_ANGLE, minD: 0 });

/** True when point (x, z) is inside the region. */
export function inRegion(region: Region, x: number, z: number): boolean {
  const dx = x - region.ox;
  const dz = z - region.oz;
  const d = Math.hypot(dx, dz);
  if (region.kind === 'arc') {
    if (Math.abs(d - region.reach) > region.width / 2) return false;
  } else if (d < region.minD || d > region.reach) {
    return false;
  }
  if (d < 1e-9) return region.kind === 'sector';
  return angleDiff(angleOf(dx, dz), region.rotY) <= region.halfAngle;
}

/** Area used by the f formula: arc 1.396·reach·w, cone 0.2618·(reach² − 0.09). */
export function regionArea(region: Region): number {
  if (region.kind === 'arc') return ARC_AREA_FACTOR * region.reach * region.width;
  if (region.kind === 'cone') return CONE_AREA_FACTOR * (region.reach * region.reach - region.minD * region.minD);
  return region.halfAngle * region.reach * region.reach;
}

/** Bounding half-size of the region around its origin. */
export const regionExtent = (region: Region): number => region.reach + region.width / 2;

/** f = min(1, speed · cadence · mods / A) (C.3). */
export const sweepFraction = (speed: number, cadence: number, mods: number, area: number): number =>
  (area > 0 ? Math.min(1, (speed * cadence * mods) / area) : 0);

/** L' = floor(L · (1 − f · eff)); the 1e-9 keeps an exact product (7.0) from flooring to 6 by rounding error. */
export const reducedLevel = (level: number, f: number, eff: number): number => Math.max(0, Math.floor(level * (1 - f * eff) + 1e-9));
