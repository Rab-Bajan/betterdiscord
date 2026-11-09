// Valódi Socket.IO kapcsolatokon futó integrációs tesztek, memóriában tartott adatbázissal.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const { createRequire } = require('module');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const setupGame = require('../gameHandler');
const { createGameStore } = require('../store');

const { io: connect } = createRequire(path.resolve(__dirname, '../../../betterdiscord-frontend/package.json'))('socket.io-client');

const world = { bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50, height: 20 }, colliders: [], spawns: { soap: [[0, 0, 0]], grime: [[0, 0, -10]] } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createServer(options = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const users = new Map();
  const db = new Database(':memory:');
  const game = setupGame(io, { users, db, world, countdownMs: 50, graceMs: 300, minRewardSeconds: 0, match: { scoreLimit: 1, timeLimit: 30 }, ...options });
  io.on('connection', (socket) => {
    const a = socket.handshake.auth;
    users.set(socket.id, { id: socket.id, username: a.username, accountId: a.accountId || null, authenticated: a.authenticated === true, voiceChannel: a.room || null });
    socket.on('disconnect', () => users.delete(socket.id));
  });
  await new Promise((r) => httpServer.listen(0, r));
  const { port } = httpServer.address();
  const clients = [];
  const client = async (auth) => {
    const socket = connect(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'], reconnection: false });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  const close = async () => {
    clients.forEach((c) => c.disconnect());
    await new Promise((r) => io.close(r));
  };
  return { client, close, game, db, store: createGameStore(db), io };
}

const once = (socket, event, ms = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Nem érkezett: ${event}`)), ms);
  socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
});

const authed = (id, room = 'r1') => ({ username: `u${id}`, accountId: `a${id}`, authenticated: true, room });

async function startPair(srv, authA = authed(1), authB = authed(2)) {
  const a = await srv.client(authA);
  const b = await srv.client(authB);
  a.emit('game:lobby-join', { channelId: authA.room });
  await once(a, 'game:lobby');
  b.emit('game:lobby-join', { channelId: authB.room });
  await once(b, 'game:lobby');
  const started = [once(a, 'game:match-start'), once(b, 'game:match-start')];
  a.emit('game:ready', { ready: true });
  b.emit('game:ready', { ready: true });
  const [infoA, infoB] = await Promise.all(started);
  return { a, b, infoA, infoB };
}

// Az a tüzel előre, amíg a meccs véget nem ér (a szerver számolja a találatokat)
function shootUntilEnd(socket, yaw = 0, pitch = -0.05) {
  let seq = 0;
  const timer = setInterval(() => { seq += 1; socket.emit('game:input', [seq, 0, 0, yaw, pitch, 4]); }, 33);
  return () => clearInterval(timer);
}

test('csak a hangszoba tagja léphet a lobbiba', async () => {
  const srv = await createServer();
  try {
    const outsider = await srv.client(authed(9, 'other'));
    const err = once(outsider, 'game:error');
    outsider.emit('game:lobby-join', { channelId: 'r1' });
    assert.match((await err).message, /hangszoba/);
    assert.strictEqual(srv.game.getSession('r1'), null);
  } finally { await srv.close(); }
});

test('rossz frakció-karakter párost a szerver elutasít', async () => {
  const srv = await createServer();
  try {
    const a = await srv.client(authed(1));
    a.emit('game:lobby-join', { channelId: 'r1' });
    await once(a, 'game:lobby');
    const err = once(a, 'game:error');
    a.emit('game:set-loadout', { team: 'soap', characterId: 'mold_creeper' });
    assert.match((await err).message, /frakció/);
  } finally { await srv.close(); }
});

test('egy játékos egyedül nem tud meccset indítani', async () => {
  const srv = await createServer();
  try {
    const a = await srv.client(authed(1));
    a.emit('game:lobby-join', { channelId: 'r1' });
    await once(a, 'game:lobby');
    const notice = once(a, 'game:notice');
    a.emit('game:ready', { ready: true });
    assert.match((await notice).message, /2 játékos/);
  } finally { await srv.close(); }
});

test('teljes meccs: játék, győzelem, tartós XP, takarítás', async () => {
  const srv = await createServer();
  try {
    const { a, b, infoA, infoB } = await startPair(srv);
    assert.notStrictEqual(infoA.players[infoA.you].team, infoB.players[infoB.you].team);
    assert.strictEqual(srv.game.getStats().liveMatches, 1);

    const shooter = infoA.players[infoA.you].team === 'soap' ? a : b;
    const victim = shooter === a ? b : a;
    let vSeq = 0;
    const idle = setInterval(() => { vSeq += 1; victim.emit('game:input', [vSeq, 0, 0, 0, 0, 0]); }, 33);
    const endP = once(shooter, 'game:match-end', 10000);
    const stop = shootUntilEnd(shooter);
    const end = await endP;
    stop();
    clearInterval(idle);

    assert.strictEqual(end.winner, 'soap');
    assert.strictEqual(end.reason, 'score');
    assert.strictEqual(end.rewardsSaved, true);
    assert.ok(end.players.every((p) => p.key === undefined), 'a fiókkulcs nem szivárog');
    assert.ok(srv.db.prepare('SELECT COUNT(*) c FROM game_matches').get().c === 1);
    const winnerId = shooter === a ? 'a1' : 'a2';
    const profile = srv.store.getProfile(winnerId);
    assert.ok(profile.xp > 0);
    assert.strictEqual(profile.wins, 1);
    await sleep(50);
    assert.strictEqual(srv.game.getStats().liveMatches, 0);
  } finally { await srv.close(); }
});

test('a kliens nem tud kamu pozíciót, sebzést vagy XP-t küldeni', async () => {
  const srv = await createServer({ match: { scoreLimit: 50, timeLimit: 30 } });
  try {
    const { a, infoA } = await startPair(srv);
    const shots = [];
    a.on('game:snapshot', (s) => shots.push(s));
    let seq = 0;
    for (let i = 0; i < 400; i += 1) { seq += 1; a.emit('game:input', [seq, 999, 999, 0, 0, 0]); }
    a.emit('game:input', { x: 9999, y: 0, z: 0, hp: 99999 });
    a.emit('game:match-end', { winner: 'soap' });
    a.emit('game:award', { xp: 999999 });
    await sleep(1000);
    const first = shots[0].p[infoA.you];
    const last = shots[shots.length - 1].p[infoA.you];
    const moved = Math.hypot(last[0] - first[0], last[2] - first[2]);
    assert.ok(moved < 6.5 * 1.05, `elmozdulás: ${moved}`);
    assert.strictEqual(srv.db.prepare('SELECT COUNT(*) c FROM game_profiles').get().c, 0);
  } finally { await srv.close(); }
});

test('hibás és rosszindulatú csomagok nem döntik be a szervert', async () => {
  const srv = await createServer({ match: { scoreLimit: 50, timeLimit: 30 } });
  try {
    const { a } = await startPair(srv);
    const junk = [null, undefined, 1, 'x', [], {}, [NaN, 0, 0, 0, 0, 0], [1, 'a', 0, 0, 0, 0], [1.5, 0, 0, 0, 0, 0], [-1, 0, 0, 0, 0, 0], new Array(1000).fill(1), [Infinity, 0, 0, 0, 0, 0]];
    for (const j of junk) {
      a.emit('game:input', j);
      a.emit('game:lobby-join', j);
      a.emit('game:set-loadout', j);
      a.emit('game:ready', j);
    }
    a.emit('game:set-loadout', { team: '__proto__', characterId: 'constructor' });
    a.emit('game:lobby-join', { channelId: { $ne: 1 } });
    const snap = await once(a, 'game:snapshot');
    assert.ok(snap.p.length === 2, 'a meccs tovább fut');
    assert.strictEqual(srv.game.getStats().liveMatches, 1);
  } finally { await srv.close(); }
});

test('visszacsatlakozás: új sockettel ugyanabba a meccsbe, újra irányítható', async () => {
  const srv = await createServer({ graceMs: 3000, match: { scoreLimit: 50, timeLimit: 30 } });
  try {
    const { a, infoA } = await startPair(srv);
    a.disconnect();
    await sleep(100);
    const again = await srv.client(authed(1));
    const resumed = once(again, 'game:match-start');
    again.emit('game:lobby-join', { channelId: 'r1' });
    const info = await resumed;
    assert.strictEqual(info.resumed, true);
    assert.strictEqual(info.matchId, infoA.matchId);
    assert.strictEqual(srv.game.getStats().liveMatches, 1);

    const start = (await once(again, 'game:snapshot')).p[info.you];
    assert.ok(start[6] & 16, 'csatlakozottként látszik');
    let seq = 0;
    const timer = setInterval(() => { seq += 1; again.emit('game:input', [seq, 1, 0, 0, 0, 0]); }, 33);
    await sleep(500);
    clearInterval(timer);
    const end = (await once(again, 'game:snapshot')).p[info.you];
    assert.ok(Math.abs(end[0] - start[0]) > 1, 'a régi sorszám nem blokkolja az új bemeneteket');
  } finally { await srv.close(); }
});

test('türelmi idő után a meccs lezárul, jutalom nélkül, a lobbi kitakarodik', async () => {
  const srv = await createServer({ graceMs: 200, match: { scoreLimit: 50, timeLimit: 30 } });
  try {
    const { a, b } = await startPair(srv);
    const endP = once(a, 'game:match-end');
    b.disconnect();
    const end = await endP;
    assert.strictEqual(end.reason, 'abandoned');
    assert.strictEqual(srv.store.getProfile('a1').xp, 0);
    await sleep(50);
    a.disconnect();
    await sleep(100);
    assert.deepStrictEqual(srv.game.getStats(), { lobbies: 0, liveMatches: 0 });
  } finally { await srv.close(); }
});

test('a nézetből kilépő játékos a meccs után nem blokkolja a lobbit', async () => {
  const srv = await createServer({ graceMs: 5000, match: { scoreLimit: 1, timeLimit: 30 } });
  try {
    const { a, b, infoA } = await startPair(srv);
    const shooter = infoA.players[infoA.you].team === 'soap' ? a : b;
    const other = shooter === a ? b : a;
    other.emit('game:lobby-leave');
    const lobbyAfter = new Promise((resolve) => shooter.on('game:lobby', (l) => { if (l.phase === 'lobby') resolve(l); }));
    const stop = shootUntilEnd(shooter);
    const lobby = await lobbyAfter;
    stop();
    assert.strictEqual(lobby.players.length, 1);
    assert.ok(lobby.players.every((p) => !p.ready));
  } finally { await srv.close(); }
});

test('hamisított fiókazonosítóval (nem hitelesített) nincs XP', async () => {
  const srv = await createServer();
  try {
    const spoof = { username: 'x', accountId: 'a1', authenticated: false, room: 'r1' };
    const { a, b, infoA } = await startPair(srv, spoof, authed(2));
    const shooter = infoA.players[infoA.you].team === 'soap' ? a : b;
    const other = shooter === a ? b : a;
    let s = 0;
    const idle = setInterval(() => { s += 1; other.emit('game:input', [s, 0, 0, 0, 0, 0]); }, 33);
    const endP = once(shooter, 'game:match-end', 10000);
    const stop = shootUntilEnd(shooter);
    await endP;
    stop();
    clearInterval(idle);
    assert.strictEqual(srv.store.getProfile('a1').xp, 0);
    assert.ok(srv.store.getProfile('a2').matches === 1);
  } finally { await srv.close(); }
});

test('két szoba meccse elkülönül', async () => {
  const srv = await createServer({ match: { scoreLimit: 50, timeLimit: 30 } });
  try {
    const one = await startPair(srv, authed(1, 'r1'), authed(2, 'r1'));
    const two = await startPair(srv, authed(3, 'r2'), authed(4, 'r2'));
    assert.notStrictEqual(one.infoA.matchId, two.infoA.matchId);
    assert.strictEqual(srv.game.getStats().liveMatches, 2);
    let leaked = 0;
    let own = 0;
    one.a.on('game:snapshot', (s) => { if (s.p.length !== 2) leaked += 1; own += 1; });
    two.a.emit('game:input', [1, 1, 0, 0, 0, 0]);
    await sleep(300);
    assert.ok(own > 2);
    assert.strictEqual(leaked, 0);
  } finally { await srv.close(); }
});

test('szimulációs hiba csak az adott meccset állítja le', async () => {
  const srv = await createServer({ match: { scoreLimit: 50, timeLimit: 30 } });
  const original = console.error;
  console.error = () => {};
  try {
    const { a } = await startPair(srv);
    const { Match } = require('../simulation');
    const realTick = Match.prototype.tick;
    Match.prototype.tick = () => { throw new Error('szimulált hiba'); };
    const aborted = await once(a, 'game:match-aborted');
    Match.prototype.tick = realTick;
    assert.match(aborted.message, /megszakadt/);
    assert.strictEqual(srv.game.getStats().liveMatches, 0);
  } finally { console.error = original; await srv.close(); }
});

const lobbyWhere = (socket, pred, ms = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Nem érkezett megfelelő lobbi')), ms);
  const listener = (l) => {
    if (!pred(l)) return;
    clearTimeout(timer);
    socket.off('game:lobby', listener);
    resolve(l);
  };
  socket.on('game:lobby', listener);
});
const playerIn = (l, s) => l.players.find((p) => p.id === s.id);

const joinAll = async (sockets, channelId) => {
  for (const s of sockets) {
    const l = once(s, 'game:lobby');
    s.emit('game:lobby-join', { channelId });
    await l;
  }
};
const pumpIdle = (socket) => {
  let s = 0;
  const t = setInterval(() => { s += 1; socket.emit('game:input', [s, 0, 0, 0, 0, 0]); }, 33);
  return () => clearInterval(t);
};

for (const [mode, n, timeLimit, opts] of [
  ['infection', 3, 1, {}],
  ['survival', 1, 1, {}],
  ['boss', 2, 1, { bossId: 'mold_queen', difficulty: 'hard' }],
  ['royale', 2, 1, {}],
  ['racing', 2, 1, { trackId: 'drain_circuit' }]
]) {
  test(`mód a socketen át: ${mode} indul, snapshotot küld, lezárul és elmentődik, a lobbi kitakarodik`, async () => {
    const srv = await createServer({ match: { timeLimit } });
    try {
      const sockets = await Promise.all(Array.from({ length: n }, (_, i) => srv.client(authed(i + 1))));
      await joinAll(sockets, 'r1');
      const lobbyAfter = lobbyWhere(sockets[0], (l) => l.mode === mode);
      sockets[0].emit('game:set-mode', { mode, options: opts });
      await lobbyAfter;
      const started = sockets.map((s) => once(s, 'game:match-start'));
      sockets.forEach((s) => s.emit('game:ready', { ready: true }));
      const [info] = await Promise.all(started);
      assert.strictEqual(info.mode, mode);
      if (opts.trackId) assert.strictEqual(info.world.id, opts.trackId);
      const stops = sockets.map(pumpIdle);
      assert.strictEqual((await once(sockets[0], 'game:snapshot')).p.length, n);
      const end = await once(sockets[0], 'game:match-end', 6000);
      stops.forEach((f) => f());
      assert.strictEqual(end.mode, mode);
      assert.strictEqual(end.rewardsSaved, true);
      assert.strictEqual(srv.db.prepare('SELECT mode FROM game_matches').get().mode, mode);
      await sleep(30);
      assert.strictEqual(srv.game.getStats().liveMatches, 0);
    } finally { await srv.close(); }
  });
}

test('klánháború a socketen át: két klán kell, oldalak a klán szerint', async () => {
  const srv = await createServer({ match: { timeLimit: 1 } });
  try {
    const a = await srv.client(authed(1));
    const b = await srv.client(authed(2));
    srv.store.meta.ensurePlayer('a1', 'u1');
    srv.store.meta.ensurePlayer('a2', 'u2');
    await joinAll([a, b], 'r1');
    const clanMode = lobbyWhere(a, (l) => l.mode === 'clan_wars');
    a.emit('game:set-mode', { mode: 'clan_wars' });
    await clanMode;
    a.emit('game:ready', { ready: true });
    assert.match((await once(a, 'game:notice')).message, /két klán/);

    srv.store.meta.addCurrency('a1', 'coins', 1000);
    srv.store.meta.addCurrency('a2', 'coins', 1000);
    srv.store.meta.clanCreate('a1', 'Egyik', '');
    srv.store.meta.clanCreate('a2', 'Masik', '');
    const notReady = lobbyWhere(a, (l) => !playerIn(l, a).ready);
    a.emit('game:ready', { ready: false });
    await notReady;
    const started = [once(a, 'game:match-start'), once(b, 'game:match-start')];
    a.emit('game:ready', { ready: true });
    b.emit('game:ready', { ready: true });
    const [info] = await Promise.all(started);
    assert.deepStrictEqual(info.players.map((p) => p.side).sort(), ['a', 'b']);
    assert.strictEqual(info.structures.length, 6);
    assert.strictEqual((await once(a, 'game:snapshot')).st.length, 6);
    await once(a, 'game:match-end', 5000);
  } finally { await srv.close(); }
});

test('területi csata: támadás, frakciós részvétel, eredmény a térképen, duplázás nélkül', async () => {
  const srv = await createServer({ minRewardSeconds: 0, match: { scoreLimit: 1, timeLimit: 30 } });
  try {
    const { meta } = srv.store;
    const a = await srv.client(authed(1));
    const b = await srv.client(authed(2));
    const rpc = (s, method, params) => new Promise((resolve) => s.emit('game:rpc', method, params, resolve));
    assert.strictEqual((await rpc(a, 'setFaction', { faction: 'soap' })).ok, true);
    assert.strictEqual((await rpc(b, 'setFaction', { faction: 'grime' })).ok, true);
    meta.admin.setTerritory('t', 'lather_heights', 'grime');
    const attack = await rpc(a, 'warAttack', { id: 'lather_heights' });
    assert.strictEqual(attack.ok, true, attack.error);
    await joinAll([a, b], 'r1');
    const battleLobby = lobbyWhere(a, (x) => x.battle);
    a.emit('game:set-mode', { mode: 'team_deathmatch', options: { battleId: attack.data.battleId } });
    assert.strictEqual((await battleLobby).battle.attacker, 'soap');

    const teamsSet = lobbyWhere(a, (x) => playerIn(x, a).team === 'soap' && playerIn(x, b).team === 'grime');
    b.emit('game:set-loadout', { team: 'grime', characterId: 'mold_creeper' });
    a.emit('game:set-loadout', { team: 'soap', characterId: 'bar_trooper' });
    await teamsSet;
    const started = [once(a, 'game:match-start'), once(b, 'game:match-start')];
    a.emit('game:ready', { ready: true });
    b.emit('game:ready', { ready: true });
    await Promise.all(started);
    const idle = pumpIdle(b);
    const update = once(b, 'game:war-updated', 9000);
    const endP = once(a, 'game:match-end', 9000);
    const stop = shootUntilEnd(a);
    await endP;
    await update;
    stop();
    idle();
    assert.strictEqual(meta.warMap().territories.find((t) => t.id === 'lather_heights').owner, 'soap');
    assert.ok(meta.wallet('a1').war_tokens > 0);
    assert.strictEqual(meta.getBattle(attack.data.battleId), null);
  } finally { await srv.close(); }
});

test('területi csatába a harcoló frakciókon kívül senki sem léphet', async () => {
  const srv = await createServer();
  try {
    const { meta } = srv.store;
    meta.ensurePlayer('a1', 'u1');
    meta.setFaction('a1', 'u1', 'soap');
    const { battleId } = meta.warAttack('a1', 'lather_heights');
    const stranger = await srv.client(authed(5));
    await joinAll([stranger], 'r1');
    const pending = lobbyWhere(stranger, (x) => x.battle);
    stranger.emit('game:set-mode', { mode: 'survival', options: { battleId } });
    const l = await pending;
    assert.strictEqual(l.mode, 'survival');
    assert.ok(l.modeOptions.waveGoal >= 3);
    stranger.emit('game:ready', { ready: true });
    assert.match((await once(stranger, 'game:notice')).message, /frakciók/);
  } finally { await srv.close(); }
});

test('rpc: vendég kizárva, admin védett, ismeretlen és prototípus-módszer elutasítva', async () => {
  const srv = await createServer();
  try {
    const rpc = (s, method, params) => new Promise((resolve) => s.emit('game:rpc', method, params, resolve));
    const guest = await srv.client({ username: 'g', room: 'r1' });
    assert.strictEqual((await rpc(guest, 'overview')).needsLogin, true);
    const a = await srv.client(authed(1));
    assert.strictEqual((await rpc(a, 'overview')).ok, true);
    assert.match((await rpc(a, 'adminOverview')).error, /jogosultság/);
    assert.match((await rpc(a, 'adminEndSeason')).error, /jogosultság/);
    assert.match((await rpc(a, '__proto__')).error, /Ismeretlen/);
    assert.match((await rpc(a, 'constructor')).error, /Ismeretlen/);
    assert.match((await rpc(a, 'buy', { id: 'hat_crown' })).error, /fedezet/);
    assert.strictEqual((await rpc(a, 'buy', null)).ok, false);
  } finally { await srv.close(); }
});

test('nyilvános és privát lobbi hangszoba nélkül, a privát csak kóddal', async () => {
  const srv = await createServer({ match: { timeLimit: 30 } });
  try {
    const a = await srv.client(authed(1, null));
    const b = await srv.client(authed(2, null));
    const err = once(a, 'game:error');
    a.emit('game:lobby-join', { channelId: 'private:ABCDEF' });
    assert.match((await err).message, /privát/);

    const created = once(a, 'game:private-created');
    a.emit('game:private-create');
    const { channelId } = await created;
    await joinAll([a, b], channelId);
    a.emit('game:lobby-leave');
    b.emit('game:lobby-leave');
    await sleep(50);

    await joinAll([a, b], 'public:team_deathmatch');
    const started = [once(a, 'game:match-start'), once(b, 'game:match-start')];
    a.emit('game:ready', { ready: true });
    b.emit('game:ready', { ready: true });
    const [info] = await Promise.all(started);
    assert.strictEqual(info.mode, 'team_deathmatch');
    assert.strictEqual(srv.game.getStats().liveMatches, 1);
  } finally { await srv.close(); }
});

test('felfüggesztett játékos nem léphet a lobbiba, letiltott mód nem indul', async () => {
  const srv = await createServer();
  try {
    const { meta } = srv.store;
    meta.ensurePlayer('a1', 'u1');
    meta.admin.suspend('t', 'u1', 5);
    const a = await srv.client(authed(1));
    const err = once(a, 'game:error');
    a.emit('game:lobby-join', { channelId: 'r1' });
    assert.match((await err).message, /felfüggesztették/);

    meta.admin.setDisabledModes('t', ['team_deathmatch']);
    const b = await srv.client(authed(2));
    await joinAll([b], 'r1');
    b.emit('game:ready', { ready: true });
    assert.match((await once(b, 'game:notice')).message, /kikapcsolták/);
  } finally { await srv.close(); }
});

test('érdekeltségi szűrés: royale-ban a távoli játékos nem látszik', async () => {
  const srv = await createServer({ match: { timeLimit: 30 } });
  try {
    const a = await srv.client(authed(1));
    const b = await srv.client(authed(2));
    await joinAll([a, b], 'r1');
    const royaleLobby = lobbyWhere(a, (l) => l.mode === 'royale');
    a.emit('game:set-mode', { mode: 'royale' });
    await royaleLobby;
    const started = [once(a, 'game:match-start'), once(b, 'game:match-start')];
    a.emit('game:ready', { ready: true });
    b.emit('game:ready', { ready: true });
    const [infoA] = await Promise.all(started);
    const snap = await once(a, 'game:snapshot');
    const me = snap.p[infoA.you];
    const other = snap.p[1 - infoA.you];
    assert.ok(me);
    if (other) assert.ok(Math.hypot(other[0] - me[0], other[2] - me[2]) <= 95);
    else assert.strictEqual(other, null);
    assert.strictEqual(infoA.world.id, 'drain_city');
  } finally { await srv.close(); }
});
