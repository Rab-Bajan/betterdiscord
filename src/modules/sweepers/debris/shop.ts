// `miskolc:buy_upgrade` rules (plan C.4): location, level, ownership, cash. Pure over the personal state.
import type { CityLayout } from '../city/layoutTypes.ts';
import { notEnoughCash, notEnoughTeamFunds, SWEEPERS_ERRORS, SweepersError } from '../SweepersError.ts';
import { DIESEL_CAN_FT, DIESEL_FULL_L, GREASE_GUN_FT, licensePrice } from '../economy/tables.ts';
import { ownsTool } from './personal.ts';
import type { PersonalData } from './personal.ts';
import { bagTier, FIRST_MACHINE, machineOf, structSpec } from '../logistics/tables.ts';
import {
  FUEL_COST, FUEL_TANK_ML, GLOVES_COST, HARD_COST, PACK_COST, REFRESHMENTS, REPAIR_SHARE, STAMINA_MAX, toolOf, WIDTH_COST
} from './tables.ts';

export const BUY_ITEMS = Object.freeze([
  'tool', 'width', 'pack', 'hard', 'gloves', 'repair', 'fuel', 'beer', 'kofola', 'zsiros', 'bag', 'grease', 'blueprint', 'diesel', 'license'
] as const);
/** Bag quantities per purchase (Phase D). */
export const BAG_QTY = Object.freeze([1, 5, 10] as const);
export type BuyItem = (typeof BUY_ITEMS)[number];

/** A parsed `miskolc:buy_upgrade`. */
export interface BuyRequest {
  channelId: string;
  item: BuyItem;
  /** Tool id: 1..6 for `tool`, 1..3 for `repair`; bag tier 0..2 for `bag`; machine 0..3 for `blueprint`; district 1..5 for `license`. */
  tier?: number;
  /** Target level for width / pack / hard. */
  level?: number;
  /** Bags bought at once (`bag`: 1, 5 or 10). */
  qty?: number;
}

export const WORKBENCH_RADIUS_M = 8;
export const KIOSK_RADIUS_M = 4;

const refuse = (key: keyof typeof SWEEPERS_ERRORS): SweepersError => new SweepersError(SWEEPERS_ERRORS[key], { reason: key });

const isRefreshment = (item: BuyItem): item is 'beer' | 'kofola' | 'zsiros' => item === 'beer' || item === 'kofola' || item === 'zsiros';

/** True within 8 m of the MÉH office (the workbench). */
export function atWorkbench(layout: CityLayout, x: number, z: number): boolean {
  const office = layout.landmarks.office;
  return Math.hypot(x - office.x, z - office.z) <= WORKBENCH_RADIUS_M;
}

/** True within 4 m of a ticket kiosk, or at the workbench (the office büfé). */
export function atKiosk(layout: CityLayout, x: number, z: number): boolean {
  return atWorkbench(layout, x, z)
    || layout.buildings.some((b) => b.kind === 'ticket_kiosk' && Math.hypot(x - b.x, z - b.z) <= KIOSK_RADIUS_M);
}

/** Price and the change of a level-type upgrade. */
function levelUpgrade(current: number, costs: readonly number[], level: number | undefined): number {
  if (current >= costs.length) throw refuse('maxLevel');
  if (level !== current + 1) throw refuse('staleLevel');
  return costs[current] ?? Infinity;
}

/**
 * Applies a purchase to `data` at the buyer's position, or throws a refusal (location, then the item's
 * own rules, then cash). Returns the bought item's Hungarian name.
 */
