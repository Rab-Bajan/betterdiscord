// District 3 – Vasgyár (Diósgyőri vasgyár): the steelworks. Factory halls with chimneys, a rail
// line with an ore train under a gantry crane, iron beams and rail pieces lying around, grease
// slicks and acid spills.
import type { DistrictContext } from '../districtKit.ts';
import { cornerSlots, scatter, tangentRotation } from '../districtKit.ts';
import { offset } from '../rotation.ts';

/** The rail line runs east–west through the district, north of the main road. */
const RAIL_Z = 14;
const RAIL_FROM_X = -48;
const RAIL_TO_X = -236;
const RAIL_WIDTH = 1.6;
const WAGON_W = 9;
/** Wagons of the ore train (x of each centre). */
const TRAIN_X: readonly number[] = [-166, -176, -186, -196];
const SPARE_WAGON_X = -96;
const CRANE_X = -181;
/** Hall sizes, biggest first. */
const HALLS: ReadonlyArray<readonly [number, number, number]> = [[34, 18, 14], [24, 14, 12]];

export function buildVasgyar(ctx: DistrictContext): void {
  const { builder, district } = ctx;
  const rng = builder.rng;
  builder.addRoad('rail', RAIL_WIDTH, [[RAIL_FROM_X, RAIL_Z], [RAIL_TO_X, RAIL_Z]]);
  const onRail = { onRoads: ['rail'] as const, roadMargin: 0.5 };
  for (const x of [...TRAIN_X, SPARE_WAGON_X]) {
    builder.placeBuilding('ore_wagon', district, { x, z: RAIL_Z, w: WAGON_W, d: 2.8, h: 3, rotY: 0 }, { ...onRail, gap: 0.6 });
  }
  // The gantry spans the rail; wagons pass between its legs.
  builder.placeBuilding('gantry_crane', district, { x: CRANE_X, z: RAIL_Z, w: 8, d: 16, h: 12, rotY: 0 }, { ...onRail, overlapOk: true, noFootprint: true });
  for (let i = 0; i < 4; i++) builder.addProp('iron_beam', CRANE_X - 3 + i * 0.5, RAIL_Z + 5.5, 0, 1);
  for (const x of [RAIL_FROM_X + 2, RAIL_TO_X - 2]) builder.addProp('rail_segment', x, RAIL_Z, 0);

  for (const cell of ctx.cells) {
    let chimneys = 0;
    for (const slot of cornerSlots(cell, 19)) {
      const rotY = tangentRotation(slot.angle);
      let hall = null;
      for (const [w, d, h] of HALLS) {
        hall = builder.placeBuilding('factory_hall', district, { x: slot.x, z: slot.z, w, d, h, rotY }, { hex: cell });
        if (hall) break;
      }
      if (!hall) continue;
      // A chimney beside the hall, at most one per hex.
      const spots: ReadonlyArray<readonly [number, number]> = [
        [hall.w / 2 + 4, 0], [-hall.w / 2 - 4, 0], [hall.w / 2 - 3, hall.d / 2 + 4], [-hall.w / 2 + 3, hall.d / 2 + 4],
        [hall.w / 2 - 3, -hall.d / 2 - 4], [-hall.w / 2 + 3, -hall.d / 2 - 4]
      ];
      for (const [u, v] of spots) {
        if (chimneys > 0) break;
        const [cx, cz] = offset(hall.x, hall.z, rotY, u, v);
        if (builder.placeBuilding('chimney', district, { x: cx, z: cz, w: 5, d: 5, h: 45, rotY: 0 }, { hex: cell, gap: 1 })) chimneys++;
      }
      // Grease in front of the hall door, now and then an acid spill.
      const [gx, gz] = offset(hall.x, hall.z, rotY, rng.range(-hall.w / 4, hall.w / 4), hall.d / 2 + 2.5);
      builder.addSurface(rng.chance(0.25) ? 'acid' : 'grease', gx, gz, rng.range(1.5, 3));
    }
  }
  scatter(ctx, 3, 8, 30, (cell, slot) => { builder.placeProp('iron_beam', slot.x, slot.z, rng.range(0, Math.PI), 1, { hex: cell, roadMargin: 0 }); });
  scatter(ctx, 2, 8, 30, (cell, slot) => { builder.placeProp('rail_segment', slot.x, slot.z, rng.range(0, Math.PI), 1, { hex: cell, roadMargin: 0 }); });
  scatter(ctx, 1, 6, 30, (_cell, slot) => { builder.addSurface('grease', slot.x, slot.z, rng.range(1.5, 3)); });
  scatter(ctx, 1, 6, 30, (_cell, slot) => { if (rng.chance(0.5)) builder.addSurface('acid', slot.x, slot.z, rng.range(1, 2)); });
  scatter(ctx, 2, 8, 30, (cell, slot) => { builder.placeProp('crate', slot.x, slot.z, rng.range(0, Math.PI / 2), 1.2, { hex: cell }); });
}
