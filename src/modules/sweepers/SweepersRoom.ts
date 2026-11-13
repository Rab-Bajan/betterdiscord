import { cityLayout } from './city/cityLayout.ts';
import { DayClock } from './dayClock.ts';
import type { ClockSync } from './dayClock.ts';
import { JOIN_BURST_CHUNKS, LOAD_RADIUS_M, TICK_MAX_CHUNKS, TICK_MAX_LOAD_BYTES } from './debris/ChunkInterest.ts';
import { DebrisWorld } from './debris/DebrisWorld.ts';
import type { DebrisDeltas } from './debris/DebrisWorld.ts';
import { CELL_M, CHUNK_M, CHUNKS_N, GRID_ORIGIN } from './debris/grid.ts';
import { effectActive, isEmptyLoad, ownsTool, personalPayload, serialisePersonal, v1Stats } from './debris/personal.ts';
import type { PersonalData, PersonalStatePayload } from './debris/personal.ts';
import { buy } from './debris/shop.ts';
import type { BuyRequest } from './debris/shop.ts';
import { DEBRIS_GEN, KIND, KOFOLA_SPEED, FLAG_STUCK, STAMINA_MAX } from './debris/tables.ts';
import { cadenceOf, drainBuffer, kickCan, spill, tipBuffer, useTool } from './debris/tools.ts';
import type { UseResult } from './debris/tools.ts';
import { ColliderIndex, groundHeight, surfaceAt, sweepCircle } from './geometry.ts';
import { districtAt, HEX_CELLS, initialCleanliness } from './hexGrid.ts';
import { MAX_SPEED, SPEED_TOLERANCE } from './motion.ts';
import type { MoveWorld } from './motion.ts';
import type { PlayerAction, SweepHit } from './payloads.ts';
import { hashString, Rng } from './random.ts';
import { SWEEPERS_ERRORS, SweepersError } from './SweepersError.ts';
import { DISTRICT_IDS, unlockedFor } from './progression.ts';
import { parseRoomState, serialiseRoomState } from './roomState.ts';
import { WeatherScheduler } from './weather.ts';
import type { WeatherPayload } from './weather.ts';
import { encodePose } from './quantize.ts';
import { SweepersPlayer } from './SweepersPlayer.ts';
import type { PlayerIdentity } from './SweepersPlayer.ts';
import type { PlayerStatsRecord, RoomRecord } from './SweepersRepository.ts';
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

/** One socket's outgoing debris and personal messages of a tick. */
export interface PlayerTickOutput {
  socketId: string;
  debris: DebrisChunkUpdate | null;
  personal: PersonalStatePayload | null;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000 + 0;
const tooFast = (): SweepersError => new SweepersError(SWEEPERS_ERRORS.tooManyRequests, undefined, SweepersError.TOO_FAST_CODE);
const refuse = (key: keyof typeof SWEEPERS_ERRORS): SweepersError => new SweepersError(SWEEPERS_ERRORS[key], { reason: key });

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
  readonly #rng: Rng;
  #lastDebrisTickAt: number;
  /** Chunk payloads built while sizing a tick's loads, reused when they are sent. */
  readonly #chunkCache = new Map<number, ChunkLoad>();
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
    this.emptySince = now;
    const world = parseRoomState(saved?.state ?? {}, channelId);
    this.lifetimeEarned = world.lifetimeEarned;
    this.#unlocked = new Set(world.unlockedDistricts);
    this.#clock = new DayClock(world.clock, now);
    this.#weather = new WeatherScheduler(world.weather);
    this.moveWorld = cityMoveWorld(this.#unlocked);
    const c0 = HEX_CELLS.map((cell) => {
      const stored = saved?.cleanliness[String(cell.id)];
      return stored === undefined ? initialCleanliness(cell) : clampCleanliness(stored);
    });
    const seed = (hashString(`${channelId}:debris:live`) ^ (now >>> 0)) >>> 0;
    // A v2 row, or a v3 row with any invalid part, regenerates from the stored cleanliness (C.6).
    this.debris = DebrisWorld.restore(world.debris, seed) ?? DebrisWorld.generate(channelId, c0, seed);
    this.#rng = new Rng(seed ^ 0x5bd1e995);
    this.#lastDebrisTickAt = now;
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
      if (player.dirty) p.push(encodePose(player.id, player.pose, player.corrected, player.personal.toolTier));
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
      debris: { gen: DEBRIS_GEN, origin: GRID_ORIGIN, chunkM: CHUNK_M, cellM: CELL_M, n: CHUNKS_N, loadM: LOAD_RADIUS_M }
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
      debris: this.debris.record()
    });
    return { roomId: this.channelId, state, cleanliness, teamFunds: this.teamFunds, lastSaved: now };
  }

  statsRecord(player: SweepersPlayer, now: number): PlayerStatsRecord {
    return { userId: player.userId, roomId: this.channelId, stats: v1Stats(player.personal), extra: serialisePersonal(player.personal, now) };
  }

  // ---- Phase C: tools, actions, shop, debris ticks ----

  /** Applies `miskolc:sweep_hit` (C.4 checks 3–7; the room and rate checks are the caller's). */
  sweepHit(player: SweepersPlayer, hit: SweepHit, now: number): SweepAck {
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

  /** Applies `miskolc:player_action` (select, kick, dump). */
  action(player: SweepersPlayer, action: PlayerAction, now: number): void {
    const data = player.personal;
    if (action.kind === 'select') {
      if (!ownsTool(data, action.tool)) throw refuse('notOwned');
      if (action.tool === data.toolTier) return;
      this.#tipOrSpill(player);
      data.toolTier = action.tool;
      player.dirty = true;
      player.personalDirty = true;
      return;
    }
    if (action.kind === 'dump') {
      if (isEmptyLoad(data.buf) && isEmptyLoad(data.pack)) throw refuse('emptyPack');
      spill(this.debris, data.buf, player.pose.x, player.pose.z, player.pose.rotY);
      spill(this.debris, data.pack, player.pose.x, player.pose.z, player.pose.rotY);
      player.personalDirty = true;
      return;
    }
    const item = this.debris.items.get(action.id);
    if (!item || item.kind !== KIND.can || (item.flags & FLAG_STUCK) !== 0) throw refuse('unknownItem');
    if (Math.hypot(item.x - player.pose.x, item.z - player.pose.z) > KICK_REACH_M) throw refuse('tooFar');
    if (!this.#unlocked.has(districtAt(item.x, item.z))) throw refuse('lockedDistrict');
    const maxV = MAX_SPEED * SPEED_TOLERANCE * (effectActive(data, 'kofola', now) ? KOFOLA_SPEED : 1);
    if (Math.hypot(action.vx, action.vz) > maxV) throw tooFast();
    this.debris.kick(kickCan(this.debris, item, action.vx, action.vz, this.#unlocked));
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
    this.debris.tickRespawn(dt);
    for (const player of this.#players.values()) this.#tickPlayer(player, now, dt);
    const deltas = this.debris.takeDeltas();
    const out: PlayerTickOutput[] = [];
    for (const player of this.#players.values()) {
      if (player.socketId === null) continue;
      for (const chunkId of deltas.reload) player.interest.reload(chunkId);
      out.push({ socketId: player.socketId, debris: this.#debrisFor(player, deltas, now), personal: this.#personalFor(player, now) });
    }
    return out;
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
