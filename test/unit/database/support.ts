// Shared fixtures for database unit tests. Never points at data/sharkvoic.db.
import type { TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AccountRepository,
  AuthTokenRepository,
  CallHistoryRepository,
  ChannelMessageRepository,
  DirectMessageRepository,
  DmReportRepository,
  IN_MEMORY,
  SqliteDatabase
} from '../../../src/infrastructure/database/index.ts';

/** All repositories over one database. */
export interface Repositories {
  database: SqliteDatabase;
  accounts: AccountRepository;
  tokens: AuthTokenRepository;
  channelMessages: ChannelMessageRepository;
  directMessages: DirectMessageRepository;
  reports: DmReportRepository;
  calls: CallHistoryRepository;
}

/** Builds every repository over `database`. */
export function repositoriesFor(database: SqliteDatabase): Repositories {
  return {
    database,
    accounts: new AccountRepository(database),
    tokens: new AuthTokenRepository(database),
    channelMessages: new ChannelMessageRepository(database),
    directMessages: new DirectMessageRepository(database),
    reports: new DmReportRepository(database),
    calls: new CallHistoryRepository(database)
  };
}

/** Fresh in-memory database with all repositories, closed when test `t` finishes. */
export function openMemory(t: TestContext): Repositories {
  const database = new SqliteDatabase(IN_MEMORY);
  t.after(() => database.close());
  return repositoriesFor(database);
}

/** Creates an empty temp directory under os.tmpdir() and returns it. */
export function makeTmpDir(prefix = 'sharkvoic-unit-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Schema snapshot used to compare two databases. */
export function schemaSnapshot(db: SqliteDatabase['connection']): unknown {
  const master = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name")
    .all() as { type: string; name: string }[];
  const tables = master.filter((m) => m.type === 'table').map((m) => m.name);
  const columns = Object.fromEntries(tables.map((t) => [t, db.prepare('SELECT * FROM pragma_table_info(?)').all(t)]));
  return { master, columns };
}
