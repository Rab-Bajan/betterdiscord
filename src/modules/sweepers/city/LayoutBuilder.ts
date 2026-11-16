// Accumulates the city layout while the district generators place things into it, and refuses any
// placement that would overlap a road, another footprint, the spawn area or leave its hex.
import { axialToWorld, HEX_OUTER_RADIUS } from '../hexGrid.ts';
import type { HexCell } from '../hexGrid.ts';
import { isBlocking } from '../geometry.ts';
import { Rng } from '../random.ts';
import { propColliders } from './colliders.ts';
import type { Building, BuildingKind, Collider, Prop, PropKind, Road, RoadKind, Surface, SurfaceKind } from './layoutTypes.ts';
import { axisU, axisV } from './rotation.ts';

/** Centre-to-edge distance of a hex. */
export const HEX_INNER_RADIUS = (HEX_OUTER_RADIUS * Math.sqrt(3)) / 2;
/** Nothing that blocks may come closer than this to the origin (Phase A spawn points lie 3–6 m out). */
export const SPAWN_CLEAR_RADIUS = 8;

/** Oriented footprint: centre, half extents along local x / z, rotation. */
interface Footprint {
  x: number;
  z: number;
  hw: number;
  hd: number;
  rotY: number;
}

type Vec = readonly [number, number];

/** Placement rules; every check is on unless switched off. */
export interface PlaceOptions {
  /** The footprint must lie inside this hex, `hexInset` metres from its edges (default 1). */
  hex?: HexCell;
  hexInset?: number;
  /** Clearance beyond a road's half width (default 1.5: sidewalk). */
  roadMargin?: number;
  /** Road kinds this footprint may stand on (an ore wagon on its rail). */
  onRoads?: readonly RoadKind[];
  /** Free gap to other footprints (default 0.8). */
  gap?: number;
  /** Skip the footprint overlap check (a shelter standing on its platform, a kukatároló at its block). */
  overlapOk?: boolean;
  /** Do not register a footprint (decor others may stand next to or on). */
  noFootprint?: boolean;
}

function corners(f: Footprint): Vec[] {
  const [ux, uz] = axisU(f.rotY);
  const [vx, vz] = axisV(f.rotY);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a = 0, b = 0]) =>
    [f.x + a * f.hw * ux + b * f.hd * vx, f.z + a * f.hw * uz + b * f.hd * vz] as const);
}

function pointToFootprint(f: Footprint, px: number, pz: number): number {
  const dx = px - f.x;
  const dz = pz - f.z;
  const cos = Math.cos(f.rotY);
  const sin = Math.sin(f.rotY);
  const u = dx * cos - dz * sin;
  const v = dx * sin + dz * cos;
  return Math.hypot(Math.max(0, Math.abs(u) - f.hw), Math.max(0, Math.abs(v) - f.hd));
}

function pointToSegment(px: number, pz: number, a: Vec, b: Vec): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - a[0]) * dx + (pz - a[1]) * dz) / len2));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
}

