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
   * Opens (and migrates) the database at `dbPath`.
   * @param dbPath file path or `:memory:`
   * @param migrator schema migrator; defaults to the legacy schema
   * @param logger receives the legacy "[SQLite] ... kész: <path>" line once migration is done
   */
  constructor(dbPath: string, migrator: SchemaMigrator = new SchemaMigrator(), logger?: DatabaseLogger) {
    this.path = dbPath;
    if (dbPath !== IN_MEMORY) SqliteDatabase.#ensureParentDir(dbPath);
    this.connection = new Database(dbPath);
    this.connection.pragma('journal_mode = WAL');
    migrator.migrate(this.connection);
    logger?.info(`[SQLite] Adatbázis inicializálva és kész: ${dbPath}`);
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
