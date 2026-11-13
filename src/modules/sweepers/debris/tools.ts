// Tool uses on the debris (plan C.3): cells, piles, items, the blower, scoop / crush / unclog /
// turbo, tipping, spilling and can kicks. Server-authoritative; refusals throw SweepersError.
import { ValidationError } from '../../../core/errors/ValidationError.ts';
import { INVALID_PAYLOAD_MESSAGE } from '../../../core/validation/PayloadReader.ts';
import { sweepCircle } from '../geometry.ts';
import { HEX_CELLS, hexAt } from '../hexGrid.ts';
import { SWEEPERS_ERRORS, SweepersError } from '../SweepersError.ts';
import type { DebrisWorld, Item, KickRow } from './DebrisWorld.ts';
import { PILE_MERGE_M } from './DebrisWorld.ts';
import { cellCentre, cellCoord, dustKg, liveIndex, seedKg } from './grid.ts';
import {
  bufferCap, effectActive, emptyLoad, hardEff, headWidth, isEmptyLoad, loadKg, loadL, packCapKg, packCapL
} from './personal.ts';
import type { Load, PersonalData } from './personal.ts';
import { arcRegion, coneRegion, dirOf, inRegion, reducedLevel, regionArea, regionExtent, sectorRegion, sweepFraction } from './regions.ts';
import type { Region } from './regions.ts';
import {
  ALT_CADENCE, BLOWER, BLOWER_ALT_STAMINA, BLOWER_FUEL_ML, CAN_KG, CAN_L, COPPER_L_PER_KG, CRUSH_MAX, CRUSH_STAMINA_PER_CAN, CRUSHED_L,
  DUST_L_PER_KG, FLAG_BURIED, FLAG_STUCK, HAND, HARD_WEAR, IRON_L_PER_KG, jackpotOf, KIND, RAKE, SCOOP_STAMINA, SEED_L_PER_KG, STENCH_MS,
  toolOf, TURBO_FUEL_ML, VACUUM, VACUUM_ALT_STAMINA
} from './tables.ts';

/** Vacuum clog chance per can. */
export const CLOG_CHANCE = 0.04;
/** Brooms push at O + dir · (reach + 0.6). */
export const PUSH_EXTRA_M = 0.6;
/** Pile take per use: 3 · speed · cadence · 1.6 kg (the 3× rule). */
export const PILE_TAKE_FACTOR = 3 * 1.6;
export const SCOOP_EXTRA_M = 0.5;
export const BLOWER_CELL_F = 0.35;
export const BLOWER_PILE_MERGE_M = 1.5;
export const BLOWER_SCATTER_M = 1;
export const TURBO_REACH_M = 3;
export const TURBO_HALF_ANGLE = (20 * Math.PI) / 180;
export const MAGNET_RADIUS_M = 2.5;
export const VACUUM_COPPER_MAX_DG = 200;
/** Buffers of tools 5 and 6 drain into the backpack at this rate. */
export const DRAIN_KG_PER_S = 3;
/** Wear: 1 % (10 permille) per 100 kg of class 1. */
export const WEAR_PERMILLE_PER_KG = 10 / 100;
export const DUMP_IRON_MAX_DG = 1_500;
export const DUMP_COPPER_MAX_DG = 800;
const EPS_KG = 1e-6;

/** What a use needs to know besides the debris and the player. */
export interface UseContext {
  world: DebrisWorld;
  data: PersonalData;
  now: number;
  /** Open districts. */
  unlocked: ReadonlySet<number>;
  drizzle: boolean;
  /** Random draw (vacuum clog), injectable for tests. */
  chance(p: number): boolean;
}

/** The use outcome (ack `{ ok, seq, kg, items, pushed }` without ok/seq). */
export interface UseResult {
  /** Kg that entered the buffer or the pack from the world. */
  kg: number;
  items: number[];
  pushed: boolean;
}

