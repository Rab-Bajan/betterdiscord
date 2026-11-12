import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { TestApp, waitFor } from '../support/TestApp.ts';
import { LEGACY_MODULE_ORDER } from '../../../src/app/index.ts';
import { MIGRATED_MODULES } from '../../../src/modules/migratedModules.ts';

// Exactly what legacy authHandler.js + server.js put into init:data, in order.
const INIT_DATA_KEYS = [
  'self', 'textChannels', 'voiceChannels', 'voiceStates', 'onlineUsers',
  'channelMessages', 'casinoSessions', 'watchSessions', 'chessSessions',
  'browserSessions', 'empireSessions', 'phobiaSessions'
];

// Legacy server.js voiceHandler room-join callback order.
const ROOM_STATE_EVENTS = [
  'game:session-updated', 'whiteboard:list', 'code:tree-data', 'watch:state',
  'browser:state', 'empire:session-updated', 'phobia:session-updated'
];

let t: TestApp;
before(async () => { t = await TestApp.start(); });
after(async () => { await t.stop(); });

test('boots with the startup line and one controller per module, in server.js order', () => {
  assert.ok(t.logs.some((r) => r.message === `>>> Discord VoIP & Chat Backend (HTTPS) fut: https://localhost:${t.port}`));
  assert.equal(t.app.io.sockets.listenerCount('connection'), 1);
  assert.deepEqual(t.app.mountedModules.map((m) => m.name), [...LEGACY_MODULE_ORDER]);
  // Migrated modules are the default; only the rest still runs its legacy handler.
  const migrated = new Set(Object.keys(MIGRATED_MODULES));
  for (const { name, source } of t.app.mountedModules) assert.equal(source, migrated.has(name) ? 'override' : 'legacy', name);
  assert.deepEqual([...LEGACY_MODULE_ORDER], [
    'casino', 'watchParty', 'chess', 'codeEditor', 'dm', 'browser', 'call', 'chat', 'whiteboard',
    'game', 'empire', 'phobia', 'speedTest', 'voice', 'auth', 'admin'
  ]);
});

test('init:data carries every legacy key in legacy order', async () => {
  const { client, init } = await t.joinAsGuest('Alice');
  assert.deepEqual(Object.keys(init), INIT_DATA_KEYS);
  assert.equal((init['self'] as { username: string }).username, 'Alice');
  assert.equal((init['self'] as { id: string }).id, client.id);
  const messages = init['channelMessages'] as Record<string, Array<{ id: string }>>;
  assert.equal(messages['altalanos']?.[0]?.id, 'welcome-1');
  for (const key of ['casinoSessions', 'watchSessions', 'chessSessions', 'browserSessions', 'empireSessions', 'phobiaSessions']) {
    assert.deepEqual(init[key], {}, key);
  }
  client.close();
});

test('chat:message round-trips to a second client', async () => {
  const a = await t.joinAsGuest('ChatA');
  const b = await t.joinAsGuest('ChatB');
  const received = waitFor<{ text: string; username: string; channelId: string }>(b.client, 'chat:new-message');
  a.client.emit('chat:message', { channelId: 'altalanos', text: '  hello  ' });
  const msg = await received;
  assert.equal(msg.text, 'hello');
  assert.equal(msg.username, 'ChatA');
  assert.equal(msg.channelId, 'altalanos');
  a.client.close();
  b.client.close();
});

test('voice:join emits the 7 room-state events in legacy order', async () => {
  const { client } = await t.joinAsGuest('Voicey');
  const seen: string[] = [];
  client.onAny((event: string) => { if (ROOM_STATE_EVENTS.includes(event)) seen.push(event); });
  const joined = waitFor<{ channelId: string }>(client, 'voice:joined');
  const last = waitFor<{ channelId: string; state: unknown }>(client, 'phobia:session-updated');
  client.emit('voice:join', { channelId: 'hang-chill' });
  assert.equal((await joined).channelId, 'hang-chill');
  assert.deepEqual(await last, { channelId: 'hang-chill', state: null });
  assert.deepEqual(seen, ROOM_STATE_EVENTS);
  assert.equal(t.app.presence.getVoiceChannelState()['hang-chill']?.[0]?.username, 'Voicey');
  client.close();
});

test('disconnect removes the user from presence', async () => {
  const { client } = await t.joinAsGuest('Leaver');
  const id = client.id;
  assert.ok(id && t.app.users.has(id));
  assert.ok(t.app.presence.getOnlineUsersList().some((u) => u.username === 'Leaver'));
  const observer = await t.joinAsGuest('Observer');
  const update = waitFor<Array<{ username: string }>>(observer.client, 'users:updated', (list) => !list.some((u) => u.username === 'Leaver'));
  client.close();
  assert.ok((await update).some((u) => u.username === 'Observer'));
  assert.equal(t.app.users.has(id), false);
  observer.client.close();
});

test('HTTP: /api/status from httpRoutes.js responds with live data', async () => {
  const res = await t.get('/api/status');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { status: string; protocol: string; textChannels: unknown[] };
  assert.equal(body.status, 'online');
  assert.equal(body.protocol, 'https');
  assert.equal(body.textChannels.length, 4);
});

test('HTTP: an analysis route (mounted before serveFrontend) is reachable', async () => {
  const res = await t.get('/api/analysis/config');
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { ok: boolean; defaults: { engine: string } };
  assert.equal(body.ok, true);
  assert.equal(body.defaults.engine, 'full');
});

test('HTTP: the casino module serves its page (express.static redirects /casino to /casino/, as in legacy)', async () => {
  assert.equal((await t.get('/casino')).status, 301);
  const res = await t.get('/casino/');
  assert.equal(res.status, 200);
  assert.match(res.body, /<html/i);
});

test('HTTP: CORS header from the global middleware', async () => {
  const res = await new Promise<string | undefined>((resolve, reject) => {
    import('node:https').then(({ get }) => {
      get(`${t.url}/api/status`, { rejectUnauthorized: false, headers: { Origin: 'https://example.test' } }, (r) => {
        r.resume();
        resolve(r.headers['access-control-allow-origin'] as string | undefined);
      }).on('error', reject);
    }, reject);
  });
  assert.equal(res, '*');
});
