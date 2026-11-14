// Logistics persistence (plan D.6): `miskolc_world_structures` rows and the state_json v4 `logistics`
// blob. Loading is defensive: every row is parsed on its own and placements are re-checked.
import { isPlainObject } from '../../../core/validation/isPlainObject.ts';
import { emptyLoad } from '../debris/personal.ts';
import type { Load } from '../debris/personal.ts';
import { jackpotOf } from '../debris/tables.ts';
import type { WorldStructureRecord } from '../SweepersRepository.ts';
import type { LogisticsWorld } from './LogisticsWorld.ts';
import { checkPlacement, exceededCap } from './placement.ts';
import type { PlacementWorld } from './placement.ts';
import { BAG_TIERS, LANDMARK_HOPPER, rotYOf, STRUCT_TYPES, structSpec, TINTS, TYPE } from './tables.ts';

/** `[dustG, seedG, cans, crushed, ironG, copperG, jackpots[]]`. */
export type LoadC = [number, number, number, number, number, number, number[]];

const MAX_ROWS = 2_000;
const MAX_GRAMS = 1e9;
const isUint = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 1e7;

export function encodeLoad(load: Load): LoadC {
  return [Math.round(load.dustG), Math.round(load.seedG), load.cans, load.crushed, Math.round(load.ironG), Math.round(load.copperG), [...load.jackpots]];
}

/** A stored LoadC, or null when invalid. */
export function parseLoadC(value: unknown): Load | null {
  if (!Array.isArray(value) || value.length !== 7) return null;
  const [dustG, seedG, cans, crushed, ironG, copperG, jackpots] = value;
  if (![dustG, seedG, cans, crushed, ironG, copperG].every((v) => isUint(v, MAX_GRAMS))) return null;
  if (!Array.isArray(jackpots) || jackpots.length > 100 || !jackpots.every((k) => isUint(k, 255) && jackpotOf(k) !== undefined)) return null;
  const load = emptyLoad();
  Object.assign(load, { dustG, seedG, cans, crushed, ironG, copperG, jackpots: jackpots.map(Number) });
  return load;
}

/** The structure rows of a room (`id = '<roomId>:<n>'`, `type` = the D.1 key, `y` = base). */
export function structureRecords(world: LogisticsWorld, roomId: string): WorldStructureRecord[] {
  return [...world.structures.values()].sort((a, b) => a.id - b.id).map((st) => ({
    id: `${roomId}:${st.id}`,
    roomId,
    type: structSpec(st.type).key,
    x: st.x,
    y: st.base,
    z: st.z,
    rotY: rotYOf(st.rot),
    config: { v: 1, rot: st.rot, lvl: st.lvl, jam: (st.flags & 1) !== 0 }
  }));
}

/** rot from a stored rotY (fallback when `config.rot` is missing). */
function rotFromRotY(rotY: number): number | null {
  for (let rot = 0; rot < 4; rot++) {
    const diff = Math.abs(Math.atan2(Math.sin(rotY - rotYOf(rot)), Math.cos(rotY - rotYOf(rot))));
    if (diff < 1e-3) return rot;
  }
  return null;
}

interface ParsedStructure {
  n: number;
  type: number;
  x: number;
  z: number;
  rot: number;
  lvl: number;
  jam: boolean;
}

function parseStructure(record: WorldStructureRecord, roomId: string): ParsedStructure | null {
  const prefix = `${roomId}:`;
  if (!record.id.startsWith(prefix)) return null;
  const suffix = record.id.slice(prefix.length);
  if (!/^\d{1,5}$/.test(suffix)) return null;
  const n = Number(suffix);
  if (n < 1 || n > 0xffff) return null;
  const type = STRUCT_TYPES.findIndex((t) => t.key === record.type);
  if (type < 0) return null;
  if (![record.x, record.z, record.rotY].every((v) => Number.isFinite(v))) return null;
  if (!Number.isInteger(record.x * 2) || !Number.isInteger(record.z * 2) || Math.abs(record.x) > 256 || Math.abs(record.z) > 256) return null;
  const config = record.config;
  const rot = config['rot'] === undefined ? rotFromRotY(record.rotY) : isUint(config['rot'], 3) ? config['rot'] : null;
  if (rot === null) return null;
  const spec = structSpec(type);
  const lvl = config['lvl'] ?? 0;
  if (!isUint(lvl, 2) || lvl < spec.lvlMin || lvl > spec.lvlMax) return null;
  return { n, type, x: record.x, z: record.z, rot, lvl, jam: config['jam'] === true };
}