/** Cadence of a use, s. */
export const cadenceOf = (tool: number, alt: boolean): number => (alt ? ALT_CADENCE : toolOf(tool).cadence);

/** Tools with an alt (RMB) use: brooms (scoop), blower (turbo), vacuum (reverse blow), hand (crush). */
export const hasAlt = (tool: number): boolean => tool !== RAKE;

const refuse = (key: keyof typeof SWEEPERS_ERRORS): SweepersError => new SweepersError(SWEEPERS_ERRORS[key], { reason: key });

const hexDistrict = (hex: number): number => HEX_CELLS[hex]?.district ?? 0;

const itemOpen = (ctx: UseContext, item: Item): boolean => item.hex >= 0 && ctx.unlocked.has(hexDistrict(item.hex));

/** Grams of an item as it goes into a load. */
function addItemToLoad(load: Load, item: Item): void {
  if (item.kind === KIND.can) load.cans += 1;
  else if (item.kind === KIND.iron) load.ironG += item.massDg * 10;
  else if (item.kind === KIND.copper) load.copperG += item.massDg * 10;
  else if (item.kind === KIND.cabbage) load.seedG += item.massDg * 10;
  else if (item.kind === KIND.pile) {
    load.seedG += item.seedDg * 10;
    load.dustG += (item.massDg - item.seedDg) * 10;
  } else if (jackpotOf(item.kind)) load.jackpots.push(item.kind);
}

const itemKg = (item: Item): number => (item.kind === KIND.can ? CAN_KG : item.massDg / 100);
function itemL(item: Item): number {
  if (item.kind === KIND.can) return CAN_L;
  const kg = item.massDg / 100;
  if (item.kind === KIND.iron) return kg * IRON_L_PER_KG;
  if (item.kind === KIND.copper) return kg * COPPER_L_PER_KG;
  if (item.kind === KIND.cabbage) return kg * SEED_L_PER_KG;
  return jackpotOf(item.kind)?.l ?? 0;
}

/** Applies the stench rule: a region holding a cabbage, without gloves, starts 10 s of stench. */
function checkStench(ctx: UseContext, region: Region): void {
  if (ctx.data.gloves) return;
  const near = ctx.world.itemsNear(region.ox, region.oz, regionExtent(region));
  if (near.some(({ item }) => item.kind === KIND.cabbage && inRegion(region, item.x, item.z))) ctx.data.fx.stench = ctx.now + STENCH_MS;
}

interface CellPlan {
  index: number;
  byte: number;
  dustKg: number;
  seedKg: number;
}

/** Planned cell changes of a sweep in `region` (nearest cells first). */
function planCells(ctx: UseContext, region: Region, tool: number, classes: { dust: boolean; seed: boolean }): CellPlan[] {
  const spec = toolOf(tool);
  const area = regionArea(region);
  const ext = regionExtent(region);
  const stench = effectActive(ctx.data, 'stench', ctx.now) ? 0.5 : 1;
  const grid = ctx.world.grid;
  const plans: Array<CellPlan & { d: number }> = [];
  for (let gz = cellCoord(region.oz - ext); gz <= cellCoord(region.oz + ext); gz++) {
    for (let gx = cellCoord(region.ox - ext); gx <= cellCoord(region.ox + ext); gx++) {
      const index = liveIndex(grid, gx, gz);
      if (index < 0) continue;
      const hex = grid.cellHex[index] ?? -1;
      if (hex < 0) continue;
      const district = hexDistrict(hex);
      if (!ctx.unlocked.has(district)) continue;
      const x = cellCentre(gx);
      const z = cellCentre(gz);
      if (!inRegion(region, x, z)) continue;
      const byte = ctx.world.cells[index] ?? 0;
      if (byte === 0) continue;
      const surface = grid.cellSurface[index] ?? 0;
      const dry = surface === 0 && !ctx.drizzle;
      const f = sweepFraction(spec.speed, spec.cadence, stench * (tool === 2 && dry ? 1.15 : 1), area);
      const heavy = district === 3 || (surface >= 1 && surface <= 3) || ctx.drizzle;
      const effDust = (tool === 1 ? 0.6 : 1) * (heavy ? 0.5 * hardEff(ctx.data) : 1);
      const dust = byte >> 4;
      const seed = byte & 15;
      const newDust = classes.dust ? reducedLevel(dust, f, Math.min(1, effDust)) : dust;
      const newSeed = classes.seed ? reducedLevel(seed, f, 1) : seed;
      if (newDust === dust && newSeed === seed) continue;
      plans.push({
        index, byte: (newDust << 4) | newSeed, d: Math.hypot(x - region.ox, z - region.oz),
        dustKg: dustKg(dust, district) - dustKg(newDust, district), seedKg: seedKg(seed, district) - seedKg(newSeed, district)
      });
    }
  }
  return plans.sort((a, b) => a.d - b.d || a.index - b.index);
}

