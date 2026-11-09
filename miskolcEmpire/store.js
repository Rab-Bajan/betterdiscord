// empire_stats tábla: csak bejelentkezett fiókok statisztikája
function createEmpireStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS empire_stats (
      account_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      ai_wins INTEGER NOT NULL DEFAULT 0,
      ai_losses INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      units_killed INTEGER NOT NULL DEFAULT 0,
      buildings_destroyed INTEGER NOT NULL DEFAULT 0,
      gathered INTEGER NOT NULL DEFAULT 0,
      last_played INTEGER NOT NULL DEFAULT 0
    );
  `);
  const upsert = db.prepare(`
    INSERT INTO empire_stats (account_id, username, wins, losses, ai_wins, ai_losses, games, units_killed, buildings_destroyed, gathered, last_played)
    VALUES (@accountId, @username, @wins, @losses, @aiWins, @aiLosses, 1, @unitsKilled, @buildingsDestroyed, @gathered, @now)
    ON CONFLICT(account_id) DO UPDATE SET
      username = excluded.username,
      wins = wins + excluded.wins,
      losses = losses + excluded.losses,
      ai_wins = ai_wins + excluded.ai_wins,
      ai_losses = ai_losses + excluded.ai_losses,
      games = games + 1,
      units_killed = units_killed + excluded.units_killed,
      buildings_destroyed = buildings_destroyed + excluded.buildings_destroyed,
      gathered = gathered + excluded.gathered,
      last_played = excluded.last_played
  `);
  const select = db.prepare('SELECT * FROM empire_stats WHERE account_id = ?');
  const top = db.prepare('SELECT username, wins, losses, ai_wins, ai_losses, games, units_killed, buildings_destroyed, gathered FROM empire_stats ORDER BY wins DESC, games DESC LIMIT ?');

  // entries: [{ accountId, username, won, vsAi, unitsKilled, buildingsDestroyed, gathered }]
  const record = db.transaction((entries, now = Date.now()) => {
    for (const e of entries) {
      if (!e.accountId) continue;
      upsert.run({
        accountId: e.accountId, username: e.username, wins: e.won && !e.vsAi ? 1 : 0, losses: !e.won && !e.vsAi ? 1 : 0,
        aiWins: e.won && e.vsAi ? 1 : 0, aiLosses: !e.won && e.vsAi ? 1 : 0, unitsKilled: e.unitsKilled | 0,
        buildingsDestroyed: e.buildingsDestroyed | 0, gathered: e.gathered | 0, now
      });
    }
  });

  return { record, get: (accountId) => select.get(accountId) || null, top: (n = 10) => top.all(n) };
}

module.exports = { createEmpireStore };
