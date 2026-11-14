// Spatial hash of item ids (spec 44): 4 m buckets aligned with the debris grid (two per chunk side).
export const HASH_CELL_M = 4;
const OFFSET = 256;
const STRIDE = 4096;

const bucket = (v: number): number => Math.floor((v + OFFSET) / HASH_CELL_M) + 1024;
const keyOf = (bx: number, bz: number): number => bx * STRIDE + bz;

export class SpatialHash {
  readonly #cells = new Map<number, Set<number>>();

  insert(id: number, x: number, z: number): void {
    const key = keyOf(bucket(x), bucket(z));
    let set = this.#cells.get(key);
    if (!set) {
      set = new Set();
      this.#cells.set(key, set);
    }
    set.add(id);
  }

  remove(id: number, x: number, z: number): void {
    const key = keyOf(bucket(x), bucket(z));
    const set = this.#cells.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.#cells.delete(key);
  }

  move(id: number, fromX: number, fromZ: number, toX: number, toZ: number): void {
    if (bucket(fromX) === bucket(toX) && bucket(fromZ) === bucket(toZ)) return;
    this.remove(id, fromX, fromZ);
    this.insert(id, toX, toZ);
  }

  /** Ids in every bucket touching the square of half-size `radius` around (x, z); callers filter the exact distance. */
  near(x: number, z: number, radius: number): number[] {
    const found: number[] = [];
    for (let bx = bucket(x - radius); bx <= bucket(x + radius); bx++) {
      for (let bz = bucket(z - radius); bz <= bucket(z + radius); bz++) {
        const set = this.#cells.get(keyOf(bx, bz));
        if (set) for (const id of set) found.push(id);
      }
    }
    return found;
  }
}