/** Moves as much of `from` into `to` as fits in (freeKg, freeL): jackpots, copper, iron, cans, crushed, dust, seed. Returns kg moved. */
export function moveLoad(from: Load, to: Load, freeKg: number, freeL: number): number {
  let kg = Math.max(0, freeKg);
  let l = Math.max(0, freeL);
  let moved = 0;
  const jackpots = [...from.jackpots];
  from.jackpots = [];
  for (const kind of jackpots) {
    const spec = jackpotOf(kind);
    if (spec && spec.kg <= kg + EPS_KG && spec.l <= l + EPS_KG) {
      to.jackpots.push(kind);
      kg -= spec.kg;
      l -= spec.l;
      moved += spec.kg;
    } else {
      from.jackpots.push(kind);
    }
  }
  const grams = (key: 'copperG' | 'ironG' | 'dustG' | 'seedG', lPerKg: number): void => {
    const take = Math.max(0, Math.min(from[key], kg * 1000, lPerKg > 0 ? (l / lPerKg) * 1000 : Infinity));
    if (take <= 0) return;
    from[key] -= take;
    to[key] += take;
    kg -= take / 1000;
    l -= (take / 1000) * lPerKg;
    moved += take / 1000;
  };
  const count = (key: 'cans' | 'crushed', litres: number): void => {
    const take = Math.max(0, Math.min(from[key], Math.floor((kg + EPS_KG) / CAN_KG), Math.floor((l + EPS_KG) / litres)));
    if (take <= 0) return;
    from[key] -= take;
    to[key] += take;
    kg -= take * CAN_KG;
    l -= take * litres;
    moved += take * CAN_KG;
  };
  grams('copperG', COPPER_L_PER_KG);
  grams('ironG', IRON_L_PER_KG);
  count('cans', CAN_L);
  count('crushed', CRUSHED_L);
  grams('dustG', DUST_L_PER_KG);
  grams('seedG', SEED_L_PER_KG);
  return moved;
}

const packFreeKg = (data: PersonalData): number => packCapKg(data) - loadKg(data.pack);
const packFreeL = (data: PersonalData): number => packCapL(data) - loadL(data.pack);
const bufFree = (data: PersonalData): number => bufferCap(data) - loadKg(data.buf);

/** Tips the buffer into the backpack as far as it fits. Returns kg moved. */
export function tipBuffer(data: PersonalData): number {
  return moveLoad(data.buf, data.pack, packFreeKg(data), packFreeL(data));
}

/** Drains the buffer of tools 5 and 6 into the backpack (3 kg/s). True when anything moved. */
export function drainBuffer(data: PersonalData, dtMs: number): boolean {
  if (data.toolTier !== VACUUM && data.toolTier !== RAKE) return false;
  if (isEmptyLoad(data.buf)) return false;
  const limit = (DRAIN_KG_PER_S * Math.max(0, dtMs)) / 1000;
  return moveLoad(data.buf, data.pack, Math.min(limit, packFreeKg(data)), packFreeL(data)) > EPS_KG;
}

