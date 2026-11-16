import type Database from 'better-sqlite3';

/**
 * One idempotent schema step. Steps run in array order on every open, exactly like the
 * top-level statements of the legacy database.js, so each must be safe to re-run.
 */
export interface Migration {
  readonly name: string;
  apply(db: Database.Database): void;
}

interface ColumnInfo {
  name: string;
}

/** True when `table` already has `column` (the legacy ALTER TABLE guard). */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as ColumnInfo[];
  return columns.some((c) => c.name === column);
}

/** Runs a fixed SQL script (CREATE ... IF NOT EXISTS statements). */
function execStep(name: string, sql: string): Migration {
  return { name, apply: (db) => void db.exec(sql) };
}

/** Adds a column only when it is missing. */
function addColumnStep(name: string, table: string, column: string, sql: string): Migration {
  return {
    name,
    apply: (db) => {
      if (!hasColumn(db, table, column)) db.exec(sql);
    }
  };
}

// The SQL below is copied verbatim from database.js (including whitespace, because SQLite
// stores the CREATE text in sqlite_master and the parity tests compare it byte for byte).

const ACCOUNTS_SQL = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE COLLATE NOCASE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    avatar_color TEXT,
    avatar_url TEXT,
    created_at INTEGER
  );
`;

const CHANNEL_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS channel_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT,
    username TEXT NOT NULL,
    avatar_color TEXT,
    avatar_url TEXT,
    text TEXT,
    attachments TEXT,
    timestamp TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at);
`;

const DIRECT_MESSAGES_SQL = `
  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    dm_key TEXT NOT NULL,
    sender_id TEXT,
    sender_account_id TEXT,
    sender_username TEXT NOT NULL,
    sender_avatar_color TEXT,
    sender_avatar_url TEXT,
    recipient_id TEXT,
    recipient_username TEXT NOT NULL,
    recipient_avatar_color TEXT,
    recipient_avatar_url TEXT,
    text TEXT,
    attachments TEXT,
    timestamp TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_dm_key_created ON direct_messages(dm_key, created_at);
`;

const CALLS_SQL = `
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    dm_key TEXT NOT NULL,
    caller_account_id TEXT NOT NULL,
    caller_username TEXT NOT NULL,
    callee_account_id TEXT NOT NULL,
    callee_username TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER,
    duration_sec INTEGER DEFAULT 0,
    end_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_calls_dm ON calls(dm_key, created_at);
`;

const DM_REPORTS_SQL = `
  CREATE TABLE IF NOT EXISTS dm_reports (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    dm_key TEXT NOT NULL,
    reporter_username TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER,
    resolved_by TEXT,
    resolved_at INTEGER,
    resolution TEXT,
    UNIQUE (message_id, reporter_username)
  );
  CREATE INDEX IF NOT EXISTS idx_dm_reports_status ON dm_reports(status, created_at);
`;

const AUTH_TOKENS_SQL = `
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_account ON auth_tokens(account_id);
`;

const PHOBIA_SQL = `
  CREATE TABLE IF NOT EXISTS phobia_profiles (
    userId TEXT PRIMARY KEY,
    balance_ft INTEGER DEFAULT 1000,
    xp INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    hunter_rank TEXT DEFAULT 'Kezdő Roncskutató'
  );

  CREATE TABLE IF NOT EXISTS phobia_match_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    matchId TEXT,
    userId TEXT,
    ghostType TEXT,
    location TEXT,
    result TEXT,
    reward_ft INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

// MiskolcSweepers (no legacy counterpart: these tables are additions after the legacy schema).
const MISKOLC_SWEEPERS_SQL = `
  CREATE TABLE IF NOT EXISTS miskolc_rooms (
    room_id TEXT PRIMARY KEY,
    state_json TEXT,
    district_cleanliness_json TEXT,
    team_funds INTEGER,
    last_saved INTEGER
  );

  CREATE TABLE IF NOT EXISTS miskolc_player_stats (
    user_id TEXT,
    room_id TEXT,
    personal_cash INTEGER,
    equipped_tool_tier INTEGER,
    backpack_tier INTEGER,
    total_kg_swept REAL,
    PRIMARY KEY (user_id, room_id)
  );
  CREATE INDEX IF NOT EXISTS idx_miskolc_player_stats_room ON miskolc_player_stats(room_id);

  CREATE TABLE IF NOT EXISTS miskolc_world_structures (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    type TEXT,
    x REAL,
    y REAL,
    z REAL,
    rot_y REAL,
    config_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_miskolc_world_structures_room ON miskolc_world_structures(room_id);
`;

/** The MiskolcSweepers tables; the sweepers module also applies this step to the shared legacy connection. */
export const MISKOLC_SWEEPERS_MIGRATION: Migration = execStep('miskolc_sweepers', MISKOLC_SWEEPERS_SQL);

/** MiskolcSweepers Phase C: the personal state beyond the four v1 columns (see sweepers debris/personal.ts). */
export const MISKOLC_STATS_JSON_MIGRATION: Migration = addColumnStep(
  'miskolc_player_stats.stats_json',
  'miskolc_player_stats',
  'stats_json',
  'ALTER TABLE miskolc_player_stats ADD COLUMN stats_json TEXT'
);

/** Tables (and their indexes) that exist only in the new schema, never in legacy database.js. */
export const NON_LEGACY_TABLES: readonly string[] = Object.freeze(['miskolc_rooms', 'miskolc_player_stats', 'miskolc_world_structures']);

/** Schema steps in the exact order database.js applies them, then the additions without a legacy counterpart. */
export const MIGRATIONS: readonly Migration[] = [
  execStep('accounts', ACCOUNTS_SQL),
  execStep('channel_messages', CHANNEL_MESSAGES_SQL),
  execStep('direct_messages', DIRECT_MESSAGES_SQL),
  addColumnStep(
    'direct_messages.removed_by_admin',
    'direct_messages',
    'removed_by_admin',
    'ALTER TABLE direct_messages ADD COLUMN removed_by_admin INTEGER DEFAULT 0'
  ),
  addColumnStep(
    'direct_messages.call_event',
    'direct_messages',
    'call_event',
    'ALTER TABLE direct_messages ADD COLUMN call_event TEXT'
  ),
  execStep('calls', CALLS_SQL),
  execStep('dm_reports', DM_REPORTS_SQL),
  execStep('auth_tokens', AUTH_TOKENS_SQL),
  execStep('phobia', PHOBIA_SQL),
  MISKOLC_SWEEPERS_MIGRATION,
  MISKOLC_STATS_JSON_MIGRATION
];
