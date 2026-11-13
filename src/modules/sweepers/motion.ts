// Server-side validation of client-predicted movement. Pure functions only.
import type { Pose } from './types.ts';

/** Fastest legitimate horizontal speed (sprint), m/s. */
export const MAX_SPEED = 7.2;
/** Allowance on top of MAX_SPEED for timing jitter. */
export const SPEED_TOLERANCE = 1.25;
/** Horizontal world bounds: x and z stay within ±WORLD_HALF_EXTENT metres. */
export const WORLD_HALF_EXTENT = 300;
export const MIN_Y = 0;
export const MAX_Y = 50;
/**
 * Movement budget cap, seconds of travel at the tolerated speed. Inputs arriving in a burst
 * (network jitter) spend the budget saved while none arrived; a long pause never banks more.
 */
export const MAX_BUDGET_SECONDS = 0.5;

/** Vertical speed allowance (climbing, jumping, falling), m/s. */
export const MAX_VERTICAL_SPEED = 6;
/** Vertical travel that may be banked on top of the per-input allowance, metres. */
export const VERTICAL_BANK = 1;
/** Feet may be this far below the ground (sampling rounding)… */
export const BELOW_GROUND_TOLERANCE = 0.05;
/** …and at most this far above it (jump apex 0.82 m plus a step-over obstacle). */
export const ABOVE_GROUND_LIMIT = 1.2;

/** Spacing of the locked-district samples along a move, metres (a move is at most ~4.5 m). */
const OPEN_CHECK_STEP = 0.25;

const TAU = Math.PI * 2;
const MAX_BUDGET_METRES = MAX_SPEED * SPEED_TOLERANCE * MAX_BUDGET_SECONDS;

/** Remaining travel allowance of a player, metres. */
export interface MotionBudget {
  /** Horizontal. */
  metres: number;
  /** Vertical bank (0..VERTICAL_BANK). */
  vertical: number;
  /** Server time of the last refill, ms. */
  at: number;
}

/** A full budget at `now` (fresh spawn or restored player). */
export function fullBudget(now: number): MotionBudget {
  return { metres: MAX_BUDGET_METRES, vertical: VERTICAL_BANK, at: now };
}

/** Rotation normalised to [0, 2π). */
export function normaliseAngle(rad: number): number {
  const wrapped = rad % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** True when every point of the straight path (sampled every OPEN_CHECK_STEP, ends included) is open. */
function pathOpen(world: MoveWorld, fromX: number, fromZ: number, toX: number, toZ: number): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toZ - fromZ) / OPEN_CHECK_STEP));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!world.isOpen(fromX + (toX - fromX) * t, fromZ + (toZ - fromZ) * t)) return false;
  }
  return true;
}

/** What movement validation needs to know about the world (the city geometry and the room's unlocks). */
export interface MoveWorld {
  /** Ground height at (x, z), metres. */
  ground(x: number, z: number): number;
  /** False where the player may not be (a locked district). */
  isOpen(x: number, z: number): boolean;
  /** Walks the player circle from one point towards another; `hit` when a collider stopped or deflected it. */
  sweep(fromX: number, fromZ: number, toX: number, toZ: number): { x: number; z: number; hit: boolean };
}

/** Result of validating one input. */
export interface MoveResult {
  /** The authoritative pose after this input. */
  pose: Pose;
  budget: MotionBudget;
  /** True when the client's position was not accepted as sent (it must snap to `pose`). */
  corrected: boolean;
}

/**
 * Validates a client-predicted pose against the current authoritative one. Rotation and state are
 * always taken. The horizontal position is refused (the player stays) when it exceeds the travel
 * budget (refilled at MAX_SPEED × SPEED_TOLERANCE per elapsed second, capped) or its path crosses a
 * closed (locked) district; otherwise it is clamped to the world bounds and swept against the colliders
 * (the player slides along a wall instead of passing it). The height must stay in the band
 * [ground − 0.05, ground + 1.2] and change by at most MAX_VERTICAL_SPEED × elapsed plus the banked
 * VERTICAL_BANK. Any adjustment marks the result `corrected`.
 */
export function validateMove(current: Pose, requested: Pose, budget: MotionBudget, now: number, world: MoveWorld): MoveResult {
  const elapsed = Math.max(0, now - budget.at) / 1000;
  const available = Math.min(MAX_BUDGET_METRES, budget.metres + elapsed * MAX_SPEED * SPEED_TOLERANCE);
  const verticalAvailable = budget.vertical + Math.min(elapsed, MAX_BUDGET_SECONDS) * MAX_VERTICAL_SPEED;
  const distance = Math.hypot(requested.x - current.x, requested.z - current.z);
  const rotY = normaliseAngle(requested.rotY);
  const refuse = (): MoveResult => ({
    pose: { ...current, rotY, state: requested.state },
    budget: { metres: available, vertical: Math.min(VERTICAL_BANK, verticalAvailable), at: now },
    corrected: true
  });
  if (distance > available) return refuse();
  const tx = clamp(requested.x, -WORLD_HALF_EXTENT, WORLD_HALF_EXTENT);
  const tz = clamp(requested.z, -WORLD_HALF_EXTENT, WORLD_HALF_EXTENT);
  // The whole path must stay open, so a move between two open points cannot clip a locked corner.
  if (!pathOpen(world, current.x, current.z, tx, tz)) return refuse();
  const swept = world.sweep(current.x, current.z, tx, tz);
  // A push-out (or slide) never carries anyone into a locked district.
  if (swept.hit && !pathOpen(world, current.x, current.z, swept.x, swept.z)) return refuse();
  const ground = world.ground(swept.x, swept.z);
  const dy = clamp(requested.y - current.y, -verticalAvailable, verticalAvailable);
  const y = clamp(clamp(current.y + dy, ground - BELOW_GROUND_TOLERANCE, ground + ABOVE_GROUND_LIMIT), MIN_Y, MAX_Y);
  const pose: Pose = { x: swept.x, y, z: swept.z, rotY, state: requested.state };
  const corrected = pose.x !== requested.x || pose.y !== requested.y || pose.z !== requested.z;
  const vertical = clamp(verticalAvailable - Math.abs(y - current.y), 0, VERTICAL_BANK);
  return { pose, budget: { metres: available - distance, vertical, at: now }, corrected };
}
