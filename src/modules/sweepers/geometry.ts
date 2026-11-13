// Pure world geometry shared by server validation and (by the same rules) client prediction:
// ground height, player-vs-collider resolution and surface lookup.
import type { Collider, Heightfield, Surface, SurfaceKind } from './city/layoutTypes.ts';

/** Player body radius, metres. */
export const PLAYER_RADIUS = 0.35;
/** Colliders whose top is at most this high above the ground are stepped over (curbs, platforms). */
export const STEP_HEIGHT = 0.35;
/** Sample spacing when sweeping a move; well under twice the radius, so no wall is skipped. */
const SWEEP_STEP = 0.1;
/** A swept path may graze a collider by this much (client-side resolution rounding) before it counts as a hit. */
const GRAZE_TOLERANCE = 0.05;
const RESOLVE_PASSES = 4;
/** Bucket size of {@link ColliderIndex}, metres. */
const INDEX_CELL = 8;

/** Ground height (m) at (x, z): bilinear between the samples; outside the field the edge is extended. */
export function groundHeight(field: Heightfield, x: number, z: number): number {
  const max = field.size - 1;
  const fx = Math.min(max, Math.max(0, (x - field.origin) / field.cell));
  const fz = Math.min(max, Math.max(0, (z - field.origin) / field.cell));
  const ix = Math.min(max - 1, Math.floor(fx));
  const iz = Math.min(max - 1, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const at = (cx: number, cz: number): number => field.heightsCm[cz * field.size + cx] ?? 0;
  const top = at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx;
  const bottom = at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx;
  return (top * (1 - tz) + bottom * tz) / 100;
}

/** True for a collider the player cannot step over. */
export const isBlocking = (collider: Collider): boolean => collider.h > STEP_HEIGHT;

/** Push-out of a circle from one collider: unit normal and penetration depth, or null when apart. */
export interface Penetration {
  nx: number;
  nz: number;
  depth: number;
}

/** Penetration of the circle (x, z, radius) into `collider` (its footprint), or null. */
export function penetration(collider: Collider, x: number, z: number, radius: number): Penetration | null {
  if (collider.shape === 'cyl') {
    const dx = x - collider.x;
    const dz = z - collider.z;
    const dist = Math.hypot(dx, dz);
    const depth = collider.r + radius - dist;
    if (depth <= 0) return null;
    return dist > 1e-9 ? { nx: dx / dist, nz: dz / dist, depth } : { nx: 1, nz: 0, depth };
  }
  // Box: work in its frame (u = local x along (cos, −sin), v = local z along (sin, cos)).
  const cos = Math.cos(collider.rotY);
  const sin = Math.sin(collider.rotY);
  const dx = x - collider.x;
  const dz = z - collider.z;
  const u = dx * cos - dz * sin;
  const v = dx * sin + dz * cos;
  const hw = collider.w / 2;
  const hd = collider.d / 2;
  let nu: number;
  let nv: number;
  let depth: number;
  if (Math.abs(u) <= hw && Math.abs(v) <= hd) {
    // Centre inside: leave through the nearest face.
    const pu = hw - Math.abs(u);
    const pv = hd - Math.abs(v);
    if (pu < pv) { nu = u < 0 ? -1 : 1; nv = 0; depth = pu + radius; }
    else { nu = 0; nv = v < 0 ? -1 : 1; depth = pv + radius; }
  } else {
    const cu = Math.min(hw, Math.max(-hw, u));
    const cv = Math.min(hd, Math.max(-hd, v));
    const du = u - cu;
    const dv = v - cv;
    const dist = Math.hypot(du, dv);
    depth = radius - dist;
    if (depth <= 0) return null;
    nu = du / dist;
    nv = dv / dist;
  }
  // Back to world: world = u * (cos, −sin) + v * (sin, cos).
  return { nx: nu * cos + nv * sin, nz: -nu * sin + nv * cos, depth };
}

/** Circle position after pushing it out of every blocking collider in `colliders`. */
export interface Resolved {
  x: number;
  z: number;
  /** True when any collider was touched (beyond `tolerance`). */
  hit: boolean;
}

/** Pushes the circle out of the blocking colliders (a few passes, for corners between two of them). */
export function resolveCircle(colliders: readonly Collider[], x: number, z: number, radius = PLAYER_RADIUS): Resolved {
  let px = x;
  let pz = z;
  let hit = false;
  for (let pass = 0; pass < RESOLVE_PASSES; pass++) {
    let moved = false;
    for (const collider of colliders) {
      if (!isBlocking(collider)) continue;
      const pen = penetration(collider, px, pz, radius);
      if (!pen) continue;
      px += pen.nx * pen.depth;
      pz += pen.nz * pen.depth;
      hit = true;
      moved = true;
    }
    if (!moved) break;
  }
  return { x: px, z: pz, hit };
}

/** Uniform-grid index of the blocking colliders (step-over ones are left out). */
export class ColliderIndex {
  readonly #cells = new Map<string, Collider[]>();

  constructor(colliders: readonly Collider[]) {
    for (const collider of colliders) {
      if (!isBlocking(collider)) continue;
      const reach = collider.shape === 'cyl' ? collider.r : Math.hypot(collider.w, collider.d) / 2;
      for (const key of ColliderIndex.#keys(collider.x, collider.z, reach)) {
        const list = this.#cells.get(key);
        if (list) list.push(collider);
        else this.#cells.set(key, [collider]);
      }
    }
  }

  static #keys(x: number, z: number, reach: number): string[] {
    const keys: string[] = [];
    for (let cx = Math.floor((x - reach) / INDEX_CELL); cx <= Math.floor((x + reach) / INDEX_CELL); cx++) {
      for (let cz = Math.floor((z - reach) / INDEX_CELL); cz <= Math.floor((z + reach) / INDEX_CELL); cz++) keys.push(`${cx},${cz}`);
    }
    return keys;
  }

  /** Blocking colliders that may touch the circle (x, z, radius), each once. */
  near(x: number, z: number, radius: number): Collider[] {
    const found = new Set<Collider>();
    for (const key of ColliderIndex.#keys(x, z, radius)) for (const c of this.#cells.get(key) ?? []) found.add(c);
    return [...found];
  }
}

/**
 * Moves the player circle from (fromX, fromZ) towards (toX, toZ). When the straight path stays clear
 * of every blocking collider (within a small graze tolerance) the target is returned unchanged with
 * `hit: false`. Otherwise the path is walked in short steps, pushing out at each one: the player
 * slides along walls and never passes through them, and `hit` is true.
 */
export function sweepCircle(index: ColliderIndex, fromX: number, fromZ: number, toX: number, toZ: number, radius = PLAYER_RADIUS): Resolved {
  const length = Math.hypot(toX - fromX, toZ - fromZ);
  const steps = Math.max(1, Math.ceil(length / SWEEP_STEP));
  // Every collider within length + radius of the midpoint: covers the straight path plus any slide
  // or push-out that leaves it (a slid end point stays within length of the start). Cheap at 8 m cells.
  const nearby = index.near((fromX + toX) / 2, (fromZ + toZ) / 2, length + radius);
  if (nearby.length === 0) return { x: toX, z: toZ, hit: false };
  const graze = radius - GRAZE_TOLERANCE;
  let clear = true;
  for (let i = 0; i <= steps && clear; i++) {
    const t = i / steps;
    const x = fromX + (toX - fromX) * t;
    const z = fromZ + (toZ - fromZ) * t;
    clear = nearby.every((c) => penetration(c, x, z, graze) === null);
  }
  if (clear) return { x: toX, z: toZ, hit: false };
  let x = fromX;
  let z = fromZ;
  const sx = (toX - fromX) / steps;
  const sz = (toZ - fromZ) / steps;
  for (let i = 0; i < steps; i++) {
    const next = resolveCircle(nearby, x + sx, z + sz, radius);
    x = next.x;
    z = next.z;
  }
  return { x, z, hit: true };
}

/** What the ground is like underfoot. */
export type SurfaceAt = SurfaceKind | 'dry';

/** When circles overlap, the more severe surface wins. */
const SURFACE_PRIORITY: readonly SurfaceKind[] = ['acid', 'grease', 'mud', 'wet'];

/** The surface at (x, z): the most severe circle containing the point, else 'dry'. */
export function surfaceAt(surfaces: readonly Surface[], x: number, z: number): SurfaceAt {
  let best: SurfaceAt = 'dry';
  let bestRank = SURFACE_PRIORITY.length;
  for (const s of surfaces) {
    if (Math.hypot(x - s.x, z - s.z) > s.r) continue;
    const rank = SURFACE_PRIORITY.indexOf(s.kind);
    if (rank < bestRank) {
      best = s.kind;
      bestRank = rank;
    }
  }
  return best;
}
