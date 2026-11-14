import { cityLayout } from './city/cityLayout.ts';
import { DayClock } from './dayClock.ts';
import type { ClockSync } from './dayClock.ts';
import { JOIN_BURST_CHUNKS, LOAD_RADIUS_M, TICK_MAX_CHUNKS, TICK_MAX_LOAD_BYTES } from './debris/ChunkInterest.ts';
import { DebrisWorld } from './debris/DebrisWorld.ts';
import type { DebrisDeltas } from './debris/DebrisWorld.ts';
import { CELL_M, CHUNK_M, CHUNKS_N, GRID_ORIGIN } from './debris/grid.ts';
import { effectActive, emptyLoad, isEmptyLoad, loadKg, loadL, ownsTool, personalPayload, serialisePersonal, v1Stats } from './debris/personal.ts';
import type { PersonalData, PersonalStatePayload } from './debris/personal.ts';
import { buy } from './debris/shop.ts';
import type { BuyRequest } from './debris/shop.ts';
import { DEBRIS_GEN, KIND, KOFOLA_SPEED, FLAG_STUCK, STAMINA_MAX } from './debris/tables.ts';
import { cadenceOf, drainBuffer, kickCan, moveLoad, spill, tipBuffer, useTool } from './debris/tools.ts';
import type { UseResult } from './debris/tools.ts';
import { groundHeight, surfaceAt, sweepCircle } from './geometry.ts';
import type { ColliderIndex } from './geometry.ts';
import { centreDistance, footprintDistance, LogisticsWorld } from './logistics/LogisticsWorld.ts';
import type { LogisticsTelemetry, LogisticsUpdate, StructRow, ThrowResult } from './logistics/LogisticsWorld.ts';
import { encodeLogistics, loadStructures, restoreLogistics, structureRecords } from './logistics/persist.ts';
import { checkPlacement, PLACE_REACH_M } from './logistics/placement.ts';
import type { PlaceSpec } from './logistics/placement.ts';
import { inRect } from './logistics/shapes.ts';
import {
  bagTier, BIG_BAG, CAP_NAMES, CAPS, CLEAR_JAM_REACH_M, CRANE, PICKUP_HEIGHT_M, PICKUP_REACH_M, TELEMETRY_OFF_M, TELEMETRY_ON_M, TIE_CADENCE_MS
} from './logistics/tables.ts';
import { districtAt, HEX_CELLS, initialCleanliness } from './hexGrid.ts';
import { MAX_SPEED, SPEED_TOLERANCE } from './motion.ts';
import type { MoveWorld } from './motion.ts';
import type { LogisticsAction, PlayerAction, SweepHit } from './payloads.ts';
import { hashString, Rng } from './random.ts';
import { refusal, SWEEPERS_ERRORS, SweepersError } from './SweepersError.ts';
import { DISTRICT_IDS, unlockedFor } from './progression.ts';
import { parseRoomState, serialiseRoomState } from './roomState.ts';
import { WeatherScheduler } from './weather.ts';
import type { WeatherPayload } from './weather.ts';
import { encodePose } from './quantize.ts';
import { SweepersPlayer } from './SweepersPlayer.ts';
import type { PlayerIdentity } from './SweepersPlayer.ts';
import type { PlayerStatsRecord, RoomRecord, WorldStructureRecord } from './SweepersRepository.ts';
import type {
  ChunkLoad, DebrisChunkUpdate, HexSnapshot, InitStatePayload, PersonalStats, PlayerSnapshot, PlayerTickRow, Pose, SweepersSessionSummary,
  TickSyncPayload
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

/** A `sweep_hit` origin may be this far from the authoritative pose, m. */
export const SWEEP_MAX_OFFSET_M = 1.5;
/** A use is accepted this share of its cadence after the previous one of the same kind. */
export const CADENCE_TOLERANCE = 0.8;
/** A kick needs the player this close to the can, m. */
export const KICK_REACH_M = 1.2;
export const ACID_STAMINA = 200;
export const ACID_COOLDOWN_MS = 3_000;
/** Stamina regeneration (tenths / s) by state, from 1 s after the last use. */
export const REGEN_DELAY_MS = 1_000;
export const REGEN_IDLE = 30;
export const REGEN_WALK = 20;
/** Stamina-only personal updates at most this often. */
export const STAMINA_UPDATE_MS = 500;
/** Longest tick step credited to timers (no catch-up after a stall). */
const MAX_TICK_STEP_MS = 1_000;

/** Sweep ack (`{ ok: true, seq, kg, items, pushed }`). */
export interface SweepAck extends UseResult {
  ok: true;
  seq: number;
}

/** One socket's outgoing debris, personal and telemetry messages of a tick. */
export interface PlayerTickOutput {
  socketId: string;
  debris: DebrisChunkUpdate | null;
  personal: PersonalStatePayload | null;
  /** 1 Hz to subscribed sockets (Phase D). */
  telemetry: LogisticsTelemetry | null;
}

/** `tie_bag` ack. */
export interface TieAck {
  ok: true;
  id: number;
  tier: number;
  kg: number;
}

/** Telemetry is sent this often to subscribers, ms. */
export const TELEMETRY_MS = 1_000;

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const tooFast = (): SweepersError => new SweepersError(SWEEPERS_ERRORS.tooManyRequests, undefined, SweepersError.TOO_FAST_CODE);
const refuse = refusal;

/** The movement rules of the city with the given open districts and colliders (both read live). */
function cityMoveWorld(unlocked: ReadonlySet<number>, colliders: () => ColliderIndex): MoveWorld {
  const layout = cityLayout();
  return {
    ground: (x, z) => groundHeight(layout.heightfield, x, z),
    isOpen: (x, z) => unlocked.has(districtAt(x, z)),
    sweep: (fromX, fromZ, toX, toZ) => sweepCircle(colliders(), fromX, fromZ, toX, toZ)
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
  /** A new room has no players yet, so it counts as empty from its creation. */
  emptySince: number | null;
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
  /** The room's debris (Phase C); hex cleanliness derives from it. */
  readonly debris: DebrisWorld;
  /** The logistics network (Phase D). */
  readonly logistics: LogisticsWorld;
  /** Rupture draw (64); tests replace it. */
  logisticsChance: (p: number) => boolean;
  /** Rows dropped while loading the network (the service logs them). */
  readonly loadWarnings: string[];
  /** The stored structure rows could not be read: structure saves are skipped so they are never overwritten. */
  structuresUnreadable = false;
  readonly #telemetry = new Set<number>();
  #telemetryAt = -Infinity;
  #logisticsBlob: Record<string, unknown> | null = null;
  readonly #rng: Rng;
  #lastDebrisTickAt: number;
  /** Chunk payloads built while sizing a tick's loads, reused when they are sent. */
  readonly #chunkCache = new Map<number, ChunkLoad>();
  readonly #players = new Map<number, SweepersPlayer>();
  readonly #byKey = new Map<string, SweepersPlayer>();
  readonly #bySocket = new Map<string, SweepersPlayer>();
  #gone: number[] = [];
  #nextId = 1;

  constructor(channelId: string, startedBy: string | null, saved: RoomRecord | null, now: number, structures: readonly WorldStructureRecord[] = []) {
    this.channelId = channelId;
    this.startedBy = startedBy;
    this.teamFunds = saved?.teamFunds ?? 0;
    this.lastSavedAt = now;
    this.lastClockSyncAt = now;
    this.emptySince = now;
    const world = parseRoomState(saved?.state ?? {}, channelId);
    this.lifetimeEarned = world.lifetimeEarned;
    this.#unlocked = new Set(world.unlockedDistricts);
    this.#clock = new DayClock(world.clock, now);
    this.#weather = new WeatherScheduler(world.weather);
    this.moveWorld = cityMoveWorld(this.#unlocked, () => this.logistics.colliders);
    const c0 = HEX_CELLS.map((cell) => {
      const stored = saved?.cleanliness[String(cell.id)];
      return stored === undefined ? initialCleanliness(cell) : clampCleanliness(stored);
    });
    const seed = (hashString(`${channelId}:debris:live`) ^ (now >>> 0)) >>> 0;
    // A v2 row, or a v3 row with any invalid part, regenerates from the stored cleanliness (C.6).
    this.debris = DebrisWorld.restore(world.debris, seed) ?? DebrisWorld.generate(channelId, c0, seed);
    this.#rng = new Rng(seed ^ 0x5bd1e995);
    this.#lastDebrisTickAt = now;
    const logisticsRng = new Rng(hashString(`${channelId}:logistics:${now}`));
    this.logisticsChance = (p) => logisticsRng.chance(p);
    const layout = cityLayout();
    this.logistics = new LogisticsWorld({ debris: this.debris, layout, unlocked: this.#unlocked, chance: (p) => this.logisticsChance(p) });
    this.loadWarnings = [
      ...loadStructures(this.logistics, { layout, ground: (x, z) => groundHeight(layout.heightfield, x, z), unlocked: this.#unlocked, layoutColliders: this.debris.grid.colliders }, structures, channelId),
      ...restoreLogistics(this.logistics, world.logistics)
    ];
    this.debris.respawnFactor = (hex) => this.logistics.fenceFactor(hex);
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
  attach(identity: PlayerIdentity, socketId: string, now: number, loadStats: (key: string) => PersonalData): AttachResult {
    let key = identity.key;
    let existing = this.#byKey.get(key);
    if (existing?.connected && existing.socketId !== socketId && identity.accountId === null) {
      key = `${identity.key}#${socketId}`;
      existing = this.#byKey.get(key);
    }
    // The socket can play only one player: a different previous one (identity change, or a guest
    // name taking over a disconnected record) is removed, never left behind as a ghost.
    // Loaded before any mutation: a throwing load (failed DB read) must leave the room unchanged.
    const stats = existing ? null : loadStats(identity.key);
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
    if (stats === null) throw new Error('unreachable: stats are loaded for every new player');
    const id = this.#nextId++;
    const player = new SweepersPlayer(id, key, identity, socketId, spawnPose(id), stats, now);
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
    this.#telemetry.delete(player.id);
    player.detach(now);
    if (this.#bySocket.size === 0) this.emptySince = now;
    return player;
  }

  /** Removes a player for good (a carried bag drops at the last pose); its id is reported in the next tick's `gone`. */
  remove(player: SweepersPlayer, now: number): void {
    if (this.#players.get(player.id) !== player) return;
    const carried = this.logistics.bags.get(player.carry);
    if (carried?.st === 1) this.logistics.dropCarried(carried, player.pose);
    player.carry = 0;
    this.#telemetry.delete(player.id);
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
      if (player.dirty) p.push(encodePose(player.id, player.pose, player.corrected, player.personal.toolTier, player.carry));
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
      id: cell.id, q: cell.q, r: cell.r, district: cell.district, cleanliness: this.debris.c10(cell.id) / 10
    }));
  }

  playerSnapshots(): PlayerSnapshot[] {
    return [...this.#players.values()].map((p) => p.snapshot());
  }

  initState(self: SweepersPlayer, tickRate: number, now: number): InitStatePayload {
    // init_state carries the full personal state: nothing is pending for the next tick.
    self.personalDirty = false;
    self.staminaSent = Math.round(self.personal.stamina);
    self.staminaSentAt = now;
    return {
      roomId: this.channelId,
      selfId: self.id,
      tickRate,
      serverTime: now,
      players: this.playerSnapshots(),
      hexes: this.hexSnapshots(),
      teamFunds: this.teamFunds,
      personal: personalPayload(self.personal, now),
      layout: cityLayout(),
      unlockedDistricts: this.unlockedDistricts(),
      lifetimeEarned: this.lifetimeEarned,
      clock: this.#clock.state(now),
      weather: this.weather(now),
      debris: { gen: DEBRIS_GEN, origin: GRID_ORIGIN, chunkM: CHUNK_M, cellM: CELL_M, n: CHUNKS_N, loadM: LOAD_RADIUS_M },
      logistics: this.logistics.initPayload()
    };
  }

  /** Session summary, or null when nobody is connected. */
  summary(): SweepersSessionSummary | null {
    if (this.connectedCount === 0) return null;
    return { active: true, startedBy: this.startedBy, playerCount: this.connectedCount };
  }

  record(now: number): RoomRecord {
    const cleanliness: Record<string, number> = {};
    for (const cell of HEX_CELLS) cleanliness[String(cell.id)] = this.debris.c10(cell.id) / 10;
    const state = serialiseRoomState({
      lifetimeEarned: this.lifetimeEarned,
      unlockedDistricts: this.unlockedDistricts(),
      clock: this.#clock.read(now),
      weather: this.#weather.record(),
      debris: this.debris.record(),
      logistics: this.#logisticsRecord()
    });
    return { roomId: this.channelId, state, cleanliness, teamFunds: this.teamFunds, lastSaved: now };
  }

  statsRecord(player: SweepersPlayer, now: number): PlayerStatsRecord {
    return { userId: player.userId, roomId: this.channelId, stats: v1Stats(player.personal), extra: serialisePersonal(player.personal, now) };
  }

  // ---- Phase C: tools, actions, shop, debris ticks ----

  /** Applies `miskolc:sweep_hit` (C.4 checks 3–7; the room and rate checks are the caller's). */
  sweepHit(player: SweepersPlayer, hit: SweepHit, now: number): SweepAck {
    if (player.carry !== 0) throw refuse('handsFull');
    const data = player.personal;
    if (hit.tool !== data.toolTier) throw refuse('notEquipped');
    if (hit.seq <= player.sweepSeq) throw tooFast();
    const slot = hit.alt ? 1 : 0;
    if (now - player.lastUseAt[slot] < CADENCE_TOLERANCE * cadenceOf(hit.tool, hit.alt) * 1000) throw tooFast();
    player.sweepSeq = hit.seq;
    if (Math.hypot(hit.x - player.pose.x, hit.z - player.pose.z) > SWEEP_MAX_OFFSET_M) throw refuse('tooFar');
    if (!this.#unlocked.has(districtAt(hit.x, hit.z))) throw refuse('lockedDistrict');
    const before = this.#signature(data, now);
    const result = useTool({
      world: this.debris, data, now, unlocked: this.#unlocked, drizzle: this.#weather.kind === 'drizzle', chance: (p) => this.#rng.chance(p)
    }, hit.tool, hit.alt, hit.x, hit.z, hit.rotY);
    player.lastUseAt[slot] = now;
    if (this.#signature(data, now) !== before) player.personalDirty = true;
    return { ok: true, seq: hit.seq, kg: r3(result.kg), items: result.items, pushed: result.pushed };
  }

  /** Applies `miskolc:player_action` (select, kick, dump); a dump into a hopper returns the kg moved, else null. */
  action(player: SweepersPlayer, action: PlayerAction, now: number): number | null {
    const data = player.personal;
    if (action.kind === 'select') {
      if (!ownsTool(data, action.tool)) throw refuse('notOwned');
      if (action.tool === data.toolTier) return null;
      this.#tipOrSpill(player);
      data.toolTier = action.tool;
      player.dirty = true;
      player.personalDirty = true;
      return null;
    }
    if (action.kind === 'dump') {
      if (isEmptyLoad(data.buf) && isEmptyLoad(data.pack)) throw refuse('emptyPack');
      const hopper = this.logistics.hopperAt(player.pose.x, player.pose.z);
      if (hopper !== null) {
        const moved = this.logistics.fillHopper(hopper, data.buf) + this.logistics.fillHopper(hopper, data.pack);
        if (moved <= 1e-6) throw refuse('hopperFull');
        player.personalDirty = true;
        return r3(moved);
      }
      spill(this.debris, data.buf, player.pose.x, player.pose.z, player.pose.rotY);
      spill(this.debris, data.pack, player.pose.x, player.pose.z, player.pose.rotY);
      player.personalDirty = true;
      return null;
    }
    const item = this.debris.items.get(action.id);
    if (!item || item.kind !== KIND.can || (item.flags & FLAG_STUCK) !== 0) throw refuse('unknownItem');
    if (Math.hypot(item.x - player.pose.x, item.z - player.pose.z) > KICK_REACH_M) throw refuse('tooFar');
    if (!this.#unlocked.has(districtAt(item.x, item.z))) throw refuse('lockedDistrict');
    const maxV = MAX_SPEED * SPEED_TOLERANCE * (effectActive(data, 'kofola', now) ? KOFOLA_SPEED : 1);
    if (Math.hypot(action.vx, action.vz) > maxV) throw tooFast();
    this.debris.kick(kickCan(this.debris, item, action.vx, action.vz, this.#unlocked));
    return null;
  }

  /** Applies `miskolc:buy_upgrade`; returns the cash left. */
  buyUpgrade(player: SweepersPlayer, request: BuyRequest, now: number): number {
    buy(player.personal, request, cityLayout(), player.pose.x, player.pose.z, now);
    player.personalDirty = true;
    return player.personal.cash;
  }

  /** Speed factor of the movement budget (Kofola). */
  speedFactor(player: SweepersPlayer, now: number): number {
    return effectActive(player.personal, 'kofola', now) ? KOFOLA_SPEED : 1;
  }

  /** After an accepted input: acid costs 20 stamina, at most once per 3 s (C.3 hazards). */
  afterInput(player: SweepersPlayer, now: number): void {
    if (now - player.lastAcidAt < ACID_COOLDOWN_MS) return;
    if (surfaceAt(cityLayout().surfaces, player.pose.x, player.pose.z) !== 'acid') return;
    player.lastAcidAt = now;
    player.personal.stamina = Math.max(0, player.personal.stamina - ACID_STAMINA);
    player.personalDirty = true;
  }

  /** The first burst for a joining socket: the 32 nearest chunks of its interest. */
  joinBurst(player: SweepersPlayer, now: number): DebrisChunkUpdate {
    player.interest.update(player.pose.x, player.pose.z);
    const load = this.#loads(player.interest.take(JOIN_BURST_CHUNKS, Infinity, () => 0));
    return { t: now, load };
  }

  /**
   * One debris tick: respawn step, buffer drains, stamina regeneration, then per connected socket the
   * interest loads / drops (≤ 16 chunks, ≤ 8 kB) with the room-wide deltas (≤ 8 kB), and the personal
   * updates (every change once per tick, stamina-only every 500 ms).
   */
  tickDebris(now: number): PlayerTickOutput[] {
    const dt = Math.min(MAX_TICK_STEP_MS, Math.max(0, now - this.#lastDebrisTickAt));
    this.#lastDebrisTickAt = now;
    this.logistics.rebuildColliders();
    this.logistics.tick(dt, now);
    this.debris.tickRespawn(dt);
    const telemetry = this.#telemetryDue(now) ? this.logistics.telemetry() : null;
    for (const player of this.#players.values()) this.#tickPlayer(player, now, dt);
    const deltas = this.debris.takeDeltas();
    const out: PlayerTickOutput[] = [];
    for (const player of this.#players.values()) {
      if (player.socketId === null) continue;
      for (const chunkId of deltas.reload) player.interest.reload(chunkId);
      out.push({
        socketId: player.socketId, debris: this.#debrisFor(player, deltas, now), personal: this.#personalFor(player, now),
        telemetry: telemetry && this.#telemetry.has(player.id) ? telemetry : null
      });
    }
    return out;
  }

  // ---- Phase D: bags, building, logistics ----

  /** Applies `miskolc:tie_bag` (D.4 checks 3–9; the room and rate checks are the caller's). */
  tieBag(player: SweepersPlayer, tier: number, now: number): TieAck {
    if (player.carry !== 0) throw refuse('handsFull');
    if (now - player.lastTieAt < CADENCE_TOLERANCE * TIE_CADENCE_MS) throw tooFast();
    const pose = player.pose;
    if (!this.#unlocked.has(districtAt(pose.x, pose.z))) throw refuse('lockedDistrict');
    const data = player.personal;
    if (isEmptyLoad(data.buf) && isEmptyLoad(data.pack)) throw refuse('emptyPack');
    const fill = tier === BIG_BAG ? this.logistics.bigBagNear(pose.x, pose.z) : null;
    if (!fill && (data.bags[tier] ?? 0) < 1) throw refuse('noBags');
    if (!fill && this.logistics.bagCount >= CAPS.bags) throw refuse('tooManyBags');
    const spec = bagTier(tier);
    // Dry run on copies: refused requests change nothing.
    const copy = { ...data, buf: { ...data.buf, jackpots: [...data.buf.jackpots] }, pack: { ...data.pack, jackpots: [...data.pack.jackpots] } };
    tipBuffer(copy);
    const probe = fill ? { ...fill.load, jackpots: [...fill.load.jackpots] } : emptyLoad();
    if (moveLoad(copy.pack, probe, spec.kg - loadKg(probe), spec.l - loadL(probe)) <= 1e-6) throw refuse('bagTooSmall');
    tipBuffer(data);
    const load = fill ? fill.load : emptyLoad();
    const kg = moveLoad(data.pack, load, spec.kg - loadKg(load), spec.l - loadL(load));
    let id: number;
    if (fill) {
      this.logistics.touchBag(fill);
      id = fill.id;
    } else {
      const dir = { x: -Math.sin(pose.rotY), z: -Math.cos(pose.rotY) };
      const at = this.debris.openToward(pose.x + dir.x * 0.6, pose.z + dir.z * 0.6, pose.x, pose.z, this.#unlocked) ?? { x: pose.x, z: pose.z };
      const bag = this.logistics.newBag(tier, load, at.x, at.z, pose.rotY, dir.x, dir.z);
      if (!bag) throw refuse('tooManyBags');
      data.bags[tier] = (data.bags[tier] ?? 0) - 1;
      id = bag.id;
    }
    player.lastTieAt = now;
    player.personalDirty = true;
    return { ok: true, id, tier, kg: Math.round(kg * 100) / 100 + 0 };
  }

  /** Applies `miskolc:place_structure` (D.3 rules 2–7); returns the new row for `structure_spawned`. */
  placeStructure(player: SweepersPlayer, spec: PlaceSpec): StructRow {
    const layout = cityLayout();
    const base = checkPlacement({
      layout,
      ground: (x, z) => groundHeight(layout.heightfield, x, z),
      unlocked: this.#unlocked,
      layoutColliders: this.debris.grid.colliders,
      structures: [...this.logistics.structures.values()],
      groundBags: [...this.logistics.bags.values()].filter((b) => b.st === 0).map((b) => ({ x: b.x, z: b.z, r: bagTier(b.tier).r })),
      players: [...this.#players.values()].map((p) => p.pose)
    }, spec, player.pose);
    const st = this.logistics.add(spec, base);
    if (!st) throw new SweepersError(SWEEPERS_ERRORS.buildLimit.replace('{what}', CAP_NAMES.structures), { reason: 'buildLimit' });
    return this.logistics.structRow(st);
  }

  /** Applies `miskolc:delete_structure` (D.3 rule 8); the removal goes out in the next `logistics_update`. */
  deleteStructure(player: SweepersPlayer, id: number): void {
    const st = this.logistics.structures.get(id);
    if (!st) throw refuse('unknownStructure');
    if (centreDistance(st, player.pose.x, player.pose.z) > PLACE_REACH_M) throw refuse('tooFar');
    if (this.logistics.supportsStructures(st)) throw refuse('supportsStructures');
    this.logistics.remove(id);
  }

  /** Applies `miskolc:logistics_action`; returns the ack. */
  logisticsAction(player: SweepersPlayer, action: LogisticsAction, now: number): { ok: true } | ({ ok: true } & ThrowResult) | { ok: true; durMs: number } {
    const pose = player.pose;
    const world = this.logistics;
    switch (action.kind) {
      case 'pickup': {
        if (player.carry !== 0) throw refuse('handsFull');
        const bag = world.bags.get(action.id);
        if (bag && bag.tier > 1) throw refuse('bigBagCrane');
        const at = bag && ((bag.st === 0 && world.onTop(bag)) || bag.st === 3) ? world.bagPosition(bag) : null;
        if (!bag || !at || Math.hypot(at.x - pose.x, at.z - pose.z) > PICKUP_REACH_M
          || Math.abs(at.y - groundHeight(cityLayout().heightfield, pose.x, pose.z)) > PICKUP_HEIGHT_M) throw refuse('noBagNear');
        world.pickUp(bag, player.id);
        player.carry = bag.id;
        player.dirty = true;
        return { ok: true };
      }
      case 'throw': {
        const bag = world.bags.get(player.carry);
        if (player.carry === 0 || bag?.st !== 1) throw refuse('notCarrying');
        const result = world.throwBag(bag, pose, action.power, action.pitch, action.rotY);
        player.carry = 0;
        player.dirty = true;
        return { ok: true, ...result };
      }
      case 'clearJam': {
        const st = world.structures.get(action.id);
        if (!st || !world.isJammed(st.id)) throw refuse('notJammed');
        if (player.personal.toolTier > 3) throw refuse('needBroom');
        if (footprintDistance(st, pose.x, pose.z) > CLEAR_JAM_REACH_M) throw refuse('tooFar');
        world.clearJam(st.id);
        return { ok: true };
      }
      case 'crane': {
        if (Math.hypot(pose.x - CRANE.console.x, pose.z - CRANE.console.z) > CRANE.consoleReachM) throw refuse('notAtCrane');
        if (world.craneJob) throw refuse('craneBusy');
        const bag = world.bags.get(action.bag);
        if (!bag || bag.st !== 0 || !world.onTop(bag) || !inRect(CRANE.area, bag.x, bag.z)) throw refuse('notInCraneArea');
        const target = CRANE.targets[action.to] ?? { x: 0, z: 0 };
        for (const other of world.bags.values()) {
          if (other.st === 0 && Math.hypot(other.x - target.x, other.z - target.z) <= CRANE.targetClearM) throw refuse('craneTargetBusy');
        }
        return { ok: true, durMs: world.startCrane(bag, action.to, now) };
      }
      case 'telemetry': {
        if (!action.on) {
          this.#telemetry.delete(player.id);
          return { ok: true };
        }
        const office = cityLayout().landmarks.office;
        if (Math.hypot(pose.x - office.x, pose.z - office.z) > TELEMETRY_ON_M) throw refuse('notAtTerminal');
        this.#telemetry.add(player.id);
        this.#telemetryAt = -Infinity;
        return { ok: true };
      }
    }
  }

  /** The coalesced `logistics_update` of this tick, or null. */
  takeLogisticsUpdate(now: number): LogisticsUpdate | null {
    return this.logistics.takeUpdate(now);
  }

  /** The structure rows when they changed since the last call (persistence), else null. */
  structureRecords(): WorldStructureRecord[] | null {
    if (this.structuresUnreadable) return null;
    return this.logistics.takeStructuresDirty() ? structureRecords(this.logistics, this.channelId) : null;
  }

  /** True once a second while anyone subscribes; subscribers further than 12 m from the office are dropped first. */
  #telemetryDue(now: number): boolean {
    const office = cityLayout().landmarks.office;
    for (const id of [...this.#telemetry]) {
      const p = this.#players.get(id);
      if (!p || p.socketId === null || Math.hypot(p.pose.x - office.x, p.pose.z - office.z) > TELEMETRY_OFF_M) this.#telemetry.delete(id);
    }
    if (this.#telemetry.size === 0 || now - this.#telemetryAt < TELEMETRY_MS) return false;
    this.#telemetryAt = now;
    return true;
  }

  /** The v4 `logistics` blob, re-encoded only when the network changed or a bag is carried. */
  #logisticsRecord(): Record<string, unknown> {
    const carrying = [...this.#players.values()].some((p) => p.carry !== 0);
    if (this.#logisticsBlob && !this.logistics.takeChanged() && !carrying) return this.#logisticsBlob;
    const layout = cityLayout();
    this.#logisticsBlob = encodeLogistics(this.logistics, (id) => {
      const p = this.#players.get(id);
      return p ? { x: p.pose.x, y: groundHeight(layout.heightfield, p.pose.x, p.pose.z), z: p.pose.z } : null;
    });
    return this.#logisticsBlob;
  }

  #tickPlayer(player: SweepersPlayer, now: number, dt: number): void {
    const data = player.personal;
    if (drainBuffer(data, dt)) player.personalDirty = true;
    if (now - player.lastAnyUseAt < REGEN_DELAY_MS || data.stamina >= STAMINA_MAX) return;
    const rate = player.pose.state === 'IDLE' ? REGEN_IDLE : player.pose.state === 'WALK' ? REGEN_WALK : 0;
    if (rate > 0) data.stamina = Math.min(STAMINA_MAX, data.stamina + (rate * dt) / 1000);
  }

  #debrisFor(player: SweepersPlayer, deltas: DebrisDeltas, now: number): DebrisChunkUpdate | null {
    const drop = player.interest.update(player.pose.x, player.pose.z);
    const load = this.#loads(player.interest.take(TICK_MAX_CHUNKS, TICK_MAX_LOAD_BYTES, (id) => this.#chunkBytes(id)));
    const update: DebrisChunkUpdate = { t: now };
    if (load.length > 0) update.load = load;
    if (drop.length > 0) update.drop = drop;
    if (deltas.cells.length > 0) update.cells = deltas.cells;
    if (deltas.add.length > 0) update.add = deltas.add;
    if (deltas.del.length > 0) update.del = deltas.del;
    if (deltas.kicks.length > 0) update.kicks = deltas.kicks;
    if (deltas.hx.length > 0) update.hx = deltas.hx;
    return Object.keys(update).length > 1 ? update : null;
  }

  #personalFor(player: SweepersPlayer, now: number): PersonalStatePayload | null {
    const stamina = Math.round(player.personal.stamina);
    const staminaDue = stamina !== player.staminaSent && now - player.staminaSentAt >= STAMINA_UPDATE_MS;
    if (!player.personalDirty && !staminaDue) return null;
    player.personalDirty = false;
    player.staminaSent = stamina;
    player.staminaSentAt = now;
    return personalPayload(player.personal, now);
  }

  #loads(chunkIds: readonly number[]): ChunkLoad[] {
    const loads = chunkIds.map((id) => this.#chunkCache.get(id) ?? this.debris.chunkPayload(id));
    this.#chunkCache.clear();
    return loads;
  }

  /** JSON size of a chunk's load entry (cached until the next `#loads`). */
  #chunkBytes(chunkId: number): number {
    let load = this.#chunkCache.get(chunkId);
    if (!load) {
      load = this.debris.chunkPayload(chunkId);
      this.#chunkCache.set(chunkId, load);
    }
    return JSON.stringify(load).length + 1;
  }

  /** Switching tool tips the buffer into the pack; what does not fit is dropped at the player's feet. */
  #tipOrSpill(player: SweepersPlayer): void {
    const data = player.personal;
    tipBuffer(data);
    if (!isEmptyLoad(data.buf)) spill(this.debris, data.buf, player.pose.x, player.pose.z, player.pose.rotY);
  }

  /** The personal payload without stamina: a use that changed only stamina waits for the 500 ms stamina update. */
  #signature(data: PersonalData, now: number): string {
    const { stamina: _stamina, ...rest } = personalPayload(data, now);
    return JSON.stringify(rest);
  }
}
