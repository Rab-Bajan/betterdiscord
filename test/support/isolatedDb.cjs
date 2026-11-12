// Preloaded by every test run: points the SQLite layer at a throwaway file so tests
// never touch the tracked/live data/sharkvoic.db. Honoured by database.js and the new Database class.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.SHARKVOIC_DB_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharkvoic-test-'));
  process.env.SHARKVOIC_DB_PATH = path.join(dir, 'test.db');
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}
