import type Database from 'better-sqlite3';
import type { SqliteDatabase } from './SqliteDatabase.ts';

/** Statement shape used by repositories: positional or named bind parameters. */
export type Statement = Database.Statement<unknown[], unknown>;

/** Base class for repositories: holds the connection and caches prepared statements by SQL. */
export abstract class BaseRepository {
  /** Raw connection for subclasses. */
  protected readonly db: Database.Database;
  readonly #statements = new Map<string, Statement>();

  /** @param database an opened (and migrated) database, or anything exposing its connection (e.g. the legacy database.js `db`) */
  constructor(database: Pick<SqliteDatabase, 'connection'>) {
    this.db = database.connection;
  }

  /** Returns the prepared statement for `sql`, preparing it on first use. */
  protected statement(sql: string): Statement {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }
}
