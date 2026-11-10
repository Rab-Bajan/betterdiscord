// Automated Verification Test for MiskolcPhobia Backend Core
// Validates socket events, authoritative 12 Hz tick loop, physics/environment states,
// circuit breaker overload (max 6 lights), Mobile Jesus hunt cancellation, and SQLite persistence.

process.env.PHOBIA_TEST_HOOKS = '1'; // teszt hookok + teszt szoba azonosító (test_room_*)
const assert = require('assert');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const { setupMiskolcPhobia } = require('./miskolcPhobiaHandler');
const { db } = require('./database');

async function runPhobiaBackendTests() {
  console.log('>>> [TEST] Starting MiskolcPhobia Authoritative Backend Test Suite...');

  // 1. Setup in-memory HTTP server and Socket.IO instance
  const server = http.createServer();
  const io = new Server(server, { cors: { origin: '*' } });
  const users = new Map();

  const phobia = setupMiskolcPhobia(io, users);

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const serverUrl = `http://localhost:${port}`;
  console.log(`>>> [TEST] Test server listening on ${serverUrl}`);

  const testRoomId = 'test_room_' + Date.now();
  const testUserId1 = 'test_user_' + Date.now();
  const testUserId2 = 'test_user_peer_' + Date.now();

  // Reset or ensure test user initial state
  db.prepare('DELETE FROM phobia_profiles WHERE userId IN (?, ?)').run(testUserId1, testUserId2);
  db.prepare('DELETE FROM phobia_match_history WHERE userId IN (?, ?)').run(testUserId1, testUserId2);

  // 2. Connect Client 1
  const client1 = ioClient(serverUrl, { reconnection: false, transports: ['websocket'] });
  const client2 = ioClient(serverUrl, { reconnection: false, transports: ['websocket'] });

  await Promise.all([
    new Promise((resolve) => client1.on('connect', resolve)),
    new Promise((resolve) => client2.on('connect', resolve))
  ]);
  console.log('>>> [TEST] Both simulated clients connected successfully.');

  try {
    // ------------------------------------------------------------------------
    // Step 1: Session Initialization & Spawn Verification
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 1: Initializing session & verifying spawn coordinates...');
    const initPromise1 = new Promise((resolve) => {
      client1.once('phobia:session-init', (data) => resolve(data));
    });

    client1.emit('phobia:init-session', {
      roomId: testRoomId,
      userId: testUserId1,
      username: 'Borsodi_Béla',
      avatarColor: '#FF5500'
    });

    const initData1 = await initPromise1;
    assert(initData1, 'Expected session-init payload');
    assert.strictEqual(initData1.session.roomId, testRoomId, 'Room ID should match');
    assert.deepStrictEqual(initData1.self.position, [-4.0, 0.0, -15.0], 'Initial spawn position must be outside the van');
    assert.strictEqual(initData1.self.sanity, 100, 'Initial player sanity must be 100%');
    assert(initData1.profile, 'Profile should be created in SQLite');
    assert.strictEqual(initData1.profile.balance_ft, 1000, 'Initial profile balance must be 1000 Ft');
    assert.strictEqual(initData1.profile.hunter_rank, 'Kezdő Roncskutató', 'Initial rank must be Kezdő Roncskutató');
    console.log('  [PASS] Step 1: Session initialized with valid spawn coords and default profile.');

    // Connect Client 2 to same room
    const initPromise2 = new Promise((resolve) => {
      client2.once('phobia:session-init', (data) => resolve(data));
    });
    client2.emit('phobia:init-session', {
      roomId: testRoomId,
      userId: testUserId2,
      username: 'Miskolci_Geza',
      avatarColor: '#00AAFF'
    });
    await initPromise2;
    console.log('  [PASS] Step 1b: Client 2 joined session.');

    // ------------------------------------------------------------------------
    // Step 2: 12 Hz Tick Broadcast Verification
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 2: Verifying 12 Hz authoritative state tick...');
    const tickData = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for phobia:tick')), 1500);
      client1.on('phobia:tick', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
    });

    assert(tickData.tick > 0, 'Tick count should be positive');
    assert(Array.isArray(tickData.players), 'Tick should include players array');
    assert.strictEqual(tickData.players.length, 2, 'Tick should contain both connected players');
    assert(tickData.ghost, 'Tick should broadcast ghost state');
    assert.strictEqual(typeof tickData.breakerOn, 'boolean', 'Tick should include breaker state');
    console.log('  [PASS] Step 2: 12 Hz tick loop actively broadcasting delta states.');

    // ------------------------------------------------------------------------
    // Step 3: Item Pickup & Inventory Slot Management
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 3: Picking up Mobile Jesus from equipment shelf...');
    const pickupPromise = new Promise((resolve) => {
      client1.once('phobia:item-picked-up', (data) => resolve(data));
    });

    client1.emit('phobia:pickup-item', {
      roomId: testRoomId,
      itemId: 'mobile_jesus_1',
      slot: 0
    });

    const pickupData = await pickupPromise;
    assert(pickupData, 'Expected item-picked-up response');
    assert.strictEqual(pickupData.slot, 0, 'Slot should be 0');
    assert.strictEqual(pickupData.item.type, 'mobile_jesus', 'Item type must be mobile_jesus');
    assert.strictEqual(pickupData.item.charges, 2, 'Mobile Jesus should have 2 charges');
    assert.strictEqual(pickupData.inventory[0].type, 'mobile_jesus', 'Inventory slot 0 should contain Mobile Jesus');
    console.log('  [PASS] Step 3: Mobile Jesus picked up into inventory slot 0 with 2 charges.');

    // ------------------------------------------------------------------------
    // Step 4: Movement to Zone 1 (Mázsaház) & Temperature Check
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 4: Moving into Zone 1 (Mázsaház coords: 5, 0, 8)...');
    client1.emit('phobia:player-move', {
      roomId: testRoomId,
      position: [5.0, 0.0, 8.0],
      rotation: [0.0, 1.57],
      crouched: false,
      sprinting: false,
      isInsideTruck: false,
      currentZone: 'zone1_mazsahaz'
    });

    // Ensure session ghost has freezing evidence for this test
    const session = phobia.sessions.get(testRoomId);
    if (!session.ghost.evidence) session.ghost.evidence = [];
    if (!session.ghost.evidence.includes('freezing_temps')) {
      session.ghost.evidence.push('freezing_temps');
    }
    if (session.ghost.type && session.ghost.type.evidences && !session.ghost.type.evidences.includes('freezing_temperatures')) {
      session.ghost.type.evidences.push('freezing_temperatures');
    }

    const tempPromise = new Promise((resolve) => {
      client1.once('phobia:temperature-reading', (data) => resolve(data));
    });

    client1.emit('phobia:get-temperature', {
      roomId: testRoomId,
      position: [5.0, 0.0, 8.0]
    });

    const tempData = await tempPromise;
    assert(tempData.temperature < 0.0, `Expected temperature < 0.0°C in freezing zone, got: ${tempData.temperature}`);
    assert.strictEqual(tempData.isFreezing, true, 'isFreezing flag should be true');
    console.log(`  [PASS] Step 4: Zone 1 temperature read as ${tempData.temperature}°C (<0.0°C freezing).`);

    // ------------------------------------------------------------------------
    // Step 5: Ghost Scrap Prop Interaction & EMF 5 Reading
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 5: Triggering ghost scrap interaction & EMF pulse...');
    if (!session.ghost.evidence.includes('emf_5')) {
      session.ghost.evidence.push('emf_5');
    }
    if (session.ghost.type && session.ghost.type.evidences && !session.ghost.type.evidences.includes('emf_5')) {
      session.ghost.type.evidences.push('emf_5');
    }

    const thrownPromise = new Promise((resolve) => {
      client1.once('phobia:item-thrown', (data) => resolve(data));
    });
    const emfPromise = new Promise((resolve) => {
      client1.once('phobia:emf-reading', (data) => resolve(data));
    });

    client1.emit('phobia:trigger-ghost-interaction', {
      roomId: testRoomId,
      propId: 'scrap_pipe_1'
    });

    const [thrownData, emfData] = await Promise.all([thrownPromise, emfPromise]);
    assert(thrownData, 'Expected item-thrown broadcast');
    assert(emfData, 'Expected emf-reading broadcast');
    assert.strictEqual(emfData.level, 5, 'Ghost with EMF 5 evidence must generate Level 5 EMF reading');
    console.log('  [PASS] Step 5: Scrap prop thrown with authentic Level 5 EMF reading.');

    // ------------------------------------------------------------------------
    // Step 6: Circuit Breaker Overload (Max 6 Lights) Rule
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 6: Testing 6-light limit and breaker trip on 7th light...');
    assert.strictEqual(session.breakerOn, true, 'Breaker should initially be ON');

    // Turn on 6 lights
    const lightIds = [
      'light_mazsahaz_office',
      'light_mazsahaz_hall',
      'light_hangar_flood_1',
      'light_hangar_flood_2',
      'light_sufni_1',
      'light_gate_floodlight'
    ];

    for (const lid of lightIds) {
      const p = new Promise((resolve) => client1.once('phobia:light-updated', resolve));
      client1.emit('phobia:light-toggle', { roomId: testRoomId, lightId: lid });
      await p;
    }
    assert.strictEqual(session.activeLights.size, 6, 'Should have exactly 6 active lights');

    // Turn on 7th light: should trip breaker to OFF!
    const tripPromise = new Promise((resolve) => {
      client1.once('phobia:breaker-tripped', (data) => resolve(data));
    });

    client1.emit('phobia:light-toggle', { roomId: testRoomId, lightId: 'light_yard_floodlight1' });

    const tripData = await tripPromise;
    assert(tripData, 'Expected phobia:breaker-tripped event');
    assert.strictEqual(tripData.reason, 'overload', 'Trip reason must be overload');
    assert.strictEqual(session.breakerOn, false, 'Breaker must be tripped to OFF');
    assert.strictEqual(session.activeLights.size, 0, 'All active lights must turn off upon breaker trip');
    console.log('  [PASS] Step 6: 7th light successfully tripped breaker and shut down all fixtures.');

    // Restore breaker
    const breakerPromise = new Promise((resolve) => {
      const handler = (data) => {
        if (data.breakerOn === true) {
          client1.off('phobia:breaker-updated', handler);
          resolve(data);
        }
      };
      client1.on('phobia:breaker-updated', handler);
    });
    client1.emit('phobia:breaker-toggle', { roomId: testRoomId, state: true });
    await breakerPromise;
    assert.strictEqual(session.breakerOn, true, 'Breaker should be restored to ON');

    // ------------------------------------------------------------------------
    // Step 7: Mobile Jesus Crucifix Hunt Cancellation
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 7: Triggering hunt initiation near Mobile Jesus...');
    // Ensure ghost is near player holding Mobile Jesus (within 4m)
    session.ghost.position = [5.5, 0.0, 8.0]; // 0.5m from player at (5, 0, 8)

    const cancelPromise = new Promise((resolve) => {
      client1.once('phobia:hunt-cancelled', (data) => resolve(data));
    });
    const burnedPromise = new Promise((resolve) => {
      client1.once('phobia:jesus-burned', (data) => resolve(data));
    });

    client1.emit('phobia:trigger-hunt', { roomId: testRoomId });

    const [cancelData, burnedData] = await Promise.all([cancelPromise, burnedPromise]);
    assert(cancelData, 'Expected hunt-cancelled broadcast');
    assert.strictEqual(cancelData.reason, 'crucifix', 'Cancellation reason must be crucifix');
    assert.strictEqual(cancelData.chargesRemaining, 1, 'Mobile Jesus should have 1 charge remaining');
    assert.strictEqual(burnedData.chargesRemaining, 1, 'Mobile Jesus burned payload should have 1 charge remaining');
    assert.strictEqual(session.ghost.huntActive, false, 'Ghost hunt must not be active');
    assert.strictEqual(session.ghost.state, 'POST_HUNT_COOLDOWN', 'Ghost must enter POST_HUNT_COOLDOWN');
    console.log('  [PASS] Step 7: Mobile Jesus successfully burned charge 1 and cancelled the hunt.');

    // ------------------------------------------------------------------------
    // Step 8: Sanity Pálinka Consumption (+35% Sanity)
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 8: Drinking Borsodi Szilvapálinka for +35% sanity...');
    const player1 = session.players.get(client1.id);
    player1.sanity = 45.0; // Reduce sanity to test restoration
    player1.inventory[1] = { id: 'sanity_palinka_1', type: 'sanity_palinka', usesLeft: 1 }; // a pálinkát tartani kell

    const sanityPromise = new Promise((resolve) => {
      client1.once('phobia:sanity-updated', (data) => resolve(data));
    });

    client1.emit('phobia:use-sanity-palinka', { roomId: testRoomId });

    const sanityData = await sanityPromise;
    assert.strictEqual(sanityData.sanity, 80, '45% sanity + 35% should restore to exactly 80%');
    console.log('  [PASS] Step 8: Pálinka restored sanity from 45% to 80%.');

    // ------------------------------------------------------------------------
    // Step 9: Hinged Door Toggle
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 9: Toggling Mázsaház hinged door...');
    const doorPromise = new Promise((resolve) => {
      client1.once('phobia:door-updated', (data) => resolve(data));
    });

    client1.emit('phobia:door-toggle', {
      roomId: testRoomId,
      doorId: 'door_mazsahaz_entry'
    });

    const doorData = await doorPromise;
    assert.strictEqual(doorData.doorId, 'door_mazsahaz_entry', 'Door ID should match');
    assert.strictEqual(doorData.open, true, 'Door should be opened');
    assert.strictEqual(doorData.angle, 1.0, 'Door angle should be 1.0');
    console.log('  [PASS] Step 9: Hinged door opened with angle 1.0.');

    // ------------------------------------------------------------------------
    // Step 9b: Client item throw rebroadcast (sender excluded, velocity clamped)
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 9b: Client emits phobia:item-thrown, peer receives clamped impulse...');
    const thrownPeer = new Promise((resolve) => client2.once('phobia:item-thrown', resolve));
    let senderGotEcho = false;
    client1.once('phobia:item-thrown', () => { senderGotEcho = true; });
    const thrower = session.players.get(client1.id);
    const thrownId = session.scrapProps[0].id;

    // invalid payload and unknown item are ignored
    client1.emit('phobia:item-thrown', { roomId: testRoomId, itemId: 'nope', position: { x: 0, y: 0, z: 0 }, velocity: { x: 1, y: 1, z: 1 } });
    client1.emit('phobia:item-thrown', { roomId: testRoomId, itemId: thrownId, position: { x: NaN, y: 0, z: 0 }, velocity: { x: 1, y: 1, z: 1 } });
    client1.emit('phobia:item-thrown', {
      roomId: testRoomId,
      itemId: thrownId,
      position: { x: thrower.position[0], y: 1, z: thrower.position[2] },
      velocity: { x: 300, y: 0, z: 400 }
    });

    const peerThrow = await thrownPeer;
    assert.strictEqual(peerThrow.propId, thrownId, 'propId should match');
    assert.strictEqual(peerThrow.x, thrower.position[0], 'x should be echoed');
    assert.strictEqual(peerThrow.y, 1, 'y should be echoed');
    assert(Math.abs(Math.hypot(...peerThrow.impulse) - 20) < 1e-9, 'impulse magnitude must be clamped to 20');
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(senderGotEcho, false, 'sender must not receive its own throw');
    console.log('  [PASS] Step 9b: item-thrown validated, clamped and rebroadcast to peer only.');

    // ------------------------------------------------------------------------
    // Step 9c: Lobby flow, settings, hiding, world item sync, objectives (separate room)
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 9c: Lobby settings, late-join snapshot, item sync, hide, objectives...');
    const lobbyRoom = 'test_room_lobby_' + Date.now();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const once = (c, ev) => new Promise((r) => c.once(ev, r));
    const hostC = client1;
    const peerC = client2;
    const lobbyInit = once(hostC, 'phobia:session-init');
    hostC.emit('phobia:init-session', { roomId: lobbyRoom, userId: testUserId1, username: 'Host', lobby: true, settings: { evidenceCount: 2, startingSanity: 80 } });
    const lobbySnap = await lobbyInit;
    assert.strictEqual(lobbySnap.session.status, 'lobby');
    assert.strictEqual(lobbySnap.session.hostSocketId, hostC.id);
    assert.deepStrictEqual(lobbySnap.session.settings, { evidenceCount: 2, startingSanity: 80 });
    const peerInit = once(peerC, 'phobia:session-init');
    peerC.emit('phobia:init-session', { roomId: lobbyRoom, userId: testUserId2, username: 'Peer', lobby: true });
    await peerInit;

    // non-host rejected; host validated/clamped
    const lobbySession = phobia.sessions.get(lobbyRoom);
    peerC.emit('phobia:update-settings', { roomId: lobbyRoom, settings: { evidenceCount: 1, startingSanity: 10 } });
    await wait(100);
    assert.deepStrictEqual(lobbySession.settings, { evidenceCount: 2, startingSanity: 80 }, 'non-host must not change settings');
    const updated = once(peerC, 'phobia:settings-updated');
    hostC.emit('phobia:update-settings', { roomId: lobbyRoom, settings: { evidenceCount: 9, startingSanity: 50 } });
    const upd = await updated;
    assert.deepStrictEqual(upd.settings, { evidenceCount: 3, startingSanity: 50 }, 'settings clamped');
    hostC.emit('phobia:update-settings', { roomId: lobbyRoom, settings: { evidenceCount: 1, startingSanity: 60 } });
    await wait(100);

    // start-match: non-host ignored, host applies settings
    peerC.emit('phobia:start-match', { roomId: lobbyRoom });
    await wait(100);
    assert.strictEqual(lobbySession.status, 'lobby', 'non-host cannot start');
    const startInit = once(peerC, 'phobia:session-init');
    hostC.emit('phobia:start-match', { roomId: lobbyRoom });
    const started = await startInit;
    assert.strictEqual(started.session.status, 'active');
    assert.strictEqual(started.session.settings.evidenceCount, 1);
    assert.strictEqual(started.self.sanity, 60, 'starting sanity applied');
    assert.strictEqual(lobbySession.players.get(hostC.id).sanity, 60);
    assert.strictEqual(lobbySession.ghost.activeEvidence?.length ?? 1, 1, 'evidenceCount applied to ghost');
    assert.strictEqual(started.session.objectives.length, 3);

    // drop an item, move it, late joiner sees it moved
    const hostP = lobbySession.players.get(hostC.id);
    hostP.position = [-3.5, 0, -14.5];
    hostC.emit('phobia:pickup-item', { roomId: lobbyRoom, itemId: 'mobile_jesus', slot: 0 }); // rack id fix
    await wait(150);
    assert(hostP.inventory[0] && hostP.inventory[0].type === 'mobile_jesus', 'client rack id must resolve to shelf item');
    const spawned = once(peerC, 'phobia:world-item-updated');
    hostC.emit('phobia:drop-item', { roomId: lobbyRoom, slot: 0, x: -3.5, y: 0.1, z: -14.5 });
    const sp = await spawned;
    assert.strictEqual(sp.action, 'spawned');
    assert.strictEqual(sp.actorSocketId, hostC.id);
    const movedEv = once(peerC, 'phobia:world-item-updated');
    hostC.emit('phobia:item-moved', { roomId: lobbyRoom, itemId: 'mobile_jesus_1', position: { x: -2, y: 0.2, z: -13 }, rotation: { x: 0.1, y: 0.2, z: 0.3 } });
    const mv = await movedEv;
    assert.strictEqual(mv.action, 'moved');
    assert.strictEqual(mv.item.x, -2);
    assert.strictEqual(mv.item.ry, 0.2);
    hostC.emit('phobia:item-moved', { roomId: lobbyRoom, itemId: 'nope', position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } });
    hostC.emit('phobia:item-moved', { roomId: lobbyRoom, itemId: 'mobile_jesus_1', position: { x: NaN, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } });
    await wait(100);
    assert.strictEqual(lobbySession.droppedItems[0].x, -2, 'invalid moves ignored');

    const client3 = ioClient(serverUrl, { reconnection: false, transports: ['websocket'] });
    await once(client3, 'connect');
    const lateInit = once(client3, 'phobia:session-init');
    client3.emit('phobia:init-session', { roomId: lobbyRoom, userId: 'late_' + Date.now(), username: 'Late', lobby: true });
    const late = await lateInit;
    const lateItem = late.session.droppedItems.find((i) => i.id === 'mobile_jesus_1');
    assert(lateItem, 'late joiner snapshot must contain dropped item');
    assert.strictEqual(lateItem.x, -2);
    assert.strictEqual(lateItem.rz, 0.3);
    assert(late.session.scrapProps.length > 0 && late.session.doors && late.session.lights);

    // hide validation
    const hideEv = once(peerC, 'phobia:player-hide');
    hostC.emit('phobia:hide', { roomId: lobbyRoom, spotId: 'car_trunk_1', hidden: true }); // too far
    hostC.emit('phobia:hide', { roomId: lobbyRoom, spotId: 'nonexistent', hidden: true });
    await wait(100);
    assert.strictEqual(hostP.hidingSpotId, null, 'far/unknown spot rejected');
    hostP.position = [-17.5, 0, 8.5];
    hostC.emit('phobia:hide', { roomId: lobbyRoom, spotId: 'car_trunk_1', hidden: true });
    const hideData = await hideEv;
    assert.deepStrictEqual(hideData, { socketId: hostC.id, spotId: 'car_trunk_1', hidden: true });
    assert.strictEqual(hostP.hidingSpotId, 'car_trunk_1');
    hostC.emit('phobia:hide', { roomId: lobbyRoom, spotId: 'car_trunk_1', hidden: false });
    await wait(100);
    assert.strictEqual(hostP.hidingSpotId, null);

    // speaking flag
    hostC.emit('phobia:player-speaking', { roomId: lobbyRoom, isSpeaking: true });
    await wait(100);
    assert.strictEqual(hostP.isSpeaking, true);

    // objective completion (server-detected): drink palinka if drawn, else force via palinka path
    lobbySession.objectives[0] = { id: 'drink_palinka', textHu: 'x', done: false, rewardFt: 300 };
    hostP.inventory[1] = { id: 'sanity_palinka_x', type: 'sanity_palinka' };
    const objEv = once(peerC, 'phobia:objectives-updated');
    hostC.emit('phobia:use-sanity-palinka', { roomId: lobbyRoom, slot: 1 });
    const obj = await objEv;
    assert.strictEqual(obj.objectives[0].done, true, 'objective detected by server');
    assert.strictEqual(obj.primary.done, false);
    client3.disconnect();
    console.log('  [PASS] Step 9c: lobby settings, late-join snapshot, item sync, hide, objectives.');

    // ------------------------------------------------------------------------
    // Step 10: Journal Verdict Submission & SQLite Persistence Verification
    // ------------------------------------------------------------------------
    console.log('>>> [TEST] Step 10: Submitting correct ghost verdict and verifying SQLite payout...');
    const correctGhostType = session.ghost.type?.name || session.ghost.typeName || session.ghost.name || (typeof session.ghost.type === 'string' ? session.ghost.type : 'Lakatos Ármándó');

    const verdictPromise = new Promise((resolve) => {
      client1.once('phobia:match-concluded', (data) => resolve(data));
    });

    client1.emit('phobia:submit-verdict', {
      roomId: testRoomId,
      ghostGuess: correctGhostType,
      userId: testUserId1
    });

    const verdictData = await verdictPromise;
    assert(verdictData, 'Expected match-concluded event');
    assert.strictEqual(verdictData.correct, true, 'Verdict guess must be correct');
    assert(verdictData.rewardFt >= 3000, `Reward must be >= 3000 Ft, got: ${verdictData.rewardFt}`);

    // Verify SQLite database tables directly
    const updatedProfile = db.prepare('SELECT * FROM phobia_profiles WHERE userId = ?').get(testUserId1);
    assert(updatedProfile, 'Profile must exist in SQLite phobia_profiles table');
    assert(
      updatedProfile.balance_ft >= 4000,
      `Profile balance must be >= 4000 Ft (1000 initial + >= 3000 reward), got: ${updatedProfile.balance_ft}`
    );
    assert(updatedProfile.xp > 0, 'XP should have increased');

    const matchHistoryRows = db.prepare('SELECT * FROM phobia_match_history WHERE userId = ?').all(testUserId1);
    assert.strictEqual(matchHistoryRows.length, 1, 'Should have 1 entry in phobia_match_history');
    assert.strictEqual(matchHistoryRows[0].result, 'Győzelem', 'Match history result should be Győzelem');
    assert.strictEqual(matchHistoryRows[0].ghostType, correctGhostType, 'Match history ghostType should match');
    assert(matchHistoryRows[0].reward_ft >= 3000, 'Match history reward_ft should match earned reward');

    console.log(`  [PASS] Step 10: Contract concluded. SQLite profile balance credited to ${updatedProfile.balance_ft} Ft.`);
    console.log('>>> [TEST] ALL 10 TESTS PASSED CLEANLY WITH ZERO REGRESSIONS!');

  } finally {
    // Cleanup
    client1.disconnect();
    client2.disconnect();
    clearInterval(phobia.tickInterval);
    server.close();
  }
}

runPhobiaBackendTests().catch((err) => {
  console.error('>>> [TEST FAILED]:', err);
  process.exit(1);
});
