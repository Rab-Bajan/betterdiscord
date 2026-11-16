// Parsers for the untrusted client payloads of the sweepers events (Phases A–F).
import { ValidationError } from '../../core/errors/ValidationError.ts';
import { INVALID_PAYLOAD_MESSAGE, PayloadReader } from '../../core/validation/PayloadReader.ts';
import { isPlainObject } from '../../core/validation/isPlainObject.ts';
import { BAG_QTY, BUY_ITEMS } from './debris/shop.ts';
import type { BuyRequest } from './debris/shop.ts';
import { TOOL_COUNT } from './debris/tables.ts';
import { onLattice } from './logistics/placement.ts';
import { CRANE, MACHINES, STOCK_TIERS, STRUCT_TYPE_COUNT, structSpec, THROW_MAX_POWER } from './logistics/tables.ts';
import { PLAYER_ANIM_STATES } from './types.ts';
import { MAX_SEATS, VEHICLE_TYPE_COUNT } from './vehicles/tables.ts';
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

/**
 * Parses `{ channelId, item, tier?, level?, qty? }`: `tier` is required for tool (1..6), repair (1..3), bag (0..2),
 * blueprint (0..3), license (1..5), vehicle (0..5) and jerrycan (0..1), `level` for width, pack and hard; bag `qty` is 1, 5 or 10 (default 1).
 */
export function parseBuyUpgrade(payload: unknown): BuyRequest {
  const reader = PayloadReader.strict(payload);
  const channelId = reader.requireString('channelId', CHANNEL_ID);
  const item = reader.requireEnum('item', BUY_ITEMS);
  if (item === 'tool') return { channelId, item, tier: reader.requireInt('tier', { min: 1, max: 6 }) };
  if (item === 'repair') return { channelId, item, tier: reader.requireInt('tier', { min: 1, max: 3 }) };
  if (item === 'width' || item === 'pack' || item === 'hard') return { channelId, item, level: reader.requireInt('level', { min: 1, max: 10 }) };
  if (item === 'bag') {
    const qty = reader.has('qty') ? reader.requireEnum('qty', BAG_QTY) : 1;
    return { channelId, item, tier: reader.requireInt('tier', { min: 0, max: STOCK_TIERS - 1 }), qty };
  }
  if (item === 'blueprint') return { channelId, item, tier: reader.requireInt('tier', { min: 0, max: MACHINES.length - 1 }) };
  if (item === 'license') return { channelId, item, tier: reader.requireInt('tier', { min: 1, max: 5 }) };
  if (item === 'vehicle') return { channelId, item, tier: reader.requireInt('tier', { min: 0, max: VEHICLE_TYPE_COUNT - 1 }) };
  if (item === 'jerrycan') return { channelId, item, tier: reader.requireInt('tier', { min: 0, max: 1 }) };
  return { channelId, item };
}

// ---- Phase D ----

/** `miskolc:tie_bag`. */
export interface TieBag {
  channelId: string;
  tier: number;
}

/** `miskolc:place_structure` (x, z on the 0.5 m lattice, lvl valid for the type). */
export interface PlaceStructure {
  channelId: string;
  type: number;
  x: number;
  z: number;
  rot: number;
  lvl: number;
}

/** `miskolc:delete_structure`. */
export interface DeleteStructure {
  channelId: string;
  id: number;
}

/** `miskolc:logistics_action`. */
export type LogisticsAction =
  | { channelId: string; kind: 'pickup'; id: number }
  | { channelId: string; kind: 'throw'; power: number; pitch: number; rotY: number }
  | { channelId: string; kind: 'clearJam'; id: number }
  | { channelId: string; kind: 'crane'; bag: number; to: number }
  | { channelId: string; kind: 'telemetry'; on: boolean }
  | { channelId: string; kind: 'grease'; id: number; point: number }
  | { channelId: string; kind: 'generator'; on: boolean };

export const LOGISTICS_ACTION_KINDS = Object.freeze(['pickup', 'throw', 'clearJam', 'crane', 'telemetry', 'grease', 'generator'] as const);
const MAX_UINT16 = 0xffff;

function inRange(payload: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = finite(payload, key);
  if (value < min || value > max) {
    throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: key, reason: 'range', message: `"${key}" must be within ${min}..${max}.` });
  }
  return value;
}

/** The channel of a Phase D request, read first (the room and bucket checks come before the full guard). */
export function parseChannel(payload: unknown): string {
  return PayloadReader.strict(payload).requireString('channelId', CHANNEL_ID);
}

/** Parses `{ channelId, tier: 0..2 }`. */
export function parseTieBag(payload: unknown): TieBag {
  const reader = PayloadReader.strict(payload);
  return { channelId: reader.requireString('channelId', CHANNEL_ID), tier: reader.requireInt('tier', { min: 0, max: STOCK_TIERS - 1 }) };
}

/** Parses `{ channelId, type: 0..18, x, z, rot: 0..3, lvl: 0..2 }`: x and z on the 0.5 m lattice within ±256, lvl valid for the type. */
export function parsePlaceStructure(payload: unknown): PlaceStructure {
  const reader = PayloadReader.strict(payload);
  const fields = isPlainObject(payload) ? payload : {};
  const channelId = reader.requireString('channelId', CHANNEL_ID);
  const type = reader.requireInt('type', { min: 0, max: STRUCT_TYPE_COUNT - 1 });
  const x = finite(fields, 'x');
  const z = finite(fields, 'z');
  for (const [key, value] of [['x', x], ['z', z]] as const) {
    if (!onLattice(value)) throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: key, reason: 'snap', message: `"${key}" must be a multiple of 0.5 within ±256.` });
  }
  const rot = reader.requireInt('rot', { min: 0, max: 3 });
  const spec = structSpec(type);
  const lvl = reader.requireInt('lvl', { min: spec.lvlMin, max: spec.lvlMax });
  return { channelId, type, x, z, rot, lvl };
}

