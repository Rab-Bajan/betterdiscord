// The vehicles of a room (plan F.2): enter / drive / exit, bed, brushes, tip, fuel, garage, damage,
// lights and horn, the coalesced `miskolc:vehicle_update`. A vehicle moves like a player: the driver's
// client predicts it and the server runs `validateMove` with the vehicle's top speed and body radius.
import { ValidationError } from '../../../core/errors/ValidationError.ts';
import { INVALID_PAYLOAD_MESSAGE } from '../../../core/validation/PayloadReader.ts';
import type { CityLayout, Collider } from '../city/layoutTypes.ts';
import type { DebrisWorld } from '../debris/DebrisWorld.ts';
import { emptyLoad, isEmptyLoad, loadKg } from '../debris/personal.ts';
import type { Load, PersonalData } from '../debris/personal.ts';
import { angleOf, rectRegion } from '../debris/regions.ts';
import { brushSweep, moveLoad, spill } from '../debris/tools.ts';
import { scaleAt } from '../economy/Economy.ts';
import { SCALE_ANCHOR_M } from '../economy/tables.ts';
import { ColliderIndex, isBlocking, penetration, resolveCircle } from '../geometry.ts';
import { districtAt, hexAt } from '../hexGrid.ts';
import type { LogisticsWorld } from '../logistics/LogisticsWorld.ts';
import { TYPE } from '../logistics/tables.ts';
import { inRect } from '../logistics/shapes.ts';
import { fullBudget, MAX_SPEED, normaliseAngle, pathOpen, validateMove } from '../motion.ts';
import type { MotionBudget, MoveWorld } from '../motion.ts';
import type { VehicleAction } from '../payloads.ts';
import { toCm, toRot16 } from '../quantize.ts';
import { notEnoughTeamFunds, refusal, SWEEPERS_ERRORS, SweepersError } from '../SweepersError.ts';
import type { SweepersPlayer } from '../SweepersPlayer.ts';
import type { Pose } from '../types.ts';
import {
  ALIGN_MAX, BED_BAGS, BED_REACH_M, bedLocal, CURB_COOLDOWN_MS, CURB_MPS, endOffsets, END_TOLERANCE_M, ENTER_REACH_EXTRA_M, EXIT_SIDE_M, fillerLocal,
  GARAGE, HORN_COOLDOWN_MS, IDLE_STOP_MS, JERRYCAN, PUNCT_SPEED, PUNCTURE_CHANCE, REPAIR_FT, spawnSlot, STOPPED_MPS, TIP_MS, toWorld, topMps, VEHICLE_CAP,
  VFLAG, vehicleType
} from './tables.ts';

/** `[id, type, xCm, zCm, rot16, vCmS, fuelDl, flags, bedKgDg, bags, s0, s1, s2]` (F.3). */
export type VehicleRow = [number, number, number, number, number, number, number, number, number, number, number, number, number];
/** `[vehicleId, kind]`: 0 curb hit, 1 curb hit that punctured a tyre. */
export type HitRow = [number, 0 | 1];

/** `miskolc:vehicle_update` (room-wide, coalesced, only when non-empty). */
export interface VehicleUpdate {
  t: number;
  v?: VehicleRow[];
  del?: number[];
  horn?: number[];
  hit?: HitRow[];
}

/** A bag on a bed: as `player.carry` in stats_json. */
export interface BedBag {
  tier: number;
  tint: number;
  load: Load;
}

export interface Vehicle {
  id: number;
  type: number;
  x: number;
  z: number;
  rotY: number;
  /** Server speed, m/s. */
  v: number;
  fuelL: number;
  align: number;
  punct: boolean;
  lights: 0 | 1 | 2;
  beacon: boolean;
  tipUntil: number;
  load: Load;
  bags: BedBag[];
  /** Short player id per seat, 0 when free. */
  seats: number[];
  budget: MotionBudget;
  /** Last accepted `vehicle_drive` seq of the current driver session (−1: none). */
  seq: number;
  lastDriveAt: number;
  /** Weighbridge stillness (E fields): 0 on the weighbridge, −1 off it. */
  scale: number;
  scaleAnchor: { x: number; z: number };
  scaleSince: number;
  scaleDone: boolean;
  curbAt: number;
  hornAt: number;
  corrected: boolean;
}