function segmentsCross(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Distance between a footprint and a segment (0 when they touch). */
export function footprintToSegment(f: Footprint, a: Vec, b: Vec): number {
  if (pointToFootprint(f, a[0], a[1]) === 0 || pointToFootprint(f, b[0], b[1]) === 0) return 0;
  const cs = corners(f);
  let best = Math.min(pointToFootprint(f, a[0], a[1]), pointToFootprint(f, b[0], b[1]));
  for (let i = 0; i < 4; i++) {
    const p = cs[i] ?? [0, 0];
    const q = cs[(i + 1) % 4] ?? [0, 0];
    if (segmentsCross(a, b, p, q)) return 0;
    best = Math.min(best, pointToSegment(p[0], p[1], a, b));
  }
  return best;
}

/** Separating-axis overlap of two footprints, each grown by `gap / 2`. */
function footprintsOverlap(a: Footprint, b: Footprint, gap: number): boolean {
  const grow = (f: Footprint): Footprint => ({ ...f, hw: f.hw + gap / 2, hd: f.hd + gap / 2 });
  const fa = grow(a);
  const fb = grow(b);
  const ca = corners(fa);
  const cb = corners(fb);
  for (const axis of [axisU(fa.rotY), axisV(fa.rotY), axisU(fb.rotY), axisV(fb.rotY)]) {
    const project = (cs: Vec[]): [number, number] => {
      const values = cs.map(([x, z]) => x * axis[0] + z * axis[1]);
      return [Math.min(...values), Math.max(...values)];
    };
    const [minA, maxA] = project(ca);
    const [minB, maxB] = project(cb);
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

/** True when every point lies inside the hex, at least `inset` from its edges. */
function insideHex(cell: HexCell, points: readonly Vec[], inset: number): boolean {
  const c = axialToWorld(cell);
  const limit = HEX_INNER_RADIUS - inset;
  return points.every(([x, z]) => [0, Math.PI / 3, (2 * Math.PI) / 3].every((angle) =>
    Math.abs((x - c.x) * Math.cos(angle) + (z - c.z) * Math.sin(angle)) <= limit));
}

/** Footprints of colliders (a cylinder counts as its bounding square). */
function footprintOf(colliders: readonly Collider[]): Footprint[] {
  return colliders.map((c) => c.shape === 'cyl'
    ? { x: c.x, z: c.z, hw: c.r, hd: c.r, rotY: 0 }
    : { x: c.x, z: c.z, hw: c.w / 2, hd: c.d / 2, rotY: c.rotY });
}

export class LayoutBuilder {
  readonly rng: Rng;
  readonly roads: Road[] = [];
  readonly buildings: Building[] = [];
  readonly props: Prop[] = [];
  readonly surfaces: Surface[] = [];
  readonly #footprints: Footprint[] = [];
  readonly #idCounts = new Map<number, number>();

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  addRoad(kind: RoadKind, width: number, points: Array<[number, number]>): void {
    this.roads.push({ kind, width, points });
  }

  addSurface(kind: SurfaceKind, x: number, z: number, r: number): void {
    this.surfaces.push({ kind, shape: 'circle', x, z, r });
  }

  /** Places a building when its footprint passes the checks; returns it, or null when refused. */
  placeBuilding(
    kind: BuildingKind, district: number, at: { x: number; z: number; w: number; d: number; h: number; rotY: number },
    options: PlaceOptions = {}
  ): Building | null {
    const footprint: Footprint = { x: at.x, z: at.z, hw: at.w / 2, hd: at.d / 2, rotY: at.rotY };
    if (!this.#fits([footprint], options)) return null;
    // Short ids keep the layout compact: `<district>-<n>`, numbered per district in placement order.
    const n = (this.#idCounts.get(district) ?? 0) + 1;
    this.#idCounts.set(district, n);
    const building: Building = { id: `${district}-${n}`, kind, district, ...at };
    this.buildings.push(building);
    if (!options.noFootprint) this.#footprints.push(footprint);
    return building;
  }

  /**
   * Places a prop when it passes the checks. A blocking prop is checked like a building (its collider
   * is its footprint); a decor prop is checked against roads, hex and spawn area but blocks nothing.
   */
  placeProp(kind: PropKind, x: number, z: number, rotY = 0, s = 1, options: PlaceOptions = {}): boolean {
    const prop: Prop = { kind, x, z, rotY, s };
    const footprints = footprintOf(propColliders(prop).filter(isBlocking));
    if (footprints.length > 0) {
      if (!this.#fits(footprints, options)) return false;
      if (!options.noFootprint) this.#footprints.push(...footprints);
    } else if (!this.#fits([{ x, z, hw: 0.3 * s, hd: 0.3 * s, rotY }], { ...options, overlapOk: true })) {
      return false;
    }
    this.props.push(prop);
    return true;
  }

  /** Adds a prop with no checks (decor that belongs exactly there: facade dishes, curb ramps, tape). */
  addProp(kind: PropKind, x: number, z: number, rotY = 0, s = 1): void {
    this.props.push({ kind, x, z, rotY, s });
  }

  /** True when a footprint of this size would pass the checks here (nothing is placed). */
  fitsArea(x: number, z: number, w: number, d: number, rotY: number, options: PlaceOptions = {}): boolean {
    return this.#fits([{ x, z, hw: w / 2, hd: d / 2, rotY }], options);
  }

  /** Registers an explicit footprint (an area the generators must keep clear, e.g. a yard lane). */
  reserve(x: number, z: number, w: number, d: number, rotY: number): void {
    this.#footprints.push({ x, z, hw: w / 2, hd: d / 2, rotY });
  }

  #fits(footprints: readonly Footprint[], options: PlaceOptions): boolean {
    const roadMargin = options.roadMargin ?? 1.5;
    const gap = options.gap ?? 0.8;
    for (const f of footprints) {
      if (options.hex && !insideHex(options.hex, corners(f), options.hexInset ?? 1)) return false;
      if (pointToFootprint(f, 0, 0) < SPAWN_CLEAR_RADIUS) return false;
      for (const road of this.roads) {
        if (options.onRoads?.includes(road.kind)) continue;
        const clearance = road.width / 2 + roadMargin;
        for (let i = 1; i < road.points.length; i++) {
          const a = road.points[i - 1];
          const b = road.points[i];
          if (a && b && footprintToSegment(f, a, b) < clearance) return false;
        }
      }
      if (!options.overlapOk && this.#footprints.some((other) => footprintsOverlap(f, other, gap))) return false;
    }
    return true;
  }
}
