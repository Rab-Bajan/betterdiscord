// MiskolcSweepers wire protocol (Phases A–C). Units: metres, y-up, rotation in radians.
// Later phases extend these shapes; they never rename a field or an event.

import type { CityLayout } from './city/layoutTypes.ts';
import type { ClockState } from './dayClock.ts';
import type { ItemRow, KickRow } from './debris/DebrisWorld.ts';
import type { PersonalStatePayload } from './debris/personal.ts';
import type { WeatherPayload } from './weather.ts';

/** Animation / activity state of a player; the index of each entry is the protocol value. */
export const PLAYER_ANIM_STATES = Object.freeze([
  'IDLE', 'WALK', 'SPRINT', 'SWEEPING_ARCS', 'HOLDING_BAG', 'OPERATING_VACUUM', 'DRIVING_VEHICLE', 'PUSHING_CART'
] as const);

export type PlayerAnimState = (typeof PLAYER_ANIM_STATES)[number];

/** Socket.io event names. */
export const SWEEPERS_EVENTS = Object.freeze({
  joinRoom: 'miskolc:join_room',
  leaveRoom: 'miskolc:leave_room',
  playerInput: 'miskolc:player_input',
  initState: 'miskolc:init_state',
  tickSync: 'miskolc:tick_sync',
  playerJoined: 'miskolc:player_joined',
  playerLeft: 'miskolc:player_left',
  sessionUpdated: 'miskolc:session-updated',
  kicked: 'miskolc:kicked',
  districtUnlocked: 'miskolc:district_unlocked',
  clock: 'miskolc:clock',
  weather: 'miskolc:weather',
  sweepHit: 'miskolc:sweep_hit',
  playerAction: 'miskolc:player_action',
  buyUpgrade: 'miskolc:buy_upgrade',
  debrisChunkUpdate: 'miskolc:debris_chunk_update',
  personalUpdate: 'miskolc:personal_update'
} as const);

/** Position, heading and activity of a player. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  rotY: number;
  state: PlayerAnimState;
}

/** A player as other clients see it (`init_state.players`, `player_joined`). */
export interface PlayerSnapshot extends Pose {
  /** Room-local short id, stable across a reconnect within the grace window. */
  id: number;
  accountId: string | null;
  username: string;
  avatarColor: string;
  /** Equipped tool 0..7 (Phase C). */
  tool: number;
}

/** One hex of the 37-hex district grid. */
export interface HexSnapshot {
  id: number;
  q: number;
  r: number;
  /** 0 = Központi MÉH Telep (centre), 1..5 = ring districts. */
  district: number;
  /** 0..100 */
  cleanliness: number;
}

/** Persistent per-player progress (`miskolc_player_stats`). */
export interface PersonalStats {
  cash: number;
  toolTier: number;
  backpackTier: number;
  totalKg: number;
}

/** `miskolc:init_state`, sent to the joining socket only. */
export interface InitStatePayload {
  roomId: string;
  selfId: number;
  tickRate: number;
  serverTime: number;
  players: PlayerSnapshot[];
  hexes: HexSnapshot[];
  teamFunds: number;
  /** Phase A fields (cash, toolTier, backpackTier, totalKg) plus the Phase C personal state. */
  personal: PersonalStatePayload;
  /** The city (identical for every room). */
  layout: CityLayout;
  /** Open district ids, ascending, always containing 0. */
  unlockedDistricts: number[];
  /** Team lifetime revenue, Ft. */
  lifetimeEarned: number;
  clock: ClockState;
  weather: WeatherPayload;
  /** Debris grid geometry (Phase C). */
  debris: DebrisInfo;
}

/** `init_state.debris`: the chunk grid the client mirrors. */
export interface DebrisInfo {
  gen: number;
  origin: number;
  chunkM: number;
  cellM: number;
  /** Chunks per axis. */
  n: number;
  /** Load radius, m. */
  loadM: number;
}

/** One full chunk: id, base64 of the 256 cell bytes (dust << 4 | seed), item rows. */
export interface ChunkLoad {
  id: number;
  c: string;
  i: ItemRow[];
}

/** `miskolc:debris_chunk_update` (per socket): interest loads / drops plus the room-wide deltas. */
export interface DebrisChunkUpdate {
  t: number;
  load?: ChunkLoad[];
  drop?: number[];
  /** Flat triplets [chunkId, cellIdx, byte]. */
  cells?: number[];
  add?: ItemRow[];
  del?: number[];
  kicks?: KickRow[];
  /** [hexId, c10]. */
  hx?: Array<[number, number]>;
}

/** `miskolc:district_unlocked`, to the world when a district opens. */
export interface DistrictUnlockedPayload {
  district: number;
  /** All open districts after this unlock. */
  unlockedDistricts: number[];
}

/** `[id, xCm, yCm, zCm, rot16, stateIdx, corr0|1, tool]`, all integers (`tool` since Phase C). */
export type PlayerTickRow = [number, number, number, number, number, number, 0 | 1, number];

/** `miskolc:tick_sync`, broadcast to the room only when something changed. */
export interface TickSyncPayload {
  t: number;
  /** Last processed input `seq` per short id, for the players whose seq advanced since the previous tick. */
  acks: Record<string, number>;
  /** Changed players only. */
  p: PlayerTickRow[];
  /** Short ids removed since the previous tick (also announced by `player_left`). */
  gone: number[];
}

/** Session summary (`init:data.sweepersSessions[channelId]`, `miskolc:session-updated.state`). */
export interface SweepersSessionSummary {
  active: true;
  startedBy: string | null;
  /** Connected players (players in their reconnection grace window are not counted). */
  playerCount: number;
}

/** `miskolc:session-updated`; `state` is null when nobody is connected to the channel's world. */
export interface SweepersSessionUpdate {
  channelId: string;
  state: SweepersSessionSummary | null;
}

/** `miskolc:kicked`: this socket no longer plays (the same account joined from another socket). */
export interface SweepersKickedPayload {
  reason: 'displaced';
}

/** API other modules may consume. */
export interface SweepersApi {
  getSweepersSessions(): Record<string, SweepersSessionSummary>;
  getSession(channelId: string): SweepersSessionSummary | null;
}
