// `miskolc:buy_upgrade` rules (plan C.4): location, level, ownership, cash. Pure over the personal state.
import type { CityLayout } from '../city/layoutTypes.ts';
import { notEnoughCash, SWEEPERS_ERRORS, SweepersError } from '../SweepersError.ts';
import { ownsTool } from './personal.ts';
import type { PersonalData } from './personal.ts';
import {
  FUEL_COST, FUEL_TANK_ML, GLOVES_COST, HARD_COST, PACK_COST, REFRESHMENTS, REPAIR_SHARE, STAMINA_MAX, toolOf, WIDTH_COST
} from './tables.ts';

export const BUY_ITEMS = Object.freeze(['tool', 'width', 'pack', 'hard', 'gloves', 'repair', 'fuel', 'beer', 'kofola', 'zsiros'] as const);
export type BuyItem = (typeof BUY_ITEMS)[number];

/** A parsed `miskolc:buy_upgrade`. */
export interface BuyRequest {
  channelId: string;
  item: BuyItem;
  /** Tool id: 1..6 for `tool`, 1..3 for `repair`. */
  tier?: number;
  /** Target level for width / pack / hard. */
  level?: number;
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
  }
}

/** Repair price of tool 1..3: 10 % of its cost. */
export const repairPrice = (tier: number): number => Math.round(toolOf(tier).cost * REPAIR_SHARE);

function pay(data: PersonalData, price: number): void {
  if (!Number.isFinite(price) || data.cash < price) throw new SweepersError(notEnoughCash(price), { reason: 'notEnoughCash', price });
  data.cash -= price;
}
