// The ground: flat city at 0 m, with the Avas hillside (district 5, Avas Kilátó & Parkerdő) rising
// to a summit south-east of the centre.
import type { Heightfield } from './layoutTypes.ts';

export const HEIGHTFIELD_ORIGIN = -300;
export const HEIGHTFIELD_CELL = 10;
export const HEIGHTFIELD_SIZE = 61;

/** Summit of the hill (the TV tower stands on it). */
export const HILL_PEAK = Object.freeze({ x: 139, z: -95 });
export const HILL_HEIGHT = 30;
/** Beyond this distance from the summit the ground is flat (the centre hex is well outside). */
export const HILL_RADIUS = 115;

/** Analytic terrain height (m): a cosine-shaped hill, 0 elsewhere. */
export function terrainHeight(x: number, z: number): number {
  const d = Math.hypot(x - HILL_PEAK.x, z - HILL_PEAK.z);
  if (d >= HILL_RADIUS) return 0;
  return HILL_HEIGHT * 0.5 * (1 + Math.cos((Math.PI * d) / HILL_RADIUS));
}

/** The terrain sampled on the layout grid (whole centimetres). */
export function buildHeightfield(): Heightfield {
  const heightsCm: number[] = [];
  for (let iz = 0; iz < HEIGHTFIELD_SIZE; iz++) {
    for (let ix = 0; ix < HEIGHTFIELD_SIZE; ix++) {
      const x = HEIGHTFIELD_ORIGIN + ix * HEIGHTFIELD_CELL;
      const z = HEIGHTFIELD_ORIGIN + iz * HEIGHTFIELD_CELL;
      heightsCm.push(Math.round(terrainHeight(x, z) * 100));
    }
  }
  return { origin: HEIGHTFIELD_ORIGIN, cell: HEIGHTFIELD_CELL, size: HEIGHTFIELD_SIZE, heightsCm };
}
