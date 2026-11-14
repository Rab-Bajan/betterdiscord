// The static debris grid (plan C.2), shared by every room: 0.5 m cells over x, z ∈ [−256, 256),
// 16×16-cell chunks, the dead mask and the live chunk set, computed once from the city layout.
import { cityLayout } from '../city/cityLayout.ts';
import type { Collider } from '../city/layoutTypes.ts';
import { ColliderIndex, penetration, surfaceAt } from '../geometry.ts';
import { HEX_CELLS, hexAt, worldToAxial } from '../hexGrid.ts';
import { DUST_KG_M2, profileOf, SEED_KG_M2 } from './tables.ts';

export const GRID_ORIGIN = -256;
export const CELL_M = 0.5;
export const CHUNK_CELLS = 16;
export const CHUNK_M = CELL_M * CHUNK_CELLS;
/** Chunks per axis. */
export const CHUNKS_N = 64;
export const CELLS_N = CHUNKS_N * CHUNK_CELLS;
export const CELLS_PER_CHUNK = CHUNK_CELLS * CHUNK_CELLS;
export const MAX_LEVEL = 15;
const CELL_AREA = CELL_M * CELL_M;

/** Surface codes per cell. */
export const SURFACE_DRY = 0;
const SURFACE_CODES = Object.freeze({ dry: 0, wet: 1, mud: 2, grease: 3, acid: 4 } as const);

/** The static part of the grid. A cell is addressed by `slot · 256 + cellIdx` ("live index"). */
export interface DebrisGrid {
  /** chunkId → slot, or -1 for a dead chunk. */
  slotOf: Int16Array;
  /** slot → chunkId, ascending. */
  liveChunks: Uint16Array;
  /** live index → hex id, -1 for a dead cell. */
  cellHex: Int8Array;
  /** live index → surface code (0 dry, 1 wet, 2 mud, 3 grease, 4 acid). */
  cellSurface: Uint8Array;
  /** Per hex, its live cells (live indices). */
  hexCells: Uint32Array[];
  /** Blocking colliders (h > 0.35) of the layout. */
  colliders: ColliderIndex;
  /** Building footprints as box colliders (copper placement). */
  buildingBoxes: ColliderIndex;
}

export const chunkIdOf = (cx: number, cz: number): number => cz * CHUNKS_N + cx;

/** Global cell coordinate of a world coordinate (may be outside 0..1023). */
export const cellCoord = (v: number): number => Math.floor((v - GRID_ORIGIN) / CELL_M);

/** World centre of global cell coordinate `g`. */
export const cellCentre = (g: number): number => GRID_ORIGIN + (g + 0.5) * CELL_M;

/** Chunk id containing world point (x, z), or -1 outside the grid. */
export function chunkAt(x: number, z: number): number {
  const gx = cellCoord(x);
  const gz = cellCoord(z);
  if (gx < 0 || gz < 0 || gx >= CELLS_N || gz >= CELLS_N) return -1;
  return chunkIdOf(gx >> 4, gz >> 4);
}

/** World centre of a chunk. */
export function chunkCentre(chunkId: number): { x: number; z: number } {
  const cx = chunkId % CHUNKS_N;
  const cz = Math.floor(chunkId / CHUNKS_N);
  return { x: GRID_ORIGIN + (cx + 0.5) * CHUNK_M, z: GRID_ORIGIN + (cz + 0.5) * CHUNK_M };
}

/** Live index of global cell (gx, gz), or -1 (outside the grid or in a dead chunk). */
export function liveIndex(grid: DebrisGrid, gx: number, gz: number): number {
  if (gx < 0 || gz < 0 || gx >= CELLS_N || gz >= CELLS_N) return -1;
  const slot = grid.slotOf[chunkIdOf(gx >> 4, gz >> 4)] ?? -1;
  if (slot < 0) return -1;
  return slot * CELLS_PER_CHUNK + (gz & 15) * CHUNK_CELLS + (gx & 15);
}

/** World centre of a live index. */
export function liveCentre(grid: DebrisGrid, index: number): { x: number; z: number } {
  const chunkId = grid.liveChunks[index >> 8] ?? 0;
  const cell = index & 255;
  const gx = (chunkId % CHUNKS_N) * CHUNK_CELLS + (cell & 15);
  const gz = Math.floor(chunkId / CHUNKS_N) * CHUNK_CELLS + (cell >> 4);
  return { x: cellCentre(gx), z: cellCentre(gz) };
}

/** True when a point is inside a blocking collider. */
export function insideCollider(index: ColliderIndex, x: number, z: number): boolean {
  return index.near(x, z, 0).some((c) => penetration(c, x, z, 0) !== null);
}

