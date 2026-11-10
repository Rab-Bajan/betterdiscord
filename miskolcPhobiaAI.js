/**
 * MiskolcPhobia Ghost AI Simulation Engine
 * Authoritative 12 Hz Server-side State Machine & Perception System
 *
 * Implements 8 States:
 *  1. IDLE
 *  2. WANDER (or WANDERING)
 *  3. INTERACTION
 *  4. GHOST_EVENT
 *  5. HUNT_INITIATION
 *  6. ACTIVE_HUNT_CHASE
 *  7. KILL_SEQUENCE
 *  8. POST_HUNT_COOLDOWN
 *
 * 7 Miskolc Folklore Archetypes with authentic evidence matrix & mechanics:
 *  - Lakatos Ármándó (Poltergeist): Ghost Writing, Spirit Box, EMF 5. Multi-item throw.
 *  - Kolompár Kálmán (Bicskás Vadász): Freezing Temps, Fingerprints, D.O.T.S. Speed boost in freezing zones.
 *  - Rostás "Flexes" Béla (Hangoskodó): EMF 5, Fingerprints, Ghost Orbs. Shatters bulbs, loud audio screams.
 *  - Bunkó Lajos (Fagyos Rezes): Freezing Temps, Ghost Writing, Spirit Box. 40% breaker sabotage probability.
 *  - Sárközi "Lókupec" Géza (Csendes Árnyék): D.O.T.S., Ghost Orbs, Freezing Temps. High shyness when players group.
 *  - Raffael Dzsenifer (Démon): Fingerprints, Ghost Writing, Freezing Temps. Early hunt at 70% average sanity.
 *  - A Keresztapa (Mimic): Spirit Box, Fingerprints, Freezing Temps PLUS fake 4th evidence Ghost Orbs.
 *
 * Mobile Jesus (Crucifix) defense mechanism:
 *  - Within 4m radius of ghost: cancels hunt, burns charge, 2 charges before destruction.
 */

// ---------------------------------------------------------------------------
// 1. CONSTANTS & ENUMS
// ---------------------------------------------------------------------------

const GHOST_STATES = Object.freeze({
  IDLE: 'IDLE',
  WANDER: 'WANDERING',
  WANDERING: 'WANDERING',
  INTERACTION: 'INTERACTION',
  GHOST_EVENT: 'GHOST_EVENT',
  HUNT_INITIATION: 'HUNT_INITIATION',
  ACTIVE_HUNT_CHASE: 'ACTIVE_HUNT_CHASE',
  KILL_SEQUENCE: 'KILL_SEQUENCE',
  POST_HUNT_COOLDOWN: 'POST_HUNT_COOLDOWN'
});

const EVIDENCES = Object.freeze({
  EMF_5: { id: 'emf_5', name: 'EMF 5', hungarian: 'EMF 5' },
  SPIRIT_BOX: { id: 'spirit_box', name: 'Spirit Box', hungarian: 'Spirit Box' },
  FINGERPRINTS: { id: 'fingerprints', name: 'Fingerprints', hungarian: 'UV Ujjlenyomat' },
  FREEZING_TEMPS: { id: 'freezing_temperatures', name: 'Freezing Temperatures', hungarian: 'Fagypont Alatt' },
  GHOST_WRITING: { id: 'ghost_writing', name: 'Ghost Writing', hungarian: 'Szellemírás' },
  GHOST_ORBS: { id: 'ghost_orbs', name: 'Ghost Orbs', hungarian: 'Szellemgömb' },
  DOTS: { id: 'dots', name: 'D.O.T.S.', hungarian: 'D.O.T.S.' }
});

