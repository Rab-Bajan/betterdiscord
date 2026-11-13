// Parsers for the untrusted client payloads of the sweepers events (Phases A–C).
import { ValidationError } from '../../core/errors/ValidationError.ts';
import { INVALID_PAYLOAD_MESSAGE, PayloadReader } from '../../core/validation/PayloadReader.ts';
import { isPlainObject } from '../../core/validation/isPlainObject.ts';
import { BUY_ITEMS } from './debris/shop.ts';
import type { BuyRequest } from './debris/shop.ts';
import { TOOL_COUNT } from './debris/tables.ts';
import { PLAYER_ANIM_STATES } from './types.ts';
import type { PlayerAnimState } from './types.ts';

const CHANNEL_ID = { trim: true, maxLength: 64 } as const;
/** Coordinates beyond this are garbage, not a position to clamp. */
const MAX_ABS_COORDINATE = 1e6;
/** Largest input sequence number (31-bit, so it stays a small integer on every client). */
export const MAX_SEQ = 0x7fffffff;

/** `miskolc:join_room` / `miskolc:leave_room`. */
export interface RoomRequest {
  channelId: string;
}

/** `miskolc:player_input`. */
export interface PlayerInput {
  channelId: string;
  seq: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
  state: PlayerAnimState;
}

function finite(payload: Record<string, unknown>, key: string): number {
  const value = Object.hasOwn(payload, key) ? payload[key] : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_ABS_COORDINATE) {
    throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: key, reason: 'type', message: `"${key}" must be a finite number.` });
  }
  return value;
}

/** Parses `{ channelId }`. */
export function parseRoomRequest(payload: unknown): RoomRequest {
  return { channelId: PayloadReader.strict(payload).requireString('channelId', CHANNEL_ID) };
}

/** Parses `{ channelId, seq, x, y, z, rotY, state }`. */
export function parsePlayerInput(payload: unknown): PlayerInput {
  const reader = PayloadReader.strict(payload);
  // strict() has accepted it as a plain object.
  const fields = isPlainObject(payload) ? payload : {};
  return {
    channelId: reader.requireString('channelId', CHANNEL_ID),
    seq: reader.requireInt('seq', { min: 0, max: MAX_SEQ }),
    x: finite(fields, 'x'),
    y: finite(fields, 'y'),
    z: finite(fields, 'z'),
    rotY: finite(fields, 'rotY'),
    state: reader.requireEnum('state', PLAYER_ANIM_STATES)
  };
}

// ---- Phase C ----

/** `miskolc:sweep_hit`: one tool use (per stroke or pulse). */
export interface SweepHit {
  channelId: string;
  /** Per socket, increasing; separate from the input seq. */
  seq: number;
  tool: number;
  alt: boolean;
  x: number;
  z: number;
  rotY: number;
}

/** `miskolc:player_action`. */
export type PlayerAction =
  | { channelId: string; kind: 'select'; tool: number }
  | { channelId: string; kind: 'kick'; id: number; vx: number; vz: number }
  | { channelId: string; kind: 'dump' };

export const PLAYER_ACTION_KINDS = Object.freeze(['select', 'kick', 'dump'] as const);
const MAX_TOOL = TOOL_COUNT - 1;
/** Kick velocities beyond this are garbage. */
const MAX_ABS_VELOCITY = 1000;

function velocity(payload: Record<string, unknown>, key: string): number {
  const value = finite(payload, key);
  if (Math.abs(value) > MAX_ABS_VELOCITY) {
    throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: key, reason: 'range', message: `"${key}" is out of range.` });
  }
  return value;
}

/** Parses `{ channelId, seq, tool: 0..7, alt: 0|1, x, z, rotY }`. */
export function parseSweepHit(payload: unknown): SweepHit {
  const reader = PayloadReader.strict(payload);
  const fields = isPlainObject(payload) ? payload : {};
  return {
    channelId: reader.requireString('channelId', CHANNEL_ID),
    seq: reader.requireInt('seq', { min: 0, max: MAX_SEQ }),
    tool: reader.requireInt('tool', { min: 0, max: MAX_TOOL }),
    alt: reader.requireEnum('alt', [0, 1]) === 1,
    x: finite(fields, 'x'),
    z: finite(fields, 'z'),
    rotY: finite(fields, 'rotY')
  };
}

/** Parses `{ channelId, kind: 'select', tool }` | `{ channelId, kind: 'kick', id, vx, vz }` | `{ channelId, kind: 'dump' }`. */
export function parsePlayerAction(payload: unknown): PlayerAction {
  const reader = PayloadReader.strict(payload);
  const fields = isPlainObject(payload) ? payload : {};
  const channelId = reader.requireString('channelId', CHANNEL_ID);
  const kind = reader.requireEnum('kind', PLAYER_ACTION_KINDS);
  if (kind === 'select') return { channelId, kind, tool: reader.requireInt('tool', { min: 0, max: MAX_TOOL }) };
  if (kind === 'kick') {
    return { channelId, kind, id: reader.requireInt('id', { min: 0, max: 0xffffffff }), vx: velocity(fields, 'vx'), vz: velocity(fields, 'vz') };
  }
  return { channelId, kind };
}

/** Parses `{ channelId, item, tier?, level? }`: `tier` is required for tool (1..6) and repair (1..3), `level` for width, pack and hard. */
export function parseBuyUpgrade(payload: unknown): BuyRequest {
  const reader = PayloadReader.strict(payload);
  const channelId = reader.requireString('channelId', CHANNEL_ID);
  const item = reader.requireEnum('item', BUY_ITEMS);
  if (item === 'tool') return { channelId, item, tier: reader.requireInt('tier', { min: 1, max: 6 }) };
  if (item === 'repair') return { channelId, item, tier: reader.requireInt('tier', { min: 1, max: 3 }) };
  if (item === 'width' || item === 'pack' || item === 'hard') return { channelId, item, level: reader.requireInt('level', { min: 1, max: 10 }) };
  return { channelId, item };
}
