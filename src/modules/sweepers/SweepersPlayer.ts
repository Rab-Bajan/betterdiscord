import { fullBudget, validateMove } from './motion.ts';
import type { MotionBudget, MoveWorld } from './motion.ts';
import type { PersonalStats, PlayerSnapshot, Pose } from './types.ts';

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
  personal: PersonalStats;
  /** Last processed input sequence number (-1: none yet). */
  lastSeq = -1;
  /** Last seq reported in a tick's `acks`. */
  ackedSeq = -1;
  /** Pose changed since the last tick. */
  dirty = false;
  /** The next tick row carries `corr: 1`. */
  corrected = false;
  #budget: MotionBudget;

  constructor(id: number, key: string, identity: PlayerIdentity, socketId: string, pose: Pose, personal: PersonalStats, now: number) {
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
    this.#budget = fullBudget(now);
  }

  detach(now: number): void {
    this.socketId = null;
    this.disconnectedAt = now;
  }

  /** Applies one client input; stale or duplicate sequence numbers are ignored (false). */
  applyInput(seq: number, requested: Pose, now: number, world: MoveWorld): boolean {
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    const result = validateMove(this.pose, requested, this.#budget, now, world);
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
    return { id: this.id, accountId: this.accountId, username: this.username, avatarColor: this.avatarColor, ...this.pose };
  }
}