const GHOST_ARCHETYPES = Object.freeze({
  lakatos_armando: {
    id: 'lakatos_armando',
    name: 'Lakatos Ármándó',
    role: 'A Poltergeist',
    englishRole: 'Poltergeist',
    evidences: ['ghost_writing', 'spirit_box', 'emf_5'],
    hungarianEvidences: ['Szellemírás', 'Spirit Box', 'EMF 5'],
    huntThreshold: 50,
    multiThrow: true,
    throwItemCountMin: 3,
    throwItemCountMax: 5,
    throwForceMin: 9.0,
    throwForceMax: 15.0,
    breakerSabotageProb: 0.15,
    description: 'Poltergeist archetype. Throws multiple scrap items at once with violent force.'
  },
  kolompar_kalman: {
    id: 'kolompar_kalman',
    name: 'Kolompár Kálmán',
    role: 'A Bicskás Vadász',
    englishRole: 'Bicskás Vadász',
    evidences: ['freezing_temperatures', 'fingerprints', 'dots'],
    hungarianEvidences: ['Fagypont Alatt', 'UV Ujjlenyomat', 'D.O.T.S.'],
    huntThreshold: 50,
    freezingSpeedBoost: true,
    baseSpeed: 1.7,
    maxSpeed: 2.8,
    freezingBaseSpeed: 2.2,
    freezingMaxSpeed: 3.3,
    breakerSabotageProb: 0.15,
    description: 'Fast, relentless hunter. Gains significant speed boost in freezing zones.'
  },
  rostas_bela: {
    id: 'rostas_bela',
    name: 'Rostás "Flexes" Béla',
    role: 'A Hangoskodó',
    englishRole: 'Hangoskodó',
    evidences: ['emf_5', 'fingerprints', 'ghost_orbs'],
    hungarianEvidences: ['EMF 5', 'UV Ujjlenyomat', 'Szellemgömb'],
    huntThreshold: 50,
    bulbShatterChance: 0.50,
    spiritBoxScream: true,
    screams: ['A VASAT AKAROM!', 'FLEXET NEKEM!', 'KIKAPCSOLOM A GENERÁTORT!'],
    breakerSabotageProb: 0.15,
    description: 'Loud screamer over audio channels; frequently shatters lightbulbs.'
  },
  bunko_lajos: {
    id: 'bunko_lajos',
    name: 'Bunkó Lajos',
    role: 'A Fagyos Rezes',
    englishRole: 'Fagyos Rezes',
    evidences: ['freezing_temperatures', 'ghost_writing', 'spirit_box'],
    hungarianEvidences: ['Fagypont Alatt', 'Szellemírás', 'Spirit Box'],
    huntThreshold: 50,
    breakerSabotageProb: 0.40,
    description: 'Breaker saboteur with 40% switch sabotage probability, leaves frosty traces.'
  },
  sarkozi_geza: {
    id: 'sarkozi_geza',
    name: 'Sárközi "Lókupec" Géza',
    role: 'A Csendes Árnyék',
    englishRole: 'Csendes Árnyék',
    evidences: ['dots', 'ghost_orbs', 'freezing_temperatures'],
    hungarianEvidences: ['D.O.T.S.', 'Szellemgömb', 'Fagypont Alatt'],
    huntThreshold: 50,
    shyness: true,
    shynessDropPercent: 0.80,
    breakerSabotageProb: 0.15,
    description: 'Extremely shy shadow. Activity drops by 80% if more than 1 player is in the room.'
  },
  raffael_dzsenifer: {
    id: 'raffael_dzsenifer',
    name: 'Raffael Dzsenifer',
    role: 'A Démon',
    englishRole: 'Démon',
    evidences: ['fingerprints', 'ghost_writing', 'freezing_temperatures'],
    hungarianEvidences: ['UV Ujjlenyomat', 'Szellemírás', 'Fagypont Alatt'],
    huntThreshold: 70, // Early hunter at 70% sanity!
    smudgeRoamDelay: 60, // 60s instead of 90s
    breakerSabotageProb: 0.15,
    description: 'Relentless early hunter starting at 70% team sanity. Smudge sticks only delay her for 60s.'
  },
  keresztapa: {
    id: 'keresztapa',
    name: 'A Keresztapa',
    role: 'A Mimic',
    englishRole: 'The Mimic',
    evidences: ['spirit_box', 'fingerprints', 'freezing_temperatures'],
    hungarianEvidences: ['Spirit Box', 'UV Ujjlenyomat', 'Fagypont Alatt'],
    fakeEvidence: 'ghost_orbs',
    fakeHungarianEvidence: 'Szellemgömb',
    isMimic: true,
    huntThreshold: 50,
    breakerSabotageProb: 0.15,
    description: 'The Great Deceiver. Always presents fake Ghost Orbs as a 4th evidence.'
  }
});

const DEFAULT_ZONES = Object.freeze({
  zone1_mazsahaz: {
    id: 'zone1_mazsahaz',
    name: 'Zone 1: Mázsaház',
    hungarian: 'Mázsaház (Mérlegház és Iroda)',
    x: 5, y: 0, z: 8,
    bounds: { minX: 0, maxX: 12, minZ: 3, maxZ: 14 },
    hasBreaker: true
  },
  zone2_roncsauto: {
    id: 'zone2_roncsauto',
    name: 'Zone 2: Roncsautó Domb',
    hungarian: 'Roncsautó Domb',
    x: 18, y: 0, z: -5,
    bounds: { minX: 12, maxX: 26, minZ: -12, maxZ: 2 }
  },
  zone3_nagyhangar: {
    id: 'zone3_nagyhangar',
    name: 'Zone 3: Nagy Hangár',
    hungarian: 'Nagy Hangár',
    x: -15, y: 0, z: 10,
    bounds: { minX: -24, maxX: -6, minZ: 2, maxZ: 18 }
  },
  zone4_kutyatelep: {
    id: 'zone4_kutyatelep',
    name: 'Zone 4: Kutyatelep & Sufni',
    hungarian: 'Kutyatelep & Sufni',
    x: -14, y: 0, z: -10,
    bounds: { minX: -22, maxX: -4, minZ: -18, maxZ: -2 }
  },
  zone5_ocskavas: {
    id: 'zone5_ocskavas',
    name: 'Zone 5: Ócskavas Lerakat',
    hungarian: 'Ócskavas Lerakat',
    x: 6, y: 0, z: -15,
    bounds: { minX: -2, maxX: 16, minZ: -24, maxZ: -6 }
  }
});

// ---------------------------------------------------------------------------
// 2. HELPER UTILITIES
// ---------------------------------------------------------------------------

function getCoords(obj) {
  if (!obj) return { x: 0, y: 0, z: 0 };
  // A live x/z (the ghost's authoritative position) wins over a stale initial position array
  if (typeof obj.x === 'number' && typeof obj.z === 'number') {
    return { x: obj.x, y: typeof obj.y === 'number' ? obj.y : 0, z: obj.z };
  }
  if (Array.isArray(obj.position)) {
    return {
      x: typeof obj.position[0] === 'number' ? obj.position[0] : 0,
      y: typeof obj.position[1] === 'number' ? obj.position[1] : 0,
      z: typeof obj.position[2] === 'number' ? obj.position[2] : 0
    };
  }
  if (Array.isArray(obj.pos)) {
    return {
      x: typeof obj.pos[0] === 'number' ? obj.pos[0] : 0,
      y: typeof obj.pos[1] === 'number' ? obj.pos[1] : 0,
      z: typeof obj.pos[2] === 'number' ? obj.pos[2] : 0
    };
  }
  if (Array.isArray(obj)) {
    return {
      x: typeof obj[0] === 'number' ? obj[0] : 0,
      y: typeof obj[1] === 'number' ? obj[1] : 0,
      z: typeof obj[2] === 'number' ? obj[2] : 0
    };
  }
  return {
    x: typeof obj.x === 'number' ? obj.x : 0,
    y: typeof obj.y === 'number' ? obj.y : 0,
    z: typeof obj.z === 'number' ? obj.z : 0
  };
}

