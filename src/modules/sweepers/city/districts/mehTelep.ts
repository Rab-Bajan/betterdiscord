// District 0 – Központi MÉH Telep: the scrap yard in the centre hex. A 2 m corrugated scrap fence
// with three gates, the weighbridge on the east lane with its LED display, the office container,
// the generator, the hopper, the sorting shed and scrap piles. Hand-placed: it is the spawn area.
import type { Building, Landmarks } from '../layoutTypes.ts';
import type { PlaceOptions } from '../LayoutBuilder.ts';
import type { DistrictContext } from '../districtKit.ts';
import { YARD_GATE_ANGLES, YARD_HALF_D, YARD_HALF_W, yardGate } from '../roads.ts';
import { rotationAlong } from '../rotation.ts';

const FENCE_HEIGHT = 2;
const FENCE_DEPTH = 0.3;
/** Half width of a gate opening along the fence. */
const GATE_HALF = 5.5;
/** Yard lanes (gate → centre) kept clear of everything, from this distance out. */
const LANE_START = 8;
const LANE_WIDTH = 6;

/** The yard is hand-designed: a refused placement is a bug in this file, not a skipped decoration. */
function must(building: Building | null, what: string): Building {
  if (!building) throw new Error(`MÉH telep: ${what} does not fit`);
  return building;
}

export function buildMehTelep(ctx: DistrictContext): Landmarks {
  const { builder, district } = ctx;
  const cell = ctx.cells[0];
  if (!cell) throw new Error('MÉH telep: no centre hex');
  const inYard: PlaceOptions = { hex: cell, roadMargin: 0.5 };

  // Lanes from each gate to the centre stay clear.
  for (const angle of YARD_GATE_ANGLES) {
    const [gx, gz] = yardGate(angle);
    const length = Math.hypot(gx, gz) - LANE_START;
    const mid = LANE_START + length / 2;
    builder.reserve(Math.cos(angle) * mid, Math.sin(angle) * mid, length, LANE_WIDTH, rotationAlong(gx, gz));
  }

  // Fence: each side split around the gates lying on it.
  const sides: Array<{ from: [number, number]; to: [number, number] }> = [
    { from: [-YARD_HALF_W, YARD_HALF_D], to: [YARD_HALF_W, YARD_HALF_D] },
    { from: [YARD_HALF_W, YARD_HALF_D], to: [YARD_HALF_W, -YARD_HALF_D] },
    { from: [YARD_HALF_W, -YARD_HALF_D], to: [-YARD_HALF_W, -YARD_HALF_D] },
    { from: [-YARD_HALF_W, -YARD_HALF_D], to: [-YARD_HALF_W, YARD_HALF_D] }
  ];
  const gates = YARD_GATE_ANGLES.map(yardGate);
  for (const { from, to } of sides) {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const ux = (to[0] - from[0]) / length;
    const uz = (to[1] - from[1]) / length;
    const cuts = gates
      .map(([gx, gz]) => ({ t: (gx - from[0]) * ux + (gz - from[1]) * uz, off: Math.abs((gx - from[0]) * uz - (gz - from[1]) * ux) }))
      .filter((g) => g.off < 1e-6 && g.t > 0 && g.t < length)
      .map((g) => g.t)
      .sort((a, b) => a - b);
    const pieces: Array<[number, number]> = [];
    let start = 0;
    for (const t of cuts) {
      pieces.push([start, t - GATE_HALF]);
      start = t + GATE_HALF;
    }
    pieces.push([start, length]);
    for (const [a, b] of pieces) {
      const m = (a + b) / 2;
      must(builder.placeBuilding('scrap_fence', district, {
        x: from[0] + ux * m, z: from[1] + uz * m, w: b - a, d: FENCE_DEPTH, h: FENCE_HEIGHT, rotY: rotationAlong(ux, uz)
      }, { ...inYard, overlapOk: true }), 'fence');
    }
  }

  // East lane: trucks enter, cross the weighbridge, read the LED display, unload at the hopper.
  const weighbridge = must(builder.placeBuilding('weighbridge', district, { x: 15, z: 0, w: 12, d: 3.5, h: 0.12, rotY: 0 },
    { ...inYard, overlapOk: true, noFootprint: true }), 'weighbridge');
  must(builder.placeBuilding('led_display', district, { x: 15, z: 4.3, w: 3, d: 0.3, h: 3.2, rotY: 0 }, inYard), 'LED display');
  const office = must(builder.placeBuilding('office_container', district, { x: 15, z: -6.6, w: 6, d: 2.5, h: 2.6, rotY: 0 }, inYard), 'office');
  const generator = must(builder.placeBuilding('generator', district, { x: 21, z: -12, w: 2.4, d: 1.2, h: 1.8, rotY: 0 }, inYard), 'generator');
  const hopper = must(builder.placeBuilding('hopper', district, { x: 14, z: 12, w: 4, d: 4, h: 4, rotY: 0 }, inYard), 'hopper');
  must(builder.placeBuilding('sorting_shed', district, { x: -17, z: 0, w: 8, d: 14, h: 6, rotY: 0 }, inYard), 'sorting shed');

  const piles: Array<[number, number, number, number]> = [
    [21.5, 13.5, 2.5, 3.2], [6, 13.5, 2, 2.4], [-20.5, 13.5, 2.5, 3], [-20.5, -13.5, 2.5, 2.6], [5, -14, 2.2, 2.8]
  ];
  for (const [x, z, r, h] of piles) {
    must(builder.placeBuilding('scrap_pile', district, { x, z, w: r * 2, d: r * 2, h, rotY: 0 }, inYard), `scrap pile ${x},${z}`);
  }
  // Loose scrap lying around (step-over decor).
  builder.addProp('iron_beam', -11, -6, 0.4);
  builder.addProp('iron_beam', -11.5, -7, 0.5);
  builder.addProp('rail_segment', 9, -11, 1.2);
  builder.addProp('cardboard', 11, 9, 0.3);
  builder.placeProp('crate', 10, 12.5, 0.2, 1, inYard);
  builder.placeProp('bin', 18.8, -9.2, 0, 1, inYard);

  return {
    weighbridge: { x: weighbridge.x, z: weighbridge.z, w: weighbridge.w, d: weighbridge.d, rotY: weighbridge.rotY },
    hopper: { x: hopper.x, z: hopper.z, w: hopper.w, d: hopper.d, rotY: hopper.rotY },
    office: { x: office.x, z: office.z, rotY: office.rotY },
    generator: { x: generator.x, z: generator.z, rotY: generator.rotY }
  };
}
