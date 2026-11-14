// The room economy (plan E.2/E.5/E.6): power grid, blueprints, the inspector's countdown and
// district kg, the coalesced `miskolc:economy` update and the persisted `state_json.economy` key.
// Money itself stays on the room (`teamFunds`, `lifetimeEarned`) and the players (`cash`).
import { isPlainObject } from '../../../core/validation/isPlainObject.ts';
import type { CoinRow } from '../logistics/LogisticsWorld.ts';
import { lmeEpoch, lmeRow } from './lme.ts';
import type { LmeRow } from './lme.ts';
import { PowerGrid } from './PowerGrid.ts';
import type { GridRow } from './PowerGrid.ts';
import type { CityLayout } from '../city/layoutTypes.ts';
import { CRANE } from '../logistics/tables.ts';
import { effectiveQuota, FINE_FT, INSPECT_MS, PAD_M, POWER, QUOTA_BASE_KG } from './tables.ts';

/** The scale containing (x, z): 0 the weighbridge (rotated rect), 1 the crane pad (3 × 3), −1 none. */
export function scaleAt(layout: CityLayout, x: number, z: number): number {
  const wb = layout.landmarks.weighbridge;
  const dx = x - wb.x;
  const dz = z - wb.z;
  const lx = dx * Math.cos(wb.rotY) - dz * Math.sin(wb.rotY);
  const lz = dx * Math.sin(wb.rotY) + dz * Math.cos(wb.rotY);
  if (Math.abs(lx) <= wb.w / 2 && Math.abs(lz) <= wb.d / 2) return 0;
  const pad = CRANE.targets[0] ?? { x: 0, z: 0 };
  return Math.abs(x - pad.x) <= PAD_M / 2 && Math.abs(z - pad.z) <= PAD_M / 2 ? 1 : -1;
}

/** `InspRow` (E.3). */
export interface InspRow {
  /** Server ms of the next visit (valid while someone is connected). */
  at: number;
  kg: number[];
  /** Effective quotas for the current connected count. */
  quota: number[];
}

/** `init_state.economy`. */
export interface EconomyInit {
  funds: number;
  bp: number;
  grid: GridRow;
  lme: LmeRow;
  insp: InspRow;
}

/** `miskolc:economy` (room-wide, coalesced, only when non-empty). */
export interface EconomyUpdate {
  t: number;
  funds?: number;
  life?: number;
  bp?: number;
  grid?: GridRow;
  lme?: LmeRow;
  insp?: InspRow;
  coins?: CoinRow[];
}

/** `miskolc:inspection`: `[district, quotaKg, kg, fineFt]` per checked district. */
export interface InspectionPayload {
  results: Array<[number, number, number, number]>;
  fine: number;
  funds: number;
}

export const ECONOMY_VERSION = 1;
const DISTRICTS = 6;
const MAX_BP = 0b1111;
const MAX_KG = 1e9;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clampOr = (v: unknown, min: number, max: number, fallback: number): number => (isNum(v) ? Math.min(max, Math.max(min, v)) : fallback);

export class Economy {
  readonly grid: PowerGrid;
  /** Bought blueprints, bit = machine type − 14. */
  bp: number;
  /** Loaded room time with someone connected until the next inspection, ms. */
  inspInMs: number;
  /** Kg collected per district since the last inspection. */
  readonly kg: number[];
  #coins: CoinRow[] = [];
  #sentFunds: number | null = null;
  #sentLife: number | null = null;
  #sentBp: number | null = null;
  #sentGrid = '';
  #sentInsp = '';
  #sentInspAt = 0;
  #sentEpoch = -1;
  #rowsSentAt = -Infinity;

  constructor(battWh: number, dieselL: number, genOn: boolean, bp: number, inspInMs: number, kg: number[]) {
    this.grid = new PowerGrid(battWh, dieselL, genOn);
    this.bp = bp;
    this.inspInMs = inspInMs;
    this.kg = kg;
  }

