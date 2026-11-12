import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PlayerInput } from '../../../src/modules/sweepers/payloads.ts';
import { spawnPose } from '../../../src/modules/sweepers/SweepersRoom.ts';
import { SweepersError } from '../../../src/modules/sweepers/SweepersError.ts';
import type { InitStatePayload, TickSyncPayload } from '../../../src/modules/sweepers/types.ts';
import { account, guest, makeService } from './support.ts';

const ROOM = 'hang-chill';
const input = (seq: number, x: number, z: number, extra: Partial<PlayerInput> = {}): PlayerInput =>
  ({ channelId: ROOM, seq, x, y: 0, z, rotY: 0, state: 'WALK', ...extra });
const lastInit = (log: unknown[][]): InitStatePayload => log.at(-1)?.[1] as InitStatePayload;
const ticks = (log: unknown[][]): TickSyncPayload[] => log.map((args) => args[1] as TickSyncPayload);

test('join sends init_state (37 hexes, personal stats), announces the player and starts the loop', () => {
  const { service, events, scheduler } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  const init = lastInit(events.of('initState'));
  assert.equal(events.of('initState')[0]?.[0], 's1');
  assert.equal(init.roomId, ROOM);
  assert.equal(init.selfId, 1);
  assert.equal(init.tickRate, 12);
  assert.equal(init.hexes.length, 37);
  assert.equal(init.hexes[0]?.cleanliness, 35);
  assert.equal(init.teamFunds, 0);
  assert.deepEqual(init.personal, { cash: 0, toolTier: 0, backpackTier: 0, totalKg: 0 });
  assert.deepEqual(init.players, [{ id: 1, accountId: null, username: 'Alice', avatarColor: '#123456', ...spawnPose(1) }]);
  assert.deepEqual(events.of('playerJoined'), [[ROOM, init.players[0], 's1']]);
  assert.deepEqual(events.of('sessionUpdated'), [[ROOM, { active: true, startedBy: 'Alice', playerCount: 1 }]]);
  assert.equal(scheduler.active, 1);
  assert.equal(scheduler.loops[0]?.intervalMs, 83);

  service.join(ROOM, 's2', account('acc-b', 'Bob'));
  assert.equal(lastInit(events.of('initState')).selfId, 2);
  assert.equal(lastInit(events.of('initState')).players.length, 2);
  assert.deepEqual(service.summaries(), { [ROOM]: { active: true, startedBy: 'Alice', playerCount: 2 } });
  assert.equal(scheduler.active, 1, 'one loop for the whole service');
});

test('tick_sync carries only changed players, acks of advanced seqs, and nothing when idle', () => {
  const { service, events, clock } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.join(ROOM, 's2', guest('Bob'));
  service.tick();
  assert.equal(events.of('tickSync').length, 0, 'nothing changed yet');
  clock.ms += 100;
  const start = spawnPose(1);
  service.input('s1', input(1, start.x + 0.5, start.z, { rotY: Math.PI, state: 'SPRINT' }));
  service.tick();
  const [first] = ticks(events.of('tickSync'));
  assert.ok(first);
  assert.equal(first.t, clock.ms);
  assert.deepEqual(first.acks, { 1: 1 });
  assert.deepEqual(first.gone, []);
  assert.equal(first.p.length, 1);
  assert.deepEqual(first.p[0], [1, Math.round((start.x + 0.5) * 100), 0, Math.round(start.z * 100), 32768, 2, 0]);
  service.tick();
  assert.equal(events.of('tickSync').length, 1, 'no tick when nothing changed');
  // A stale seq is ignored entirely.
  service.input('s1', input(1, start.x, start.z));
  service.tick();
  assert.equal(events.of('tickSync').length, 1);
});

test('a too fast move is corrected: authoritative pose with corr = 1', () => {
  const { service, events, clock } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  clock.ms += 50;
  const start = spawnPose(1);
  service.input('s1', input(1, start.x + 40, start.z));
  service.tick();
  const [sync] = ticks(events.of('tickSync'));
  assert.deepEqual(sync?.p[0]?.slice(0, 4), [1, Math.round(start.x * 100), 0, Math.round(start.z * 100)]);
  assert.equal(sync?.p[0]?.[6], 1);
  service.input('s1', input(2, start.x + 0.1, start.z));
  service.tick();
  assert.equal(ticks(events.of('tickSync'))[1]?.p[0]?.[6], 0, 'corr is sent once');
});