/**
 * Loads the structure rows into `world`: parsed one by one, then D.3 rules 3, 4, 6 (without players
 * and bags) and 7 re-run in id order with the caps applied in id order. Base y is recomputed.
 * Returns the warnings of the dropped rows.
 */
export function loadStructures(world: LogisticsWorld, placement: Omit<PlacementWorld, 'structures' | 'groundBags' | 'players'>, records: readonly WorldStructureRecord[], roomId: string): string[] {
  const warnings: string[] = [];
  const parsed: ParsedStructure[] = [];
  const seen = new Set<number>();
  for (const record of records.slice(0, MAX_ROWS)) {
    const row = parseStructure(record, roomId);
    if (!row || seen.has(row.n)) {
      warnings.push(`invalid structure row ${record.id}`);
      continue;
    }
    seen.add(row.n);
    parsed.push(row);
  }
  parsed.sort((a, b) => a.n - b.n);
  for (const row of parsed) {
    const spec = { type: row.type, x: row.x, z: row.z, rot: row.rot, lvl: row.lvl };
    const what = exceededCap([...world.structures.values()], row.type);
    if (what !== null) {
      warnings.push(`structure ${row.n} over the cap (${what})`);
      continue;
    }
    try {
      const base = checkPlacement({ ...placement, structures: [...world.structures.values()], groundBags: [], players: [] }, spec, null, false);
      const jammable = row.type === TYPE.splitter || row.type === TYPE.merger || row.type === TYPE.packager;
      world.add(spec, base, row.n, row.jam && jammable ? 1 : 0);
    } catch (err) {
      warnings.push(`structure ${row.n} rejected: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  world.rebuildColliders();
  return warnings;
}

/** The v4 `logistics` blob; a carried bag is written at its carrier's feet, a crane-held one at its job target. */
export function encodeLogistics(world: LogisticsWorld, carrierFeet: (playerId: number) => { x: number; y: number; z: number } | null): Record<string, unknown> {
  const cm = (m: number): number => Math.round(m * 100) + 0;
  const bags: unknown[] = [];
  for (const bag of [...world.bags.values()].sort((a, b) => a.id - b.id)) {
    if (bag.st === 3) continue;
    const at = bag.st === 1 ? carrierFeet(bag.carrier) ?? { x: bag.x, y: bag.y, z: bag.z } : { x: bag.x, y: bag.y, z: bag.z };
    bags.push([bag.id, bag.tier, bag.tint, cm(at.x), cm(at.y), cm(at.z), bag.rot8, encodeLoad(bag.load)]);
  }
  const cargo = [...world.cargo.values()].sort((a, b) => a.id - b.id).map((c) => [
    c.id, c.kind, c.sub, c.tint, c.node, Math.round(c.s * 1000), c.route, Math.round(c.waitMs), encodeLoad(c.bag ? c.bag.load : c.load)
  ]);
  const hoppers: unknown[] = [];
  const packagers: unknown[] = [];
  for (const id of [...world.nodes.keys()].sort((a, b) => a - b)) {
    const buffer = world.bufferOf(id);
    if (!buffer) continue;
    const timers = world.timersOf(id);
    if (world.nodes.get(id)?.type === TYPE.packager) packagers.push([id, encodeLoad(buffer), Math.round(timers.timer), Math.round(timers.idleMs)]);
    else hoppers.push([id, encodeLoad(buffer)]);
  }
  const job = world.craneJob;
  const hook = job ? { x: job.tx / 100, z: job.tz / 100 } : world.hook;
  return { v: 1, bags, cargo, hoppers, packagers, crane: { hook: [cm(hook.x), cm(hook.z)] } };
}

/** Restores the blob into `world` (structures already loaded). Invalid rows are dropped; returns warnings. */
export function restoreLogistics(world: LogisticsWorld, value: unknown): string[] {
  const warnings: string[] = [];
  if (!isPlainObject(value) || value['v'] !== 1) return value === null || value === undefined ? warnings : ['invalid logistics blob'];
  const list = (key: string): unknown[] => {
    const raw = value[key];
    return Array.isArray(raw) ? raw.slice(0, MAX_ROWS) : [];
  };
  // A valid buffer whose node did not survive the re-check goes into the landmark hopper: nothing is lost.
  const orphan = (load: Load, what: string): void => {
    world.restoreBuffer(LANDMARK_HOPPER, load);
    warnings.push(`${what} buffer moved to the hopper`);
  };
  for (const row of list('hoppers')) {
    const load = Array.isArray(row) && row.length === 2 && isUint(row[0], 0xffff) ? parseLoadC(row[1]) : null;
    if (!Array.isArray(row) || !load) warnings.push('hopper row dropped');
    else if (world.nodes.get(Number(row[0]))?.type !== TYPE.hopper) orphan(load, 'hopper');
    else world.restoreBuffer(Number(row[0]), load);
  }
  for (const row of list('packagers')) {
    const ok = Array.isArray(row) && row.length === 4 && isUint(row[0], 0xffff) && isUint(row[2], 1e7) && isUint(row[3], 1e7);
    const load = ok ? parseLoadC(row[1]) : null;
    if (!ok || !load) warnings.push('packager row dropped');
    else if (world.nodes.get(Number(row[0]))?.type !== TYPE.packager) orphan(load, 'packager');
    else world.restoreBuffer(Number(row[0]), load, Number(row[2]), Number(row[3]));
  }
  for (const row of list('cargo')) {
    if (!Array.isArray(row) || row.length !== 9) {
      warnings.push('cargo row dropped');
      continue;
    }
    const [id, kind, sub, tint, node, sMm, route, waitMs, loadC] = row;
    const load = parseLoadC(loadC);
    const subOk = kind === 0 ? isUint(sub, 2) : isUint(sub, BAG_TIERS.length - 1);
    if (!isUint(id, 0xffff) || id === 0 || (kind !== 0 && kind !== 1) || !subOk || !isUint(tint, TINTS.length - 1) || !isUint(node, 0xffff)
      || !isInt(sMm) || !isUint(route, 2) || !isUint(waitMs, 1e9) || !load) {
      warnings.push('cargo row dropped');
      continue;
    }
    if (!world.restoreCargo({ id, kind, sub, tint, node, s: sMm / 1000, route, waitMs, load })) warnings.push(`duplicate id ${id} dropped`);
  }
  const bagRows = list('bags').filter((row): row is unknown[] => Array.isArray(row) && row.length === 8);
  if (bagRows.length !== list('bags').length) warnings.push('bag row dropped');
  // Lowest first, so stacks rebuild bottom-up.
  bagRows.sort((a, b) => (isInt(a[4]) ? a[4] : 0) - (isInt(b[4]) ? b[4] : 0));
  for (const [id, tier, tint, xCm, yCm, zCm, rot8, loadC] of bagRows) {
    const load = parseLoadC(loadC);
    if (!isUint(id, 0xffff) || id === 0 || !isUint(tier, BAG_TIERS.length - 1) || !isUint(tint, TINTS.length - 1) || !isInt(xCm) || !isInt(yCm) || !isInt(zCm)
      || Math.abs(xCm) > 25_600 || Math.abs(zCm) > 25_600 || !isUint(rot8, 255) || !load) {
      warnings.push('bag row dropped');
      continue;
    }
    if (!world.restoreGroundBag({ id, tier, tint, x: xCm / 100, z: zCm / 100, rot8, load })) warnings.push(`duplicate id ${id} dropped`);
  }
  const crane = value['crane'];
  const hook = isPlainObject(crane) ? crane['hook'] : null;
  if (Array.isArray(hook) && hook.length === 2 && isInt(hook[0]) && isInt(hook[1])) world.setHook(hook[0] / 100, hook[1] / 100);
  world.clearPending();
  return warnings;
}
