// Backend tests: smudge sticks, photo capture, hidden/safe-zone players vs the ghost AI.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { setupMiskolcPhobia } = require('../miskolcPhobiaHandler');
const { createGhostAI, updateGhostAI, GHOST_STATES } = require('../miskolcPhobiaAI');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (sock, ev, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    sock.once(ev, (d) => { clearTimeout(t); res(d); });
  });

describe('MiskolcPhobia handler: smudge, photos, hiding', () => {
  let server, io, phobia, url, c1, c2;
  const room = 'test_room_extras_' + Date.now();

  before(async () => {
    server = http.createServer();
    io = new Server(server, { cors: { origin: '*' } });
    phobia = setupMiskolcPhobia(io, new Map());
    await new Promise((r) => server.listen(0, r));
    url = `http://localhost:${server.address().port}`;
    c1 = ioClient(url, { transports: ['websocket'], reconnection: false });
    c2 = ioClient(url, { transports: ['websocket'], reconnection: false });
    await Promise.all([once(c1, 'connect'), once(c2, 'connect')]);
    c1.emit('phobia:init-session', { roomId: room, userId: 'ex_u1_' + Date.now(), username: 'Egy' });
    await once(c1, 'phobia:session-init');
    // Freeze the 12 Hz AI loop so ghost/player state set by the tests is not overwritten mid-test
    clearInterval(phobia.tickInterval);
  });

  after(async () => {
    c1.close(); c2.close();
    clearInterval(phobia.tickInterval);
    await new Promise((r) => io.close(r));
  });

  it('smudge sticks consume the item, blind the ghost and block hunts', async () => {
    const session = phobia.sessions.get(room);
    const player = [...session.players.values()][0];
    player.inventory[0] = { id: 'smudge_sticks_1', type: 'smudge_sticks', name: 'Füstölő' };
    const used = once(c1, 'phobia:smudge-used');
    const inv = once(c1, 'phobia:inventory-updated');
    c1.emit('phobia:use-smudge', { roomId: room, slot: 0 });
    const ev = await used;
    const invUpdate = await inv;
    assert.strictEqual(ev.duration, 5);
    assert.ok([60, 90].includes(ev.roamDelay));
    assert.strictEqual(invUpdate.inventory[0], null);
    assert.ok(session.ghost.huntBlockedBySmudgeUntil > Date.now() + 50000);
  });

  it('smudge without the item does nothing', async () => {
    let fired = false;
    c1.once('phobia:smudge-used', () => { fired = true; });
    c1.emit('phobia:use-smudge', { roomId: room, slot: 1 });
    await wait(300);
    assert.strictEqual(fired, false);
  });

  it('non-members cannot use smudge or submit photos', async () => {
    let fired = false;
    c2.on('phobia:smudge-used', () => { fired = true; });
    c2.on('phobia:photo-taken', () => { fired = true; });
    c2.emit('phobia:use-smudge', { roomId: room, slot: 0 });
    c2.emit('phobia:photo-captured', { roomId: room, photo: { subject: 'x' } });
    await wait(300);
    assert.strictEqual(fired, false);
  });

  it('photo-captured stores a bounty and echoes photo-taken; server decides the reward', async () => {
    const session = phobia.sessions.get(room);
    const player = [...session.players.values()][0];
    session.ghost.visible = false;
    const taken = once(c1, 'phobia:photo-taken');
    // client claims a 1000 Ft ghost photo while the ghost is invisible
    c1.emit('phobia:photo-captured', { roomId: room, photo: { subject: 'Szellem Fénykép', reward: 1000, rewardFt: 1000 } });
    const ev = await taken;
    assert.strictEqual(ev.ghostInFrame, false);
    assert.ok(ev.reward < 1000);
    assert.strictEqual(session.photoBounties.length, 1);
    assert.strictEqual(session.photoBounties[0].userId, player.userId);
  });

  it('a visible ghost in front of the camera yields a verified ghost photo and a side task', async () => {
    const session = phobia.sessions.get(room);
    const player = [...session.players.values()][0];
    player.position = [0, 0, 0];
    player.rotation = [0, 0]; // yaw 0 => looking toward -z
    session.ghost.x = 0; session.ghost.z = -6; session.ghost.visible = true;
    const taken = once(c1, 'phobia:photo-taken');
    c1.emit('phobia:photo-captured', { roomId: room, photo: { subject: 'Fotó' } });
    const ev = await taken;
    assert.strictEqual(ev.ghostInFrame, true);
    assert.strictEqual(ev.reward, 1000);
    assert.ok(session.sideTasks.find((t) => t.id === 'photo_ghost')?.completed);
  });

  it('explicit photo kind is honored only when server-side evidence supports it', async () => {
    const session = phobia.sessions.get(room);
    session.ghost.visible = false;
    const snap = (photo) => { const t = once(c1, 'phobia:photo-taken'); c1.emit('phobia:photo-captured', { roomId: room, photo }); return t; };
    session.ghost.evidence = ['fingerprints'];
    assert.strictEqual((await snap({ subject: 'Fotó', kind: 'fingerprint' })).kind, 'fingerprint');
    assert.strictEqual((await snap({ subject: 'Fotó', kind: 'orb' })).kind, 'generic'); // no orb evidence
    assert.strictEqual((await snap({ subject: 'ujjlenyomat', kind: 'other' })).kind, 'generic'); // explicit kind wins over text
    assert.strictEqual((await snap({ subject: 'Fotó', kind: 'bogus' })).kind, 'generic');
    assert.strictEqual((await snap({ subject: 'Ujjlenyomat' })).kind, 'fingerprint'); // legacy payload
    const ghost = await snap({ subject: 'x', kind: 'ghost' }); // ghost kind claimed, ghost not in frame
    assert.strictEqual(ghost.kind, 'generic');
    assert.strictEqual(ghost.ghostInFrame, false);
  });

  it('oversized photo payloads are rejected', async () => {
    const session = phobia.sessions.get(room);
    const before = session.photoBounties.length;
    c1.emit('phobia:photo-captured', { roomId: room, photo: { subject: 'x', dataUrl: 'A'.repeat(300 * 1024) } });
    await wait(300);
    assert.strictEqual(session.photoBounties.length, before);
  });

  it('hunting AI ignores hidden and in-truck players but kills an exposed one at its real position', () => {
    const mk = (id, pos, extra = {}) => ({ id, socketId: id, alive: true, sanity: 10, position: pos, ...extra });
    const events = [];
    const fakeIo = { to: () => ({ emit: (ev, d) => events.push([ev, d]) }) };

    function hunt(players) {
      const ghost = createGhostAI('lakatos_armando', { x: 20, y: 0, z: 20 });
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.huntTimer = 30;
      ghost.x = 20; ghost.z = 20;
      const session = { roomId: 'r', players: new Map(players.map((p) => [p.id, p])) };
      for (let i = 0; i < 600; i++) updateGhostAI(ghost, session, 83, fakeIo);
      return { ghost, session };
    }

    const hidden = mk('h', [20.2, 0, 20.2], { hidden: true });
    const safe = mk('s', [20.2, 0, 20.4], { isInsideTruck: true });
    const r1 = hunt([hidden, safe]);
    assert.strictEqual(hidden.alive, true, 'hidden player must survive');
    assert.strictEqual(safe.alive, true, 'player in truck must survive');

    const exposed = mk('e', [26, 0, 20]);
    const r2 = hunt([mk('h2', [26.1, 0, 20], { hidden: true }), exposed]);
    assert.strictEqual(exposed.alive, false, 'exposed player is killed at its real coordinates');
    const kill = events.find(([ev, d]) => ev === 'phobia:player-killed' && d.victimId === 'e');
    assert.ok(kill, 'player-killed carries the socket id');
    assert.ok(r1.ghost && r2.ghost);
  });
});
