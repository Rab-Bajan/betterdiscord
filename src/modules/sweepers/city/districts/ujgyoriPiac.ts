// District 2 – Újgyőri Piac: the market. Tight rows of stalls with awnings along narrow aisles,
// covered market rows behind them, crates and cardboard everywhere, mud underfoot.
import type { DistrictContext } from '../districtKit.ts';
import { cornerSlots, scatter, tangentRotation } from '../districtKit.ts';
import { offset } from '../rotation.ts';

const AISLE_LENGTH = 11;
const AISLE_WIDTH = 2.4;
const STALL_W = 3;
const STALL_D = 2.4;
/** Market blocks per hex at most (the rest of the hex stays open for the debris of later phases). */
const BLOCKS_PER_HEX = 2;

export function buildUjgyoriPiac(ctx: DistrictContext): void {
  const { builder, district } = ctx;
  const rng = builder.rng;
  for (const cell of ctx.cells) {
    let blocks = 0;
    for (const slot of cornerSlots(cell, 19)) {
      if (blocks >= BLOCKS_PER_HEX) break;
      const rotY = tangentRotation(slot.angle);
      // The whole block (aisle, two stall rows, two market rows) must fit before anything is placed.
      if (!builder.fitsArea(slot.x, slot.z, AISLE_LENGTH + 2, 20, rotY, { hex: cell })) continue;
      blocks++;
      const [ax, az] = offset(slot.x, slot.z, rotY, -AISLE_LENGTH / 2, 0);
      const [bx, bz] = offset(slot.x, slot.z, rotY, AISLE_LENGTH / 2, 0);
      builder.addRoad('sidewalk', AISLE_WIDTH, [[ax, az], [bx, bz]]);
      for (const side of [-1, 1]) {
        const stallV = side * (AISLE_WIDTH / 2 + 0.3 + STALL_D / 2);
        // Stalls face the aisle: local +z of a stall points at it.
        const stallRot = side < 0 ? rotY : rotY + Math.PI;
        for (let u = -AISLE_LENGTH / 2 + STALL_W / 2; u <= AISLE_LENGTH / 2 - STALL_W / 2 + 1e-9; u += STALL_W + 0.4) {
          const [sx, sz] = offset(slot.x, slot.z, rotY, u, stallV);
          const stall = builder.placeBuilding('market_stall', district, { x: sx, z: sz, w: STALL_W, d: STALL_D, h: 2.4, rotY: stallRot },
            { hex: cell, roadMargin: 0.2, gap: 0.3 });
          if (!stall) continue;
          const [wx, wz] = offset(slot.x, slot.z, rotY, u, side * (AISLE_WIDTH / 2 + 0.2));
          // Every other stall has a striped awning out over the aisle.
          if (Math.round((u + AISLE_LENGTH) / (STALL_W + 0.4)) % 2 === 0) builder.addProp('awning', wx, wz, stallRot);
          if (rng.chance(0.2)) builder.addProp('cardboard', wx + rng.range(-0.6, 0.6), wz + rng.range(-0.6, 0.6), rng.range(0, Math.PI));
        }
        const [rx, rz] = offset(slot.x, slot.z, rotY, 0, side * (AISLE_WIDTH / 2 + 0.3 + STALL_D + 1.6 + 2));
        builder.placeBuilding('market_row', district, { x: rx, z: rz, w: AISLE_LENGTH, d: 4, h: 3.4, rotY: stallRot }, { hex: cell, roadMargin: 0.5 });
      }
      // Crates stacked at the aisle ends, mud in the aisle.
      for (const u of [-AISLE_LENGTH / 2 - 1, AISLE_LENGTH / 2 + 1]) {
        const [cx, cz] = offset(slot.x, slot.z, rotY, u, rng.range(-3.5, 3.5));
        builder.placeProp('crate', cx, cz, rng.range(0, Math.PI / 2), rng.range(0.9, 1.2), { hex: cell, roadMargin: 0.3, gap: 0.3 });
      }
      const [mx, mz] = offset(slot.x, slot.z, rotY, rng.range(-5, 5), 0);
      builder.addSurface('mud', mx, mz, rng.range(1.4, 2.4));
    }
  }
  scatter(ctx, 4, 8, 30, (cell, slot) => {
    builder.placeProp('crate', slot.x, slot.z, rng.range(0, Math.PI / 2), rng.range(0.9, 1.3), { hex: cell, roadMargin: 0.5 });
  });
  scatter(ctx, 2, 8, 30, (cell, slot) => { builder.placeProp('cardboard', slot.x, slot.z, rng.range(0, Math.PI), 1, { hex: cell, roadMargin: 0 }); });
  scatter(ctx, 2, 6, 30, (_cell, slot) => { builder.addSurface('mud', slot.x, slot.z, rng.range(2, 4)); });
  scatter(ctx, 1, 8, 28, (cell, slot) => { builder.placeProp('bin', slot.x, slot.z, 0, 1, { hex: cell, roadMargin: 0.4 }); });
}