/** `vehicle_action` acks. */
export type VehicleAck =
  | { ok: true }
  | { ok: true; x: number; z: number }
  | { ok: true; into: 'hopper' | 'ground'; kg: number }
  | { ok: true; bedKg: number }
  | { ok: true; fuelL: number }
  | { ok: true; teamFunds: number };

/** What the vehicles need from their room. */
export interface VehicleDeps {
  debris: DebrisWorld;
  logistics: LogisticsWorld;
  layout: CityLayout;
  /** The room's movement rules (its `sweep` takes the body radius). */
  moveWorld: MoveWorld;
  unlocked: ReadonlySet<number>;
  /** The team purse (the room). */
  purse: { teamFunds: number };
  drizzle(): boolean;
  /** Puncture draw, injectable. */
  chance(p: number): boolean;
  /** Inspector kg credit (86). */
  credit(district: number, kg: number): void;
  player(id: number): SweepersPlayer | undefined;
}

const r2 = (v: number): number => Math.round(v * 100) / 100 + 0;
const refuse = refusal;
const tooFast = (): SweepersError => new SweepersError(SWEEPERS_ERRORS.tooManyRequests, undefined, SweepersError.TOO_FAST_CODE);

/** Bed mass: loose load plus every bed bag, kg. */
export const bedKg = (v: Vehicle): number => loadKg(v.load) + v.bags.reduce((s, b) => s + loadKg(b.load), 0);

/** A fresh vehicle of `type` at its spawn slot. */
export function newVehicle(id: number, type: number, now: number): Vehicle {
  const slot = spawnSlot(type);
  return {
    id, type, x: slot.x, z: slot.z, rotY: normaliseAngle(slot.rotY), v: 0, fuelL: vehicleType(type).tankL, align: 0, punct: false, lights: 0, beacon: false,
    tipUntil: 0, load: emptyLoad(), bags: [], seats: vehicleType(type).seats.map(() => 0), budget: fullBudget(now), seq: -1, lastDriveAt: now,
    scale: -1, scaleAnchor: { x: slot.x, z: slot.z }, scaleSince: now, scaleDone: false, curbAt: -Infinity, hornAt: -Infinity, corrected: false
  };
}

export class VehicleWorld {
  readonly vehicles = new Map<number, Vehicle>();
  readonly #deps: VehicleDeps;
  /** Step-over layout boxes (curbs, 103). */
  readonly #curbs: ColliderIndex;
  readonly #sent = new Map<number, string>();
  #horns: number[] = [];
  #hits: HitRow[] = [];
  #garageMs = 0;

  constructor(deps: VehicleDeps) {
    this.#deps = deps;
    this.#curbs = new ColliderIndex(deps.layout.colliders, (c) => c.shape === 'box' && !isBlocking(c));
  }

  // ---- lookups ----

  get(id: number): Vehicle {
    const v = this.vehicles.get(id);
    if (!v) throw refuse('unknownVehicle');
    return v;
  }

