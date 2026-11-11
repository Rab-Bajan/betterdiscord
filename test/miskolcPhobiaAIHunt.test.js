const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  createGhostAI,
  updateGhostAI,
  triggerGhostEvent,
  triggerInteraction,
  pickActiveEvidence,
  GHOST_STATES,
  GHOST_ARCHETYPES
} = require('../miskolcPhobiaAI');

// Small deterministic PRNG (mulberry32)
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSession(players, extra = {}) {
  const events = [];
  return {
    players,
    huntActive: true,
    broadcast: (name, data) => events.push({ name, data }),
    events,
    ...extra
  };
}

function chasingGhost(type = 'lakatos_armando', rng = seeded(1)) {
  const ghost = createGhostAI(type, null, { rng });
  ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
  ghost.huntDuration = 120;
  ghost.x = 0;
  ghost.z = 0;
  return ghost;
}

const TICK = 1000 / 12;

describe('pickActiveEvidence', () => {
  const list = ['a', 'b', 'c'];

  it('returns the requested number of distinct items from the input, without mutating it', () => {
    for (let n = 0; n <= 3; n++) {
      const copy = list.slice();
      const out = pickActiveEvidence(copy, n, seeded(n + 7));
      assert.strictEqual(out.length, n);
      assert.strictEqual(new Set(out).size, n);
      out.forEach((x) => assert.ok(list.includes(x)));
      assert.deepStrictEqual(copy, list);
    }
  });

  it('clamps count and is deterministic for a given seed but varies across seeds', () => {
    assert.strictEqual(pickActiveEvidence(list, 9, seeded(1)).length, 3);
    assert.strictEqual(pickActiveEvidence(list, -2, seeded(1)).length, 0);
    assert.deepStrictEqual(pickActiveEvidence(list, 2, seeded(5)), pickActiveEvidence(list, 2, seeded(5)));
    const seen = new Set();
    for (let s = 1; s < 40; s++) seen.add(pickActiveEvidence(list, 2, seeded(s)).join(','));
    assert.ok(seen.size > 3, 'subsets should vary across seeds');
  });

  it('createGhostAI exposes activeEvidence and hasEvidence honours it', () => {
    const ghost = createGhostAI('lakatos_armando', null, { evidenceCount: 2, rng: seeded(3) });
    assert.strictEqual(ghost.activeEvidence.length, 2);
    const all = GHOST_ARCHETYPES.lakatos_armando.evidences;
    const active = all.filter((e) => ghost.hasEvidence(e));
    assert.deepStrictEqual(active.sort(), ghost.activeEvidence.slice().sort());
    assert.strictEqual(createGhostAI('lakatos_armando').activeEvidence.length, 3);
    assert.strictEqual(createGhostAI('lakatos_armando', null, { evidenceCount: 0 }).hasEvidence('emf_5'), false);
  });

  it('Mimic fake orb stays an extra evidence even with zero real evidence', () => {
    const mimic = createGhostAI('keresztapa', null, { evidenceCount: 0 });
    assert.strictEqual(mimic.activeEvidence.length, 0);
    assert.strictEqual(mimic.hasEvidence('ghost_orbs'), true);
    assert.strictEqual(mimic.hasEvidence('spirit_box'), false);
  });
});

