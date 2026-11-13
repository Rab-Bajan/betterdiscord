// Integer encoding of player poses for `miskolc:tick_sync`. Pure functions only.
import { PLAYER_ANIM_STATES } from './types.ts';
import type { PlayerAnimState, PlayerTickRow, Pose } from './types.ts';

/** Metres → whole centimetres. */
export function toCm(metres: number): number {
  return Math.round(metres * 100) + 0;
}

/** Radians → 16-bit turn fraction: round(rotY / 2π × 65536) & 0xffff. */
export function toRot16(rotY: number): number {
  return Math.round((rotY / (Math.PI * 2)) * 65536) & 0xffff;
}

/** 16-bit turn fraction → radians in [0, 2π). */
export function fromRot16(rot16: number): number {
  return ((rot16 & 0xffff) / 65536) * Math.PI * 2;
}

/** Protocol index of an animation state. */
export function stateIndex(state: PlayerAnimState): number {
  return PLAYER_ANIM_STATES.indexOf(state);
}

/** One tick row for player `id` holding `tool`. */
export function encodePose(id: number, pose: Pose, corrected: boolean, tool = 0): PlayerTickRow {
  return [id, toCm(pose.x), toCm(pose.y), toCm(pose.z), toRot16(pose.rotY), stateIndex(pose.state), corrected ? 1 : 0, tool];
}
