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

const TAU = Math.PI * 2;
const MAX_BUDGET_METRES = MAX_SPEED * SPEED_TOLERANCE * MAX_BUDGET_SECONDS;

/** Remaining horizontal travel allowance of a player, metres. */
export interface MotionBudget {
  metres: number;
  /** Server time of the last refill, ms. */
  at: number;
}

/** A full budget at `now` (fresh spawn or restored player). */
export function fullBudget(now: number): MotionBudget {
  return { metres: MAX_BUDGET_METRES, at: now };
}

/** Rotation normalised to [0, 2π). */
export function normaliseAngle(rad: number): number {
  const wrapped = rad % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

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
 * always taken. The position is taken when the horizontal distance fits the travel budget (refilled
 * at MAX_SPEED × SPEED_TOLERANCE per elapsed second, capped); otherwise the player stays where the
 * server has them. An accepted position is clamped to the world bounds (clamping also corrects).
 */
export function validateMove(current: Pose, requested: Pose, budget: MotionBudget, now: number): MoveResult {
  const elapsed = Math.max(0, now - budget.at) / 1000;
  const available = Math.min(MAX_BUDGET_METRES, budget.metres + elapsed * MAX_SPEED * SPEED_TOLERANCE);
  const distance = Math.hypot(requested.x - current.x, requested.z - current.z);
  const rotY = normaliseAngle(requested.rotY);
  if (distance > available) {
    return { pose: { ...current, rotY, state: requested.state }, budget: { metres: available, at: now }, corrected: true };
  }
  const pose: Pose = {
    x: clamp(requested.x, -WORLD_HALF_EXTENT, WORLD_HALF_EXTENT),
    y: clamp(requested.y, MIN_Y, MAX_Y),
    z: clamp(requested.z, -WORLD_HALF_EXTENT, WORLD_HALF_EXTENT),
    rotY,
    state: requested.state
  };
  const corrected = pose.x !== requested.x || pose.y !== requested.y || pose.z !== requested.z;
  return { pose, budget: { metres: available - distance, at: now }, corrected };
}