/** Deterministic scatter offset of an item id: up to `radius` m. */
function scatter(id: number, radius: number): { dx: number; dz: number } {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
  const r = ((h >>> 16) / 0x10000) * radius;
  return { dx: Math.cos(angle) * r, dz: Math.sin(angle) * r };
}

/**
 * Spills a whole load at (x, z) (dump; Phase D bag rupture): one pile for dust and seed, then re-created
 * items with new ids (cans and crushed cans as cans, iron in ≤ 15 kg and copper in ≤ 8 kg pieces, each
 * jackpot on its own). Points that are not open fall back towards the grid centre. Empties the load.
 */
export function spill(world: DebrisWorld, load: Load, x: number, z: number, rotY: number): void {
  const at = world.openToward(x, z, 0, 0) ?? { x, z };
  const dir = dirOf(rotY);
  world.deposit(at.x, at.z, load.dustG / 1000, load.seedG / 1000, dir.x, dir.z, PILE_MERGE_M, 0, 0);
  const pieces: Array<[number, number]> = [];
  for (let i = 0; i < load.cans + load.crushed; i++) pieces.push([KIND.can, CAN_KG * 100]);
  const split = (grams: number, maxDg: number, kind: number): void => {
    let dg = Math.round(grams / 10);
    while (dg > 0) {
      const piece = Math.min(dg, maxDg);
      pieces.push([kind, piece]);
      dg -= piece;
    }
  };
  split(load.ironG, DUMP_IRON_MAX_DG, KIND.iron);
  split(load.copperG, DUMP_COPPER_MAX_DG, KIND.copper);
  for (const kind of load.jackpots) {
    const spec = jackpotOf(kind);
    if (spec) pieces.push([kind, spec.kg * 100]);
  }
  pieces.forEach(([kind, dg], i) => {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const r = 0.4 + 0.15 * (i % 6);
    const p = world.openToward(at.x + Math.cos(angle) * r, at.z + Math.sin(angle) * r, at.x, at.z) ?? at;
    world.place(kind, p.x, p.z, dg, 0, (i * 37) & 0xff);
  });
  Object.assign(load, emptyLoad());
}

/** Stamina (tenths) a use costs before it runs (the crush cost is per can, checked inside). */
function staminaCost(tool: number, alt: boolean): number {
  if (!alt) return toolOf(tool).stamina;
  if (tool <= 3) return SCOOP_STAMINA;
  if (tool === BLOWER) return BLOWER_ALT_STAMINA;
  if (tool === VACUUM) return VACUUM_ALT_STAMINA;
  return CRUSH_STAMINA_PER_CAN;
}

/**
 * Runs one accepted use of the equipped `tool` at origin (ox, oz) facing `rotY`. The caller has
 * checked the room, rate, equipped tool, cadence, distance and origin district. Throws a refusal for
 * stamina, fuel, clog and capacity (C.3).
 */
export function useTool(ctx: UseContext, tool: number, alt: boolean, ox: number, oz: number, rotY: number): UseResult {
  if (alt && !hasAlt(tool)) throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: 'alt', reason: 'range', message: 'This tool has no alt use.' });
  const data = ctx.data;
  const cost = staminaCost(tool, alt);
  if (data.stamina < cost) throw refuse('exhausted');
  if (tool === VACUUM && data.clogged && !alt) throw refuse('clogged');
  if (tool === BLOWER && data.fuelMl < (alt ? TURBO_FUEL_ML : BLOWER_FUEL_ML)) throw refuse('noFuel');
  if (tool === VACUUM && !alt && bufFree(data) <= EPS_KG) throw refuse('tankFull');
  let result: UseResult;
  if (alt) result = altUse(ctx, tool, ox, oz, rotY);
  else if (tool <= 3 || tool === VACUUM) result = sweep(ctx, tool, ox, oz, rotY);
  else if (tool === BLOWER) result = blow(ctx, ox, oz, rotY);
  else if (tool === RAKE) result = rake(ctx, ox, oz, rotY);
  else result = hand(ctx, ox, oz, rotY);
  if (!(alt && tool === HAND)) data.stamina = Math.max(0, data.stamina - cost);
  if (tool === BLOWER) data.fuelMl = Math.max(0, data.fuelMl - (alt ? TURBO_FUEL_ML : BLOWER_FUEL_ML));
  data.totalKg += result.kg;
  return result;
}

