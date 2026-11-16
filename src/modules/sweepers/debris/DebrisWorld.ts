// The debris of one room (plan C.2): cell levels, items, per-hex mass and cleanliness, the
// room-wide delta queue, persistence (state_json v3 `debris`) and respawn.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { isPlainObject } from '../../../core/validation/isPlainObject.ts';
import { penetration } from '../geometry.ts';
import { HEX_CELLS, hexAt } from '../hexGrid.ts';
import { hashString, Rng } from '../random.ts';
import {
  CELLS_PER_CHUNK, cellKg, chunkAt, debrisGrid, dustKg, liveCentre, MAX_LEVEL, openPoint, scoredKg, seedKg
} from './grid.ts';
import type { DebrisGrid } from './grid.ts';
import { SpatialHash } from './SpatialHash.ts';
import {
  CABBAGE_KG, CAN_KG, COPPER_KG, DEBRIS_GEN, DUST_KG_M2, FLAG_BURIED, FLAG_STUCK, IRON_KG, ITEM_KINDS, JACKPOT_CHANCE, JACKPOTS, KIND,
  profileOf, SEED_KG_M2
} from './tables.ts';

/** `[id, kind, xCm, zCm, rf, massDg]`; rf = rot8 | flags << 8. */
export type ItemRow = [number, number, number, number, number, number];
/** `[id, fromXCm, fromZCm, toXCm, toZCm]`. */
export type KickRow = [number, number, number, number, number];

export interface Item {
  id: number;
  kind: number;
  x: number;
  z: number;
  rot8: number;
  flags: number;
  /** Total mass, dg (10 g). */
  massDg: number;
  /** Seed share of a pile, dg (0 for other kinds). */
  seedDg: number;
  /** Hex the item lies in now (-1 outside the grid); its mass counts there. */
  hex: number;
}

/** state_json v3 `debris`. */
export interface DebrisRecord {
  gen: number;
  /** base64(deflateRaw(live chunks' 256 B each, ascending chunk id)). */
  cells: string;
  /** Persisted rows: ItemRow, a pile appends seedDg. */
  items: number[][];
  /** Per-hex index counters (37). */
  next: number[];
  respawnInMs: number;
}

/** One tick's room-wide changes (C.5). */
export interface DebrisDeltas {
  cells: number[];
  add: ItemRow[];
  del: number[];
  kicks: KickRow[];
  hx: Array<[number, number]>;
  /** Chunks with more than 32 changed cells this tick: sent as full loads to the sockets that know them. */
  reload: number[];
}

export const MAX_ITEMS_PER_HEX = 250;
export const MAX_ITEMS_PER_ROOM = 6_000;
export const PILE_MAX_DG = 6_000;
export const PILE_MERGE_M = 1;
export const PILE_OVERFLOW_STEP_M = 0.8;
export const RESPAWN_INTERVAL_MS = 300_000;
export const RESPAWN_SHARE: readonly [number, number] = [0.03, 0.07];
/** Cells of one chunk changed in one tick above which the chunk goes out as a full load. */
export const FULL_LOAD_THRESHOLD = 32;
/** Hard cap of the room-wide part of one `debris_chunk_update`, bytes of JSON. */
export const DELTA_MAX_BYTES = 8_192;
/** Mean of round(15·u), u ∈ [0.7, 1]: the expected cell level at φ = 1. */
export const MEAN_FULL_LEVEL = 12.75;
const MAX_INDEX = 0xffff;
const ITEM_CLEARANCE = 0.3;
const COPPER_NEAR_BUILDING = 6;
const PLACE_TRIES = 10;
/** Room-wide delta overhead reserve (keys, `t`), bytes. */
const DELTA_OVERHEAD = 96;

const cm = (m: number): number => Math.round(m * 100) + 0;
const districtOfHex = (hex: number): number => HEX_CELLS[hex]?.district ?? 0;
const isUint = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/** Mass an item contributes to its hex's M (C.2): jackpots and buried copper count 0. */
function contribution(item: Item): number {
  if (item.kind === KIND.pile) return item.massDg / 100;
  if (item.kind >= KIND.cauldron) return 0;
  if (item.kind === KIND.copper && (item.flags & FLAG_BURIED) !== 0) return 0;
  return scoredKg(item.massDg / 100);
}

