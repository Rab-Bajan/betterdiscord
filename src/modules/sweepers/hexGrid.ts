// The MiskolcSweepers district grid: 37 pointy-top hexes (axial radius 3), outer radius 40 m,
// centred on the world origin in the x/z plane. Pure functions only.

/** Rings around the centre hex. */
export const GRID_RADIUS = 3;
/** Centre-to-corner distance of one hex, metres. */
export const HEX_OUTER_RADIUS = 40;
/** Number of ring districts (district 0 is the centre hex). */
export const RING_DISTRICTS = 5;

const SQRT3 = Math.sqrt(3);
const TAU = Math.PI * 2;

/** Axial neighbour offsets, counter-clockwise starting east. */
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Axial coordinates of a hex. */
export interface Axial {
  q: number;
  r: number;
}

/** A hex cell of the grid (static part of a HexSnapshot). */
export interface HexCell extends Axial {
  /** 0 = centre, then ring by ring (spiral order). */
  id: number;
  district: number;
}

/** Hex distance from the centre. */
export function axialDistance({ q, r }: Axial): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
}

/** World-space centre (x, z) of an axial hex. */
export function axialToWorld({ q, r }: Axial): { x: number; z: number } {
  return { x: HEX_OUTER_RADIUS * SQRT3 * (q + r / 2), z: HEX_OUTER_RADIUS * 1.5 * r };
}

/** The axial hex containing world point (x, z) (cube rounding), regardless of the grid's extent. */
export function worldToAxial(x: number, z: number): Axial {
  const fq = ((SQRT3 / 3) * x - z / 3) / HEX_OUTER_RADIUS;
  const fr = ((2 / 3) * z) / HEX_OUTER_RADIUS;
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  // `+ 0` turns a rounded -0 into 0.
  return { q: q + 0, r: r + 0 };
}

/**
 * District of a hex: 0 for the centre, otherwise 1..5 by the angle of the hex centre around the
 * origin (five 72° sectors counter-clockwise from +x): 1 Avas, 2 Újgyőri Piac, 3 Vasgyár,
 * 4 Búza tér, 5 Avas Kilátó & Parkerdő.
 */
export function districtOf(hex: Axial): number {
  if (hex.q === 0 && hex.r === 0) return 0;
  const { x, z } = axialToWorld(hex);
  // The epsilon keeps a centre lying exactly on a sector boundary in the sector that starts there.
  const angle = (Math.atan2(z, x) + TAU + 1e-9) % TAU;
  return 1 + Math.min(RING_DISTRICTS - 1, Math.floor(angle / (TAU / RING_DISTRICTS)));
}

function buildCells(): readonly HexCell[] {
  const cells: HexCell[] = [];
  const add = (q: number, r: number): void => {
    cells.push(Object.freeze({ id: cells.length, q: q + 0, r: r + 0, district: districtOf({ q, r }) }));
  };
  add(0, 0);
  for (let ring = 1; ring <= GRID_RADIUS; ring++) {
    const start = DIRECTIONS[4] ?? [0, 0];
    let q = start[0] * ring;
    let r = start[1] * ring;
    for (const [dq, dr] of DIRECTIONS) {
      for (let step = 0; step < ring; step++) {
        add(q, r);
        q += dq;
        r += dr;
      }
    }
  }
  return Object.freeze(cells);
}

/** All 37 cells, index = id. */
export const HEX_CELLS: readonly HexCell[] = buildCells();

const CELL_BY_AXIAL = new Map(HEX_CELLS.map((cell) => [`${cell.q},${cell.r}`, cell]));

/** The grid cell containing world point (x, z), or null outside the grid. */
export function hexAt(x: number, z: number): HexCell | null {
  const { q, r } = worldToAxial(x, z);
  return CELL_BY_AXIAL.get(`${q},${r}`) ?? null;
}

/**
 * District of any world point, inside the 37 hexes or in the outskirts beyond them (same sector
 * rule as the grid: the hex containing the point decides).
 */
export function districtAt(x: number, z: number): number {
  return districtOf(worldToAxial(x, z));
}

/** Deterministic 32-bit integer hash (lowbias32). */
function hash32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Starting cleanliness: 35 for the centre district, 10..25 elsewhere (deterministic per hex id). */
export function initialCleanliness(cell: HexCell): number {
  return cell.district === 0 ? 35 : 10 + (hash32(cell.id + 1) % 16);
}
