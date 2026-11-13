import { cityLayout } from './city/cityLayout.ts';
import { DayClock } from './dayClock.ts';
import type { ClockSync } from './dayClock.ts';
import { ColliderIndex, groundHeight, sweepCircle } from './geometry.ts';
import { districtAt, HEX_CELLS, initialCleanliness } from './hexGrid.ts';
import type { MoveWorld } from './motion.ts';
import { DISTRICT_IDS, unlockedFor } from './progression.ts';
import { parseRoomState, serialiseRoomState } from './roomState.ts';
import { WeatherScheduler } from './weather.ts';
import type { WeatherPayload } from './weather.ts';
import { encodePose } from './quantize.ts';
import { SweepersPlayer } from './SweepersPlayer.ts';
import type { PlayerIdentity } from './SweepersPlayer.ts';
import type { PlayerStatsRecord, RoomRecord } from './SweepersRepository.ts';
import type {
  HexSnapshot, InitStatePayload, PersonalStats, PlayerSnapshot, PlayerTickRow, Pose, SweepersSessionSummary, TickSyncPayload
} from './types.ts';

/** Golden angle: spreads consecutive spawn points around the centre hex. */
const SPAWN_ANGLE_STEP = Math.PI * (3 - Math.sqrt(5));

/** Fresh progress of a player who never played in this room. */
export const NEW_PLAYER_STATS: Readonly<PersonalStats> = Object.freeze({ cash: 0, toolTier: 0, backpackTier: 0, totalKg: 0 });

/** Outcome of {@link SweepersRoom.attach}. */
export interface AttachResult {
  player: SweepersPlayer;
  /** True when an existing record (grace window or same account) was reused. */
  restored: boolean;
  /** Another live socket that held this player and was replaced (same account in a second tab). */
  displacedSocketId: string | null;
  /** The socket's previous player in this room, removed because another record took the socket. */
  replaced: SweepersPlayer | null;
}

const clampCleanliness = (value: number): number => Math.min(100, Math.max(0, value));

let colliderIndex: ColliderIndex | null = null;

/** The movement rules of the city with the given open districts (the set is read live). */
function cityMoveWorld(unlocked: ReadonlySet<number>): MoveWorld {
  const layout = cityLayout();
  colliderIndex ??= new ColliderIndex(layout.colliders);
  const index = colliderIndex;
  return {
    ground: (x, z) => groundHeight(layout.heightfield, x, z),
    isOpen: (x, z) => unlocked.has(districtAt(x, z)),
    sweep: (fromX, fromZ, toX, toZ) => sweepCircle(index, fromX, fromZ, toX, toZ)
  };
}

/** Spawn pose in the centre district for short id `id`. */
export function spawnPose(id: number): Pose {
  const angle = id * SPAWN_ANGLE_STEP;
  const radius = 3 + (id % 4);
  return { x: Math.cos(angle) * radius, y: 0, z: Math.sin(angle) * radius, rotY: 0, state: 'IDLE' };
}

/** The world of one voice channel: players, hexes and the team purse. */
export class SweepersRoom {
  readonly channelId: string;
  readonly startedBy: string | null;
  teamFunds: number;
  /** Server time since when nobody is connected, null while someone is. */
  emptySince: number | null = null;
  lastSavedAt: number;
  /** Server time of the last `miskolc:clock` broadcast. */
  lastClockSyncAt: number;
  /** Team lifetime revenue, Ft. */
  lifetimeEarned: number;
  /** Movement rules for this room's open districts. */
  readonly moveWorld: MoveWorld;
  readonly #unlocked: Set<number>;
  readonly #clock: DayClock;
  readonly #weather: WeatherScheduler;
  readonly #cleanliness: number[];
  readonly #players = new Map<number, SweepersPlayer>();
  readonly #byKey = new Map<string, SweepersPlayer>();
  readonly #bySocket = new Map<string, SweepersPlayer>();
  #gone: number[] = [];
  #nextId = 1;

