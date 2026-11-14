// District 5 – Avas Kilátó & Parkerdő: the hill (in the heightfield, see terrain.ts) with the TV
// tower on the summit, the lookout tower beside it, stair flights up the slope, a row of wine
// cellars dug into the hillside, and park forest with footpaths.
import { hexAt } from '../../hexGrid.ts';
import type { DistrictContext } from '../districtKit.ts';
import { hexCentre, scatter } from '../districtKit.ts';
import { offset, rotationAlong } from '../rotation.ts';
import { HILL_PEAK } from '../terrain.ts';

const TOWER_R = 3.5;
const PATH_WIDTH = 2;
const STAIRS_WIDTH = 2.5;
/** Stair flights from the roads below up to the summit. */
const STAIRS: ReadonlyArray<ReadonlyArray<[number, number]>> = [
  [[132, -66], [134, -76], [135, -86]],
  [[110, -116], [119, -108], [127, -101]]
];
/** Wine cellars stand on this contour around the summit (m). */
const CELLAR_RING = 58;
const MAX_CELLARS = 8;

export function buildAvasKilato(ctx: DistrictContext): void {
  const { builder, district } = ctx;
  const rng = builder.rng;
  const summitCell = hexAt(HILL_PEAK.x, HILL_PEAK.z) ?? undefined;
  const tower = builder.placeBuilding('tv_tower', district,
    { x: HILL_PEAK.x, z: HILL_PEAK.z, w: TOWER_R * 2, d: TOWER_R * 2, h: 72, rotY: 0 }, { hex: summitCell });
  if (!tower) throw new Error('Avas Kilátó: the TV tower does not fit on the summit');
  // A fence ring around the tower base.
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    builder.placeProp('fence', HILL_PEAK.x + Math.cos(a) * 6, HILL_PEAK.z + Math.sin(a) * 6, rotationAlong(-Math.sin(a), Math.cos(a)), 1.4,
      { roadMargin: 0.3, gap: 0.2, overlapOk: true });
  }
  // The lookout: first free spot on a ring around the summit.
  for (let k = 0; k < 12; k++) {
    const a = Math.PI + (k * Math.PI) / 6;
    const x = HILL_PEAK.x + Math.cos(a) * 22;
    const z = HILL_PEAK.z + Math.sin(a) * 22;
    const cell = hexAt(x, z);
    if (cell?.district !== district) continue;
    if (!builder.placeBuilding('lookout', district, { x, z, w: 6, d: 6, h: 23, rotY: 0 }, { hex: cell })) continue;
    for (const u of [-2, 2]) {
      const [bx, bz] = offset(x, z, 0, u, 5);
      builder.placeProp('bench', bx, bz, 0, 1, { hex: cell, gap: 0.4 });
    }
    break;
  }

  for (const points of STAIRS) {
    builder.addRoad('stairs', STAIRS_WIDTH, points.map(([x, z]) => [x, z]));
    for (let i = 1; i < points.length; i++) {
      const [ax, az] = points[i - 1] ?? [0, 0];
      const [bx, bz] = points[i] ?? [0, 0];
      const length = Math.hypot(bx - ax, bz - az);
      const rotY = rotationAlong(bx - ax, bz - az);
      for (let u = 2.5; u < length; u += 5) {
        const [sx, sz] = offset(ax, az, rotY, u, 0);
        builder.addProp('stair_flight', sx, sz, rotY);
      }
    }
  }

  // Footpaths: a loop through each forest hex (not the summit hex, which has the stairs).
  for (const cell of ctx.cells) {
    if (cell === summitCell) continue;
    const c = hexCentre(cell);
    const loop: Array<[number, number]> = [];
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI / 6 + (k * Math.PI) / 3;
      loop.push([c.x + Math.cos(a) * 24, c.z + Math.sin(a) * 24]);
    }
    builder.addRoad('path', PATH_WIDTH, loop);
  }

  // Wine cellars facing downhill (local +z points away from the summit).
  let cellars = 0;
  for (let k = 0; k < 30 && cellars < MAX_CELLARS; k++) {
    const a = (k * 2 * Math.PI) / 30;
    const x = HILL_PEAK.x + Math.cos(a) * CELLAR_RING;
    const z = HILL_PEAK.z + Math.sin(a) * CELLAR_RING;
    const cell = hexAt(x, z);
    if (cell?.district !== district) continue;
    const rotY = rotationAlong(Math.sin(a), -Math.cos(a));
    if (builder.placeBuilding('wine_cellar', district, { x, z, w: 4, d: 3, h: 3, rotY }, { hex: cell, gap: 2 })) cellars++;
  }

  scatter(ctx, 12, 6, 32, (cell, slot) => { builder.placeProp('tree', slot.x, slot.z, 0, rng.range(0.9, 1.5), { hex: cell, roadMargin: 0.8, gap: 1.2 }); });
  scatter(ctx, 2, 8, 30, (cell, slot) => { builder.placeProp('bench', slot.x, slot.z, rng.range(0, Math.PI), 1, { hex: cell, roadMargin: 0.5 }); });
  scatter(ctx, 1, 8, 30, (cell, slot) => { builder.placeProp('bin', slot.x, slot.z, 0, 1, { hex: cell, roadMargin: 0.4 }); });
  scatter(ctx, 1, 6, 30, (_cell, slot) => { if (rng.chance(0.6)) builder.addSurface('mud', slot.x, slot.z, rng.range(1.5, 3)); });
}
