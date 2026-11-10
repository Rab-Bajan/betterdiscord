// Backend tests: lobby flow, host migration, no-lobby compatibility, survive-hunt/crucifix objectives.
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

describe('MiskolcPhobia handler: lobby and objectives', () => {
  let server, io, phobia, url, c1, c2;
  const lobbyRoom = 'test_room_lobbyflow_' + Date.now();
  const plainRoom = 'test_room_plain_' + Date.now();

  before(async () => {
    server = http.createServer();
    io = new Server(server, { cors: { origin: '*' } });
    phobia = setupMiskolcPhobia(io, new Map());
    await new Promise((r) => server.listen(0, r));
    url = `http://localhost:${server.address().port}`;
    c1 = ioClient(url, { transports: ['websocket'], reconnection: false });
    c2 = ioClient(url, { transports: ['websocket'], reconnection: false });
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
  });

  after(async () => {
    c1.close(); c2.close();
    clearInterval(phobia.tickInterval);
    await new Promise((r) => io.close(r));
  });

  it('sessions without lobby start active with default settings', async () => {
    c1.emit('phobia:init-session', { roomId: plainRoom, username: 'Egy' });
    const init = await once(c1, 'phobia:session-init');
    assert.strictEqual(init.session.status, 'active');
    assert.deepStrictEqual(init.session.settings, { evidenceCount: 3, startingSanity: 100 });
    assert.strictEqual(init.session.primaryObjective.done, false);
    assert.strictEqual(init.session.objectives.length, 3);
    c1.emit('phobia:leave-session', { roomId: plainRoom });
    await wait(50);
  });

  it('lobby does not simulate sanity or ghost, and host migrates when the host leaves', async () => {
    c1.emit('phobia:init-session', { roomId: lobbyRoom, username: 'Host', lobby: true });
    await once(c1, 'phobia:session-init');
    c2.emit('phobia:init-session', { roomId: lobbyRoom, username: 'Vendeg', lobby: true });
    await once(c2, 'phobia:session-init');
    const session = phobia.sessions.get(lobbyRoom);
    const p = session.players.get(c1.id);
    p.isInsideTruck = false;
    const stateBefore = session.ghost.state;
    await wait(400);
    assert.strictEqual(p.sanity, 100);
    assert.strictEqual(session.ghost.state, stateBefore);
    const upd = once(c2, 'phobia:settings-updated');
    c1.emit('phobia:leave-session', { roomId: lobbyRoom });
    const ev = await upd;
    assert.strictEqual(ev.hostSocketId, c2.id);
    assert.strictEqual(session.hostSocketId, c2.id);
  });

  it('crucifix hunt-cancelled and survived hunts complete objectives', async () => {
    const session = phobia.sessions.get(lobbyRoom);
    session.status = 'active';
    session.objectives = [
      { id: 'crucifix_block', textHu: 'x', done: false, rewardFt: 750 },
      { id: 'survive_hunt', textHu: 'y', done: false, rewardFt: 700 },
      { id: 'ghost_event', textHu: 'z', done: false, rewardFt: 400 }
    ];
    session.broadcast('phobia:hunt-cancelled', { reason: 'crucifix' });
    session.broadcast('phobia:hunt-started', {});
    session.broadcast('phobia:hunt-ended', {});
    session.broadcast('phobia:ghost-event', {});
    assert.deepStrictEqual(session.objectives.map((o) => o.done), [true, true, true]);
  });
});
