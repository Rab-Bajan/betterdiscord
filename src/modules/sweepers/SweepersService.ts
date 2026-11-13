import type { Logger } from '../../core/logging/Logger.ts';
import type { SweepersEvents } from './SweepersBroadcaster.ts';
import { SWEEPERS_ERRORS, SweepersError } from './SweepersError.ts';
import type { PlayerIdentity, SweepersPlayer } from './SweepersPlayer.ts';
import type { SweepersStore } from './SweepersRepository.ts';
import { NEW_PLAYER_STATS, SweepersRoom } from './SweepersRoom.ts';
import type { PlayerInput } from './payloads.ts';
import type { PersonalStats, SweepersSessionSummary } from './types.ts';

/** Server time source (ms). */
export interface Clock {
  now(): number;
}

/** Starts a repeating task; returns its cancel function. */
export type Scheduler = (intervalMs: number, task: () => void) => () => void;

/** Real timers: one unref'd setInterval (it never keeps the process alive). */
export const intervalScheduler: Scheduler = (intervalMs, task) => {
  const handle = setInterval(task, intervalMs);
  handle.unref();
  return () => clearInterval(handle);
};

export const systemClock: Clock = { now: () => Date.now() };

/** Timing constants (ms unless noted). */
export interface SweepersTimings {
  tickRate: number;
  /** A disconnected player is kept this long for a reconnect. */
  reconnectGraceMs: number;
  /** A world nobody is connected to is saved and unloaded after this long. */
  emptyRoomUnloadMs: number;
  saveIntervalMs: number;
  /** `miskolc:clock` is broadcast to each world this often. */
  clockSyncMs: number;
}

export const DEFAULT_TIMINGS: Readonly<SweepersTimings> = Object.freeze({
  tickRate: 12,
  reconnectGraceMs: 120_000,
  emptyRoomUnloadMs: 120_000,
  saveIntervalMs: 60_000,
  clockSyncMs: 30_000
});

export interface SweepersServiceOptions {
  store: SweepersStore;
  events: SweepersEvents;
  logger: Logger;
  clock?: Clock;
  scheduler?: Scheduler;
  timings?: Partial<SweepersTimings>;
}

/** Result of {@link SweepersService.join}. */
export interface JoinResult {
  /** The socket's previous world, which it left (null when none or the same). */
  leftChannelId: string | null;
  /** A socket that held the same account's player and was replaced; it should leave the room. */
  displacedSocketId: string | null;
}

/**
 * All sweepers worlds, keyed by voice channel id. Owns the single tick loop (running only while
 * at least one world is loaded): per tick it expires reconnection grace windows, broadcasts the
 * changed poses, saves every `saveIntervalMs` and unloads worlds nobody joined for `emptyRoomUnloadMs`.
 */
export class SweepersService {
  readonly #rooms = new Map<string, SweepersRoom>();
  /** socket id → channel id of the world it plays in. */
  readonly #socketRooms = new Map<string, string>();
  readonly #store: SweepersStore;
  readonly #events: SweepersEvents;
  readonly #log: Logger;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #timings: SweepersTimings;
  #cancelLoop: (() => void) | null = null;
  #disposed = false;

  constructor(options: SweepersServiceOptions) {
    this.#store = options.store;
    this.#events = options.events;
    this.#log = options.logger;
    this.#clock = options.clock ?? systemClock;
    this.#scheduler = options.scheduler ?? intervalScheduler;
    this.#timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  get tickRate(): number {
    return this.#timings.tickRate;
  }

  /** True while the tick loop is scheduled. */
  get running(): boolean {
    return this.#cancelLoop !== null;
  }

