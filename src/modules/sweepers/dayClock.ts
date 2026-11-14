// In-game day/night clock (spec 28): 36 real minutes per day (24 daylight + 12 night). It runs
// with server time while the room is loaded and stands still while it is unloaded.

export const DAY_MS = 2_160_000;
export const DAYLIGHT_MS = 1_440_000;

/** Clock position: `timeMs` into day `day` (day 1 starts at sunrise, timeMs 0). */
export interface ClockReading {
  timeMs: number;
  day: number;
}

/** `init_state.clock`. */
export interface ClockState extends ClockReading {
  dayMs: number;
  daylightMs: number;
  serverTime: number;
}

/** `miskolc:clock`. */
export interface ClockSync extends ClockReading {
  serverTime: number;
}

export const FRESH_CLOCK: Readonly<ClockReading> = Object.freeze({ timeMs: 0, day: 1 });

export class DayClock {
  /** Game time (ms since the sunrise of day 1) at server time `#since`. */
  readonly #elapsedAtStart: number;
  readonly #since: number;

  constructor(reading: ClockReading, now: number) {
    this.#elapsedAtStart = (reading.day - 1) * DAY_MS + reading.timeMs;
    this.#since = now;
  }

  /** Game ms since the sunrise of day 1. */
  elapsed(now: number): number {
    return this.#elapsedAtStart + Math.max(0, now - this.#since);
  }

  read(now: number): ClockReading {
    const elapsed = this.elapsed(now);
    return { timeMs: elapsed % DAY_MS, day: Math.floor(elapsed / DAY_MS) + 1 };
  }

  sync(now: number): ClockSync {
    return { ...this.read(now), serverTime: now };
  }

  state(now: number): ClockState {
    return { dayMs: DAY_MS, daylightMs: DAYLIGHT_MS, ...this.read(now), serverTime: now };
  }
}