test('input from a socket outside the world is refused', () => {
  const { service } = makeService();
  assert.throws(() => service.input('nobody', input(1, 0, 0)), SweepersError);
  service.join(ROOM, 's1', guest('Alice'));
  assert.throws(() => service.input('s1', { ...input(1, 0, 0), channelId: 'hang-gaming-1' }), SweepersError);
});

test('reconnect within 120 s restores id, pose and stats; join twice re-sends init_state', () => {
  const { service, events, clock } = makeService();
  service.join(ROOM, 's1', account('acc-a', 'Alice'));
  service.join(ROOM, 's2', guest('Bob'));
  clock.ms += 200;
  const start = spawnPose(1);
  service.input('s1', input(1, start.x + 1, start.z + 1, { rotY: 1 }));
  service.tick();
  service.join(ROOM, 's1', account('acc-a', 'Alice'));
  assert.equal(events.of('initState').length, 3, 'same socket joining again gets init_state again');

  service.disconnect('s1');
  assert.deepEqual(events.of('sessionUpdated').at(-1), [ROOM, { active: true, startedBy: 'Alice', playerCount: 1 }]);
  clock.ms += 119_000;
  service.tick();
  assert.equal(events.of('playerLeft').length, 0, 'still in the grace window');
  events.clear();
  service.join(ROOM, 's9', account('acc-a', 'Alice (új)'));
  const init = lastInit(events.of('initState'));
  assert.equal(init.selfId, 1);
  const self = init.players.find((p) => p.id === 1);
  assert.ok(self);
  assert.ok(Math.abs(self.x - (start.x + 1)) < 1e-9 && Math.abs(self.z - (start.z + 1)) < 1e-9 && self.rotY === 1);
  assert.equal(self.username, 'Alice (új)');
  assert.equal(events.of('playerJoined').length, 0, 'the others never lost the player');
  // The restored socket's inputs restart at any seq.
  clock.ms += 100;
  service.input('s9', input(0, start.x + 1.2, start.z + 1));
  service.tick();
  assert.deepEqual(ticks(events.of('tickSync')).at(-1)?.acks, { 1: 0 });
});

test('after 120 s of grace the player is removed: player_left, gone, stats saved', () => {
  const { service, events, clock, store } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.join(ROOM, 's2', guest('Bob'));
  service.tick();
  service.disconnect('s1');
  clock.ms += 120_000;
  service.tick();
  assert.deepEqual(events.of('playerLeft'), [[ROOM, 1]]);
  assert.deepEqual(ticks(events.of('tickSync')).at(-1)?.gone, [1]);
  assert.deepEqual(store.loadPlayerStats('name:alice', ROOM), { cash: 0, toolTier: 0, backpackTier: 0, totalKg: 0 });
  events.clear();
  service.join(ROOM, 's3', guest('Alice'));
  assert.equal(lastInit(events.of('initState')).selfId, 3, 'a new short id after the window');
  assert.equal(events.of('playerJoined').length, 1);
});

test('leave removes at once; another world on the same socket leaves the first', () => {
  const { service, events } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.join(ROOM, 's2', guest('Bob'));
  assert.equal(service.leave('s2', 'hang-gaming-1'), null, 'not in that world');
  assert.equal(service.leave('s2', ROOM), ROOM);
  assert.deepEqual(events.of('playerLeft'), [[ROOM, 2]]);
  assert.equal(service.summaryOf(ROOM)?.playerCount, 1);
  assert.deepEqual(service.join('hang-gaming-1', 's1', guest('Alice')).leftChannelId, ROOM);
  assert.equal(service.summaryOf(ROOM), null);
  assert.equal(service.summaryOf('hang-gaming-1')?.playerCount, 1);
});

test('two guests with one name get separate players; one account in a second tab takes over and the old socket is kicked', () => {
  const { service, events } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.join(ROOM, 's2', guest('Alice'));
  assert.equal(service.room(ROOM)?.playerCount, 2);
  service.join(ROOM, 's3', account('acc', 'Carol'));
  const result = service.join(ROOM, 's4', account('acc', 'Carol'));
  assert.equal(result.displacedSocketId, 's3');
  assert.deepEqual(events.of('kicked'), [['s3', ROOM, { reason: 'displaced' }]]);
  assert.equal(service.room(ROOM)?.playerCount, 3);
  assert.throws(() => service.input('s3', input(1, 0, 0)), SweepersError);
  // The kicked socket's later disconnect does not touch the player it lost.
  service.disconnect('s3');
  assert.equal(service.summaryOf(ROOM)?.playerCount, 3);
});