/** Kg of dust at `level` in a hex of `district`. */
export const dustKg = (level: number, district: number): number => (level / MAX_LEVEL) * DUST_KG_M2 * profileOf(district).dust * CELL_AREA;
export const seedKg = (level: number, district: number): number => (level / MAX_LEVEL) * SEED_KG_M2 * profileOf(district).seed * CELL_AREA;

/** Kg of a whole cell byte. */
export const cellKg = (byte: number, district: number): number => dustKg(byte >> 4, district) + seedKg(byte & 15, district);

/** Mass an item counts with in the cleanliness score: max(mass, 1 kg) (cans, iron, copper, cabbage). */
export const scoredKg = (massKg: number): number => Math.max(massKg, 1);

const HEX_INDEX = new Map(HEX_CELLS.map((c) => [`${c.q},${c.r}`, c.id]));

function buildGrid(): DebrisGrid {
  const layout = cityLayout();
  const colliders = new ColliderIndex(layout.colliders);
  const boxes: Collider[] = layout.buildings.map((b) => ({ shape: 'box', x: b.x, z: b.z, w: b.w, d: b.d, h: 10, rotY: b.rotY }));
  const buildingBoxes = new ColliderIndex(boxes);
  const slotOf = new Int16Array(CHUNKS_N * CHUNKS_N).fill(-1);
  const chunkHex: Int8Array[] = [];
  const chunkSurface: Uint8Array[] = [];
  const live: number[] = [];
  for (let cz = 0; cz < CHUNKS_N; cz++) {
    for (let cx = 0; cx < CHUNKS_N; cx++) {
      const centreX = GRID_ORIGIN + (cx + 0.5) * CHUNK_M;
      const centreZ = GRID_ORIGIN + (cz + 0.5) * CHUNK_M;
      // A chunk whose centre is far beyond the outermost hex has no live cell (max extent 248 m).
      if (Math.hypot(centreX, centreZ) > 260) continue;
      const nearby = colliders.near(centreX, centreZ, CHUNK_M);
      const surfaces = layout.surfaces.filter((s) => Math.hypot(s.x - centreX, s.z - centreZ) <= s.r + CHUNK_M);
      const hexes = new Int8Array(CELLS_PER_CHUNK).fill(-1);
      const surf = new Uint8Array(CELLS_PER_CHUNK);
      let hasLive = false;
      for (let lz = 0; lz < CHUNK_CELLS; lz++) {
        const z = cellCentre(cz * CHUNK_CELLS + lz);
        for (let lx = 0; lx < CHUNK_CELLS; lx++) {
          const x = cellCentre(cx * CHUNK_CELLS + lx);
          const { q, r } = worldToAxial(x, z);
          const hex = HEX_INDEX.get(`${q},${r}`);
          if (hex === undefined) continue;
          if (nearby.some((c) => penetration(c, x, z, 0) !== null)) continue;
          const i = lz * CHUNK_CELLS + lx;
          hexes[i] = hex;
          surf[i] = surfaces.length === 0 ? SURFACE_DRY : SURFACE_CODES[surfaceAt(surfaces, x, z)];
          hasLive = true;
        }
      }
      if (!hasLive) continue;
      slotOf[chunkIdOf(cx, cz)] = live.length;
      live.push(chunkIdOf(cx, cz));
      chunkHex.push(hexes);
      chunkSurface.push(surf);
    }
  }
  const cellHex = new Int8Array(live.length * CELLS_PER_CHUNK);
  const cellSurface = new Uint8Array(live.length * CELLS_PER_CHUNK);
  const perHex: number[][] = HEX_CELLS.map(() => []);
  chunkHex.forEach((hexes, slot) => {
    cellHex.set(hexes, slot * CELLS_PER_CHUNK);
    cellSurface.set(chunkSurface[slot] ?? new Uint8Array(CELLS_PER_CHUNK), slot * CELLS_PER_CHUNK);
    hexes.forEach((hex, i) => { if (hex >= 0) perHex[hex]?.push(slot * CELLS_PER_CHUNK + i); });
  });
  return {
    slotOf,
    liveChunks: Uint16Array.from(live),
    cellHex,
    cellSurface,
    hexCells: perHex.map((cells) => Uint32Array.from(cells)),
    colliders,
    buildingBoxes
  };
}

let cached: DebrisGrid | null = null;

/** The grid, built once per process (treat as read-only). */
export function debrisGrid(): DebrisGrid {
  cached ??= buildGrid();
  return cached;
}

/** True when (x, z) lies in a grid hex, outside every blocking collider. */
export function openPoint(grid: DebrisGrid, x: number, z: number): boolean {
  return hexAt(x, z) !== null && !insideCollider(grid.colliders, x, z);
}
