// Structure geometry (plan D.1/D.2): quarter-turn transforms, footprints, ports, cargo paths, decks
// and colliders. Pure functions; rot is 0..3 so every transform is exact on the 0.5 m lattice.
import type { Collider } from '../city/layoutTypes.ts';
import { deckOffset, structSpec } from './tables.ts';
import type { PortSpec } from './tables.ts';

/** A placed structure (server memory). `base` is the deck base; a foundation's `base` is its top. */
export interface Structure {
  id: number;
  type: number;
  x: number;
  z: number;
  rot: number;
  lvl: number;
  base: number;
  /** Bit 0 jammed, bit 1 packager busy. */
  flags: number;
  rect: Rect;
}

/** Axis-aligned world rectangle. */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A port in world space: point, heading, deck height. */
export interface WorldPort {
  x: number;
  z: number;
  hx: number;
  hz: number;
  y: number;
}

const z0 = (v: number): number => v + 0;

/** Local (x, z) → world offset for quarter turn `rot` (local x → (cos θ, −sin θ), local z → (sin θ, cos θ), θ = −rot·π/2). */
export function rotate(rot: number, x: number, z: number): [number, number] {
  switch (rot & 3) {
    case 1: return [z0(-z), z0(x)];
    case 2: return [z0(-x), z0(-z)];
    case 3: return [z0(z), z0(-x)];
    default: return [z0(x), z0(z)];
  }
}

/** World offset → local (x, z) (inverse of {@link rotate}). */
export function unrotate(rot: number, x: number, z: number): [number, number] {
  return rotate((4 - (rot & 3)) & 3, x, z);
}

/** World footprint of a type at (x, z, rot): w × d, swapped for an odd rot. */
export function footprint(type: number, x: number, z: number, rot: number): Rect {
  const spec = structSpec(type);
  const odd = (rot & 1) === 1;
  const hw = (odd ? spec.d : spec.w) / 2;
  const hd = (odd ? spec.w : spec.d) / 2;
  return { minX: x - hw, maxX: x + hw, minZ: z - hd, maxZ: z + hd };
}

export const shrink = (r: Rect, by: number): Rect => ({ minX: r.minX + by, maxX: r.maxX - by, minZ: r.minZ + by, maxZ: r.maxZ - by });
export const expand = (r: Rect, by: number): Rect => shrink(r, -by);
export const rectsOverlap = (a: Rect, b: Rect): boolean => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
export const inRect = (r: Rect, x: number, z: number, eps = 1e-9): boolean =>
  x >= r.minX - eps && x <= r.maxX + eps && z >= r.minZ - eps && z <= r.maxZ + eps;

/** Distance from (x, z) to the rectangle (0 inside). */
export function rectDistance(r: Rect, x: number, z: number): number {
  const dx = Math.max(r.minX - x, 0, x - r.maxX);
  const dz = Math.max(r.minZ - z, 0, z - r.maxZ);
  return Math.hypot(dx, dz);
}

/** True when the circle overlaps the rectangle's interior. */
export const rectHitsCircle = (r: Rect, x: number, z: number, radius: number): boolean => rectDistance(r, x, z) < radius;

/** True when the rectangle overlaps a layout-style collider's footprint (SAT for a rotated box). */
export function rectHitsCollider(r: Rect, c: Collider): boolean {
  if (c.shape === 'cyl') return rectHitsCircle(r, c.x, c.z, c.r);
  const ux: [number, number] = [Math.cos(c.rotY), -Math.sin(c.rotY)];
  const uz: [number, number] = [Math.sin(c.rotY), Math.cos(c.rotY)];
  const corners: Array<[number, number]> = [];
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) corners.push([c.x + (su * c.w * ux[0]) / 2 + (sv * c.d * uz[0]) / 2, c.z + (su * c.w * ux[1]) / 2 + (sv * c.d * uz[1]) / 2]);
  }
  const rc: Array<[number, number]> = [[r.minX, r.minZ], [r.maxX, r.minZ], [r.minX, r.maxZ], [r.maxX, r.maxZ]];
  const separated = (axis: readonly [number, number], a: Array<[number, number]>, b: Array<[number, number]>): boolean => {
    const pa = a.map(([x, z]) => x * axis[0] + z * axis[1]);
    const pb = b.map(([x, z]) => x * axis[0] + z * axis[1]);
    return Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa);
  };
  return ![[1, 0] as const, [0, 1] as const, ux, uz].some((axis) => separated(axis, rc, corners));
}

/** Sample coordinates along one axis: the 0.5 m lattice inside, plus both edges, each kept 0.01 m inside. */
function axisSamples(min: number, max: number): number[] {
  const out = [min + 0.01];
  for (let k = Math.floor(min * 2) + 1; k / 2 < max; k++) if (k / 2 > min) out.push(k / 2);
  out.push(max - 0.01);
  return [...new Set(out)].filter((v) => v >= min && v <= max).sort((a, b) => a - b);
}

