// Child-process script: boots either the legacy wiring replica (test/support/legacyBootstrap.cjs)
// or the new Application, plays one scripted two-client session, and prints the normalised
// per-client event transcript as a single `GOLDEN:<json>` line on stdout.
// Usage: node --import ./test/support/isolatedDb.cjs runGoldenSession.ts legacy|app
// In `app` mode, GOLDEN_OVERRIDES=name:/abs/factory.ts[,name:/abs/factory.ts...] mounts exactly these
// module overrides (each file's default export is a ModuleFactory, see worker-1-notes "Module factory
// contract"); an empty value mounts only legacy modules, and leaving it unset mounts the default set.
import { createRequire } from 'node:module';
import { io as connect } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';
import { Application } from '../../../../src/app/Application.ts';
import { AppConfig } from '../../../../src/config/AppConfig.ts';
import { Logger } from '../../../../src/core/logging/Logger.ts';
import { installProcessGuards } from '../../../../src/app/processGuards.ts';
import { createTestCerts, waitFor } from '../../support/TestApp.ts';
import { MODULE_ORDER } from '../../../../src/app/modules/ModuleFactory.ts';
import type { ModuleName, ModuleOverrides } from '../../../../src/app/modules/ModuleFactory.ts';

type Transcript = Array<[string, unknown]>;
interface Booted { port: number; close: () => Promise<void> }
type BootLegacy = (options: { certDir: string; port: number; host: string }) => Promise<Booted>;

const SETTLE_MS = 150;
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

async function boot(mode: string, certDir: string): Promise<Booted> {
  if (mode === 'legacy') {
    const { bootLegacy } = createRequire(import.meta.url)('../../../support/legacyBootstrap.cjs') as { bootLegacy: BootLegacy };
    return bootLegacy({ certDir, port: 0, host: '127.0.0.1' });
  }
  const logger = new Logger({ minLevel: 'warn' });
  // Same guards as main.ts (and legacy server.js): a handler throwing on a sloppy payload must not end the run.
  installProcessGuards(logger.child('FATAL-GUARD'));
  const config = new AppConfig({ ...AppConfig.fromEnv(), port: 0, certsDir: certDir });
  const spec = process.env['GOLDEN_OVERRIDES'];
  // Unset: the default module set (MIGRATED_MODULES). Set: exactly the listed overrides ('' = legacy only).
  const moduleOverrides = spec === undefined ? undefined : await loadOverrides(spec);
  const app = new Application({ config, host: '127.0.0.1', logger, moduleOverrides });
  const { port } = await app.start();
  return { port, close: () => app.stop() };
}

const isModuleName = (name: string): name is ModuleName => (MODULE_ORDER as readonly string[]).includes(name);

/** Parses GOLDEN_OVERRIDES and imports each factory module's default export. */
async function loadOverrides(spec: string): Promise<ModuleOverrides> {
  const overrides: Record<string, unknown> = {};
  for (const entry of spec.split(',').filter(Boolean)) {
    const sep = entry.indexOf(':');
    const name = entry.slice(0, sep);
    if (sep < 1 || !isModuleName(name)) throw new Error(`GOLDEN_OVERRIDES: bad entry "${entry}"`);
    const mod = (await import(entry.slice(sep + 1))) as { default?: unknown };
    if (typeof mod.default !== 'function') throw new Error(`GOLDEN_OVERRIDES: ${entry} has no default-exported factory`);
    overrides[name] = mod.default;
  }
  // Each default export is a ModuleFactory for the name it is listed under (checked to be a function above).
  return overrides as ModuleOverrides;
}

