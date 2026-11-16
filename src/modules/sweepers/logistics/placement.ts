// Placement rules (plan D.3), server-authoritative; the client copies them for the ghost colour.
// Footprint samples are the 0.5 m lattice plus the edges, each kept 0.01 m inside (see footprintSamples).
import type { CityLayout, Collider } from '../city/layoutTypes.ts';
import type { ColliderIndex } from '../geometry.ts';
import { hexAt } from '../hexGrid.ts';
import { refusal, SWEEPERS_ERRORS, SweepersError } from '../SweepersError.ts';
import { blocksPlayers, footprint, footprintSamples, inRect, rectHitsCircle, rectHitsCollider, rectsOverlap, shrink } from './shapes.ts';
import type { Rect, Structure } from './shapes.ts';
import { CAP_NAMES, CAPS, CRANE, FIRST_MACHINE, isBeltLike, isFoundation, isMachine, structSpec, TYPE } from './tables.ts';

export const PLACE_REACH_M = 10;
export const MAX_ABS_XZ = 256;
const PLAYER_R = 0.35;
const OVERLAP_SHRINK = 0.01;

/** A parsed `place_structure` (without the channel). */
export interface PlaceSpec {
  type: number;
  x: number;
  z: number;
  rot: number;
  lvl: number;
}

/** What the rules read from the room. Players and bags are left out on a persistence reload. */
export interface PlacementWorld {
  layout: CityLayout;
  ground(x: number, z: number): number;
  unlocked: ReadonlySet<number>;
  /** Blocking (h > 0.35) layout colliders. */
  layoutColliders: ColliderIndex;
  structures: readonly Structure[];
  groundBags: ReadonlyArray<{ x: number; z: number; r: number }>;
  /** Vehicle body circles and spawn slots (Phase F); absent on a persistence reload. */
  vehicles?: ReadonlyArray<{ x: number; z: number; r: number }>;
  players: ReadonlyArray<{ x: number; z: number }>;
  /** Bought machine blueprints (bit = type − 14, Phase E rule 5b). */
  blueprints: number;
}

/** The crane legs: cylinders at the working-area corners, added to every room's colliders. */
export const CRANE_LEGS: readonly Collider[] = Object.freeze([
  [CRANE.area.minX, CRANE.area.minZ], [CRANE.area.maxX, CRANE.area.minZ], [CRANE.area.minX, CRANE.area.maxZ], [CRANE.area.maxX, CRANE.area.maxZ]
].map(([x, z]): Collider => ({ shape: 'cyl', x: x ?? 0, z: z ?? 0, r: CRANE.legR, h: CRANE.legH })));

export const CRANE_AREA: Rect = Object.freeze({ ...CRANE.area });

/** Reserved rectangles of rule 4 (the console is a 1 m circle, checked separately). */
export function reservedRects(layout: CityLayout): Rect[] {
  const wb = layout.landmarks.weighbridge;
  const hop = layout.landmarks.hopper;
  const odd = (r: number): boolean => Math.abs(Math.sin(r)) > 0.5;
  const half = (w: number, d: number, rotY: number): [number, number] => (odd(rotY) ? [d / 2, w / 2] : [w / 2, d / 2]);
  const [wbx, wbz] = half(wb.w, wb.d, wb.rotY);
  const [hx, hz] = half(hop.w, hop.d, hop.rotY);
  return [
    { minX: wb.x - wbx - 1, maxX: wb.x + wbx + 1, minZ: wb.z - wbz - 1, maxZ: wb.z + wbz + 1 },
    { minX: hop.x - hx, maxX: hop.x + hx, minZ: hop.z - hz, maxZ: hop.z + hz },
    CRANE_AREA
  ];
}

/** `x`, `z` multiples of 0.5, finite, |·| ≤ 256 (rule 1; a guard failure is a VALIDATION_ERROR). */
export const onLattice = (v: number): boolean => Number.isFinite(v) && Number.isInteger(v * 2) && Math.abs(v) <= MAX_ABS_XZ;

/** Belt path length counted by the cap (types 2–10, by `len`). */
export const beltLen = (type: number): number => (isBeltLike(type) ? structSpec(type).len : 0);

/** Counts against the room caps; returns the exceeded cap's name, or null. */
export function exceededCap(structures: Iterable<Structure>, type: number): string | null {
  let total = 0;
  let found = 0;
  let belt = 0;
  let junctions = 0;
  let hoppers = 0;
  let packagers = 0;
  let fences = 0;
  let machines = 0;
  let garages = 0;
  for (const s of structures) {
    total++;
    if (isFoundation(s.type)) found++;
    belt += beltLen(s.type);
    if (s.type === TYPE.splitter || s.type === TYPE.merger) junctions++;
    if (s.type === TYPE.hopper) hoppers++;
    if (s.type === TYPE.packager) packagers++;
    if (s.type === TYPE.fence) fences++;
    if (isMachine(s.type)) machines++;
    if (s.type === TYPE.garage) garages++;
  }
  if (total + 1 > CAPS.structures) return CAP_NAMES.structures;
  if (isFoundation(type) && found + 1 > CAPS.foundations) return CAP_NAMES.foundations;
  if (belt + beltLen(type) > CAPS.beltM + 1e-9) return CAP_NAMES.beltM;
  if ((type === TYPE.splitter || type === TYPE.merger) && junctions + 1 > CAPS.junctions) return CAP_NAMES.junctions;
  if (type === TYPE.hopper && hoppers + 1 > CAPS.hoppers) return CAP_NAMES.hoppers;
  if (type === TYPE.packager && packagers + 1 > CAPS.packagers) return CAP_NAMES.packagers;
  if (type === TYPE.fence && fences + 1 > CAPS.fences) return CAP_NAMES.fences;
  if (isMachine(type) && machines + 1 > CAPS.machines) return CAP_NAMES.machines;
  if (type === TYPE.garage && garages + 1 > CAPS.garages) return CAP_NAMES.garages;
  return null;
}