/** M_ref per hex (φ = 1, expected levels and mean item masses). */
function buildMref(grid: DebrisGrid): Float64Array {
  const mref = new Float64Array(HEX_CELLS.length);
  for (const cell of HEX_CELLS) {
    const p = profileOf(cell.district);
    const cells = grid.hexCells[cell.id]?.length ?? 0;
    const perCell = (MEAN_FULL_LEVEL / MAX_LEVEL) * (DUST_KG_M2 * p.dust + SEED_KG_M2 * p.seed) * 0.25;
    const items = p.cans * scoredKg(CAN_KG) + p.iron * scoredKg((IRON_KG[0] + IRON_KG[1]) / 2)
      + p.copper * (1 - p.buried) * scoredKg((COPPER_KG[0] + COPPER_KG[1]) / 2) + p.cabbage * scoredKg(CABBAGE_KG);
    mref[cell.id] = cells * perCell + items;
  }
  return mref;
}

let mrefCache: Float64Array | null = null;
const hexMref = (grid: DebrisGrid): Float64Array => (mrefCache ??= buildMref(grid));

/** c10 = clamp(floor(1000·(1 − M/Mref)), 0, 1000). */
export function c10Of(m: number, mref: number): number {
  if (m <= 1e-9 || mref <= 0) return 1000;
  return Math.min(1000, Math.max(0, Math.floor(1000 * (1 - m / mref))));
}

export class DebrisWorld {
  readonly grid: DebrisGrid;
  readonly cells: Uint8Array;
  readonly items = new Map<number, Item>();
  readonly hash = new SpatialHash();
  readonly #mref: Float64Array;
  readonly #m = new Float64Array(HEX_CELLS.length);
  readonly #c10 = new Int16Array(HEX_CELLS.length);
  /** floor(C) last broadcast per hex. */
  readonly #sentFloor = new Int16Array(HEX_CELLS.length);
  readonly #hexItems = new Int32Array(HEX_CELLS.length);
  readonly #next: number[];
  readonly #dirtyHex = new Set<number>();
  #respawnInMs: number;
  #respawnQueue: number[] = [];
  #rng: Rng;
  // Pending room-wide deltas (FIFO, coalesced).
  #cellDelta = new Map<number, number>();
  #itemDelta = new Map<number, ItemRow | null>();
  #kicks: KickRow[] = [];
  #hx = new Map<number, number>();
  #tickCells = new Set<number>();
  #tickChunkCount = new Map<number, number>();
  #changed = true;
  #encoded: DebrisRecord | null = null;
  /** Respawn multiplier per hex (Phase D fencing, 41); 1 by default. */
  respawnFactor: (hex: number) => number = () => 1;

  private constructor(grid: DebrisGrid, cells: Uint8Array, next: number[], respawnInMs: number, seed: number) {
    this.grid = grid;
    this.cells = cells;
    this.#mref = hexMref(grid);
    this.#next = next;
    this.#respawnInMs = respawnInMs;
    this.#rng = new Rng(seed);
  }

