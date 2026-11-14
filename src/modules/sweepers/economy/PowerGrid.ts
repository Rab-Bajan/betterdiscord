// The yard power grid (82–84): solar by the day clock, a diesel generator, a battery, and the belt and
// machine demand. Stepped once per second of loaded room time; `pf` is the network speed factor.
import { DAYLIGHT_MS } from '../dayClock.ts';
import { POWER } from './tables.ts';

/** `GridRow` (E.3): ints except `pf`; `dieselDl` in 0.1 L. */
export interface GridRow {
  st: 0 | 1 | 2;
  pf: number;
  solarW: number;
  genW: number;
  demandW: number;
  battWh: number;
  dieselDl: number;
  genOn: boolean;
}

/** Solar output at `timeMs` of the day (0 = sunrise): a half-sine over the daylight. */
export const solarW = (timeMs: number): number =>
  (timeMs < DAYLIGHT_MS ? POWER.solarPeakW * Math.max(0, Math.sin((Math.PI * timeMs) / DAYLIGHT_MS)) : 0);

const HOUR_MS = 3_600_000;

export class PowerGrid {
  battWh: number;
  dieselL: number;
  genOn: boolean;
  st: 0 | 1 | 2 = 0;
  pf = 1;
  solarW = 0;
  genW = 0;
  demandW = 0;
  #acc = 0;

  constructor(battWh: number, dieselL: number, genOn: boolean) {
    this.battWh = battWh;
    this.dieselL = dieselL;
    this.genOn = genOn && dieselL > 0;
  }

  /** Adds `dtMs` of room time; runs one step per whole second (no catch-up beyond one). True when a step ran. */
  tick(dtMs: number, timeOfDayMs: number, demandW: () => number): boolean {
    this.#acc = Math.min(POWER.stepMs, this.#acc + dtMs);
    if (this.#acc < POWER.stepMs) return false;
    this.#acc -= POWER.stepMs;
    this.step(POWER.stepMs, timeOfDayMs, demandW());
    return true;
  }

  /** One step of `dtMs` with the given demand (E.2 states, battery and diesel). */
  step(dtMs: number, timeOfDayMs: number, demandW: number): void {
    this.solarW = solarW(timeOfDayMs);
    this.genW = this.genOn && this.dieselL > 0 ? POWER.generatorW : 0;
    this.demandW = demandW;
    const supply = this.solarW + this.genW;
    const capacity = supply + (this.battWh > 0 ? POWER.batteryMaxW : 0);
    const h = dtMs / HOUR_MS;
    if (demandW === 0 || demandW <= capacity) {
      this.st = 0;
      this.pf = 1;
      this.battWh = Math.min(POWER.batteryWh, Math.max(0, this.battWh + (supply - demandW) * h));
    } else if (capacity === 0) {
      this.st = 2;
      this.pf = 0;
    } else {
      this.st = 1;
      this.pf = POWER.brownoutPf;
      this.battWh = Math.max(0, this.battWh - POWER.batteryMaxW * h);
    }
    if (this.genOn) {
      this.dieselL = Math.max(0, this.dieselL - POWER.dieselLPerHour * h);
      if (this.dieselL <= 0) this.genOn = false;
    }
  }

  row(): GridRow {
    return {
      st: this.st, pf: this.pf, solarW: Math.round(this.solarW), genW: Math.round(this.genW), demandW: Math.round(this.demandW),
      battWh: Math.round(this.battWh), dieselDl: Math.round(this.dieselL * 10), genOn: this.genOn
    };
  }
}
