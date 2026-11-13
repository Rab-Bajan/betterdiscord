// Per-socket chunk interest (plan C.5): which chunks a socket knows, which it should load next
// (nearest first) and which it should drop. Load radius 48 m, drop radius 64 m (hysteresis); the
// interest is recomputed only after the player moved more than 4 m.
import { CHUNK_M, CHUNKS_N, chunkCentre, chunkIdOf, GRID_ORIGIN } from './grid.ts';
import type { DebrisGrid } from './grid.ts';

export const LOAD_RADIUS_M = 48;
export const DROP_RADIUS_M = 64;
export const RECOMPUTE_MOVE_M = 4;
export const JOIN_BURST_CHUNKS = 32;
export const TICK_MAX_CHUNKS = 16;
export const TICK_MAX_LOAD_BYTES = 8_192;

const distanceTo = (chunkId: number, x: number, z: number): number => {
  const c = chunkCentre(chunkId);
  return Math.hypot(c.x - x, c.z - z);
};

/** Live chunks whose centre is within `radius` of (x, z), nearest first. */
export function chunksWithin(grid: DebrisGrid, x: number, z: number, radius: number): number[] {
  const lo = (v: number): number => Math.max(0, Math.floor((v - radius - GRID_ORIGIN) / CHUNK_M));
  const hi = (v: number): number => Math.min(CHUNKS_N - 1, Math.floor((v + radius - GRID_ORIGIN) / CHUNK_M));
  const found: Array<[number, number]> = [];
  for (let cz = lo(z); cz <= hi(z); cz++) {
    for (let cx = lo(x); cx <= hi(x); cx++) {
      const id = chunkIdOf(cx, cz);
      if ((grid.slotOf[id] ?? -1) < 0) continue;
      const d = distanceTo(id, x, z);
      if (d <= radius) found.push([id, d]);
    }
  }
  return found.sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([id]) => id);
}

export class ChunkInterest {
  readonly known = new Set<number>();
  #queue: number[] = [];
  /** Chunks the socket knows that must be re-sent in full (the >32-cells rule). */
  readonly #reload = new Set<number>();
  #centre: { x: number; z: number } | null = null;
  readonly #grid: DebrisGrid;

  constructor(grid: DebrisGrid) {
    this.#grid = grid;
  }

  /** Pending chunk loads (tests). */
  get pending(): number {
    return this.#queue.length + this.#reload.size;
  }

  /** Re-evaluates the interest around (x, z) when moved > 4 m (or never evaluated); returns the dropped chunks. */
  update(x: number, z: number): number[] {
    if (this.#centre && Math.hypot(x - this.#centre.x, z - this.#centre.z) <= RECOMPUTE_MOVE_M) return [];
    this.#centre = { x, z };
    const dropped: number[] = [];
    for (const id of this.known) {
      if (distanceTo(id, x, z) > DROP_RADIUS_M) {
        this.known.delete(id);
        this.#reload.delete(id);
        dropped.push(id);
      }
    }
    const queued = new Set(this.#queue.filter((id) => distanceTo(id, x, z) <= DROP_RADIUS_M));
    for (const id of chunksWithin(this.#grid, x, z, LOAD_RADIUS_M)) if (!this.known.has(id)) queued.add(id);
    this.#queue = [...queued].sort((a, b) => distanceTo(a, x, z) - distanceTo(b, x, z) || a - b);
    return dropped.sort((a, b) => a - b);
  }

  /** Queues a full re-send of a chunk the socket knows. */
  reload(chunkId: number): void {
    if (this.known.has(chunkId)) this.#reload.add(chunkId);
  }

  /**
   * Takes the next chunks to send, nearest first (re-sends before new ones): at most `maxChunks`,
   * and at most `maxBytes` by `sizeOf` (the first chunk is always taken). Marks them known.
   */
  take(maxChunks: number, maxBytes: number, sizeOf: (chunkId: number) => number): number[] {
    const taken: number[] = [];
    let bytes = 0;
    const tryTake = (id: number): boolean => {
      if (taken.length >= maxChunks) return false;
      const size = sizeOf(id);
      if (taken.length > 0 && bytes + size > maxBytes) return false;
      bytes += size;
      taken.push(id);
      this.known.add(id);
      return true;
    };
    for (const id of [...this.#reload]) {
      if (!tryTake(id)) return taken;
      this.#reload.delete(id);
    }
    while (this.#queue.length > 0) {
      const id = this.#queue[0];
      if (id === undefined || !tryTake(id)) break;
      this.#queue.shift();
    }
    return taken;
  }
}