  /** The stored `economy` key, each field parsed on its own (defaults: full battery, 20 L, off, none, 30 min, zeros). */
  static restore(value: unknown): Economy {
    const v = isPlainObject(value) ? value : {};
    const kgRaw = Array.isArray(v['kg']) ? v['kg'] : [];
    const bp = v['bp'];
    return new Economy(
      clampOr(v['battWh'], 0, POWER.batteryWh, POWER.batteryWh),
      clampOr(v['dieselL'], 0, POWER.tankL, POWER.startDieselL),
      v['genOn'] === true,
      typeof bp === 'number' && Number.isInteger(bp) && bp >= 0 && bp <= MAX_BP ? bp : 0,
      clampOr(v['inspInMs'], 0, INSPECT_MS, INSPECT_MS),
      Array.from({ length: DISTRICTS }, (_, d) => clampOr(kgRaw[d], 0, MAX_KG, 0))
    );
  }

  record(): Record<string, unknown> {
    const g = this.grid;
    return { v: ECONOMY_VERSION, battWh: g.battWh, dieselL: g.dieselL, genOn: g.genOn, bp: this.bp, inspInMs: this.inspInMs, kg: [...this.kg] };
  }

  /** Credits kg collected in `district` towards its quota (86). */
  credit(district: number, kg: number): void {
    if (district >= 0 && district < DISTRICTS && kg > 0) this.kg[district] = (this.kg[district] ?? 0) + kg;
  }

  addCoins(coins: readonly CoinRow[]): void {
    this.#coins.push(...coins);
  }

  /**
   * Counts the inspector down while someone is connected; at 0 fines every unlocked district (with a
   * quota) below its effective quota. Returns the visit's results and total fine, or null.
   */
  tickInspector(dtMs: number, connected: number, unlocked: ReadonlySet<number>): { results: Array<[number, number, number, number]>; fine: number } | null {
    if (connected < 1) return null;
    this.inspInMs -= dtMs;
    if (this.inspInMs > 0) return null;
    const results: Array<[number, number, number, number]> = [];
    let fine = 0;
    for (let d = 0; d < DISTRICTS; d++) {
      const quota = effectiveQuota(d, connected);
      if (!unlocked.has(d) || (QUOTA_BASE_KG[d] ?? 0) <= 0) continue;
      const kg = Math.round(this.kg[d] ?? 0);
      const f = (this.kg[d] ?? 0) < quota ? FINE_FT : 0;
      fine += f;
      results.push([d, quota, kg, f]);
    }
    this.kg.fill(0);
    this.inspInMs = INSPECT_MS;
    return { results, fine };
  }

  inspRow(now: number, connected: number): InspRow {
    return {
      at: now + Math.max(0, Math.round(this.inspInMs)),
      kg: this.kg.map((k) => Math.round(k)),
      quota: QUOTA_BASE_KG.map((_, d) => effectiveQuota(d, connected))
    };
  }

  initPayload(funds: number, now: number, connected: number): EconomyInit {
    return { funds, bp: this.bp, grid: this.grid.row(), lme: lmeRow(lmeEpoch(now)), insp: this.inspRow(now, connected) };
  }

  /**
   * The coalesced update of this tick, or null: `funds` / `life` / `bp` on change, `grid` and `insp`
   * at most once a second and only on change (`insp.at` drifting > 1 s counts), `lme` on a new epoch, coins.
   */
  takeUpdate(now: number, funds: number, life: number, connected: number): EconomyUpdate | null {
    const update: EconomyUpdate = { t: now };
    if (funds !== this.#sentFunds) update.funds = this.#sentFunds = funds;
    if (life !== this.#sentLife) update.life = this.#sentLife = life;
    if (this.bp !== this.#sentBp) update.bp = this.#sentBp = this.bp;
    const epoch = lmeEpoch(now);
    if (epoch !== this.#sentEpoch) {
      this.#sentEpoch = epoch;
      update.lme = lmeRow(epoch);
    }
    if (now - this.#rowsSentAt >= POWER.stepMs) {
      const grid = this.grid.row();
      const gridKey = JSON.stringify(grid);
      const insp = this.inspRow(now, connected);
      const inspKey = JSON.stringify([insp.kg, insp.quota]);
      if (gridKey !== this.#sentGrid) {
        update.grid = grid;
        this.#sentGrid = gridKey;
        this.#rowsSentAt = now;
      }
      if (inspKey !== this.#sentInsp || Math.abs(insp.at - this.#sentInspAt) > POWER.stepMs) {
        update.insp = insp;
        this.#sentInsp = inspKey;
        this.#sentInspAt = insp.at;
        this.#rowsSentAt = now;
      }
    }
    if (this.#coins.length > 0) {
      update.coins = this.#coins;
      this.#coins = [];
    }
    return Object.keys(update).length > 1 ? update : null;
  }
}