/** Brooms 0–3 and the vacuum, LMB. */
function sweep(ctx: UseContext, tool: number, ox: number, oz: number, rotY: number): UseResult {
  const data = ctx.data;
  const spec = toolOf(tool);
  const vacuum = tool === VACUUM;
  const region = vacuum ? coneRegion(ox, oz, rotY, spec.reach) : arcRegion(ox, oz, rotY, spec.reach, headWidth(data, tool));
  checkStench(ctx, region);
  const result: UseResult = { kg: 0, items: [], pushed: false };
  // Cells.
  let free = Math.max(0, bufFree(data));
  const plans = planCells(ctx, region, tool, { dust: true, seed: !vacuum });
  let takenDust = 0;
  let takenSeed = 0;
  let pushDust = 0;
  let pushSeed = 0;
  for (const plan of plans) {
    const kg = plan.dustKg + plan.seedKg;
    if (vacuum && kg > free + EPS_KG) break;
    ctx.world.setCell(plan.index, plan.byte);
    const share = vacuum ? 1 : Math.min(1, kg > 0 ? free / kg : 1);
    takenDust += plan.dustKg * share;
    takenSeed += plan.seedKg * share;
    pushDust += plan.dustKg * (1 - share);
    pushSeed += plan.seedKg * (1 - share);
    free = Math.max(0, free - kg * share);
  }
  data.buf.dustG += takenDust * 1000;
  data.buf.seedG += takenSeed * 1000;
  result.kg += takenDust + takenSeed;
  if (pushDust + pushSeed > EPS_KG) {
    const dir = dirOf(rotY);
    const d = spec.reach + PUSH_EXTRA_M;
    ctx.world.deposit(ox + dir.x * d, oz + dir.z * d, pushDust, pushSeed, dir.x, dir.z, PILE_MERGE_M, ox, oz, ctx.unlocked);
    result.pushed = true;
  }
  if (tool >= 1 && tool <= 3) {
    const wear = (takenDust + pushDust) * WEAR_PERMILLE_PER_KG * (HARD_WEAR[data.hardLvl] ?? 1);
    data.dur[tool - 1] = Math.max(0, (data.dur[tool - 1] ?? 1000) - wear);
  }
  // Piles whose centre is in the region (the 3× rule).
  const near = ctx.world.itemsNear(ox, oz, regionExtent(region));
  for (const { item } of near) {
    if (free <= EPS_KG) break;
    if (item.kind !== KIND.pile || !itemOpen(ctx, item) || !inRegion(region, item.x, item.z)) continue;
    const dustAvail = (item.massDg - item.seedDg) / 100;
    const seedAvail = vacuum ? 0 : item.seedDg / 100;
    const avail = dustAvail + seedAvail;
    const take = Math.min(avail, spec.speed * spec.cadence * PILE_TAKE_FACTOR, free);
    if (take <= EPS_KG) continue;
    const dustTake = avail > 0 ? (take * dustAvail) / avail : 0;
    const seedTake = take - dustTake;
    const takeDustDg = Math.round(dustTake * 100);
    const takeSeedDg = Math.round(seedTake * 100);
    const leftDg = item.massDg - takeDustDg - takeSeedDg;
    if (leftDg <= 0) ctx.world.remove(item.id);
    else ctx.world.update(item, { massDg: leftDg, seedDg: Math.max(0, item.seedDg - takeSeedDg) });
    data.buf.dustG += takeDustDg * 10;
    data.buf.seedG += takeSeedDg * 10;
    free -= (takeDustDg + takeSeedDg) / 100;
    result.kg += (takeDustDg + takeSeedDg) / 100;
  }
  // Items, nearest first, while they fit the buffer.
  for (const { item } of near) {
    if (!itemOpen(ctx, item) || !inRegion(region, item.x, item.z)) continue;
    if (!sweepTakes(tool, item)) continue;
    const kg = itemKg(item);
    if (kg > free + EPS_KG) continue;
    if (vacuum && item.kind === KIND.can && ctx.chance(CLOG_CHANCE)) {
      data.clogged = true;
      break;
    }
    ctx.world.remove(item.id);
    addItemToLoad(data.buf, item);
    free -= kg;
    result.kg += kg;
    result.items.push(item.id);
  }
  return result;
}