/** The footprint samples of D.3 rules 3 and 7. */
export function footprintSamples(r: Rect): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const z of axisSamples(r.minZ, r.maxZ)) for (const x of axisSamples(r.minX, r.maxX)) out.push([x, z]);
  return out;
}

/** World port of a placed structure. */
export function worldPort(s: Pick<Structure, 'x' | 'z' | 'rot' | 'lvl' | 'base'>, p: PortSpec): WorldPort {
  const [ox, oz] = rotate(s.rot, p.x, p.z);
  const [hx, hz] = rotate(s.rot, p.hx, p.hz);
  return { x: s.x + ox, z: s.z + oz, hx, hz, y: s.base + deckOffset(s.lvl + p.dl) };
}

/** Port hash key: millimetres. */
export const portKey = (x: number, z: number): string => `${Math.round(x * 1000)},${Math.round(z * 1000)}`;

/** Local point of a cargo at `s` (m) on a structure's path; `way` = splitter route or merger entry (0 left, 1 right). */
export function localPathPoint(type: number, s: number, way: number): { x: number; z: number; t: number } {
  const spec = structSpec(type);
  const t = spec.len > 0 ? Math.min(1, Math.max(0, s / spec.len)) : 0;
  switch (spec.family) {
    case 'bendL': {
      const phi = t * (Math.PI / 2);
      return { x: -0.5 + 0.5 * Math.cos(phi), z: 0.5 - 0.5 * Math.sin(phi), t };
    }
    case 'bendR': {
      const phi = t * (Math.PI / 2);
      return { x: 0.5 - 0.5 * Math.cos(phi), z: 0.5 - 0.5 * Math.sin(phi), t };
    }
    case 'splitter': {
      if (s <= 0.5) return { x: 0, z: 0.5 - s, t };
      const u = s - 0.5;
      return way === 1 ? { x: -u, z: 0, t } : way === 2 ? { x: u, z: 0, t } : { x: 0, z: -u, t };
    }
    case 'merger':
      if (s <= 0.5) return { x: way === 1 ? 0.5 - s : -0.5 + s, z: 0, t };
      return { x: 0, z: -(s - 0.5), t };
    default:
      return { x: 0, z: spec.d / 2 - t * spec.d, t };
  }
}

/** World point (and deck y) of a cargo at `s` on structure `st`. */
export function pathPoint(st: Structure, s: number, way: number): { x: number; y: number; z: number } {
  const p = localPathPoint(st.type, s, way);
  const [ox, oz] = rotate(st.rot, p.x, p.z);
  const dl = structSpec(st.type).outs[0]?.dl ?? 0;
  return { x: st.x + ox, y: st.base + deckOffset(st.lvl) + 0.9 * dl * p.t, z: st.z + oz };
}

/** Projected path position of world point (x, z) on a belt-like structure, in m (not clamped). */
export function projectS(st: Structure, x: number, z: number): number {
  const spec = structSpec(st.type);
  const [lx, lz] = unrotate(st.rot, x - st.x, z - st.z);
  if (spec.family === 'bendL') return 0.5 * Math.atan2(-(lz - 0.5), lx + 0.5);
  if (spec.family === 'bendR') return 0.5 * Math.atan2(-(lz - 0.5), -(lx - 0.5));
  return ((spec.d / 2 - lz) / spec.d) * spec.len;
}

/** Deck height of a belt-like structure over (x, z) (ramps interpolate). */
export function deckAt(st: Structure, x: number, z: number): number {
  const spec = structSpec(st.type);
  const dl = spec.outs[0]?.dl ?? 0;
  const t = spec.len > 0 ? Math.min(1, Math.max(0, projectS(st, x, z) / spec.len)) : 0;
  return st.base + deckOffset(st.lvl) + 0.9 * dl * t;
}

/** Height of the highest deck above the base. */
export function highestDeck(type: number, lvl: number): number {
  const spec = structSpec(type);
  return deckOffset(Math.max(lvl, lvl + (spec.outs[0]?.dl ?? 0)));
}

/** The structure's collider (world-space box like a layout collider), or null (hopper). `groundAtCentre` for foundations. */
export function colliderOf(st: Structure, groundAtCentre: number): Collider | null {
  const spec = structSpec(st.type);
  const r = st.rect;
  const box = (h: number): Collider => ({ shape: 'box', x: st.x, z: st.z, w: r.maxX - r.minX, d: r.maxZ - r.minZ, h, rotY: 0 });
  switch (spec.collider.kind) {
    case 'found': return box(st.base - groundAtCentre);
    case 'deck': return box(highestDeck(st.type, st.lvl));
    case 'fixed': return box(spec.collider.h);
    default: return null;
  }
}

/** True for a structure whose collider blocks players (h > 0.35). */
export function blocksPlayers(type: number, lvl: number, base: number, groundAtCentre: number): boolean {
  const spec = structSpec(type);
  if (spec.collider.kind === 'fixed') return spec.collider.h > 0.35;
  if (spec.collider.kind === 'deck') return highestDeck(type, lvl) > 0.35;
  if (spec.collider.kind === 'found') return base - groundAtCentre > 0.35;
  return false;
}

