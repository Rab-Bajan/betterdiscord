import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

test('test runs use a throwaway SQLite file, never the tracked data/ database', () => {
  const dbPath = process.env.SHARKVOIC_DB_PATH;
  assert.ok(dbPath, 'SHARKVOIC_DB_PATH must be set by test/support/isolatedDb.cjs');
  assert.ok(dbPath.startsWith(os.tmpdir()), `expected a tmp path, got ${dbPath}`);
  assert.notEqual(path.basename(path.dirname(dbPath)), 'data');
});