/** Parses `{ channelId, id }` (0..65535; id 0, the landmark hopper, is refused by the rules). */
export function parseDeleteStructure(payload: unknown): DeleteStructure {
  const reader = PayloadReader.strict(payload);
  return { channelId: reader.requireString('channelId', CHANNEL_ID), id: reader.requireInt('id', { min: 0, max: MAX_UINT16 }) };
}

/** Parses a `miskolc:logistics_action` (pickup, throw, clearJam, crane, telemetry; Phase E grease, generator). */
export function parseLogisticsAction(payload: unknown): LogisticsAction {
  const reader = PayloadReader.strict(payload);
  const fields = isPlainObject(payload) ? payload : {};
  const channelId = reader.requireString('channelId', CHANNEL_ID);
  const kind = reader.requireEnum('kind', LOGISTICS_ACTION_KINDS);
  switch (kind) {
    case 'pickup':
    case 'clearJam':
      return { channelId, kind, id: reader.requireInt('id', { min: 0, max: MAX_UINT16 }) };
    case 'throw':
      return {
        channelId, kind, power: inRange(fields, 'power', 0, THROW_MAX_POWER), pitch: inRange(fields, 'pitch', -0.6, 1.2), rotY: finite(fields, 'rotY')
      };
    case 'crane':
      return { channelId, kind, bag: reader.requireInt('bag', { min: 0, max: MAX_UINT16 }), to: reader.requireInt('to', { min: 0, max: CRANE.targets.length - 1 }) };
    case 'telemetry':
    case 'generator': {
      const on = reader.optionalBoolean('on');
      if (on === undefined) throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: 'on', reason: 'missing', message: '"on" is required.' });
      return { channelId, kind, on };
    }
    case 'grease':
      return { channelId, kind, id: reader.requireInt('id', { min: 0, max: MAX_UINT16 }), point: reader.requireInt('point', { min: 0, max: 3 }) };
  }
}

// ---- Phase F ----

/** `miskolc:vehicle_enter`. */
export interface VehicleEnter {
  channelId: string;
  id: number;
  seat: number;
}

/** `miskolc:vehicle_drive`: the driver's predicted vehicle pose. */
export interface VehicleDrive {
  channelId: string;
  seq: number;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

/** `miskolc:vehicle_action`. */
export type VehicleAction =
  | { channelId: string; kind: 'exit' }
  | { channelId: string; kind: 'tip' }
  | { channelId: string; kind: 'lights'; mode: 0 | 1 | 2 }
  | { channelId: string; kind: 'beacon'; on: boolean }
  | { channelId: string; kind: 'horn' }
  | { channelId: string; kind: 'load'; id: number }
  | { channelId: string; kind: 'refuel'; id: number }
  | { channelId: string; kind: 'repair'; id: number };

export const VEHICLE_ACTION_KINDS = Object.freeze(['exit', 'tip', 'lights', 'beacon', 'horn', 'load', 'refuel', 'repair'] as const);
const MAX_VEHICLE_ID = 255;

/** Parses `{ channelId, id: 1..255, seat: 0..2 }`. */
export function parseVehicleEnter(payload: unknown): VehicleEnter {
  const reader = PayloadReader.strict(payload);
  return {
    channelId: reader.requireString('channelId', CHANNEL_ID),
    id: reader.requireInt('id', { min: 1, max: MAX_VEHICLE_ID }),
    seat: reader.requireInt('seat', { min: 0, max: MAX_SEATS - 1 })
  };
}

/** Parses `{ channelId, seq, x, y, z, rotY }`. */
export function parseVehicleDrive(payload: unknown): VehicleDrive {
  const reader = PayloadReader.strict(payload);
  const fields = isPlainObject(payload) ? payload : {};
  return {
    channelId: reader.requireString('channelId', CHANNEL_ID),
    seq: reader.requireInt('seq', { min: 0, max: MAX_SEQ }),
    x: finite(fields, 'x'),
    y: finite(fields, 'y'),
    z: finite(fields, 'z'),
    rotY: finite(fields, 'rotY')
  };
}

/** Parses a `miskolc:vehicle_action` (exit, tip, lights, beacon, horn, load, refuel, repair). */
export function parseVehicleAction(payload: unknown): VehicleAction {
  const reader = PayloadReader.strict(payload);
  const channelId = reader.requireString('channelId', CHANNEL_ID);
  const kind = reader.requireEnum('kind', VEHICLE_ACTION_KINDS);
  switch (kind) {
    case 'exit':
    case 'tip':
    case 'horn':
      return { channelId, kind };
    case 'lights':
      return { channelId, kind, mode: reader.requireEnum('mode', [0, 1, 2] as const) };
    case 'beacon': {
      const on = reader.optionalBoolean('on');
      if (on === undefined) throw new ValidationError(INVALID_PAYLOAD_MESSAGE, { field: 'on', reason: 'missing', message: '"on" is required.' });
      return { channelId, kind, on };
    }
    case 'load':
    case 'refuel':
    case 'repair':
      return { channelId, kind, id: reader.requireInt('id', { min: 1, max: MAX_VEHICLE_ID }) };
  }
}