export function buy(data: PersonalData, request: BuyRequest, layout: CityLayout, x: number, z: number, now: number): string {
  const { item } = request;
  if (isRefreshment(item)) {
    if (!atKiosk(layout, x, z)) throw refuse('notAtKiosk');
    const spec = REFRESHMENTS[item];
    pay(data, spec.cost);
    data.stamina = spec.stamina === null ? STAMINA_MAX : Math.min(STAMINA_MAX, data.stamina + spec.stamina);
    if (spec.fx !== null) data.fx[spec.fx] = Math.max(data.fx[spec.fx] ?? 0, now) + spec.fxMs;
    return spec.name;
  }
  if (!atWorkbench(layout, x, z)) throw refuse('notAtWorkbench');
  switch (item) {
    case 'tool': {
      const tier = request.tier ?? 0;
      if (ownsTool(data, tier)) throw refuse('alreadyOwned');
      pay(data, toolOf(tier).cost);
      data.owned |= 1 << tier;
      if (tier >= 1 && tier <= 3) data.dur[tier - 1] = 1000;
      return toolOf(tier).name;
    }
    case 'width':
      pay(data, levelUpgrade(data.widthLvl, WIDTH_COST, request.level));
      data.widthLvl += 1;
      return 'Szélesebb fej';
    case 'pack':
      pay(data, levelUpgrade(data.backpackTier, PACK_COST, request.level));
      data.backpackTier += 1;
      return 'Nagyobb hátizsák';
    case 'hard':
      pay(data, levelUpgrade(data.hardLvl, HARD_COST, request.level));
      data.hardLvl += 1;
      return 'Edzett sörte';
    case 'gloves':
      if (data.gloves) throw refuse('alreadyOwned');
      pay(data, GLOVES_COST);
      data.gloves = true;
      return 'Munkáskesztyű';
    case 'repair': {
      const tier = request.tier ?? 0;
      if (!ownsTool(data, tier)) throw refuse('notOwned');
      if ((data.dur[tier - 1] ?? 1000) >= 999.5) throw refuse('noRepairNeeded');
      pay(data, repairPrice(tier));
      data.dur[tier - 1] = 1000;
      return toolOf(tier).name;
    }
    case 'fuel':
      if (data.fuelMl >= FUEL_TANK_ML) throw refuse('tankFull');
      pay(data, FUEL_COST);
      data.fuelMl = FUEL_TANK_ML;
      return 'Benzin';
    case 'grease':
      if (data.greaseGun) throw refuse('alreadyOwned');
      pay(data, GREASE_GUN_FT);
      data.greaseGun = true;
      return 'Zsírzóprés';
    case 'blueprint':
    case 'diesel':
    case 'license':
      throw new Error(`team item ${item} is bought with teamPurchase`);
    case 'bag': {
      const tier = request.tier ?? 0;
      const qty = request.qty ?? 1;
      const spec = bagTier(tier);
      if ((data.bags[tier] ?? 0) + qty > spec.stockCap) throw refuse('bagStockFull');
      pay(data, spec.cost * qty);
      data.bags[tier] = (data.bags[tier] ?? 0) + qty;
      return spec.name;
    }
  }
}

/** Repair price of tool 1..3: 10 % of its cost. */
export const repairPrice = (tier: number): number => Math.round(toolOf(tier).cost * REPAIR_SHARE);

function pay(data: PersonalData, price: number): void {
  if (!Number.isFinite(price) || data.cash < price) throw new SweepersError(notEnoughCash(price), { reason: 'notEnoughCash', price });
  data.cash -= price;
}

/** What the team purse of a room offers a team purchase (E.2 shop). */
export interface TeamPurse {
  funds: number;
  bp: number;
  dieselL: number;
  unlocked: ReadonlySet<number>;
}

/** A checked team purchase; the room applies it (funds − price, then the effect). */
export type TeamPurchase =
  | { item: 'blueprint'; bit: number; price: number; name: string }
  | { item: 'diesel'; price: number; name: string }
  | { item: 'license'; district: number; price: number; name: string };

export const isTeamItem = (item: BuyItem): item is 'blueprint' | 'diesel' | 'license' => item === 'blueprint' || item === 'diesel' || item === 'license';

/** Checks a team-paid purchase (location, item rules, team funds) without changing anything. */
export function teamPurchase(request: BuyRequest, layout: CityLayout, x: number, z: number, purse: TeamPurse): TeamPurchase {
  if (!atWorkbench(layout, x, z)) throw refuse('notAtWorkbench');
  let purchase: TeamPurchase;
  if (request.item === 'blueprint') {
    const bit = request.tier ?? 0;
    if ((purse.bp & (1 << bit)) !== 0) throw refuse('alreadyOwned');
    const type = FIRST_MACHINE + bit;
    purchase = { item: 'blueprint', bit, price: machineOf(type)?.blueprintFt ?? Infinity, name: structSpec(type).name };
  } else if (request.item === 'diesel') {
    if (purse.dieselL >= DIESEL_FULL_L) throw refuse('tankFull');
    purchase = { item: 'diesel', price: DIESEL_CAN_FT, name: 'Gázolajkanna 20 L' };
  } else {
    const district = request.tier ?? 0;
    if (purse.unlocked.has(district)) throw refuse('alreadyUnlocked');
    purchase = { item: 'license', district, price: licensePrice(district), name: 'Kerületi engedély' };
  }
  if (!Number.isFinite(purchase.price) || purse.funds < purchase.price) throw notEnoughTeamFunds(purchase.price);
  return purchase;
}
