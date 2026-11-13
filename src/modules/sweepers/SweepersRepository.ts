import { BaseRepository } from '../../infrastructure/database/BaseRepository.ts';
import { isPlainObject } from '../../core/validation/isPlainObject.ts';
import type { PersonalStats } from './types.ts';

/** A persisted sweepers world (`miskolc_rooms`). */
export interface RoomRecord {
  roomId: string;
  /** Room-level world state, `state_json` format v2 (see roomState.ts). */
  state: Record<string, unknown>;
  /** Cleanliness (0..100) by hex id. */
  cleanliness: Record<string, number>;
  teamFunds: number;
  lastSaved: number;
}

/** Persisted progress of one player in one room (`miskolc_player_stats`). */
export interface PlayerStatsRecord {
  userId: string;
  roomId: string;
  stats: PersonalStats;
}

/** A placed structure (`miskolc_world_structures`, used from Phase D on). */
export interface WorldStructureRecord {
  id: string;
  roomId: string;
  type: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  config: Record<string, unknown>;
}

/** What the sweepers service needs from storage. */
export interface SweepersStore {
  loadRoom(roomId: string): RoomRecord | null;
  loadPlayerStats(userId: string, roomId: string): PersonalStats | null;
  /** Upserts the room and the given players' stats in one transaction. */
  saveRoom(room: RoomRecord, players: readonly PlayerStatsRecord[]): void;
  savePlayerStats(record: PlayerStatsRecord): void;
}

interface RoomRow {
  room_id: string;
  state_json: string | null;
  district_cleanliness_json: string | null;
  team_funds: number | null;
  last_saved: number | null;
}

interface PlayerStatsRow {
  personal_cash: number | null;
  equipped_tool_tier: number | null;
  backpack_tier: number | null;
  total_kg_swept: number | null;
}

interface StructureRow {
  id: string;
  room_id: string;
  type: string;
  x: number;
  y: number;
  z: number;
  rot_y: number;
  config_json: string | null;
}

const LOAD_ROOM_SQL = 'SELECT * FROM miskolc_rooms WHERE room_id = ?';
const UPSERT_ROOM_SQL = `
  INSERT INTO miskolc_rooms (room_id, state_json, district_cleanliness_json, team_funds, last_saved)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(room_id) DO UPDATE SET
    state_json = excluded.state_json,
    district_cleanliness_json = excluded.district_cleanliness_json,
    team_funds = excluded.team_funds,
    last_saved = excluded.last_saved
`;
const LOAD_STATS_SQL = 'SELECT * FROM miskolc_player_stats WHERE user_id = ? AND room_id = ?';
const UPSERT_STATS_SQL = `
  INSERT INTO miskolc_player_stats (user_id, room_id, personal_cash, equipped_tool_tier, backpack_tier, total_kg_swept)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(user_id, room_id) DO UPDATE SET
    personal_cash = excluded.personal_cash,
    equipped_tool_tier = excluded.equipped_tool_tier,
    backpack_tier = excluded.backpack_tier,
    total_kg_swept = excluded.total_kg_swept
`;
const LOAD_STRUCTURES_SQL = 'SELECT * FROM miskolc_world_structures WHERE room_id = ? ORDER BY rowid';
const UPSERT_STRUCTURE_SQL = `
  INSERT INTO miskolc_world_structures (id, room_id, type, x, y, z, rot_y, config_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    room_id = excluded.room_id, type = excluded.type, x = excluded.x, y = excluded.y, z = excluded.z,
    rot_y = excluded.rot_y, config_json = excluded.config_json
`;

/** Parses a stored JSON object column; anything else (null, corrupt, non-object) reads as `{}`. */
function jsonObject(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
}

const num = (value: number | null, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** The three `miskolc_*` tables (schema: the `miskolc_sweepers` migration). */
export class SweepersRepository extends BaseRepository implements SweepersStore {
  loadRoom(roomId: string): RoomRecord | null {
    const row = this.statement(LOAD_ROOM_SQL).get(roomId) as RoomRow | undefined;
    if (!row) return null;
    const cleanliness: Record<string, number> = {};
    for (const [id, value] of Object.entries(jsonObject(row.district_cleanliness_json))) {
      if (typeof value === 'number' && Number.isFinite(value)) cleanliness[id] = value;
    }
    return {
      roomId: row.room_id,
      state: jsonObject(row.state_json),
      cleanliness,
      teamFunds: num(row.team_funds),
      lastSaved: num(row.last_saved)
    };
  }

  loadPlayerStats(userId: string, roomId: string): PersonalStats | null {
    const row = this.statement(LOAD_STATS_SQL).get(userId, roomId) as PlayerStatsRow | undefined;
    if (!row) return null;
    return {
      cash: num(row.personal_cash),
      toolTier: num(row.equipped_tool_tier),
      backpackTier: num(row.backpack_tier),
      totalKg: num(row.total_kg_swept)
    };
  }

  saveRoom(room: RoomRecord, players: readonly PlayerStatsRecord[]): void {
    this.db.transaction(() => {
      this.statement(UPSERT_ROOM_SQL).run(
        room.roomId, JSON.stringify(room.state), JSON.stringify(room.cleanliness), Math.round(room.teamFunds), room.lastSaved
      );
      for (const player of players) this.savePlayerStats(player);
    })();
  }

  savePlayerStats({ userId, roomId, stats }: PlayerStatsRecord): void {
    this.statement(UPSERT_STATS_SQL).run(userId, roomId, Math.round(stats.cash), stats.toolTier, stats.backpackTier, stats.totalKg);
  }

  loadStructures(roomId: string): WorldStructureRecord[] {
    const rows = this.statement(LOAD_STRUCTURES_SQL).all(roomId) as StructureRow[];
    return rows.map((row) => ({
      id: row.id, roomId: row.room_id, type: row.type, x: row.x, y: row.y, z: row.z, rotY: row.rot_y, config: jsonObject(row.config_json)
    }));
  }

  upsertStructure(s: WorldStructureRecord): void {
    this.statement(UPSERT_STRUCTURE_SQL).run(s.id, s.roomId, s.type, s.x, s.y, s.z, s.rotY, JSON.stringify(s.config));
  }
}