/** Which items a broom or the vacuum takes (C.3). */
function sweepTakes(tool: number, item: Item): boolean {
  const stuck = (item.flags & FLAG_STUCK) !== 0;
  const buried = (item.flags & FLAG_BURIED) !== 0;
  switch (item.kind) {
    case KIND.can: return tool === 3 || ((tool === 1 || tool === 2 || tool === VACUUM) && !stuck);
    case KIND.iron: return tool === 3;
    case KIND.copper: return !buried && (tool === 3 || (tool === VACUUM && item.massDg <= VACUUM_COPPER_MAX_DG));
    case KIND.cabbage: return tool <= 3;
    default: return false;
  }
}

/** The leaf blower, LMB: cells → a pile 7 m ahead, loose cans scattered there; iron and copper stay. */
function blow(ctx: UseContext, ox: number, oz: number, rotY: number): UseResult {
  const spec = toolOf(BLOWER);
  const region = coneRegion(ox, oz, rotY, spec.reach);
  checkStench(ctx, region);
  const dir = dirOf(rotY);
  const tx = ox + dir.x * spec.reach;
  const tz = oz + dir.z * spec.reach;
  let dust = 0;
  let seed = 0;
  const grid = ctx.world.grid;
  const ext = regionExtent(region);
  for (let gz = cellCoord(oz - ext); gz <= cellCoord(oz + ext); gz++) {
    for (let gx = cellCoord(ox - ext); gx <= cellCoord(ox + ext); gx++) {
      const index = liveIndex(grid, gx, gz);
      const hex = index < 0 ? -1 : grid.cellHex[index] ?? -1;
      if (hex < 0 || !ctx.unlocked.has(hexDistrict(hex)) || !inRegion(region, cellCentre(gx), cellCentre(gz))) continue;
      const byte = ctx.world.cells[index] ?? 0;
      if (byte === 0) continue;
      const district = hexDistrict(hex);
      const d = byte >> 4;
      const s = byte & 15;
      const nd = reducedLevel(d, BLOWER_CELL_F, 1);
      const ns = reducedLevel(s, BLOWER_CELL_F, 1);
      dust += dustKg(d, district) - dustKg(nd, district);
      seed += seedKg(s, district) - seedKg(ns, district);
      ctx.world.setCell(index, (nd << 4) | ns);
    }
  }
  if (dust + seed > EPS_KG) ctx.world.deposit(tx, tz, dust, seed, dir.x, dir.z, BLOWER_PILE_MERGE_M, ox, oz, ctx.unlocked);
  for (const { item } of ctx.world.itemsNear(ox, oz, ext)) {
    if (item.kind !== KIND.can || (item.flags & FLAG_STUCK) !== 0 || !itemOpen(ctx, item) || !inRegion(region, item.x, item.z)) continue;
    const { dx, dz } = scatter(item.id, BLOWER_SCATTER_M);
    const to = ctx.world.openToward(tx + dx, tz + dz, ox, oz);
    if (to && ctx.unlocked.has(hexDistrict(hexAt(to.x, to.z)?.id ?? 0))) ctx.world.update(item, { x: to.x, z: to.z });
  }
  return { kg: 0, items: [], pushed: dust + seed > EPS_KG };
}

