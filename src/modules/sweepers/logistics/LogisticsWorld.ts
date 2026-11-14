// The logistics network of one room (plan D.2): structures and their port links, belt cargo
// (lots and bags as 1-D queues), hoppers, packagers, jams, bags on the ground, throws, the crane,
// telemetry, the coalesced `logistics_update` and the persisted v4 `logistics` blob.
import type { CityLayout, Collider } from '../city/layoutTypes.ts';
import type { DebrisWorld } from '../debris/DebrisWorld.ts';
import { emptyLoad, isEmptyLoad, loadKg } from '../debris/personal.ts';
import type { Load } from '../debris/personal.ts';
import { jackpotOf } from '../debris/tables.ts';
import { moveLoad, spill } from '../debris/tools.ts';
import { ColliderIndex, groundHeight, penetration } from '../geometry.ts';
import { hexAt } from '../hexGrid.ts';
import { CRANE_LEGS } from './placement.ts';
import type { PlaceSpec } from './placement.ts';
import {
  colliderOf, deckAt, expand, footprint, inRect, pathPoint, portKey, projectS, rectDistance, rotate, worldPort
} from './shapes.ts';
import type { Rect, Structure, WorldPort } from './shapes.ts';
import {
  bagTier, BELT_MPS, BIG_BAG, BIG_BAG_FILL_M, CAPS, CARGO_PITCH_M, CRANE, DROP_POWER, FENCE_STOP_M,
  GRAVITY, groupKg, GROUP_BULK, GROUP_COPPER, GROUP_FERROUS, HOPPER_BAG_QUEUE, HOPPER_EMIT_MS, HOPPER_INTAKE_TOP_M, HOPPER_KG,
  isBeltLike, isFoundation, isJunction, JAM_MS, jackpotGroup, LANDMARK_HOPPER, LANDMARK_INTAKE_PAD_M, LANDMARK_INTAKE_TOP_M, LOT_KG,
  PACKAGER_BAG_KG, PACKAGER_CYCLE_MS, PACKAGER_FLUSH_MS, PACKAGER_KG, RUPTURE_CHANCE, RUPTURE_FALL_M, RUPTURE_SHARP_KG, sharpKg,
  STACK_MAX, STACK_SLIDE_M, structSpec, THROW_MAX_STEPS, THROW_STEP_S, TYPE, VALUE_FT_PER_KG, WATTS_PER_M, deckOffset
} from './tables.ts';

/** `[id, type, xCm, zCm, baseYCm, rot, lvl, flags]`. */
export type StructRow = [number, number, number, number, number, number, number, number];
/** `[id, tier, tint, st, xCm, yCm, zCm, rot8, kgDg]`. */
export type BagRow = [number, number, number, number, number, number, number, number, number];
/** `[id, kind, sub, tint, node, sMm, route, mv, kgDg]`. */
export type CargoRow = [number, number, number, number, number, number, number, number, number];
/** `[id, fxCm, fyCm, fzCm, txCm, tyCm, tzCm, apexYCm, durMs]`. */
export type ArcRow = [number, number, number, number, number, number, number, number, number];
export type BurstRow = [number, number, number];
/** `[nodeId, kgDg]`. */
export type FillRow = [number, number];

export interface CraneJob {
  bag: number;
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  t0: number;
  durMs: number;
}

/** `init_state.logistics`. */
export interface LogisticsInit {
  v: 1;
  beltMps: number;
  structures: StructRow[];
  bags: BagRow[];
  cargo: CargoRow[];
  hoppers: FillRow[];
  packagers: FillRow[];
  crane: { hook: [number, number]; job: CraneJob | null };
}

/** `miskolc:logistics_update`. */
export interface LogisticsUpdate {
  t: number;
  s?: StructRow[];
  sdel?: number[];
  b?: BagRow[];
  c?: CargoRow[];
  del?: number[];
  arcs?: ArcRow[];
  burst?: BurstRow[];
  crane?: CraneJob | null;
  hop?: FillRow[];
  pk?: FillRow[];
}

/** `miskolc:logistics_telemetry`. */
export interface LogisticsTelemetry {
  kgMin: number;
  loadPct: number;
  kW: number;
  ftHour: number;
  beltM: number;
  jams: number;
}

/** Bag states: 0 ground, 1 carried, 2 crane, 3 cargo (internal: on a belt or in a hopper queue). */
export interface Bag {
  id: number;
  tier: number;
  tint: number;
  st: 0 | 1 | 2 | 3;
  x: number;
  y: number;
  z: number;
  rot8: number;
  load: Load;
  /** The ground bag this one rests on (0: none). */
  on: number;
  /** Carrier's short player id (st 1). */
  carrier: number;
}

export interface Cargo {
  id: number;
  kind: 0 | 1;
  /** Lot group (lots) or bag tier (bags). */
  sub: number;
  tint: number;
  node: number;
  s: number;
  /** Splitter route (0 straight, 1 left, 2 right); 0 elsewhere. */
  route: number;
  /** Merger entry (0 left, 1 right). */
  way: number;
  mv: 0 | 1;
  waitMs: number;
  /** Lot contents (a bag's are on `bag.load`). */
  load: Load;
  bag: Bag | null;
  /** Tick stamp of the last move: a cargo moves at most once per tick. */
  tick: number;
}

type Target = { kind: 'node'; node: number; entry: number } | { kind: 'hopper'; node: number } | { kind: 'open' };

interface LogNode {
  id: number;
  type: number;
  /** null for the landmark hopper. */
  st: Structure | null;
  len: number;
  /** Head (largest s) first. */
  queue: Cargo[];
  ins: WorldPort[];
  outs: WorldPort[];
  targets: Target[];
  /** Hopper / packager buffer. */
  buffer: Load | null;
  /** Hopper emit timer or packager cycle timer, ms. */
  timer: number;
  /** Packager: ms since the last input. */
  idleMs: number;
  /** Hopper round-robin next group. */
  rr: number;
  /** Merger: entry used last. */
  lastIn: number;
  /** Hopper intake zone and the height above ground it accepts throws up to. */
  intake: Rect | null;
  intakeTop: number;
}

/** What the world needs from its room. */
export interface LogisticsDeps {
  debris: DebrisWorld;
  layout: CityLayout;
  /** The room's open districts (read live). */
  unlocked: ReadonlySet<number>;
  /** Random draw (rupture), injectable for tests. */
  chance(p: number): boolean;
}

/** Outcome of a throw (ack fields). */
export interface ThrowResult {
  id: number;
  to: [number, number, number];
  into: 'ground' | 'belt' | 'hopper';
  burst: boolean;
}

const EPS = 1e-6;
const cm = (m: number): number => Math.round(m * 100) + 0;
const dg = (load: Load): number => Math.round(loadKg(load) * 100);
const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const MAX_ID = 0xffff;
const DELTA_MAX_BYTES = 8_192;
const DELTA_OVERHEAD = 128;
const LANDING_TRIES = 6;

/** The rotation byte of a heading. */
export const rot8Of = (rotY: number): number => Math.round((rotY / (Math.PI * 2)) * 256) & 0xff;
const dirOf = (rotY: number): { x: number; z: number } => ({ x: -Math.sin(rotY) + 0, z: -Math.cos(rotY) + 0 });

export function addLoad(to: Load, from: Load): void {
  to.dustG += from.dustG;
  to.seedG += from.seedG;
  to.cans += from.cans;
  to.crushed += from.crushed;
  to.ironG += from.ironG;
  to.copperG += from.copperG;
  to.jackpots.push(...from.jackpots);
}

