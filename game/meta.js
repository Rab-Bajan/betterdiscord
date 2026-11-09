// Tartós játékrendszerek a meglévő SQLite adatbázisban. Minden szabályt a szerver ellenőriz,
// és minden pénzt vagy tárgyat mozgató művelet egyetlen tranzakció.
const crypto = require('crypto');
const { levelFromXp } = require('./progression');
const { ITEMS, CURRENCIES, DAILY_MISSIONS, WEEKLY_MISSIONS, ACHIEVEMENTS, TERRITORIES, BUILDINGS, LEADERBOARDS, RARITIES } = require('./catalog');
const { FACTIONS } = require('./content');

class GameError extends Error {}
const fail = (message) => { throw new GameError(message); };

const CLAN_RANKS = { recruit: 0, member: 1, officer: 2, co_leader: 3, leader: 4 };
const CLAN_CREATE_COST = 500;
const BATTLE_TTL_MS = 20 * 60 * 1000;
const ATTACK_COOLDOWN_MS = 5 * 60 * 1000;
const RAID_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_INVENTORY_TRADE_ITEMS = 12;
const DAY_MS = 86400000;

const text = (v, min, max, what) => {
  if (typeof v !== 'string') fail(`Érvénytelen ${what}.`);
  const t = v.trim();
  if (t.length < min || t.length > max) fail(`A(z) ${what} ${min}-${max} karakter lehet.`);
  return t;
};
const int = (v, min, max, what) => {
  if (!Number.isSafeInteger(v) || v < min || v > max) fail(`Érvénytelen ${what}.`);
  return v;
};

const hashString = (value) => crypto.createHash('sha256').update(value).digest().readUInt32BE(0);

function pickMissions(pool, period, count) {
  return [...pool].sort((a, b) => hashString(period + a.id) - hashString(period + b.id)).slice(0, count);
}