  #seated(player: SweepersPlayer): Vehicle | null {
    return player.vehicle !== 0 ? this.vehicles.get(player.vehicle) ?? null : null;
  }

  #driven(player: SweepersPlayer): Vehicle {
    const v = this.#seated(player);
    if (!v || player.seat !== 0) throw refuse('notDriver');
    return v;
  }

  #point(v: Vehicle, [lx, lz]: [number, number]): { x: number; z: number } {
    const [ox, oz] = toWorld(v.rotY, lx, lz);
    return { x: v.x + ox, z: v.z + oz };
  }

  bedPoint(v: Vehicle): { x: number; z: number } {
    return this.#point(v, bedLocal(v.type));
  }

  #ground(x: number, z: number): number {
    return this.#deps.moveWorld.ground(x, z);
  }

  /** A vehicle whose bed point is within 1.5 m of (x, z), nearest first, or null. */
  bedAt(x: number, z: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bestD = BED_REACH_M;
    for (const v of this.vehicles.values()) {
      const b = this.bedPoint(v);
      const d = Math.hypot(b.x - x, b.z - z);
      if (d <= bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }

  /** The loose load and bags of the bed fit `kg` more. */
  freeKg(v: Vehicle): number {
    return vehicleType(v.type).capKg - bedKg(v);
  }

  /** Body circles (centre and both end circles) of every vehicle: placement keeps clear of them (M3). */
  bodyCircles(): Array<{ x: number; z: number; r: number }> {
    return [...this.vehicles.values()].flatMap((v) => [0, ...endOffsets(v.type)].map((lz) => {
      const [ox, oz] = toWorld(v.rotY, 0, lz);
      return { x: v.x + ox, z: v.z + oz, r: vehicleType(v.type).r };
    }));
  }

  /** True when the centre and both end circles are inside the grid, in open districts and clear of blocking colliders. */
  bodyClear(type: number, x: number, z: number, rotY: number): boolean {
    const r = vehicleType(type).r;
    return [0, ...endOffsets(type)].every((lz) => {
      const [ox, oz] = toWorld(rotY, 0, lz);
      const cx = x + ox;
      const cz = z + oz;
      const hex = hexAt(cx, cz);
      return hex !== null && this.#deps.unlocked.has(hex.district) && !this.#pushed(cx, cz, r);
    });
  }

  /** True when the circle would be pushed out of a blocking collider by more than the tolerance. */
  #pushed(x: number, z: number, r: number): boolean {
    const out = resolveCircle(this.#deps.logistics.colliders.near(x, z, r), x, z, r);
    return Math.hypot(out.x - x, out.z - z) > END_TOLERANCE_M;
  }

  // ---- shop ----

  /** Buys vehicle `type` from the team funds (the caller checked the workbench); it spawns at its slot. */
  buy(type: number, now: number): Vehicle {
    if ([...this.vehicles.values()].some((v) => v.type === type)) throw refuse('alreadyOwned');
    const price = vehicleType(type).priceFt;
    if (this.#deps.purse.teamFunds < price) throw notEnoughTeamFunds(price);
    // A structure built over the empty slot would trap the new vehicle (M3): refuse instead of spawning it stuck.
    const slot = spawnSlot(type);
    if (!this.bodyClear(type, slot.x, slot.z, slot.rotY)) throw refuse('slotBlocked');
    const id = this.#freeId();
    if (id === null) throw refuse('alreadyOwned');
    this.#deps.purse.teamFunds -= price;
    const v = newVehicle(id, type, now);
    this.vehicles.set(id, v);
    return v;
  }

  /** Buys a jerry can (0 benzin, 1 dízel) from the team funds into empty hands. */
  buyJerryCan(player: SweepersPlayer, tier: number): void {
    if (player.carry !== 0 || player.personal.jerry !== 0) throw refuse('handsFull');
    if (this.#deps.purse.teamFunds < JERRYCAN.ft) throw notEnoughTeamFunds(JERRYCAN.ft);
    this.#deps.purse.teamFunds -= JERRYCAN.ft;
    player.personal.jerry = tier === 0 ? 1 : 2;
    player.personalDirty = true;
  }

  #freeId(): number | null {
    if (this.vehicles.size >= VEHICLE_CAP) return null;
    for (let id = 1; id <= 255; id++) if (!this.vehicles.has(id)) return id;
    return null;
  }

  // ---- seats ----

  /** `vehicle_enter` checks after the guard (F.4 order); returns the seat. */
  enter(player: SweepersPlayer, id: number, seat: number, now: number): number {
    const v = this.get(id);
    if (player.vehicle !== 0) throw refuse('alreadySeated');
    if (player.carry !== 0 || player.personal.jerry !== 0) throw refuse('handsFull');
    if (seat >= v.seats.length) {
      throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: 'seat', reason: 'range', message: `"seat" must be within 0..${v.seats.length - 1}.` });
    }
    if (v.seats[seat] !== 0) throw refuse('seatTaken');
    if (Math.hypot(player.pose.x - v.x, player.pose.z - v.z) > vehicleType(v.type).r + ENTER_REACH_EXTRA_M) throw refuse('tooFar');
    // No getting in through a wall or fence: the player circle must reach the centre unhindered.
    if (this.#deps.moveWorld.sweep(player.pose.x, player.pose.z, v.x, v.z).hit) throw refuse('tooFar');
    if (v.v >= STOPPED_MPS) throw refuse('vehicleMoving');
    v.seats[seat] = player.id;
    player.vehicle = v.id;
    player.seat = seat;
    if (seat === 0) {
      v.seq = -1;
      v.lastDriveAt = now;
      v.budget = fullBudget(now);
      this.#anchorScale(v, now);
    }
    player.pose = { ...player.pose, state: 'IDLE' };
    this.#seatPoses(v);
    return seat;
  }

  /**
   * `vehicle_action exit`: out on the driver side, else the passenger side, the rear, the front. A point is
   * usable when the player circle walks from the centre to it without touching a collider and the whole path
   * is open; none → `exitBlocked` (the player stays seated). Returns the new position.
   */
  exit(player: SweepersPlayer, now: number): { x: number; z: number } {
    const v = this.#seated(player);
    if (!v) throw refuse('notSeated');
    const t = vehicleType(v.type);
    const world = this.#deps.moveWorld;
    // Driver side, passenger side, then rear and front: a gap the vehicle drove into is open at one of its ends (review N1).
    const exits: Array<[number, number]> = [[-1, 0], [1, 0], [0, 1], [0, -1]];
    const out = exits.map(([s, e]) => this.#point(v, [s * (t.wid / 2 + EXIT_SIDE_M), e * (t.len / 2 + EXIT_SIDE_M)])).find((p) =>
      !world.sweep(v.x, v.z, p.x, p.z).hit && pathOpen(world, v.x, v.z, p.x, p.z));
    if (!out) throw refuse('exitBlocked');
    this.unseat(player);
    player.pose = { x: out.x, y: this.#ground(out.x, out.z), z: out.z, rotY: player.pose.rotY, state: 'IDLE' };
    player.resetBudget(now);
    player.corrected = true;
    player.dirty = true;
    return { x: r2(out.x), z: r2(out.z) };
  }

  /** Frees the player's seat (exit, removal after the grace window); a driver leaving stops the vehicle. */
  unseat(player: SweepersPlayer): void {
    const v = this.#seated(player);
    if (v && v.seats[player.seat] === player.id) {
      v.seats[player.seat] = 0;
      if (player.seat === 0) v.v = 0;
    }
    player.vehicle = 0;
    player.seat = 0;
  }

  /** A seated player's socket dropped (seat kept for the grace window): a driver's vehicle stops. */
  detached(player: SweepersPlayer): void {
    const v = this.#seated(player);
    if (v && player.seat === 0) v.v = 0;
  }

  /** A seated driver reconnected: its client starts a new drive seq. */
  reattached(player: SweepersPlayer): void {
    const v = this.#seated(player);
    if (v && player.seat === 0) v.seq = -1;
  }

  /** A seated `player_input`: seq and heading; a passenger's WALK / SPRINT become IDLE. Then the pose follows the seat. */
  seatedInput(player: SweepersPlayer, seq: number, rotY: number, state: Pose['state']): boolean {
    const passenger = player.seat !== 0;
    const ok = player.applySeatedInput(seq, rotY, passenger ? (state === 'WALK' || state === 'SPRINT' ? 'IDLE' : state) : null);
    const v = this.#seated(player);
    if (ok && v) this.#seatPoses(v);
    return ok;
  }

  /** Writes every seated player's pose from its seat (driver: the vehicle heading and the drive state). */
  #seatPoses(v: Vehicle): void {
    const t = vehicleType(v.type);
    const y0 = this.#ground(v.x, v.z);
    v.seats.forEach((id, i) => {
      const p = id === 0 ? undefined : this.#deps.player(id);
      const seat = t.seats[i];
      if (!p || !seat) return;
      const at = this.#point(v, [seat[0], seat[2]]);
      const driver = i === 0;
      const pose: Pose = {
        x: at.x, y: y0 + seat[1], z: at.z, rotY: driver ? v.rotY : p.pose.rotY, state: driver ? (t.manual ? 'PUSHING_CART' : 'DRIVING_VEHICLE') : p.pose.state
      };
      const before = p.pose;
      if (before.x !== pose.x || before.y !== pose.y || before.z !== pose.z || before.rotY !== pose.rotY || before.state !== pose.state) p.dirty = true;
      p.pose = pose;
    });
  }

  // ---- driving ----

  /** `vehicle_drive` from seat 0 (F.2 steps 1–6); stale seqs are ignored. */
  drive(player: SweepersPlayer, seq: number, req: { x: number; y: number; z: number; rotY: number }, now: number): void {
    const v = this.#driven(player);
    if (seq <= v.seq) return;
    v.seq = seq;
    const t = vehicleType(v.type);
    // Floor at the input limiter's 1/30 s, so faster drives never under-report the speed (curbs, "stopped").
    const elapsed = Math.max(1 / 30, (now - v.lastDriveAt) / 1000);
    v.lastDriveAt = now;
    const world: MoveWorld = { ...this.#deps.moveWorld, sweep: (a, b, c, d) => this.#deps.moveWorld.sweep(a, b, c, d, t.r) };
    const factor = (topMps(v.type) / MAX_SPEED) * (v.punct ? PUNCT_SPEED : 1);
    const current: Pose = { x: v.x, y: this.#ground(v.x, v.z), z: v.z, rotY: v.rotY, state: 'IDLE' };
    const refused = (): void => {
      // A zero move refills the budget exactly as a refused one does.
      v.budget = validateMove(current, current, v.budget, now, world, factor).budget;
      v.v = 0;
      v.corrected = true;
      this.#seatPoses(v);
    };
    if (!t.manual && v.fuelL <= 0) return refused();
    const result = validateMove(current, { ...req, state: 'IDLE' }, v.budget, now, world, factor);
    const { x, z, rotY } = result.pose;
    const r = t.r;
    // The nose and tail circles may not enter walls (step 3).
    if (endOffsets(v.type).some((lz) => {
      const [ox, oz] = toWorld(rotY, 0, lz);
      return this.#pushed(x + ox, z + oz, r);
    })) return refused();
    v.budget = result.budget;
    const moved = Math.hypot(x - v.x, z - v.z);
    const from = { x: v.x, z: v.z, rotY: v.rotY };
    v.x = x;
    v.z = z;
    v.rotY = rotY;
    v.v = moved / elapsed;
    if (!t.manual) v.fuelL = Math.max(0, v.fuelL - (moved * t.lPerKm) / 1000);
    if (x !== req.x || z !== req.z) v.corrected = true;
    this.#curb(v, from, now);
    if (t.brush && moved > 0.05) this.#brush(v, from, player);
    this.#seatPoses(v);
    this.#anchorScale(v, now);
  }

  /** Curb hit (103): over 35 km/h the body circle newly touches a step-over box. */
  #curb(v: Vehicle, from: { x: number; z: number }, now: number): void {
    if (v.v <= CURB_MPS || now - v.curbAt < CURB_COOLDOWN_MS) return;
    const r = vehicleType(v.type).r;
    const touching = (x: number, z: number): Collider[] => this.#curbs.near(x, z, r).filter((c) => penetration(c, x, z, r) !== null);
    const before = new Set(touching(from.x, from.z));
    if (!touching(v.x, v.z).some((c) => !before.has(c))) return;
    v.curbAt = now;
    v.align = Math.min(ALIGN_MAX, v.align + 1);
    const punctured = !v.punct && this.#deps.chance(PUNCTURE_CHANCE);
    if (punctured) v.punct = true;
    this.#hits.push([v.id, punctured ? 1 : 0]);
  }

  /** Multicar / IFA brushes (95/96): a rect from the old to the new front bumper into the bed. */
  #brush(v: Vehicle, from: { x: number; z: number; rotY: number }, driver: SweepersPlayer): void {
    const t = vehicleType(v.type);
    const brush = t.brush;
    const free = this.freeKg(v);
    if (!brush || free <= 1e-6) return;
    const a = this.#point({ ...v, ...from }, [0, -t.len / 2]);
    const b = this.#point(v, [0, -t.len / 2]);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const region = rectRegion(a.x, a.z, angleOf(b.x - a.x, b.z - a.z), len, brush.widthM);
    const { kg } = brushSweep({ world: this.#deps.debris, unlocked: this.#deps.unlocked, drizzle: this.#deps.drizzle() }, region, brush.eff, free, v.load);
    if (kg <= 0) return;
    driver.personal.totalKg += kg;
    driver.personalDirty = true;
    this.#deps.credit(districtAt(v.x, v.z), kg);
  }

  /** E.2 on the vehicle's own fields: off the weighbridge, or more than 0.15 m from the anchor, re-anchors. */
  #anchorScale(v: Vehicle, now: number): void {
    const scale = scaleAt(this.#deps.layout, v.x, v.z) === 0 ? 0 : -1;
    if (scale === 0 && v.scale === 0 && Math.hypot(v.x - v.scaleAnchor.x, v.z - v.scaleAnchor.z) <= SCALE_ANCHOR_M) return;
    v.scale = scale;
    v.scaleAnchor = { x: v.x, z: v.z };
    v.scaleSince = now;
    v.scaleDone = false;
  }

  // ---- actions ----

  /** `miskolc:vehicle_action` except exit (F.4). */
  action(player: SweepersPlayer, action: VehicleAction, now: number): VehicleAck {
    switch (action.kind) {
      case 'exit':
        return { ok: true, ...this.exit(player, now) };
      case 'tip':
        return this.#tip(this.#driven(player), now);
      case 'lights': {
        const v = this.#driven(player);
        if (!vehicleType(v.type).lights) throw refuse('noLights');
        v.lights = action.mode;
        return { ok: true };
      }
      case 'beacon': {
        const v = this.#driven(player);
        if (!vehicleType(v.type).beacon) throw refuse('noBeacon');
        v.beacon = action.on;
        return { ok: true };
      }
      case 'horn': {
        const v = this.#driven(player);
        if (!vehicleType(v.type).horn) throw refuse('noHorn');
        if (now - v.hornAt < HORN_COOLDOWN_MS) throw tooFast();
        v.hornAt = now;
        this.#horns.push(v.id);
        return { ok: true };
      }
      case 'load':
        return { ok: true, bedKg: this.#load(player, this.get(action.id)) };
      case 'refuel':
        return { ok: true, fuelL: this.#refuel(player, this.get(action.id)) };
      case 'repair':
        return { ok: true, teamFunds: this.#repair(player, this.get(action.id)) };
    }
  }

  /** `player_action dump` into a bed (F.2): buffer and pack move in up to the cap; returns the bed kg. */
  dumpInto(v: Vehicle, data: PersonalData): number {
    const moved = moveLoad(data.buf, v.load, this.freeKg(v), Infinity) + moveLoad(data.pack, v.load, this.freeKg(v), Infinity);
    if (moved <= 1e-6) throw refuse('bedFull');
    return r2(bedKg(v));
  }

  #load(player: SweepersPlayer, v: Vehicle): number {
    if (player.vehicle !== 0) throw refuse('alreadySeated');
    const bag = this.#deps.logistics.bags.get(player.carry);
    if (player.carry === 0 || bag?.st !== 1) throw refuse('notCarrying');
    const b = this.bedPoint(v);
    if (Math.hypot(player.pose.x - b.x, player.pose.z - b.z) > BED_REACH_M) throw refuse('tooFar');
    if (v.bags.length >= BED_BAGS || loadKg(bag.load) > this.freeKg(v) + 1e-6) throw refuse('bedFull');
    this.#deps.logistics.takeBag(bag);
    v.bags.push({ tier: bag.tier, tint: bag.tint, load: bag.load });
    player.carry = 0;
    player.pose = { ...player.pose, state: player.pose.state === 'HOLDING_BAG' ? 'IDLE' : player.pose.state };
    player.dirty = true;
    return r2(bedKg(v));
  }

  #tip(v: Vehicle, now: number): VehicleAck {
    if (v.v >= STOPPED_MPS) throw refuse('vehicleMoving');
    if (now < v.tipUntil) throw tooFast();
    if (isEmptyLoad(v.load) && v.bags.length === 0) throw refuse('bedEmpty');
    v.tipUntil = now + TIP_MS;
    const logistics = this.#deps.logistics;
    const b = this.bedPoint(v);
    const hopper = logistics.hopperAt(b.x, b.z);
    if (hopper !== null) {
      let kg = logistics.fillHopper(hopper, v.load);
      v.bags = v.bags.filter((bag) => {
        const bagKg = loadKg(bag.load);
        if (!logistics.queueIntoHopper(hopper, bag.tier, bag.tint, bag.load)) return true;
        kg += bagKg;
        return false;
      });
      return { ok: true, into: 'hopper', kg: r2(kg) };
    }
    let kg = loadKg(v.load);
    spill(this.#deps.debris, v.load, b.x, b.z, v.rotY);
    // Bags land just behind the bed point (away from the body), sliding off each other; at the room bag cap the rest stay on the bed.
    const dx = b.x - v.x;
    const dz = b.z - v.z;
    const d = Math.hypot(dx, dz) || 1;
    const at = this.#deps.debris.openToward(b.x + (dx / d) * 0.6, b.z + (dz / d) * 0.6, v.x, v.z, this.#deps.unlocked) ?? b;
    v.bags = v.bags.filter((bag) => {
      if (!logistics.newBag(bag.tier, bag.load, at.x, at.z, v.rotY, dx / d, dz / d, true, bag.tint)) return true;
      kg += loadKg(bag.load);
      return false;
    });
    return { ok: true, into: 'ground', kg: r2(kg) };
  }

  #refuel(player: SweepersPlayer, v: Vehicle): number {
    if (player.vehicle !== 0) throw refuse('alreadySeated');
    const f = this.#point(v, fillerLocal(v.type));
    if (Math.hypot(player.pose.x - f.x, player.pose.z - f.z) > BED_REACH_M) throw refuse('tooFar');
    const t = vehicleType(v.type);
    if (t.fuel === null) throw refuse('noFuelTank');
    const can = player.personal.jerry;
    if (can === 0) throw refuse('noJerryCan');
    if (can - 1 !== t.fuel) throw refuse('wrongFuel');
    // A partial pour wastes the rest of the can.
    v.fuelL = Math.min(t.tankL, v.fuelL + JERRYCAN.l);
    player.personal.jerry = 0;
    player.personalDirty = true;
    return r2(v.fuelL);
  }

  #repair(player: SweepersPlayer, v: Vehicle): number {
    if (player.vehicle !== 0) throw refuse('alreadySeated');
    if (Math.hypot(player.pose.x - v.x, player.pose.z - v.z) > vehicleType(v.type).r + ENTER_REACH_EXTRA_M) throw refuse('tooFar');
    if (v.v >= STOPPED_MPS) throw refuse('vehicleMoving');
    if (v.align === 0 && !v.punct) throw refuse('nothingToRepair');
    const purse = this.#deps.purse;
    if (purse.teamFunds < REPAIR_FT) throw notEnoughTeamFunds(REPAIR_FT);
    purse.teamFunds -= REPAIR_FT;
    v.align = 0;
    v.punct = false;
    return purse.teamFunds;
  }

  /** The bed contents leave (weighed): loose load and bags. */
  emptyBed(v: Vehicle): void {
    v.load = emptyLoad();
    v.bags = [];
  }

  // ---- tick, rows ----

  /** Idle stop, then the 1 Hz garage refuel (room time). */
  tick(dtMs: number, now: number): void {
    for (const v of this.vehicles.values()) if (now - v.lastDriveAt >= IDLE_STOP_MS) v.v = 0;
    this.#garageMs += dtMs;
    while (this.#garageMs >= GARAGE.stepMs) {
      this.#garageMs -= GARAGE.stepMs;
      this.#garageStep();
    }
  }

  #garageStep(): void {
    const purse = this.#deps.purse;
    for (const v of this.vehicles.values()) {
      const t = vehicleType(v.type);
      if (t.manual || v.v >= STOPPED_MPS || v.fuelL >= t.tankL || !this.inGarage(v)) continue;
      const litres = Math.min((GARAGE.lPerS * GARAGE.stepMs) / 1000, t.tankL - v.fuelL);
      const cost = Math.round(litres * GARAGE.ftPerL);
      if (purse.teamFunds < cost) continue;
      purse.teamFunds -= cost;
      v.fuelL = Math.min(t.tankL, v.fuelL + litres);
    }
  }

  inGarage(v: Vehicle): boolean {
    for (const st of this.#deps.logistics.structures.values()) if (st.type === TYPE.garage && inRect(st.rect, v.x, v.z)) return true;
    return false;
  }

  row(v: Vehicle, now: number): VehicleRow {
    const t = vehicleType(v.type);
    const flags = v.lights | (v.beacon ? VFLAG.beacon : 0) | (now < v.tipUntil ? VFLAG.tipping : 0) | (v.punct ? VFLAG.punct : 0)
      | (!t.manual && v.fuelL <= 0 && v.seats.some((s) => s !== 0) ? VFLAG.stalled : 0) | (v.corrected ? VFLAG.corr : 0)
      | (this.inGarage(v) ? VFLAG.garage : 0) | (v.align << VFLAG.alignShift);
    return [
      v.id, v.type, toCm(v.x), toCm(v.z), toRot16(v.rotY), Math.round(v.v * 100), Math.round(v.fuelL * 10), flags, Math.round(bedKg(v) * 100), v.bags.length,
      v.seats[0] ?? 0, v.seats[1] ?? 0, v.seats[2] ?? 0
    ];
  }

  /** `init_state.vehicles`, by id. */
  rows(now: number): VehicleRow[] {
    return [...this.vehicles.values()].sort((a, b) => a.id - b.id).map((v) => this.row(v, now));
  }

  /** The coalesced update of this tick (changed rows, horns, hits), or null. A corrected row always goes out (the driver must snap); clears the corr flags. */
  takeUpdate(now: number): VehicleUpdate | null {
    const update: VehicleUpdate = { t: now };
    const changed: VehicleRow[] = [];
    for (const v of [...this.vehicles.values()].sort((a, b) => a.id - b.id)) {
      const row = this.row(v, now);
      const key = JSON.stringify(row);
      if (this.#sent.get(v.id) !== key || v.corrected) {
        changed.push(row);
        this.#sent.set(v.id, key);
      }
      v.corrected = false;
    }
    if (changed.length > 0) update.v = changed;
    if (this.#horns.length > 0) update.horn = this.#horns;
    if (this.#hits.length > 0) update.hit = this.#hits;
    this.#horns = [];
    this.#hits = [];
    return Object.keys(update).length > 1 ? update : null;
  }
}
