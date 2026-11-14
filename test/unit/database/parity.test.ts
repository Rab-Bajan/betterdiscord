// Parity: the legacy database.js and the new repositories receive the same operations on two
// separate throwaway files; every return value (or error) and the final contents must match.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { NON_LEGACY_TABLES, SchemaMigrator, SqliteDatabase } from '../../../src/infrastructure/database/index.ts';
import { makeTmpDir, repositoriesFor, schemaSnapshot } from './support.ts';

type Fn = (...args: unknown[]) => unknown;
type LegacyModule = { db: Database.Database } & Record<string, unknown>;

const dir = makeTmpDir('sharkvoic-parity-');
const legacyPath = path.join(dir, 'legacy.db');
assert.ok(legacyPath.startsWith(os.tmpdir()), 'legacy parity DB must live in the tmp dir');
// database.js reads this at require() time; it must never resolve to data/sharkvoic.db.
process.env['SHARKVOIC_DB_PATH'] = legacyPath;
const legacy = createRequire(import.meta.url)('../../../database.js') as LegacyModule;
assert.equal(legacy.db.name, legacyPath);

const database = new SqliteDatabase(path.join(dir, 'new.db'));
const repos = repositoriesFor(database);

after(() => {
  legacy.db.close();
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let clock = 1_700_000_000_000;
mock.method(Date, 'now', () => clock);

function bound<T extends object>(target: T, key: keyof T & string): Fn {
  const fn = target[key] as Fn;
  return (...args) => fn.apply(target, args);
}

/** Legacy export name → the one repository method that replaces it. */
const MAPPING: Record<string, Fn> = {
  createAccount: bound(repos.accounts, 'createAccount'),
  getAccountById: bound(repos.accounts, 'getAccountById'),
  getAccountByUsername: bound(repos.accounts, 'getAccountByUsername'),
  updateAccount: bound(repos.accounts, 'updateAccount'),
  saveChannelMessage: bound(repos.channelMessages, 'saveChannelMessage'),
  getChannelMessages: bound(repos.channelMessages, 'getChannelMessages'),
  loadAllChannelMessages: bound(repos.channelMessages, 'loadAllChannelMessages'),
  saveDmMessage: bound(repos.directMessages, 'saveDmMessage'),
  getDmMessageById: bound(repos.directMessages, 'getDmMessageById'),
  getDmContext: bound(repos.directMessages, 'getDmContext'),
  removeDmMessage: bound(repos.directMessages, 'removeDmMessage'),
  getDmMessages: bound(repos.directMessages, 'getDmMessages'),
  getUserDmConversations: bound(repos.directMessages, 'getUserDmConversations'),
  createDmReport: bound(repos.reports, 'createDmReport'),
  getDmReport: bound(repos.reports, 'getDmReport'),
  listDmReports: bound(repos.reports, 'listDmReports'),
  resolveDmReport: bound(repos.reports, 'resolveDmReport'),
  saveCall: bound(repos.calls, 'saveCall'),
  getCallHistory: bound(repos.calls, 'getCallHistory'),
  saveAuthToken: bound(repos.tokens, 'saveAuthToken'),
  getAccountByToken: bound(repos.tokens, 'getAccountByToken'),
  deleteAuthToken: bound(repos.tokens, 'deleteAuthToken'),
  deleteAccountTokens: bound(repos.tokens, 'deleteAccountTokens')
};

const called = new Set<string>();

type Outcome = { value: unknown } | { error: { code: unknown; message: string } };

function outcome(fn: Fn, args: unknown[], at: number): Outcome {
  clock = at;
  try {
    return { value: fn(...args) };
  } catch (err) {
    const e = err as Error & { code?: unknown };
    return { error: { code: e.code, message: e.message } };
  }
}

/** Runs `name(...args)` on both implementations at the same fake time and asserts equal results. */
function both(name: string, ...args: unknown[]): Outcome {
  const legacyFn = legacy[name];
  const mine = MAPPING[name];
  assert.equal(typeof legacyFn, 'function', `legacy export ${name}`);
  assert.ok(mine, `no repository mapping for ${name}`);
  const at = (clock += 1000);
  const expected = outcome((...a) => (legacyFn as Fn).apply(legacy, a), structuredClone(args), at);
  const actual = outcome(mine, structuredClone(args), at);
  assert.deepStrictEqual(actual, expected, `${name}(${JSON.stringify(args)})`);
  called.add(name);
  return expected;
}

function dumpTables(db: Database.Database): Record<string, unknown[]> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .filter(({ name }) => !NON_LEGACY_TABLES.includes(name));
  return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
}

// The new schema = the legacy schema plus NON_LEGACY_TABLES (no legacy counterpart), so legacy
// comparisons leave those additions out.
const legacyOnly = { legacyOnly: true };

test('fresh schema is identical (sqlite_master + PRAGMA table_info)', () => {
  assert.deepStrictEqual(schemaSnapshot(database.connection, legacyOnly), schemaSnapshot(legacy.db));
  assert.deepStrictEqual(schemaSnapshot(legacy.db, legacyOnly), schemaSnapshot(legacy.db), 'legacy has none of the additions');
  assert.deepStrictEqual(database.connection.pragma('journal_mode'), legacy.db.pragma('journal_mode'));
});

test('every legacy function export has exactly one repository method', () => {
  const exported = Object.keys(legacy).filter((k) => typeof legacy[k] === 'function').sort();
  assert.deepStrictEqual(Object.keys(MAPPING).sort(), exported);
  assert.deepEqual(
    Object.keys(legacy).filter((k) => typeof legacy[k] !== 'function'),
    ['db'],
    'the only non-function export is the raw handle (SqliteDatabase.connection)'
  );
});

test('accounts parity', () => {
  both('createAccount', { id: 'a1', username: 'Alice', passwordHash: 'h1', salt: 's1', avatarColor: '#111', avatarUrl: '/a.png', createdAt: 5 });
  both('createAccount', { id: 'a2', username: 'Bob', passwordHash: 'h2', salt: 's2' });
  both('createAccount', { id: 'a3', username: 'Carol', passwordHash: 'h3', salt: 's3', avatarColor: '', avatarUrl: '', createdAt: 0 });
  both('createAccount', { id: 'a4', username: 'ALICE', passwordHash: 'x', salt: 'x' });
  both('createAccount', { id: 'a1', username: 'Other', passwordHash: 'x', salt: 'x' });
  both('getAccountById', 'a1');
  both('getAccountById', 'missing');
  both('getAccountByUsername', 'alice');
  both('getAccountByUsername', 'BOB');
  both('getAccountByUsername', '');
  both('getAccountByUsername', undefined);
  both('getAccountByUsername', 'nobody');
  both('updateAccount', 'a2', { username: 'Bobby', avatarColor: '#222', avatarUrl: null });
  both('updateAccount', 'missing', { username: 'Ghost', avatarColor: null, avatarUrl: null });
  both('updateAccount', 'a2', { username: 'alice', avatarColor: null, avatarUrl: null });
  both('updateAccount', 'a3', {});
  both('getAccountByUsername', 'bobby');
});

test('auth token parity', () => {
  both('saveAuthToken', 't1', 'a1');
  both('saveAuthToken', 't2', 'a1');
  both('saveAuthToken', 't3', 'a2');
  both('saveAuthToken', 't4', 'no-account');
  both('saveAuthToken', 't1', 'a2');
  both('getAccountByToken', 't1');
  both('getAccountByToken', 't4');
  both('getAccountByToken', '');
  both('getAccountByToken', null);
  both('getAccountByToken', 'missing');
  both('deleteAuthToken', 't2');
  both('deleteAuthToken', '');
  both('deleteAuthToken', undefined);
  both('getAccountByToken', 't2');
  both('deleteAccountTokens', 'a1');
  both('deleteAccountTokens', '');
  both('getAccountByToken', 't1');
  both('getAccountByToken', 't3');
});

test('channel message parity', () => {
  both('saveChannelMessage', { id: 'c1', channelId: 'gaming', senderId: 's1', username: 'Alice', text: 'hi', timestamp: '10:00', createdAt: 100 });
  both('saveChannelMessage', { id: 'c2', channelId: 'gaming', username: 'Bob', attachments: [{ url: '/f', name: 'f' }], createdAt: 50 });
  both('saveChannelMessage', { id: 'c3', channelId: 'zene', username: 'Carol', avatarColor: '#333', avatarUrl: '/c.png', text: '' });
  both('saveChannelMessage', { id: 'c4', channelId: 'zene', username: 'Dave', attachments: null, createdAt: 0, extra: 'kept' });
  both('saveChannelMessage', { id: 'c1', channelId: 'gaming', username: 'Dup' });
  both('getChannelMessages', 'gaming');
  both('getChannelMessages', 'zene');
  both('getChannelMessages', 'empty');
  both('loadAllChannelMessages', ['altalanos', 'gaming', 'zene', 'fejlesztes']);
  both('loadAllChannelMessages', []);
});

test('direct message parity', () => {
  const base = { dmKey: 'alice|bob', senderId: 'sa', senderAccountId: 'a1', senderUsername: 'Alice', recipientId: 'sb', recipientUsername: 'Bob' };
  for (let i = 1; i <= 25; i++) both('saveDmMessage', { ...base, id: `d${i}`, text: `m${i}`, timestamp: `t${i}`, createdAt: i * 10 });
  both('saveDmMessage', {
    ...base,
    id: 'd-call',
    senderUsername: 'bob',
    recipientUsername: 'ALICE',
    senderAvatarColor: '#b0b',
    recipientAvatarUrl: '/a.png',
    callEvent: { callId: 'k1', status: 'ended', durationSec: 12, callerUsername: 'bob' },
    createdAt: 300
  });
  both('saveDmMessage', { id: 'd-min', dmKey: 'alice|carol', senderUsername: 'Carol', recipientUsername: 'Alice' });
  both('saveDmMessage', { ...base, id: 'd-att', dmKey: 'alice|dave', recipientUsername: 'Dave', recipientId: null, text: '', attachments: [{ u: 1 }], createdAt: 400 });
  both('saveDmMessage', { ...base, id: 'd-extra', dmKey: 'x|y', senderUsername: 'X', recipientUsername: 'Y', sender_id: 'snake', removed_by_admin: 1, createdAt: 1 });
  both('saveDmMessage', { ...base, id: 'd1', createdAt: 1 });

  both('getDmMessageById', 'd5');
  both('getDmMessageById', 'd-call');
  both('getDmMessageById', 'd-min');
  both('getDmMessageById', 'd-extra');
  both('getDmMessageById', 'missing');
  both('getDmMessages', 'alice|bob');
  both('getDmMessages', 'none');
  both('getDmContext', 'alice|bob', 120);
  both('getDmContext', 'alice|bob', 120, 2, 3);
  both('getDmContext', 'alice|bob', 120, 0, 0);
  both('getDmContext', 'alice|bob', 5, 3, 3);
  both('getDmContext', 'alice|bob', 1000);
  both('getDmContext', 'none', 100);
  both('removeDmMessage', 'd3');
  both('removeDmMessage', 'missing');
  both('getDmMessageById', 'd3');
  both('getUserDmConversations', 'alice');
  both('getUserDmConversations', 'BOB');
  both('getUserDmConversations', 'x');
  both('getUserDmConversations', '');
  both('getUserDmConversations', null);
  both('getUserDmConversations', 'nobody');
});

test('DM report parity', () => {
  both('createDmReport', { id: 'r1', messageId: 'd5', dmKey: 'alice|bob', reporterUsername: 'bob', reason: 'spam' });
  both('createDmReport', { id: 'r2', messageId: 'd5', dmKey: 'alice|bob', reporterUsername: 'bob', reason: 'again' });
  both('createDmReport', { id: 'r3', messageId: 'd6', dmKey: 'alice|bob', reporterUsername: 'alice' });
  both('createDmReport', { id: 'r4', messageId: 'd7', dmKey: 'alice|bob', reporterUsername: 'alice', reason: null });
  both('getDmReport', 'r1');
  both('getDmReport', 'r2');
  both('getDmReport', 'missing');
  both('listDmReports');
  both('listDmReports', 'open');
  both('resolveDmReport', 'r1', 'bajan', 'removed');
  both('resolveDmReport', 'r3', 'bajan');
  both('resolveDmReport', 'r1', 'bajan', 'twice');
  both('resolveDmReport', 'missing', 'bajan', 'x');
  both('listDmReports', 'resolved');
  both('listDmReports');
  both('getDmReport', 'r1');
});

test('call history parity', () => {
  const c = { dmKey: 'alice|bob', callerAccountId: 'a1', callerUsername: 'Alice', calleeAccountId: 'a2', calleeUsername: 'Bob' };
  for (let i = 1; i <= 55; i++) both('saveCall', { ...c, id: `k${i}`, status: 'missed', createdAt: i });
  both('saveCall', { ...c, id: 'k1', status: 'ended', createdAt: 1, answeredAt: 2, endedAt: 9, durationSec: 7, endReason: 'hangup' });
  both('saveCall', { ...c, id: 'k-null', status: 'ended', createdAt: 100, durationSec: null });
  both('saveCall', { ...c, id: 'k-bad', status: 'x' });
  both('getCallHistory', 'alice|bob');
  both('getCallHistory', 'alice|bob', 3);
  both('getCallHistory', 'none');
});

test('every legacy function was exercised and final contents are identical', () => {
  assert.deepStrictEqual([...called].sort(), Object.keys(MAPPING).sort());
  assert.deepStrictEqual(dumpTables(database.connection), dumpTables(legacy.db));
});

test('opening a legacy-created file with SqliteDatabase leaves its schema unchanged', () => {
  const before = schemaSnapshot(legacy.db);
  const reopened = new SqliteDatabase(legacyPath);
  try {
    assert.deepStrictEqual(schemaSnapshot(reopened.connection, legacyOnly), before);
  } finally {
    reopened.close();
  }
});

test('upgrading a pre-migration file reaches the legacy schema', () => {
  const file = path.join(dir, 'old.db');
  const preMigration = new SchemaMigrator([{ name: 'pre-migration direct_messages', apply: (db) => void db.exec(`
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
`) }]);
  new SqliteDatabase(file, preMigration).close();
  const upgraded = new SqliteDatabase(file);
  try {
    // legacy.db itself was reopened (and so extended) by SqliteDatabase in the previous test.
    assert.deepStrictEqual(schemaSnapshot(upgraded.connection, legacyOnly), schemaSnapshot(legacy.db, legacyOnly));
  } finally {
    upgraded.close();
  }
});