describe('hunt targeting of hidden players', () => {
  it('ignores a silent hidden player the ghost did not see enter', () => {
    const ghost = chasingGhost();
    const p = { id: 'p1', x: 3, z: 0, alive: true, hidingSpotId: 'locker_1' };
    const session = makeSession([p]);
    for (let i = 0; i < 120; i++) updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(ghost.targetPlayerId, null);
    assert.strictEqual(p.alive, true);
  });

  it('targets a hidden player who speaks within 5 m but not at 7 m', () => {
    const near = { id: 'n', x: 4, z: 0, alive: true, hidingSpotId: 's', isSpeaking: true };
    const ghost = chasingGhost();
    updateGhostAI(ghost, makeSession([near]), TICK, null);
    assert.strictEqual(ghost.targetPlayerId, 'n');

    const far = { id: 'f', x: 7, z: 0, alive: true, hidingSpotId: 's', isSpeaking: true };
    const ghost2 = chasingGhost();
    updateGhostAI(ghost2, makeSession([far]), TICK, null);
    assert.strictEqual(ghost2.targetPlayerId, null);
  });

  it('sets seenEnteringHide only when the ghost had line of sight while hunting', () => {
    const seen = { id: 'a', x: 6, z: 0, alive: true };
    const unseen = { id: 'b', x: 6, z: 1, alive: true, noLOS: true };
    const ghost = chasingGhost();
    const session = makeSession([seen, unseen]);
    updateGhostAI(ghost, session, TICK, null);
    seen.hidingSpotId = 'locker_1';
    unseen.hidingSpotId = 'locker_2';
    updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(seen.seenEnteringHide, true);
    assert.strictEqual(unseen.seenEnteringHide, false);
    seen.hidingSpotId = null;
    updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(seen.seenEnteringHide, false);
  });

  it('a ghost that saw you hide searches the spot and usually leaves without killing', () => {
    const ghost = chasingGhost('lakatos_armando', () => 0.999); // never finds
    const p = { id: 'p1', x: 8, z: 0, alive: true, hidingSpotId: 'locker_1', seenEnteringHide: true };
    const session = makeSession([p]);
    let searched = false;
    for (let i = 0; i < 12 * 20; i++) {
      updateGhostAI(ghost, session, TICK, null);
      if (ghost.spotSearch) searched = true;
    }
    assert.ok(searched, 'ghost should search the spot');
    assert.strictEqual(p.alive, true);
    assert.strictEqual(p.seenEnteringHide, false);
    assert.strictEqual(ghost.targetPlayerId, null);
  });

  it('a lucky search finds the hidden player (rng forced low)', () => {
    const ghost = chasingGhost('lakatos_armando', () => 0);
    const p = { id: 'p1', x: 8, z: 0, alive: true, hidingSpotId: 'locker_1', seenEnteringHide: true };
    const session = makeSession([p]);
    for (let i = 0; i < 12 * 10 && p.alive; i++) updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(p.alive, false);
  });
});

describe('last-known-position pursuit and local search', () => {
  it('walks to the last known position, searches nearby, then roams on', () => {
    const ghost = chasingGhost('lakatos_armando', seeded(11));
    const p = { id: 'p1', x: 10, z: 0, alive: true };
    const session = makeSession([p]);
    updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(ghost.targetPlayerId, 'p1');
    assert.deepStrictEqual(ghost.lastKnownPos, { x: 10, z: 0 });

    // Player vanishes far away behind cover (beyond sight, silent)
    p.x = 60;
    p.z = 60;
    const lkp = { ...ghost.lastKnownPos };
    updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(ghost.targetPlayerId, null);

    let phase = null;
    let reachedLkp = false;
    const phases = new Set();
    for (let i = 0; i < 12 * 30; i++) {
      updateGhostAI(ghost, session, TICK, null);
      if (ghost.searchPhase === 'search') {
        reachedLkp = true;
        assert.ok(Math.hypot(ghost.x - lkp.x, ghost.z - lkp.z) <= 8, 'search stays near the last known position');
      }
      phases.add(ghost.searchPhase);
      phase = ghost.searchPhase;
    }
    assert.ok(reachedLkp, 'ghost reached the last known position and searched');
    assert.ok(phases.has('roam'));
    assert.strictEqual(phase, 'roam');
    assert.strictEqual(ghost.lastKnownPos, null);
  });

  it('re-acquires the player when they speak nearby during the search', () => {
    const ghost = chasingGhost('lakatos_armando', seeded(2));
    ghost.lastKnownPos = { x: 2, z: 0 };
    const p = { id: 'p1', x: 40, z: 0, alive: true };
    const session = makeSession([p]);
    for (let i = 0; i < 60; i++) updateGhostAI(ghost, session, TICK, null);
    p.x = ghost.x + 6;
    p.z = ghost.z;
    p.isSpeaking = true;
    updateGhostAI(ghost, session, TICK, null);
    assert.strictEqual(ghost.targetPlayerId, 'p1');
  });
});