const cloneLoad = (load: Load): Load => ({ ...load, jackpots: [...load.jackpots] });
const jackpotKg = (kind: number): number => jackpotOf(kind)?.kg ?? 0;

/** Moves one group's fields of `from` into a fresh load. */
function takeGroup(from: Load, group: number): Load {
  const part = emptyLoad();
  if (group === GROUP_BULK) {
    part.dustG = from.dustG;
    part.seedG = from.seedG;
    from.dustG = 0;
    from.seedG = 0;
  } else if (group === GROUP_FERROUS) {
    part.ironG = from.ironG;
    part.cans = from.cans;
    part.crushed = from.crushed;
    from.ironG = 0;
    from.cans = 0;
    from.crushed = 0;
  } else {
    part.copperG = from.copperG;
    from.copperG = 0;
  }
  part.jackpots = from.jackpots.filter((k) => jackpotGroup(k) === group);
  from.jackpots = from.jackpots.filter((k) => jackpotGroup(k) !== group);
  return part;
}

/** Cuts up to `maxKg` from `from` into a new load; a single jackpot heavier than that moves alone. */
function cut(from: Load, maxKg: number, maxL: number): Load {
  const out = emptyLoad();
  if (moveLoad(from, out, maxKg, maxL) <= EPS && from.jackpots.length > 0) {
    const kind = from.jackpots.shift();
    if (kind !== undefined) out.jackpots.push(kind);
  }
  return out;
}

/** The dominant lot group of a load by mass. */
function dominantGroup(load: Load): number {
  const kg = [GROUP_BULK, GROUP_FERROUS, GROUP_COPPER].map((g) => groupKg(load, g, jackpotKg));
  let best = 0;
  for (let g = 1; g < 3; g++) if ((kg[g] ?? 0) > (kg[best] ?? 0)) best = g;
  return best;
}

/** Ft value of a load (C.1 Ft/kg, jackpots at their fixed worth). */
export function loadValue(load: Load): number {
  const v = VALUE_FT_PER_KG;
  const jackpots = load.jackpots.reduce((s, k) => s + (jackpotOf(k)?.ft ?? 0), 0);
  return (load.dustG / 1000) * v.dust + (load.seedG / 1000) * v.seed + (load.cans + load.crushed) * 0.05 * v.can
    + (load.ironG / 1000) * v.iron + (load.copperG / 1000) * v.copper + jackpots;
}

/** Lot group of a cargo entering a splitter: 2 → left (1), 1 → right (2), 0 and bags → straight (0). */
const routeOf = (c: Cargo): number => (c.kind === 1 ? 0 : c.sub === GROUP_COPPER ? 1 : c.sub === GROUP_FERROUS ? 2 : 0);

/** Lowest free id 1..65535 of a map, or null. */
function lowestFree(used: { has(id: number): boolean }): number | null {
  for (let id = 1; id <= MAX_ID; id++) if (!used.has(id)) return id;
  return null;
}

type Pending = { row: ['b', BagRow] | ['c', CargoRow] | ['del']; arc?: ArcRow; burst?: BurstRow };

export class LogisticsWorld {
  readonly structures = new Map<number, Structure>();
  readonly bags = new Map<number, Bag>();
  readonly cargo = new Map<number, Cargo>();
  readonly nodes = new Map<number, LogNode>();
  readonly #deps: LogisticsDeps;
  readonly #inHash = new Map<string, Array<{ node: number; entry: number; port: WorldPort }>>();
  #colliders: ColliderIndex;
  #collidersDirty = false;
  #crane: { hook: { x: number; z: number }; job: CraneJob | null } = { hook: { x: CRANE.targets[0]?.x ?? 0, z: CRANE.targets[0]?.z ?? 0 }, job: null };
  #tick = 0;
  #timeMs = 0;
  readonly #flowKg = new Float64Array(60);
  readonly #flowFt = new Float64Array(60);
  #flowSec = 0;
  // Pending update parts (FIFO, coalesced).
  readonly #pending = new Map<number, Pending>();
  readonly #structChanged = new Set<number>();
  #sdel: number[] = [];
  #craneChanged = false;
  readonly #fillSent = new Map<number, number>();
  #structuresDirty = false;
  #changed = true;

  constructor(deps: LogisticsDeps) {
    this.#deps = deps;
    const lm = deps.layout.landmarks.hopper;
    const gx = (x: number, z: number): number => this.ground(x, z);
    const out = { x: lm.x, z: lm.z - lm.d / 2, hx: 0, hz: -1, y: gx(lm.x, lm.z - lm.d / 2) + deckOffset(0) };
    const rect: Rect = { minX: lm.x - lm.w / 2, maxX: lm.x + lm.w / 2, minZ: lm.z - lm.d / 2, maxZ: lm.z + lm.d / 2 };
    this.nodes.set(LANDMARK_HOPPER, {
      id: LANDMARK_HOPPER, type: TYPE.hopper, st: null, len: 0, queue: [], ins: [], outs: [out], targets: [{ kind: 'open' }], buffer: emptyLoad(),
      timer: 0, idleMs: 0, rr: 0, lastIn: 1, intake: expand(rect, LANDMARK_INTAKE_PAD_M), intakeTop: LANDMARK_INTAKE_TOP_M
    });
    this.#colliders = this.#buildColliders();
  }

