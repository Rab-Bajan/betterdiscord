// Vehicle persistence (plan F.6): the optional `state_json.vehicles` key (state_json stays v4). Seats,
// speed, tipping, jerry cans and the curb cooldown are not saved: everyone loads on foot.
import { isPlainObject } from '../../../core/validation/isPlainObject.ts';
import { encodeLoad, parseLoadC } from '../logistics/persist.ts';
import type { LoadC } from '../logistics/persist.ts';
import { BAG_TIERS, TINTS } from '../logistics/tables.ts';
import { fromRot16, toCm, toRot16 } from '../quantize.ts';
import { ALIGN_MAX, BED_BAGS, spawnSlot, VEHICLE_TYPE_COUNT, vehicleType } from './tables.ts';
import { bedKg, newVehicle } from './VehicleWorld.ts';
import type { VehicleWorld } from './VehicleWorld.ts';
import { normaliseAngle } from '../motion.ts';

export const VEHICLES_VERSION = 1;
/** Rounding margin of a stored bed: 13 loads × 4 gram fields × 0.5 g ≈ 26 g, with room to spare. */
export const BED_ROUNDING_KG = 0.1;

/** `[id, type, xCm, zCm, rot16, fuelDl, align, punct, lights, beacon, LoadC, [tier, tint, LoadC][]]`. */
export type VehicleRecord = [number, number, number, number, number, number, number, 0 | 1, number, 0 | 1, LoadC, Array<[number, number, LoadC]>];

const isUint = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isCm = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 30_000;

export function encodeVehicles(world: VehicleWorld): Record<string, unknown> {
  const list: VehicleRecord[] = [...world.vehicles.values()].sort((a, b) => a.id - b.id).map((v) => [
    v.id, v.type, toCm(v.x), toCm(v.z), toRot16(v.rotY), Math.round(v.fuelL * 10), v.align, v.punct ? 1 : 0, v.lights, v.beacon ? 1 : 0, encodeLoad(v.load),
    v.bags.map((b): [number, number, LoadC] => [b.tier, b.tint, encodeLoad(b.load)])
  ]);
  return { v: VEHICLES_VERSION, list };
}

/**
 * Restores the stored vehicles into `world` (empty). An invalid row (unknown or duplicate id / type,
 * non-integer fields, a bad LoadC, a bed over its cap) is dropped; a row whose body is outside the grid,
 * in a locked district or inside a blocking collider is moved to its spawn slot. Returns the warnings.
 */
export function restoreVehicles(world: VehicleWorld, value: unknown, now: number): string[] {
  if (value === null || value === undefined) return [];
  if (!isPlainObject(value) || value['v'] !== VEHICLES_VERSION || !Array.isArray(value['list'])) return ['invalid vehicles blob'];
  const warnings: string[] = [];
  const types = new Set<number>();
  for (const row of value['list'].slice(0, VEHICLE_TYPE_COUNT * 4)) {
    const v = parseRow(row);
    if (!v || world.vehicles.has(v.id) || types.has(v.type) || world.vehicles.size >= VEHICLE_TYPE_COUNT) {
      warnings.push('vehicle row dropped');
      continue;
    }
    const restored = newVehicle(v.id, v.type, now);
    Object.assign(restored, v);
    // Stored grams are rounded (≤ 0.5 g per field and load), so a bed filled exactly to its cap may read a little over it.
    if (bedKg(restored) > vehicleType(v.type).capKg + BED_ROUNDING_KG) {
      warnings.push('vehicle row dropped');
      continue;
    }
    if (!world.bodyClear(v.type, v.x, v.z, v.rotY)) {
      const slot = spawnSlot(v.type);
      Object.assign(restored, { x: slot.x, z: slot.z, rotY: normaliseAngle(slot.rotY) });
      warnings.push(`vehicle ${v.id} moved to its slot`);
    }
    types.add(v.type);
    world.vehicles.set(v.id, restored);
  }
  return warnings;
}

function parseRow(row: unknown): Pick<ReturnType<typeof newVehicle>, 'id' | 'type' | 'x' | 'z' | 'rotY' | 'fuelL' | 'align' | 'punct' | 'lights' | 'beacon' | 'load' | 'bags'> | null {
  if (!Array.isArray(row) || row.length !== 12) return null;
  const [id, type, xCm, zCm, rot16, fuelDl, align, punct, lights, beacon, loadC, bagsRaw] = row;
  if (!isUint(id, 255) || id === 0 || !isUint(type, VEHICLE_TYPE_COUNT - 1) || !isCm(xCm) || !isCm(zCm) || !isUint(rot16, 0xffff)) return null;
  if (!isUint(fuelDl, 1e6) || !isUint(align, ALIGN_MAX) || !isUint(punct, 1) || !isUint(lights, 2) || !isUint(beacon, 1)) return null;
  const load = parseLoadC(loadC);
  if (!load || !Array.isArray(bagsRaw) || bagsRaw.length > BED_BAGS) return null;
  const bags = [];
  for (const b of bagsRaw) {
    const bagLoad = Array.isArray(b) && b.length === 3 && isUint(b[0], BAG_TIERS.length - 1) && isUint(b[1], TINTS.length - 1) ? parseLoadC(b[2]) : null;
    if (!Array.isArray(b) || !bagLoad) return null;
    bags.push({ tier: Number(b[0]), tint: Number(b[1]), load: bagLoad });
  }
  const t = vehicleType(type);
  return {
    id, type, x: xCm / 100, z: zCm / 100, rotY: fromRot16(rot16), fuelL: Math.min(t.tankL, fuelDl / 10), align, punct: punct === 1,
    lights: t.lights ? (lights === 2 ? 2 : lights === 1 ? 1 : 0) : 0, beacon: t.beacon && beacon === 1, load, bags
  };
}
