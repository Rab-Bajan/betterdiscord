import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SchemaMigrator } from './schema/SchemaMigrator.ts';

/** Minimal structural logger accepted by {@link SqliteDatabase}. */
export interface DatabaseLogger {
  info(msg: string): void;
}

/** Path value that opens a private in-memory database. */
export const IN_MEMORY = ':memory:';

/**
 * Owns one better-sqlite3 connection, configured exactly like the legacy database.js:
 * the parent directory is created on demand, WAL journaling is enabled and the schema
 * steps are applied on open.
 */
export class SqliteDatabase {
  /** File path (or `:memory:`) this database was opened with. */
  readonly path: string;
  /** Underlying better-sqlite3 handle (the legacy `db` export). */
  readonly connection: Database.Database;

  /**
   * Opens (and migrates) the database at `source`, or wraps an already-open connection.
   * @param source file path, `:memory:`, or an open connection (see {@link SqliteDatabase.fromConnection})
   * @param migrator schema migrator; defaults to the legacy schema (ignored for a connection)
   * @param logger receives the legacy "[SQLite] ... kész: <path>" line once migration is done
   */
  constructor(source: string | Database.Database, migrator: SchemaMigrator = new SchemaMigrator(), logger?: DatabaseLogger) {
    if (typeof source !== 'string') {
      this.path = source.name;
      this.connection = source;
      return;
    }
    const dbPath = source;
    this.path = dbPath;
    if (dbPath !== IN_MEMORY) SqliteDatabase.#ensureParentDir(dbPath);
    this.connection = new Database(dbPath);
    this.connection.pragma('journal_mode = WAL');
    migrator.migrate(this.connection);
    logger?.info(`[SQLite] Adatbázis inicializálva és kész: ${dbPath}`);
  }

  /**
   * Wraps a connection someone else opened and migrated (during the migration: the legacy
   * database.js `db`), so repositories share it. No pragma, migration or log line is applied;
   * the owner stays responsible for closing it.
   */
  static fromConnection(connection: Database.Database): SqliteDatabase {
    return new SqliteDatabase(connection);
  }

  /** Wraps `fn` in a transaction (better-sqlite3 `db.transaction` passthrough). */
  transaction<F extends (...args: never[]) => unknown>(fn: F): Database.Transaction<F> {
    return this.connection.transaction(fn);
  }

  /** Closes the connection. */
  close(): void {
    this.connection.close();
  }

  static #ensureParentDir(dbPath: string): void {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}