  /** Fresh debris for a room whose hexes have cleanliness `c0` (0..100 by hex id). */
  static generate(roomId: string, c0: readonly number[], seed: number): DebrisWorld {
    const grid = debrisGrid();
    const world = new DebrisWorld(grid, new Uint8Array(grid.liveChunks.length * CELLS_PER_CHUNK), HEX_CELLS.map(() => 0), RESPAWN_INTERVAL_MS, seed);
    const rng = new Rng(hashString(`${roomId}:debris:${DEBRIS_GEN}`));
    for (const hex of HEX_CELLS) {
      const phi = Math.min(1, Math.max(0, (100 - (c0[hex.id] ?? 0)) / 100));
      for (const index of grid.hexCells[hex.id] ?? []) {
        const dust = Math.round(MAX_LEVEL * phi * rng.range(0.7, 1));
        const seedLevel = Math.round(MAX_LEVEL * phi * rng.range(0.7, 1));
        world.cells[index] = (dust << 4) | seedLevel;
      }
      const p = profileOf(hex.district);
      for (let i = Math.round(p.cans * phi); i > 0; i--) world.#spawnRandom(rng, hex.id, KIND.can, CAN_KG, rng.chance(p.stuck) ? FLAG_STUCK : 0);
      for (let i = Math.round(p.iron * phi); i > 0; i--) world.#spawnRandom(rng, hex.id, KIND.iron, rng.range(IRON_KG[0], IRON_KG[1]), 0);
      for (let i = Math.round(p.copper * phi); i > 0; i--) {
        world.#spawnRandom(rng, hex.id, KIND.copper, rng.range(COPPER_KG[0], COPPER_KG[1]), rng.chance(p.buried) ? FLAG_BURIED : 0, true);
      }
      for (let i = Math.round(p.cabbage * phi); i > 0; i--) world.#spawnRandom(rng, hex.id, KIND.cabbage, CABBAGE_KG, 0);
      world.#rollJackpot(rng, hex.id);
    }
    world.#recomputeAll();
    world.#clearDeltas();
    return world;
  }

  /** A world from a stored record, or null when any part is invalid or corrupt (the caller regenerates). */
  static restore(value: unknown, seed: number): DebrisWorld | null {
    if (!isPlainObject(value)) return null;
    const { gen, cells, items, next, respawnInMs } = value;
    if (gen !== DEBRIS_GEN || typeof cells !== 'string' || !Array.isArray(items) || !Array.isArray(next)) return null;
    if (!isUint(respawnInMs, RESPAWN_INTERVAL_MS) || next.length !== HEX_CELLS.length || !next.every((n) => isUint(n, MAX_INDEX + 1))) return null;
    if (items.length > MAX_ITEMS_PER_ROOM * 4) return null;
    const grid = debrisGrid();
    let bytes: Buffer;
    try {
      bytes = inflateRawSync(Buffer.from(cells, 'base64'));
    } catch {
      return null;
    }
    if (bytes.length !== grid.liveChunks.length * CELLS_PER_CHUNK) return null;
    const cellArray = new Uint8Array(bytes);
    // Dead cells are always 0.
    for (let i = 0; i < cellArray.length; i++) if ((grid.cellHex[i] ?? -1) < 0) cellArray[i] = 0;
    const world = new DebrisWorld(grid, cellArray, next.map((n) => Number(n)), respawnInMs, seed);
    for (const row of items) {
      const item = parsePersistedRow(row);
      if (!item || world.items.has(item.id)) return null;
      world.#insert(item);
    }
    world.#recomputeAll();
    world.#clearDeltas();
    world.#encoded = { gen: DEBRIS_GEN, cells, items: items.map((r: unknown) => (Array.isArray(r) ? r.map(Number) : [])), next: [...world.#next], respawnInMs };
    world.#changed = false;
    return world;
  }

  /** Cleanliness ×10 (0..1000) of a hex. */
  c10(hex: number): number {
    this.#refresh();
    return this.#c10[hex] ?? 1000;
  }

  /** Current M of a hex, kg. */
  massOf(hex: number): number {
    return this.#m[hex] ?? 0;
  }

  mrefOf(hex: number): number {
    return this.#mref[hex] ?? 0;
  }

  get itemCount(): number {
    return this.items.size;
  }

