// `miskolc_rooms.state_json`: the room-level world state (format v4). A v1 row (Phase A stored only
// `{ "v": 1 }`) or any missing / corrupt field loads as the fresh default; a v2 row has no debris, and a
// row before v4 has no logistics network (it loads empty). Phase E adds the optional `economy` key
// without a version bump (a v5 would make D's parser drop debris and logistics on a rollback).
import { DAY_MS, FRESH_CLOCK } from './dayClock.ts';
import type { ClockReading } from './dayClock.ts';
import { isPlainObject } from '../../core/validation/isPlainObject.ts';
import { DISTRICT_IDS, unlockedFor } from './progression.ts';
import { freshWeather, SPELL_GAP_DAYS, SPELL_LENGTH_DAYS, WEATHER_KINDS } from './weather.ts';
import type { WeatherKind, WeatherRecord } from './weather.ts';

/** Version stored in `state_json.v`. */
export const ROOM_STATE_VERSION = 4;

export interface RoomWorldRecord {
  /** Team lifetime revenue, Ft (only grows). */
  lifetimeEarned: number;
  /** Open districts, ascending, always containing 0. */
  unlockedDistricts: number[];
  clock: ClockReading;
  weather: WeatherRecord;
  /** v3 `debris` as stored (validated by `DebrisWorld.restore`); null for v1 / v2 rows (regenerate). */
  debris: unknown;
  /** v4 `logistics` as stored (validated by `restoreLogistics`); null before v4 (empty network). */
  logistics: unknown;
  /** Phase E `economy` as stored, any version (parsed per field by `Economy.restore`); null when absent. */
  economy: unknown;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isUint32 = (value: unknown): value is number => Number.isInteger(value) && isFiniteNumber(value) && value >= 0 && value <= 0xffffffff;
const isWeatherKind = (value: unknown): value is WeatherKind => WEATHER_KINDS.some((k) => k === value);

/** Highest stored day accepted (about 68 years of play); anything above is corrupt and resets the clock. */
export const MAX_CLOCK_DAY = 1_000_000;

function parseClock(value: unknown): ClockReading {
  if (!isPlainObject(value)) return { ...FRESH_CLOCK };
  const { timeMs, day } = value;
  if (!isFiniteNumber(timeMs) || timeMs < 0 || timeMs >= DAY_MS) return { ...FRESH_CLOCK };
  if (!Number.isInteger(day) || !isFiniteNumber(day) || day < 1 || day > MAX_CLOCK_DAY) return { ...FRESH_CLOCK };
  return { timeMs, day };
}

function parseWeather(value: unknown, roomId: string): WeatherRecord {
  if (!isPlainObject(value)) return freshWeather(roomId);
  const { kind, until, nextStart, rng } = value;
  const untilOk = until === null || (isFiniteNumber(until) && until >= 0);
  if (!isWeatherKind(kind) || !untilOk || !isFiniteNumber(nextStart) || nextStart < 0 || !isUint32(rng)) return freshWeather(roomId);
  // A clear sky has no end; a spell must have one.
  if ((kind === 'clear') !== (until === null)) return freshWeather(roomId);
  return { kind, until, nextStart, rng };
}

/**
 * The world state of a stored `state_json` (defaults for anything absent or invalid). Branches on
 * `v`: v1 (or none) has none of these fields, v2 adds the world fields, v3 adds `debris`, v4 adds
 * `logistics`. No version changed the meaning of an earlier field.
 */
export function parseRoomState(state: Record<string, unknown>, roomId: string): RoomWorldRecord {
  const version = state['v'];
  const debris = (version === 3 || version === 4) && state['debris'] !== undefined ? state['debris'] : null;
  const logistics = version === 4 && state['logistics'] !== undefined ? state['logistics'] : null;
  const lifetimeEarned = isFiniteNumber(state['lifetimeEarned']) && state['lifetimeEarned'] > 0 ? state['lifetimeEarned'] : 0;
  const stored: unknown[] = Array.isArray(state['unlockedDistricts']) ? state['unlockedDistricts'] : [];
  // Unlocks never go back: the stored ones stay open even if a threshold was raised later.
  const clock = parseClock(state['clock']);
  const unlocked = new Set([...unlockedFor(lifetimeEarned), ...stored.filter((d): d is number => typeof d === 'number' && DISTRICT_IDS.includes(d))]);
  return {
    lifetimeEarned,
    unlockedDistricts: DISTRICT_IDS.filter((d) => unlocked.has(d)),
    clock,
    weather: boundedWeather(parseWeather(state['weather'], roomId), clock, roomId),
    debris,
    logistics,
    economy: state['economy'] ?? null
  };
}

/**
 * A weather record from another timeline (a reset clock, a corrupt row) is replaced by a fresh
 * schedule from the current game time: a spell can end at most 0.5 day, and the next one start at
 * most 3 days, after the clock. Otherwise a stale `until` could mean smog for ages, or a huge
 * `nextStart` no weather ever again.
 */
function boundedWeather(weather: WeatherRecord, clock: ClockReading, roomId: string): WeatherRecord {
  const elapsed = (clock.day - 1) * DAY_MS + clock.timeMs;
  const untilOk = weather.until === null || weather.until <= elapsed + SPELL_LENGTH_DAYS[1] * DAY_MS;
  if (untilOk && weather.nextStart <= elapsed + SPELL_GAP_DAYS[1] * DAY_MS) return weather;
  const fresh = freshWeather(roomId);
  return { ...fresh, nextStart: fresh.nextStart + elapsed };
}

/** The `state_json` object of a world state. */
export function serialiseRoomState(world: RoomWorldRecord): Record<string, unknown> {
  return {
    v: ROOM_STATE_VERSION, ...world, unlockedDistricts: [...world.unlockedDistricts], clock: { ...world.clock }, weather: { ...world.weather }
  };
}