  constructor(channelId: string, startedBy: string | null, saved: RoomRecord | null, now: number) {
    this.channelId = channelId;
    this.startedBy = startedBy;
    this.teamFunds = saved?.teamFunds ?? 0;
    this.lastSavedAt = now;
    this.lastClockSyncAt = now;
    const world = parseRoomState(saved?.state ?? {}, channelId);
    this.lifetimeEarned = world.lifetimeEarned;
    this.#unlocked = new Set(world.unlockedDistricts);
    this.#clock = new DayClock(world.clock, now);
    this.#weather = new WeatherScheduler(world.weather);
    this.moveWorld = cityMoveWorld(this.#unlocked);
    this.#cleanliness = HEX_CELLS.map((cell) => {
      const stored = saved?.cleanliness[String(cell.id)];
      return stored === undefined ? initialCleanliness(cell) : clampCleanliness(stored);
    });
  }

  get connectedCount(): number {
    return this.#bySocket.size;
  }

  get playerCount(): number {
    return this.#players.size;
  }

  players(): IterableIterator<SweepersPlayer> {
    return this.#players.values();
  }

  bySocket(socketId: string): SweepersPlayer | undefined {
    return this.#bySocket.get(socketId);
  }

  /**
   * Binds `socketId` to the player of `identity`: the existing record when there is one (reconnect
   * within the grace window, the same socket joining again, or the same account from another socket),
   * otherwise a new player with the next short id. A guest name already held by another live socket
   * gets a separate record (two guests may share a name; both keep the name's stored stats).
   */
  attach(identity: PlayerIdentity, socketId: string, now: number, loadStats: (key: string) => PersonalStats): AttachResult {
    let key = identity.key;
    let existing = this.#byKey.get(key);
    if (existing?.connected && existing.socketId !== socketId && identity.accountId === null) {
      key = `${identity.key}#${socketId}`;
      existing = this.#byKey.get(key);
    }
    // The socket can play only one player: a different previous one (identity change, or a guest
    // name taking over a disconnected record) is removed, never left behind as a ghost.
    const own = this.#bySocket.get(socketId);
    const replaced = own !== undefined && own !== existing ? own : null;
    if (replaced) this.remove(replaced, now);
    this.emptySince = null;
    if (existing) {
      const displaced = existing.socketId !== null && existing.socketId !== socketId ? existing.socketId : null;
      if (existing.socketId !== null) this.#bySocket.delete(existing.socketId);
      existing.reattach(identity, socketId, now);
      this.#bySocket.set(socketId, existing);
      return { player: existing, restored: true, displacedSocketId: displaced, replaced };
    }
    const id = this.#nextId++;
    const player = new SweepersPlayer(id, key, identity, socketId, spawnPose(id), { ...loadStats(identity.key) }, now);
    this.#players.set(id, player);
    this.#byKey.set(player.key, player);
    this.#bySocket.set(socketId, player);
    return { player, restored: false, displacedSocketId: null, replaced };
  }

  /** Marks the socket's player disconnected (kept for the grace window). */
  detach(socketId: string, now: number): SweepersPlayer | undefined {
    const player = this.#bySocket.get(socketId);
    if (!player) return undefined;
    this.#bySocket.delete(socketId);
    player.detach(now);
    if (this.#bySocket.size === 0) this.emptySince = now;
    return player;
  }

  /** Removes a player for good; its id is reported in the next tick's `gone`. */
  remove(player: SweepersPlayer, now: number): void {
    if (this.#players.get(player.id) !== player) return;
    this.#players.delete(player.id);
    this.#byKey.delete(player.key);
    if (player.socketId !== null) this.#bySocket.delete(player.socketId);
    this.#gone.push(player.id);
    if (this.#bySocket.size === 0) this.emptySince ??= now;
  }

  /** Removes and returns the disconnected players whose grace window (ms) has passed. */
  expire(now: number, graceMs: number): SweepersPlayer[] {
    const expired = [...this.#players.values()].filter((p) => p.disconnectedAt !== null && now - p.disconnectedAt >= graceMs);
    for (const player of expired) this.remove(player, now);
    return expired;
  }

  /** The changes since the previous call, or null when nothing changed. Resets the change tracking. */
  takeTick(now: number): TickSyncPayload | null {
    const p: PlayerTickRow[] = [];
    const acks: Record<string, number> = {};
    for (const player of this.#players.values()) {
      if (player.dirty) p.push(encodePose(player.id, player.pose, player.corrected));
      if (player.lastSeq > player.ackedSeq) acks[String(player.id)] = player.lastSeq;
      player.dirty = false;
      player.corrected = false;
      player.ackedSeq = player.lastSeq;
    }
    const gone = this.#gone;
    this.#gone = [];
    if (p.length === 0 && gone.length === 0 && Object.keys(acks).length === 0) return null;
    return { t: now, acks, p, gone };
  }

  /** Open district ids, ascending. */
  unlockedDistricts(): number[] {
    return DISTRICT_IDS.filter((d) => this.#unlocked.has(d));
  }

  /**
   * Adds team revenue (Ft) to the lifetime total and opens every district whose threshold it now
   * reaches. Returns the newly opened district ids, ascending.
   */
  addRevenue(amount: number): number[] {
    if (!Number.isFinite(amount) || amount <= 0) throw new RangeError(`Revenue must be a positive finite amount, got ${amount}`);
    this.lifetimeEarned += amount;
    const opened = unlockedFor(this.lifetimeEarned).filter((d) => !this.#unlocked.has(d));
    for (const d of opened) this.#unlocked.add(d);
    return opened;
  }

  clockSync(now: number): ClockSync {
    return this.#clock.sync(now);
  }

  /** Advances the weather to `now`; true when it changed. */
  advanceWeather(now: number): boolean {
    return this.#weather.advance(this.#clock.elapsed(now));
  }

  weather(now: number): WeatherPayload {
    return this.#weather.payload(this.#clock.elapsed(now), now);
  }

  hexSnapshots(): HexSnapshot[] {
    return HEX_CELLS.map((cell) => ({
      id: cell.id, q: cell.q, r: cell.r, district: cell.district, cleanliness: this.#cleanliness[cell.id] ?? 0
    }));
  }

  playerSnapshots(): PlayerSnapshot[] {
    return [...this.#players.values()].map((p) => p.snapshot());
  }

  initState(self: SweepersPlayer, tickRate: number, now: number): InitStatePayload {
    return {
      roomId: this.channelId,
      selfId: self.id,
      tickRate,
      serverTime: now,
      players: this.playerSnapshots(),
      hexes: this.hexSnapshots(),
      teamFunds: this.teamFunds,
      personal: { ...self.personal },
      layout: cityLayout(),
      unlockedDistricts: this.unlockedDistricts(),
      lifetimeEarned: this.lifetimeEarned,
      clock: this.#clock.state(now),
      weather: this.weather(now)
    };
  }

  /** Session summary, or null when nobody is connected. */
  summary(): SweepersSessionSummary | null {
    if (this.connectedCount === 0) return null;
    return { active: true, startedBy: this.startedBy, playerCount: this.connectedCount };
  }

  record(now: number): RoomRecord {
    const cleanliness: Record<string, number> = {};
    for (const cell of HEX_CELLS) cleanliness[String(cell.id)] = this.#cleanliness[cell.id] ?? 0;
    const state = serialiseRoomState({
      lifetimeEarned: this.lifetimeEarned,
      unlockedDistricts: this.unlockedDistricts(),
      clock: this.#clock.read(now),
      weather: this.#weather.record()
    });
    return { roomId: this.channelId, state, cleanliness, teamFunds: this.teamFunds, lastSaved: now };
  }

  statsRecord(player: SweepersPlayer): PlayerStatsRecord {
    return { userId: player.userId, roomId: this.channelId, stats: { ...player.personal } };
  }
}
