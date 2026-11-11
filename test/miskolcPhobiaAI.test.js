const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  createGhostAI,
  updateGhostAI,
  checkCrucifixDefense,
  applySmudgeSticks,
  triggerHunt,
  triggerInteraction,
  triggerGhostEvent,
  calculateRoomTemperature,
  getGhostTemperature,
  getArchetype,
  getEvidenceList,
  GHOST_STATES,
  GHOST_ARCHETYPES,
  EVIDENCES,
  DEFAULT_ZONES
} = require('../miskolcPhobiaAI.js');

describe('MiskolcPhobia Ghost AI Simulation Engine', () => {

  describe('1. The 7 Miskolc Folklore Archetypes & Evidence Matrix', () => {
    it('should have all 7 authentic folklore archetypes configured', () => {
      const keys = Object.keys(GHOST_ARCHETYPES);
      assert.strictEqual(keys.length, 7);
      assert.ok(GHOST_ARCHETYPES.lakatos_armando);
      assert.ok(GHOST_ARCHETYPES.kolompar_kalman);
      assert.ok(GHOST_ARCHETYPES.rostas_bela);
      assert.ok(GHOST_ARCHETYPES.bunko_lajos);
      assert.ok(GHOST_ARCHETYPES.sarkozi_geza);
      assert.ok(GHOST_ARCHETYPES.raffael_dzsenifer);
      assert.ok(GHOST_ARCHETYPES.keresztapa);
    });

    it('Lakatos Ármándó (Poltergeist): Ghost Writing, Spirit Box, EMF 5 + multi-throw perk', () => {
      const arch = GHOST_ARCHETYPES.lakatos_armando;
      assert.strictEqual(arch.name, 'Lakatos Ármándó');
      assert.deepStrictEqual(arch.evidences.sort(), ['emf_5', 'ghost_writing', 'spirit_box'].sort());
      assert.strictEqual(arch.multiThrow, true);
      assert.strictEqual(arch.huntThreshold, 50);
    });

    it('Kolompár Kálmán (Bicskás Vadász): Freezing Temps, Fingerprints, D.O.T.S. + freezing speed boost', () => {
      const arch = GHOST_ARCHETYPES.kolompar_kalman;
      assert.strictEqual(arch.name, 'Kolompár Kálmán');
      assert.deepStrictEqual(arch.evidences.sort(), ['dots', 'fingerprints', 'freezing_temperatures'].sort());
      assert.strictEqual(arch.freezingSpeedBoost, true);
      assert.strictEqual(arch.freezingBaseSpeed, 2.2);
      assert.strictEqual(arch.freezingMaxSpeed, 3.3);
    });

    it('Rostás "Flexes" Béla (Hangoskodó): EMF 5, Fingerprints, Ghost Orbs + bulb shatter chance', () => {
      const arch = GHOST_ARCHETYPES.rostas_bela;
      assert.strictEqual(arch.name, 'Rostás "Flexes" Béla');
      assert.deepStrictEqual(arch.evidences.sort(), ['emf_5', 'fingerprints', 'ghost_orbs'].sort());
      assert.strictEqual(arch.bulbShatterChance, 0.50);
      assert.strictEqual(arch.spiritBoxScream, true);
    });

    it('Bunkó Lajos (Fagyos Rezes): Freezing Temps, Ghost Writing, Spirit Box + 40% breaker sabotage', () => {
      const arch = GHOST_ARCHETYPES.bunko_lajos;
      assert.strictEqual(arch.name, 'Bunkó Lajos');
      assert.deepStrictEqual(arch.evidences.sort(), ['freezing_temperatures', 'ghost_writing', 'spirit_box'].sort());
      assert.strictEqual(arch.breakerSabotageProb, 0.40);
    });

    it('Sárközi "Lókupec" Géza (Csendes Árnyék): D.O.T.S., Ghost Orbs, Freezing Temps + shyness', () => {
      const arch = GHOST_ARCHETYPES.sarkozi_geza;
      assert.strictEqual(arch.name, 'Sárközi "Lókupec" Géza');
      assert.deepStrictEqual(arch.evidences.sort(), ['dots', 'freezing_temperatures', 'ghost_orbs'].sort());
      assert.strictEqual(arch.shyness, true);
      assert.strictEqual(arch.shynessDropPercent, 0.80);
    });

    it('Raffael Dzsenifer (Démon): Fingerprints, Ghost Writing, Freezing Temps + 70% early hunt', () => {
      const arch = GHOST_ARCHETYPES.raffael_dzsenifer;
      assert.strictEqual(arch.name, 'Raffael Dzsenifer');
      assert.deepStrictEqual(arch.evidences.sort(), ['fingerprints', 'freezing_temperatures', 'ghost_writing'].sort());
      assert.strictEqual(arch.huntThreshold, 70);
      assert.strictEqual(arch.smudgeRoamDelay, 60);
    });

    it('A Keresztapa (Mimic): Spirit Box, Fingerprints, Freezing Temps + fake 4th evidence Ghost Orbs', () => {
      const arch = GHOST_ARCHETYPES.keresztapa;
      assert.strictEqual(arch.name, 'A Keresztapa');
      assert.deepStrictEqual(arch.evidences.sort(), ['fingerprints', 'freezing_temperatures', 'spirit_box'].sort());
      assert.strictEqual(arch.fakeEvidence, 'ghost_orbs');
      assert.strictEqual(arch.isMimic, true);

      // Verify that hasEvidence reports true for ghost_orbs due to mimic deception
      const ghost = createGhostAI('keresztapa');
      assert.strictEqual(ghost.hasEvidence('spirit_box'), true);
      assert.strictEqual(ghost.hasEvidence('fingerprints'), true);
      assert.strictEqual(ghost.hasEvidence('freezing_temperatures'), true);
      assert.strictEqual(ghost.hasEvidence('ghost_orbs'), true); // Fake 4th evidence!
      assert.strictEqual(ghost.hasEvidence('Szellemgömb'), true);
      assert.strictEqual(ghost.hasEvidence('dots'), false);
    });

    it('getArchetype should look up by English ID, Hungarian Name, and Role', () => {
      assert.strictEqual(getArchetype('lakatos_armando').id, 'lakatos_armando');
      assert.strictEqual(getArchetype('Lakatos Ármándó').id, 'lakatos_armando');
      assert.strictEqual(getArchetype('Poltergeist').id, 'lakatos_armando');
      assert.strictEqual(getArchetype('Démon').id, 'raffael_dzsenifer');
      assert.strictEqual(getArchetype('Mimic').id, 'keresztapa');
    });
  });

  describe('2. Factory & Favorite Room Setup', () => {
    it('creates ghost with correct initial state, coordinates, and favorite room', () => {
      const ghost = createGhostAI('bunko_lajos');
      assert.strictEqual(ghost.type.id, 'bunko_lajos');
      assert.strictEqual(ghost.state, GHOST_STATES.IDLE);
      assert.ok(ghost.favoriteRoom);
      assert.strictEqual(ghost.favoriteRoom.id, 'zone1_mazsahaz');
      assert.strictEqual(ghost.x, 5.0);
      assert.strictEqual(ghost.z, 8.0);
      assert.strictEqual(ghost.speed, 1.2);
      assert.strictEqual(ghost.visible, false);
    });
  });

  describe('3. Thermal Gradient & Sub-zero Temperature Evidence', () => {
    it('drops temperature below 0.0°C in favorite room for freezing ghost', () => {
      const freezingGhost = createGhostAI('kolompar_kalman'); // has freezing temps
      const tempInFavRoom = getGhostTemperature(freezingGhost, 5.0, 8.0, 'zone1_mazsahaz');
      assert.ok(tempInFavRoom < 0.0, `Expected sub-zero temp, got ${tempInFavRoom}°C`);
      assert.ok(tempInFavRoom >= -10.0 && tempInFavRoom <= -2.0);
    });

    it('keeps temperature above 0.0°C (2.0°C - 5.0°C) in favorite room for non-freezing ghost', () => {
      const warmGhost = createGhostAI('lakatos_armando'); // no freezing temps
      const tempInFavRoom = getGhostTemperature(warmGhost, 5.0, 8.0, 'zone1_mazsahaz');
      assert.ok(tempInFavRoom > 0.0, `Expected above zero temp, got ${tempInFavRoom}°C`);
      assert.ok(tempInFavRoom >= 2.0 && tempInFavRoom <= 5.0);
    });

    it('returns ambient baseline (~15°C) far away from ghost outside favorite room', () => {
      const ghost = createGhostAI('lakatos_armando');
      const tempFar = getGhostTemperature(ghost, 18.0, -5.0, 'zone2_roncsauto');
      assert.strictEqual(tempFar, 15.0);
    });
  });

  describe('4. Mobile Jesus (Crucifix) Defense Mechanism', () => {
    it('blocks hunt within 4m radius, burns charge from 2 to 1, emits cancel event', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.x = 5.0;
      ghost.z = 8.0;

      const events = [];
      const mockIo = {
        emit: (name, data) => events.push({ name, data }),
        to: () => mockIo
      };

      const jesusItem = {
        id: 'jesus_prop_1',
        type: 'mobile_jesus',
        x: 6.0,
        y: 0.0,
        z: 8.5, // Distance = sqrt(1^2 + 0.5^2) = 1.12m <= 4m
        charges: 2
      };

      const session = {
        roomId: 'test_room',
        players: [],
        droppedItems: [jesusItem],
        huntActive: false
      };

      // Trigger hunt initiation
      const result = triggerHunt(ghost, session, mockIo);

      // Hunt should be blocked!
      assert.strictEqual(result, false, 'Hunt should be blocked by Mobile Jesus');
      assert.strictEqual(jesusItem.charges, 1, 'Charges should decrease to 1');
      assert.strictEqual(jesusItem.charred, true, 'Item should be charred');
      assert.strictEqual(ghost.state, GHOST_STATES.POST_HUNT_COOLDOWN);
      assert.strictEqual(ghost.cooldownTimer, 25.0);

      // Verify emitted events
      const cancelEvt = events.find(e => e.name === 'phobia:hunt-cancelled');
      assert.ok(cancelEvt, 'phobia:hunt-cancelled must be emitted');
      assert.strictEqual(cancelEvt.data.reason, 'crucifix');
      assert.strictEqual(cancelEvt.data.chargesRemaining, 1);

      const burnEvt = events.find(e => e.name === 'phobia:jesus-burned');
      assert.ok(burnEvt, 'phobia:jesus-burned must be emitted');
      assert.strictEqual(burnEvt.data.chargesRemaining, 1);
    });

    it('second hunt burns final charge (1 -> 0) destroying crucifix', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.x = 5.0;
      ghost.z = 8.0;

      const mockIo = { emit: () => {}, to: () => mockIo };
      const jesusItem = {
        id: 'jesus_prop_1',
        type: 'mobile_jesus',
        x: 5.5,
        z: 8.0,
        charges: 1,
        charred: true
      };

      const session = {
        droppedItems: [jesusItem]
      };

      const blocked = checkCrucifixDefense(ghost, session, mockIo);
      assert.strictEqual(blocked, true);
      assert.strictEqual(jesusItem.charges, 0);
      assert.strictEqual(jesusItem.destroyed, true);

      // Third hunt cannot be blocked by destroyed crucifix!
      const blockedThird = checkCrucifixDefense(ghost, session, mockIo);
      assert.strictEqual(blockedThird, false, 'Destroyed crucifix cannot block a 3rd hunt');
    });

    it('does not block hunt if Mobile Jesus is beyond 4m (e.g. at van coordinates)', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.x = 5.0;
      ghost.z = 8.0;

      const mockIo = { emit: () => {}, to: () => mockIo };
      const distantJesus = {
        id: 'jesus_van',
        type: 'mobile_jesus',
        x: -4.0,
        z: -15.0, // distance > 20m
        charges: 2
      };

      const session = { droppedItems: [distantJesus] };
      const blocked = checkCrucifixDefense(ghost, session, mockIo);
      assert.strictEqual(blocked, false);
      assert.strictEqual(distantJesus.charges, 2);
    });
  });

  describe('5. Smudge Sticks Blinding & Hunt Delays', () => {
    it('blinds ghost for 5 seconds and resets chase target', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.targetPlayerId = 'player_1';

      const res = applySmudgeSticks(ghost, null, null, null);
      assert.strictEqual(res.blinded, true);
      assert.strictEqual(ghost.smudgeBlindedTimer, 5.0);
      assert.strictEqual(ghost.targetPlayerId, null);
      assert.strictEqual(res.roamDelay, 90);
    });

    it('Raffael Dzsenifer (Démon) receives only 60s roam delay instead of 90s', () => {
      const demon = createGhostAI('raffael_dzsenifer');
      const res = applySmudgeSticks(demon, null, null, null);
      assert.strictEqual(res.roamDelay, 60);
    });
  });

  describe('6. Sensory Perception (Line of Sight, Flashlights, Voice/Mic)', () => {
    it('detects flashlight within 12m even without line of sight', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.x = 0;
      ghost.z = 0;

      const playerFlashlight = {
        id: 'player_fl',
        x: 10.0, // 10m away (< 12m)
        z: 0.0,
        flashlightOn: true,
        speaking: false,
        alive: true
      };

      const session = { players: [playerFlashlight], huntActive: true };
      updateGhostAI(ghost, session, 83.33, null);

      assert.strictEqual(ghost.targetPlayerId, 'player_fl');
    });

    it('detects speaking mic within 8m', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.x = 0;
      ghost.z = 0;

      const playerVoice = {
        id: 'player_voice',
        x: 6.0, // 6m away (< 8m)
        z: 0.0,
        flashlightOn: false,
        speaking: true,
        audioLevel: 0.45,
        alive: true
      };

      const session = { players: [playerVoice], huntActive: true };
      updateGhostAI(ghost, session, 83.33, null);

      assert.strictEqual(ghost.targetPlayerId, 'player_voice');
    });
  });

  describe('7. Speed Acceleration & Kolompár Kálmán Modifier', () => {
    it('standard ghost accelerates from 1.7 m/s to 2.8 m/s under continuous LOS', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.huntDuration = 30.0;
      ghost.x = 0; ghost.z = 0;

      const player = { id: 'target_p', x: 15, z: 0, alive: true };
      const session = { players: [player], huntActive: true };

      // Initial speed
      assert.strictEqual(ghost.speed, 1.2); // Wander speed before chase start

      // Simulate 5 seconds of continuous LOS at 12 Hz with player staying ahead
      for (let i = 0; i < 60; i++) {
        player.x = ghost.x + 15;
        updateGhostAI(ghost, session, 83.33, null);
      }

      // Expected: min(2.8, 1.7 + 0.15 * 5.0) = 2.45 m/s
      assert.ok(ghost.speed >= 2.40 && ghost.speed <= 2.50, `Expected ~2.45 m/s, got ${ghost.speed}`);

      // Simulate 10 more seconds (total 15s) -> should clamp at 2.8 m/s max
      for (let i = 0; i < 120; i++) {
        player.x = ghost.x + 15;
        updateGhostAI(ghost, session, 83.33, null);
      }
      assert.strictEqual(Number(ghost.speed.toFixed(2)), 2.80);
    });

    it('Kolompár Kálmán accelerates from 2.2 m/s to 3.3 m/s in freezing room', () => {
      const ghost = createGhostAI('kolompar_kalman');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.huntDuration = 30.0;
      ghost.x = 0; ghost.z = 0;

      const player = { id: 'target_p', x: 15, z: 0, alive: true };
      const session = { players: [player], huntActive: true };

      // 10 seconds of LOS with player staying ahead
      for (let i = 0; i < 120; i++) {
        player.x = ghost.x + 15;
        updateGhostAI(ghost, session, 83.33, null);
      }

      // Kolompár Kálmán accelerates up to 3.3 m/s!
      assert.ok(ghost.speed > 2.8, `Expected Kolompár speed > 2.8 m/s, got ${ghost.speed}`);
      assert.ok(ghost.speed <= 3.3, `Expected Kolompár speed <= 3.3 m/s, got ${ghost.speed}`);
    });
  });

  describe('8. 8-State Transitions & Kill Sequence', () => {
    it('transitions HUNT_INITIATION -> ACTIVE_HUNT_CHASE after 3s grace period', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.HUNT_INITIATION;
      ghost.graceTimer = 3.0;

      const session = { players: [{ id: 'p1', x: 20, z: 20, alive: true }], huntActive: true };

      // Tick 2.0 seconds
      updateGhostAI(ghost, session, 2000, null);
      assert.strictEqual(ghost.state, GHOST_STATES.HUNT_INITIATION);

      // Tick 1.5 seconds (total 3.5s > 3.0s grace)
      updateGhostAI(ghost, session, 1500, null);
      assert.strictEqual(ghost.state, GHOST_STATES.ACTIVE_HUNT_CHASE);
      assert.strictEqual(ghost.visible, true);
    });

    it('triggers KILL_SEQUENCE when touching player (<= 0.8m), drops items, marks spectator', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.huntDuration = 25.0;
      ghost.x = 1.0; ghost.z = 1.0;

      const victim = {
        id: 'victim_1',
        x: 1.3, z: 1.2, // Distance = sqrt(0.3^2 + 0.2^2) = 0.36m <= 0.8m
        alive: true,
        inventory: [{ id: 'palinka_1', type: 'sanity_palinka' }]
      };

      const survivor = {
        id: 'survivor_2',
        x: 20.0, z: 20.0,
        alive: true,
        inventory: []
      };

      const events = [];
      const mockIo = {
        emit: (name, data) => events.push({ name, data }),
        to: () => mockIo
      };

      const session = {
        roomId: 'test_room',
        players: [victim, survivor],
        droppedItems: [],
        huntActive: true
      };

      // Tick
      updateGhostAI(ghost, session, 83.33, mockIo);

      assert.strictEqual(ghost.state, GHOST_STATES.KILL_SEQUENCE);
      assert.strictEqual(victim.alive, false);
      assert.strictEqual(victim.isSpectator, true);
      assert.strictEqual(victim.inventory.length, 0);
      assert.strictEqual(session.droppedItems.length, 1);
      assert.strictEqual(session.droppedItems[0].id, 'palinka_1');

      const killEvt = events.find(e => e.name === 'phobia:player-killed');
      assert.ok(killEvt);
      assert.strictEqual(killEvt.data.victimId, 'victim_1');

      // Tick kill timer (2.0s) -> should resume ACTIVE_HUNT_CHASE because survivor is still alive!
      updateGhostAI(ghost, session, 2100, mockIo);
      assert.strictEqual(ghost.state, GHOST_STATES.ACTIVE_HUNT_CHASE);
    });

    it('transitions to POST_HUNT_COOLDOWN (25s) when all players dead or hunt timer ends', () => {
      const ghost = createGhostAI('lakatos_armando');
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.huntDuration = 0.5;

      const session = { players: [{ id: 'p1', alive: true, x: 20, z: 20 }], huntActive: true };
      updateGhostAI(ghost, session, 1000, null); // 1.0s elapsed > 0.5s remaining

      assert.strictEqual(ghost.state, GHOST_STATES.POST_HUNT_COOLDOWN);
      assert.strictEqual(ghost.cooldownTimer, 25.0);
      assert.strictEqual(session.huntActive, false);

      // Fast forward 25s cooldown
      updateGhostAI(ghost, session, 26000, null);
      assert.strictEqual(ghost.state, GHOST_STATES.IDLE);
    });
  });

  describe('9. Poltergeist & Scrap Throwing Interactions', () => {
    it('Lakatos Ármándó throws 3-5 scrap items with high impulse force', () => {
      const poltergeist = createGhostAI('lakatos_armando');
      const events = [];
      const mockIo = { emit: (name, data) => events.push({ name, data }), to: () => mockIo };

      triggerInteraction(poltergeist, { roomId: 'test_room' }, mockIo, { id: 'pipe_1' });

      const thrown = events.find(e => e.name === 'phobia:item-thrown');
      assert.ok(thrown);
      assert.ok(thrown.data.thrownCount >= 3 && thrown.data.thrownCount <= 5);
      assert.ok(thrown.data.force >= 9.0 && thrown.data.force <= 15.0);

      const emf = events.find(e => e.name === 'phobia:emf-reading');
      assert.ok(emf);
      assert.strictEqual(emf.data.level, 5, 'Poltergeist with EMF 5 evidence must emit EMF 5');
    });
  });

  describe('10. Breaker Sabotage Probabilities', () => {
    it('Bunkó Lajos has 40% breaker sabotage probability override', () => {
      const bunko = createGhostAI('bunko_lajos');
      assert.strictEqual(bunko.type.breakerSabotageProb, 0.40);
    });
  });
});