  ground(x: number, z: number): number {
    return groundHeight(this.#deps.layout.heightfield, x, z);
  }

  // ---- colliders ----

  /** The combined index (layout + crane legs + structures) that movement and throws sweep against. */
  get colliders(): ColliderIndex {
    return this.#colliders;
  }

  /** Rebuilds the combined index when a structure collider changed; true when rebuilt (at most once per tick by the caller). */
  rebuildColliders(): boolean {
    if (!this.#collidersDirty) return false;
    this.#colliders = this.#buildColliders();
    this.#collidersDirty = false;
    return true;
  }

  structureColliders(): Collider[] {
    const out: Collider[] = [];
    for (const st of this.structures.values()) {
      const c = colliderOf(st, this.ground(st.x, st.z));
      if (c) out.push(c);
    }
    return out;
  }

  #buildColliders(): ColliderIndex {
    return new ColliderIndex([...this.#deps.layout.colliders, ...CRANE_LEGS, ...this.structureColliders()]);
  }

  // ---- structures ----

  /** Places a checked structure (the caller ran {@link checkPlacement}); returns it. Null when the id space is full. */
  add(spec: PlaceSpec, base: number, id: number | null = null, flags = 0): Structure | null {
    const sid = id ?? lowestFree(this.structures);
    if (sid === null || sid === LANDMARK_HOPPER) return null;
    const st: Structure = { id: sid, type: spec.type, x: spec.x, z: spec.z, rot: spec.rot, lvl: spec.lvl, base, flags, rect: footprint(spec.type, spec.x, spec.z, spec.rot) };
    this.structures.set(sid, st);
    const type = structSpec(st.type);
    if (type.ins.length > 0 || type.outs.length > 0) {
      const node: LogNode = {
        id: sid, type: st.type, st, len: type.len, queue: [], ins: type.ins.map((p) => worldPort(st, p)), outs: type.outs.map((p) => worldPort(st, p)),
        targets: [], buffer: st.type === TYPE.hopper || st.type === TYPE.packager ? emptyLoad() : null, timer: 0, idleMs: 0, rr: 0, lastIn: 1,
        intake: st.type === TYPE.hopper ? st.rect : null, intakeTop: HOPPER_INTAKE_TOP_M
      };
      this.nodes.set(sid, node);
      node.ins.forEach((port, entry) => {
        const key = portKey(port.x, port.z);
        const list = this.#inHash.get(key) ?? [];
        list.push({ node: sid, entry, port });
        this.#inHash.set(key, list);
      });
      this.#relinkAround(node);
    }
    this.#structuresDirty = true;
    this.#collidersDirty = true;
    this.#changed = true;
    return st;
  }

  /** Removes a structure (D.3 rule 8 effects: cargo falls/spills, buffers spill, bags on it settle, neighbours relink). */
  remove(id: number): void {
    const st = this.structures.get(id);
    if (!st) return;
    this.structures.delete(id);
    const node = this.nodes.get(id);
    if (node) {
      this.nodes.delete(id);
      for (const port of node.ins) {
        const key = portKey(port.x, port.z);
        const list = (this.#inHash.get(key) ?? []).filter((e) => e.node !== id);
        if (list.length > 0) this.#inHash.set(key, list);
        else this.#inHash.delete(key);
      }
      for (const c of node.queue) {
        this.cargo.delete(c.id);
        const at = node.type === TYPE.hopper ? { x: st.x, y: this.ground(st.x, st.z), z: st.z } : pathPoint(st, c.s, c.way);
        if (c.bag) this.#land(c.bag, at.x, at.z, at.y, at.y, 0, 0, false);
        else this.#spillLoad(c.id, c.load, at.x, at.z);
      }
      node.queue = [];
      if (node.buffer && !isEmptyLoad(node.buffer)) spill(this.#deps.debris, node.buffer, st.x, st.z, 0);
      this.#fillSent.delete(id);
      for (const other of this.nodes.values()) {
        if (other.targets.some((t) => t.kind !== 'open' && t.node === id)) this.#relink(other);
      }
    }
    this.#sdel.push(id);
    this.#structChanged.delete(id);
    this.#settleArea(st.rect);
    this.#structuresDirty = true;
    this.#collidersDirty = true;
    this.#changed = true;
  }

  structRow(st: Structure): StructRow {
    return [st.id, st.type, cm(st.x), cm(st.z), cm(st.base), st.rot, st.lvl, st.flags];
  }

  /** True when any non-foundation structure overlaps the foundation (rule 8 `supportsStructures`). */
  supportsStructures(st: Structure): boolean {
    if (!isFoundation(st.type)) return false;
    const inner = expand(st.rect, -0.01);
    return [...this.structures.values()].some((o) => o.id !== st.id && !isFoundation(o.type)
      && o.rect.minX < inner.maxX && inner.minX < o.rect.maxX && o.rect.minZ < inner.maxZ && inner.minZ < o.rect.maxZ);
  }

  /** Metres of fence whose centre lies in each hex (41). */
  fenceFactor(hex: number): number {
    let metres = 0;
    for (const st of this.structures.values()) if (st.type === TYPE.fence && hexAt(st.x, st.z)?.id === hex) metres += 2;
    return Math.max(0, 1 - metres / FENCE_STOP_M);
  }

  /** Re-arms {@link takeStructuresDirty} after a failed save. */
  markStructuresDirty(): void {
    this.#structuresDirty = true;
  }

  /** True once since the last call when the structure set changed (persistence). */
  takeStructuresDirty(): boolean {
    const dirty = this.#structuresDirty;
    this.#structuresDirty = false;
    return dirty;
  }

  #relinkAround(node: LogNode): void {
    this.#relink(node);
    const inKeys = new Set(node.ins.map((p) => portKey(p.x, p.z)));
    for (const other of this.nodes.values()) {
      if (other === node) continue;
      const feeds = other.outs.some((p) => inKeys.has(portKey(p.x, p.z)));
      const inZone = node.intake !== null && other.outs.some((p) => node.intake !== null && inRect(node.intake, p.x, p.z));
      if (feeds || inZone) this.#relink(other);
    }
  }

  #relink(node: LogNode): void {
    node.targets = node.outs.map((p) => this.#targetOf(node, p));
  }

  #targetOf(node: LogNode, p: WorldPort): Target {
    for (const cand of this.#inHash.get(portKey(p.x, p.z)) ?? []) {
      if (cand.node === node.id) continue;
      if (Math.abs(cand.port.y - p.y) <= 0.05 && Math.abs(cand.port.hx - p.hx) < EPS && Math.abs(cand.port.hz - p.hz) < EPS) {
        return { kind: 'node', node: cand.node, entry: cand.entry };
      }
    }
    for (const hop of this.nodes.values()) {
      if (hop.id !== node.id && hop.intake && inRect(hop.intake, p.x, p.z)) return { kind: 'hopper', node: hop.id };
    }
    return { kind: 'open' };
  }

  isJammed(id: number): boolean {
    return ((this.structures.get(id)?.flags ?? 0) & 1) !== 0;
  }

  #setFlag(st: Structure, bit: number, on: boolean): void {
    const flags = on ? st.flags | bit : st.flags & ~bit;
    if (flags === st.flags) return;
    st.flags = flags;
    this.#structChanged.add(st.id);
    if (bit === 1) this.#structuresDirty = true;
  }

  // ---- the simulation ----

  /** One tick of `dtMs` (already clamped by the room): belts, hoppers, packagers, jams, crane. */
  tick(dtMs: number, now: number): void {
    this.#tick++;
    this.#timeMs += dtMs;
    this.#advanceFlow();
    const ids = [...this.nodes.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (node.type === TYPE.hopper) this.#tickHopper(node, dtMs);
      else this.#moveQueue(node, dtMs);
      if (node.type === TYPE.packager) this.#tickPackager(node, dtMs);
    }
    this.#detectJams();
    const job = this.#crane.job;
    if (job && now >= job.t0 + job.durMs) this.#finishCrane(job);
    if (ids.length > 1 || this.cargo.size > 0) this.#changed = true;
  }

  #moveQueue(node: LogNode, dtMs: number): void {
    const jammed = node.st !== null && (node.st.flags & 1) !== 0;
    const step = BELT_MPS * (dtMs / 1000);
    let aheadS = Infinity;
    for (let i = 0; i < node.queue.length;) {
      const c = node.queue[i];
      if (!c) break;
      if (c.tick === this.#tick) {
        aheadS = c.s;
        i++;
        continue;
      }
      let moved = false;
      if (!jammed) {
        const limit = Math.min(node.len, aheadS - CARGO_PITCH_M);
        const next = Math.min(c.s + step, limit);
        if (next > c.s + EPS) {
          c.s = next;
          moved = true;
        }
        if (c.s >= node.len - EPS && aheadS === Infinity && this.#exit(node, c)) {
          node.queue.splice(i, 1);
          continue;
        }
      }
      c.tick = this.#tick;
      this.#setMotion(c, moved, dtMs);
      aheadS = c.s;
      i++;
    }
  }

  #setMotion(c: Cargo, moved: boolean, dtMs: number): void {
    const mv: 0 | 1 = moved ? 1 : 0;
    c.waitMs = moved ? 0 : c.waitMs + dtMs;
    if (mv !== c.mv) {
      c.mv = mv;
      this.#cargoRow(c);
    }
  }

