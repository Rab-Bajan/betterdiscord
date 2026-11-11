// Biztonsági tesztek: összeomlást okozó payloadok, prototípus-szennyezés, verdikt-visszaélés.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { setupMiskolcPhobia } = require('../miskolcPhobiaHandler');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (sock, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    sock.once(ev, (d) => { clearTimeout(t); res(d); });
  });

describe('MiskolcPhobia security', () => {
  let server, io, phobia, url, c1, c2;
  const room = 'sec_room_' + Date.now();
  const crashes = [];
  const onCrash = (e) => crashes.push(e);

  before(async () => {
    process.on('uncaughtException', onCrash);
    server = http.createServer();
    io = new Server(server, { cors: { origin: '*' } });
    phobia = setupMiskolcPhobia(io, new Map());
    await new Promise((r) => server.listen(0, r));
    url = `http://localhost:${server.address().port}`;
    c1 = ioClient(url, { transports: ['websocket'], reconnection: false });
    c2 = ioClient(url, { transports: ['websocket'], reconnection: false });
    c1.on('error', () => {});
    c2.on('error', () => {});
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    c1.emit('phobia:init-session', { roomId: room, userId: 'sec_u1', username: 'Egy' });
    await once(c1, 'phobia:session-init');
  });

  after(async () => {
    process.off('uncaughtException', onCrash);
    c1.close(); c2.close();
    clearInterval(phobia.tickInterval);
    await new Promise((r) => server.close(r));
  });

  it('C3: malformed payloads of every phobia event never crash the process', async () => {
    const events = [
      'init-session', 'flashlight-toggle', 'player-move',
      'pickup-item', 'item-pickup', 'drop-item', 'item-drop', 'door-toggle', 'breaker-toggle', 'light-toggle',
      'use-sanity-palinka', 'use-smudge', 'photo-captured', 'get-temperature', 'trigger-ghost-interaction',
      'trigger-hunt', 'submit-verdict', 'get-profile', 'player-speaking', 'gate-toggle'
    ];
    const bad = [null, 5, 'x', [], [1, 2], { roomId: 5 }, { roomId: { a: 1 } }, { roomId: room, itemId: { a: 1 } },
      { roomId: room, itemId: 'x'.repeat(500) }, { roomId: room, slot: 'a' }, { roomId: room, slot: 99 },
      { roomId: room, position: ['a', null, NaN] }, { roomId: room, position: { x: 1 } }, { roomId: room, userId: 12 },
      { roomId: room, doorId: ['a'] }, { roomId: room, lightId: 7 }, { roomId: room, ghostGuess: { a: 1 } }];
    for (const ev of events) for (const p of bad) c1.emit('phobia:' + ev, p);
    for (const ev of ['start-session', 'stop-session', 'leave-session']) for (const p of bad.slice(0, 7)) c1.emit('phobia:' + ev, p);
    await wait(1200); // a sebességkorlát ablaka lejár
    assert.deepStrictEqual(crashes, []);
    c1.emit('phobia:get-profile');
    const prof = await once(c1, 'phobia:profile-data');
    assert.ok(prof.profile);
  });

  it('C2: __proto__/constructor ids are rejected for doors and lights', async () => {
    const session = phobia.sessions.get(room);
    let got = false;
    const h = () => { got = true; };
    c1.on('phobia:door-updated', h);
    c1.on('phobia:light-updated', h);
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      c1.emit('phobia:door-toggle', { roomId: room, doorId: id });
      c1.emit('phobia:light-toggle', { roomId: room, lightId: id });
    }
    await wait(200);
    c1.off('phobia:door-updated', h);
    c1.off('phobia:light-updated', h);
    assert.strictEqual(got, false);
    assert.strictEqual(session.activeLights.size, 0);
    assert.strictEqual(Object.prototype.open, undefined);
  });

  it('C1: empty/short guesses are rejected and do not conclude the match', async () => {
    const session = phobia.sessions.get(room);
    for (const g of ['', 'a', '  ', 'ab']) {
      const rej = once(c1, 'phobia:verdict-rejected');
      c1.emit('phobia:submit-verdict', { roomId: room, ghostGuess: g });
      await rej;
    }
    await wait(100);
    assert.strictEqual(session.status, 'active');
  });

  it('C1: correct verdict pays the server-side identity only, and only once', async () => {
    const r2 = 'sec_room_v_' + Date.now();
    c2.emit('phobia:init-session', { roomId: r2, userId: 'victim_account_id', username: 'Ketto' });
    await once(c2, 'phobia:session-init');
    const session = phobia.sessions.get(r2);
    const name = session.ghost.type?.name || session.ghost.typeName || session.ghost.name;
    const before = phobia.db.prepare('SELECT COUNT(*) c FROM phobia_profiles WHERE userId = ?').get('victim_account_id').c;
    const done = once(c2, 'phobia:match-concluded');
    c2.emit('phobia:submit-verdict', { roomId: r2, ghostGuess: name, userId: 'victim_account_id' });
    const out = await done;
    assert.strictEqual(out.correct, true);
    assert.strictEqual(phobia.db.prepare('SELECT COUNT(*) c FROM phobia_profiles WHERE userId = ?').get('victim_account_id').c, before);
    assert.strictEqual(out.profile.userId, c2.id);
    assert.ok(session.paidOut.has(c2.id));
  });
});
