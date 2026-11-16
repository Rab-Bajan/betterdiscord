// The main road network joining the districts, its curbs (step-over colliders with ramps at the
// ends), street lamps and rain puddles.
import { axialDistance, axialToWorld, HEX_CELLS } from '../hexGrid.ts';
import type { HexCell } from '../hexGrid.ts';
import type { LayoutBuilder } from './LayoutBuilder.ts';
import type { BoxCollider } from './layoutTypes.ts';
import { offset, rotationAlong } from './rotation.ts';

export const ROAD_WIDTH = 7;
export const CURB_HEIGHT = 0.15;
const CURB_DEPTH = 0.25;
/** Curbs stop this far from a junction (hex centre), so crossing roads stay open. */
const JUNCTION_TRIM = 8;
const LAMP_SPACING = 30;

/** The three yard gates of the centre district (Központi MÉH Telep), on the fence line. */
export const YARD_HALF_W = 25;
export const YARD_HALF_D = 18;
/** Gate directions from the origin (towards Avas, Újgyőri Piac, Búza tér), radians CCW from +x. */
export const YARD_GATE_ANGLES: readonly number[] = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];

/** Where the ray from the origin at `angle` leaves the yard rectangle. */
export function yardGate(angle: number): [number, number] {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const t = Math.min(Math.abs(dx) > 1e-9 ? YARD_HALF_W / Math.abs(dx) : Infinity, Math.abs(dz) > 1e-9 ? YARD_HALF_D / Math.abs(dz) : Infinity);
  return [dx * t, dz * t];
}

/** One straight piece of the main network; a junction end is a hex centre. */
export interface RoadSegment {
  a: [number, number];
  b: [number, number];
  aJunction: boolean;
  bJunction: boolean;
}

const centre = (cell: HexCell): [number, number] => {
  const { x, z } = axialToWorld(cell);
  return [x, z];
};

const neighbours = (a: HexCell, b: HexCell): boolean => axialDistance({ q: a.q - b.q, r: a.r - b.r }) === 1;

/**
 * Segments: the yard gates to their ring-1 hexes, the ring-1 hexes in a cycle, and every outer hex
 * to its parent one ring in (preferring a parent of the same district, then the lower id).
 */
export function mainRoadSegments(): RoadSegment[] {
  const segments: RoadSegment[] = [];
  for (const angle of YARD_GATE_ANGLES) {
    const target = HEX_CELLS.find((c) => axialDistance(c) === 1 && Math.abs(Math.atan2(centre(c)[1], centre(c)[0]) - normalisePi(angle)) < 1e-6);
    if (target) segments.push({ a: yardGate(angle), b: centre(target), aJunction: false, bJunction: true });
  }
  const ring1 = HEX_CELLS.filter((c) => axialDistance(c) === 1);
  ring1.forEach((cell, i) => {
    const next = ring1[(i + 1) % ring1.length];
    if (next) segments.push({ a: centre(cell), b: centre(next), aJunction: true, bJunction: true });
  });
  for (const cell of HEX_CELLS) {
    const ring = axialDistance(cell);
    if (ring < 2) continue;
    const parents = HEX_CELLS.filter((c) => axialDistance(c) === ring - 1 && neighbours(c, cell));
    const parent = parents.find((p) => p.district === cell.district) ?? parents[0];
    if (parent) segments.push({ a: centre(parent), b: centre(cell), aJunction: true, bJunction: true });
  }
  return segments;
}

function normalisePi(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/** Directions (radians CCW from +x) of the main roads leaving `cell`'s centre. */
export function spokeAngles(segments: readonly RoadSegment[], cell: HexCell): number[] {
  const [cx, cz] = centre(cell);
  const angles: number[] = [];
  for (const s of segments) {
    if (s.aJunction && Math.hypot(s.a[0] - cx, s.a[1] - cz) < 1e-6) angles.push(Math.atan2(s.b[1] - cz, s.b[0] - cx));
    if (s.bJunction && Math.hypot(s.b[0] - cx, s.b[1] - cz) < 1e-6) angles.push(Math.atan2(s.a[1] - cz, s.a[0] - cx));
  }
  return angles;
}

/** Adds the main roads to the layout. */
export function addMainRoads(builder: LayoutBuilder, segments: readonly RoadSegment[]): void {
  for (const s of segments) builder.addRoad('road', ROAD_WIDTH, [s.a, s.b]);
}

/** Curb colliders (step-over, 0.15 m) along both road edges, with a curb ramp at the outer end of each. */
export function curbsFor(builder: LayoutBuilder, segments: readonly RoadSegment[]): BoxCollider[] {
  const curbs: BoxCollider[] = [];
  for (const s of segments) {
    const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const rotY = rotationAlong(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const start = s.aJunction ? JUNCTION_TRIM : 0.5;
    const end = length - (s.bJunction ? JUNCTION_TRIM : 0.5);
    const mid = (start + end) / 2 - length / 2;
    for (const side of [-1, 1]) {
      const v = side * (ROAD_WIDTH / 2 + CURB_DEPTH / 2);
      const [x, z] = offset((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, rotY, mid, v);
      curbs.push({ shape: 'box', x, z, w: end - start, d: CURB_DEPTH, h: CURB_HEIGHT, rotY });
      // A ramp where the curb meets the outer junction (the crossing pedestrians use).
      const [rx, rz] = offset(s.a[0], s.a[1], rotY, end, v);
      builder.addProp('curb_ramp', rx, rz, rotY);
    }
  }
  return curbs;
}

/** Street lamps along the sidewalks (alternating sides), skipping spots something already took. */
export function addStreetLamps(builder: LayoutBuilder, segments: readonly RoadSegment[]): void {
  for (const s of segments) {
    const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const rotY = rotationAlong(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    let side = 1;
    for (let u = 12; u < length - 10; u += LAMP_SPACING) {
      const [x, z] = offset(s.a[0], s.a[1], rotY, u, side * (ROAD_WIDTH / 2 + 1.2));
      builder.placeProp('street_lamp', x, z, rotY, 1, { roadMargin: 0.6, gap: 0.5 });
      side = -side;
    }
  }
}

/** Rain puddles (wet) on about half of the road segments. */
export function addPuddles(builder: LayoutBuilder, segments: readonly RoadSegment[]): void {
  const rng = builder.rng;
  for (const s of segments) {
    if (!rng.chance(0.5)) continue;
    const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const rotY = rotationAlong(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    const [x, z] = offset(s.a[0], s.a[1], rotY, rng.range(0.25, 0.75) * length, rng.range(-2, 2));
    builder.addSurface('wet', x, z, rng.range(1.2, 3));
  }
}
