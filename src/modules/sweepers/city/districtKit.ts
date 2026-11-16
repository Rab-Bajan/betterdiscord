// Shared helpers of the district generators: slots inside a hex between its road spokes.
import { axialToWorld } from '../hexGrid.ts';
import type { HexCell } from '../hexGrid.ts';
import type { LayoutBuilder } from './LayoutBuilder.ts';
import type { RoadSegment } from './roads.ts';
import { rotationAlong } from './rotation.ts';

/** What every district generator receives. */
export interface DistrictContext {
  builder: LayoutBuilder;
  district: number;
  /** The grid hexes of this district, in id order. */
  cells: readonly HexCell[];
  /** The main road network (already in the layout). */
  roads: readonly RoadSegment[];
}

/** A candidate spot in a hex: world position and its direction from the hex centre. */
export interface Slot {
  x: number;
  z: number;
  /** Direction from the hex centre, radians CCW from +x. */
  angle: number;
}

export const hexCentre = (cell: HexCell): { x: number; z: number } => axialToWorld(cell);

/** The six corner directions of a pointy-top hex (30°, 90°, …): always between two road spokes. */
export const CORNER_ANGLES: readonly number[] = [0, 1, 2, 3, 4, 5].map((k) => Math.PI / 6 + (k * Math.PI) / 3);

/** A spot `dist` metres from the hex centre in direction `angle`. */
export function slotAt(cell: HexCell, angle: number, dist: number): Slot {
  const c = hexCentre(cell);
  return { x: c.x + Math.cos(angle) * dist, z: c.z + Math.sin(angle) * dist, angle };
}

/** The six corner slots at `dist` metres. */
export const cornerSlots = (cell: HexCell, dist: number): Slot[] => CORNER_ANGLES.map((a) => slotAt(cell, a, dist));

/** Rotation whose local x axis runs tangentially around the hex centre at `angle` (local +z then points to the centre). */
export const tangentRotation = (angle: number): number => rotationAlong(-Math.sin(angle), Math.cos(angle));

/** Rotation whose local x axis points away from the hex centre at `angle`. */
export const radialRotation = (angle: number): number => rotationAlong(Math.cos(angle), Math.sin(angle));

/** A random point in the hex, at most `maxDist` from its centre (used for scatter attempts). */
export function randomSpot(ctx: DistrictContext, cell: HexCell, minDist: number, maxDist: number): Slot {
  const angle = ctx.builder.rng.range(0, 2 * Math.PI);
  return slotAt(cell, angle, ctx.builder.rng.range(minDist, maxDist));
}

/** Tries `attempts` random spots in every hex of the district for prop `place`. */
export function scatter(ctx: DistrictContext, attempts: number, minDist: number, maxDist: number, place: (cell: HexCell, slot: Slot) => void): void {
  for (const cell of ctx.cells) {
    for (let i = 0; i < attempts; i++) place(cell, randomSpot(ctx, cell, minDist, maxDist));
  }
}
