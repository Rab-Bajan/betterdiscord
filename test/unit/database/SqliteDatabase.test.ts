import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { IN_MEMORY, MIGRATIONS, SchemaMigrator, SqliteDatabase } from '../../../src/infrastructure/database/index.ts';
import { makeTmpDir, schemaSnapshot } from './support.ts';

const EXPECTED_TABLES = [
  'accounts',
  'auth_tokens',
  'calls',
  'channel_messages',
  'direct_messages',
  'dm_reports',
  'phobia_match_history',
  'phobia_profiles',
  'sqlite_sequence'
];

const EXPECTED_INDEXES = [
  'idx_auth_tokens_account',
  'idx_calls_dm',
  'idx_channel_messages_channel',
  'idx_dm_key_created',
  'idx_dm_reports_status'
];

function names(db: SqliteDatabase, type: string): string[] {
  return (
    db.connection.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name").all(type) as {
      name: string;
    }[]
  ).map((r) => r.name);
}

test('in-memory database gets every table and index', () => {
  const db = new SqliteDatabase(IN_MEMORY);
  assert.deepEqual(names(db, 'table'), EXPECTED_TABLES);
  assert.deepEqual(names(db, 'index'), EXPECTED_INDEXES);
  assert.equal(db.path, IN_MEMORY);
  db.close();
});

test('direct_messages gets the migrated columns with their defaults', () => {
  const db = new SqliteDatabase(IN_MEMORY);
  const cols = db.connection.prepare('SELECT * FROM pragma_table_info(?)').all('direct_messages') as { name: string; dflt_value: string | null }[];
  const byName = new Map(cols.map((c) => [c.name, c]));
  assert.equal(byName.get('removed_by_admin')?.dflt_value, '0');
  assert.ok(byName.has('call_event'));
  assert.equal(cols.at(-1)?.name, 'call_event', 'ALTER order: removed_by_admin then call_event');
  db.close();
});

test('file database: creates the parent dir and enables WAL', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'nested', 'deeper', 'x.db');
    const db = new SqliteDatabase(file);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(db.connection.pragma('journal_mode'), [{ journal_mode: 'wal' }]);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening the same file is idempotent and keeps data', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'x.db');
    const first = new SqliteDatabase(file);
    const before = schemaSnapshot(first.connection);
    first.connection.prepare("INSERT INTO auth_tokens (token, account_id, created_at) VALUES ('t', 'a', 1)").run();
    first.close();

    const second = new SqliteDatabase(file);
    assert.deepEqual(schemaSnapshot(second.connection), before);
    assert.equal((second.connection.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get() as { n: number }).n, 1);
    second.close();

    const third = new SqliteDatabase(file);
    assert.deepEqual(schemaSnapshot(third.connection), before);
    third.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migrator can be re-run on an open connection without changes', () => {
  const db = new SqliteDatabase(IN_MEMORY);
  const before = schemaSnapshot(db.connection);
  new SchemaMigrator().migrate(db.connection);
  assert.deepEqual(schemaSnapshot(db.connection), before);
  db.close();
});

test('migrations are listed in legacy order', () => {
  assert.deepEqual(
    MIGRATIONS.map((m) => m.name),
    [
      'accounts',
      'channel_messages',
      'direct_messages',
      'direct_messages.removed_by_admin',
      'direct_messages.call_event',
      'calls',
      'dm_reports',
      'auth_tokens',
      'phobia'
    ]
  );
});

test('custom migrator is honoured', () => {
  const applied: string[] = [];
  const db = new SqliteDatabase(IN_MEMORY, new SchemaMigrator([{ name: 'only', apply: () => void applied.push('only') }]));
  assert.deepEqual(applied, ['only']);
  assert.deepEqual(names(db, 'table'), []);
  db.close();
});

test('transaction commits on success and rolls back on throw', () => {
  const db = new SqliteDatabase(IN_MEMORY);
  const insert = db.connection.prepare('INSERT INTO auth_tokens (token, account_id, created_at) VALUES (?, ?, ?)');
  const count = () => (db.connection.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get() as { n: number }).n;

  const ok = db.transaction((a: string, b: string) => {
    insert.run(a, 'acc', 1);
    insert.run(b, 'acc', 1);
    return 'done';
  });
  assert.equal(ok('t1', 't2'), 'done');
  assert.equal(count(), 2);

  const failing = db.transaction(() => {
    insert.run('t3', 'acc', 1);
    throw new Error('boom');
  });
  assert.throws(() => failing(), /boom/);
  assert.equal(count(), 2);
  db.close();
});

test('close() closes the connection', () => {
  const db = new SqliteDatabase(IN_MEMORY);
  db.close();
  assert.equal(db.connection.open, false);
});

test('logs the legacy ready line once, after migration', () => {
  const events: string[] = [];
  const migrator = new SchemaMigrator([{ name: 'probe', apply: () => void events.push('migrate') }]);
  const db = new SqliteDatabase(IN_MEMORY, migrator, { info: (msg) => void events.push(msg) });
  db.close();
  assert.deepEqual(events, ['migrate', '[SQLite] Adatbázis inicializálva és kész: :memory:']);
});

test('logged path is the path the database was opened with', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'log.db');
    const lines: string[] = [];
    new SqliteDatabase(file, undefined, { info: (msg) => void lines.push(msg) }).close();
    assert.deepEqual(lines, [`[SQLite] Adatbázis inicializálva és kész: ${file}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('logger is optional', () => {
  assert.doesNotThrow(() => new SqliteDatabase(IN_MEMORY).close());
});

test('fromConnection wraps an open connection without migrating, and repositories share it', () => {
  const owner = new SqliteDatabase(IN_MEMORY);
  const before = schemaSnapshot(owner.connection);
  const wrapped = SqliteDatabase.fromConnection(owner.connection);
  assert.equal(wrapped.connection, owner.connection);
  assert.equal(wrapped.path, owner.connection.name);
  assert.deepEqual(schemaSnapshot(owner.connection), before);
  owner.connection.prepare("INSERT INTO auth_tokens (token, account_id, created_at) VALUES ('t', 'a', 1)").run();
  assert.equal((wrapped.connection.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get() as { n: number }).n, 1);
  owner.close();
});

test('fromConnection applies no schema to an empty connection', () => {
  const empty = new SqliteDatabase(IN_MEMORY, new SchemaMigrator([]));
  const wrapped = SqliteDatabase.fromConnection(empty.connection);
  assert.deepEqual(names(wrapped, 'table'), []);
  empty.close();
});