  /** The persisted form; re-encoded only when the debris changed since the last call. */
  record(): DebrisRecord {
    if (this.#encoded && !this.#changed) return { ...this.#encoded, respawnInMs: Math.round(this.#respawnInMs) };
    const items = [...this.items.values()].map((item) => (item.kind === KIND.pile ? [...rowOf(item), item.seedDg] : rowOf(item)));
    this.#encoded = {
      gen: DEBRIS_GEN,
      cells: deflateRawSync(this.cells).toString('base64'),
      items,
      next: [...this.#next],
      respawnInMs: Math.round(this.#respawnInMs)
    };
    this.#changed = false;
    return this.#encoded;
  }

  // ---- cells ----

  /** Sets a live cell's byte, keeping M and the deltas up to date. */
  setCell(index: number, byte: number): void {
    const hex = this.grid.cellHex[index] ?? -1;
    if (hex < 0) return;
    const old = this.cells[index] ?? 0;
    if (old === byte) return;
    const district = districtOfHex(hex);
    this.#m[hex] = (this.#m[hex] ?? 0) + cellKg(byte, district) - cellKg(old, district);
    this.cells[index] = byte;
    this.#dirtyHex.add(hex);
    this.#cellDelta.set(index, byte);
    if (!this.#tickCells.has(index)) {
      this.#tickCells.add(index);
      const slot = index >> 8;
      this.#tickChunkCount.set(slot, (this.#tickChunkCount.get(slot) ?? 0) + 1);
    }
    this.#changed = true;
  }

  // ---- items ----

  /** Items within `radius` of (x, z) (exact distance), with their distance. */
  itemsNear(x: number, z: number, radius: number): Array<{ item: Item; d: number }> {
    const found: Array<{ item: Item; d: number }> = [];
    for (const id of this.hash.near(x, z, radius)) {
      const item = this.items.get(id);
      if (!item) continue;
      const d = Math.hypot(item.x - x, item.z - z);
      if (d <= radius) found.push({ item, d });
    }
    return found.sort((a, b) => a.d - b.d || a.item.id - b.item.id);
  }

  /** Spawns a world item (generation, respawn): skipped (null) over the per-hex or per-room cap. */
  spawn(kind: number, x: number, z: number, massDg: number, flags: number, rot8: number): Item | null {
    const hex = hexAt(x, z)?.id ?? -1;
    if (hex < 0 || this.items.size >= MAX_ITEMS_PER_ROOM || (this.#hexItems[hex] ?? 0) >= MAX_ITEMS_PER_HEX) return null;
    return this.#create(hex, kind, x, z, massDg, 0, flags, rot8);
  }

  /** Creates an item that holds player mass (dump, piles): never skipped by the caps, so nothing is lost. */
  place(kind: number, x: number, z: number, massDg: number, seedDg: number, rot8: number): Item | null {
    const hex = hexAt(x, z)?.id ?? -1;
    if (hex < 0) return null;
    return this.#create(hex, kind, x, z, massDg, seedDg, 0, rot8);
  }

  remove(id: number): Item | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    this.items.delete(id);
    this.hash.remove(id, item.x, item.z);
    if (item.hex >= 0) {
      this.#m[item.hex] = (this.#m[item.hex] ?? 0) - contribution(item);
      this.#hexItems[item.hex] = (this.#hexItems[item.hex] ?? 0) - 1;
      this.#dirtyHex.add(item.hex);
    }
    this.#itemDelta.set(id, null);
    this.#changed = true;
    return item;
  }

  /** Moves an item and/or changes its flags or masses (the row replaces the old one). */
  update(item: Item, change: { x?: number; z?: number; flags?: number; massDg?: number; seedDg?: number }): void {
    const x = change.x ?? item.x;
    const z = change.z ?? item.z;
    this.#uncount(item);
    this.hash.move(item.id, item.x, item.z, x, z);
    item.x = x;
    item.z = z;
    item.hex = hexAt(x, z)?.id ?? -1;
    if (change.flags !== undefined) item.flags = change.flags;
    if (change.massDg !== undefined) item.massDg = change.massDg;
    if (change.seedDg !== undefined) item.seedDg = change.seedDg;
    this.#count(item);
    this.#itemDelta.set(item.id, rowOf(item));
    this.#changed = true;
  }

  /** Records a kick animation (the item's new row goes out in `add` as well). */
  kick(row: KickRow): void {
    this.#kicks.push(row);
  }

  /**
   * Deposits dust + seed (kg) as piles at (x, z): merged into a pile within `mergeM`, at most 60 kg per
   * pile, the overflow starting new piles 0.8 m further along (dirX, dirZ). Points that are not open fall
   * back towards (backX, backZ). Returns the kg that could not be placed (0 normally).
   */
  deposit(x: number, z: number, dustKgIn: number, seedKgIn: number, dirX: number, dirZ: number, mergeM: number, backX: number, backZ: number, unlocked?: ReadonlySet<number>): number {
    let dust = Math.max(0, dustKgIn);
    let seed = Math.max(0, seedKgIn);
    let px = x;
    let pz = z;
    for (let guard = 0; guard < 64 && dust + seed >= 0.005; guard++) {
      const at = this.openToward(px, pz, backX, backZ, unlocked);
      if (!at) break;
      const totalDg = Math.round((dust + seed) * 100);
      const pile = this.itemsNear(at.x, at.z, mergeM).find(({ item }) => item.kind === KIND.pile && item.massDg < PILE_MAX_DG)?.item;
      const room = pile ? PILE_MAX_DG - pile.massDg : PILE_MAX_DG;
      const takeDg = Math.min(totalDg, room);
      const seedShare = dust + seed > 0 ? seed / (dust + seed) : 0;
      const seedDg = Math.round(takeDg * seedShare);
      if (pile) this.update(pile, { massDg: pile.massDg + takeDg, seedDg: pile.seedDg + seedDg });
      else if (!this.place(KIND.pile, at.x, at.z, takeDg, seedDg, 0)) break;
      const takenKg = takeDg / 100;
      const takenSeed = seedDg / 100;
      seed = Math.max(0, seed - takenSeed);
      dust = Math.max(0, dust - (takenKg - takenSeed));
      px = at.x + dirX * PILE_OVERFLOW_STEP_M;
      pz = at.z + dirZ * PILE_OVERFLOW_STEP_M;
    }
    return dust + seed < 0.005 ? 0 : dust + seed;
  }

  /** (x, z) when open (and, given `unlocked`, in an unlocked district), else the first such point stepping 0.5 m towards (backX, backZ); null when none. */
  openToward(x: number, z: number, backX: number, backZ: number, unlocked?: ReadonlySet<number>): { x: number; z: number } | null {
    const length = Math.hypot(backX - x, backZ - z);
    const steps = Math.ceil(length / 0.5);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      const px = x + (backX - x) * t;
      const pz = z + (backZ - z) * t;
      if (openPoint(this.grid, px, pz) && (!unlocked || unlocked.has(hexAt(px, pz)?.district ?? 0))) return { x: px, z: pz };
    }
    return null;
  }

  /** A fresh item id in `hex` (C.2): counter, then the lowest free index after 0xFFFF. */
  allocateId(hex: number): number | null {
    const next = this.#next[hex] ?? 0;
    if (next <= MAX_INDEX) {
      this.#next[hex] = next + 1;
      return (hex << 16) | next;
    }
    for (let index = 0; index <= MAX_INDEX; index++) {
      const id = (hex << 16) | index;
      if (!this.items.has(id)) return id;
    }
    return null;
  }

  /** Test / tooling hook: the index counter of a hex. */
  setNextIndex(hex: number, value: number): void {
    this.#next[hex] = value;
  }

  // ---- chunks ----

  /** The full chunk for a `load` entry. */
  chunkPayload(chunkId: number): { id: number; c: string; i: ItemRow[] } {
    const slot = this.grid.slotOf[chunkId] ?? -1;
    const bytes = slot < 0 ? new Uint8Array(CELLS_PER_CHUNK) : this.cells.subarray(slot * CELLS_PER_CHUNK, (slot + 1) * CELLS_PER_CHUNK);
    const centreX = -256 + ((chunkId % 64) + 0.5) * 8;
    const centreZ = -256 + (Math.floor(chunkId / 64) + 0.5) * 8;
    const items: ItemRow[] = [];
    for (const id of this.hash.near(centreX, centreZ, 4)) {
      const item = this.items.get(id);
      if (item && chunkAt(item.x, item.z) === chunkId) items.push(rowOf(item));
    }
    items.sort((a, b) => a[0] - b[0]);
    return { id: chunkId, c: Buffer.from(bytes).toString('base64'), i: items };
  }

  // ---- deltas ----

  /** Takes this tick's coalesced deltas within `maxBytes` of JSON; the rest carries over FIFO. */
  takeDeltas(maxBytes = DELTA_MAX_BYTES): DebrisDeltas {
    this.#refresh();
    const reload: number[] = [];
    for (const [slot, count] of this.#tickChunkCount) {
      if (count <= FULL_LOAD_THRESHOLD) continue;
      const chunkId = this.grid.liveChunks[slot] ?? -1;
      if (chunkId < 0) continue;
      reload.push(chunkId);
      for (let i = slot * CELLS_PER_CHUNK; i < (slot + 1) * CELLS_PER_CHUNK; i++) this.#cellDelta.delete(i);
    }
    this.#tickChunkCount.clear();
    this.#tickCells.clear();
    let budget = maxBytes - DELTA_OVERHEAD;
    const out: DebrisDeltas = { cells: [], add: [], del: [], kicks: [], hx: [], reload };
    const fits = (size: number): boolean => {
      if (size > budget) return false;
      budget -= size;
      return true;
    };
    for (const [id, row] of this.#itemDelta) {
      if (!fits(row === null ? String(id).length + 1 : JSON.stringify(row).length + 1)) break;
      if (row === null) out.del.push(id);
      else out.add.push(row);
      this.#itemDelta.delete(id);
    }
    while (this.#kicks.length > 0) {
      const kick = this.#kicks[0];
      if (!kick || !fits(JSON.stringify(kick).length + 1)) break;
      out.kicks.push(kick);
      this.#kicks.shift();
    }
    for (const [hex, c10] of this.#hx) {
      if (!fits(String(hex).length + String(c10).length + 4)) break;
      out.hx.push([hex, c10]);
      this.#hx.delete(hex);
    }
    for (const [index, byte] of this.#cellDelta) {
      const chunkId = this.grid.liveChunks[index >> 8] ?? 0;
      const cell = index & 255;
      if (!fits(String(chunkId).length + String(cell).length + String(byte).length + 3)) break;
      out.cells.push(chunkId, cell, byte);
      this.#cellDelta.delete(index);
    }
    return out;
  }

  // ---- respawn ----

  /** Advances the respawn timer by one tick (`dtMs` of loaded room time); processes at most one hex. */
  tickRespawn(dtMs: number): void {
    this.#respawnInMs -= Math.max(0, dtMs);
    if (this.#respawnInMs <= 0) {
      this.#respawnInMs += RESPAWN_INTERVAL_MS;
      if (this.#respawnInMs <= 0) this.#respawnInMs = RESPAWN_INTERVAL_MS;
      this.#respawnQueue = HEX_CELLS.map((c) => c.id);
    }
    const hex = this.#respawnQueue.shift();
    if (hex !== undefined) this.respawnHex(hex);
  }

  get respawnInMs(): number {
    return this.#respawnInMs;
  }

  /** Respawns one hex (C.2): +3..7 % of Mref (capped at Mref, times the fence factor), 90 % into cells, 10 % into items, plus the jackpot roll. */
  respawnHex(hex: number): void {
    const m = this.#m[hex] ?? 0;
    const mref = this.#mref[hex] ?? 0;
    if (m <= 1e-9 || mref <= 0) return;
    const add = Math.min(this.#rng.range(RESPAWN_SHARE[0], RESPAWN_SHARE[1]) * mref, mref - m) * this.respawnFactor(hex);
    if (add <= 0) return;
    const district = districtOfHex(hex);
    const p = profileOf(district);
    const dustRate = DUST_KG_M2 * p.dust;
    const seedRate = SEED_KG_M2 * p.seed;
    let dustBudget = add * 0.9 * (dustRate / (dustRate + seedRate));
    let seedBudget = add * 0.9 - dustBudget;
    const cells = this.grid.hexCells[hex];
    if (cells && cells.length > 0) {
      for (let tries = 0; (dustBudget > 0 || seedBudget > 0) && tries < cells.length * 4; tries++) {
        const index = cells[this.#rng.int(0, cells.length - 1)] ?? 0;
        const byte = this.cells[index] ?? 0;
        const useDust = dustBudget > 0 && (seedBudget <= 0 || this.#rng.chance(0.5));
        const level = useDust ? byte >> 4 : byte & 15;
        if (level >= MAX_LEVEL) continue;
        const raised = Math.min(MAX_LEVEL, level + this.#rng.int(1, 3));
        if (useDust) {
          dustBudget -= dustKg(raised, district) - dustKg(level, district);
          this.setCell(index, (raised << 4) | (byte & 15));
        } else {
          seedBudget -= seedKg(raised, district) - seedKg(level, district);
          this.setCell(index, (byte & 0xf0) | raised);
        }
      }
    }
    const weights: Array<[number, number]> = [[KIND.can, p.cans], [KIND.iron, p.iron], [KIND.copper, p.copper], [KIND.cabbage, p.cabbage]];
    const total = weights.reduce((s, [, w]) => s + w, 0);
    let itemBudget = add * 0.1;
    for (let guard = 0; guard < 200 && total > 0; guard++) {
      let pick = this.#rng.next() * total;
      let kind: number = KIND.can;
      for (const [k, w] of weights) {
        pick -= w;
        if (pick < 0) {
          kind = k;
          break;
        }
      }
      const kg = kind === KIND.can ? CAN_KG : kind === KIND.iron ? this.#rng.range(IRON_KG[0], IRON_KG[1])
        : kind === KIND.copper ? this.#rng.range(COPPER_KG[0], COPPER_KG[1]) : CABBAGE_KG;
      if (scoredKg(kg) > itemBudget) break;
      const flags = kind === KIND.can && this.#rng.chance(p.stuck) ? FLAG_STUCK : kind === KIND.copper && this.#rng.chance(p.buried) ? FLAG_BURIED : 0;
      if (this.#spawnRandom(this.#rng, hex, kind, kg, flags, kind === KIND.copper)) itemBudget -= flags & FLAG_BURIED ? 0 : scoredKg(kg);
      else break;
    }
    this.#rollJackpot(this.#rng, hex);
  }

  // ---- internals ----

  #create(hex: number, kind: number, x: number, z: number, massDg: number, seedDg: number, flags: number, rot8: number): Item | null {
    const id = this.allocateId(hex);
    if (id === null) return null;
    const item: Item = { id, kind, x, z, rot8: rot8 & 0xff, flags, massDg: Math.max(1, Math.round(massDg)), seedDg, hex: -1 };
    this.#insert(item);
    this.#itemDelta.set(id, rowOf(item));
    this.#changed = true;
    return item;
  }

  #insert(item: Item): void {
    item.hex = hexAt(item.x, item.z)?.id ?? -1;
    this.items.set(item.id, item);
    this.hash.insert(item.id, item.x, item.z);
    this.#count(item);
  }

  #count(item: Item): void {
    if (item.hex < 0) return;
    this.#m[item.hex] = (this.#m[item.hex] ?? 0) + contribution(item);
    this.#hexItems[item.hex] = (this.#hexItems[item.hex] ?? 0) + 1;
    this.#dirtyHex.add(item.hex);
  }

  #uncount(item: Item): void {
    if (item.hex < 0) return;
    this.#m[item.hex] = (this.#m[item.hex] ?? 0) - contribution(item);
    this.#hexItems[item.hex] = (this.#hexItems[item.hex] ?? 0) - 1;
    this.#dirtyHex.add(item.hex);
  }

  /** Places a spawned item at a random live cell of `hex` with 0.3 m collider clearance (10 tries). */
  #spawnRandom(rng: Rng, hex: number, kind: number, kg: number, flags: number, nearBuilding = false): Item | null {
    const cells = this.grid.hexCells[hex];
    if (!cells || cells.length === 0) return null;
    let fallback: { x: number; z: number } | null = null;
    for (let tries = 0; tries < PLACE_TRIES * (nearBuilding ? 2 : 1); tries++) {
      const centre = liveCentre(this.grid, cells[rng.int(0, cells.length - 1)] ?? 0);
      const x = centre.x + rng.range(-0.25, 0.25);
      const z = centre.z + rng.range(-0.25, 0.25);
      if (hexAt(x, z)?.id !== hex) continue;
      if (this.grid.colliders.near(x, z, ITEM_CLEARANCE).some((c) => penetration(c, x, z, ITEM_CLEARANCE) !== null)) continue;
      if (nearBuilding && tries < PLACE_TRIES) {
        const near = this.grid.buildingBoxes.near(x, z, COPPER_NEAR_BUILDING).some((c) => penetration(c, x, z, COPPER_NEAR_BUILDING) !== null);
        if (!near) {
          fallback ??= { x, z };
          continue;
        }
      }
      return this.spawn(kind, x, z, kg * 100, flags, rng.int(0, 255));
    }
    return fallback ? this.spawn(kind, fallback.x, fallback.z, kg * 100, flags, rng.int(0, 255)) : null;
  }

  #rollJackpot(rng: Rng, hex: number): void {
    if (!rng.chance(JACKPOT_CHANCE)) return;
    let pick = rng.next();
    let spec = JACKPOTS[0];
    for (const j of JACKPOTS) {
      pick -= j.weight;
      spec = j;
      if (pick < 0) break;
    }
    if (spec) this.#spawnRandom(rng, hex, spec.kind, spec.kg, 0);
  }

  #recomputeAll(): void {
    this.#m.fill(0);
    this.#hexItems.fill(0);
    for (let i = 0; i < this.cells.length; i++) {
      const hex = this.grid.cellHex[i] ?? -1;
      if (hex >= 0) this.#m[hex] = (this.#m[hex] ?? 0) + cellKg(this.cells[i] ?? 0, districtOfHex(hex));
    }
    for (const item of this.items.values()) this.#count(item);
    for (const cell of HEX_CELLS) {
      const c10 = c10Of(this.#m[cell.id] ?? 0, this.#mref[cell.id] ?? 0);
      this.#c10[cell.id] = c10;
      this.#sentFloor[cell.id] = Math.floor(c10 / 10);
    }
    this.#dirtyHex.clear();
  }

  #refresh(): void {
    for (const hex of this.#dirtyHex) {
      const c10 = c10Of(this.#m[hex] ?? 0, this.#mref[hex] ?? 0);
      this.#c10[hex] = c10;
      const floor = Math.floor(c10 / 10);
      if (floor !== this.#sentFloor[hex]) {
        this.#sentFloor[hex] = floor;
        this.#hx.set(hex, c10);
      }
    }
    this.#dirtyHex.clear();
  }

  #clearDeltas(): void {
    this.#cellDelta.clear();
    this.#itemDelta.clear();
    this.#kicks = [];
    this.#hx.clear();
    this.#tickCells.clear();
    this.#tickChunkCount.clear();
  }
}

export function rowOf(item: Item): ItemRow {
  return [item.id, item.kind, cm(item.x), cm(item.z), (item.rot8 & 0xff) | (item.flags << 8), item.massDg];
}

/** A persisted row as an item, or null when invalid. */
function parsePersistedRow(row: unknown): Item | null {
  if (!Array.isArray(row) || row.length < 6 || row.length > 7) return null;
  const [id, kind, xCm, zCm, rf, massDg, seedDg] = row;
  if (!isUint(id, 0xffffffff) || !isUint(kind, ITEM_KINDS.length - 1) || !isUint(rf, 0xffff) || !isUint(massDg, 1_000_000)) return null;
  if ((id >>> 16) >= HEX_CELLS.length || massDg < 1) return null;
  if (typeof xCm !== 'number' || typeof zCm !== 'number' || !Number.isInteger(xCm) || !Number.isInteger(zCm)) return null;
  if (Math.abs(xCm) > 25_600 || Math.abs(zCm) > 25_600) return null;
  const isPile = kind === KIND.pile;
  if (isPile !== (row.length === 7)) return null;
  const seed = isPile ? seedDg : 0;
  if (!isUint(seed, massDg)) return null;
  return { id, kind, x: xCm / 100, z: zCm / 100, rot8: rf & 0xff, flags: rf >> 8, massDg, seedDg: seed, hex: -1 };
}