/** The magnetic rake, LMB: iron and copper (buried too) in the arc, plus iron within 2.5 m of the arc midpoint. */
function rake(ctx: UseContext, ox: number, oz: number, rotY: number): UseResult {
  const data = ctx.data;
  const spec = toolOf(RAKE);
  const region = arcRegion(ox, oz, rotY, spec.reach, headWidth(data, RAKE));
  checkStench(ctx, region);
  const dir = dirOf(rotY);
  const mx = ox + dir.x * spec.reach;
  const mz = oz + dir.z * spec.reach;
  const result: UseResult = { kg: 0, items: [], pushed: false };
  let free = Math.max(0, bufFree(data));
  for (const { item } of ctx.world.itemsNear(ox, oz, Math.max(regionExtent(region), spec.reach + MAGNET_RADIUS_M))) {
    if (!itemOpen(ctx, item) || (item.kind !== KIND.iron && item.kind !== KIND.copper)) continue;
    const inArc = inRegion(region, item.x, item.z);
    const magnet = item.kind === KIND.iron && Math.hypot(item.x - mx, item.z - mz) <= MAGNET_RADIUS_M;
    if (!inArc && !magnet) continue;
    const kg = itemKg(item);
    if (kg > free + EPS_KG) continue;
    ctx.world.remove(item.id);
    addItemToLoad(data.buf, item);
    free -= kg;
    result.kg += kg;
    result.items.push(item.id);
  }
  return result;
}

/** The hand, LMB: the nearest item in the 80° arc within 2 m, straight into the backpack. */
function hand(ctx: UseContext, ox: number, oz: number, rotY: number): UseResult {
  const data = ctx.data;
  const region = sectorRegion(ox, oz, rotY, toolOf(HAND).reach);
  checkStench(ctx, region);
  let tooBig = false;
  for (const { item } of ctx.world.itemsNear(ox, oz, region.reach)) {
    if (!itemOpen(ctx, item) || !inRegion(region, item.x, item.z)) continue;
    const pickable = item.kind === KIND.can || item.kind === KIND.iron || (item.kind === KIND.copper && (item.flags & FLAG_BURIED) === 0)
      || jackpotOf(item.kind) !== undefined;
    if (!pickable) continue;
    const kg = itemKg(item);
    if (kg > packFreeKg(data) + EPS_KG || itemL(item) > packFreeL(data) + EPS_KG) {
      tooBig = true;
      continue;
    }
    ctx.world.remove(item.id);
    addItemToLoad(data.pack, item);
    return { kg, items: [item.id], pushed: false };
  }
  if (tooBig) throw refuse('tooHeavy');
  return { kg: 0, items: [], pushed: false };
}

