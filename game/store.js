// A játék saját táblái a meglévő SQLite adatbázisban. Csak új táblákat hoz létre, a régiekhez nem nyúl.
const { levelFromXp, outcomeFor, xpForMatch, isRewardable, sideOf } = require('./progression');
const { createGameMeta } = require('./meta');

function createGameStore(db, { minRewardSeconds, metaOptions } = {}) {
  const meta = createGameMeta(db, metaOptions);
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_profiles (
      account_id TEXT PRIMARY KEY,
      xp INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
      matches INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      assists INTEGER NOT NULL DEFAULT 0,
      damage INTEGER NOT NULL DEFAULT 0,
      playtime_s INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS game_matches (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      winner TEXT,
      reason TEXT NOT NULL,
      score_json TEXT NOT NULL,
      duration_s INTEGER NOT NULL,
      ended_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_match_players (
      match_id TEXT NOT NULL REFERENCES game_matches(id),
      account_id TEXT NOT NULL,
      username TEXT NOT NULL,
      team TEXT NOT NULL,
      character_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      kills INTEGER NOT NULL,
      deaths INTEGER NOT NULL,
      assists INTEGER NOT NULL,
      damage INTEGER NOT NULL,
      xp_awarded INTEGER NOT NULL,
      PRIMARY KEY (match_id, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_game_match_players_account ON game_match_players(account_id);
  `);

  const insertMatch = db.prepare(`
    INSERT OR IGNORE INTO game_matches (id, channel_id, mode, winner, reason, score_json, duration_s, ended_at)
    VALUES (@id, @channelId, @mode, @winner, @reason, @scoreJson, @durationS, @endedAt)
  `);
  const insertPlayer = db.prepare(`
    INSERT INTO game_match_players (match_id, account_id, username, team, character_id, outcome, kills, deaths, assists, damage, xp_awarded)
    VALUES (@matchId, @accountId, @username, @team, @characterId, @outcome, @kills, @deaths, @assists, @damage, @xp)
  `);
  const ensureProfile = db.prepare('INSERT OR IGNORE INTO game_profiles (account_id) VALUES (?)');
  const selectProfile = db.prepare('SELECT * FROM game_profiles WHERE account_id = ?');
  const updateProfile = db.prepare(`
    UPDATE game_profiles SET
      xp = xp + @xp, matches = matches + 1,
      wins = wins + @win, losses = losses + @loss, draws = draws + @draw,
      kills = kills + @kills, deaths = deaths + @deaths, assists = assists + @assists,
      damage = damage + @damage, playtime_s = playtime_s + @durationS, updated_at = @now
    WHERE account_id = @accountId
  `);

  // accounts: key -> accountId, csak hitelesített játékosoké. A match id egyedisége miatt
  // ugyanaz a meccs nem jutalmazható kétszer, és a tranzakció miatt részlegesen sem.
  const recordMatch = db.transaction((result, channelId, accounts, context = {}) => {
    const { changes } = insertMatch.run({
      id: result.matchId,
      channelId,
      mode: result.mode || 'team_deathmatch',
      winner: result.winner,
      reason: result.reason,
      scoreJson: JSON.stringify(result.score),
      durationS: result.durationS,
      endedAt: Date.now()
    });
    if (changes === 0) return { duplicate: true, rewards: {} };

    const rewards = {};
    for (const p of result.players) {
      const accountId = accounts.get(p.key);
      if (!accountId) continue;

      const outcome = p.outcome ?? outcomeFor(sideOf(p), result.winner);
      const xp = isRewardable(result, p, minRewardSeconds) ? meta.modifyXp(accountId, xpForMatch(p, outcome)) : 0;
      ensureProfile.run(accountId);
      const before = selectProfile.get(accountId);
      insertPlayer.run({ matchId: result.matchId, accountId, username: p.username, team: p.team, characterId: p.characterId, outcome, kills: p.kills, deaths: p.deaths, assists: p.assists, damage: p.damage, xp });

      if (xp > 0) {
        updateProfile.run({
          accountId, xp, win: outcome === 'win' ? 1 : 0, loss: outcome === 'loss' ? 1 : 0, draw: outcome === 'draw' ? 1 : 0,
          kills: p.kills, deaths: p.deaths, assists: p.assists, damage: p.damage, durationS: result.durationS, now: Date.now()
        });
      }
      const after = selectProfile.get(accountId);
      const extras = meta.applyPlayerMatch(accountId, p, result, outcome, xp, after.xp, context.muted?.has(p.key) === true);
      rewards[p.i] = { xp, totalXp: after.xp, level: levelFromXp(after.xp), leveledUp: levelFromXp(after.xp) > levelFromXp(before.xp), ...extras };
    }
    // A terület sorsa ugyanabban a tranzakcióban dől el, mint a meccs jutalmai
    if (context.battleId && result.reason !== 'abandoned') {
      meta.resolveBattle(context.battleId, context.battleWinner, [...accounts.values()]);
    }
    return { duplicate: false, rewards };
  });

  return {
    meta,
    recordMatch,
    getProfile(accountId) {
      const row = selectProfile.get(accountId);
      const profile = row || { xp: 0, matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0, assists: 0, damage: 0, playtime_s: 0 };
      const { account_id: _id, updated_at: _updated, ...stats } = profile;
      return { ...stats, level: levelFromXp(profile.xp) };
    }
  };
}

module.exports = { createGameStore };