function createGameMeta(db, { now = () => Date.now(), hour = () => new Date().getHours() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_player_meta (account_id TEXT PRIMARY KEY, username TEXT, faction TEXT, suspended_until INTEGER NOT NULL DEFAULT 0, last_attack INTEGER NOT NULL DEFAULT 0, last_collect INTEGER NOT NULL DEFAULT 0, last_raid INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS game_wallets (account_id TEXT PRIMARY KEY, coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0), gems INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0), war_tokens INTEGER NOT NULL DEFAULT 0 CHECK (war_tokens >= 0), season_tokens INTEGER NOT NULL DEFAULT 0 CHECK (season_tokens >= 0));
    CREATE TABLE IF NOT EXISTS game_stats (scope TEXT NOT NULL, account_id TEXT NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope, account_id, key));
    CREATE INDEX IF NOT EXISTS idx_game_stats_board ON game_stats(scope, key, value DESC);
    CREATE TABLE IF NOT EXISTS game_inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, item_id TEXT NOT NULL, acquired_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_game_inventory_account ON game_inventory(account_id);
    CREATE TABLE IF NOT EXISTS game_equipped (account_id TEXT NOT NULL, slot TEXT NOT NULL, inventory_id INTEGER NOT NULL, PRIMARY KEY (account_id, slot));
    CREATE TABLE IF NOT EXISTS game_missions (account_id TEXT NOT NULL, mission_id TEXT NOT NULL, period TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, mission_id, period));
    CREATE TABLE IF NOT EXISTS game_achievements (account_id TEXT NOT NULL, achievement_id TEXT NOT NULL, earned_at INTEGER NOT NULL, PRIMARY KEY (account_id, achievement_id));
    CREATE TABLE IF NOT EXISTS game_clans (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', logo TEXT NOT NULL DEFAULT '🫧', open INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, war_wins INTEGER NOT NULL DEFAULT 0, contribution INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS game_clan_members (account_id TEXT PRIMARY KEY, clan_id TEXT NOT NULL REFERENCES game_clans(id), rank INTEGER NOT NULL, joined_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_game_clan_members_clan ON game_clan_members(clan_id);
    CREATE TABLE IF NOT EXISTS game_clan_invites (clan_id TEXT NOT NULL, account_id TEXT NOT NULL, PRIMARY KEY (clan_id, account_id));
    CREATE TABLE IF NOT EXISTS game_clan_chat (id INTEGER PRIMARY KEY AUTOINCREMENT, clan_id TEXT NOT NULL, username TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS game_trades (id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, offer_a TEXT NOT NULL DEFAULT '{}', offer_b TEXT NOT NULL DEFAULT '{}', confirm_a INTEGER NOT NULL DEFAULT 0, confirm_b INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_game_trades_a ON game_trades(a); CREATE INDEX IF NOT EXISTS idx_game_trades_b ON game_trades(b);
    CREATE TABLE IF NOT EXISTS game_territories (id TEXT PRIMARY KEY, owner TEXT, defense INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS game_battles (id TEXT PRIMARY KEY, territory_id TEXT NOT NULL, attacker TEXT NOT NULL, defender TEXT, status TEXT NOT NULL, winner TEXT, season_id INTEGER, created_at INTEGER NOT NULL, resolved_at INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_game_battles_open ON game_battles(territory_id) WHERE status = 'open';
    CREATE TABLE IF NOT EXISTS game_seasons (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, status TEXT NOT NULL, winner TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS game_faction_points (season_id INTEGER NOT NULL, faction TEXT NOT NULL, points INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (season_id, faction));
    CREATE TABLE IF NOT EXISTS game_base (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, type TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, ready_at INTEGER NOT NULL, health INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_game_base_account ON game_base(account_id);
    CREATE TABLE IF NOT EXISTS game_friends (a TEXT NOT NULL, b TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (a, b));
    CREATE TABLE IF NOT EXISTS game_blocks (account_id TEXT NOT NULL, blocked_id TEXT NOT NULL, PRIMARY KEY (account_id, blocked_id));
    CREATE TABLE IF NOT EXISTS game_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE IF NOT EXISTS game_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS game_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const seedTerritory = db.prepare('INSERT OR IGNORE INTO game_territories (id, owner, defense, updated_at) VALUES (?, ?, ?, ?)');
  for (const t of TERRITORIES) seedTerritory.run(t.id, t.start || null, t.start ? 3 : 1, now());

  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = (fn) => db.transaction(fn);

  const setting = (key, fallback) => {
    const row = get('SELECT value FROM game_settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : fallback;
  };
  const setSetting = (key, value) => run('INSERT INTO game_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

  const audit = (actor, action, detail) => run('INSERT INTO game_audit (actor, action, detail, at) VALUES (?, ?, ?, ?)', actor, action, JSON.stringify(detail), now());

  function ensurePlayer(accountId, username) {
    run('INSERT OR IGNORE INTO game_player_meta (account_id, username) VALUES (?, ?)', accountId, username || null);
    run('INSERT OR IGNORE INTO game_wallets (account_id) VALUES (?)', accountId);
    if (username) run('UPDATE game_player_meta SET username = ? WHERE account_id = ?', username, accountId);
  }

  const playerRow = (accountId) => get('SELECT * FROM game_player_meta WHERE account_id = ?', accountId);
  const wallet = (accountId) => {
    const row = get('SELECT coins, gems, war_tokens, season_tokens FROM game_wallets WHERE account_id = ?', accountId);
    return row || { coins: 0, gems: 0, war_tokens: 0, season_tokens: 0 };
  };

  function addCurrency(accountId, currency, amount) {
    if (!CURRENCIES.includes(currency)) throw new Error('ismeretlen valuta');
    run('INSERT OR IGNORE INTO game_wallets (account_id) VALUES (?)', accountId);
    if (amount < 0 && wallet(accountId)[currency] < -amount) fail('Nincs elég fedezeted.');
    run(`UPDATE game_wallets SET ${currency} = ${currency} + ? WHERE account_id = ?`, amount, accountId);
  }
  const giveRewards = (accountId, reward) => {
    for (const [currency, amount] of Object.entries(reward)) addCurrency(accountId, currency, amount);
  };

  function accountByName(username) {
    const name = text(username, 1, 64, 'felhasználónév');
    let row = get('SELECT account_id AS id, username FROM game_player_meta WHERE username = ? COLLATE NOCASE', name);
    if (!row) {
      try {
        row = get('SELECT id, username FROM accounts WHERE username = ? COLLATE NOCASE', name);
      } catch {
        row = null;
      }
    }
    if (!row) fail('Nincs ilyen játékos.');
    return row;
  }
  const nameOf = (id) => get('SELECT username FROM game_player_meta WHERE account_id = ?', id)?.username || 'Ismeretlen';

  // ---- Évszakok ----
  function currentSeason() {
    let season = get("SELECT * FROM game_seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1");
    if (!season) {
      const days = setting('season_days', 30);
      const t = now();
      const { lastInsertRowid } = run("INSERT INTO game_seasons (started_at, ends_at, status) VALUES (?, ?, 'active')", t, t + days * DAY_MS);
      season = get('SELECT * FROM game_seasons WHERE id = ?', lastInsertRowid);
    }
    return season;
  }

  const addFactionPoints = (seasonId, faction, points) => {
    run('INSERT INTO game_faction_points (season_id, faction, points) VALUES (?, ?, ?) ON CONFLICT(season_id, faction) DO UPDATE SET points = points + excluded.points', seasonId, faction, points);
  };

  function factionStandings(seasonId) {
    const points = Object.fromEntries(all('SELECT faction, points FROM game_faction_points WHERE season_id = ?', seasonId).map((r) => [r.faction, r.points]));
    const territories = Object.fromEntries(Object.keys(FACTIONS).map((f) => [f, 0]));
    for (const t of all('SELECT owner, id FROM game_territories WHERE owner IS NOT NULL')) {
      territories[t.owner] += TERRITORIES.find((d) => d.id === t.id)?.value || 0;
    }
    return Object.keys(FACTIONS).map((f) => ({ faction: f, points: points[f] || 0, territoryValue: territories[f], total: (points[f] || 0) + territories[f] * 25 })).sort((a, b) => b.total - a.total);
  }

  // Lezárás, jutalmak, archiválás és új évszak egyetlen tranzakcióban. Az állapot-feltétel miatt csak egyszer futhat le.
  const endSeason = tx((seasonId) => {
    const season = get("SELECT * FROM game_seasons WHERE id = ? AND status = 'active'", seasonId);
    if (!season) return null;
    const standings = factionStandings(season.id);
    const winner = standings[0].total > (standings[1]?.total ?? -1) ? standings[0].faction : null;

    const scope = `season:${season.id}`;
    const top = all("SELECT account_id, value FROM game_stats WHERE scope = ? AND key = 'contribution' ORDER BY value DESC LIMIT 10", scope);
    const participants = all("SELECT DISTINCT account_id FROM game_stats WHERE scope = ? AND key = 'contribution'", scope);
    for (const { account_id: id } of participants) {
      const meta = playerRow(id);
      addCurrency(id, 'season_tokens', 20);
      if (winner && meta?.faction === winner) addCurrency(id, 'gems', 25);
    }
    top.forEach((row, index) => {
      addCurrency(row.account_id, 'gems', Math.max(10, 100 - index * 10));
      if (index === 0) run('INSERT INTO game_inventory (account_id, item_id, acquired_at) VALUES (?, ?, ?)', row.account_id, 'title_season', now());
    });

    const summary = JSON.stringify({ standings, top: top.map((r) => ({ username: nameOf(r.account_id), value: r.value })) });
    run("UPDATE game_seasons SET status = 'ended', winner = ?, summary = ? WHERE id = ?", winner, summary, season.id);
    run("UPDATE game_battles SET status = 'cancelled', resolved_at = ? WHERE status = 'open'", now());
    for (const t of TERRITORIES) run('UPDATE game_territories SET owner = ?, defense = ?, updated_at = ? WHERE id = ?', t.start || null, t.start ? 3 : 1, now(), t.id);
    // A frakcióválasztás évszakonként újra eldönthető, a tartós fejlődés megmarad
    run('UPDATE game_player_meta SET faction = NULL');
    const next = currentSeason();
    return { ended: season.id, winner, next: next.id };
  });

  function maintain() {
    const season = currentSeason();
    run("UPDATE game_battles SET status = 'expired', resolved_at = ? WHERE status = 'open' AND created_at < ?", now(), now() - BATTLE_TTL_MS);
    return season.ends_at <= now() ? endSeason(season.id) : null;
  }

  // ---- Küldetések ----
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);
  const weekKey = () => {
    const d = new Date(now());
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    return `w${monday.toISOString().slice(0, 10)}`;
  };
  const activeMissions = () => [
    ...pickMissions(DAILY_MISSIONS, dayKey(), 3).map((m) => ({ ...m, period: dayKey(), kind: 'daily' })),
    ...pickMissions(WEEKLY_MISSIONS, weekKey(), 2).map((m) => ({ ...m, period: weekKey(), kind: 'weekly' }))
  ];

  function advanceMissions(accountId, deltas) {
    for (const m of activeMissions()) {
      const amount = deltas[m.metric] || 0;
      if (amount <= 0) continue;
      run('INSERT INTO game_missions (account_id, mission_id, period, progress) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, mission_id, period) DO UPDATE SET progress = progress + excluded.progress', accountId, m.id, m.period, amount);
    }
  }

  const missions = (accountId) => activeMissions().map((m) => {
    const row = get('SELECT progress, claimed FROM game_missions WHERE account_id = ? AND mission_id = ? AND period = ?', accountId, m.id, m.period);
    return { ...m, progress: Math.min(m.goal, row?.progress || 0), claimed: !!row?.claimed };
  });

  const claimMission = tx((accountId, missionId) => {
    const m = activeMissions().find((q) => q.id === missionId);
    if (!m) fail('Ez a küldetés nem aktív.');
    const row = get('SELECT progress, claimed FROM game_missions WHERE account_id = ? AND mission_id = ? AND period = ?', accountId, m.id, m.period);
    if (!row || row.progress < m.goal) fail('A küldetés még nincs kész.');
    const { changes } = run('UPDATE game_missions SET claimed = 1 WHERE account_id = ? AND mission_id = ? AND period = ? AND claimed = 0', accountId, m.id, m.period);
    if (!changes) fail('A jutalmat már átvetted.');
    giveRewards(accountId, m.reward);
    return { reward: m.reward };
  });

  // ---- Statisztikák, eredmények ----
  const MAX_KEYS = new Set(['survival_best']);

  function addStat(scope, accountId, key, amount) {
    if (MAX_KEYS.has(key)) {
      run('INSERT INTO game_stats (scope, account_id, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(scope, account_id, key) DO UPDATE SET value = MAX(value, excluded.value)', scope, accountId, key, amount);
    } else {
      run('INSERT INTO game_stats (scope, account_id, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(scope, account_id, key) DO UPDATE SET value = value + excluded.value', scope, accountId, key, amount);
    }
  }
  const statsOf = (accountId, scope = 'life') => Object.fromEntries(all('SELECT key, value FROM game_stats WHERE scope = ? AND account_id = ?', scope, accountId).map((r) => [r.key, r.value]));

  function grantAchievement(accountId, id, earned) {
    const { changes } = run('INSERT OR IGNORE INTO game_achievements (account_id, achievement_id, earned_at) VALUES (?, ?, ?)', accountId, id, now());
    if (!changes) return;
    earned.push(id);
    const def = ACHIEVEMENTS.find((a) => a.id === id);
    if (def.reward) run('INSERT INTO game_inventory (account_id, item_id, acquired_at) VALUES (?, ?, ?)', accountId, def.reward, now());
    addCurrency(accountId, 'gems', def.secret ? 15 : 5);
  }

  function evaluateAchievements(accountId, ctx) {
    const earned = [];
    const { stats, player, result, outcome, level, muted } = ctx;
    const check = (id, condition) => { if (condition) grantAchievement(accountId, id, earned); };
    check('first_win', (stats.wins || 0) >= 1);
    check('night_owl', hour() === 3);
    check('the_gathering', result.playerCount >= 10);
    check('silence_master', outcome === 'win' && muted);
    check('chaos_unlocked', result.chaos === true);
    check('titan_slayer', (player.counters.titan_kills || 0) > 0);
    check('void_hunter', (player.counters.secret_boss_kills || 0) > 0);
    check('scrub_god', level >= 100);
    check('wave_10', (stats.survival_best || 0) >= 10);
    check('podium', (player.counters.race_wins || 0) > 0);
    check('last_bubble', (player.counters.royale_wins || 0) > 0);
    check('conqueror', (stats.territories_captured || 0) >= 1);
    check('clan_victor', (player.counters.clan_war_wins || 0) > 0);
    check('centurion', (stats.kills || 0) >= 100);
    check('collector', get('SELECT COUNT(*) c FROM game_inventory WHERE account_id = ?', accountId).c >= 5);
    return earned;
  }

  const achievements = (accountId) => {
    const earned = new Map(all('SELECT achievement_id, earned_at FROM game_achievements WHERE account_id = ?', accountId).map((r) => [r.achievement_id, r.earned_at]));
    return ACHIEVEMENTS.map((a) => {
      const has = earned.has(a.id);
      if (a.secret && !has) return { id: a.id, name: '???', desc: 'Titkos eredmény.', secret: true, earned: false };
      return { id: a.id, name: a.name, desc: a.desc, secret: !!a.secret, earned: has, earnedAt: earned.get(a.id) || null };
    });
  };

  // ---- Bázis bónuszok ----
  const buildings = (accountId, type) => all('SELECT * FROM game_base WHERE account_id = ? AND type = ? AND ready_at <= ? AND health > 0', accountId, type, now());
  const levelBonus = (accountId, type, field) => Math.min(0.2, buildings(accountId, type).reduce((sum, b) => sum + BUILDINGS[type][field] * b.level, 0));
  const modifyXp = (accountId, xp) => Math.round(xp * (1 + levelBonus(accountId, 'gym', 'xpBonus')) * setting('xp_multiplier', 1));

  // A store tranzakcióján belül fut: egy játékos egy meccsének minden tartós következménye
  function applyPlayerMatch(accountId, rawPlayer, result, outcome, xp, totalXp, muted) {
    const player = { counters: {}, ...rawPlayer };
    ensurePlayer(accountId, player.username);
    const season = currentSeason();
    const scope = `season:${season.id}`;
    const rewards = { coins: 0, seasonTokens: 0, warTokens: 0, achievements: [] };
    if (xp <= 0) return rewards;

    rewards.coins = Math.round((xp / 4) * (1 + levelBonus(accountId, 'lab', 'coinBonus')));
    rewards.seasonTokens = 1;
    addCurrency(accountId, 'coins', rewards.coins);
    addCurrency(accountId, 'season_tokens', 1);

    const { counters } = player;
    const contribution = player.kills * 2 + player.assists + (outcome === 'win' ? 15 : 3) + (counters.boss_kills || 0) * 10;
    const clan = get('SELECT clan_id FROM game_clan_members WHERE account_id = ?', accountId);
    const deltas = {
      xp, matches: 1, kills: player.kills, deaths: player.deaths, assists: player.assists, damage: player.damage,
      wins: outcome === 'win' ? 1 : 0, losses: outcome === 'loss' ? 1 : 0, contribution, playtime_s: result.durationS,
      races: result.mode === 'racing' ? 1 : 0, clan_activity: clan ? 1 : 0,
      ...counters
    };
    for (const [key, amount] of Object.entries(deltas)) {
      if (!amount) continue;
      addStat('life', accountId, key, amount);
      addStat(scope, accountId, key, amount);
    }
    advanceMissions(accountId, deltas);

    if (counters.clan_war_wins) {
      rewards.warTokens = 15;
      addCurrency(accountId, 'war_tokens', 15);
    }
    const faction = playerRow(accountId)?.faction;
    if (faction) addFactionPoints(season.id, faction, contribution);
    if (clan) {
      run('UPDATE game_clans SET xp = xp + ?, wins = wins + ?, war_wins = war_wins + ?, contribution = contribution + ? WHERE id = ?', Math.round(xp / 5), outcome === 'win' ? 1 : 0, counters.clan_war_wins ? 1 : 0, contribution, clan.clan_id);
    }

    const stats = statsOf(accountId);
    rewards.achievements = evaluateAchievements(accountId, { stats, player, result, outcome, level: levelFromXp(totalXp), muted });
    return rewards;
  }

  // ---- Bolt, leltár ----
  const catalogue = () => ({ rarities: RARITIES, items: Object.values(ITEMS).filter((i) => i.price).map((i) => ({ ...i })) });

  const inventory = (accountId) => {
    const equipped = new Set(all('SELECT inventory_id FROM game_equipped WHERE account_id = ?', accountId).map((r) => r.inventory_id));
    return all('SELECT id, item_id FROM game_inventory WHERE account_id = ? ORDER BY id DESC', accountId).map((r) => ({ id: r.id, equipped: equipped.has(r.id), item: ITEMS[r.item_id] }));
  };

  const buy = tx((accountId, itemId) => {
    const i = Object.prototype.hasOwnProperty.call(ITEMS, itemId) ? ITEMS[itemId] : null;
    if (!i?.price) fail('Ez a tárgy nem vásárolható meg.');
    if (i.slot !== 'collectible' && get('SELECT 1 FROM game_inventory WHERE account_id = ? AND item_id = ?', accountId, itemId)) fail('Ez már megvan neked.');
    addCurrency(accountId, i.price.currency, -i.price.amount);
    const { lastInsertRowid } = run('INSERT INTO game_inventory (account_id, item_id, acquired_at) VALUES (?, ?, ?)', accountId, itemId, now());
    return { inventoryId: Number(lastInsertRowid), wallet: wallet(accountId) };
  });

  const equip = tx((accountId, inventoryId, unequip) => {
    const row = get('SELECT item_id FROM game_inventory WHERE id = ? AND account_id = ?', inventoryId, accountId);
    if (!row) fail('Ez nem a te tárgyad.');
    const i = ITEMS[row.item_id];
    if (i.slot === 'collectible') fail('Gyűjtői tárgyat nem lehet felvenni.');
    if (unequip) run('DELETE FROM game_equipped WHERE account_id = ? AND inventory_id = ?', accountId, inventoryId);
    else run('INSERT INTO game_equipped (account_id, slot, inventory_id) VALUES (?, ?, ?) ON CONFLICT(account_id, slot) DO UPDATE SET inventory_id = excluded.inventory_id', accountId, i.slot, inventoryId);
    return {};
  });

  function cosmeticsOf(accountId) {
    const merged = {};
    for (const r of all('SELECT i.item_id FROM game_equipped e JOIN game_inventory i ON i.id = e.inventory_id WHERE e.account_id = ?', accountId)) {
      Object.assign(merged, ITEMS[r.item_id]?.visual);
    }
    return merged;
  }

  // ---- Ranglisták ----
  function leaderboard(board) {
    const def = Object.prototype.hasOwnProperty.call(LEADERBOARDS, board) ? LEADERBOARDS[board] : null;
    if (board === 'clans') return { name: 'Legjobb klán', rows: all('SELECT name, logo, xp AS value FROM game_clans ORDER BY xp DESC LIMIT 25').map((r) => ({ username: `${r.logo} ${r.name}`, value: r.value })) };
    if (!def) fail('Ismeretlen ranglista.');
    const scope = def.season ? `season:${currentSeason().id}` : 'life';
    return { name: def.name, rows: all('SELECT s.value, m.username FROM game_stats s LEFT JOIN game_player_meta m ON m.account_id = s.account_id WHERE s.scope = ? AND s.key = ? AND s.value > 0 ORDER BY s.value DESC LIMIT 25', scope, def.key) };
  }
  const leaderboards = () => [...Object.entries(LEADERBOARDS).map(([id, d]) => ({ id, name: d.name })), { id: 'clans', name: 'Legjobb klán' }];

  // ---- Klánok ----
  const membership = (accountId) => get('SELECT * FROM game_clan_members WHERE account_id = ?', accountId);
  const requireRank = (accountId, min) => {
    const m = membership(accountId);
    if (!m) fail('Nem vagy klán tagja.');
    if (m.rank < min) fail('Ehhez nincs elég magas rangod.');
    return m;
  };
  const targetMember = (clanId, username) => {
    const target = accountByName(username);
    const m = membership(target.id);
    if (!m || m.clan_id !== clanId) fail('Ő nem a klánod tagja.');
    return m;
  };

  const clanCreate = tx((accountId, name, description) => {
    if (membership(accountId)) fail('Már klán tagja vagy.');
    const clean = text(name, 3, 24, 'klánnév');
    if (!/^[\p{L}\p{N} _-]+$/u.test(clean)) fail('A klánnév csak betűt, számot és szóközt tartalmazhat.');
    if (get('SELECT 1 FROM game_clans WHERE name = ? COLLATE NOCASE', clean)) fail('Ez a klánnév foglalt.');
    addCurrency(accountId, 'coins', -CLAN_CREATE_COST);
    const id = crypto.randomUUID();
    run('INSERT INTO game_clans (id, name, description, created_at) VALUES (?, ?, ?, ?)', id, clean, typeof description === 'string' ? description.slice(0, 200) : '', now());
    run('INSERT INTO game_clan_members (account_id, clan_id, rank, joined_at) VALUES (?, ?, ?, ?)', accountId, id, CLAN_RANKS.leader, now());
    return { clanId: id };
  });

  const clanJoin = tx((accountId, clanId) => {
    if (membership(accountId)) fail('Már klán tagja vagy.');
    const clan = get('SELECT * FROM game_clans WHERE id = ?', clanId);
    if (!clan) fail('Nincs ilyen klán.');
    const invited = get('SELECT 1 FROM game_clan_invites WHERE clan_id = ? AND account_id = ?', clanId, accountId);
    if (!clan.open && !invited) fail('Ebbe a klánba csak meghívással lehet belépni.');
    run('DELETE FROM game_clan_invites WHERE account_id = ?', accountId);
    run('INSERT INTO game_clan_members (account_id, clan_id, rank, joined_at) VALUES (?, ?, ?, ?)', accountId, clanId, CLAN_RANKS.recruit, now());
    return {};
  });

  const clanInvite = (accountId, username) => {
    const me = requireRank(accountId, CLAN_RANKS.officer);
    const target = accountByName(username);
    if (membership(target.id)) fail('Ő már klán tagja.');
    if (get('SELECT 1 FROM game_blocks WHERE account_id = ? AND blocked_id = ?', target.id, accountId)) fail('Ő nem fogad meghívást tőled.');
    run('INSERT OR IGNORE INTO game_clan_invites (clan_id, account_id) VALUES (?, ?)', me.clan_id, target.id);
    return { invited: target.id };
  };

  const clanLeave = tx((accountId) => {
    const me = requireRank(accountId, CLAN_RANKS.recruit);
    run('DELETE FROM game_clan_members WHERE account_id = ?', accountId);
    const next = get('SELECT account_id FROM game_clan_members WHERE clan_id = ? ORDER BY rank DESC, joined_at ASC LIMIT 1', me.clan_id);
    if (!next) {
      run('DELETE FROM game_clan_invites WHERE clan_id = ?', me.clan_id);
      run('DELETE FROM game_clan_chat WHERE clan_id = ?', me.clan_id);
      run('DELETE FROM game_clans WHERE id = ?', me.clan_id);
    } else if (me.rank === CLAN_RANKS.leader) {
      run('UPDATE game_clan_members SET rank = ? WHERE account_id = ?', CLAN_RANKS.leader, next.account_id);
    }
    return {};
  });

  const clanKick = tx((accountId, username) => {
    const me = requireRank(accountId, CLAN_RANKS.officer);
    const target = targetMember(me.clan_id, username);
    if (target.rank >= me.rank) fail('Csak alacsonyabb rangút távolíthatsz el.');
    run('DELETE FROM game_clan_members WHERE account_id = ?', target.account_id);
    return {};
  });

  const clanSetRank = tx((accountId, username, rank) => {
    const me = requireRank(accountId, CLAN_RANKS.co_leader);
    const value = Object.prototype.hasOwnProperty.call(CLAN_RANKS, rank) ? CLAN_RANKS[rank] : fail('Ismeretlen rang.');
    const target = targetMember(me.clan_id, username);
    if (target.account_id === accountId) fail('A saját rangodat nem módosíthatod.');
    if (target.rank >= me.rank) fail('Magasabb vagy egyenrangú tagot nem módosíthatsz.');
    if (value === CLAN_RANKS.leader) {
      if (me.rank !== CLAN_RANKS.leader) fail('Csak a vezető adhatja át a vezetést.');
      run('UPDATE game_clan_members SET rank = ? WHERE account_id = ?', CLAN_RANKS.co_leader, accountId);
    } else if (value >= me.rank) {
      fail('Csak a sajátodnál alacsonyabb rangot adhatsz.');
    }
    run('UPDATE game_clan_members SET rank = ? WHERE account_id = ?', value, target.account_id);
    return {};
  });

  const clanUpdate = (accountId, { description, logo, open }) => {
    const me = requireRank(accountId, CLAN_RANKS.co_leader);
    if (typeof description === 'string') run('UPDATE game_clans SET description = ? WHERE id = ?', description.slice(0, 200), me.clan_id);
    if (typeof logo === 'string' && [...logo].length >= 1 && [...logo].length <= 4) run('UPDATE game_clans SET logo = ? WHERE id = ?', logo, me.clan_id);
    if (typeof open === 'boolean') run('UPDATE game_clans SET open = ? WHERE id = ?', open ? 1 : 0, me.clan_id);
    return {};
  };

  function clanInfo(accountId) {
    const me = membership(accountId);
    const invites = all('SELECT c.id, c.name, c.logo FROM game_clan_invites i JOIN game_clans c ON c.id = i.clan_id WHERE i.account_id = ?', accountId);
    const list = all('SELECT c.id, c.name, c.logo, c.open, c.xp, (SELECT COUNT(*) FROM game_clan_members m WHERE m.clan_id = c.id) AS members FROM game_clans c ORDER BY c.xp DESC LIMIT 30');
    if (!me) return { clan: null, invites, list };
    const clan = get('SELECT * FROM game_clans WHERE id = ?', me.clan_id);
    const members = all('SELECT m.account_id, m.rank, p.username FROM game_clan_members m LEFT JOIN game_player_meta p ON p.account_id = m.account_id WHERE m.clan_id = ? ORDER BY m.rank DESC', me.clan_id)
      .map((m) => ({ username: m.username || 'Ismeretlen', rank: Object.keys(CLAN_RANKS).find((k) => CLAN_RANKS[k] === m.rank), self: m.account_id === accountId }));
    const chat = all('SELECT username, text, at FROM game_clan_chat WHERE clan_id = ? ORDER BY id DESC LIMIT 50', me.clan_id).reverse();
    return { clan, members, chat, myRank: Object.keys(CLAN_RANKS).find((k) => CLAN_RANKS[k] === me.rank), invites, list };
  }

  const clanChat = (accountId, username, message) => {
    const me = requireRank(accountId, CLAN_RANKS.recruit);
    const entry = { username, text: text(message, 1, 300, 'üzenet'), at: now() };
    run('INSERT INTO game_clan_chat (clan_id, username, text, at) VALUES (?, ?, ?, ?)', me.clan_id, username, entry.text, entry.at);
    run('DELETE FROM game_clan_chat WHERE clan_id = ? AND id NOT IN (SELECT id FROM game_clan_chat WHERE clan_id = ? ORDER BY id DESC LIMIT 200)', me.clan_id, me.clan_id);
    return { clanId: me.clan_id, entry };
  };

  const clanOf = (accountId) => membership(accountId)?.clan_id || null;

  // ---- Kereskedelem ----
  const tradeRow = (id) => get('SELECT * FROM game_trades WHERE id = ?', id);
  const tradeSideOf = (trade, accountId) => (trade.a === accountId ? 'a' : trade.b === accountId ? 'b' : fail('Ez nem a te cseréd.'));

  const tradeCreate = tx((accountId, username) => {
    const target = accountByName(username);
    if (target.id === accountId) fail('Magaddal nem cserélhetsz.');
    if (get('SELECT 1 FROM game_blocks WHERE (account_id = ? AND blocked_id = ?) OR (account_id = ? AND blocked_id = ?)', accountId, target.id, target.id, accountId)) fail('A csere nem lehetséges.');
    if (get("SELECT 1 FROM game_trades WHERE status IN ('pending','active') AND ((a = ? AND b = ?) OR (a = ? AND b = ?))", accountId, target.id, target.id, accountId)) fail('Már van közös nyitott cserétek.');
    const id = crypto.randomUUID();
    run("INSERT INTO game_trades (id, a, b, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)", id, accountId, target.id, now(), now());
    return { tradeId: id, to: target.id };
  });

  const tradeAccept = (accountId, tradeId) => {
    const trade = tradeRow(tradeId) || fail('Nincs ilyen csere.');
    if (trade.b !== accountId) fail('Ezt a kérést csak a címzett fogadhatja el.');
    const { changes } = run("UPDATE game_trades SET status = 'active', updated_at = ? WHERE id = ? AND status = 'pending'", now(), tradeId);
    if (!changes) fail('A kérés már nem aktív.');
    return { other: trade.a };
  };

  function validateOffer(accountId, offer) {
    const items = Array.isArray(offer?.items) ? offer.items : [];
    const coins = offer?.coins ?? 0;
    int(coins, 0, 100000000, 'érmemennyiség');
    if (items.length > MAX_INVENTORY_TRADE_ITEMS) fail('Túl sok tárgy egy cseréhez.');
    if (new Set(items).size !== items.length) fail('Ugyanaz a tárgy kétszer szerepel.');
    for (const id of items) {
      int(id, 1, Number.MAX_SAFE_INTEGER, 'tárgy');
      const row = get('SELECT item_id FROM game_inventory WHERE id = ? AND account_id = ?', id, accountId);
      if (!row) fail('A felajánlott tárgy nem a tiéd.');
      if (!ITEMS[row.item_id].tradable) fail('Ez a tárgy nem cserélhető.');
    }
    if (wallet(accountId).coins < coins) fail('Nincs ennyi érméd.');
    return { items, coins };
  }

  // Bármelyik fél módosítása nullázza a megerősítéseket, így nem lehet az utolsó pillanatban kicserélni az ajánlatot
  const tradeSetOffer = tx((accountId, tradeId, offer) => {
    const trade = tradeRow(tradeId) || fail('Nincs ilyen csere.');
    const side = tradeSideOf(trade, accountId);
    if (trade.status !== 'active') fail('A csere nem aktív.');
    const clean = validateOffer(accountId, offer);
    run(`UPDATE game_trades SET offer_${side} = ?, confirm_a = 0, confirm_b = 0, updated_at = ? WHERE id = ?`, JSON.stringify(clean), now(), tradeId);
    return { other: side === 'a' ? trade.b : trade.a };
  });

  const tradeConfirm = tx((accountId, tradeId) => {
    const trade = tradeRow(tradeId) || fail('Nincs ilyen csere.');
    const side = tradeSideOf(trade, accountId);
    if (trade.status !== 'active') fail('A csere nem aktív.');
    run(`UPDATE game_trades SET confirm_${side} = 1, updated_at = ? WHERE id = ?`, now(), tradeId);
    const fresh = tradeRow(tradeId);
    const other = side === 'a' ? trade.b : trade.a;
    if (!(fresh.confirm_a && fresh.confirm_b)) return { completed: false, other };

    // Végrehajtás előtt újraellenőrizzük a birtoklást: közben eladhatta vagy elcserélhette
    const offerA = validateOffer(fresh.a, JSON.parse(fresh.offer_a));
    const offerB = validateOffer(fresh.b, JSON.parse(fresh.offer_b));
    if (!offerA.items.length && !offerB.items.length && !offerA.coins && !offerB.coins) fail('Üres cserét nem lehet megerősíteni.');
    const move = (from, to, offer) => {
      for (const id of offer.items) {
        run('DELETE FROM game_equipped WHERE inventory_id = ?', id);
        const { changes } = run('UPDATE game_inventory SET account_id = ? WHERE id = ? AND account_id = ?', to, id, from);
        if (!changes) fail('A csere nem hajtható végre.');
      }
      if (offer.coins) {
        addCurrency(from, 'coins', -offer.coins);
        addCurrency(to, 'coins', offer.coins);
      }
    };
    move(fresh.a, fresh.b, offerA);
    move(fresh.b, fresh.a, offerB);
    run("UPDATE game_trades SET status = 'completed', updated_at = ? WHERE id = ?", now(), tradeId);
    return { completed: true, other };
  });

  const tradeCancel = (accountId, tradeId) => {
    const trade = tradeRow(tradeId) || fail('Nincs ilyen csere.');
    const side = tradeSideOf(trade, accountId);
    const { changes } = run("UPDATE game_trades SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending','active')", now(), tradeId);
    if (!changes) fail('A csere már lezárult.');
    return { other: side === 'a' ? trade.b : trade.a };
  };

  function describeOffer(json) {
    const offer = JSON.parse(json);
    return {
      coins: offer.coins || 0,
      items: (offer.items || []).map((id) => {
        const row = get('SELECT item_id FROM game_inventory WHERE id = ?', id);
        return { id, name: row ? ITEMS[row.item_id].name : 'Eltűnt tárgy', rarity: row ? ITEMS[row.item_id].rarity : 'common' };
      })
    };
  }

  const trades = (accountId) => all('SELECT * FROM game_trades WHERE a = ? OR b = ? ORDER BY updated_at DESC LIMIT 30', accountId, accountId).map((t) => {
    const mine = t.a === accountId ? 'a' : 'b';
    const theirs = mine === 'a' ? 'b' : 'a';
    return {
      id: t.id, status: t.status, incoming: t.b === accountId, partner: nameOf(mine === 'a' ? t.b : t.a), updatedAt: t.updated_at,
      myOffer: describeOffer(t[`offer_${mine}`]), theirOffer: describeOffer(t[`offer_${theirs}`]),
      myConfirm: !!t[`confirm_${mine}`], theirConfirm: !!t[`confirm_${theirs}`]
    };
  });

  // ---- Frakciók, területek ----
  const setFaction = tx((accountId, username, faction) => {
    if (!Object.prototype.hasOwnProperty.call(FACTIONS, faction)) fail('Ismeretlen frakció.');
    ensurePlayer(accountId, username);
    const { changes } = run('UPDATE game_player_meta SET faction = ? WHERE account_id = ? AND faction IS NULL', faction, accountId);
    if (!changes) fail('Ebben az évszakban már választottál frakciót.');
    return {};
  });

  function warMap() {
    const rows = new Map(all('SELECT * FROM game_territories').map((r) => [r.id, r]));
    const battles = all("SELECT * FROM game_battles WHERE status = 'open'");
    return {
      territories: TERRITORIES.map((t) => {
        const row = rows.get(t.id);
        const history = all('SELECT attacker, winner, resolved_at FROM game_battles WHERE territory_id = ? AND status = ? ORDER BY resolved_at DESC LIMIT 5', t.id, 'resolved');
        return { ...t, owner: row.owner, defense: row.defense, battle: battles.find((b) => b.territory_id === t.id) || null, history };
      }),
      standings: factionStandings(currentSeason().id)
    };
  }

  const canAttack = (faction, t, owner) => {
    if (owner === faction) return false;
    return t.links.some((id) => get('SELECT owner FROM game_territories WHERE id = ?', id).owner === faction);
  };

  const warAttack = tx((accountId, territoryId) => {
    const meta = playerRow(accountId);
    if (!meta?.faction) fail('Előbb válassz frakciót.');
    if (now() - meta.last_attack < ATTACK_COOLDOWN_MS) fail('Nemrég már indítottál támadást, várj egy kicsit.');
    const t = TERRITORIES.find((q) => q.id === territoryId) || fail('Nincs ilyen terület.');
    const row = get('SELECT * FROM game_territories WHERE id = ?', t.id);
    if (!canAttack(meta.faction, t, row.owner)) fail('Csak saját területtel szomszédos ellenséges vagy semleges terület támadható.');
    if (get("SELECT 1 FROM game_battles WHERE territory_id = ? AND status = 'open'", t.id)) fail('Itt már folyik csata.');
    const id = crypto.randomUUID();
    run("INSERT INTO game_battles (id, territory_id, attacker, defender, status, season_id, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?)", id, t.id, meta.faction, row.owner, currentSeason().id, now());
    run('UPDATE game_player_meta SET last_attack = ? WHERE account_id = ?', now(), accountId);
    return { battleId: id, territory: t.name, attacker: meta.faction };
  });

  const getBattle = (id) => {
    if (typeof id !== 'string') return null;
    const battle = get("SELECT * FROM game_battles WHERE id = ? AND status = 'open'", id);
    if (!battle) return null;
    return { ...battle, defense: get('SELECT defense FROM game_territories WHERE id = ?', battle.territory_id).defense, territoryName: TERRITORIES.find((t) => t.id === battle.territory_id).name };
  };
  const factionOf = (accountId) => playerRow(accountId)?.faction || null;

  // Az állapotfeltétel garantálja, hogy egy csata pontosan egyszer dől el, egymással ütköző eredmény nélkül
  function resolveBattle(battleId, winnerFaction, participants) {
    const { changes } = run("UPDATE game_battles SET status = 'resolved', winner = ?, resolved_at = ? WHERE id = ? AND status = 'open'", winnerFaction, now(), battleId);
    if (!changes) return false;
    const battle = get('SELECT * FROM game_battles WHERE id = ?', battleId);
    const t = TERRITORIES.find((q) => q.id === battle.territory_id);
    const season = currentSeason();
    const scope = `season:${season.id}`;
    if (winnerFaction === battle.attacker) {
      run('UPDATE game_territories SET owner = ?, defense = 1, updated_at = ? WHERE id = ?', battle.attacker, now(), t.id);
      addFactionPoints(season.id, battle.attacker, t.value * 20);
      for (const accountId of participants) {
        if (factionOf(accountId) !== battle.attacker) continue;
        addStat('life', accountId, 'territories_captured', 1);
        addStat(scope, accountId, 'territories_captured', 1);
        advanceMissions(accountId, { territories_captured: 1 });
        addCurrency(accountId, 'war_tokens', 10 + t.value * 2);
        const earned = [];
        if (!get("SELECT 1 FROM game_achievements WHERE account_id = ? AND achievement_id = 'conqueror'", accountId)) grantAchievement(accountId, 'conqueror', earned);
      }
    } else if (winnerFaction) {
      run('UPDATE game_territories SET defense = MIN(defense + 1, 5), updated_at = ? WHERE id = ?', now(), t.id);
      addFactionPoints(season.id, winnerFaction, t.value * 8);
      for (const accountId of participants) if (factionOf(accountId) === winnerFaction) addCurrency(accountId, 'war_tokens', 6);
    }
    return true;
  }

  // ---- Bázis ----
  function baseState(accountId) {
    const list = all('SELECT * FROM game_base WHERE account_id = ? ORDER BY id', accountId).map((b) => ({ ...b, ready: b.ready_at <= now(), def: BUILDINGS[b.type], maxHealth: BUILDINGS[b.type].health * b.level }));
    const meta = playerRow(accountId);
    return { buildings: list, catalog: Object.values(BUILDINGS), pending: pendingProduction(accountId, meta), defense: baseDefense(accountId), raidReadyAt: (meta?.last_raid || 0) + RAID_COOLDOWN_MS, now: now() };
  }
  function pendingProduction(accountId, meta) {
    const last = meta?.last_collect || 0;
    const hours = Math.min(24, last ? (now() - last) / 3600000 : 0);
    return Math.floor(buildings(accountId, 'generator').reduce((sum, b) => sum + BUILDINGS.generator.production * b.level, 0) * hours);
  }
  const baseDefense = (accountId) => ['tower', 'wall'].reduce((sum, type) => sum + buildings(accountId, type).reduce((acc, b) => acc + BUILDINGS[type].defense * b.level, 0), 0);

  const baseBuild = tx((accountId, username, type) => {
    const def = Object.prototype.hasOwnProperty.call(BUILDINGS, type) ? BUILDINGS[type] : fail('Ismeretlen épület.');
    ensurePlayer(accountId, username);
    if (get('SELECT COUNT(*) c FROM game_base WHERE account_id = ? AND type = ?', accountId, type).c >= def.max) fail('Ebből több nem építhető.');
    addCurrency(accountId, 'coins', -def.cost);
    run('INSERT INTO game_base (account_id, type, ready_at, health) VALUES (?, ?, ?, ?)', accountId, type, now() + def.time * 1000, def.health);
    if (!playerRow(accountId).last_collect) run('UPDATE game_player_meta SET last_collect = ? WHERE account_id = ?', now(), accountId);
    return {};
  });

  const baseUpgrade = tx((accountId, id) => {
    const b = get('SELECT * FROM game_base WHERE id = ? AND account_id = ?', id, accountId) || fail('Nincs ilyen épületed.');
    if (b.ready_at > now()) fail('Még épül.');
    const def = BUILDINGS[b.type];
    if (b.level >= def.maxLevel) fail('Már a legmagasabb szinten van.');
    addCurrency(accountId, 'coins', -def.cost * (b.level + 1));
    run('UPDATE game_base SET level = level + 1, ready_at = ?, health = ? WHERE id = ?', now() + def.time * 1000 * (b.level + 1), def.health * (b.level + 1), id);
    return {};
  });

  const baseRepair = tx((accountId, id) => {
    const b = get('SELECT * FROM game_base WHERE id = ? AND account_id = ?', id, accountId) || fail('Nincs ilyen épületed.');
    const max = BUILDINGS[b.type].health * b.level;
    if (b.health >= max) fail('Ez az épület ép.');
    addCurrency(accountId, 'coins', -Math.ceil((max - b.health) / 2));
    run('UPDATE game_base SET health = ? WHERE id = ?', max, id);
    return {};
  });

  const baseCollect = tx((accountId) => {
    const meta = playerRow(accountId);
    const amount = pendingProduction(accountId, meta);
    if (amount <= 0) fail('Még nincs mit begyűjteni.');
    run('UPDATE game_player_meta SET last_collect = ? WHERE account_id = ?', now(), accountId);
    addCurrency(accountId, 'coins', amount);
    return { amount };
  });

  // Rajtaütés: a szerver számolja az erőviszonyt, sikernél épületek sérülnek és érme kerül át
  const baseRaid = tx((accountId, username, rng) => {
    const target = accountByName(username);
    if (target.id === accountId) fail('Saját magadat nem támadhatod.');
    const meta = playerRow(accountId) || fail('Előbb játssz egy meccset.');
    if (now() - meta.last_raid < RAID_COOLDOWN_MS) fail('Még nem indíthatsz újabb rajtaütést.');
    const list = all('SELECT * FROM game_base WHERE account_id = ? AND health > 0 AND ready_at <= ?', target.id, now());
    if (!list.length) fail('Ennek a játékosnak nincs támadható bázisa.');
    const armory = buildings(accountId, 'armory').reduce((sum, b) => sum + BUILDINGS.armory.raid * b.level, 0);
    const attack = 30 + armory + rng() * 60;
    const defense = baseDefense(target.id) + rng() * 40;
    run('UPDATE game_player_meta SET last_raid = ? WHERE account_id = ?', now(), accountId);
    if (attack <= defense) return { success: false, attack: Math.round(attack), defense: Math.round(defense), stolen: 0 };

    const hit = list[Math.floor(rng() * list.length)];
    const damage = Math.round(60 + (attack - defense) * 3);
    run('UPDATE game_base SET health = MAX(0, health - ?) WHERE id = ?', damage, hit.id);
    const stolen = Math.min(wallet(target.id).coins, Math.round(20 + (attack - defense) * 2));
    if (stolen) {
      addCurrency(target.id, 'coins', -stolen);
      addCurrency(accountId, 'coins', stolen);
    }
    return { success: true, attack: Math.round(attack), defense: Math.round(defense), stolen, damaged: BUILDINGS[hit.type].name };
  });

  // ---- Közösség ----
  const friends = (accountId) => {
    const out = all("SELECT a, b, status FROM game_friends WHERE a = ? OR b = ?", accountId, accountId);
    return out.map((r) => {
      const other = r.a === accountId ? r.b : r.a;
      return { accountId: other, username: nameOf(other), status: r.status, incoming: r.b === accountId && r.status === 'pending' };
    });
  };
  const friendRequest = tx((accountId, username) => {
    const target = accountByName(username);
    if (target.id === accountId) fail('Magadat nem jelölheted.');
    if (get('SELECT 1 FROM game_blocks WHERE account_id = ? AND blocked_id = ?', target.id, accountId)) fail('A jelölés nem lehetséges.');
    if (get('SELECT 1 FROM game_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', accountId, target.id, target.id, accountId)) fail('Már van közös kapcsolatotok vagy jelölésetek.');
    ensurePlayer(target.id, target.username);
    run("INSERT INTO game_friends (a, b, status) VALUES (?, ?, 'pending')", accountId, target.id);
    return { to: target.id };
  });
  const friendAccept = (accountId, username) => {
    const target = accountByName(username);
    const { changes } = run("UPDATE game_friends SET status = 'accepted' WHERE a = ? AND b = ? AND status = 'pending'", target.id, accountId);
    if (!changes) fail('Nincs ilyen jelölés.');
    return {};
  };
  const friendRemove = (accountId, username) => {
    const target = accountByName(username);
    run('DELETE FROM game_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', accountId, target.id, target.id, accountId);
    return {};
  };
  const isFriend = (a, b) => !!get("SELECT 1 FROM game_friends WHERE status = 'accepted' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))", a, b, b, a);

  const block = tx((accountId, username) => {
    const target = accountByName(username);
    if (target.id === accountId) fail('Magadat nem tilthatod le.');
    run('INSERT OR IGNORE INTO game_blocks (account_id, blocked_id) VALUES (?, ?)', accountId, target.id);
    run('DELETE FROM game_friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', accountId, target.id, target.id, accountId);
    return {};
  });
  const report = (accountId, username, reason) => {
    const target = accountByName(username);
    if (get('SELECT COUNT(*) c FROM game_reports WHERE reporter = ? AND at > ?', accountId, now() - 3600000).c >= 10) fail('Túl sok jelentés rövid idő alatt.');
    run('INSERT INTO game_reports (reporter, target, reason, at) VALUES (?, ?, ?, ?)', accountId, target.id, text(reason, 3, 300, 'indok'), now());
    return {};
  };

  function profile(accountId) {
    const base = get('SELECT * FROM game_profiles WHERE account_id = ?', accountId);
    const xp = base?.xp || 0;
    const meta = playerRow(accountId);
    return {
      username: meta?.username || null, faction: meta?.faction || null, xp, level: levelFromXp(xp), badge: rankBadge(levelFromXp(xp)),
      title: cosmeticsOf(accountId).title || null, stats: statsOf(accountId),
      history: all('SELECT p.team, p.outcome, p.kills, p.deaths, p.damage, p.xp_awarded, m.mode, m.ended_at, m.duration_s FROM game_match_players p JOIN game_matches m ON m.id = p.match_id WHERE p.account_id = ? ORDER BY m.ended_at DESC LIMIT 20', accountId)
    };
  }
  const rankBadge = (level) => ['Újonc', 'Bronz', 'Ezüst', 'Arany', 'Platina', 'Gyémánt'][Math.min(5, Math.floor(level / 20))];

  function overview(accountId) {
    return { profile: profile(accountId), wallet: wallet(accountId), season: currentSeason(), clanId: clanOf(accountId) };
  }

  const seasons = () => ({
    current: currentSeason(),
    standings: factionStandings(currentSeason().id),
    history: all("SELECT id, started_at, ends_at, winner, summary FROM game_seasons WHERE status = 'ended' ORDER BY id DESC LIMIT 12").map((r) => ({ ...r, summary: JSON.parse(r.summary) }))
  });

  const isSuspended = (accountId) => (playerRow(accountId)?.suspended_until || 0) > now();

  // ---- Admin ----
  const admin = {
    overview: () => ({
      season: currentSeason(),
      seasonDays: setting('season_days', 30),
      xpMultiplier: setting('xp_multiplier', 1),
      disabledModes: setting('disabled_modes', []),
      reports: all("SELECT r.id, r.reason, r.at, a.username AS reporter, b.username AS target FROM game_reports r LEFT JOIN game_player_meta a ON a.account_id = r.reporter LEFT JOIN game_player_meta b ON b.account_id = r.target WHERE r.status = 'open' ORDER BY r.id DESC LIMIT 50"),
      audit: all('SELECT actor, action, detail, at FROM game_audit ORDER BY id DESC LIMIT 30')
    }),
    setSeasonDays(actor, days) {
      int(days, 1, 365, 'időtartam');
      setSetting('season_days', days);
      audit(actor, 'season_days', { days });
      return {};
    },
    setXpMultiplier(actor, value) {
      if (typeof value !== 'number' || !(value >= 0 && value <= 5)) fail('Érvénytelen szorzó.');
      setSetting('xp_multiplier', value);
      audit(actor, 'xp_multiplier', { value });
      return {};
    },
    setDisabledModes(actor, modes) {
      if (!Array.isArray(modes) || !modes.every((m) => typeof m === 'string')) fail('Érvénytelen módlista.');
      setSetting('disabled_modes', modes);
      audit(actor, 'disabled_modes', { modes });
      return {};
    },
    endSeasonNow(actor) {
      const result = endSeason(currentSeason().id);
      audit(actor, 'end_season', result || {});
      return result || {};
    },
    setTerritory(actor, id, owner) {
      if (!TERRITORIES.some((t) => t.id === id)) fail('Nincs ilyen terület.');
      if (owner !== null && !Object.prototype.hasOwnProperty.call(FACTIONS, owner)) fail('Ismeretlen frakció.');
      run('UPDATE game_territories SET owner = ?, updated_at = ? WHERE id = ?', owner, now(), id);
      audit(actor, 'set_territory', { id, owner });
      return {};
    },
    suspend(actor, username, hours) {
      const target = accountByName(username);
      int(hours, 0, 24 * 365, 'időtartam');
      ensurePlayer(target.id, target.username);
      run('UPDATE game_player_meta SET suspended_until = ? WHERE account_id = ?', hours ? now() + hours * 3600000 : 0, target.id);
      audit(actor, 'suspend', { username: target.username, hours });
      return {};
    },
    closeReport(actor, id) {
      int(id, 1, Number.MAX_SAFE_INTEGER, 'jelentés');
      run("UPDATE game_reports SET status = 'closed' WHERE id = ?", id);
      audit(actor, 'close_report', { id });
      return {};
    },
    playerDetail(actor, username) {
      const target = accountByName(username);
      audit(actor, 'view_player', { username: target.username });
      return { profile: profile(target.id), wallet: wallet(target.id), suspendedUntil: playerRow(target.id)?.suspended_until || 0, trades: trades(target.id).slice(0, 15) };
    }
  };

  const isModeDisabled = (mode) => setting('disabled_modes', []).includes(mode);

  currentSeason();

  return {
    GameError, ensurePlayer, wallet, addCurrency, overview, profile, maintain, endSeason, currentSeason, factionStandings,
    missions, claimMission, achievements, catalogue, inventory, buy, equip, cosmeticsOf, leaderboard, leaderboards,
    clanCreate, clanJoin, clanInvite, clanLeave, clanKick, clanSetRank, clanUpdate, clanInfo, clanChat, clanOf,
    tradeCreate, tradeAccept, tradeSetOffer, tradeConfirm, tradeCancel, trades,
    setFaction, factionOf, warMap, warAttack, getBattle, resolveBattle,
    baseState, baseBuild, baseUpgrade, baseRepair, baseCollect, baseRaid,
    friends, friendRequest, friendAccept, friendRemove, isFriend, block, report,
    seasons, isSuspended, isModeDisabled, modifyXp, applyPlayerMatch, admin, accountByName
  };
}

module.exports = { createGameMeta, GameError, CLAN_RANKS };