test('no ghost (a): a new identity on the same socket replaces its old player (player_left + gone)', () => {
  const { service, events } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.join(ROOM, 's2', guest('Bob'));
  service.tick();
  service.join(ROOM, 's1', guest('Alicia'));
  assert.deepEqual(events.of('playerLeft'), [[ROOM, 1]]);
  assert.equal(service.room(ROOM)?.playerCount, 2);
  assert.deepEqual(service.room(ROOM)?.playerSnapshots().map((p) => p.username), ['Bob', 'Alicia']);
  assert.equal(lastInit(events.of('initState')).selfId, 3);
  service.tick();
  assert.deepEqual(ticks(events.of('tickSync')).at(-1)?.gone, [1]);
  assert.equal(service.summaryOf(ROOM)?.playerCount, 2);
  // Nothing is left to expire later.
  service.disconnect('s1');
  service.disconnect('s2');
  assert.equal(service.room(ROOM)?.playerCount, 2);
});

test('no ghost (b): a duplicate guest name taking over the disconnected record drops its own record', () => {
  const { service, events } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.join(ROOM, 's2', guest('Alice'));
  assert.equal(service.room(ROOM)?.playerCount, 2);
  service.disconnect('s1');
  service.join(ROOM, 's2', guest('Alice'));
  assert.equal(lastInit(events.of('initState')).selfId, 1, 's2 now plays the name\'s original record');
  assert.deepEqual(events.of('playerLeft'), [[ROOM, 2]]);
  assert.equal(service.room(ROOM)?.playerCount, 1);
  assert.equal(service.summaryOf(ROOM)?.playerCount, 1);
});

test('after dispose: joins are refused and the loop is never scheduled again', () => {
  const { service, scheduler } = makeService();
  service.dispose();
  assert.throws(() => service.join(ROOM, 's1', guest('Alice')), SweepersError);
  assert.equal(scheduler.loops.length, 0);
  assert.equal(service.running, false);
});

test('periodic save every 60 s; empty world saved and unloaded after 120 s; loop stops with the last world', () => {
  const { service, events, clock, store, scheduler } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  clock.ms += 59_000;
  service.tick();
  assert.equal(store.saves, 0);
  clock.ms += 1000;
  service.tick();
  assert.equal(store.saves, 1);
  assert.equal(store.rooms.get(ROOM)?.lastSaved, clock.ms);
  service.disconnect('s1');
  assert.deepEqual(events.of('sessionUpdated').at(-1), [ROOM, null]);
  clock.ms += 119_999;
  service.tick();
  assert.ok(service.room(ROOM));
  clock.ms += 1;
  service.tick();
  assert.equal(service.room(ROOM), undefined);
  assert.equal(scheduler.active, 0);
  assert.ok(store.saves >= 2);
  assert.deepEqual(service.summaries(), {});
});

test('a loaded world restores cleanliness, team funds and personal stats', () => {
  const { service, events, store } = makeService();
  const cleanliness: Record<string, number> = {};
  for (let id = 0; id < 37; id++) cleanliness[String(id)] = id;
  cleanliness['36'] = 250;
  store.rooms.set(ROOM, { roomId: ROOM, state: { v: 1 }, cleanliness, teamFunds: 4200, lastSaved: 1 });
  store.savePlayerStats({ userId: 'acc:acc-a', roomId: ROOM, stats: { cash: 77, toolTier: 2, backpackTier: 1, totalKg: 12.5 } });
  service.join(ROOM, 's1', account('acc-a', 'Alice'));
  const init = lastInit(events.of('initState'));
  assert.equal(init.teamFunds, 4200);
  assert.deepEqual(init.hexes.slice(0, 3).map((h) => h.cleanliness), [0, 1, 2]);
  assert.equal(init.hexes[36]?.cleanliness, 100, 'clamped');
  assert.deepEqual(init.personal, { cash: 77, toolTier: 2, backpackTier: 1, totalKg: 12.5 });
});

test('dispose saves every world and stops the loop', () => {
  const { service, store, scheduler } = makeService();
  service.join(ROOM, 's1', guest('Alice'));
  service.dispose();
  assert.equal(store.saves, 1);
  assert.equal(scheduler.active, 0);
  assert.equal(service.running, false);
});

test('a failing store is logged, the game keeps running', () => {
  const { service, events } = makeService({
    store: {
      loadRoom: () => { throw new Error('disk'); },
      loadPlayerStats: () => { throw new Error('disk'); },
      saveRoom: () => { throw new Error('disk'); },
      savePlayerStats: () => { throw new Error('disk'); }
    }
  });
  service.join(ROOM, 's1', guest('Alice'));
  assert.equal(lastInit(events.of('initState')).hexes.length, 37);
  service.dispose();
  assert.equal(service.leave('s1'), ROOM);
});
