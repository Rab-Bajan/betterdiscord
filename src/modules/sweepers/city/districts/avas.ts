// District 1 – Avas: the housing estate. Ten-storey panel blocks (panelház) with a kukatároló (bin
// room) at the door, satellite dishes and laundry on the facades, playgrounds with benches and bins.
import type { DistrictContext } from '../districtKit.ts';
import { cornerSlots, scatter, tangentRotation } from '../districtKit.ts';
import { offset } from '../rotation.ts';

/** Ten storeys of 2.9 m plus the roof parapet. */
const PANEL_HEIGHT = 30;
const PANEL_DEPTH = 11;
/** Long block first, then a shorter section where the long one does not fit. */
const PANEL_LENGTHS: readonly number[] = [26, 18];

export function buildAvas(ctx: DistrictContext): void {
  const { builder, district } = ctx;
  const rng = builder.rng;
  for (const cell of ctx.cells) {
    const options = { hex: cell };
    // One playground per hex (placed before the blocks so it gets a slot), with benches and a bin beside it.
    for (const slot of cornerSlots(cell, 17)) {
      const rotY = tangentRotation(slot.angle);
      const ground = builder.placeBuilding('playground', district, { x: slot.x, z: slot.z, w: 12, d: 9, h: 0.1, rotY }, options);
      if (!ground) continue;
      for (const u of [-3, 3]) {
        const [bx, bz] = offset(slot.x, slot.z, rotY, u, 5.6);
        builder.placeProp('bench', bx, bz, rotY, 1, { ...options, gap: 0.4 });
      }
      const [ix, iz] = offset(slot.x, slot.z, rotY, 6.8, 5.2);
      builder.placeProp('bin', ix, iz, 0, 1, { ...options, gap: 0.4 });
      break;
    }
    for (const slot of cornerSlots(cell, 21)) {
      const rotY = tangentRotation(slot.angle);
      let block = null;
      for (const w of PANEL_LENGTHS) {
        block = builder.placeBuilding('panel10', district, { x: slot.x, z: slot.z, w, d: PANEL_DEPTH, h: PANEL_HEIGHT, rotY }, options);
        if (block) break;
      }
      if (!block) continue;
      // The door side faces the hex centre (local +z); the kukatároló stands right at the door.
      const [kx, kz] = offset(block.x, block.z, rotY, rng.range(-block.w / 4, block.w / 4), PANEL_DEPTH / 2 + 1.5);
      builder.placeBuilding('kukatarolo', district, { x: kx, z: kz, w: 3, d: 2, h: 2.2, rotY }, { ...options, gap: 0.3 });
      for (let i = 0; i < 2; i++) {
        const [dx, dz] = offset(block.x, block.z, rotY, rng.range(-block.w / 2 + 1, block.w / 2 - 1), -PANEL_DEPTH / 2 - 0.3);
        builder.addProp('satellite_dish', dx, dz, rotY + Math.PI);
      }
      const [lx, lz] = offset(block.x, block.z, rotY, rng.range(-block.w / 3, block.w / 3), PANEL_DEPTH / 2 + 0.2);
      builder.addProp('laundry', lx, lz, rotY);
    }
  }
  scatter(ctx, 5, 8, 30, (cell, slot) => { builder.placeProp('tree', slot.x, slot.z, 0, rng.range(0.8, 1.2), { hex: cell }); });
  scatter(ctx, 1, 8, 28, (cell, slot) => { builder.placeProp('bin', slot.x, slot.z, 0, 1, { hex: cell, roadMargin: 0.4 }); });
  scatter(ctx, 2, 8, 28, (cell, slot) => { builder.placeProp('bench', slot.x, slot.z, tangentRotation(slot.angle), 1, { hex: cell }); });
}