/** ceil to 0.1 m (with a float guard). */
const ceil10 = (v: number): number => Math.ceil(v * 10 - 1e-9) / 10;

/** True when two rectangles share an edge segment of positive length. */
function edgeAdjacent(a: Rect, b: Rect): boolean {
  const eq = (u: number, v: number): boolean => Math.abs(u - v) < 1e-9;
  const zOverlap = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 1e-9;
  const xOverlap = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 1e-9;
  return ((eq(a.maxX, b.minX) || eq(b.maxX, a.minX)) && zOverlap) || ((eq(a.maxZ, b.minZ) || eq(b.maxZ, a.minZ)) && xOverlap);
}

/**
 * Checks D.3 rules 2–7 (with E's 5b, the blueprint) in order and returns the base height (a foundation's
 * top). `pose` null skips rule 2 and `caps` false skips rule 5 (persistence reload applies caps itself, in id order).
 */
export function checkPlacement(world: PlacementWorld, spec: PlaceSpec, pose: { x: number; z: number } | null, caps = true): number {
  const rect = footprint(spec.type, spec.x, spec.z, spec.rot);
  if (pose && Math.hypot(spec.x - pose.x, spec.z - pose.z) > PLACE_REACH_M) throw refusal('tooFar');
  const samples = footprintSamples(rect);
  for (const [x, z] of samples) {
    const hex = hexAt(x, z);
    if (!hex) throw refusal('outOfGrid');
    if (!world.unlocked.has(hex.district)) throw refusal('lockedDistrict');
  }
  const inner = shrink(rect, OVERLAP_SHRINK);
  const console = CRANE.console;
  if (reservedRects(world.layout).some((r) => rectsOverlap(inner, r)) || rectHitsCircle(inner, console.x, console.z, 1)) throw refusal('reserved');
  const structures = world.structures;
  if (caps) {
    const what = exceededCap(structures, spec.type);
    if (what !== null) throw new SweepersError(SWEEPERS_ERRORS.buildLimit.replace('{what}', what), { reason: 'buildLimit', what });
  }
  if (isMachine(spec.type) && (world.blueprints & (1 << (spec.type - FIRST_MACHINE))) === 0) throw refusal('noBlueprint');
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const reach = Math.hypot(rect.maxX - rect.minX, rect.maxZ - rect.minZ) / 2;
  if (world.layoutColliders.near(cx, cz, reach).some((c) => rectHitsCollider(inner, c))) throw refusal('blocked');
  if (CRANE_LEGS.some((c) => rectHitsCollider(inner, c))) throw refusal('blocked');
  const base = baseHeight(world, spec, rect, samples, structures);
  const foundation = isFoundation(spec.type);
  for (const other of structures) {
    if (!rectsOverlap(inner, other.rect)) continue;
    if (foundation || !isFoundation(other.type)) throw refusal('blocked');
  }
  for (const bag of world.groundBags) if (rectHitsCircle(inner, bag.x, bag.z, bag.r)) throw refusal('blocked');
  for (const body of world.vehicles ?? []) if (rectHitsCircle(inner, body.x, body.z, body.r)) throw refusal('blocked');
  const groundC = world.ground(spec.x, spec.z);
  if (blocksPlayers(spec.type, spec.lvl, base ?? groundC, groundC)) {
    for (const p of world.players) if (rectHitsCircle(inner, p.x, p.z, PLAYER_R)) throw refusal('blocked');
  }
  if (base === null) throw refusal('notFlat');
  return base;
}

/** Rule 7: the base (a foundation's top), or null for `notFlat`. */
function baseHeight(world: PlacementWorld, spec: PlaceSpec, rect: Rect, samples: Array<[number, number]>, structures: readonly Structure[]): number | null {
  const grounds = samples.map(([x, z]) => world.ground(x, z));
  const maxG = Math.max(...grounds);
  const minG = Math.min(...grounds);
  if (isFoundation(spec.type)) {
    if (maxG - minG > 0.8 + 1e-9) return null;
    const top = ceil10(maxG + 0.2);
    const neighbour = structures.find((o) => isFoundation(o.type) && edgeAdjacent(rect, o.rect) && Math.abs(o.base - top) <= 0.5 + 1e-9);
    return neighbour ? neighbour.base : top;
  }
  const tops = samples.map(([x, z]) => structures.filter((o) => isFoundation(o.type) && inRect(o.rect, x, z)).map((o) => o.base));
  const covered = tops.filter((t) => t.length > 0).length;
  if (covered === samples.length) {
    const first = tops[0]?.[0] ?? 0;
    return tops.every((t) => t.every((top) => Math.abs(top - first) < 1e-9)) ? first : null;
  }
  if (covered === 0) return maxG - minG > 0.3 + 1e-9 ? null : maxG;
  return null;
}