  /** The head at the end of `node` leaves through the out port of its route; false when it must wait. */
  #exit(node: LogNode, c: Cargo): boolean {
    const outIndex = node.type === TYPE.splitter ? c.route : 0;
    const target = node.targets[outIndex] ?? { kind: 'open' };
    const port = node.outs[outIndex];
    if (!port) return false;
    if (target.kind === 'open') {
      this.#outflow(c);
      this.cargo.delete(c.id);
      const x = port.x + port.hx * 0.4;
      const z = port.z + port.hz * 0.4;
      if (c.bag) {
        c.bag.st = 0;
        this.#land(c.bag, x, z, port.y, port.y, port.hx, port.hz, true);
      } else {
        this.#spillLoad(c.id, c.load, x, z);
      }
      return true;
    }
    if (target.kind === 'hopper') {
      const hop = this.nodes.get(target.node);
      if (!hop || !this.#hopperAccepts(hop, c)) return false;
      this.#outflow(c);
      this.#intoHopper(hop, c);
      return true;
    }
    const into = this.nodes.get(target.node);
    if (!into || !this.#accepts(into, target.entry, node.id, c)) return false;
    this.#enter(into, target.entry, c);
    return true;
  }

  /** True when `into` takes `c` at `entry` now (free entry, not jammed, merger alternation, packager buffer). */
  #accepts(into: LogNode, entry: number, fromId: number, c: Cargo): boolean {
    if (into.st && (into.st.flags & 1) !== 0) return false;
    if (into.type === TYPE.packager && c.kind === 0) return (into.buffer ? loadKg(into.buffer) : 0) + loadKg(c.load) <= PACKAGER_KG + EPS;
    if (into.queue.some((q) => q.s < CARGO_PITCH_M)) return false;
    if (into.type === TYPE.merger && into.lastIn === entry && this.#mergerWaiting(into, 1 - entry, fromId)) return false;
    return true;
  }

  /** True when the head of the node feeding merger entry `entry` is waiting at its end. */
  #mergerWaiting(merger: LogNode, entry: number, exceptId: number): boolean {
    for (const n of this.nodes.values()) {
      if (n.id === exceptId) continue;
      const feeds = n.targets.some((t, i) => t.kind === 'node' && t.node === merger.id && t.entry === entry
        && (n.type !== TYPE.splitter || n.queue[0]?.route === i));
      if (!feeds) continue;
      const head = n.queue[0];
      if (head && head.s >= n.len - EPS) return true;
    }
    return false;
  }

