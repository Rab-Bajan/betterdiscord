// District 4 – Búza tér: the bus station. Raised platforms beside the roads with shelters and
// benches, ticket kiosks, and subway stairs fenced off with hazard tape.
import type { DistrictContext } from '../districtKit.ts';
import { cornerSlots, hexCentre, scatter, tangentRotation } from '../districtKit.ts';
import { offset, rotationAlong } from '../rotation.ts';
import { ROAD_WIDTH, spokeAngles } from '../roads.ts';

const PLATFORM_W = 20;
const PLATFORM_D = 3;
/** Platform top above the ground: step-over (≤ 0.35 m). */
const PLATFORM_H = 0.25;
const STAIRS_W = 3.4;
const STAIRS_D = 7;

export function buildBuzaTer(ctx: DistrictContext): void {
  const { builder, district } = ctx;
  const rng = builder.rng;
  for (const cell of ctx.cells) {
    const c = hexCentre(cell);
    // A platform on each side of every road leaving the hex centre, 12–32 m out.
    for (const angle of spokeAngles(ctx.roads, cell)) {
      const rotY = rotationAlong(Math.cos(angle), Math.sin(angle));
      for (const side of [-1, 1]) {
        const v = side * (ROAD_WIDTH / 2 + 0.6 + PLATFORM_D / 2);
        const [px, pz] = offset(c.x, c.z, rotY, 22, v);
        const platform = builder.placeBuilding('bus_platform', district, { x: px, z: pz, w: PLATFORM_W, d: PLATFORM_D, h: PLATFORM_H, rotY },
          { hex: cell, roadMargin: 0.5 });
        if (!platform) continue;
        // The shelter's open side (local +z) faces the road.
        const shelterRot = side < 0 ? rotY : rotY + Math.PI;
        const [sx, sz] = offset(px, pz, rotY, rng.range(-5, 5), side * 0.6);
        builder.placeBuilding('bus_shelter', district, { x: sx, z: sz, w: 4, d: 1.6, h: 2.6, rotY: shelterRot },
          { hex: cell, roadMargin: 0.5, overlapOk: true });
        const [bx, bz] = offset(px, pz, rotY, sx > px ? -6 : 6, side * 0.4);
        builder.placeProp('bench', bx, bz, shelterRot, 1, { hex: cell, roadMargin: 0.5, overlapOk: true });
        const [ix, iz] = offset(px, pz, rotY, PLATFORM_W / 2 - 0.8, side * 0.2);
        builder.placeProp('bin', ix, iz, 0, 1, { hex: cell, roadMargin: 0.5, overlapOk: true });
      }
    }
    // A ticket kiosk and (every other hex) subway stairs in the open corners.
    let kiosk = false;
    let stairs = cell.id % 2 === 1;
    for (const slot of cornerSlots(cell, 15)) {
      const rotY = tangentRotation(slot.angle);
      if (!kiosk && builder.placeBuilding('ticket_kiosk', district, { x: slot.x, z: slot.z, w: 2.6, d: 2.6, h: 2.8, rotY }, { hex: cell })) {
        kiosk = true;
        continue;
      }
      if (stairs) continue;
      if (!builder.placeBuilding('subway_stairs', district, { x: slot.x, z: slot.z, w: STAIRS_W, d: STAIRS_D, h: 1, rotY }, { hex: cell, gap: 1.5 })) continue;
      stairs = true;
      // Tape around the stair well, one piece per side.
      for (const [u, v, turn] of [[0, STAIRS_D / 2 + 0.5, 0], [0, -STAIRS_D / 2 - 0.5, 0], [STAIRS_W / 2 + 0.5, 0, Math.PI / 2], [-STAIRS_W / 2 - 0.5, 0, Math.PI / 2]] as const) {
        const [tx, tz] = offset(slot.x, slot.z, rotY, u, v);
        builder.addProp('hazard_tape', tx, tz, rotY + turn);
      }
    }
  }
  scatter(ctx, 3, 8, 30, (cell, slot) => { builder.placeProp('tree', slot.x, slot.z, 0, rng.range(0.8, 1.1), { hex: cell }); });
  scatter(ctx, 2, 8, 30, (cell, slot) => { builder.placeProp('bench', slot.x, slot.z, tangentRotation(slot.angle), 1, { hex: cell }); });
  scatter(ctx, 2, 8, 28, (cell, slot) => { builder.placeProp('bin', slot.x, slot.z, 0, 1, { hex: cell, roadMargin: 0.4 }); });
  scatter(ctx, 1, 8, 30, (cell, slot) => { builder.placeProp('cardboard', slot.x, slot.z, rng.range(0, Math.PI), 1, { hex: cell, roadMargin: 0 }); });
}