function distance2D(a, b) {
  if (!a || !b) return 9999;
  const ca = getCoords(a);
  const cb = getCoords(b);
  const dx = ca.x - cb.x;
  const dz = ca.z - cb.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function distance3D(a, b) {
  if (!a || !b) return 9999;
  const ca = getCoords(a);
  const cb = getCoords(b);
  const dx = ca.x - cb.x;
  const dy = ca.y - cb.y;
  const dz = ca.z - cb.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function getLivingPlayers(session) {
  if (!session || !session.players) return [];
  let list = [];
  if (session.players instanceof Map) {
    list = Array.from(session.players.values());
  } else if (Array.isArray(session.players)) {
    list = session.players;
  } else if (typeof session.players === 'object') {
    list = Object.values(session.players);
  }
  return list.filter(p => p && p.alive !== false);
}

function getTeamAverageSanity(session) {
  const living = getLivingPlayers(session);
  if (living.length === 0) return 100;
  const sum = living.reduce((acc, p) => acc + (typeof p.sanity === 'number' ? p.sanity : 100), 0);
  return sum / living.length;
}

function emitSessionEvent(io, session, eventName, payload) {
  if (session && typeof session.broadcast === 'function') {
    session.broadcast(eventName, payload);
  } else if (io) {
    const targetRoom = session?.roomId || session?.id;
    // Nincs globális io.emit tartalék: szoba nélkül az esemény elvész
    if (targetRoom && typeof io.to === 'function') {
      io.to(targetRoom).emit(eventName, payload);
    }
  }
}

function getArchetype(identifier) {
  if (!identifier) return null;
  const idLower = String(identifier).toLowerCase().trim();

  for (const key of Object.keys(GHOST_ARCHETYPES)) {
    const arch = GHOST_ARCHETYPES[key];
    if (
      arch.id.toLowerCase() === idLower ||
      arch.name.toLowerCase() === idLower ||
      arch.role.toLowerCase() === idLower ||
      arch.englishRole.toLowerCase() === idLower ||
      arch.name.toLowerCase().includes(idLower) ||
      arch.role.toLowerCase().includes(idLower) ||
      arch.englishRole.toLowerCase().includes(idLower)
    ) {
      return arch;
    }
  }
  return null;
}

function getEvidenceList() {
  return Object.values(EVIDENCES);
}

function isFreezingZone(ghost) {
  if (!ghost) return false;
  return ghost.hasEvidence('freezing_temperatures');
}

// ---------------------------------------------------------------------------
// 3. FACTORY: createGhostAI
// ---------------------------------------------------------------------------

function createGhostAI(type, roomCoordinates) {
  let archetype = null;
  if (type) {
    if (typeof type === 'object' && type.id && type.evidences) {
      archetype = type;
    } else {
      archetype = getArchetype(type);
    }
  }
  if (!archetype) {
    const keys = Object.keys(GHOST_ARCHETYPES);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    archetype = GHOST_ARCHETYPES[randomKey];
  }

  let favoriteRoom = null;
  let zones = DEFAULT_ZONES;

  if (roomCoordinates && typeof roomCoordinates.x === 'number' && typeof roomCoordinates.z === 'number') {
    favoriteRoom = {
      id: roomCoordinates.id || 'zone1_mazsahaz',
      name: roomCoordinates.name || 'Mázsaház',
      x: roomCoordinates.x,
      y: typeof roomCoordinates.y === 'number' ? roomCoordinates.y : 0.0,
      z: roomCoordinates.z
    };
    zones = (roomCoordinates.zones && typeof roomCoordinates.zones === 'object') ? roomCoordinates.zones : DEFAULT_ZONES;
  } else if (roomCoordinates && typeof roomCoordinates === 'object') {
    zones = roomCoordinates;
    const zoneKeys = Object.keys(zones);
    const favoriteKey = zones.zone1_mazsahaz ? 'zone1_mazsahaz' : zoneKeys[Math.floor(Math.random() * zoneKeys.length)];
    favoriteRoom = zones[favoriteKey];
  } else {
    favoriteRoom = DEFAULT_ZONES.zone1_mazsahaz;
  }

  const initX = (favoriteRoom && typeof favoriteRoom.x === 'number')
    ? favoriteRoom.x
    : ((roomCoordinates && typeof roomCoordinates.x === 'number') ? roomCoordinates.x : 5.0);
  const initY = (favoriteRoom && typeof favoriteRoom.y === 'number')
    ? favoriteRoom.y
    : ((roomCoordinates && typeof roomCoordinates.y === 'number') ? roomCoordinates.y : 0.0);
  const initZ = (favoriteRoom && typeof favoriteRoom.z === 'number')
    ? favoriteRoom.z
    : ((roomCoordinates && typeof roomCoordinates.z === 'number') ? roomCoordinates.z : 8.0);

  const ghost = {
    id: 'ghost_' + Math.random().toString(36).substring(2, 9),
    type: archetype,
    state: GHOST_STATES.IDLE,
    stateTimer: 3.0 + Math.random() * 5.0, // 3-8s
    favoriteRoom: favoriteRoom,
    currentRoomId: favoriteRoom ? favoriteRoom.id : 'zone1_mazsahaz',
    x: initX,
    y: initY,
    z: initZ,
    rot: 0.0,
    speed: 1.2,
    baseSpeed: 1.7,
    maxSpeed: 2.8,
    visible: false,
    targetPlayerId: null,
    losTime: 0.0,
    hasLOS: false,
    huntDuration: 0.0,
    huntMaxDuration: 35.0, // Standard 35s hunt
    graceTimer: 0.0,
    cooldownTimer: 0.0,
    eventTimer: 0.0,
    killTimer: 0.0,
    smudgeBlindedTimer: 0.0,
    huntBlockedBySmudgeUntil: 0,
    breakerSabotageCooldown: 10.0 + Math.random() * 5.0,
    lastHuntRollTime: 0,
    navTarget: { x: initX, y: initY, z: initZ },
    zones: zones,

    hasEvidence(evidenceId) {
      if (!this.type || !this.type.evidences) return false;
      const key = String(evidenceId).toLowerCase();
      const direct = this.type.evidences.some(e => e.toLowerCase() === key);
      if (direct) return true;
      if (this.type.isMimic && (key === 'ghost_orbs' || key === 'szellemgömb' || key === 'szellemgomb')) {
        return true;
      }
      return false;
    }
  };

  return ghost;
}

// ---------------------------------------------------------------------------
// 4. THERMAL ENGINE & TEMPERATURE GRADIENT
// ---------------------------------------------------------------------------

function calculateRoomTemperature(ghost, roomOrZone, pos) {
  const baselineYardTemp = 15.0; // 14.0°C - 18.0°C
  const hasFreezing = isFreezingZone(ghost);

  // Check if target is inside or near favorite room
  const favZone = ghost?.favoriteRoom || DEFAULT_ZONES.zone1_mazsahaz;
  const isTargetFavZone = (roomOrZone && roomOrZone.id === favZone.id) ||
    (typeof roomOrZone === 'string' && (roomOrZone === favZone.id || roomOrZone.includes('mazsahaz')));

  let dToFav = 999;
  if (pos) {
    dToFav = distance2D(pos, favZone);
  }

  const dToGhost = pos ? distance2D(pos, ghost) : 999;
  const inFavRoom = isTargetFavZone || dToFav <= 6.0;

  if (inFavRoom) {
    if (hasFreezing) {
      // Favorite room ambient sub-zero gradient: -2.0°C to -10.0°C
      let temp = -3.5;
      if (dToGhost < 6.0) {
        temp -= (1.0 - dToGhost / 6.0) * 5.0;
      }
      return Number(temp.toFixed(1));
    } else {
      // Favorite room non-freezing ambient: 2.0°C to 5.0°C
      let temp = 3.5;
      if (dToGhost < 6.0) {
        temp -= (1.0 - dToGhost / 6.0) * 1.5;
      }
      return Number(temp.toFixed(1));
    }
  }

  // Outside favorite room
  if (dToGhost < 6.0) {
    const deltaT = hasFreezing ? 18.0 : 8.0;
    const temp = baselineYardTemp - deltaT * (1.0 - dToGhost / 6.0);
    return Number(temp.toFixed(1));
  }

  return Number(baselineYardTemp.toFixed(1));
}

function getGhostTemperature(ghost, x, z, zoneId) {
  const pos = (typeof x === 'number' && typeof z === 'number') ? { x, z } : null;
  const zone = zoneId ? (ghost?.zones?.[zoneId] || { id: zoneId }) : null;
  return calculateRoomTemperature(ghost, zone, pos);
}

// ---------------------------------------------------------------------------
// 5. MOBILE JESUS (CRUCIFIX) DEFENSE
// ---------------------------------------------------------------------------

function checkCrucifixDefense(ghost, session, io) {
  if (!ghost) return false;

  const crucifixRadius = 4.0; // Exactly 4.0m aura
  let defendingJesus = null;

  // 1. Check carried items by living players
  const living = getLivingPlayers(session);
  for (const player of living) {
    let px = 0;
    let pz = 0;
    if (Array.isArray(player.position) && player.position.length >= 3) {
      px = typeof player.position[0] === 'number' ? player.position[0] : 0;
      pz = typeof player.position[2] === 'number' ? player.position[2] : 0;
    } else if (Array.isArray(player.pos) && player.pos.length >= 3) {
      px = typeof player.pos[0] === 'number' ? player.pos[0] : 0;
      pz = typeof player.pos[2] === 'number' ? player.pos[2] : 0;
    } else if (typeof player.x === 'number' || typeof player.z === 'number') {
      px = player.x || 0;
      pz = player.z || 0;
    } else {
      const coords = getCoords(player);
      px = coords.x;
      pz = coords.z;
    }

    const gx = typeof ghost.x === 'number' ? ghost.x : (Array.isArray(ghost.position) ? ghost.position[0] : 0);
    const gz = typeof ghost.z === 'number' ? ghost.z : (Array.isArray(ghost.position) ? ghost.position[2] : 0);
    const dist = Math.sqrt((px - gx) * (px - gx) + (pz - gz) * (pz - gz));

    if (dist <= crucifixRadius) {
      // Check held item or inventory
      const held = player.heldItem;
      if (held && (held.type === 'mobile_jesus' || held.id?.includes('jesus'))) {
        const charges = (typeof held.charges === 'number') ? held.charges : 2;
        if (charges > 0 && !held.destroyed) {
          defendingJesus = held;
          break;
        }
      }
      if (!defendingJesus && Array.isArray(player.inventory)) {
        for (const item of player.inventory) {
          if (item && (item.type === 'mobile_jesus' || item.id?.includes('jesus'))) {
            const charges = (typeof item.charges === 'number') ? item.charges : 2;
            if (charges > 0 && !item.destroyed) {
              defendingJesus = item;
              break;
            }
          }
        }
      }
      if (defendingJesus) break;
    }
  }

  // 2. Check dropped items / ground props
  if (!defendingJesus && session) {
    const groundItems = session.droppedItems || session.items || [];
    for (const item of groundItems) {
      if (item && (item.type === 'mobile_jesus' || item.id?.includes('jesus'))) {
        const charges = (typeof item.charges === 'number') ? item.charges : 2;
        if (charges > 0 && !item.destroyed && distance2D(item, ghost) <= crucifixRadius) {
          defendingJesus = item;
          break;
        }
      }
    }
  }

  if (defendingJesus) {
    const currentCharges = (typeof defendingJesus.charges === 'number') ? defendingJesus.charges : 2;
    const chargesRemaining = Math.max(0, currentCharges - 1);
    defendingJesus.charges = chargesRemaining;

    if (chargesRemaining === 1) {
      defendingJesus.charred = true;
    } else if (chargesRemaining <= 0) {
      defendingJesus.charred = true;
      defendingJesus.destroyed = true;
    }

    // Cancel hunt immediately!
    ghost.state = GHOST_STATES.POST_HUNT_COOLDOWN;
    ghost.cooldownTimer = 25.0; // 25s cooldown
    ghost.visible = false;
    ghost.speed = 1.2;
    ghost.targetPlayerId = null;
    if (session) {
      session.huntActive = false;
    }

    const payload = {
      reason: 'crucifix',
      chargesRemaining: chargesRemaining,
      jesusId: defendingJesus.id || 'mobile_jesus_1'
    };

    emitSessionEvent(io, session, 'phobia:hunt-cancelled', payload);
    emitSessionEvent(io, session, 'phobia:jesus-burned', {
      jesusId: defendingJesus.id || 'mobile_jesus_1',
      chargesRemaining: chargesRemaining
    });

    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 6. SMUDGE STICKS BLINDING LOGIC
// ---------------------------------------------------------------------------

function applySmudgeSticks(ghost, player, session, io) {
  if (!ghost) return { blinded: false };

  const isDemon = ghost.type?.id === 'raffael_dzsenifer';
  const roamDelaySec = isDemon ? 60 : 90; // Raffael Dzsenifer delays 60s instead of 90s

  ghost.smudgeBlindedTimer = 5.0; // Blinds ghost for exactly 5 seconds
  ghost.targetPlayerId = null; // Resets chase target
  ghost.huntBlockedBySmudgeUntil = Date.now() + roamDelaySec * 1000;

  emitSessionEvent(io, session, 'phobia:ghost-blinded', {
    duration: 5.0,
    roamDelay: roamDelaySec,
    ghostId: ghost.id
  });

  return {
    blinded: true,
    duration: 5.0,
    roamDelay: roamDelaySec
  };
}

// ---------------------------------------------------------------------------
// 7. SENSOR PERCEPTION ENGINE
// ---------------------------------------------------------------------------

function evaluateGhostSensors(ghost, livingPlayers) {
  if (!livingPlayers || livingPlayers.length === 0) {
    return { target: null, hasLOS: false, reason: null };
  }

  let candidates = [];

  for (const player of livingPlayers) {
    const dist = distance2D(ghost, player);
    let score = 0;
    let hasLOS = false;
    let reason = 'proximity';

    // 1. Direct Line-of-Sight within 20m
    if (dist <= 20.0 && !player.noLOS) {
      hasLOS = true;
      score += 100 - dist;
      reason = 'direct_los';
    }

    // 2. Voice / Microphone Sensing within 8m
    const isSpeaking = Boolean(
      player.micActive === true ||
      player.speaking === true ||
      (typeof player.audioLevel === 'number' && player.audioLevel > 0.15)
    );
    if (dist <= 8.0 && isSpeaking) {
      score += 80 + (8.0 - dist) * 5;
      if (!hasLOS) reason = 'voice_mic';
    }

    // 3. Flashlight Sensing within 12m (through darkness and obstacles)
    const flashlightOn = Boolean(
      player.flashlightOn === true ||
      (player.heldItem && (player.heldItem.type?.includes('flashlight') || player.heldItem.id?.includes('flashlight')) && player.heldItem.on)
    );
    if (dist <= 12.0 && flashlightOn) {
      score += 60 + (12.0 - dist) * 4;
      if (!hasLOS && !isSpeaking) reason = 'flashlight';
    }

    // Hiding penalty if quiet and no light
    if (player.hidden && !isSpeaking && !flashlightOn) {
      score -= 50;
    }

    candidates.push({ player, dist, score, hasLOS, reason });
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score <= 0) {
    // Pick nearest player as fallback
    candidates.sort((a, b) => a.dist - b.dist);
    const nearest = candidates[0];
    return { target: nearest?.player || null, hasLOS: false, reason: 'nearest_fallback' };
  }

  return { target: best.player, hasLOS: best.hasLOS, reason: best.reason };
}

// ---------------------------------------------------------------------------
// 8. ACTIONS: HUNTS, INTERACTIONS & EVENTS
// ---------------------------------------------------------------------------

function startHuntInitiation(ghost, session, io) {
  if (!ghost) return false;

  // Smudge check
  if (ghost.huntBlockedBySmudgeUntil && Date.now() < ghost.huntBlockedBySmudgeUntil) {
    return false;
  }

  // Check crucifix defense before hunt can start
  const defended = checkCrucifixDefense(ghost, session, io);
  if (defended) {
    return false;
  }

  ghost.state = GHOST_STATES.HUNT_INITIATION;
  ghost.graceTimer = 3.0; // 3.0 second grace period
  ghost.speed = 0.0;
  ghost.visible = false;
  ghost.losTime = 0.0;
  ghost.targetPlayerId = null;

  if (session) {
    session.huntActive = true;
  }

  emitSessionEvent(io, session, 'phobia:gates-locked', { locked: true });
  emitSessionEvent(io, session, 'phobia:electronics-flicker', { duration: 3.0 });
  emitSessionEvent(io, session, 'phobia:audio-event', { sfx: 'sfx_heartbeat_fast', bpm: 80 });

  return true;
}

function triggerHunt(ghost, session, io) {
  return startHuntInitiation(ghost, session, io);
}

function triggerGhostEvent(ghost, session, io) {
  if (!ghost) return;
  ghost.state = GHOST_STATES.GHOST_EVENT;
  ghost.eventTimer = 2.0 + Math.random() * 3.0; // 2.0s - 5.0s
  ghost.visible = true;
  ghost.speed = 0.0;

  // Lightbulb shatter evaluation
  const shatterRoll = Math.random();
  const shatterProb = (ghost.type?.id === 'rostas_bela') ? 0.50 : 0.25;
  if (shatterRoll < shatterProb && session) {
    emitSessionEvent(io, session, 'phobia:lightbulb-shattered', {
      lightId: 'zone1_mazsahaz_office',
      zoneId: ghost.currentRoomId
    });
  }

  // Shock sanity penalty (-10% to nearby players in LOS within 8m)
  const living = getLivingPlayers(session);
  for (const p of living) {
    if (distance2D(p, ghost) <= 8.0) {
      if (typeof p.sanity === 'number') {
        p.sanity = Math.max(0, p.sanity - 10);
      }
    }
  }

  emitSessionEvent(io, session, 'phobia:ghost-event', {
    duration: ghost.eventTimer,
    type: 'manifestation',
    sfx: 'sfx_ghost_whisper',
    lightColor: '#FF1111'
  });
}

function triggerInteraction(ghost, session, io, targetProp) {
  if (!ghost) return;

  const isPoltergeist = ghost.type?.id === 'lakatos_armando';
  const hasEMF5 = ghost.hasEvidence('emf_5');

  // Scrap prop throw physics
  let count = isPoltergeist ? (3 + Math.floor(Math.random() * 3)) : 1; // 3-5 items for Poltergeist
  let force = isPoltergeist ? (9.0 + Math.random() * 6.0) : (4.5 + Math.random() * 4.5); // 9-15 vs 4.5-9 m/s
  let emfLevel = hasEMF5 ? 5 : (Math.random() < 0.5 ? 2 : 3);

  const angle = Math.random() * Math.PI * 2;
  const impulse = {
    x: Math.cos(angle) * force,
    y: 0.35 * force,
    z: Math.sin(angle) * force
  };

  emitSessionEvent(io, session, 'phobia:item-thrown', {
    itemId: targetProp?.id || 'scrap_pipe_1',
    propType: targetProp?.type || 'scrap_pipe',
    impulse: impulse,
    force: force,
    thrownCount: count,
    ghostType: ghost.type.name
  });

  emitSessionEvent(io, session, 'phobia:emf-reading', {
    level: emfLevel,
    x: ghost.x,
    y: ghost.y,
    z: ghost.z,
    targetId: targetProp?.id || 'scrap_pipe_1'
  });

  emitSessionEvent(io, session, 'phobia:emf-pulse', {
    level: emfLevel,
    x: ghost.x,
    y: ghost.y,
    z: ghost.z
  });

  // Ghost writing book check
  if (ghost.hasEvidence('ghost_writing')) {
    emitSessionEvent(io, session, 'phobia:ghost-writing', {
      text: 'NE NYÚLJ A RÉZHEZ!',
      author: ghost.type.name
    });
  }

  // Fingerprint check
  if (ghost.hasEvidence('fingerprints')) {
    emitSessionEvent(io, session, 'phobia:uv-fingerprint', {
      surfaceId: targetProp?.id || 'door_mazsahaz_entry',
      expiresIn: 60
    });
  }
}

function checkBreakerSabotage(ghost, session, io) {
  if (!ghost || !session) return;
  if (session.breakerOn === false) return; // Already off

  const sabotageProb = ghost.type?.breakerSabotageProb || 0.15;
  if (Math.random() < sabotageProb) {
    session.breakerOn = false;
    emitSessionEvent(io, session, 'phobia:breaker-state', {
      breakerOn: false,
      sabotaged: true,
      ghostId: ghost.id
    });
    emitSessionEvent(io, session, 'phobia:audio-event', { sfx: 'sfx_breaker_flip' });
  }
}

function pickNewWanderWaypoint(ghost) {
  if (!ghost) return;
  const zones = ghost.zones || DEFAULT_ZONES;
  const zoneList = Object.values(zones);

  // 65% chance waypoint in Favorite Room
  if (Math.random() < 0.65 && ghost.favoriteRoom) {
    const fav = ghost.favoriteRoom;
    ghost.navTarget = {
      x: fav.x + (Math.random() - 0.5) * 4.0,
      y: 0,
      z: fav.z + (Math.random() - 0.5) * 4.0
    };
    ghost.currentRoomId = fav.id;
  } else {
    // 35% chance random adjacent zone
    const randomZone = zoneList[Math.floor(Math.random() * zoneList.length)];
    ghost.navTarget = {
      x: randomZone.x + (Math.random() - 0.5) * 6.0,
      y: 0,
      z: randomZone.z + (Math.random() - 0.5) * 6.0
    };
    ghost.currentRoomId = randomZone.id;
  }
}

function wanderRandomly(ghost, dt) {
  const wanderAngle = (ghost.rot || 0) + (Math.random() - 0.5) * 0.8;
  ghost.rot = wanderAngle;
  ghost.x += Math.sin(wanderAngle) * (ghost.speed || 1.2) * dt;
  ghost.z += Math.cos(wanderAngle) * (ghost.speed || 1.2) * dt;
}

// ---------------------------------------------------------------------------
// 9. AUTHORITATIVE 12 HZ TICK ENGINE: updateGhostAI
// ---------------------------------------------------------------------------

function updateGhostAI(ghost, session, deltaMs, io) {
  if (!ghost) return;
  const dt = Math.max(0.001, (deltaMs || 83.33) / 1000); // delta in seconds

  // ---------------------------------------------------------
  // STATE 1: IDLE
  // ---------------------------------------------------------
  if (ghost.state === GHOST_STATES.IDLE) {
    ghost.visible = false;
    ghost.speed = 0.0;
    ghost.stateTimer -= dt;

    // Check hunt roll every 20s if sanity < threshold
    const avgSanity = getTeamAverageSanity(session);
    const threshold = ghost.type?.huntThreshold || 50;

    if (avgSanity < threshold && (!ghost.lastHuntRollTime || Date.now() - ghost.lastHuntRollTime > 20000)) {
      ghost.lastHuntRollTime = Date.now();
      const huntProb = ((threshold - avgSanity) / threshold) * 0.65;
      if (Math.random() < huntProb) {
        startHuntInitiation(ghost, session, io);
        return;
      }
    }

    if (ghost.stateTimer <= 0) {
      const roll = Math.random();
      if (roll < 0.70) {
        ghost.state = GHOST_STATES.WANDER;
        ghost.stateTimer = 4.0 + Math.random() * 4.0;
        pickNewWanderWaypoint(ghost);
      } else if (roll < 0.90) {
        ghost.state = GHOST_STATES.INTERACTION;
      } else {
        ghost.state = GHOST_STATES.IDLE;
        ghost.stateTimer = 3.0 + Math.random() * 5.0;
      }
    }
  }

  // ---------------------------------------------------------
  // STATE 2: WANDER / WANDERING
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.WANDER || ghost.state === GHOST_STATES.WANDERING) {
    ghost.visible = false;
    ghost.speed = 1.2;
    ghost.stateTimer -= dt;

    // Periodic breaker sabotage roll
    ghost.breakerSabotageCooldown -= dt;
    if (ghost.breakerSabotageCooldown <= 0) {
      ghost.breakerSabotageCooldown = 10.0 + Math.random() * 5.0;
      checkBreakerSabotage(ghost, session, io);
    }

    // Waypoint movement
    if (ghost.navTarget) {
      const dx = ghost.navTarget.x - ghost.x;
      const dz = ghost.navTarget.z - ghost.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 0.5) {
        const step = Math.min(dist, ghost.speed * dt);
        ghost.x += (dx / dist) * step;
        ghost.z += (dz / dist) * step;
        ghost.rot = Math.atan2(dx, dz);
      } else {
        pickNewWanderWaypoint(ghost);
      }
    }

    // Check hunt roll
    const avgSanity = getTeamAverageSanity(session);
    const threshold = ghost.type?.huntThreshold || 50;
    if (avgSanity < threshold && (!ghost.lastHuntRollTime || Date.now() - ghost.lastHuntRollTime > 20000)) {
      ghost.lastHuntRollTime = Date.now();
      const huntProb = ((threshold - avgSanity) / threshold) * 0.65;
      if (Math.random() < huntProb) {
        startHuntInitiation(ghost, session, io);
        return;
      }
    }

    // Shyness perk for Sárközi Géza: suppresses ghost events when players group
    const living = getLivingPlayers(session);
    const nearbyPlayers = living.filter(p => distance2D(p, ghost) <= 8.0);
    const isShy = ghost.type?.shyness && nearbyPlayers.length > 1;

    if (!isShy && avgSanity < 75 && Math.random() < 0.005 * dt) {
      triggerGhostEvent(ghost, session, io);
      return;
    }

    if (ghost.stateTimer <= 0) {
      ghost.state = GHOST_STATES.IDLE;
      ghost.stateTimer = 3.0 + Math.random() * 5.0;
    }
  }

  // ---------------------------------------------------------
  // STATE 3: INTERACTION
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.INTERACTION) {
    triggerInteraction(ghost, session, io, null);
    ghost.state = GHOST_STATES.WANDER;
    ghost.stateTimer = 3.0 + Math.random() * 4.0;
    pickNewWanderWaypoint(ghost);
  }

  // ---------------------------------------------------------
  // STATE 4: GHOST_EVENT
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.GHOST_EVENT) {
    ghost.eventTimer -= dt;
    ghost.visible = true;
    ghost.speed = 0.0;
    if (ghost.eventTimer <= 0) {
      ghost.visible = false;
      ghost.state = GHOST_STATES.IDLE;
      ghost.stateTimer = 3.0 + Math.random() * 3.0;
    }
  }

  // ---------------------------------------------------------
  // STATE 5: HUNT_INITIATION
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.HUNT_INITIATION) {
    // Check crucifix defense continually during grace period
    const defended = checkCrucifixDefense(ghost, session, io);
    if (defended) {
      return;
    }

    ghost.graceTimer -= dt;
    ghost.speed = 0.0;
    ghost.visible = false;

    if (ghost.graceTimer <= 0) {
      ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
      ghost.huntDuration = ghost.huntMaxDuration || 35.0;
      ghost.visible = true;
      ghost.losTime = 0.0;
      const inFreezing = isFreezingZone(ghost);
      ghost.speed = (ghost.type?.freezingSpeedBoost && inFreezing) ? 2.2 : 1.7;

      emitSessionEvent(io, session, 'phobia:hunt-started', {
        duration: ghost.huntDuration,
        ghostId: ghost.id,
        speed: ghost.speed
      });
    }
  }

  // ---------------------------------------------------------
  // STATE 6: ACTIVE_HUNT_CHASE
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.ACTIVE_HUNT_CHASE) {
    if (ghost.huntDuration === undefined || ghost.huntDuration === null || ghost.huntDuration <= 0) {
      if (!ghost._huntExpired) {
        ghost.huntDuration = ghost.huntMaxDuration || 35.0;
      }
    }
    ghost.huntDuration -= dt;
    ghost.visible = true;

    // Check hunt expiration
    if (ghost.huntDuration <= 0) {
      ghost._huntExpired = true;
      ghost.state = GHOST_STATES.POST_HUNT_COOLDOWN;
      ghost.cooldownTimer = 25.0;
      ghost.visible = false;
      ghost.speed = 1.2;
      ghost.targetPlayerId = null;
      if (session) session.huntActive = false;
      emitSessionEvent(io, session, 'phobia:hunt-ended', { reason: 'timer_expired' });
      emitSessionEvent(io, session, 'phobia:gates-unlocked', { locked: false });
      return;
    }

    // Smudge sticks blinded condition
    if (ghost.smudgeBlindedTimer > 0) {
      ghost.smudgeBlindedTimer -= dt;
      ghost.targetPlayerId = null;
      ghost.speed = 1.0;
      wanderRandomly(ghost, dt);
      return;
    }

    // Living players evaluation
    const living = getLivingPlayers(session);
    if (living.length === 0) {
      ghost.state = GHOST_STATES.POST_HUNT_COOLDOWN;
      ghost.cooldownTimer = 25.0;
      ghost.visible = false;
      if (session) {
        session.huntActive = false;
        session.gameOver = true;
      }
      emitSessionEvent(io, session, 'phobia:hunt-ended', { reason: 'all_players_dead' });
      emitSessionEvent(io, session, 'phobia:gates-unlocked', { locked: false });
      return;
    }

    // Hidden players (lockers / trunks) and players inside the truck safe zone cannot be hunted
    const huntable = living.filter((p) => !p.hidden && !p.isInsideTruck);

    // Sensor evaluation (Line-of-Sight, Flashlight, Voice/Mic)
    const sensorResult = evaluateGhostSensors(ghost, huntable);
    const targetKey = (t) => (t ? (t.id ?? t.socketId ?? t.userId ?? null) : null);
    ghost.targetPlayerId = targetKey(sensorResult.target);
    ghost.hasLOS = sensorResult.hasLOS;

    if (sensorResult.target) {
      const target = sensorResult.target;
      const inFreezing = isFreezingZone(ghost);
      const isKolompar = ghost.type?.id === 'kolompar_kalman';

      // Speed acceleration formulas:
      // Standard: 1.7 m/s to 2.8 m/s with 0.15 m/s^2 acceleration under LOS
      // Kolompár Kálmán in freezing: 2.2 m/s to 3.3 m/s with 0.18 m/s^2
      const baseSpeed = (isKolompar && inFreezing) ? 2.2 : 1.7;
      const maxSpeed = (isKolompar && inFreezing) ? 3.3 : 2.8;
      const accelRate = (isKolompar && inFreezing) ? 0.18 : 0.15;

      if (ghost.hasLOS) {
        ghost.losTime += dt;
        ghost.speed = Math.min(maxSpeed, baseSpeed + accelRate * ghost.losTime);
      } else {
        ghost.losTime = Math.max(0, ghost.losTime - dt);
        ghost.speed = Math.max(baseSpeed, ghost.speed - 0.10 * dt);
      }

      // Move towards target
      const tc = getCoords(target);
      const dx = tc.x - ghost.x;
      const dz = tc.z - ghost.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.001) {
        const step = Math.min(dist, ghost.speed * dt);
        ghost.x += (dx / dist) * step;
        ghost.z += (dz / dist) * step;
        ghost.rot = Math.atan2(dx, dz);
      }

      // Kill trigger: touches player within 0.8m
      if (dist <= 0.8) {
        ghost.state = GHOST_STATES.KILL_SEQUENCE;
        ghost.killTimer = 2.0;
        ghost.victimId = targetKey(target);

        // Mark victim
        target.alive = false;
        target.isSpectator = true;

        // Drop held & inventory items
        if (Array.isArray(target.inventory)) {
          if (!session.droppedItems) session.droppedItems = [];
          for (const item of target.inventory) {
            if (item) {
              session.droppedItems.push({
                ...item,
                x: tc.x || ghost.x,
                y: 0.05,
                z: tc.z || ghost.z
              });
            }
          }
          target.inventory = [];
        }

        emitSessionEvent(io, session, 'phobia:player-killed', {
          victimId: targetKey(target),
          playerId: targetKey(target),
          userId: target.userId,
          username: target.username,
          jumpscareDuration: 2.0
        });
      }
    } else {
      wanderRandomly(ghost, dt);
    }
  }

  // ---------------------------------------------------------
  // STATE 7: KILL_SEQUENCE
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.KILL_SEQUENCE) {
    ghost.killTimer -= dt;
    ghost.speed = 0.0;
    ghost.visible = true;

    if (ghost.killTimer <= 0) {
      const livingRemaining = getLivingPlayers(session);
      if (livingRemaining.length > 0) {
        // More players alive: return to chase for remainder of hunt
        ghost.state = GHOST_STATES.ACTIVE_HUNT_CHASE;
        ghost.targetPlayerId = null;
        ghost.losTime = 0.0;
        ghost.speed = 1.7;
      } else {
        // All players dead: defeat
        ghost.state = GHOST_STATES.POST_HUNT_COOLDOWN;
        ghost.cooldownTimer = 25.0;
        ghost.visible = false;
        if (session) {
          session.huntActive = false;
          session.gameOver = true;
        }
        emitSessionEvent(io, session, 'phobia:match-concluded', {
          victory: false,
          reason: 'all_players_killed'
        });
        emitSessionEvent(io, session, 'phobia:gates-unlocked', { locked: false });
      }
    }
  }

  // ---------------------------------------------------------
  // STATE 8: POST_HUNT_COOLDOWN
  // ---------------------------------------------------------
  else if (ghost.state === GHOST_STATES.POST_HUNT_COOLDOWN) {
    ghost.cooldownTimer -= dt;
    ghost.visible = false;
    ghost.speed = 1.2;
    if (session) {
      session.huntActive = false;
    }
    if (ghost.cooldownTimer <= 0) {
      ghost.state = GHOST_STATES.IDLE;
      ghost.stateTimer = 3.0 + Math.random() * 5.0;
    }
  }
}

// ---------------------------------------------------------------------------
// 10. EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
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
};
