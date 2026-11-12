import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { TestApp, waitFor } from '../support/TestApp.ts';
import { MODULE_ORDER, TS_ONLY_MODULES } from '../../../src/app/modules/ModuleFactory.ts';
import type { ModuleDeps, ModuleFactory } from '../../../src/app/modules/ModuleFactory.ts';
import legacyChat from './golden/fixtures/legacyChatOverride.ts';

const seen: { chat?: ModuleDeps; laterModuleError?: unknown; dbIsShared?: boolean } = {};

const chat: ModuleFactory<'chat'> = (deps) => {
  seen.chat = deps;
  try { deps.module('voice'); } catch (err) { seen.laterModuleError = err; }
  // database.js was already required by earlier modules: the handle is the very same connection.
  seen.dbIsShared = deps.database.connection === deps.loadLegacy<{ db: unknown }>('./database').db;
  return legacyChat(deps);
};
// A module without controller or providers (the legacy call handler is simply not mounted).
const call: ModuleFactory<'call'> = () => ({ api: { replaced: true } });
// A room-state provider from an override lands in its module's legacy slot (game is first).
const game: ModuleFactory<'game'> = (deps) => {
  const legacyGame = deps.loadLegacy<(io: unknown, o: unknown) => { getSession(id: string): unknown }>('./game/gameHandler');
  const adapter = deps.createLegacyAdapter();
  const api = legacyGame(adapter.io, { users: deps.usersMap });
  return { controller: adapter, api, roomStateProvider: { getRoomState: (id) => [{ event: 'game:override-state', payload: id }] } };
};

let t: TestApp;
before(async () => { t = await TestApp.start({ moduleOverrides: { chat, call, game } }); });
after(async () => { await t.stop(); });

test('overrides mount at the position of the module they replace; TS-only modules need an override', () => {
  const tsOnly: readonly string[] = TS_ONLY_MODULES;
  assert.deepEqual(t.app.mountedModules.map((m) => m.name), MODULE_ORDER.filter((name) => !tsOnly.includes(name)));
  const sources = Object.fromEntries(t.app.mountedModules.map((m) => [m.name, m.source]));
  assert.equal(sources['chat'], 'override');
  assert.equal(sources['call'], 'override');
  assert.equal(sources['game'], 'override');
  assert.equal(sources['casino'], 'legacy');
});

test('deps: earlier modules only, shared users and database', () => {
  const deps = seen.chat;
  assert.ok(deps);
  assert.equal(deps.name, 'chat');
  assert.equal(typeof deps.module('casino').getCasinoSessions, 'function');
  assert.match(String(seen.laterModuleError), /Module "voice" is not mounted yet/);
  assert.equal(seen.dbIsShared, true);
  assert.equal(deps.users, t.app.users);
  assert.equal(deps.presence, t.app.presence);
});

test('override providers keep the legacy slot; init:data still complete', async () => {
  const { client, init } = await t.joinAsGuest('Ovr');
  assert.deepEqual(Object.keys(init).slice(5), [
    'channelMessages', 'casinoSessions', 'watchSessions', 'chessSessions', 'browserSessions', 'empireSessions', 'phobiaSessions'
  ]);
  const order: string[] = [];
  client.onAny((event: string) => { order.push(event); });
  const done = waitFor(client, 'phobia:session-updated');
  client.emit('voice:join', { channelId: 'hang-chill' });
  await done;
  const afterJoin = order.slice(order.indexOf('voice:joined') + 1);
  assert.deepEqual(afterJoin.slice(0, 2), ['game:override-state', 'whiteboard:list']);
  client.close();
});
