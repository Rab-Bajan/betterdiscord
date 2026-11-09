// MiskolcEmpire E2E: valódi Socket.IO szerver és kliensek, memóriában tartott adatbázis.
// Futtatás: node scripts/test_miskolc_empire_e2e.js   (hibánál nem nulla kilépési kóddal áll meg)
// A játékidőt a kézi empire.tick() hívások gyorsítják, a türelmi idő rövidített (GRACE_MS).
const http = require('http');
const path = require('path');
const assert = require('assert');
const { createRequire } = require('module');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const { setupMiskolcEmpire } = require('../miskolcEmpireHandler');

const { io: connect } = createRequire(path.resolve(__dirname, '../../betterdiscord-frontend/package.json'))('socket.io-client');

const GRACE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
let step = 0;
const log = (msg) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${++step}. ${msg}`);

async function until(pred, ms = 6000, what = 'feltétel') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await pred();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`Időtúllépés: ${what}`);
}

async function main() {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  const users = new Map();
  io.on('connection', (socket) => {
    const a = socket.handshake.auth;
    users.set(socket.id, { id: socket.id, username: a.username, accountId: a.accountId || null, authenticated: a.authenticated === true, voiceChannel: a.room || null });
    socket.on('disconnect', () => users.delete(socket.id));
  });
  const db = new Database(':memory:');
  const empire = setupMiskolcEmpire(io, users, { db, graceMs: GRACE_MS, tickMs: 100 });
  await new Promise((r) => httpServer.listen(0, r));
  const { port } = httpServer.address();
  const sockets = [];

  // Kliens: összegyűjti a tickeket, a snapshot-ot és a meccs végét, a saját állapotot is vezeti
  async function client(auth) {
    const socket = connect(`http://127.0.0.1:${port}`, { auth, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const c = { socket, ticks: [], snaps: [], ended: null, sessionEvents: [], res: null, paused: null, seen: new Map(), dead: new Set(), built: new Set(), tickCount: 0 };
    socket.on('empire:snapshot', (s) => { c.snaps.push(s); c.res = s.res; c.paused = s.paused; c.seen.clear(); for (const u of s.units) c.seen.set(u.i, u); for (const b of s.buildings) c.seen.set(b.i, b); });
    socket.on('empire:tick', (t) => {
      c.ticks.push(t); c.tickCount++;
      if (t.r) c.res = t.r;
      if ('p' in t) c.paused = t.p;
      for (const u of t.u || []) c.seen.set(u.i, { ...(c.seen.get(u.i) || {}), ...u });
      for (const b of t.b || []) c.seen.set(b.i, { ...(c.seen.get(b.i) || {}), ...b });
      for (const id of t.x || []) c.seen.delete(id);
      for (const e of t.ev || []) { if (e.e === 'dead') c.dead.add(e.i); if (e.e === 'built') c.built.add(e.i); }
    });
    socket.on('empire:match-ended', (m) => { c.ended = m; });
    socket.on('empire:session-updated', (m) => c.sessionEvents.push(m));
    c.call = (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Nincs ack: ${event}`)), 5000);
      socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
    });
    return c;
  }
  const pump = async (n) => { for (let i = 0; i < n; i++) { empire.tick(); if (i % 100 === 99) await sleep(10); } await sleep(150); };
  const match = (roomId) => empire.sessions.get(roomId).match;
  const authed = (n, room) => ({ username: `jatekos${n}`, accountId: `acc${n}`, authenticated: true, room });

  // ---- 1. tartalom és alap védelmek ----
  const A = await client(authed(1, 'hang-1'));
  const B = await client({ username: 'Vendeg', accountId: 'acc1', authenticated: false, room: 'hang-1' }); // hamis accountId
  const content = await A.call('empire:get-content');
  assert.strictEqual(content.ok, true);
  assert.strictEqual(content.content.buildings.house.names[1].name, 'Lakótelepi lakás');
  assert.strictEqual(content.content.epochs.length, 5);
  log('empire:get-content rendben');
  assert.strictEqual((await A.call('empire:create-match', { mode: 'xx' })).ok, false);
  assert.strictEqual((await A.call('empire:create-match', { mode: '1v1', channelId: 'masik-szoba' })).ok, false);
  assert.strictEqual((await A.call('empire:join-match', { roomId: '__proto__' })).ok, false);
  assert.strictEqual((await A.call('empire:command', { roomId: 'hang-1', type: 'move' })).ok, false);
  log('érvénytelen kérések elutasítva');

  // ---- 2. meccs létrehozása, csatlakozás, indítás ----
  const created = await A.call('empire:create-match', { channelId: 'hang-1', mode: '1v1', name: 'Teszt meccs' });
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.roomId, 'hang-1');
  assert.ok(created.rejoinToken && created.rejoinToken.length >= 16);
  assert.strictEqual(created.summary.status, 'lobby');
  assert.strictEqual((await A.call('empire:create-match', { mode: '1v1' })).ok, false); // már meccsben
  const joined = await B.call('empire:join-match', { roomId: 'hang-1' });
  assert.strictEqual(joined.ok, true);
  assert.strictEqual(joined.summary.players.length, 2);
  assert.strictEqual((await B.call('empire:start-match', { roomId: 'hang-1' })).ok, false); // nem házigazda
  assert.deepStrictEqual(Object.keys(empire.getEmpireSessions()), ['hang-1']);
  const listed = await A.call('empire:list-matches');
  assert.strictEqual(listed.matches.length, 1);
  const startRes = await A.call('empire:start-match', { roomId: 'hang-1' });
  assert.strictEqual(startRes.ok, true);
  await until(() => A.snaps.length && B.snaps.length, 3000, 'snapshot');
  const sa = A.snaps[0];
  assert.strictEqual(sa.you.idx, 0);
  assert.strictEqual(B.snaps[0].you.idx, 1);
  assert.strictEqual(sa.tickHz, 10);
  assert.ok(sa.units.every((u) => u.o === 0) && sa.buildings.every((b) => b.o === 0), 'ellenség a snapshotban');
  assert.strictEqual(sa.map.tiles.length, sa.map.w * sa.map.h);
  assert.ok(sa.nodes.length > 10);
  log('meccs létrejött, mindkét játékos megkapta a snapshotot, ellenség nem szivárog');

  // ---- 3. valós idejű ciklus ----
  const before = A.tickCount;
  await sleep(1500);
  assert.ok(A.tickCount >= before + 1, 'a közös időzítő nem küld tickeket');
  log(`a közös setInterval működik (${A.tickCount - before} tick 1,5 mp alatt)`);

  // ---- 4. gyűjtés ----
  const room = 'hang-1';
  const iron0 = A.res.iron;
  const scav = sa.units.filter((u) => u.k === 'scavenger');
  const node = sa.nodes.filter((n) => n.k === 'iron').sort((p, q) => Math.hypot(p.x - scav[0].x, p.y - scav[0].y) - Math.hypot(q.x - scav[0].x, q.y - scav[0].y))[0];
  const foreignIds = B.snaps[0].units.map((u) => u.i);
  const bad = await A.call('empire:command', { roomId: room, type: 'gather', unitIds: foreignIds, target: { nodeId: node.i } });
  assert.strictEqual(bad.ok, false);
  const g = await A.call('empire:command', { roomId: room, type: 'gather', unitIds: scav.map((u) => u.i), target: { nodeId: node.i } });
  assert.strictEqual(g.ok, true);
  await pump(1200);
  await until(() => A.res.iron > iron0, 4000, 'vas gyarapodás');
  log(`gyűjtés: vas ${iron0} -> ${A.res.iron}`);

  // ---- 5. építés ----
  const tc = sa.buildings.find((b) => b.k === 'townCenter');
  const builder = sa.units.find((u) => u.k === 'builder');
  let houseOk = null;
  for (let r = 4; r < 12 && !houseOk; r++) for (let dx = -r; dx <= r && !houseOk; dx += 2) {
    const res = await A.call('empire:command', { roomId: room, type: 'build', unitIds: [builder.i], building: 'house', target: { x: tc.x + dx, y: tc.y - r } });
    if (res.ok) houseOk = res;
  }
  assert.ok(houseOk, 'nem sikerült házat építeni');
  const cap0 = A.res.popCap;
  await pump(450);
  await until(() => A.built.size > 0 && A.res.popCap === cap0 + 8, 4000, 'ház elkészült és nőtt a lakosságkorlát');
  log(`építés: Viskó kész, lakosságkorlát ${cap0} -> ${A.res.popCap}`);

  // ---- 6. harc (az egységeket közvetlenül az állapotba tesszük, a parancsok a socketen mennek) ----
  const m = match(room);
  const aUnits = [0, 1, 2, 3].map((i) => m.createUnit(0, 'brawler', 30 + i * 0.6, 30));
  const bUnits = [0, 1].map((i) => m.createUnit(1, 'ram', 33 + i * 0.6, 30));
  m.players[0].pop += 4; m.players[1].pop += 2;
  await pump(2);
  const targets = bUnits.map((u) => u.id);
  await until(() => targets.every((id) => A.seen.has(id)), 3000, 'az ellenség látótérbe került');
  for (const id of targets) {
    const r = await A.call('empire:command', { roomId: room, type: 'attack', unitIds: aUnits.map((u) => u.id), target: { entityId: id } });
    assert.strictEqual(r.ok, true);
  }
  await pump(400);
  await until(() => targets.every((id) => A.dead.has(id)), 4000, 'dead események');
  assert.ok(m.players[0].stats.unitsKilled >= 2);
  log(`harc: ${targets.length} ellenséges egység elesett, dead esemény megjött`);

  // ---- 7. sebességkorlát ----
  let limited = false;
  for (let i = 0; i < 150 && !limited; i++) { const r = await A.call('empire:command', { roomId: room, type: 'ping', target: { x: 5, y: 5 } }); if (!r.ok && /gyorsan/.test(r.error)) limited = true; }
  assert.ok(limited, 'nincs parancs-sebességkorlát');
  log('parancs-sebességkorlát működik');

  // ---- 8. lekapcsolódás, szünet, visszatérés ----
  const bToken = joined.rejoinToken;
  const tickAt = m.tick;
  B.socket.disconnect();
  await until(() => A.paused, 3000, 'szünet jelzése');
  await sleep(300);
  assert.ok(m.paused && m.paused.untilMs > Date.now() - 1);
  const frozen = m.tick;
  empire.tick(); empire.tick();
  assert.strictEqual(m.tick, frozen, 'szünet alatt lépett a szimuláció');
  assert.ok(frozen >= tickAt);
  assert.strictEqual((await A.call('empire:command', { roomId: room, type: 'ping', target: { x: 9, y: 9 } })).ok, false); // szünetel
  log('lekapcsolódás: a meccs szünetel, a szimuláció áll');
  // vendég a hamis accountId-val nem veheti át a helyet
  const thief = await client({ username: 'Tolvaj', accountId: 'acc2', authenticated: false, room: 'hang-1' });
  assert.strictEqual((await thief.call('empire:join-match', { roomId: room })).ok, false);
  const stolen = await thief.call('empire:join-match', { roomId: room, rejoinToken: 'nem-a-token' });
  assert.strictEqual(stolen.ok, false);
  const B2 = await client({ username: 'Vendeg', accountId: null, authenticated: false, room: 'hang-1' });
  const rejoin = await B2.call('empire:join-match', { roomId: room, rejoinToken: bToken });
  assert.strictEqual(rejoin.ok, true);
  assert.strictEqual(rejoin.idx, 1);
  await until(() => B2.snaps.length > 0, 3000, 'újracsatlakozási snapshot');
  await until(() => A.paused === null, 3000, 'a szünet vége');
  await pump(20);
  assert.ok(m.tick > frozen, 'a szimuláció nem indult újra');
  assert.strictEqual((await B2.call('empire:command', { roomId: room, type: 'ping', target: { x: 9, y: 9 } })).ok, true);
  log('visszatérés a token-nel: snapshot megjött, a játék folytatódik');
  assert.strictEqual((await thief.call('empire:get-state', { roomId: room })).ok, false);

  // ---- 9. türelmi idő lejár, automatikus feladás, meccs vége, statisztika ----
  A.socket.disconnect();
  await sleep(GRACE_MS + 600);
  for (let i = 0; i < 10 && !B2.ended; i++) { empire.tick(); await sleep(100); }
  await until(() => B2.ended, 4000, 'empire:match-ended');
  assert.strictEqual(B2.ended.roomId, room);
  assert.strictEqual(B2.ended.winnerTeam, 1);
  const byIdx = Object.fromEntries(B2.ended.results.map((r) => [r.idx, r]));
  assert.strictEqual(byIdx[0].won, false);
  assert.strictEqual(byIdx[1].won, true);
  assert.ok(byIdx[1].unitsKilled >= 0 && typeof byIdx[0].gathered === 'number');
  assert.ok(!('accountId' in byIdx[0]));
  const rows = db.prepare('SELECT * FROM empire_stats').all();
  assert.strictEqual(rows.length, 1, 'csak a bejelentkezett fiók kerülhet a statisztikába');
  assert.strictEqual(rows[0].account_id, 'acc1');
  assert.strictEqual(rows[0].losses, 1);
  assert.strictEqual(rows[0].wins, 0);
  assert.strictEqual(rows[0].games, 1);
  assert.ok(rows[0].gathered > 0, 'a gyűjtött mennyiség nem került mentésre');
  assert.deepStrictEqual(Object.keys(empire.getEmpireSessions()), []);
  const lastEvt = B2.sessionEvents[B2.sessionEvents.length - 1];
  assert.ok(lastEvt === undefined || lastEvt.state === null);
  log(`türelmi idő lejárt, A automatikusan feladta, B nyert; empire_stats: ${JSON.stringify({ losses: rows[0].losses, games: rows[0].games, gathered: rows[0].gathered })}; a vendég nem szerepel`);

  // ---- 10. két bejelentkezett játékos, feladás, mindkettő rögzül ----
  const D = await client(authed(3, 'hang-2'));
  const E = await client(authed(4, 'hang-2'));
  await D.call('empire:create-match', { channelId: 'hang-2', mode: '1v1' });
  await E.call('empire:join-match', { roomId: 'hang-2' });
  assert.strictEqual((await D.call('empire:start-match', { roomId: 'hang-2' })).ok, true);
  await until(() => D.snaps.length && E.snaps.length, 3000, 'snapshot');
  await pump(50);
  assert.strictEqual((await D.call('empire:resign', { roomId: 'hang-2' })).ok, true);
  await until(() => D.ended && E.ended, 3000, 'match-ended');
  assert.strictEqual(E.ended.winnerTeam, 1);
  const stat = (id) => db.prepare('SELECT * FROM empire_stats WHERE account_id = ?').get(id);
  assert.strictEqual(stat('acc4').wins, 1);
  assert.strictEqual(stat('acc3').losses, 1);
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM empire_stats').get().c, 3);
  log('feladás: győztes és vesztes is rögzítve (hitelesített fiókok)');

  // ---- 11. MI elleni meccs: azonnal indul; mindenki lekapcsolódik -> eldobott meccs, nincs statisztika ----
  const F = await client(authed(5, 'hang-3'));
  const ai = await F.call('empire:create-match', { channelId: 'hang-3', mode: 'ai', difficulty: 'easy' });
  assert.strictEqual(ai.ok, true);
  assert.strictEqual(ai.summary.status, 'playing');
  assert.ok(ai.summary.players.some((p) => p.isAi));
  await until(() => F.snaps.length, 3000, 'MI snapshot');
  const sessNow = await F.call('empire:get-state', { roomId: 'hang-3' });
  assert.strictEqual(sessNow.ok, true);
  assert.ok(sessNow.snapshot.units.length > 0);
  F.socket.disconnect();
  await sleep(GRACE_MS + 800);
  for (let i = 0; i < 5; i++) { empire.tick(); await sleep(50); }
  await until(() => !empire.sessions.has('hang-3'), 3000, 'az eldobott meccs törlése');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM empire_stats').get().c, 3, 'az eldobott meccs nem számolhat');
  assert.strictEqual(stat('acc5'), undefined);
  log('mindenki lekapcsolódott: a meccs eldobva, nincs statisztika');

  // ---- 12. lobbi: házigazda-átadás és üres lobbi törlése ----
  const H = await client(authed(6, 'hang-4'));
  const I = await client(authed(7, 'hang-4'));
  await H.call('empire:create-match', { channelId: 'hang-4', mode: 'ffa', maxPlayers: 3 });
  await I.call('empire:join-match', { roomId: 'hang-4' });
  assert.strictEqual(empire.getSession('hang-4').host, 0);
  H.socket.disconnect();
  await until(() => empire.getSession('hang-4')?.players.length === 1, 3000, 'kilépő eltávolítása');
  assert.strictEqual(empire.getSession('hang-4').players[0].name, 'jatekos7');
  assert.strictEqual(empire.getSession('hang-4').host, 0);
  I.socket.disconnect();
  await until(() => !empire.getSession('hang-4'), 3000, 'üres lobbi törlése');
  log('lobbi: házigazda-átadás és üres lobbi törlése rendben');

  const st = await B2.call('empire:get-stats');
  assert.strictEqual(st.ok, true);
}

main().then(() => {
  console.log(`\nMINDEN TESZT SIKERES (${((Date.now() - started) / 1000).toFixed(1)} mp)`);
  process.exit(0);
}).catch((err) => {
  console.error('\nA TESZT SIKERTELEN:', err && err.stack ? err.stack : err);
  process.exit(1);
});
