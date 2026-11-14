import { ChunkInterest } from './debris/ChunkInterest.ts';
import { debrisGrid } from './debris/grid.ts';
import type { PersonalData } from './debris/personal.ts';
import { fullBudget, validateMove } from './motion.ts';
import type { MotionBudget, MoveWorld } from './motion.ts';
import type { PlayerSnapshot, Pose } from './types.ts';

/** Who a player is, taken from the presence registry at join time. */
export interface PlayerIdentity {
  /** Reconnection key: `acc:<accountId>`, or `name:<lowercased username>` for guests. */
  key: string;
  accountId: string | null;
  username: string;
  avatarColor: string;
}

/** One player of a sweepers room; survives a disconnect for the reconnection grace window. */
export class SweepersPlayer {
  readonly id: number;
  /** Reconnection key within the room. */
  readonly key: string;
  /** `miskolc_player_stats.user_id`: the identity key (a duplicate guest name shares it). */
  readonly userId: string;
  readonly accountId: string | null;
  username: string;
  avatarColor: string;
  /** Current socket, null while disconnected. */
  socketId: string | null;
  /** Server time of the disconnect, null while connected. */
  disconnectedAt: number | null = null;
  pose: Pose;
  personal: PersonalData;
  /** Last processed input sequence number (-1: none yet). */
  lastSeq = -1;
  /** Last seq reported in a tick's `acks`. */
  ackedSeq = -1;
  /** Pose changed since the last tick. */
  dirty = false;
  /** The next tick row carries `corr: 1`. */
  corrected = false;
  /** Last accepted `sweep_hit` seq of the current socket (-1: none). */
  sweepSeq = -1;
  /** Server time of the last accepted use, per alt (index 0 LMB, 1 RMB). */
  readonly lastUseAt: [number, number] = [-Infinity, -Infinity];
  /** Server time of the last acid stamina hit. */
  lastAcidAt = -Infinity;
  /** Personal state changed (beyond stamina) since the last `personal_update`. */
  personalDirty = false;
  /** Stamina value and time of the last `personal_update`. */
  staminaSent = -1;
  staminaSentAt = -Infinity;
  /** Carried bag id, 0 when none (Phase D); kept through the reconnect grace window. */
  carry = 0;
  /** Server time of the last accepted `tie_bag`. */
  lastTieAt = -Infinity;
  /** Chunks the current socket knows. */
  interest: ChunkInterest;
  #budget: MotionBudget;

  constructor(id: number, key: string, identity: PlayerIdentity, socketId: string, pose: Pose, personal: PersonalData, now: number) {
    this.id = id;
    this.key = key;
    this.userId = identity.key;
    this.accountId = identity.accountId;
    this.username = identity.username;
    this.avatarColor = identity.avatarColor;
    this.socketId = socketId;
    this.pose = pose;
    this.personal = personal;
    this.#budget = fullBudget(now);
    this.interest = new ChunkInterest(debrisGrid());
  }

  /** Server time of the last accepted use of either kind. */
  get lastAnyUseAt(): number {
    return Math.max(this.lastUseAt[0], this.lastUseAt[1]);
  }

  get connected(): boolean {
    return this.socketId !== null;
  }

  /** Binds a (new) socket after a reconnect; the pose and stats are kept, the input sequence restarts. */
  reattach(identity: PlayerIdentity, socketId: string, now: number): void {
    this.username = identity.username;
    this.avatarColor = identity.avatarColor;
    this.socketId = socketId;
    this.disconnectedAt = null;
    this.lastSeq = -1;
    this.ackedSeq = -1;
    this.sweepSeq = -1;
    this.#budget = fullBudget(now);
    // The new socket knows no chunk yet; it gets a fresh burst.
    this.interest = new ChunkInterest(debrisGrid());
    this.personalDirty = true;
  }

  detach(now: number): void {
    this.socketId = null;
    this.disconnectedAt = now;
  }

  /** Applies one client input; stale or duplicate sequence numbers are ignored (false). `speedFactor`: 1.15 under Kofola. */
  applyInput(seq: number, requested: Pose, now: number, world: MoveWorld, speedFactor = 1): boolean {
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    const result = validateMove(this.pose, requested, this.#budget, now, world, speedFactor);
    this.#budget = result.budget;
    const before = this.pose;
    const after = result.pose;
    if (before.x !== after.x || before.y !== after.y || before.z !== after.z || before.rotY !== after.rotY || before.state !== after.state) {
      this.dirty = true;
    }
    this.pose = after;
    if (result.corrected) {
      this.corrected = true;
      this.dirty = true;
    }
    return true;
  }

  snapshot(): PlayerSnapshot {
    return { id: this.id, accountId: this.accountId, username: this.username, avatarColor: this.avatarColor, ...this.pose, tool: this.personal.toolTier, carry: this.carry };
  }
}
