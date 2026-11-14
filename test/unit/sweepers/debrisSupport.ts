// Helpers for the Phase C debris tests: an empty debris world, cell painting and a personal state.
import { DebrisWorld } from '../../../src/modules/sweepers/debris/DebrisWorld.ts';
import type { Item } from '../../../src/modules/sweepers/debris/DebrisWorld.ts';
import { cellCentre, cellCoord, liveIndex } from '../../../src/modules/sweepers/debris/grid.ts';
import { parsePersonal } from '../../../src/modules/sweepers/debris/personal.ts';
import type { PersonalData } from '../../../src/modules/sweepers/debris/personal.ts';
import type { UseContext } from '../../../src/modules/sweepers/debris/tools.ts';
import { HEX_CELLS } from '../../../src/modules/sweepers/hexGrid.ts';
import { NEW_PLAYER_STATS } from '../../../src/modules/sweepers/SweepersRoom.ts';

export const ALL_DISTRICTS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5]);

/** A world with no dirt and no items (every hex at 100 %), deltas cleared. */
export function emptyWorld(): DebrisWorld {
  const world = DebrisWorld.generate('test-empty', HEX_CELLS.map(() => 100), 1);
  for (const id of [...world.items.keys()]) world.remove(id);
  world.takeDeltas(Number.MAX_SAFE_INTEGER);
  return world;
}

/** Live index of the cell containing (x, z). */
export function cellAt(world: DebrisWorld, x: number, z: number): number {
  return liveIndex(world.grid, cellCoord(x), cellCoord(z));
}

/** Sets every live cell whose centre is within `radius` of (x, z) to `byte`. */
export function paint(world: DebrisWorld, x: number, z: number, radius: number, byte: number): number {
  let count = 0;
  for (let gz = cellCoord(z - radius); gz <= cellCoord(z + radius); gz++) {
    for (let gx = cellCoord(x - radius); gx <= cellCoord(x + radius); gx++) {
      if (Math.hypot(cellCentre(gx) - x, cellCentre(gz) - z) > radius) continue;
      const index = liveIndex(world.grid, gx, gz);
      if (index < 0 || (world.grid.cellHex[index] ?? -1) < 0) continue;
      world.setCell(index, byte);
      count++;
    }
  }
  return count;
}

/** A personal state after the starter grant (cash 2 000), with overrides. */
export function personal(overrides: Partial<PersonalData> = {}): PersonalData {
  const { data } = parsePersonal({ ...NEW_PLAYER_STATS }, { starter: true }, 0);
  data.cash = 0;
  return Object.assign(data, overrides);
}

/** Use context over every district, dry weather, no clog unless `clog`. */
export function context(world: DebrisWorld, data: PersonalData, now = 10_000, clog = false, drizzle = false): UseContext {
  return { world, data, now, unlocked: ALL_DISTRICTS, drizzle, chance: () => clog };
}

/** Places an item through the world API (no caps). */
export function put(world: DebrisWorld, kind: number, x: number, z: number, massDg: number, flags = 0, seedDg = 0): Item {
  const item = world.place(kind, x, z, massDg, seedDg, 0);
  if (!item) throw new Error(`could not place kind ${kind} at ${x},${z}`);
  if (flags !== 0) world.update(item, { flags });
  return item;
}
