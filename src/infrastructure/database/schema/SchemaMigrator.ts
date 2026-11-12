import type Database from 'better-sqlite3';
import { MIGRATIONS, type Migration } from './migrations.ts';

/** Applies the idempotent schema steps to a connection, in order. */
export class SchemaMigrator {
  readonly #migrations: readonly Migration[];

  /** @param migrations steps to apply; defaults to the legacy database.js schema. */
  constructor(migrations: readonly Migration[] = MIGRATIONS) {
    this.#migrations = migrations;
  }

  /** Runs every step against `db`. Safe to call on an already-migrated database. */
  migrate(db: Database.Database): void {
    for (const migration of this.#migrations) migration.apply(db);
  }
}