  /**
   * Puts the socket's player into the channel's world (loading or creating it) and sends it
   * `init_state`. Joining again (same socket, or a reconnect within the grace window) restores the
   * player with its short id and pose and re-sends `init_state`.
   */
  join(channelId: string, socketId: string, identity: PlayerIdentity): JoinResult {
    if (this.#disposed) throw new SweepersError(SWEEPERS_ERRORS.shuttingDown);
    const now = this.#clock.now();
    const previous = this.#socketRooms.get(socketId);
    const leftChannelId = previous !== undefined && previous !== channelId && this.leave(socketId) ? previous : null;
    const room = this.#room(channelId, identity.username, now);
    const wasConnected = room.connectedCount;
    const { player, restored, displacedSocketId, replaced } = room.attach(identity, socketId, now, (key) => this.#loadStats(key, channelId));
    if (replaced) {
      this.#saveStats(room, replaced);
      this.#events.playerLeft(channelId, replaced.id);
    }
    if (displacedSocketId !== null) {
      this.#socketRooms.delete(displacedSocketId);
      this.#events.kicked(displacedSocketId, channelId, { reason: 'displaced' });
    }
    this.#socketRooms.set(socketId, channelId);
    // The weather is advanced first so init_state carries it, but its broadcast waits until after
    // init_state: the joiner is already in the socket.io room and must never see a world event first.
    const weatherChanged = room.advanceWeather(now);
    this.#events.initState(socketId, room.initState(player, this.#timings.tickRate, now));
    this.#events.clockTo(socketId, room.clockSync(now));
    if (weatherChanged) this.#events.weather(channelId, room.weather(now));
    if (!restored) this.#events.playerJoined(channelId, player.snapshot(), socketId);
    if (room.connectedCount !== wasConnected) this.#sessionChanged(room);
    return { leftChannelId, displacedSocketId };
  }

  /** Removes the socket's player from its world for good (explicit leave). Returns the channel left. */
  leave(socketId: string, channelId?: string): string | null {
    const current = this.#socketRooms.get(socketId);
    if (current === undefined || (channelId !== undefined && channelId !== current)) return null;
    this.#socketRooms.delete(socketId);
    const room = this.#rooms.get(current);
    const player = room?.bySocket(socketId);
    if (!room || !player) return current;
    room.remove(player, this.#clock.now());
    this.#saveStats(room, player);
    this.#events.playerLeft(room.channelId, player.id);
    this.#sessionChanged(room);
    return current;
  }

  /** Keeps the socket's player for the reconnection grace window. */
  disconnect(socketId: string): void {
    const channelId = this.#socketRooms.get(socketId);
    if (channelId === undefined) return;
    this.#socketRooms.delete(socketId);
    const room = this.#rooms.get(channelId);
    if (room?.detach(socketId, this.#clock.now())) this.#sessionChanged(room);
  }

  /** Applies a client-predicted pose; the result goes out with the next tick. */
  input(socketId: string, input: PlayerInput): void {
    const room = this.#socketRooms.get(socketId) === input.channelId ? this.#rooms.get(input.channelId) : undefined;
    const player = room?.bySocket(socketId);
    if (!room || !player) throw new SweepersError(SWEEPERS_ERRORS.notInRoom, { channelId: input.channelId });
    const { channelId: _channelId, seq, ...pose } = input;
    player.applyInput(seq, pose, this.#clock.now(), room.moveWorld);
  }

  /** One tick for every loaded world. */
  tick(): void {
    const now = this.#clock.now();
    for (const room of [...this.#rooms.values()]) {
      for (const player of room.expire(now, this.#timings.reconnectGraceMs)) {
        this.#saveStats(room, player);
        this.#events.playerLeft(room.channelId, player.id);
      }
      const sync = room.takeTick(now);
      if (sync) this.#events.tickSync(room.channelId, sync);
      this.#advanceWeather(room, now);
      if (now - room.lastClockSyncAt >= this.#timings.clockSyncMs) {
        room.lastClockSyncAt = now;
        this.#events.clock(room.channelId, room.clockSync(now));
      }
      if (room.emptySince !== null && now - room.emptySince >= this.#timings.emptyRoomUnloadMs) this.#unload(room, now);
      else if (now - room.lastSavedAt >= this.#timings.saveIntervalMs) this.#save(room, now);
    }
  }

  /**
   * Adds team revenue (Ft) to a loaded world's lifetime total (producer: the Phase E weighbridge)
   * and opens the districts whose thresholds it reaches: each emits `miskolc:district_unlocked`, and
   * the world is saved at once. Returns the newly opened district ids.
   */
  addRevenue(channelId: string, amount: number): number[] {
    const room = this.#rooms.get(channelId);
    if (!room) throw new SweepersError(SWEEPERS_ERRORS.roomNotLoaded, { channelId });
    const opened = room.addRevenue(amount);
    if (opened.length === 0) return opened;
    const unlockedDistricts = room.unlockedDistricts();
    for (const district of opened) {
      this.#log.info(`MiskolcSweepers kerület megnyílt: ${channelId} / ${district}`);
      this.#events.districtUnlocked(channelId, { district, unlockedDistricts });
    }
    this.#save(room, this.#clock.now());
    return opened;
  }

  summaries(): Record<string, SweepersSessionSummary> {
    const result: Record<string, SweepersSessionSummary> = {};
    for (const [channelId, room] of this.#rooms) {
      const summary = room.summary();
      if (summary) result[channelId] = summary;
    }
    return result;
  }

  summaryOf(channelId: string): SweepersSessionSummary | null {
    return this.#rooms.get(channelId)?.summary() ?? null;
  }

  /** Loaded world of a channel (tests, later phases). */
  room(channelId: string): SweepersRoom | undefined {
    return this.#rooms.get(channelId);
  }

  /** Saves every world and stops the tick loop (application shutdown). Worlds stay loaded. */
  dispose(): void {
    this.#disposed = true;
    const now = this.#clock.now();
    for (const room of this.#rooms.values()) this.#save(room, now);
    this.#stopLoop();
  }

  #room(channelId: string, startedBy: string, now: number): SweepersRoom {
    let room = this.#rooms.get(channelId);
    if (!room) {
      room = new SweepersRoom(channelId, startedBy, this.#safely('load room', () => this.#store.loadRoom(channelId)) ?? null, now);
      this.#rooms.set(channelId, room);
      this.#log.info(`MiskolcSweepers világ betöltve: ${channelId}`);
      if (!this.#disposed) this.#cancelLoop ??= this.#scheduler(Math.round(1000 / this.#timings.tickRate), () => this.#safely('tick', () => this.tick()));
    }
    return room;
  }

  #advanceWeather(room: SweepersRoom, now: number): void {
    if (room.advanceWeather(now)) this.#events.weather(room.channelId, room.weather(now));
  }

  #unload(room: SweepersRoom, now: number): void {
    this.#save(room, now);
    this.#rooms.delete(room.channelId);
    this.#log.info(`MiskolcSweepers világ mentve és leállítva: ${room.channelId}`);
    if (this.#rooms.size === 0) this.#stopLoop();
  }

  #save(room: SweepersRoom, now: number): void {
    const players = [...room.players()].map((p) => room.statsRecord(p));
    this.#safely('save room', () => this.#store.saveRoom(room.record(now), players));
    room.lastSavedAt = now;
  }

  #saveStats(room: SweepersRoom, player: SweepersPlayer): void {
    this.#safely('save player', () => this.#store.savePlayerStats(room.statsRecord(player)));
  }

  #loadStats(userId: string, channelId: string): PersonalStats {
    return this.#safely('load player', () => this.#store.loadPlayerStats(userId, channelId)) ?? NEW_PLAYER_STATS;
  }

  #sessionChanged(room: SweepersRoom): void {
    this.#events.sessionUpdated(room.channelId, room.summary());
  }

  #stopLoop(): void {
    this.#cancelLoop?.();
    this.#cancelLoop = null;
  }

  /** Storage or loop failures are logged; the game keeps running. */
  #safely<T>(label: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.#log.error(`MiskolcSweepers ${label} failed`, err);
      return undefined;
    }
  }
}