describe('roaming, interactions and events', () => {
  it('always returns to the favourite room after an excursion', () => {
    const ghost = createGhostAI('kolompar_kalman', null, { rng: seeded(4) });
    const fav = ghost.favoriteRoom;
    let wentAway = 0;
    for (let i = 0; i < 40; i++) {
      const wasAway = ghost.awayFromFav;
      // Drive the private waypoint picker through the public tick
      ghost.state = GHOST_STATES.WANDER;
      ghost.stateTimer = 100;
      ghost.navTarget = { x: ghost.x, z: ghost.z };
      updateGhostAI(ghost, makeSession([{ id: 'p', x: 500, z: 500, alive: true, sanity: 100 }]), TICK, null);
      if (ghost.awayFromFav) wentAway++;
      if (wasAway) {
        assert.ok(Math.abs(ghost.navTarget.x - fav.x) <= 2 && Math.abs(ghost.navTarget.z - fav.z) <= 2,
          'next waypoint after an excursion is in the favourite room');
        assert.strictEqual(ghost.awayFromFav, false);
      }
    }
    assert.ok(wentAway > 0, 'the ghost should sometimes roam away');
  });

  it('interacts with props, doors and lights near the nearby player, not far ones', () => {
    const session = makeSession([{ id: 'p1', x: 5, z: 8, alive: true, isSpeaking: true }], {
      huntActive: false,
      doors: {
        door_near: { id: 'door_near', x: 6, z: 9, open: false, angle: 0 },
        door_far: { id: 'door_far', x: 200, z: 200, open: false, angle: 0 },
        door_mazsahaz_locker_1: { id: 'door_mazsahaz_locker_1', x: 5, z: 8, open: false, angle: 0 }
      },
      lights: {
        light_near: { id: 'light_near', x: 5, z: 8, state: true, shattered: false },
        light_far: { id: 'light_far', x: 300, z: 300, state: true, shattered: false }
      },
      scrapProps: [
        { id: 'prop_near', type: 'scrap_pipe', x: 5.5, y: 0.1, z: 8.5 },
        { id: 'prop_far', type: 'scrap_can', x: 150, y: 0.1, z: 150 }
      ]
    });
    const kinds = new Set();
    for (let i = 0; i < 60; i++) {
      const ghost = createGhostAI('lakatos_armando', null, { rng: seeded(100 + i) });
      ghost.x = 5;
      ghost.z = 8;
      session.events.length = 0;
      triggerInteraction(ghost, session, null, null);
      for (const e of session.events) {
        if (e.name === 'phobia:door-updated') { kinds.add('door'); assert.strictEqual(e.data.doorId, 'door_near'); }
        if (e.name === 'phobia:light-updated') { kinds.add('light'); assert.strictEqual(e.data.lightId, 'light_near'); }
        if (e.name === 'phobia:item-thrown') { kinds.add('throw'); assert.strictEqual(e.data.itemId, 'prop_near'); }
      }
    }
    assert.ok(kinds.size >= 2, `expected a mix of interactions, got ${[...kinds]}`);
    assert.strictEqual(session.doors.door_mazsahaz_locker_1.open, false, 'hiding-spot doors are never driven');
  });

  it('produces varied ghost events and archetype specific ones', () => {
    const types = new Set();
    for (let i = 0; i < 80; i++) {
      const ghost = createGhostAI('rostas_bela', null, { rng: seeded(i + 1) });
      const session = makeSession([{ id: 'p', x: 5, z: 8, alive: true, sanity: 100 }]);
      triggerGhostEvent(ghost, session, null);
      const ev = session.events.find((e) => e.name === 'phobia:ghost-event');
      assert.ok(ev);
      assert.deepStrictEqual(ev.data.witnessIds, ['p']);
      types.add(ev.data.type);
    }
    assert.ok(types.size >= 3, `expected varied events, got ${[...types]}`);
    assert.ok(types.has('scream'));
  });
});
