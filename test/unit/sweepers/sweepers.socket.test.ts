// End to end through the real Application (127.0.0.1:<ephemeral>, isolated DB): two
// socket.io clients join a world, see each other move, and one reconnects within the grace window.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Socket as ClientSocket } from 'socket.io-client';
import { TestApp, waitFor } from '../support/TestApp.ts';
import type { InitStatePayload, PlayerSnapshot, SweepersSessionUpdate, TickSyncPayload } from '../../../src/modules/sweepers/types.ts';

const ROOM = 'hang-chill';

let t: TestApp;
before(async () => { t = await TestApp.start(); });
after(async () => { await t.stop(); });

const ack = (client: ClientSocket, event: string, payload: unknown): Promise<Record<string, unknown>> =>
  client.timeout(2000).emitWithAck(event, payload) as Promise<Record<string, unknown>>;

async function joinWorld(client: ClientSocket): Promise<InitStatePayload> {
  const init = waitFor<InitStatePayload>(client, 'miskolc:init_state');
  assert.deepEqual(await ack(client, 'miskolc:join_room', { channelId: ROOM }), { ok: true });
  return init;
}

test('refusals: not logged in, unknown channel, malformed payloads, input outside the world', async () => {
  const anonymous = await t.connectClient();
  assert.equal((await ack(anonymous, 'miskolc:join_room', { channelId: ROOM }))['code'], 'SWEEPERS_REFUSED');
  const { client } = await t.joinAsGuest('SwRefused');
  const unknown = await ack(client, 'miskolc:join_room', { channelId: 'nincs-ilyen' });
  assert.deepEqual(unknown, { ok: false, error: 'Ismeretlen hangszoba.', code: 'SWEEPERS_REFUSED' });
  assert.equal((await ack(client, 'miskolc:join_room', null))['code'], 'VALIDATION_ERROR');
  const input = { channelId: ROOM, seq: 1, x: 0, y: 0, z: 0, rotY: 0, state: 'WALK' };
  assert.equal((await ack(client, 'miskolc:player_input', input))['code'], 'SWEEPERS_REFUSED');
  assert.equal((await ack(client, 'miskolc:player_input', { ...input, x: 'a' }))['code'], 'VALIDATION_ERROR');
  assert.equal((await ack(client, 'miskolc:player_input', { ...input, state: 'FLYING' }))['code'], 'VALIDATION_ERROR');
  anonymous.close();
  client.close();
});