async function client(port: number, transcript: Transcript): Promise<ClientSocket> {
  const socket = connect(`https://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true, rejectUnauthorized: false, reconnection: false });
  socket.onAny((event: string, payload: unknown) => { transcript.push([event, payload]); });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return socket;
}

/** Emits with an ack, records the response as `ack:<event>` and returns it. */
async function ack(socket: ClientSocket, transcript: Transcript, event: string, ...args: unknown[]): Promise<unknown> {
  const response: unknown = await socket.timeout(2000).emitWithAck(event, ...args).catch((err: unknown) => {
    throw new Error(`no ack for "${event}" ${JSON.stringify(args)}: ${String(err)}`);
  });
  transcript.push([`ack:${event}`, response]);
  return response;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Accounts (auth module), direct messages (dm) and moderation (admin). Carol registers as the
 * default admin name `bajan`; Alice DMs Bob, Bob reports it, Carol moderates the report.
 */
async function playAccountsDmAdmin(port: number, alice: ClientSocket, a: Transcript, bob: ClientSocket, b: Transcript, c: Transcript): Promise<ClientSocket> {
  const carol = await client(port, c);
  const shortPassword = waitFor(carol, 'auth:error');
  carol.emit('auth:register', { username: 'x', password: '1' });
  await shortPassword; await settle();
  const registered = waitFor<{ token: string }>(carol, 'auth:success');
  carol.emit('auth:register', { username: 'Bajan', password: 'titok', avatarColor: '#222222' });
  const { token } = await registered; await settle();
  const taken = waitFor(carol, 'auth:error');
  carol.emit('auth:register', { username: 'bajan', password: 'titok' });
  await taken; await settle();
  const wrongPassword = waitFor(carol, 'auth:error');
  carol.emit('auth:login', { username: 'Bajan', password: 'rossz' });
  await wrongPassword; await settle();
  carol.emit('auth:login', { username: 'senki', password: 'abcd' });
  carol.emit('auth:login', { username: '', password: '' });
  carol.emit('auth:login', null);
  await settle();
  const loggedIn = waitFor(carol, 'auth:success');
  carol.emit('auth:login', { username: 'bajan', password: 'titok' });
  await loggedIn; await settle();
  const invalid = waitFor(carol, 'auth:token-invalid');
  carol.emit('auth:verify-token', { token: 'nem-letezik' });
  await invalid; await settle();
  carol.emit('auth:verify-token', {});
  await settle();
  const verified = waitFor(carol, 'auth:success');
  carol.emit('auth:verify-token', { token });
  await verified; await settle();
  const profile = waitFor(carol, 'user:profile-updated');
  carol.emit('user:update-profile', { username: 'Bajan', avatarColor: '#333333' });
  await profile; await settle();
  const guestProfile = waitFor(alice, 'user:profile-updated');
  alice.emit('user:update-profile', { username: 'Alice', avatarColor: '#111111' });
  await guestProfile; await settle();
  // Alice's guest update created an "Alice" account, so renaming Carol to it conflicts.
  const nameTaken = waitFor(carol, 'profile:error');
  carol.emit('user:update-profile', { username: 'alice' });
  await nameTaken; await settle();

  // Direct messages: online delivery, offline recipient, conversation list, history.
  const delivered = waitFor<{ id: string }>(bob, 'dm:new-message');
  alice.emit('dm:send-message', { targetUsername: 'Bob', text: '  hello bob  ' });
  const dm = await delivered; await settle();
  const offline = waitFor(alice, 'dm:new-message');
  alice.emit('dm:send-message', { targetUsername: 'Senki', text: 'offline' });
  await offline; await settle();
  alice.emit('dm:send-message', { targetUsername: 'Bob', text: '   ' });
  alice.emit('dm:send-message', null);
  alice.emit('dm:get-history', {});
  await settle();
  const conversations = waitFor(bob, 'dm:conversations');
  bob.emit('dm:get-conversations');
  await conversations; await settle();
  const history = waitFor(bob, 'dm:history');
  bob.emit('dm:get-history', { targetUserId: alice.id });
  await history; await settle();
  await ack(bob, b, 'dm:report-message', { messageId: dm.id, reason: '  spam  ' });
  await ack(bob, b, 'dm:report-message', { messageId: dm.id, reason: 'again' });
  await ack(alice, a, 'dm:report-message', { messageId: dm.id });
  await ack(alice, a, 'dm:report-message', { messageId: 'nincs' });

  // Moderation: only the admin session may act; every reply is acked.
  await ack(alice, a, 'admin:dm-reports', {});
  const reports = await ack(carol, c, 'admin:dm-reports', {});
  const list = field(reports, 'reports');
  const reportId = Array.isArray(list) ? field(list[0], 'id') : undefined;
  await ack(carol, c, 'admin:dm-report-context', { reportId });
  await ack(carol, c, 'admin:dm-report-context', { reportId: 'nincs' });
  await ack(carol, c, 'admin:dm-remove-message', { reportId, messageId: 'nincs' });
  const removed = waitFor(bob, 'dm:message-removed');
  await ack(carol, c, 'admin:dm-remove-message', { reportId, messageId: dm.id });
  await removed; await settle();
  await ack(bob, b, 'dm:report-message', { messageId: dm.id });
  await ack(carol, c, 'admin:dm-resolve', { reportId, resolution: 'rendezve' });
  await ack(carol, c, 'admin:dm-resolve', { reportId });
  await ack(carol, c, 'admin:dm-remove-message', { reportId, messageId: dm.id });
  await ack(carol, c, 'admin:casino-set-balance', { playerId: 'nincs', balance: 100, freeSpins: 2 });
  await ack(carol, c, 'admin:casino-set-rig', { playerId: 'nincs', rig: 'jackpot' });
  await ack(carol, c, 'admin:chess-set-turn', { channelId: 'hang-chill', turn: 'b' });
  await ack(carol, c, 'admin:chess-put', { channelId: 'hang-chill', square: 'e4' });
  await ack(carol, c, 'admin:chess-force-move', { channelId: 'hang-chill', from: 'e2', to: 'e4' });
  await ack(carol, c, 'admin:casino-list', null);

  const loggedOut = waitFor(alice, 'users:updated');
  carol.emit('auth:logout', { token });
  await loggedOut; await settle();
  await ack(carol, c, 'admin:dm-reports', {});
  return carol;
}

/** Shared whiteboards in hang-chill, where Alice and Bob both are. */
async function playWhiteboard(alice: ClientSocket, bob: ClientSocket): Promise<void> {
  const room = 'hang-chill';
  const created = waitFor<{ board: { id: string } }>(bob, 'whiteboard:created');
  alice.emit('whiteboard:create', { channelId: room, title: '  Terv  ' });
  const boardId = (await created).board.id; await settle();
  const second = waitFor<{ board: { id: string } }>(alice, 'whiteboard:created');
  bob.emit('whiteboard:create', { channelId: room });
  const secondId = (await second).board.id; await settle();
  alice.emit('whiteboard:create', { channelId: 'hang-gaming-1', title: 'not a member' });
  alice.emit('whiteboard:create', null);
  await settle();
  const stroke = waitFor(bob, 'whiteboard:stroke');
  alice.emit('whiteboard:draw', { channelId: room, boardId, stroke: { points: [1, 2, 3], color: '#f00' } });
  await stroke; await settle();
  alice.emit('whiteboard:draw', { channelId: room, boardId: 'nincs', stroke: {} });
  alice.emit('whiteboard:draw', { channelId: 'gaming', boardId, stroke: {} });
  await settle();
  const data = waitFor(bob, 'whiteboard:data');
  bob.emit('whiteboard:get', { channelId: room, boardId });
  await data; await settle();
  bob.emit('whiteboard:get', { channelId: room, boardId: 'nincs' });
  bob.emit('whiteboard:get');
  await settle();
  const cleared = waitFor(alice, 'whiteboard:cleared');
  bob.emit('whiteboard:clear', { channelId: room, boardId });
  await cleared; await settle();
  const deleted = waitFor(alice, 'whiteboard:deleted');
  bob.emit('whiteboard:delete', { channelId: room, boardId: secondId });
  await deleted; await settle();
  alice.emit('whiteboard:draw', { channelId: room, boardId, stroke: { points: [4] } });
  await settle();
}

/**
 * Watch party in hang-chill. While a video plays its live position depends on wall time, so
 * those positions are normalised; paused positions and explicit seeks are compared exactly.
 */
async function playWatchParty(alice: ClientSocket, bob: ClientSocket): Promise<void> {
  const room = 'hang-chill';
  const started = waitFor(bob, 'watch:state');
  alice.emit('watch:update-media', { channelId: room, url: 'https://youtu.be/dQw4w9WgXcQ', videoId: 'dQw4w9WgXcQ', title: 'Klip' });
  await started; await settle();
  alice.emit('watch:update-media', { channelId: room, videoId: 'rossz' });
  alice.emit('watch:update-media', { channelId: 'hang-gaming-1', videoId: 'dQw4w9WgXcQ' });
  alice.emit('watch:update-media', null);
  await settle();
  const paused = waitFor(alice, 'watch:sync-event');
  bob.emit('watch:playback-control', { channelId: room, action: 'pause', currentTime: 42.5 });
  await paused; await settle();
  const resumed = waitFor(bob, 'watch:sync-event');
  alice.emit('watch:playback-control', { channelId: room, action: 'play', currentTime: -1 });
  await resumed; await settle();
  const seek = waitFor(alice, 'watch:sync-event');
  bob.emit('watch:playback-control', { channelId: room, action: 'seek', currentTime: 10 });
  await seek; await settle();
  bob.emit('watch:playback-control', { channelId: 'gaming', action: 'pause', currentTime: 1 });
  await settle();
  const state = waitFor(bob, 'watch:state');
  bob.emit('watch:get-state', { channelId: room });
  await state; await settle();
  const none = waitFor(bob, 'watch:state');
  bob.emit('watch:get-state', { channelId: 'nincs' });
  await none; await settle();
  bob.emit('watch:get-state', {});
  const countdown = waitFor(bob, 'watch:countdown-start');
  alice.emit('watch:countdown', { channelId: room });
  await countdown; await settle();
  const reaction = waitFor(alice, 'watch:reaction-received');
  bob.emit('watch:reaction', { channelId: room, emoji: '🎉🎉🎉🎉🎉' });
  await reaction; await settle();
  const fallback = waitFor(alice, 'watch:reaction-received');
  bob.emit('watch:reaction', { channelId: room });
  await fallback; await settle();
  const stopped = waitFor(bob, 'watch:state');
  alice.emit('watch:stop', { channelId: room });
  await stopped; await settle();
  const next = waitFor(alice, 'watch:state');
  bob.emit('watch:update-media', { channelId: room, videoId: 'abcdefghijk' });
  await next; await settle();
  const pausedAgain = waitFor(alice, 'watch:sync-event');
  bob.emit('watch:playback-control', { channelId: room, action: 'pause', currentTime: 3 });
  await pausedAgain; await settle();
}

interface TreeNode { id: string; name: string; type: string; children?: TreeNode[] }
const nodeNamed = (tree: TreeNode, name: string): TreeNode | undefined =>
  tree.name === name ? tree : (tree.children ?? []).map((c) => nodeNamed(c, name)).find(Boolean);

/** Shared code editor project of hang-chill. */
async function playCodeEditor(alice: ClientSocket, bob: ClientSocket): Promise<void> {
  const room = 'hang-chill';
  const tree = waitFor(alice, 'code:tree-data');
  alice.emit('code:get-tree', { channelId: room });
  await tree; await settle();
  alice.emit('code:get-tree', { channelId: 'hang-gaming-1' });
  alice.emit('code:get-tree', null);
  await settle();
  const folderTree = waitFor<TreeNode>(bob, 'code:tree-data');
  alice.emit('code:create-node', { channelId: room, name: ' lib/utils ', type: 'folder' });
  const folder = nodeNamed(await folderTree, 'libutils'); await settle();
  const fileTree = waitFor<TreeNode>(alice, 'code:tree-data');
  bob.emit('code:create-node', { channelId: room, parentId: folder?.id, type: 'file' });
  const file = nodeNamed(await fileTree, 'uj_file.js'); await settle();
  bob.emit('code:create-node', { channelId: room, parentId: 'file-readme', name: 'x', type: 'file' });
  bob.emit('code:create-node', { channelId: room, name: 'x', type: 'link' });
  await settle();
  const renamed = waitFor(alice, 'code:tree-data');
  bob.emit('code:rename-node', { channelId: room, nodeId: file?.id, newName: ' main.ts ' });
  await renamed; await settle();
  bob.emit('code:rename-node', { channelId: room, nodeId: 'root', newName: 'x' });
  bob.emit('code:rename-node', { channelId: room, nodeId: 'file-readme', newName: '///' });
  await settle();
  const updated = waitFor(bob, 'code:file-updated');
  alice.emit('code:file-change', { channelId: room, fileId: file?.id, content: 'export {};\n' });
  await updated; await settle();
  alice.emit('code:file-change', { channelId: room, fileId: 'folder-src', content: 'x' });
  alice.emit('code:file-change', { channelId: room, fileId: 'file-readme', content: 42 });
  await settle();
  const deleted = waitFor(bob, 'code:tree-data');
  alice.emit('code:delete-node', { channelId: room, nodeId: 'file-app-py' });
  await deleted; await settle();
  alice.emit('code:delete-node', { channelId: room, nodeId: 'root' });
  alice.emit('code:delete-node', { channelId: room, nodeId: 'nincs' });
  await settle();
}

/** Registers a fresh account on a new connection and returns the socket (events go to `t`). */
async function registered(port: number, t: Transcript, username: string): Promise<ClientSocket> {
  const socket = await client(port, t);
  const ok = waitFor(socket, 'auth:success');
  socket.emit('auth:register', { username, password: 'jelszo', avatarColor: '#444444' });
  await ok; await settle();
  return socket;
}

/** DM voice calls between two authenticated accounts, Dave and Erin; Alice is a guest. */
async function playCalls(port: number, alice: ClientSocket, a: Transcript, d: Transcript, e: Transcript): Promise<ClientSocket[]> {
  const dave = await registered(port, d, 'Dave');
  const erin = await registered(port, e, 'Erin');
  await ack(alice, a, 'call:invite', { targetUsername: 'Erin' });
  await ack(alice, a, 'call:sync', {});
  await ack(alice, a, 'call:get-ice-config', {});
  await ack(dave, d, 'call:invite', { targetUsername: '  ' });
  await ack(dave, d, 'call:invite', { targetUsername: 'nincs' });
  await ack(dave, d, 'call:invite', { targetUsername: 'dave' });
  await ack(dave, d, 'call:invite', { targetUsername: 'Alice' });
  await settle();

  // Ring, late sync on the callee, accept, signalling, connected, resume, hang up.
  const incoming = waitFor(erin, 'call:incoming');
  const invite = await ack(dave, d, 'call:invite', { targetUsername: ' erin ' });
  const callId = field(invite, 'callId');
  await incoming; await settle();
  await ack(dave, d, 'call:invite', { targetUsername: 'Erin' });
  await ack(erin, e, 'call:sync', { callId: null });
  await ack(alice, a, 'call:accept', { callId });
  await ack(dave, d, 'call:accept', { callId });
  await ack(dave, d, 'call:end', { callId: 'nincs' });
  dave.emit('call:signal', { callId, signal: { type: 'offer', sdp: 'v=0' } }); // still ringing: dropped
  const accepted = waitFor(dave, 'call:accepted');
  await ack(erin, e, 'call:accept', { callId });
  await accepted; await settle();
  await ack(erin, e, 'call:accept', { callId });
  const offer = waitFor(erin, 'call:signal');
  dave.emit('call:signal', { callId, signal: { type: 'offer', sdp: 'v=0', extra: 'x' } });
  await offer; await settle();
  const candidate = waitFor(dave, 'call:signal');
  erin.emit('call:signal', { callId, signal: { type: 'candidate', candidate: { candidate: 'c1', sdpMLineIndex: 0, junk: 1 } } });
  await candidate; await settle();
  const endOfCandidates = waitFor(erin, 'call:signal');
  dave.emit('call:signal', { callId, signal: { type: 'candidate', candidate: null } });
  await endOfCandidates; await settle();
  const media = waitFor(erin, 'call:signal');
  dave.emit('call:signal', { callId, signal: { type: 'media', muted: true } });
  await media; await settle();
  dave.emit('call:signal', { callId, signal: { type: 'media', muted: 'yes' } });
  dave.emit('call:signal', { callId, signal: { type: 'candidate', candidate: { candidate: 'c', sdpMLineIndex: 300 } } });
  dave.emit('call:signal', { callId, signal: { type: 'bogus' } });
  alice.emit('call:signal', { callId, signal: { type: 'restart-request' } });
  await settle();
  const restart = waitFor(dave, 'call:signal');
  erin.emit('call:signal', { callId, signal: { type: 'restart-request' } });
  await restart; await settle();
  dave.emit('call:connected', { callId });
  await settle();
  const reconnected = waitFor(erin, 'call:peer-reconnected');
  await ack(dave, d, 'call:sync', { callId });
  await reconnected;
  const ended = waitFor(erin, 'call:ended');
  await ack(erin, e, 'call:end', { callId });
  await ended; await settle();
  await ack(erin, e, 'call:end', { callId });

  // Declined by the callee, cancelled by the caller, then the callee goes offline.
  const declinedRing = waitFor<{ callId: string }>(dave, 'call:incoming');
  await ack(erin, e, 'call:invite', { targetUsername: 'Dave' });
  const declinedId = (await declinedRing).callId; await settle();
  await ack(erin, e, 'call:decline', { callId: declinedId });
  await ack(dave, d, 'call:decline', { callId: declinedId });
  await settle();
  const cancelledRing = waitFor<{ callId: string }>(erin, 'call:incoming');
  await ack(dave, d, 'call:invite', { targetUsername: 'Erin' });
  const cancelledId = (await cancelledRing).callId; await settle();
  await ack(dave, d, 'call:sync', { callId: 'stale' });
  await ack(dave, d, 'call:end', { callId: cancelledId });
  await settle();
  const erinOut = waitFor(dave, 'users:updated');
  erin.emit('auth:logout', {});
  await erinOut; await settle();
  await ack(dave, d, 'call:invite', { targetUsername: 'Erin' });
  await settle();
  await ack(dave, d, 'call:history', { targetUsername: ' Erin ' });
  await ack(dave, d, 'call:history', {});
  await ack(dave, d, 'call:get-ice-config', {});
  return [dave, erin];
}

/**
 * Casino: a voice-channel session, the 3D lobby, lobby chat and the admin wallet tools. Slot
 * spins are rigged by the admin so the reels are deterministic; dealt cards are random, so
 * blackjack and poker are exercised only up to their (deterministic) refusals.
 */
async function playCasino(alice: ClientSocket, a: Transcript, bob: ClientSocket, b: Transcript, carol: ClientSocket, c: Transcript, erin: ClientSocket, e: Transcript): Promise<void> {
  const room = 'hang-chill';
  const alicePlayer = 'alice-player-0000001';
  const started = waitFor(bob, 'casino:session-updated');
  alice.emit('casino:start-session', { channelId: room, username: 'Alice' });
  await started; await settle();
  alice.emit('casino:start-session', null);
  alice.emit('casino:start-session', { channelId: '' });
  await settle();
  const adminBack = waitFor(carol, 'auth:success');
  carol.emit('auth:login', { username: 'bajan', password: 'titok' });
  await adminBack; await settle();

  alice.emit('lobby:join', { id: alicePlayer, name: 'no ack' });
  await settle();
  await ack(alice, a, 'lobby:join', { id: 'short' });
  await ack(alice, a, 'lobby:join', null);
  await ack(alice, a, 'lobby:join', { id: alicePlayer, name: ' <b>Alice</b> ', channelId: room });
  await settle();
  await ack(bob, b, 'lobby:join', { id: 'bob-player-000000001', channelId: room });
  await settle();
  const moved = waitFor(alice, 'player:moved');
  bob.emit('player:move', { x: -1.5, z: 14, yaw: 4 });
  await moved;
  bob.emit('player:move', { x: -1, z: 14, yaw: 0 }); // within 45 ms: ignored
  await settle();
  bob.emit('player:move', { x: 20, z: 14, yaw: 0 }); // teleport: ignored
  bob.emit('player:move', { x: 'a', z: 14, yaw: 0 });
  bob.emit('player:move', null);
  await settle();
  await ack(bob, b, 'chat:send', '   ');
  const said = waitFor(alice, 'chat:message');
  await ack(bob, b, 'chat:send', ' szia <script> ');
  await said;
  await ack(bob, b, 'chat:send', 'gyors');
  await settle();
  await ack(erin, e, 'chat:send', 'x');
  await ack(erin, e, 'casino:slot', { bet: 10 });

  await ack(alice, a, 'casino:slot', { bet: 15 });
  await ack(alice, a, 'casino:slot', { bet: 5000 });
  await ack(alice, a, 'blackjack:hit', {});
  await ack(alice, a, 'blackjack:stand', {});
  await ack(alice, a, 'blackjack:start', { bet: 7 });
  await ack(alice, a, 'poker:deal', { bet: 2000 });
  await ack(alice, a, 'poker:draw', { held: [0, 1] });
  await ack(carol, c, 'admin:casino-list', {});
  await ack(carol, c, 'admin:casino-set-rig', { playerId: alicePlayer, rig: { mode: 'chaos' } });
  await ack(carol, c, 'admin:casino-set-rig', { playerId: alicePlayer, rig: { mode: 'jackpot', symbols: ['💎'], spins: 2 } });
  await ack(alice, a, 'casino:slot', { bet: 10 });
  await ack(alice, a, 'casino:slot', { bet: 20 });
  await ack(carol, c, 'admin:casino-set-rig', { playerId: alicePlayer, rig: { mode: 'bonus' } });
  await ack(alice, a, 'casino:slot', { bet: 10 });
  await ack(carol, c, 'admin:casino-set-rig', { playerId: alicePlayer, rig: { mode: 'symbols', symbols: ['✨', '🍒', '✨'], spins: '2' } });
  await ack(alice, a, 'casino:slot', { bet: 30 });
  await ack(alice, a, 'casino:slot', { bet: 30 });
  await ack(carol, c, 'admin:casino-set-rig', { playerId: alicePlayer, rig: { mode: 'lose', spins: 5000 } });
  await ack(alice, a, 'casino:slot', { bet: 100 });
  await ack(carol, c, 'admin:casino-set-rig', { playerId: alicePlayer, rig: null });
  await ack(carol, c, 'admin:casino-set-balance', { playerId: alicePlayer, balance: -1 });
  await ack(carol, c, 'admin:casino-set-balance', { playerId: alicePlayer, freeSpins: 1.5 });
  const wallet = waitFor(alice, 'wallet:balance');
  await ack(carol, c, 'admin:casino-set-balance', { playerId: alicePlayer, balance: 5000, freeSpins: 0 });
  await wallet; await settle();
  await ack(carol, c, 'admin:casino-list', {});
  const stopped = waitFor(bob, 'casino:session-updated');
  alice.emit('casino:stop-session', { channelId: room });
  await stopped; await settle();
}

/** Emits `event` from `sender`, waits until `waiter` receives `waitEvent`, then lets broadcasts settle. */
async function expect(waiter: ClientSocket, waitEvent: string, sender: ClientSocket, event: string, payload: unknown): Promise<void> {
  const received = waitFor(waiter, waitEvent);
  sender.emit(event, payload);
  await received; await settle();
}

/** Chess in hang-chill: seats, fool's mate, rematch, resignation and admin board edits. */
async function playChess(alice: ClientSocket, bob: ClientSocket, carol: ClientSocket, c: Transcript, erin: ClientSocket): Promise<void> {
  const room = 'hang-chill';
  await expect(alice, 'chess:state', alice, 'chess:start', { channelId: room });
  await expect(bob, 'chess:error', bob, 'chess:move', { channelId: room, from: 'e7', to: 'e5' });
  await expect(carol, 'chess:session-updated', carol, 'chess:start', { channelId: room, colorPreference: 'black' });
  alice.emit('chess:start', null);
  alice.emit('chess:join');
  await settle();
  await expect(alice, 'chess:state', bob, 'chess:join', { channelId: room });
  await expect(carol, 'chess:session-updated', carol, 'chess:join', { channelId: room });
  await expect(bob, 'chess:error', bob, 'chess:move', { channelId: room, from: 'e7', to: 'e5' });
  await expect(bob, 'chess:state', alice, 'chess:move', { channelId: room, from: 'f2', to: 'f3' });
  await expect(bob, 'chess:error', bob, 'chess:move', { channelId: room, from: 'e7', to: 'e1' });
  await expect(alice, 'chess:state', bob, 'chess:move', { channelId: room, from: 'e7', to: 'e5', promotion: '' });
  await expect(bob, 'chess:state', alice, 'chess:move', { channelId: room, from: 'g2', to: 'g4' });
  await expect(alice, 'chess:state', bob, 'chess:move', { channelId: room, from: 'd8', to: 'h4' });
  await expect(alice, 'chess:error', alice, 'chess:move', { channelId: room, from: 'a2', to: 'a3' });
  alice.emit('chess:resign', { channelId: room });
  await settle();
  await expect(alice, 'chess:state', bob, 'chess:rematch', { channelId: room });
  carol.emit('chess:resign', { channelId: room });
  await settle();
  await expect(bob, 'chess:state', alice, 'chess:resign', { channelId: room });
  await expect(erin, 'chess:session-updated', erin, 'chess:start', { channelId: 'hang-gaming-1', colorPreference: 'black' });

  await ack(carol, c, 'admin:chess-set-turn', { channelId: room, turn: 'x' });
  await ack(carol, c, 'admin:chess-set-turn', { channelId: room, turn: 'b' });
  await ack(carol, c, 'admin:chess-put', { channelId: room, square: 'z9', piece: null });
  await ack(carol, c, 'admin:chess-put', { channelId: room, square: 'e4', piece: { type: 'x', color: 'w' } });
  await ack(carol, c, 'admin:chess-put', { channelId: room, square: 'e4', piece: { type: 'q', color: 'w', extra: 1 } });
  await ack(carol, c, 'admin:chess-put', { channelId: room, square: 'd4', piece: { type: 'k', color: 'w' } });
  await ack(carol, c, 'admin:chess-put', { channelId: room, square: 'a1' });
  await ack(carol, c, 'admin:chess-force-move', { channelId: room, from: 'e5', to: 'e6' });
  await ack(carol, c, 'admin:chess-force-move', { channelId: room, from: 'e2', to: 'e9' });
  await ack(carol, c, 'admin:chess-force-move', { channelId: room, from: 'h2', to: 'h6', switchTurn: false });
  await ack(carol, c, 'admin:chess-force-move', { channelId: room, from: 'd1', to: 'e8' });
  await ack(carol, c, 'admin:chess-set-turn', { channelId: 'nincs', turn: 'w' });
  await settle();
}

/**
 * Shared browser without a running session (the script never launches Chrome, so it does not
 * depend on Chrome being installed): state queries, refused starts, ignored controls.
 */
async function playBrowser(alice: ClientSocket, bob: ClientSocket, erin: ClientSocket): Promise<void> {
  const room = 'hang-chill';
  await expect(alice, 'browser:state', alice, 'browser:get-state', { channelId: room });
  await expect(alice, 'browser:state', alice, 'browser:get-state', { channelId: 42 });
  await expect(erin, 'browser:error', erin, 'browser:start', { channelId: room, initialUrl: 'example.com' });
  await expect(bob, 'browser:error', bob, 'browser:start', { channelId: 'hang-gaming-1' });
  await expect(bob, 'browser:error', bob, 'browser:start', {});
  alice.emit('browser:get-state', {});
  alice.emit('browser:start', null);
  for (const event of ['browser:view-enter', 'browser:view-leave', 'browser:navigate', 'browser:back', 'browser:reload',
    'browser:mouse-move', 'browser:mouse-click', 'browser:key', 'browser:set-mode', 'browser:take-control', 'browser:stop']) {
    alice.emit(event, { channelId: room, url: 'example.com', x: 1, y: 2, mode: 'controller' });
  }
  await settle();
}

/** Bob leaves and rejoins hang-chill, so every room-state provider reports its current state. */
async function playRoomSnapshot(bob: ClientSocket): Promise<void> {
  const left = waitFor(bob, 'phobia:session-updated');
  bob.emit('voice:join', { channelId: 'hang-gaming-1' });
  await left; await settle();
  const back = waitFor(bob, 'phobia:session-updated');
  bob.emit('voice:join', { channelId: 'hang-chill' });
  await back; await settle();
}

/** The scripted session; every step waits for its effect, then lets broadcasts settle. */
async function play(port: number): Promise<{ transcripts: Record<string, Transcript>; ids: string[] }> {
  const a: Transcript = [];
  const b: Transcript = [];
  const c: Transcript = [];
  const d: Transcript = [];
  const e: Transcript = [];
  const alice = await client(port, a);
  const aliceInit = waitFor(alice, 'init:data');
  alice.emit('user:join', { username: 'Alice', avatarColor: '#111111' });
  await aliceInit; await settle();

  const bob = await client(port, b);
  const bobInit = waitFor(bob, 'init:data');
  bob.emit('user:join', { username: 'Bob' });
  await bobInit; await settle();

  const chat = waitFor(bob, 'chat:new-message');
  alice.emit('chat:message', { channelId: 'altalanos', text: 'szia' });
  await chat; await settle();

  const aliceRoom = waitFor(alice, 'phobia:session-updated');
  alice.emit('voice:join', { channelId: 'hang-chill' });
  await aliceRoom; await settle();
  const bobRoom = waitFor(bob, 'phobia:session-updated');
  bob.emit('voice:join', { channelId: 'hang-chill' });
  await bobRoom; await settle();

  const speaking = waitFor(bob, 'voice:user-speaking');
  alice.emit('voice:speaking', { isSpeaking: true });
  await speaking; await settle();

  const pong = waitFor(bob, 'speedtest:pong');
  bob.emit('speedtest:ping', { clientTime: 1 });
  await pong; await settle();

  // Media flags (truthiness coercion), mute state (only booleans applied), WebRTC relay.
  const sharing = waitFor(bob, 'voice:user-screen-sharing');
  alice.emit('voice:screen-share', { isSharing: true });
  await sharing; await settle();
  const camera = waitFor(bob, 'voice:user-camera');
  alice.emit('voice:camera', { isOn: 1 });
  await camera; await settle();
  const muted = waitFor(alice, 'voice:peer-state-changed');
  bob.emit('voice:state-change', { isMuted: true, isDeafened: 'yes' });
  await muted; await settle();
  const signal = waitFor(bob, 'webrtc:signal');
  alice.emit('webrtc:signal', { targetPeerId: bob.id, signal: { type: 'offer', sdp: 'v=0' } });
  await signal;
  alice.emit('webrtc:signal', { targetPeerId: 'nobody', signal: { type: 'offer' } });
  alice.emit('webrtc:signal', { targetPeerId: bob.id });
  await settle();

  // Speed test: valid result (coerced), invalid result (ignored), peer request.
  const announced = waitFor(alice, 'speedtest:result-announced');
  bob.emit('speedtest:save-result', { ping: 12.6, download: 50.04, upload: 9.96, jitter: '2' });
  await announced; await settle();
  bob.emit('speedtest:save-result', { download: '5' });
  await settle();
  const requested = waitFor(bob, 'speedtest:requested-by');
  alice.emit('speedtest:request-user', { targetUserId: bob.id });
  await requested; await settle();

  // Malformed payloads: legacy destructuring threw, so nothing happens.
  alice.emit('voice:join', null);
  alice.emit('chat:message', null);
  alice.emit('speedtest:ping', null);
  alice.emit('voice:speaking', null);
  alice.emit('chat:message', 'not an object');
  await settle();

  // Attachment-only chat in another channel; channel switch; leave.
  const attachment = waitFor(alice, 'chat:new-message');
  bob.emit('chat:message', { channelId: 'gaming', text: '', attachments: [{ name: 'a.png', url: '/uploads/a.png' }] });
  await attachment; await settle();
  const switched = waitFor(bob, 'voice:peer-left');
  alice.emit('voice:join', { channelId: 'hang-gaming-1' });
  await switched; await settle();
  const leftStates = waitFor(bob, 'voice:states-updated');
  alice.emit('voice:leave');
  await leftStates; await settle();
  const rejoined = waitFor(alice, 'phobia:session-updated');
  alice.emit('voice:join', { channelId: 'hang-chill' });
  await rejoined; await settle();

  const carol = await playAccountsDmAdmin(port, alice, a, bob, b, c);
  await playWhiteboard(alice, bob);
  await playWatchParty(alice, bob);
  await playCodeEditor(alice, bob);
  const callers = await playCalls(port, alice, a, d, e);
  const [, erin] = callers;
  if (erin) await playCasino(alice, a, bob, b, carol, c, erin, e);
  if (erin) await playChess(alice, bob, carol, c, erin);
  if (erin) await playBrowser(alice, bob, erin);
  await playRoomSnapshot(bob);

  await ack(alice, a, 'admin:casino-list', {});
  await ack(bob, b, 'game:rpc', 'getProfile', {});
  bob.emit('chat:message', { channelId: 'altalanos', text: '   ' }); // ignored by legacy: empty text
  await settle();

  const ids = [alice.id ?? '', bob.id ?? '', carol.id ?? '', ...callers.map((s) => s.id ?? '')];
  carol.close();
  for (const socket of callers) socket.close();
  await settle();
  const peerLeft = waitFor(alice, 'voice:peer-left');
  bob.close();
  await peerLeft; await settle();
  alice.close();
  return { transcripts: { alice: a, bob: b, carol: c, dave: d, erin: e }, ids };
}

/**
 * MiskolcSweepers has no legacy counterpart: its `miskolc:*` events and its `sweepersSessions`
 * init:data key are additions (covered by test/unit/sweepers), left out of the legacy comparison.
 */
function withoutSweepers(transcripts: Record<string, Transcript>): Record<string, Transcript> {
  const strip = ([event, payload]: [string, unknown]): [string, unknown] => {
    if (event !== 'init:data' || typeof payload !== 'object' || payload === null) return [event, payload];
    return [event, Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'sweepersSessions'))];
  };
  return Object.fromEntries(Object.entries(transcripts).map(([who, t]) => [who, t.filter(([event]) => !event.startsWith('miskolc:')).map(strip)]));
}

/** Replaces socket ids, Date.now() stamps, locale times, generated ids and auth tokens with placeholders. */
function normalise(value: unknown, ids: string[]): unknown {
  const text = JSON.stringify(value, function (this: unknown, key: string, v: unknown) {
    const holder = typeof this === 'object' && this !== null ? (this as Record<string, unknown>) : {};
    // Live watch-party position of a playing video (wall-time dependent).
    if (key === 'currentTime' && holder['isPlaying'] === true && 'serverTime' in holder) return '<live>';
    // Random id of a watch-party reaction.
    if (key === 'id' && 'emoji' in holder) return '<reaction>';
    if (typeof v === 'number' && v > 1e12 && v < 1e13) return '<ts>';
    if (typeof v === 'string' && /^\d{1,2}:\d{2}(\s?[AP]M)?$/.test(v)) return '<time>';
    if (typeof v === 'string' && /^\d{13}-[a-z0-9]+$/.test(v)) return '<msgid>';
    if (typeof v === 'string' && /^[a-z]+_\d{13}_[a-z0-9]*$/.test(v)) return '<id>';
    if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) return '<token>';
    if (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)) return '<callid>';
    return v;
  });
  const replaced = ids.reduce((acc, id, i) => (id ? acc.split(id).join(`<socket${i}>`) : acc), text);
  return JSON.parse(replaced) as unknown;
}

const mode = process.argv[2] ?? '';
if (mode !== 'legacy' && mode !== 'app') throw new Error('usage: runGoldenSession.ts legacy|app');
try {
  const booted = await boot(mode, await createTestCerts());
  const { transcripts, ids } = await play(booted.port);
  await booted.close();
  // stdout is an async pipe here: exit only once the whole transcript is flushed, or it is truncated.
  process.stdout.write(`\nGOLDEN:${JSON.stringify(normalise(withoutSweepers(transcripts), ids))}\n`, () => process.exit(0));
} catch (err) {
  // The process guards would swallow this and leave the run hanging: fail fast instead.
  process.stderr.write(`golden session failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`, () => process.exit(1));
}