  #enter(into: LogNode, entry: number, c: Cargo): void {
    if (into.type === TYPE.packager && c.kind === 0 && into.buffer) {
      addLoad(into.buffer, c.load);
      into.idleMs = 0;
      this.cargo.delete(c.id);
      this.#gone(c.id);
      return;
    }
    if (into.type === TYPE.merger) into.lastIn = entry;
    c.node = into.id;
    c.s = 0;
    c.way = into.type === TYPE.merger ? entry : 0;
    c.route = into.type === TYPE.splitter ? routeOf(c) : 0;
    c.tick = this.#tick;
    c.waitMs = 0;
    c.mv = 1;
    into.queue.push(c);
    this.#cargoRow(c);
  }

  #hopperAccepts(hop: LogNode, c: Cargo): boolean {
    if (c.kind === 1) return hop.queue.length < HOPPER_BAG_QUEUE;
    return (hop.buffer ? loadKg(hop.buffer) : 0) + loadKg(c.load) <= HOPPER_KG + EPS;
  }

  #intoHopper(hop: LogNode, c: Cargo): void {
    if (c.kind === 0 || !c.bag) {
      if (hop.buffer) addLoad(hop.buffer, c.load);
      this.cargo.delete(c.id);
      this.#gone(c.id);
      return;
    }
    c.node = hop.id;
    c.s = 0;
    c.route = 0;
    c.way = 0;
    c.mv = 0;
    c.waitMs = 0;
    c.tick = this.#tick;
    c.bag.st = 3;
    hop.queue.push(c);
    this.cargo.set(c.id, c);
    this.#cargoRow(c);
  }

  #tickHopper(hop: LogNode, dtMs: number): void {
    hop.timer = Math.min(HOPPER_EMIT_MS, hop.timer + dtMs);
    if (hop.timer < HOPPER_EMIT_MS) return;
    const target = hop.targets[0];
    // Emits only into a linked node: an unlinked hopper keeps its contents.
    if (!target || target.kind !== 'node') return;
    const into = this.nodes.get(target.node);
    if (!into) return;
    const bagCargo = hop.queue[0];
    if (bagCargo) {
      if (!this.#accepts(into, target.entry, hop.id, bagCargo)) return;
      hop.queue.shift();
      this.#enter(into, target.entry, bagCargo);
      hop.timer = 0;
      return;
    }
    if (!hop.buffer || isEmptyLoad(hop.buffer) || this.#lotCount() >= CAPS.lots) return;
    const id = lowestFree(this.#entityIds());
    if (id === null) return;
    for (let k = 0; k < 3; k++) {
      const group = (hop.rr + k) % 3;
      if (groupKg(hop.buffer, group, jackpotKg) <= EPS) continue;
      const part = takeGroup(hop.buffer, group);
      const load = cut(part, LOT_KG, Infinity);
      const lot: Cargo = { id, kind: 0, sub: group, tint: group + 1, node: hop.id, s: 0, route: 0, way: 0, mv: 0, waitMs: 0, load, bag: null, tick: 0 };
      if (!this.#accepts(into, target.entry, hop.id, lot)) {
        addLoad(part, load);
        addLoad(hop.buffer, part);
        return;
      }
      addLoad(hop.buffer, part);
      this.cargo.set(id, lot);
      this.#enter(into, target.entry, lot);
      hop.rr = (group + 1) % 3;
      hop.timer = 0;
      return;
    }
  }

  #tickPackager(pk: LogNode, dtMs: number): void {
    const st = pk.st;
    if (!st || !pk.buffer || (st.flags & 1) !== 0) return;
    pk.timer = Math.min(PACKAGER_CYCLE_MS, pk.timer + dtMs);
    const kg = loadKg(pk.buffer);
    pk.idleMs = kg > EPS ? pk.idleMs + dtMs : 0;
    const full = kg >= PACKAGER_BAG_KG - EPS && pk.timer >= PACKAGER_CYCLE_MS;
    const flush = kg > EPS && kg < PACKAGER_BAG_KG - EPS && pk.idleMs >= PACKAGER_FLUSH_MS;
    if ((full || flush) && this.bags.size < CAPS.bags && !pk.queue.some((q) => Math.abs(q.s - 1) < CARGO_PITCH_M)) {
      const id = lowestFree(this.#entityIds());
      if (id !== null) {
        const tint = dominantGroup(pk.buffer) + 1;
        const load = cut(pk.buffer, PACKAGER_BAG_KG, bagTier(1).l);
        const bag: Bag = { id, tier: 1, tint, st: 3, x: 0, y: 0, z: 0, rot8: 0, load, on: 0, carrier: 0 };
        this.bags.set(id, bag);
        const c: Cargo = { id, kind: 1, sub: 1, tint, node: pk.id, s: 1, route: 0, way: 0, mv: 1, waitMs: 0, load: emptyLoad(), bag, tick: this.#tick };
        this.cargo.set(id, c);
        pk.queue.push(c);
        pk.queue.sort((a, b) => b.s - a.s);
        this.#cargoRow(c);
        pk.timer = 0;
        pk.idleMs = 0;
      }
    }
    this.#setFlag(st, 2, !isEmptyLoad(pk.buffer));
  }

  #detectJams(): void {
    for (const node of this.nodes.values()) {
      const st = node.st;
      if (!st || !isJunction(st.type) || (st.flags & 1) !== 0) continue;
      const inside = node.queue.some((c) => c.waitMs >= JAM_MS);
      const feeding = !inside && [...this.nodes.values()].some((n) => n.targets.some((t) => t.kind === 'node' && t.node === node.id)
        && (n.queue[0]?.waitMs ?? 0) >= JAM_MS && (n.queue[0]?.s ?? 0) >= n.len - EPS);
      if (inside || feeding) this.#setFlag(st, 1, true);
    }
  }

  /** `clearJam`: ejects the junction's cargo and the heads waiting ≥ 10 s at its inputs 1 m to its right. */
  clearJam(id: number): void {
    const node = this.nodes.get(id);
    const st = node?.st;
    if (!node || !st) return;
    const [rx, rz] = rotate(st.rot, 1, 0);
    const half = Math.max(st.rect.maxX - st.rect.minX, st.rect.maxZ - st.rect.minZ) / 2;
    const x = st.x + rx * (half + 1);
    const z = st.z + rz * (half + 1);
    const eject = (c: Cargo, from: { y: number }): void => {
      this.cargo.delete(c.id);
      if (c.bag) {
        c.bag.st = 0;
        this.#land(c.bag, x, z, from.y, from.y, rx, rz, false);
      } else {
        this.#spillLoad(c.id, c.load, x, z);
      }
    };
    for (const c of node.queue) eject(c, pathPoint(st, c.s, c.way));
    node.queue = [];
    for (const n of this.nodes.values()) {
      if (!n.targets.some((t) => t.kind === 'node' && t.node === id)) continue;
      const head = n.queue[0];
      if (head && head.waitMs >= JAM_MS) {
        n.queue.shift();
        eject(head, n.st ? pathPoint(n.st, head.s, head.way) : { y: n.outs[0]?.y ?? 0 });
      }
    }
    node.timer = 0;
    node.idleMs = 0;
    this.#setFlag(st, 1, false);
  }

  /** Jammed junction count. */
  get jams(): number {
    let n = 0;
    for (const st of this.structures.values()) if ((st.flags & 1) !== 0) n++;
    return n;
  }

  // ---- bags ----

  #entityIds(): { has(id: number): boolean } {
    return { has: (id) => this.bags.has(id) || this.cargo.has(id) };
  }

  #lotCount(): number {
    let n = 0;
    for (const c of this.cargo.values()) if (c.kind === 0) n++;
    return n;
  }

  /** Creates a ground bag (tie). Null at the room cap or when the id space is full. */
  newBag(tier: number, load: Load, x: number, z: number, rotY: number, dirX: number, dirZ: number): Bag | null {
    if (this.bags.size >= CAPS.bags) return null;
    const id = lowestFree(this.#entityIds());
    if (id === null) return null;
    const bag: Bag = { id, tier, tint: 0, st: 0, x, y: 0, z, rot8: rot8Of(rotY), load, on: 0, carrier: 0 };
    this.bags.set(id, bag);
    this.#land(bag, x, z, Infinity, -Infinity, dirX, dirZ, false);
    return bag;
  }

  get bagCount(): number {
    return this.bags.size;
  }

  /** A ground Big-Bag within 2.5 m of (x, z), nearest first. */
  bigBagNear(x: number, z: number): Bag | null {
    let best: Bag | null = null;
    let bestD = BIG_BAG_FILL_M;
    for (const bag of this.bags.values()) {
      if (bag.tier !== BIG_BAG || bag.st !== 0) continue;
      const d = Math.hypot(bag.x - x, bag.z - z);
      if (d <= bestD) {
        best = bag;
        bestD = d;
      }
    }
    return best;
  }

  /** A changed bag's row goes out (b or c by its state). */
  touchBag(bag: Bag): void {
    this.#bagRow(bag);
    this.#changed = true;
  }

  /** World position of a bag (a cargo bag on its path; a hopper-queued one at the hopper). */
  bagPosition(bag: Bag): { x: number; y: number; z: number } | null {
    if (bag.st !== 3) return { x: bag.x, y: bag.y, z: bag.z };
    const c = this.cargo.get(bag.id);
    const node = c ? this.nodes.get(c.node) : undefined;
    if (!c || !node?.st || node.type === TYPE.hopper) return null;
    return pathPoint(node.st, c.s, c.way);
  }

  /** True when no ground bag rests on it. */
  onTop(bag: Bag): boolean {
    for (const other of this.bags.values()) if (other.st === 0 && other.on === bag.id) return false;
    return true;
  }

  /** Takes a ground or belt bag into a player's hands (checks are the caller's). */
  pickUp(bag: Bag, carrier: number): void {
    if (bag.st === 3) {
      const c = this.cargo.get(bag.id);
      const node = c ? this.nodes.get(c.node) : undefined;
      if (node) node.queue = node.queue.filter((q) => q.id !== bag.id);
      this.cargo.delete(bag.id);
    } else {
      this.#unstack(bag);
    }
    bag.st = 1;
    bag.carrier = carrier;
    bag.on = 0;
    this.#bagRow(bag);
    this.#changed = true;
  }

  /**
   * Throws (or, with power < 1, drops) the carried bag from `pose` (62): the arc is marched in 0.05 s
   * steps; it ends in a hopper, on a belt, or on the ground (stacking, rupture).
   */
  throwBag(bag: Bag, pose: { x: number; z: number }, power: number, pitch: number, rotY: number): ThrowResult {
    const dir = dirOf(rotY);
    const drop = power < DROP_POWER;
    const sx = pose.x + dir.x * (drop ? 0.5 : 0.4);
    const sz = pose.z + dir.z * (drop ? 0.5 : 0.4);
    const sy = drop ? this.support(sx, sz, bag).y + 1 : this.ground(pose.x, pose.z) + 1.4;
    const speed = drop ? 0 : Math.min(power, 12);
    const vx = speed * Math.cos(pitch) * dir.x;
    const vz = speed * Math.cos(pitch) * dir.z;
    const vy = speed * Math.sin(pitch);
    bag.st = 0;
    bag.carrier = 0;
    bag.rot8 = rot8Of(rotY);
    let prev = { x: sx, y: sy, z: sz };
    let apex = sy;
    let fallFrom: { x: number; y: number; z: number } | null = null;
    let landAt: { x: number; y: number; z: number } | null = null;
    let steps = 0;
    for (let i = 1; i <= THROW_MAX_STEPS; i++) {
      steps = i;
      const t = i * THROW_STEP_S;
      const p = { x: sx + vx * t, y: sy + vy * t - (GRAVITY * t * t) / 2, z: sz + vz * t };
      apex = Math.max(apex, p.y);
      const hex = hexAt(p.x, p.z);
      if (!hex || !this.#deps.unlocked.has(hex.district)) {
        fallFrom = prev;
        break;
      }
      const hop = this.#hopperZone(p.x, p.y, p.z);
      if (hop && hop.queue.length < HOPPER_BAG_QUEUE) {
        const durMs = Math.round(t * 1000);
        this.#queueBag(hop, bag);
        this.#arc(bag.id, sx, sy, sz, p.x, p.y, p.z, apex, durMs);
        return { id: bag.id, to: [cm(p.x), cm(p.y), cm(p.z)], into: 'hopper', burst: false };
      }
      if (this.#insideCollider(p.x, p.y, p.z)) {
        fallFrom = prev;
        break;
      }
      if (p.y <= this.support(p.x, p.z, bag).y) {
        landAt = p;
        break;
      }
      prev = p;
    }
    const at = landAt ?? fallFrom ?? prev;
    const burst = this.#land(bag, at.x, at.z, apex, apex, dir.x, dir.z, true, false);
    const rest = this.bagPosition(bag) ?? { x: at.x, y: this.ground(at.x, at.z), z: at.z };
    const fallMs = landAt ? 0 : Math.sqrt((2 * Math.max(0, at.y - rest.y)) / GRAVITY) * 1000;
    const into = this.cargo.has(bag.id) ? 'belt' : 'ground';
    this.#arc(bag.id, sx, sy, sz, rest.x, rest.y, rest.z, apex, Math.round(steps * THROW_STEP_S * 1000 + fallMs));
    return { id: bag.id, to: [cm(rest.x), cm(rest.y), cm(rest.z)], into, burst };
  }

  /**
   * Support under (x, z) for `bag`: terrain, foundation tops, belt decks, and the tops of ground bags it
   * overlaps. A re-settle passes the bag's old y as `maxY`, so the bags resting above it are not counted.
   */
  support(x: number, z: number, bag: Bag | null, maxY = Infinity): { y: number; on: Bag | null } {
    let y = this.ground(x, z);
    let on: Bag | null = null;
    for (const st of this.structures.values()) {
      if (!inRect(st.rect, x, z)) continue;
      if (isFoundation(st.type)) y = Math.max(y, st.base);
      else if (isBeltLike(st.type)) y = Math.max(y, deckAt(st, x, z));
    }
    const r = bag ? bagTier(bag.tier).r : 0.3;
    for (const other of this.bags.values()) {
      if (other === bag || other.st !== 0 || other.y >= maxY - EPS) continue;
      if (Math.hypot(other.x - x, other.z - z) >= (r + bagTier(other.tier).r) / 2) continue;
      const top = other.y + bagTier(other.tier).h;
      if (top > y) {
        y = top;
        on = other;
      }
    }
    return { y, on };
  }

  #depth(bag: Bag): number {
    let depth = 1;
    for (let b = this.bags.get(bag.on); b && depth <= STACK_MAX + 1; b = this.bags.get(b.on)) depth++;
    return depth;
  }

  #hopperZone(x: number, y: number, z: number): LogNode | null {
    for (const node of this.nodes.values()) {
      if (!node.intake || !inRect(node.intake, x, z)) continue;
      if (y <= this.ground(x, z) + node.intakeTop) return node;
    }
    return null;
  }

  /** Hopper intake zone containing (x, z) at player height (dump). */
  hopperAt(x: number, z: number): number | null {
    for (const node of this.nodes.values()) if (node.intake && inRect(node.intake, x, z)) return node.id;
    return null;
  }

  #insideCollider(x: number, y: number, z: number): boolean {
    return this.#colliders.near(x, z, 0).some((c) => penetration(c, x, z, 0) !== null && y < this.ground(c.x, c.z) + c.h);
  }

  #queueBag(hop: LogNode, bag: Bag): void {
    const c: Cargo = { id: bag.id, kind: 1, sub: bag.tier, tint: bag.tint, node: hop.id, s: 0, route: 0, way: 0, mv: 0, waitMs: 0, load: emptyLoad(), bag, tick: this.#tick };
    this.#intoHopper(hop, c);
  }

  /**
   * Rests `bag` at (x, z): as cargo on a belt deck when `allowCargo` and there is room (else 0.6 m to
   * the belt's right), otherwise on the support, sliding 0.6 m along (dirX, dirZ) off a full stack.
   * `fromY` is the fall start for the rupture rule (`apexY` for throws). Returns true when it burst.
   */
  #land(bag: Bag, x: number, z: number, fromY: number, apexY: number, dirX: number, dirZ: number, allowCargo: boolean, arc = true): boolean {
    let px = x;
    let pz = z;
    let cargoOk = allowCargo && bag.tier !== BIG_BAG;
    for (let attempt = 0; attempt < LANDING_TRIES; attempt++) {
      const belt = cargoOk ? this.#beltAt(px, pz) : null;
      if (belt?.st) {
        const len = belt.len;
        const s = Math.min(len - 0.3, Math.max(0.3, projectS(belt.st, px, pz)));
        const free = (belt.st.flags & 1) === 0 && belt.queue.every((q) => Math.abs(q.s - s) >= CARGO_PITCH_M);
        if (free) {
          const c: Cargo = { id: bag.id, kind: 1, sub: bag.tier, tint: bag.tint, node: belt.id, s, route: 0, way: 0, mv: 0, waitMs: 0, load: emptyLoad(), bag, tick: this.#tick };
          if (belt.type === TYPE.splitter) c.route = routeOf(c);
          bag.st = 3;
          bag.on = 0;
          belt.queue.push(c);
          belt.queue.sort((a, b) => b.s - a.s);
          this.cargo.set(bag.id, c);
          this.#cargoRow(c);
          return false;
        }
        const [rx, rz] = rotate(belt.st.rot, 1, 0);
        px += rx * CARGO_PITCH_M;
        pz += rz * CARGO_PITCH_M;
        cargoOk = false;
        continue;
      }
      const sup = this.support(px, pz, bag);
      if (sup.on && this.#depth(sup.on) >= STACK_MAX) {
        const len = Math.hypot(dirX, dirZ) || 1;
        const tx = px + (dirX / len) * STACK_SLIDE_M;
        const tz = pz + (dirZ / len) * STACK_SLIDE_M;
        const open = this.#deps.debris.openToward(tx, tz, px, pz, this.#deps.unlocked);
        px = open?.x ?? tx;
        pz = open?.z ?? tz;
        continue;
      }
      return this.#rest(bag, px, sup.y, pz, sup.on, fromY, apexY, arc);
    }
    const sup = this.support(px, pz, bag);
    return this.#rest(bag, px, sup.y, pz, sup.on, fromY, apexY, arc);
  }

  #rest(bag: Bag, x: number, y: number, z: number, on: Bag | null, fromY: number, apexY: number, arc: boolean): boolean {
    const oldY = Number.isFinite(fromY) ? fromY : y;
    bag.st = 0;
    bag.x = x;
    bag.y = y;
    bag.z = z;
    bag.on = on?.id ?? 0;
    const fall = Math.max(oldY, Number.isFinite(apexY) ? apexY : oldY) - y;
    if (arc && fall > EPS && Number.isFinite(fromY)) this.#arc(bag.id, x, oldY, z, x, y, z, Math.max(oldY, y), Math.round(Math.sqrt((2 * fall) / GRAVITY) * 1000));
    if (this.#ruptures(bag, fall)) {
      this.#burst(bag);
      return true;
    }
    this.#bagRow(bag);
    this.#changed = true;
    return false;
  }

  /** Rupture (64): tier 0, sharp mass > 15 kg, fall > 1.5 m, 40 %. */
  #ruptures(bag: Bag, fall: number): boolean {
    return bagTier(bag.tier).rupture && sharpKg(bag.load) > RUPTURE_SHARP_KG && fall > RUPTURE_FALL_M && this.#deps.chance(RUPTURE_CHANCE);
  }

  #burst(bag: Bag): void {
    spill(this.#deps.debris, bag.load, bag.x, bag.z, (bag.rot8 / 256) * Math.PI * 2);
    this.bags.delete(bag.id);
    this.cargo.delete(bag.id);
    const pending = this.#pend(bag.id);
    pending.row = ['del'];
    pending.burst = [bag.id, cm(bag.x), cm(bag.z)];
    this.#settleOn(bag.id);
    this.#changed = true;
  }

  /** A ground bag leaves its spot: the bags resting on it settle without it. */
  #unstack(bag: Bag): void {
    const id = bag.id;
    bag.on = 0;
    this.#settleOn(id, bag);
  }

  /** Bags that rested on `id` settle (rupture rule), recursively. */
  #settleOn(id: number, removed: Bag | null = null): void {
    const above = [...this.bags.values()].filter((b) => b.st === 0 && b.on === id).sort((a, b) => a.y - b.y);
    for (const b of above) {
      const oldY = b.y;
      if (removed) removed.st = 2;
      const sup = this.support(b.x, b.z, b, oldY);
      if (removed) removed.st = 0;
      if (sup.y >= oldY - EPS && sup.on?.id === b.on) continue;
      const myId = b.id;
      this.#rest(b, b.x, sup.y, b.z, sup.on, oldY, oldY, true);
      if (this.bags.has(myId)) this.#settleOn(myId, removed);
    }
  }

  /** Ground bags inside `rect` re-settle (a deleted structure under them), lowest first. */
  #settleArea(rect: Rect): void {
    const inside = [...this.bags.values()].filter((b) => b.st === 0 && inRect(rect, b.x, b.z)).sort((a, b) => a.y - b.y);
    for (const b of inside) {
      if (!this.bags.has(b.id)) continue;
      const oldY = b.y;
      const sup = this.support(b.x, b.z, b, oldY);
      if (Math.abs(sup.y - oldY) < EPS) continue;
      this.#rest(b, b.x, sup.y, b.z, sup.on, oldY, oldY, true);
      if (this.bags.has(b.id)) this.#settleOn(b.id);
    }
  }

  #beltAt(x: number, z: number): LogNode | null {
    for (const st of this.structures.values()) {
      if (!isBeltLike(st.type) || !inRect(st.rect, x, z)) continue;
      return this.nodes.get(st.id) ?? null;
    }
    return null;
  }

  /** Drops a carried bag at a pose (the carrier left for good). */
  dropCarried(bag: Bag, pose: { x: number; z: number; rotY: number }): void {
    this.throwBag(bag, pose, 0, 0, pose.rotY);
  }

  /** Moves `load` into a hopper buffer up to 2 000 kg; returns kg moved. */
  fillHopper(nodeId: number, load: Load): number {
    const hop = this.nodes.get(nodeId);
    if (!hop?.buffer) return 0;
    const moved = moveLoad(load, hop.buffer, HOPPER_KG - loadKg(hop.buffer), Infinity);
    if (moved > EPS) this.#changed = true;
    return moved;
  }

  #spillLoad(id: number, load: Load, x: number, z: number): void {
    if (!isEmptyLoad(load)) spill(this.#deps.debris, load, x, z, 0);
    this.#gone(id);
  }

  // ---- crane ----

  get craneJob(): CraneJob | null {
    return this.#crane.job;
  }

  get hook(): { x: number; z: number } {
    return this.#crane.hook;
  }

  /** Starts a crane job (checks are the caller's); returns its duration. */
  startCrane(bag: Bag, target: number, now: number): number {
    const to = CRANE.targets[target] ?? CRANE.targets[0] ?? { x: 0, z: 0 };
    const hook = this.#crane.hook;
    const dist = Math.hypot(bag.x - hook.x, bag.z - hook.z) + Math.hypot(to.x - bag.x, to.z - bag.z);
    const durMs = Math.round((dist / CRANE.hookMps) * 1000 + 2 * CRANE.liftMs);
    this.#unstack(bag);
    const job: CraneJob = { bag: bag.id, fx: cm(bag.x), fz: cm(bag.z), tx: cm(to.x), tz: cm(to.z), t0: now, durMs };
    bag.st = 2;
    bag.x = to.x;
    bag.z = to.z;
    bag.y = this.support(to.x, to.z, bag).y;
    this.#crane.job = job;
    this.#craneChanged = true;
    this.#bagRow(bag);
    this.#changed = true;
    return durMs;
  }

  #finishCrane(job: CraneJob): void {
    this.#crane.job = null;
    this.#crane.hook = { x: job.tx / 100, z: job.tz / 100 };
    this.#craneChanged = true;
    const bag = this.bags.get(job.bag);
    if (bag?.st === 2) {
      bag.st = 0;
      this.#land(bag, job.tx / 100, job.tz / 100, Infinity, -Infinity, 0, 0, false);
    }
    this.#changed = true;
  }

  // ---- telemetry ----

  #advanceFlow(): void {
    const sec = Math.floor(this.#timeMs / 1000);
    for (let s = this.#flowSec + 1; s <= sec && s <= this.#flowSec + 60; s++) {
      this.#flowKg[s % 60] = 0;
      this.#flowFt[s % 60] = 0;
    }
    this.#flowSec = Math.max(this.#flowSec, sec);
  }

  #outflow(c: Cargo): void {
    const load = c.bag ? c.bag.load : c.load;
    const slot = this.#flowSec % 60;
    this.#flowKg[slot] = (this.#flowKg[slot] ?? 0) + loadKg(load);
    this.#flowFt[slot] = (this.#flowFt[slot] ?? 0) + loadValue(load);
  }

  /** Belt path, m (types 2–10). */
  beltM(): number {
    let m = 0;
    for (const st of this.structures.values()) if (isBeltLike(st.type)) m += structSpec(st.type).len;
    return m;
  }

  telemetry(): LogisticsTelemetry {
    const beltM = this.beltM();
    let onBelts = 0;
    for (const node of this.nodes.values()) if (isBeltLike(node.type)) onBelts += node.queue.length;
    const kg = this.#flowKg.reduce((s, v) => s + v, 0);
    const ft = this.#flowFt.reduce((s, v) => s + v, 0);
    return {
      kgMin: r2(kg),
      loadPct: beltM > 0 ? Math.min(100, Math.max(0, Math.round((100 * onBelts * CARGO_PITCH_M) / beltM))) : 0,
      kW: Math.round(beltM * WATTS_PER_M) / 1000,
      ftHour: Math.round(60 * ft),
      beltM: Math.round(beltM * 1000) / 1000,
      jams: this.jams
    };
  }

  // ---- wire ----

  bagRow(bag: Bag): BagRow {
    const placed = bag.st === 0 || bag.st === 2;
    return [bag.id, bag.tier, bag.tint, bag.st === 3 ? 0 : bag.st, placed ? cm(bag.x) : 0, placed ? cm(bag.y) : 0, placed ? cm(bag.z) : 0, bag.rot8, dg(bag.load)];
  }

  cargoRow(c: Cargo): CargoRow {
    const kg = c.bag ? dg(c.bag.load) : dg(c.load);
    return [c.id, c.kind, c.sub, c.tint, c.node, Math.round(c.s * 1000), c.route, c.mv, kg];
  }

  initPayload(): LogisticsInit {
    const hoppers: FillRow[] = [];
    const packagers: FillRow[] = [];
    for (const node of [...this.nodes.values()].sort((a, b) => a.id - b.id)) {
      if (!node.buffer) continue;
      const row: FillRow = [node.id, dg(node.buffer)];
      if (node.type === TYPE.hopper) hoppers.push(row);
      else packagers.push(row);
      this.#fillSent.set(node.id, row[1]);
    }
    return {
      v: 1,
      beltMps: BELT_MPS,
      structures: [...this.structures.values()].sort((a, b) => a.id - b.id).map((st) => this.structRow(st)),
      bags: [...this.bags.values()].filter((b) => b.st !== 3).sort((a, b) => a.id - b.id).map((b) => this.bagRow(b)),
      cargo: [...this.cargo.values()].sort((a, b) => a.id - b.id).map((c) => this.cargoRow(c)),
      hoppers,
      packagers,
      crane: { hook: [cm(this.#crane.hook.x), cm(this.#crane.hook.z)], job: this.#crane.job }
    };
  }

  #pend(id: number): Pending {
    let p = this.#pending.get(id);
    if (!p) {
      p = { row: ['del'] };
      this.#pending.set(id, p);
    }
    return p;
  }

  #bagRow(bag: Bag): void {
    if (bag.st === 3) {
      const c = this.cargo.get(bag.id);
      if (c) this.#cargoRow(c);
      return;
    }
    this.#pend(bag.id).row = ['b', this.bagRow(bag)];
  }

  #cargoRow(c: Cargo): void {
    this.#pend(c.id).row = ['c', this.cargoRow(c)];
    this.#changed = true;
  }

  #gone(id: number): void {
    this.#pend(id).row = ['del'];
  }

  #arc(id: number, fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, apex: number, durMs: number): void {
    this.#pend(id).arc = [id, cm(fx), cm(fy), cm(fz), cm(tx), cm(ty), cm(tz), cm(apex), Math.max(0, durMs)];
  }

  /** The coalesced update since the last call (≤ 8 kB; the rest carries over FIFO), or null when empty. */
  takeUpdate(now: number, maxBytes = DELTA_MAX_BYTES): LogisticsUpdate | null {
    let budget = maxBytes - DELTA_OVERHEAD;
    const fits = (...values: unknown[]): boolean => {
      const size = values.reduce<number>((sum, v) => sum + (v === undefined ? 0 : JSON.stringify(v).length + 1), 0);
      if (size > budget) return false;
      budget -= size;
      return true;
    };
    const update: LogisticsUpdate = { t: now };
    if (this.#craneChanged && fits(this.#crane.job ?? 0)) {
      update.crane = this.#crane.job;
      this.#craneChanged = false;
    }
    const sdel: number[] = [];
    while (this.#sdel.length > 0) {
      const id = this.#sdel[0];
      if (id === undefined || !fits(id)) break;
      sdel.push(id);
      this.#sdel.shift();
    }
    const s: StructRow[] = [];
    for (const id of [...this.#structChanged]) {
      const st = this.structures.get(id);
      if (st && !fits(this.structRow(st))) break;
      if (st) s.push(this.structRow(st));
      this.#structChanged.delete(id);
    }
    const b: BagRow[] = [];
    const c: CargoRow[] = [];
    const del: number[] = [];
    const arcs: ArcRow[] = [];
    const burst: BurstRow[] = [];
    for (const [id, p] of this.#pending) {
      const row = p.row[0] === 'del' ? id : p.row[1];
      if (!fits(row, p.arc, p.burst)) break;
      if (p.row[0] === 'b') b.push(p.row[1]);
      else if (p.row[0] === 'c') c.push(p.row[1]);
      else del.push(id);
      if (p.arc) arcs.push(p.arc);
      if (p.burst) burst.push(p.burst);
      this.#pending.delete(id);
    }
    const hop: FillRow[] = [];
    const pk: FillRow[] = [];
    for (const node of [...this.nodes.values()].sort((x, y) => x.id - y.id)) {
      if (!node.buffer) continue;
      const kgDg = dg(node.buffer);
      const sent = this.#fillSent.get(node.id) ?? 0;
      if (Math.abs(kgDg - sent) < 100 && !(kgDg === 0 && sent !== 0)) continue;
      const row: FillRow = [node.id, kgDg];
      if (!fits(row)) break;
      (node.type === TYPE.hopper ? hop : pk).push(row);
      this.#fillSent.set(node.id, kgDg);
    }
    if (s.length > 0) update.s = s;
    if (sdel.length > 0) update.sdel = sdel;
    if (b.length > 0) update.b = b;
    if (c.length > 0) update.c = c;
    if (del.length > 0) update.del = del;
    if (arcs.length > 0) update.arcs = arcs;
    if (burst.length > 0) update.burst = burst;
    if (hop.length > 0) update.hop = hop;
    if (pk.length > 0) update.pk = pk;
    return Object.keys(update).length > 1 ? update : null;
  }

  // ---- persistence helpers ----

  /** True once since the last call when anything persisted changed. */
  takeChanged(): boolean {
    const changed = this.#changed;
    this.#changed = false;
    return changed;
  }

  /** Internal state for persistence (read-only use). */
  get craneState(): { hook: { x: number; z: number }; job: CraneJob | null } {
    return this.#crane;
  }

  setHook(x: number, z: number): void {
    this.#crane.hook = { x, z };
  }

  /** Restores a hopper or packager buffer and timers (persistence). */
  restoreBuffer(nodeId: number, load: Load, timer = 0, idleMs = 0): boolean {
    const node = this.nodes.get(nodeId);
    if (!node?.buffer) return false;
    addLoad(node.buffer, load);
    node.timer = timer;
    node.idleMs = idleMs;
    this.#changed = true;
    return true;
  }

  bufferOf(nodeId: number): Load | null {
    return this.nodes.get(nodeId)?.buffer ?? null;
  }

  timersOf(nodeId: number): { timer: number; idleMs: number } {
    const node = this.nodes.get(nodeId);
    return { timer: node?.timer ?? 0, idleMs: node?.idleMs ?? 0 };
  }

  /** Restores a ground bag (y re-derived from the support). Returns false on a duplicate id. */
  restoreGroundBag(bag: Omit<Bag, 'st' | 'y' | 'on' | 'carrier'>): boolean {
    if (this.bags.has(bag.id) || this.cargo.has(bag.id)) return false;
    const full: Bag = { ...bag, st: 0, y: 0, on: 0, carrier: 0 };
    this.bags.set(full.id, full);
    const sup = this.support(full.x, full.z, full);
    full.y = sup.y;
    full.on = sup.on?.id ?? 0;
    return true;
  }

  /**
   * Restores a cargo row; an orphan (missing node, s outside [0, len]) goes to the landmark hopper:
   * a lot into its buffer (over its cap if need be), a bag into its queue. False on a duplicate id.
   */
  restoreCargo(row: { id: number; kind: 0 | 1; sub: number; tint: number; node: number; s: number; route: number; waitMs: number; load: Load }): boolean {
    if (this.bags.has(row.id) || this.cargo.has(row.id)) return false;
    let node = this.nodes.get(row.node);
    const valid = node !== undefined && (node.type === TYPE.hopper ? row.s === 0 && row.kind === 1 : row.s >= 0 && row.s <= node.len + EPS);
    if (!valid || !node) {
      node = this.nodes.get(LANDMARK_HOPPER);
      if (!node?.buffer) return false;
      if (row.kind === 0) {
        addLoad(node.buffer, row.load);
        this.#changed = true;
        return true;
      }
    }
    const bag: Bag | null = row.kind === 1 ? { id: row.id, tier: row.sub, tint: row.tint, st: 3, x: 0, y: 0, z: 0, rot8: 0, load: row.load, on: 0, carrier: 0 } : null;
    const atHopper = node.type === TYPE.hopper;
    const c: Cargo = {
      id: row.id, kind: row.kind, sub: row.sub, tint: row.tint, node: node.id, s: atHopper ? 0 : row.s, route: node.type === TYPE.splitter ? row.route : 0,
      way: 0, mv: 0, waitMs: atHopper ? 0 : row.waitMs, load: bag ? emptyLoad() : row.load, bag, tick: 0
    };
    if (bag) this.bags.set(bag.id, bag);
    this.cargo.set(c.id, c);
    node.queue.push(c);
    node.queue.sort((a, b) => b.s - a.s);
    this.#changed = true;
    return true;
  }

  /** Clears the pending update parts (after a restore, the init payload carries everything). */
  clearPending(): void {
    this.#pending.clear();
    this.#structChanged.clear();
    this.#sdel = [];
    this.#craneChanged = false;
    this.#structuresDirty = false;
    for (const node of this.nodes.values()) if (node.buffer) this.#fillSent.set(node.id, dg(node.buffer));
  }
}

/** Rule 8 reach for delete and the D.4 distance checks, from the footprint centre. */
export const centreDistance = (st: Structure, x: number, z: number): number => Math.hypot(st.x - x, st.z - z);
/** Distance from a pose to a structure's footprint rectangle (`clearJam`). */
export const footprintDistance = (st: Structure, x: number, z: number): number => rectDistance(st.rect, x, z);