test('join → init_state → input → tick_sync at the other client → disconnect / rejoin restores the pose', async () => {
  const alice = await t.joinAsGuest('SwAlice');
  const bob = await t.joinAsGuest('SwBob');
  // Alice is in the voice channel: she receives the session updates of its world.
  const aliceVoice = waitFor<SweepersSessionUpdate>(alice.client, 'miskolc:session-updated');
  alice.client.emit('voice:join', { channelId: ROOM });
  assert.deepEqual(await aliceVoice, { channelId: ROOM, state: null });

  const started = waitFor<SweepersSessionUpdate>(alice.client, 'miskolc:session-updated', (u) => u.state !== null);
  const aliceInit = await joinWorld(alice.client);
  assert.deepEqual((await started).state, { active: true, startedBy: 'SwAlice', playerCount: 1 });
  assert.equal(aliceInit.roomId, ROOM);
  assert.equal(aliceInit.tickRate, 12);
  assert.equal(aliceInit.hexes.length, 37);
  assert.equal(aliceInit.players.length, 1);
  const self = aliceInit.players[0];
  assert.ok(self && self.id === aliceInit.selfId && self.username === 'SwAlice' && self.accountId === null);

  const joined = waitFor<PlayerSnapshot>(alice.client, 'miskolc:player_joined');
  const bobInit = await joinWorld(bob.client);
  assert.equal((await joined).id, bobInit.selfId);
  assert.deepEqual(bobInit.players.map((p) => p.username).sort(), ['SwAlice', 'SwBob']);

  const observer = await t.joinAsGuest('SwObserver');
  assert.deepEqual((observer.init['sweepersSessions'] as Record<string, unknown>)[ROOM], { active: true, startedBy: 'SwAlice', playerCount: 2 });
  observer.client.close();

  const target = { x: self.x + 0.5, z: self.z - 0.25 };
  const seen = waitFor<TickSyncPayload>(bob.client, 'miskolc:tick_sync', (s) => s.p.some(([id]) => id === self.id));
  const acked = waitFor<TickSyncPayload>(alice.client, 'miskolc:tick_sync', (s) => s.acks[String(self.id)] === 3);
  alice.client.emit('miskolc:player_input', { channelId: ROOM, seq: 3, x: target.x, y: 0, z: target.z, rotY: Math.PI, state: 'WALK' });
  const row = (await seen).p.find(([id]) => id === self.id);
  assert.deepEqual(row, [self.id, Math.round(target.x * 100), 0, Math.round(target.z * 100), 32768, 1, 0]);
  await acked;

  // Alice drops; within the grace window she comes back on a new socket under the same name.
  const dropped = waitFor<SweepersSessionUpdate>(bob.client, 'miskolc:session-updated', (u) => u.state?.playerCount === 1);
  alice.client.close();
  await dropped;
  const back = await t.joinAsGuest('SwAlice');
  const leftEvents: unknown[] = [];
  bob.client.on('miskolc:player_left', (p: unknown) => leftEvents.push(p));
  const rejoined = await joinWorld(back.client);
  assert.equal(rejoined.selfId, self.id, 'same short id');
  const restored = rejoined.players.find((p) => p.id === self.id);
  assert.ok(restored);
  assert.ok(Math.abs(restored.x - target.x) < 1e-9 && Math.abs(restored.z - target.z) < 1e-9);
  assert.ok(Math.abs(restored.rotY - Math.PI) < 1e-9);
  assert.equal(restored.state, 'WALK');

  // Explicit leave: bob sees player_left at once.
  const left = waitFor<{ id: number }>(bob.client, 'miskolc:player_left');
  assert.deepEqual(await ack(back.client, 'miskolc:leave_room', { channelId: ROOM }), { ok: true });
  assert.deepEqual(await left, { id: self.id });
  assert.equal(leftEvents.length, 1);
  back.client.close();
  bob.client.close();
});

test('an unauthenticated user:join claiming an accountId cannot take over that player', async () => {
  const join = async (username: string): Promise<ClientSocket> => {
    const client = await t.connectClient();
    const init = waitFor(client, 'init:data');
    client.emit('user:join', { username, accountId: 'acc-claimed' });
    await init;
    return client;
  };
  const owner = await join('SwOwner');
  const ownerInit = await joinWorld(owner);
  const kicked: unknown[] = [];
  owner.on('miskolc:kicked', (p: unknown) => kicked.push(p));
  const impostor = await join('SwImpostor');
  const impostorInit = await joinWorld(impostor);
  assert.notEqual(impostorInit.selfId, ownerInit.selfId, 'a separate player');
  const mine = impostorInit.players.filter((p) => p.username === 'SwOwner' || p.username === 'SwImpostor');
  assert.deepEqual(mine.map((p) => p.accountId), [null, null], 'unverified accountIds are not exposed');
  // A burst of acked inputs: at most the bucket (10) is processed and acked, the rest are dropped silently.
  const acks = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => impostor.timeout(800).emitWithAck('miskolc:player_input',
    { channelId: ROOM, seq: i + 1, x: 0, y: 0, z: 0, rotY: 0, state: 'IDLE' })));
  const answered = acks.filter((a) => a.status === 'fulfilled').length;
  assert.ok(answered >= 10 && answered <= 11, `answered ${answered}`);
  assert.deepEqual(kicked, []);
  owner.close();
  impostor.close();
});
