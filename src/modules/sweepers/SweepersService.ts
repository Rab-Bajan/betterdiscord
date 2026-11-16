import type { Logger } from '../../core/logging/Logger.ts';
import type { SweepersEvents } from './SweepersBroadcaster.ts';
import { SWEEPERS_ERRORS, SweepersError } from './SweepersError.ts';
import type { PlayerIdentity, SweepersPlayer } from './SweepersPlayer.ts';
import type { SweepersStore } from './SweepersRepository.ts';
import { NEW_PLAYER_STATS, SweepersRoom } from './SweepersRoom.ts';
import type { ActionResult, BuyAck, LogisticsAck, SweepAck, TieAck } from './SweepersRoom.ts';
import type { VehicleAck } from './vehicles/VehicleWorld.ts';
import { parsePersonal } from './debris/personal.ts';
import type { PersonalData } from './debris/personal.ts';
import type { BuyRequest } from './debris/shop.ts';
import type { LogisticsAction, PlaceStructure, PlayerAction, PlayerInput, SweepHit, VehicleAction, VehicleDrive, VehicleEnter } from './payloads.ts';
import type { SweepersSessionSummary } from './types.ts';

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
    let granted = false;
    const { player, restored, displacedSocketId, replaced } = room.attach(identity, socketId, now, (key) => {
      const loaded = this.#loadStats(key, channelId, now);
      granted = loaded.granted;
      return loaded.data;
    });
    // The starter grant is persisted at once, so it is paid exactly once per stats row.
    if (granted) this.#saveStats(room, player);
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
    this.#events.debrisUpdate(socketId, room.joinBurst(player, now));
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
    const { room, player } = this.#playerOf(socketId, input.channelId);
    const { channelId: _channelId, seq, ...pose } = input;
    const now = this.#clock.now();
    // Seated (Phase F): only seq, heading and a passenger's state; the pose follows the seat.
    if (player.vehicle !== 0) {
      room.vehicles.seatedInput(player, seq, pose.rotY, pose.state);
      return;
    }
    if (player.applyInput(seq, pose, now, room.moveWorld, room.speedFactor(player, now))) room.afterInput(player, now);
  }

  /** One tool use (`miskolc:sweep_hit`); the world changes go out with the next tick. */
  sweepHit(socketId: string, hit: SweepHit): SweepAck {
    const { room, player } = this.#playerOf(socketId, hit.channelId);
    return room.sweepHit(player, hit, this.#clock.now());
  }

  /** `miskolc:player_action`: select a tool, kick a can, dump the pack; a dump into a hopper or a vehicle bed returns its kg. */
  playerAction(socketId: string, action: PlayerAction): ActionResult {
    const { room, player } = this.#playerOf(socketId, action.channelId);
    return room.action(player, action, this.#clock.now());
  }

  /** `miskolc:tie_bag`; the bag row and the personal update follow with the next tick. */
  tieBag(socketId: string, channelId: string, tier: number): TieAck {
    const { room, player } = this.#playerOf(socketId, channelId);
    return room.tieBag(player, tier, this.#clock.now());
  }

  /** `miskolc:place_structure`: places it and sends `structure_spawned` to the world at once; returns the new id. */
  placeStructure(socketId: string, request: PlaceStructure): number {
    const { room, player } = this.#playerOf(socketId, request.channelId);
    const row = room.placeStructure(player, request);
    this.#events.structureSpawned(room.channelId, { row, by: player.id });
    return row[0];
  }

  /** `miskolc:delete_structure`; the removal goes out in the next `logistics_update`. */
  deleteStructure(socketId: string, channelId: string, id: number): void {
    const { room, player } = this.#playerOf(socketId, channelId);
    room.deleteStructure(player, id);
  }

  /** `miskolc:logistics_action` (pickup, throw, clearJam, crane, telemetry, grease, generator); returns the ack. */
  logisticsAction(socketId: string, action: LogisticsAction): LogisticsAck {
    const { room, player } = this.#playerOf(socketId, action.channelId);
    return room.logisticsAction(player, action, this.#clock.now());
  }

  /** `miskolc:buy_upgrade`; returns the cash and team funds left (personal / economy updates follow with the next tick; a licence unlocks at once). */
  buyUpgrade(socketId: string, request: BuyRequest): BuyAck {
    const { room, player } = this.#playerOf(socketId, request.channelId);
    const balances = room.buyUpgrade(player, request, this.#clock.now());
    this.#announceUnlocks(room);
    return balances;
  }

  /** `miskolc:vehicle_enter`; returns the seat. */
  vehicleEnter(socketId: string, request: VehicleEnter): number {
    const { room, player } = this.#playerOf(socketId, request.channelId);
    return room.vehicleEnter(player, request.id, request.seat, this.#clock.now());
  }

  /** `miskolc:vehicle_drive`; corrections go out as the row's corr flag. */
  vehicleDrive(socketId: string, drive: VehicleDrive): void {
    const { room, player } = this.#playerOf(socketId, drive.channelId);
    room.vehicleDrive(player, drive, this.#clock.now());
  }

  /** `miskolc:vehicle_action`; returns the ack. */
  vehicleAction(socketId: string, action: VehicleAction): VehicleAck {
    const { room, player } = this.#playerOf(socketId, action.channelId);
    return room.vehicleAction(player, action, this.#clock.now());
  }

  /** Throws `notInRoom` unless the socket plays in the channel's world. */
  assertInRoom(socketId: string, channelId: string): void {
    this.#playerOf(socketId, channelId);
  }

  #playerOf(socketId: string, channelId: string): { room: SweepersRoom; player: SweepersPlayer } {
    const room = this.#socketRooms.get(socketId) === channelId ? this.#rooms.get(channelId) : undefined;
    const player = room?.bySocket(socketId);
    if (!room || !player) throw new SweepersError(SWEEPERS_ERRORS.notInRoom, { channelId });
    return { room, player };
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
      for (const out of room.tickDebris(now)) {
        if (out.debris) this.#events.debrisUpdate(out.socketId, out.debris);
        if (out.personal) this.#events.personalUpdate(out.socketId, out.personal);
        if (out.telemetry) this.#events.logisticsTelemetry(out.socketId, out.telemetry);
      }
      const logistics = room.takeLogisticsUpdate(now);
      if (logistics) this.#events.logisticsUpdate(room.channelId, logistics);
      const vehicles = room.takeVehicleUpdate(now);
      if (vehicles) this.#events.vehicleUpdate(room.channelId, vehicles);
      for (const weighed of room.takeWeighings()) this.#events.scaleWeighed(room.channelId, weighed);
      const inspection = room.takeInspection();
      if (inspection) this.#events.inspection(room.channelId, inspection);
      const economy = room.takeEconomyUpdate(now);
      if (economy) this.#events.economy(room.channelId, economy);
      this.#announceUnlocks(room);
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
   * Adds team revenue (Ft) to a loaded world's lifetime total (the weighbridge itself pays inside the room)
   * and opens the districts whose thresholds it reaches: each emits `miskolc:district_unlocked`, and
   * the world is saved at once. Returns the newly opened district ids.
   */
  addRevenue(channelId: string, amount: number): number[] {
    const room = this.#rooms.get(channelId);
    if (!room) throw new SweepersError(SWEEPERS_ERRORS.roomNotLoaded, { channelId });
    const opened = room.addRevenue(amount);
    this.#announce(room, opened);
    return opened;
  }

  /** Announces the districts a room opened by itself (weighing, coins, licence). */
  #announceUnlocks(room: SweepersRoom): void {
    this.#announce(room, room.takeOpened());
  }

  /** Each opened district emits `miskolc:district_unlocked`, then the world is saved at once. */
  #announce(room: SweepersRoom, opened: readonly number[]): void {
    if (opened.length === 0) return;
    const unlockedDistricts = room.unlockedDistricts();
    for (const district of opened) {
      this.#log.info(`MiskolcSweepers kerület megnyílt: ${room.channelId} / ${district}`);
      this.#events.districtUnlocked(room.channelId, { district, unlockedDistricts });
    }
    this.#save(room, this.#clock.now());
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
      const saved = this.#safely('load room', () => this.#store.loadRoom(channelId)) ?? null;
      const structures = this.#safely('load structures', () => this.#store.loadStructures(channelId));
      room = new SweepersRoom(channelId, startedBy, saved, now, structures ?? []);
      // An unread structure table must never be replaced by this room's (incomplete) set.
      if (structures === undefined) room.structuresUnreadable = true;
      for (const warning of room.loadWarnings) this.#log.warn(`MiskolcSweepers ${channelId}: ${warning}`);
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
    const players = [...room.players()].map((p) => room.statsRecord(p, now));
    const structures = room.structureRecords();
    const saved = this.#safely('save room', () => { this.#store.saveRoom(room.record(now), players, structures); return true; });
    // A failed save keeps the structure changes pending for the next one.
    if (!saved && structures) room.logistics.markStructuresDirty();
    room.lastSavedAt = now;
  }

  #saveStats(room: SweepersRoom, player: SweepersPlayer): void {
    this.#safely('save player', () => this.#store.savePlayerStats(room.statsRecord(player, this.#clock.now())));
  }

  /** The stored personal state (with the starter grant applied when due), or a fresh one; a failed read refuses the join so the real row is never overwritten. */
  #loadStats(userId: string, channelId: string, now: number): { data: PersonalData; granted: boolean } {
    const stored = this.#safely('load player', () => this.#store.loadPlayerStats(userId, channelId));
    if (stored === undefined) throw new SweepersError(SWEEPERS_ERRORS.shuttingDown);
    return parsePersonal(stored?.stats ?? NEW_PLAYER_STATS, stored?.extra ?? null, now);
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
