import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Logger } from '../../../src/core/logging/Logger.ts';
import type { LogRecord } from '../../../src/core/logging/Logger.ts';
import { ensureSweepersSchema } from '../../../src/modules/sweepers/sweepersModule.ts';

test('the schema step reports a failing migration (logged) instead of throwing', () => {
  const logs: LogRecord[] = [];
  const logger = new Logger({ sink: (r) => { logs.push(r); } });
  const closed = new Database(':memory:');
  closed.close();
  assert.equal(ensureSweepersSchema({ connection: closed }, logger), false);
  assert.ok(logs.some((r) => r.level === 'error' && /migration failed/.test(r.message)));

  const open = new Database(':memory:');
  assert.equal(ensureSweepersSchema({ connection: open }, logger), true);
  assert.equal(ensureSweepersSchema({ connection: open }, logger), true, 'idempotent');
  const tables = open.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  assert.deepEqual(tables, [{ name: 'miskolc_player_stats' }, { name: 'miskolc_rooms' }, { name: 'miskolc_world_structures' }]);
  open.close();
});