/** RMB: scoop (brooms), turbo (blower), reverse blow (vacuum), crush (hand). */
function altUse(ctx: UseContext, tool: number, ox: number, oz: number, rotY: number): UseResult {
  const data = ctx.data;
  if (tool === VACUUM) {
    data.clogged = false;
    return { kg: 0, items: [], pushed: false };
  }
  if (tool === BLOWER) {
    const region = coneRegion(ox, oz, rotY, TURBO_REACH_M, TURBO_HALF_ANGLE, 0);
    for (const { item } of ctx.world.itemsNear(ox, oz, TURBO_REACH_M)) {
      if (item.kind !== KIND.can || (item.flags & FLAG_STUCK) === 0 || !itemOpen(ctx, item) || !inRegion(region, item.x, item.z)) continue;
      ctx.world.update(item, { flags: item.flags & ~FLAG_STUCK });
    }
    return { kg: 0, items: [], pushed: false };
  }
  if (tool === HAND) {
    const cans = Math.min(CRUSH_MAX, data.pack.cans);
    if (cans === 0) throw refuse('emptyPack');
    const n = Math.min(cans, Math.floor(data.stamina / CRUSH_STAMINA_PER_CAN));
    if (n === 0) throw refuse('exhausted');
    data.pack.cans -= n;
    data.pack.crushed += n;
    data.stamina = Math.max(0, data.stamina - n * CRUSH_STAMINA_PER_CAN);
    return { kg: 0, items: [], pushed: false };
  }
  // Broom scoop: tip the buffer, then (tools 1–3) take the nearest pile within reach + 0.5 m into the pack.
  const tipped = tipBuffer(data);
  const bufferLeft = !isEmptyLoad(data.buf);
  const pile = tool >= 1
    ? ctx.world.itemsNear(ox, oz, toolOf(tool).reach + SCOOP_EXTRA_M).find(({ item }) => item.kind === KIND.pile && itemOpen(ctx, item))?.item
    : undefined;
  let kg = 0;
  const items: number[] = [];
  if (pile) {
    const rest = emptyLoad();
    addItemToLoad(rest, pile);
    kg = moveLoad(rest, data.pack, packFreeKg(data), packFreeL(data));
    const leftDg = Math.round((rest.dustG + rest.seedG) / 10);
    if (kg > EPS_KG && leftDg <= 0) {
      ctx.world.remove(pile.id);
      items.push(pile.id);
    } else if (kg > EPS_KG) {
      ctx.world.update(pile, { massDg: leftDg, seedDg: Math.min(leftDg, Math.round(rest.seedG / 10)) });
    }
  }
  if (kg <= EPS_KG && tipped <= EPS_KG && (bufferLeft || pile)) throw refuse('packFull');
  return { kg: kg > EPS_KG ? kg : 0, items, pushed: false };
}

/** Kick (37) motion constants. */
export const KICK_GAIN = 1.8;
export const KICK_MAX_SPEED = 6;
export const KICK_AIR_S = 0.286;
export const KICK_ROLL_DECEL = 3;
export const KICK_STEP_M = 0.25;
export const KICK_RADIUS_M = 0.05;

/** Total kick distance for a launch speed |u|: |u|·0.286 + |u|²/6. */
export const kickDistance = (speed: number): number => speed * KICK_AIR_S + (speed * speed) / (2 * KICK_ROLL_DECEL);

/**
 * Moves a kicked can along u = 1.8·v (capped at 6 m/s) in 0.25 m steps; it stops at the last point
 * that is inside the grid, unlocked and not blocked (sweepCircle r 0.05). Returns the kick row.
 */
export function kickCan(world: DebrisWorld, item: Item, vx: number, vz: number, unlocked: ReadonlySet<number>): KickRow {
  const v = Math.hypot(vx, vz);
  const fromX = Math.round(item.x * 100) + 0;
  const fromZ = Math.round(item.z * 100) + 0;
  if (v <= 1e-9) return [item.id, fromX, fromZ, fromX, fromZ];
  const speed = Math.min(KICK_MAX_SPEED, KICK_GAIN * v);
  const ux = vx / v;
  const uz = vz / v;
  const total = kickDistance(speed);
  let x = item.x;
  let z = item.z;
  for (let travelled = 0; travelled < total - 1e-9;) {
    const step = Math.min(KICK_STEP_M, total - travelled);
    const nx = x + ux * step;
    const nz = z + uz * step;
    const hex = hexAt(nx, nz);
    if (!hex || !unlocked.has(hex.district)) break;
    if (sweepCircle(world.grid.colliders, x, z, nx, nz, KICK_RADIUS_M).hit) break;
    x = nx;
    z = nz;
    travelled += step;
  }
  world.update(item, { x, z });
  return [item.id, fromX, fromZ, Math.round(x * 100) + 0, Math.round(z * 100) + 0];
}
