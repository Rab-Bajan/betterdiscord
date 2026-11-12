// Parsers for the untrusted client payloads of the sweepers events.
import { ValidationError } from '../../core/errors/ValidationError.ts';
import { INVALID_PAYLOAD_MESSAGE, PayloadReader } from '../../core/validation/PayloadReader.ts';
import { isPlainObject } from '../../core/validation/isPlainObject.ts';
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
