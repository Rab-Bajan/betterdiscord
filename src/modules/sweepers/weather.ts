// Weather (spec 29): every 2–3 in-game days a smog or drizzle spell starts and lasts 0.25–0.5
// in-game day, then it is clear again. Scheduled in game time with a per-room seeded PRNG whose
// state is persisted, so a room's weather continues where it stopped.
import { DAY_MS } from './dayClock.ts';
import { hashString, Rng } from './random.ts';

export const WEATHER_KINDS = Object.freeze(['clear', 'smog', 'drizzle'] as const);
export type WeatherKind = (typeof WEATHER_KINDS)[number];

/** `init_state.weather`, `miskolc:weather`. */
export interface WeatherPayload {
  kind: WeatherKind;
  /** Server time the current spell ends; null while clear. */
  untilServerTime: number | null;
}

/** Persisted scheduler state; all times are game ms since the sunrise of day 1. */
export interface WeatherRecord {
  kind: WeatherKind;
  /** End of the current spell (null while clear). */
  until: number | null;
  /** Start of the next spell. */
  nextStart: number;
  /** PRNG state. */
  rng: number;
}

export const SPELL_GAP_DAYS: readonly [number, number] = [2, 3];
export const SPELL_LENGTH_DAYS: readonly [number, number] = [0.25, 0.5];
/**
 * Catch-up bound: spells that would have started more than this long ago are skipped (the next one
 * starts at `elapsed - MAX_CATCH_UP_MS`), so a corrupt or huge stored clock cannot block the event loop.
 */
export const MAX_CATCH_UP_MS = 10 * DAY_MS;
/** Mixed into the room id hash, so weather and other seeded streams differ. */
const WEATHER_SEED_SALT = 0x57454154;

/** A room's first weather: clear, first spell 2–3 days after the start of day 1. */
export function freshWeather(roomId: string): WeatherRecord {
  const rng = new Rng(hashString(roomId) ^ WEATHER_SEED_SALT);
  const nextStart = Math.round(rng.range(SPELL_GAP_DAYS[0], SPELL_GAP_DAYS[1]) * DAY_MS);
  return { kind: 'clear', until: null, nextStart, rng: rng.state };
}

export class WeatherScheduler {
  #record: WeatherRecord;

  constructor(record: WeatherRecord) {
    this.#record = { ...record };
  }

  get kind(): WeatherKind {
    return this.#record.kind;
  }

  record(): WeatherRecord {
    return { ...this.#record };
  }

  /** Advances to game time `elapsed`; true when the weather (kind or end) changed. */
  advance(elapsed: number): boolean {
    const before = this.#record;
    let r = before;
    for (;;) {
      if (r.until !== null && elapsed >= r.until) {
        r = { ...r, kind: 'clear', until: null };
      } else if (r.until === null && elapsed >= r.nextStart) {
        const start = Math.max(r.nextStart, elapsed - MAX_CATCH_UP_MS);
        const rng = new Rng(r.rng);
        const kind: WeatherKind = rng.chance(0.5) ? 'smog' : 'drizzle';
        const until = start + Math.round(rng.range(SPELL_LENGTH_DAYS[0], SPELL_LENGTH_DAYS[1]) * DAY_MS);
        const nextStart = start + Math.round(rng.range(SPELL_GAP_DAYS[0], SPELL_GAP_DAYS[1]) * DAY_MS);
        r = { kind, until, nextStart, rng: rng.state };
      } else {
        break;
      }
    }
    this.#record = r;
    return r.kind !== before.kind || r.until !== before.until;
  }

  /** The wire payload at game time `elapsed` / server time `now` (game time runs 1:1 with server time). */
  payload(elapsed: number, now: number): WeatherPayload {
    const { kind, until } = this.#record;
    return { kind, untilServerTime: until === null ? null : now + (until - elapsed) };
  }
}
