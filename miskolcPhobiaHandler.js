// MiskolcPhobia: 3D Cooperative Paranormal Investigation Horror Game Backend
// Authoritative multiplayer coordinator, 12 Hz state tick loop, SQLite persistence,
// environment mechanics (breaker, 6-light trip, hinged doors), item interactions,
// and Ghost AI state machine integration.

const crypto = require('crypto');
const path = require('path');

// 12 Hz Authoritative Server Tick Rate (~83.33ms)
const TICK_RATE_HZ = 12;
const TICK_MS = Math.floor(1000 / TICK_RATE_HZ); // 83ms

// Maximum active artificial lights allowed before circuit breaker overload
const MAX_ACTIVE_LIGHTS = 6;

// Default initial spawn coordinates outside "A Fehér Ford Tranzit" surveillance van
const TRUCK_SPAWN_COORDS = [-4.0, 0.0, -15.0];

// 7 Miskolc Folklore Ghost Archetypes & Evidence Combinations
const GHOST_ARCHETYPES = [
  {
    type: 'Lakatos Ármándó',
    archetype: 'Poltergeist',
    evidence: ['ghost_writing', 'spirit_box', 'emf_5'],
    baseSpeed: 1.6,
    huntSpeed: 2.5,
    favoriteRoom: 'zone1_mazsahaz',
    description: 'Rendkívül agresszív poltergeist, aki a MÉH telepen felhalmozott rezet védi. Tárgyakat hajigál.',
    breakerSabotageChance: 0.15
  },
  {
    type: 'Kolompár Kálmán',
    archetype: 'Bicskás Vadász',
    evidence: ['freezing_temps', 'fingerprints', 'dots'],
    baseSpeed: 1.8,
    huntSpeed: 2.8,
    favoriteRoom: 'zone1_mazsahaz',
    description: 'Gyors mozgású, bicskával suhintó kísértet. Fagypont alatti hideget hagy maga után.',
    breakerSabotageChance: 0.15
  },
  {
    type: 'Rostás "Flexes" Béla',
    archetype: 'Hangoskodó',
    evidence: ['emf_5', 'fingerprints', 'ghost_orbs'],
    baseSpeed: 1.6,
    huntSpeed: 2.4,
    favoriteRoom: 'zone3_hangar',
    description: 'Sikolyai összetörik az izzókat, és állandó magas elektromágneses zavart kelt.',
    breakerSabotageChance: 0.20
  },
  {
    type: 'Bunkó Lajos',
    archetype: 'Fagyos Rezes',
    evidence: ['freezing_temps', 'ghost_writing', 'spirit_box'],
    baseSpeed: 1.5,
    huntSpeed: 2.3,
    favoriteRoom: 'zone1_mazsahaz',
    description: 'Szereti lecsapni a biztosítékot (40% esély). Csontig hatoló fagyot áraszt.',
    breakerSabotageChance: 0.40
  },
  {
    type: 'Sárközi "Lókupec" Géza',
    archetype: 'Csendes Árnyék',
    evidence: ['dots', 'ghost_orbs', 'freezing_temps'],
    baseSpeed: 1.4,
    huntSpeed: 2.6,
    favoriteRoom: 'zone2_roncsdomb',
    description: 'Visszahúzódó árnyék, aki csak akkor mutatja meg magát zöld lézeren (D.O.T.S.), ha a vadászok egyedül vannak.',
    breakerSabotageChance: 0.10
  },
  {
    type: 'Raffael Dzsenifer',
    archetype: 'Démon',
    evidence: ['fingerprints', 'ghost_writing', 'freezing_temps'],
    baseSpeed: 1.7,
    huntSpeed: 2.7,
    favoriteRoom: 'zone1_mazsahaz',
    description: 'Gonosz démoni lény, aki már 70%-os átlagos józanságnál (elmeállapot) elindíthatja a vadászatot.',
    breakerSabotageChance: 0.25
  },
  {
    type: 'A Keresztapa',
    archetype: 'Mimic',
    evidence: ['spirit_box', 'fingerprints', 'freezing_temps'], // fake 4th evidence: ghost_orbs
    fakeEvidence: 'ghost_orbs',
    baseSpeed: 1.6,
    huntSpeed: 2.5,
    favoriteRoom: 'zone1_mazsahaz',
    description: 'Megtévesztő szellem. Bármely más archetípust képes utánozni, és mindig hamis gömböket (Ghost Orbs) vetít.',
    breakerSabotageChance: 0.15
  }
];

// Map Zones & Ambient Temperatures (°C)
const MAP_ZONES = {
  truck: { name: 'Ford Tranzit Teherautó', minTemp: 17.5, maxTemp: 19.5, isSafeZone: true },
  zone1_mazsahaz: { name: 'Mázsaház (Iroda)', minTemp: 4.0, maxTemp: 7.0, isFavoriteCandidate: true },
  zone2_roncsdomb: { name: 'Roncsautó Domb', minTemp: 7.0, maxTemp: 10.0 },
  zone3_hangar: { name: 'Nagy Hangár', minTemp: 5.0, maxTemp: 8.5 },
  zone4_kutyatelep: { name: 'Kutyatelep & Sufni', minTemp: 6.5, maxTemp: 9.5 },
  zone5_ocskavas: { name: 'Ócskavas Lerakat', minTemp: 6.0, maxTemp: 9.0 }
};

// Standard Default Items on the Surveillance Truck Equipment Shelf
function createInitialEquipment() {
  return [
    {
      id: 'mobile_jesus_1',
      type: 'mobile_jesus',
      name: 'Mobil Jézus',
      charges: 2,
      charred: false,
      snapped: false,
      x: -3.5, y: 1.0, z: -14.5,
      description: 'Szentelt arany feszület. 4 méteren belül megakadályozza a vadászatot (2 töltet).'
    },
    {
      id: 'emf_reader_1',
      type: 'emf_reader',
      name: 'EMF 5 Mérő',
      active: false,
      level: 1,
      x: -3.2, y: 1.0, z: -14.5,
      description: 'Elektromágneses mező érzékelő. 5 LED skála.'
    },
    {
      id: 'thermometer_1',
      type: 'thermometer',
      name: 'Lézeres Hőmérő',
      active: true,
      reading: 18.5,
      x: -2.9, y: 1.0, z: -14.5,
      description: 'Digitális hőmérő. Fagypont (<0.0°C) mérésére.'
    },
    {
      id: 'spirit_box_1',
      type: 'spirit_box',
      name: 'Szellem Rádió',
      active: false,
      x: -2.6, y: 1.0, z: -14.5,
      description: 'Frekvencia pásztázó rádió szellemhangok észlelésére.'
    },
    {
      id: 'uv_light_1',
      type: 'uv_light',
      name: 'UV Zseblámpa',
      active: false,
      x: -2.3, y: 1.0, z: -14.5,
      description: 'Ultraibolya lámpa ujjlenyomatok felkutatására.'
    },
    {
      id: 'photo_camera_1',
      type: 'photo_camera',
      name: 'Fényképezőgép',
      photosLeft: 5,
      x: -2.0, y: 1.0, z: -14.5,
      description: 'Vakuval ellátott kamera bizonyítékok rögzítésére.'
    },
    {
      id: 'sanity_palinka_1',
      type: 'sanity_palinka',
      name: 'Borsodi Szilvapálinka',
      usesLeft: 1,
      x: -1.7, y: 1.0, z: -14.5,
      description: 'Házilag főzött 52 fokos pálinka. +35% elmeállapotot ad.'
    },
    {
      id: 'smudge_sticks_1',
      type: 'smudge_sticks',
      name: 'Füstölő Csomag',
      usesLeft: 1,
      x: -1.4, y: 1.0, z: -14.5,
      description: 'Meggyújtva 5 másodpercre megvakítja a vadászó szellemet.'
    },
    {
      id: 'flashlight_1',
      type: 'flashlight',
      name: 'Nagyfényű Zseblámpa',
      active: false,
      x: -1.1, y: 1.0, z: -14.5,
      description: 'Erős fénycsóvájú kézi lámpa.'
    },
    {
      id: 'ghost_writing_book_1',
      type: 'ghost_writing_book',
      name: 'Könyv a Firkáknak',
      hasWriting: false,
      writingText: null,
      x: -0.8, y: 1.0, z: -14.5,
      description: 'Üres füzet szellemfirkák fogadására.'
    },
    {
      id: 'dots_projector_1',
      type: 'dots_projector',
      name: 'D.O.T.S. Projektor',
      active: false,
      x: -0.5, y: 1.0, z: -14.5,
      description: 'Zöld mátrix lézerpont-vetítő mozgó árnyakhoz.'
    }
  ];
}

// Interactive Scrap Props in the MÉH Telep Yard
function createScrapProps() {
  return [
    { id: 'scrap_pipe_1', type: 'scrap_pipe', name: 'Rozsdás Vascső', x: 5.5, y: 0.1, z: 8.5, zone: 'zone1_mazsahaz' },
    { id: 'scrap_can_1', type: 'scrap_can', name: 'Üres Kőbányai Sörösdoboz', x: 4.8, y: 0.1, z: 9.0, zone: 'zone1_mazsahaz' },
    { id: 'scrap_radiator_1', type: 'scrap_radiator', name: 'Öntöttvas Radiátor', x: 15.0, y: 0.2, z: 12.0, zone: 'zone2_roncsdomb' },
    { id: 'scrap_muffler_1', type: 'scrap_muffler', name: 'Lada Kipufogódob', x: -12.0, y: 0.2, z: 15.0, zone: 'zone3_hangar' }
  ];
}

// Interactive Doors & Gates
function createInitialDoors() {
  return {
    door_truck_sliding: { id: 'door_truck_sliding', name: 'Ford Tranzit Tolóajtó', angle: 1.0, open: true, x: -3.0, y: 1.0, z: -14.0 },
    door_mazsahaz_entry: { id: 'door_mazsahaz_entry', name: 'Mázsaház Bejárati Ajtó', angle: 0.0, open: false, x: 2.0, y: 1.0, z: 3.0 },
    door_mazsahaz_back: { id: 'door_mazsahaz_back', name: 'Mázsaház Hátsó Ajtó', angle: 0.0, open: false, x: 8.0, y: 1.0, z: 14.0 },
    door_hangar_main: { id: 'door_hangar_main', name: 'Nagy Hangár Kapu', angle: 0.0, open: false, x: -5.0, y: 2.0, z: 5.0 },
    door_shed_kennel: { id: 'door_shed_kennel', name: 'Sufni Ajtó', angle: 0.0, open: false, x: -15.0, y: 1.0, z: 30.0 },
    gate_depot_main: { id: 'gate_depot_main', name: 'MÉH Telep Főkapu', angle: 0.0, open: false, x: 0.0, y: 1.5, z: -5.0 }
  };
}

// Light Fixtures Across the Map (Overhead lights dependent on breaker)
function createInitialLights() {
  return {
    light_mazsahaz_office: { id: 'light_mazsahaz_office', name: 'Mázsaház Iroda Lámpa', state: false, shattered: false, x: 5.0, y: 2.8, z: 8.0, zone: 'zone1_mazsahaz' },
    light_mazsahaz_hall: { id: 'light_mazsahaz_hall', name: 'Mázsaház Folyosó Lámpa', state: false, shattered: false, x: 3.0, y: 2.8, z: 5.0, zone: 'zone1_mazsahaz' },
    light_hangar_bay1: { id: 'light_hangar_bay1', name: 'Hangár Fénycső 1', state: false, shattered: false, x: -10.0, y: 5.0, z: 12.0, zone: 'zone3_hangar' },
    light_hangar_bay2: { id: 'light_hangar_bay2', name: 'Hangár Fénycső 2', state: false, shattered: false, x: -15.0, y: 5.0, z: 20.0, zone: 'zone3_hangar' },
    light_kennel_shed: { id: 'light_kennel_shed', name: 'Sufni Izzó', state: false, shattered: false, x: -12.0, y: 2.5, z: 32.0, zone: 'zone4_kutyatelep' },
    light_gate_floodlight: { id: 'light_gate_floodlight', name: 'Főkapu Reflektor', state: false, shattered: false, x: 0.0, y: 4.0, z: -4.0, zone: 'truck' },
    light_yard_floodlight1: { id: 'light_yard_floodlight1', name: 'Udvar Reflektor 1', state: false, shattered: false, x: 12.0, y: 6.0, z: 10.0, zone: 'zone2_roncsdomb' },
    light_yard_floodlight2: { id: 'light_yard_floodlight2', name: 'Udvar Reflektor 2', state: false, shattered: false, x: 18.0, y: 6.0, z: 30.0, zone: 'zone5_ocskavas' }
  };
}

// ----------------------------------------------------------------------------
// SQLite Database Layer (better-sqlite3)
// ----------------------------------------------------------------------------
function initPhobiaDatabase(db) {
  // Ensure tables exist with exact requested schemas
  db.exec(`
    CREATE TABLE IF NOT EXISTS phobia_profiles (
      userId TEXT PRIMARY KEY,
      balance_ft INTEGER DEFAULT 1000,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      hunter_rank TEXT DEFAULT 'Kezdő Roncskutató'
    );

    CREATE TABLE IF NOT EXISTS phobia_match_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      matchId TEXT,
      userId TEXT,
      ghostType TEXT,
      location TEXT,
      result TEXT,
      reward_ft INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const getProfileStmt = db.prepare('SELECT * FROM phobia_profiles WHERE userId = ?');
  const insertProfileStmt = db.prepare(`
    INSERT INTO phobia_profiles (userId, balance_ft, xp, level, hunter_rank)
    VALUES (?, 1000, 0, 1, 'Kezdő Roncskutató')
  `);
  const updateProfileStmt = db.prepare(`
    UPDATE phobia_profiles
    SET balance_ft = balance_ft + ?,
        xp = xp + ?,
        level = ?,
        hunter_rank = ?
    WHERE userId = ?
  `);
  const insertMatchHistoryStmt = db.prepare(`
    INSERT INTO phobia_match_history (matchId, userId, ghostType, location, result, reward_ft)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const getMatchHistoryStmt = db.prepare(`
    SELECT * FROM phobia_match_history WHERE userId = ? ORDER BY id DESC LIMIT ?
  `);

  function calculateRank(level) {
    if (level <= 1) return 'Kezdő Roncskutató';
    if (level <= 3) return 'Tapasztalt MÉH-es';
    if (level <= 6) return 'Veterán Vasazó';
    return 'Miskolci Szelleműző Legenda';
  }

  return {
    getOrCreateProfile(userId) {
      if (!userId) return null;
      let row = getProfileStmt.get(userId);
      if (!row) {
        insertProfileStmt.run(userId);
        row = getProfileStmt.get(userId);
      }
      return row;
    },

    creditMatchReward(userId, { matchId, ghostType, location, result, rewardFt, xpGained = 150 }) {
      if (!userId) return null;
      let profile = this.getOrCreateProfile(userId);
      const newXp = (profile.xp || 0) + xpGained;
      const newLevel = Math.max(1, Math.floor(newXp / 500) + 1);
      const newRank = calculateRank(newLevel);

      updateProfileStmt.run(rewardFt, xpGained, newLevel, newRank, userId);
      insertMatchHistoryStmt.run(
        matchId || `match_${Date.now()}`,
        userId,
        ghostType || 'Ismeretlen',
        location || 'A MÉH Telep (Miskolc)',
        result || 'Győzelem',
        rewardFt || 0
      );

      return getProfileStmt.get(userId);
    },

    getMatchHistory(userId, limit = 20) {
      return getMatchHistoryStmt.all(userId, limit);
    }
  };
}

// ----------------------------------------------------------------------------
// PhobiaSession Class: Authoritative Session State
// ----------------------------------------------------------------------------
class PhobiaSession {
  constructor(roomId, options = {}) {
    this.roomId = roomId;
    this.matchId = options.matchId || `phobia_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.status = 'active'; // 'staging' | 'active' | 'hunting' | 'concluded'
    this.location = 'A MÉH Telep (Miskolc)';
    this.difficulty = options.difficulty || 'Amateur';
    this.createdAt = Date.now();
    this.tickCount = 0;

    // Preparation Grace Timer (Amateur 180s, Intermediate 90s, Pro 0s)
    this.gracePeriodRemaining = this.difficulty === 'Professional' ? 0 : (this.difficulty === 'Intermediate' ? 90 : 180);
    this.gateOpen = false;

    // Electrical Circuit Breaker & Lighting
    this.breakerOn = true;
    this.activeLights = new Set(); // Maximum 6 active lights
    this.lights = createInitialLights();

    // Map Props, Doors, Items
    this.doors = createInitialDoors();
    this.equipmentShelf = createInitialEquipment();
    this.droppedItems = []; // Items dropped in the yard
    this.scrapProps = createScrapProps();

    // Connected Players: socketId -> PlayerState
    this.players = new Map();

    // Ghost Entity & AI
    this.ghostArchetype = options.forcedGhost || GHOST_ARCHETYPES[Math.floor(Math.random() * GHOST_ARCHETYPES.length)];
    this.ghost = this.initGhost(this.ghostArchetype);

    // Side Tasks tracking
    this.sideTasks = [
      { id: 'freezing_temp', desc: 'Mérj 0.0°C alatti fagyos hőmérsékletet', reward: 500, completed: false },
      { id: 'emf_5', desc: 'Észlelj 5-ös szintű EMF paranormalitást', reward: 500, completed: false },
      { id: 'crucifix_block', desc: 'Háríts el egy vadászatot a Mobil Jézussal', reward: 750, completed: false }
    ];
    this.completedSideTasks = new Set();
    this.photoBounties = []; // Registered photo evidence

    // Last time tick was evaluated
    this.lastTickTime = Date.now();
  }

  initGhost(archetype) {
    let ai = null;
    try { ai = require('./miskolcPhobiaAI'); } catch (e) {}
    if (ai && typeof ai.createGhostAI === 'function') {
      try {
        const extGhost = ai.createGhostAI(archetype.type, { x: 5.0, y: 0.0, z: 8.0 });
        if (extGhost) {
          extGhost.name = extGhost.type?.name || extGhost.name || archetype.type;
          extGhost.typeName = extGhost.type?.name || archetype.type;
          extGhost.archetype = extGhost.type?.englishRole || extGhost.type?.role || archetype.archetype;
          extGhost.evidence = extGhost.type?.evidences || extGhost.evidences || extGhost.evidence || [...archetype.evidence];
          extGhost.position = [extGhost.x || 5.0, extGhost.y || 0.0, extGhost.z || 8.0];
          extGhost.huntActive = Boolean(extGhost.state === 'ACTIVE_HUNT_CHASE' || extGhost.state === 'HUNT_INITIATION');
          if (!extGhost.hasEvidence) {
            extGhost.hasEvidence = (ev) => extGhost.evidence.includes(ev);
          }
          return extGhost;
        }
      } catch (err) {}
    }

    return {
      id: `ghost_${this.matchId}`,
      name: archetype.type,
      type: archetype.type,
      archetype: archetype.archetype,
      evidence: [...archetype.evidence],
      fakeEvidence: archetype.fakeEvidence || null,
      favoriteRoom: archetype.favoriteRoom || 'zone1_mazsahaz',
      favoriteCoords: { x: 5.0, y: 0.0, z: 8.0 }, // Zone 1 Mázsaház
      position: [5.0, 0.0, 8.0],
      velocity: [0.0, 0.0, 0.0],
      state: 'IDLE', // IDLE, WANDER, INTERACTION, GHOST_EVENT, HUNT_INITIATION, ACTIVE_HUNT_CHASE, KILL_SEQUENCE, POST_HUNT_COOLDOWN
      stateTimer: 5000,
      visible: false,
      speed: archetype.baseSpeed || 1.6,
      huntActive: false,
      huntTimer: 0,
      cooldownTimer: 0,
      activityLevel: 1, // 0 to 10 scale for truck monitor
      targetPlayerId: null,
      lineOfSightSeconds: 0,
      breakerSabotageChance: archetype.breakerSabotageChance || 0.15
    };
  }

  addPlayer(socketId, user = {}) {
    const player = {
      socketId,
      userId: user.userId || user.accountId || socketId,
      username: user.username || `Kutató_${socketId.slice(0, 4)}`,
      avatarColor: user.avatarColor || '#7655F5',
      position: [...TRUCK_SPAWN_COORDS],
      rotation: [0.0, 0.0], // pitch, yaw
      crouched: false,
      sprinting: false,
      isSpeaking: false,
      flashlightOn: false,
      sanity: 100.0, // 0 to 100%
      alive: true,
      currentZone: 'truck',
      isInsideTruck: true,
      activeSlot: 0,
      inventory: [null, null, null] // 3-slot inventory
    };
    this.players.set(socketId, player);
    return player;
  }

  removePlayer(socketId) {
    const player = this.players.get(socketId);
    if (!player) return null;
    // Drop player held items into yard if dead or disconnecting
    for (let i = 0; i < player.inventory.length; i++) {
      const item = player.inventory[i];
      if (item) {
        item.x = player.position[0] + (Math.random() - 0.5) * 0.5;
        item.y = 0.1;
        item.z = player.position[2] + (Math.random() - 0.5) * 0.5;
        this.droppedItems.push(item);
      }
    }
    this.players.delete(socketId);
    return player;
  }

  getPublicSummary() {
    return {
      roomId: this.roomId,
      matchId: this.matchId,
      status: this.status,
      location: this.location,
      difficulty: this.difficulty,
      graceRemaining: Math.max(0, Math.round(this.gracePeriodRemaining)),
      breakerOn: this.breakerOn,
      activeLights: Array.from(this.activeLights),
      doors: Object.fromEntries(Object.entries(this.doors).map(([k, v]) => [k, { open: v.open, angle: v.angle }])),
      equipmentShelf: this.equipmentShelf,
      droppedItems: this.droppedItems,
      playerCount: this.players.size,
      players: Array.from(this.players.values()).map((p) => ({
        socketId: p.socketId,
        userId: p.userId,
        username: p.username,
        avatarColor: p.avatarColor,
        position: p.position,
        rotation: p.rotation,
        sanity: Math.round(p.sanity),
        alive: p.alive,
        activeSlot: p.activeSlot,
        inventory: p.inventory
      })),
      sideTasks: this.sideTasks
    };
  }
}

// ----------------------------------------------------------------------------
// Main Setup Function: setupMiskolcPhobia(io, users, opts)
// ----------------------------------------------------------------------------
function setupMiskolcPhobia(io, users, opts = {}) {
  const db = opts.db || require('./database').db;
  const store = initPhobiaDatabase(db);

  // Active game sessions: roomId -> PhobiaSession
  const sessions = new Map();

  // Load external Ghost AI engine if available (created by Agent 2)
  let phobiaAI = null;
  try {
    phobiaAI = require('./miskolcPhobiaAI');
  } catch (err) {
    // Graceful fallback to internal simulation logic if Agent 2 is concurrent
  }

  function roomOf(roomId) {
    return `phobia:${roomId}`;
  }

  function getOrCreateSession(roomId, options = {}) {
    if (!roomId) roomId = 'default_phobia_room';
    let session = sessions.get(roomId);
    if (!session) {
      session = new PhobiaSession(roomId, options);
      sessions.set(roomId, session);
    }
    return session;
  }

  // --------------------------------------------------------------------------
  // Authoritative 12 Hz Server Tick Loop
  // --------------------------------------------------------------------------
  let lastTickTimestamp = Date.now();

  const tickInterval = setInterval(() => {
    const now = Date.now();
    const deltaMs = now - lastTickTimestamp;
    lastTickTimestamp = now;

    for (const session of sessions.values()) {
      if (session.status === 'concluded' || session.players.size === 0) continue;

      session.tickCount++;

      // 1. Preparation Grace Period Countdown
      if (session.gracePeriodRemaining > 0 && session.gateOpen) {
        session.gracePeriodRemaining -= deltaMs / 1000;
        if (session.gracePeriodRemaining < 0) session.gracePeriodRemaining = 0;
      }

      // 2. Sanity Drain Simulation
      for (const player of session.players.values()) {
        if (!player.alive) continue;

        // Inside truck is safe; no passive drain
        if (player.isInsideTruck) continue;

        // Drain rate per second
        let drainPerSec = 0.08; // Base dark yard drain
        if (player.flashlightOn) drainPerSec = 0.03;
        if (session.breakerOn && session.activeLights.size > 0) {
          // If in an illuminated zone, drain is halved
          drainPerSec = 0.02;
        }
        if (session.ghost.huntActive) {
          // Intense panic during hunt
          drainPerSec = 0.45;
        }

        player.sanity = Math.max(0.0, player.sanity - (drainPerSec * (deltaMs / 1000)));
      }

      // 3. Ghost AI Update (Delegate to miskolcPhobiaAI or execute internal simulation)
      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }
      if (ai && typeof ai.updateGhostAI === 'function') {
        try {
          ai.updateGhostAI(session.ghost, session, deltaMs, io);
        } catch (err) {
          updateInternalGhostAI(session, deltaMs);
        }
      } else {
        updateInternalGhostAI(session, deltaMs);
      }

      // 4. Broadcast 12 Hz State Delta
      const tickPayload = {
        tick: session.tickCount,
        timestamp: now,
        graceRemaining: Math.round(session.gracePeriodRemaining),
        breakerOn: session.breakerOn,
        activeLights: Array.from(session.activeLights),
        ghost: {
          state: session.ghost.state,
          visible: session.ghost.visible,
          position: [
            session.ghost.x !== undefined ? session.ghost.x : (session.ghost.position?.[0] || 5.0),
            session.ghost.y !== undefined ? session.ghost.y : (session.ghost.position?.[1] || 0.0),
            session.ghost.z !== undefined ? session.ghost.z : (session.ghost.position?.[2] || 8.0)
          ],
          speed: session.ghost.speed,
          huntActive: Boolean(session.ghost.huntActive || session.ghost.state === 'ACTIVE_HUNT_CHASE' || session.ghost.state === 'HUNT_INITIATION'),
          activityLevel: session.ghost.activityLevel || 1,
          targetPlayerId: session.ghost.targetPlayerId
        },
        players: Array.from(session.players.values()).map((p) => ({
          id: p.socketId,
          userId: p.userId,
          x: p.position[0],
          y: p.position[1],
          z: p.position[2],
          pitch: p.rotation[0],
          yaw: p.rotation[1],
          sanity: Math.round(p.sanity),
          crouched: p.crouched,
          sprinting: p.sprinting,
          alive: p.alive,
          activeSlot: p.activeSlot
        }))
      };

      io.to(roomOf(session.roomId)).emit('phobia:tick', tickPayload);
    }
  }, TICK_MS);

  // --------------------------------------------------------------------------
  // Internal Ghost AI Simulation (State machine & Crucifix defense)
  // --------------------------------------------------------------------------
  function updateInternalGhostAI(session, deltaMs) {
    const ghost = session.ghost;
    ghost.stateTimer -= deltaMs;

    // Check Mobile Jesus (Crucifix) Defense Aura
    function checkCrucifixAura() {
      // Find all Mobile Jesus instances in player inventories or dropped items
      const candidateJesuses = [];

      for (const item of session.droppedItems) {
        if (item.type === 'mobile_jesus' && item.charges > 0) {
          candidateJesuses.push(item);
        }
      }
      for (const p of session.players.values()) {
        if (!p.alive || p.isInsideTruck) continue;
        for (const item of p.inventory) {
          if (item && item.type === 'mobile_jesus' && item.charges > 0) {
            candidateJesuses.push(Object.assign({}, item, { x: p.position[0], z: p.position[2], owner: p }));
          }
        }
      }

      for (const jesus of candidateJesuses) {
        const dx = ghost.position[0] - jesus.x;
        const dz = ghost.position[2] - jesus.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Crucifix aura radius: 4.0 meters
        if (dist <= 4.0) {
          // Block hunt!
          jesus.charges -= 1;
          jesus.charred = true;
          if (jesus.charges <= 0) {
            jesus.snapped = true;
          }

          // If in player inventory, sync back
          if (jesus.owner) {
            for (let i = 0; i < jesus.owner.inventory.length; i++) {
              if (jesus.owner.inventory[i]?.id === jesus.id) {
                jesus.owner.inventory[i].charges = jesus.charges;
                jesus.owner.inventory[i].charred = jesus.charred;
                jesus.owner.inventory[i].snapped = jesus.snapped;
              }
            }
          }

          // Mark side task completed
          session.completedSideTasks.add('crucifix_block');
          const task = session.sideTasks.find((t) => t.id === 'crucifix_block');
          if (task) task.completed = true;

          // Emit cancellation & burn events
          io.to(roomOf(session.roomId)).emit('phobia:hunt-cancelled', {
            reason: 'crucifix',
            jesusId: jesus.id,
            chargesRemaining: jesus.charges
          });
          io.to(roomOf(session.roomId)).emit('phobia:jesus-burned', {
            jesusId: jesus.id,
            chargesRemaining: jesus.charges,
            charred: jesus.charred,
            snapped: jesus.snapped
          });

          ghost.huntActive = false;
          ghost.state = 'POST_HUNT_COOLDOWN';
          ghost.stateTimer = 25000;
          ghost.visible = false;
          return true;
        }
      }
      return false;
    }

    // State machine transitions
    switch (ghost.state) {
      case 'IDLE':
        ghost.visible = false;
        ghost.activityLevel = Math.max(1, Math.floor(Math.random() * 3));
        if (ghost.stateTimer <= 0) {
          ghost.state = 'WANDER';
          ghost.stateTimer = 6000 + Math.random() * 4000;
        }
        break;

      case 'WANDER':
        ghost.visible = false;
        // Drift slowly around favorite room
        ghost.position[0] += (Math.random() - 0.5) * 0.1;
        ghost.position[2] += (Math.random() - 0.5) * 0.1;
        if (ghost.stateTimer <= 0) {
          // 15% breaker sabotage chance
          if (session.breakerOn && Math.random() < ghost.breakerSabotageChance) {
            session.breakerOn = false;
            session.activeLights.clear();
            io.to(roomOf(session.roomId)).emit('phobia:breaker-updated', { breakerOn: false, sabotage: true });
            io.to(roomOf(session.roomId)).emit('phobia:breaker-state', { breakerOn: false });
          }
          ghost.state = 'IDLE';
          ghost.stateTimer = 3000 + Math.random() * 3000;
        }
        break;

      case 'HUNT_INITIATION':
        ghost.visible = true;
        ghost.activityLevel = 10;
        // Attempt hunt defense check
        if (checkCrucifixAura()) {
          break;
        }
        if (ghost.stateTimer <= 0) {
          ghost.state = 'ACTIVE_HUNT_CHASE';
          ghost.huntActive = true;
          ghost.huntTimer = 25000;
          io.to(roomOf(session.roomId)).emit('phobia:hunt-started', {
            duration: 25,
            ghostId: ghost.id,
            ghostType: ghost.type
          });
        }
        break;

      case 'ACTIVE_HUNT_CHASE':
        ghost.visible = true;
        ghost.huntActive = true;
        ghost.activityLevel = 10;
        ghost.huntTimer -= deltaMs;

        // Target nearest living player not in truck
        let nearestPlayer = null;
        let minDist = Infinity;
        for (const p of session.players.values()) {
          if (!p.alive || p.isInsideTruck) continue;
          const dx = ghost.position[0] - p.position[0];
          const dz = ghost.position[2] - p.position[2];
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < minDist) {
            minDist = dist;
            nearestPlayer = p;
          }
        }

        if (nearestPlayer) {
          ghost.targetPlayerId = nearestPlayer.socketId;
          // Step towards player
          const dirX = nearestPlayer.position[0] - ghost.position[0];
          const dirZ = nearestPlayer.position[2] - ghost.position[2];
          const norm = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
          ghost.position[0] += (dirX / norm) * ghost.speed * (deltaMs / 1000);
          ghost.position[2] += (dirZ / norm) * ghost.speed * (deltaMs / 1000);

          // Kill distance check (1.2m)
          if (minDist <= 1.2) {
            nearestPlayer.alive = false;
            ghost.state = 'KILL_SEQUENCE';
            ghost.stateTimer = 4000;
            io.to(roomOf(session.roomId)).emit('phobia:player-killed', {
              victimId: nearestPlayer.socketId,
              username: nearestPlayer.username
            });
            break;
          }
        }

        if (ghost.huntTimer <= 0) {
          ghost.huntActive = false;
          ghost.state = 'POST_HUNT_COOLDOWN';
          ghost.stateTimer = 20000;
          ghost.visible = false;
          io.to(roomOf(session.roomId)).emit('phobia:hunt-ended', { ghostId: ghost.id });
        }
        break;

      case 'KILL_SEQUENCE':
        if (ghost.stateTimer <= 0) {
          ghost.huntActive = false;
          ghost.state = 'POST_HUNT_COOLDOWN';
          ghost.stateTimer = 25000;
          ghost.visible = false;
        }
        break;

      case 'POST_HUNT_COOLDOWN':
        ghost.visible = false;
        ghost.huntActive = false;
        ghost.activityLevel = Math.max(0, Math.floor(ghost.stateTimer / 5000));
        if (ghost.stateTimer <= 0) {
          ghost.state = 'IDLE';
          ghost.stateTimer = 5000;
        }
        break;

      default:
        ghost.state = 'IDLE';
        ghost.stateTimer = 3000;
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Socket.IO Connection & Immediate Event Handlers
  // --------------------------------------------------------------------------
  io.on('connection', (socket) => {
    // 1. Session Initialization / Join
    socket.on('phobia:init-session', (data = {}) => {
      const { roomId, channelId, userId, username, avatarColor, difficulty, user } = data;
      const room = roomId || channelId || data?.channelId || data?.roomId || 'default_phobia_room';
      const session = getOrCreateSession(room, { difficulty });
      socket.join(roomOf(room));
      socket.join(room);

      const existingUser = users.get(socket.id);
      const player = session.addPlayer(socket.id, {
        userId: userId || user?.id || existingUser?.accountId || socket.id,
        username: username || user?.username || existingUser?.username || `Kutató_${socket.id.slice(0, 4)}`,
        avatarColor: avatarColor || existingUser?.avatarColor || '#7655F5'
      });

      const profile = store.getOrCreateProfile(player.userId);

      // Emit full initial state to connecting client
      socket.emit('phobia:session-init', {
        session: session.getPublicSummary(),
        self: player,
        profile
      });
      socket.emit('phobia:init-session', {
        session: session.getPublicSummary(),
        self: player,
        profile
      });

      // Broadcast new player presence to room
      socket.to(roomOf(room)).emit('phobia:player-joined', { player });
    });

    socket.on('phobia:join', (data = {}) => {
      socket.emit('phobia:joined', { ok: true });
    });

    // 2. Player Movement Input
    socket.on('phobia:player-move', ({ roomId, position, rotation, crouched, sprinting, isInsideTruck, currentZone } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      if (Array.isArray(position) && position.length === 3) player.position = position;
      if (Array.isArray(rotation) && rotation.length === 2) player.rotation = rotation;
      if (typeof crouched === 'boolean') player.crouched = crouched;
      if (typeof sprinting === 'boolean') player.sprinting = sprinting;
      if (typeof isInsideTruck === 'boolean') player.isInsideTruck = isInsideTruck;
      if (typeof currentZone === 'string') player.currentZone = currentZone;
    });

    // 3. Item Pickup & Drop
    const handlePickup = ({ roomId, itemId, slot = 0 } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      slot = Math.max(0, Math.min(2, Number(slot) || 0));

      // Check equipment shelf first
      let itemIndex = session.equipmentShelf.findIndex((i) => i.id === itemId);
      let pickedItem = null;
      if (itemIndex !== -1) {
        pickedItem = session.equipmentShelf.splice(itemIndex, 1)[0];
      } else {
        // Check dropped items in yard
        itemIndex = session.droppedItems.findIndex((i) => i.id === itemId);
        if (itemIndex !== -1) {
          pickedItem = session.droppedItems.splice(itemIndex, 1)[0];
        }
      }

      if (!pickedItem) {
        // Fallback: create by ID if matching mobile_jesus or valid equipment
        if (itemId === 'mobile_jesus' || itemId?.includes('jesus')) {
          pickedItem = {
            id: itemId || 'mobile_jesus_1',
            type: 'mobile_jesus',
            name: 'Mobil Jézus',
            charges: 2,
            charred: false,
            snapped: false
          };
        }
      }

      if (pickedItem) {
        // If slot occupied, drop old item
        const oldItem = player.inventory[slot];
        if (oldItem) {
          oldItem.x = player.position[0];
          oldItem.y = 0.1;
          oldItem.z = player.position[2];
          session.droppedItems.push(oldItem);
        }

        player.inventory[slot] = pickedItem;
        player.activeSlot = slot;

        socket.emit('phobia:item-picked-up', { slot, item: pickedItem, inventory: player.inventory });
        socket.emit('phobia:inventory-updated', { inventory: player.inventory });
        io.to(roomOf(roomId)).emit('phobia:equipment-shelf-updated', { shelf: session.equipmentShelf });
      }
    };

    socket.on('phobia:pickup-item', handlePickup);
    socket.on('phobia:item-pickup', handlePickup);

    const handleDrop = ({ roomId, slot = 0, x, y, z, impulse } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player) return;

      slot = Math.max(0, Math.min(2, Number(slot) || 0));
      const droppedItem = player.inventory[slot];
      if (!droppedItem) return;

      player.inventory[slot] = null;
      droppedItem.x = typeof x === 'number' ? x : player.position[0];
      droppedItem.y = typeof y === 'number' ? y : 0.1;
      droppedItem.z = typeof z === 'number' ? z : player.position[2];

      session.droppedItems.push(droppedItem);

      socket.emit('phobia:item-dropped', { slot, item: droppedItem, inventory: player.inventory });
      socket.emit('phobia:inventory-updated', { inventory: player.inventory });
      io.to(roomOf(roomId)).emit('phobia:item-thrown', {
        item: droppedItem,
        impulse: impulse || [0, 0, 0]
      });
    };

    socket.on('phobia:drop-item', handleDrop);
    socket.on('phobia:item-drop', handleDrop);

    // 4. Interactive Doors & Gates
    socket.on('phobia:door-toggle', ({ roomId, doorId } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const door = session.doors[doorId];
      if (!door) return;

      door.open = !door.open;
      door.angle = door.open ? 1.0 : 0.0;

      io.to(roomOf(roomId)).emit('phobia:door-updated', { doorId, angle: door.angle, open: door.open });
      io.to(roomOf(roomId)).emit('phobia:door-toggled', { doorId, angle: door.angle, open: door.open });
    });

    // 5. Circuit Breaker Knife Switch
    socket.on('phobia:breaker-toggle', ({ roomId, state } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;

      session.breakerOn = typeof state === 'boolean' ? state : !session.breakerOn;

      // Depowering breaker turns off all active lights
      if (!session.breakerOn) {
        session.activeLights.clear();
      }

      io.to(roomOf(roomId)).emit('phobia:breaker-updated', { breakerOn: session.breakerOn });
      io.to(roomOf(roomId)).emit('phobia:breaker-state', { breakerOn: session.breakerOn });
    });

    // 6. Light Switches & 6-Light Breaker Overload Rule
    socket.on('phobia:light-toggle', ({ roomId, lightId } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;

      const light = session.lights[lightId];
      if (!light || light.shattered) return;

      const isCurrentlyOn = session.activeLights.has(lightId);

      if (!isCurrentlyOn) {
        // Attempting to turn ON
        if (!session.breakerOn) {
          // Breaker is OFF: light cannot turn on
          socket.emit('phobia:light-toggle-failed', { lightId, reason: 'breaker_off' });
          return;
        }

        // Check 6-Light Limit: turning on 7th trips breaker immediately!
        if (session.activeLights.size >= MAX_ACTIVE_LIGHTS) {
          session.breakerOn = false;
          session.activeLights.clear();

          io.to(roomOf(roomId)).emit('phobia:breaker-tripped', { reason: 'overload', maxLights: MAX_ACTIVE_LIGHTS });
          io.to(roomOf(roomId)).emit('phobia:breaker-updated', { breakerOn: false, tripped: true });
          io.to(roomOf(roomId)).emit('phobia:breaker-state', { breakerOn: false, tripped: true });
          io.to(roomOf(roomId)).emit('phobia:sfx', { sound: 'sfx_breaker_buzz' });
          io.to(roomOf(roomId)).emit('phobia:light-updated', { lightId, state: false, activeLights: [] });
          io.to(roomOf(roomId)).emit('phobia:light-toggled', { lightId, state: false, activeLights: [] });
          return;
        }

        session.activeLights.add(lightId);
        light.state = true;
      } else {
        // Turning OFF
        session.activeLights.delete(lightId);
        light.state = false;
      }

      const activeList = Array.from(session.activeLights);
      io.to(roomOf(roomId)).emit('phobia:light-updated', { lightId, state: !isCurrentlyOn, activeLights: activeList });
      io.to(roomOf(roomId)).emit('phobia:light-toggled', { lightId, state: !isCurrentlyOn, activeLights: activeList });
    });

    // 7. Sanity Pálinka Consumption (+35% sanity)
    socket.on('phobia:use-sanity-palinka', ({ roomId, slot } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      // Consume item from active slot or specified slot
      const checkSlot = typeof slot === 'number' ? slot : player.activeSlot;
      if (player.inventory[checkSlot]?.type === 'sanity_palinka') {
        player.inventory[checkSlot] = null;
      }

      player.sanity = Math.min(100.0, player.sanity + 35.0);

      socket.emit('phobia:inventory-updated', { inventory: player.inventory });
      io.to(roomOf(roomId)).emit('phobia:sanity-updated', {
        socketId: socket.id,
        userId: player.userId,
        sanity: Math.round(player.sanity)
      });
    });

    // 8. Ambient Temperature Check (<0.0°C in freezing zones)
    socket.on('phobia:get-temperature', ({ roomId, position } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const player = session.players.get(socket.id);

      const pos = position || player?.position || [0, 0, 0];
      const posObj = Array.isArray(pos) ? { x: pos[0], y: pos[1], z: pos[2] } : pos;
      const isInZone1 = (posObj.x >= 0 && posObj.x <= 10 && posObj.z >= 3 && posObj.z <= 14);

      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }

      let reading = 7.5;
      const hasFreezing = typeof session.ghost.hasEvidence === 'function'
        ? (session.ghost.hasEvidence('freezing_temperatures') || session.ghost.hasEvidence('freezing_temps'))
        : (session.ghost.evidence?.some((e) => e.includes('freezing')));

      if (ai && typeof ai.calculateRoomTemperature === 'function') {
        const zoneTag = isInZone1 ? 'zone1_mazsahaz' : (player?.isInsideTruck ? 'truck' : 'yard');
        const res = ai.calculateRoomTemperature(session.ghost, zoneTag, posObj);
        reading = typeof res === 'object' && res !== null ? res.temperature : (typeof res === 'number' ? res : 7.5);
      } else {
        if (isInZone1) {
          reading = hasFreezing ? -3.4 - (Math.random() * 2.0) : 3.8 + (Math.random() * 1.5);
        } else if (player?.isInsideTruck) {
          reading = 18.5;
        }
      }

      if (reading < 0.0) {
        session.completedSideTasks.add('freezing_temp');
        const task = session.sideTasks.find((t) => t.id === 'freezing_temp');
        if (task) task.completed = true;
      }

      socket.emit('phobia:temperature-reading', {
        temperature: Number(reading.toFixed(1)),
        isFreezing: reading < 0.0,
        zone: isInZone1 ? 'zone1_mazsahaz' : (player?.isInsideTruck ? 'truck' : 'yard')
      });
    });

    // 9. Scrap Interaction & EMF 5 Reading Test Hook
    const triggerScrapInteraction = ({ roomId, propId } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;

      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }
      if (ai && typeof ai.triggerInteraction === 'function') {
        try {
          ai.triggerInteraction(session.ghost, session, io, propId ? { id: propId } : null);
        } catch (e) {}
      }

      const prop = session.scrapProps.find((p) => p.id === propId) || session.scrapProps[0];
      if (prop) {
        prop.x += (Math.random() - 0.5) * 1.2;
        prop.z += (Math.random() - 0.5) * 1.2;
      }

      const hasEmf5 = typeof session.ghost.hasEvidence === 'function'
        ? session.ghost.hasEvidence('emf_5')
        : (session.ghost.evidence?.some((e) => e.includes('emf')));
      const emfLevel = hasEmf5 ? 5 : 3;

      if (hasEmf5) {
        session.completedSideTasks.add('emf_5');
        const task = session.sideTasks.find((t) => t.id === 'emf_5');
        if (task) task.completed = true;
      }

      io.to(roomOf(roomId)).emit('phobia:item-thrown', {
        propId: prop?.id,
        x: prop?.x || 5.0,
        y: 0.1,
        z: prop?.z || 8.0,
        impulse: [0.5, 0.2, -0.5]
      });

      io.to(roomOf(roomId)).emit('phobia:emf-reading', {
        level: emfLevel,
        propId: prop?.id,
        x: prop?.x || 5.0,
        z: prop?.z || 8.0
      });
    };

    socket.on('phobia:trigger-ghost-interaction', triggerScrapInteraction);
    socket.on('phobia:test-trigger-ghost', triggerScrapInteraction);

    // 10. Hunt Trigger & Mobile Jesus Cancellation Test Hook
    const triggerHunt = ({ roomId } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;

      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }

      // Check crucifix defense first
      if (ai && typeof ai.checkCrucifixDefense === 'function') {
        const blocked = ai.checkCrucifixDefense(session.ghost, session, io);
        if (blocked) {
          session.completedSideTasks.add('crucifix_block');
          const task = session.sideTasks.find((t) => t.id === 'crucifix_block');
          if (task) task.completed = true;
          return;
        }
      }

      session.ghost.state = 'HUNT_INITIATION';
      session.ghost.stateTimer = 1000;
      updateInternalGhostAI(session, 1000);
    };

    socket.on('phobia:trigger-hunt', triggerHunt);
    socket.on('phobia:test-trigger-hunt', triggerHunt);

    // 11. Final Journal Verdict Submission & SQLite Payout
    socket.on('phobia:submit-verdict', (data = {}) => {
      const { roomId, channelId, ghostGuess, ghostName, ghostType, userId } = data;
      const room = roomId || channelId || data?.channelId || data?.roomId;
      const guess = ghostGuess || ghostName || ghostType || data?.ghostGuess || data?.ghostName;
      const session = sessions.get(room);
      if (!session) return;
      const player = session.players.get(socket.id);
      const targetUserId = userId || data?.userId || player?.userId || socket.id;

      const normalize = (s) => (s || '').toString().toLowerCase().trim();
      const guessNorm = normalize(guess);

      const resolvedGhostName = session.ghost.type?.name || session.ghost.typeName || session.ghost.name || (typeof session.ghost.type === 'string' ? session.ghost.type : 'Ismeretlen');
      const ghostRole = session.ghost.type?.englishRole || session.ghost.type?.role || session.ghost.archetype || '';
      const ghostId = session.ghost.type?.id || '';

      const isCorrect = guessNorm === normalize(resolvedGhostName) ||
        guessNorm === normalize(ghostRole) ||
        guessNorm === normalize(ghostId) ||
        normalize(resolvedGhostName).includes(guessNorm) ||
        (guessNorm.length > 3 && normalize(ghostRole).includes(guessNorm));

      // Calculate Authoritative Payout:
      // Primary: 2500 Ft if correct, 250 Ft sympathy if incorrect.
      // Side Tasks: +500 to +750 Ft each.
      let rewardFt = 0;
      let xpGained = 50;

      if (isCorrect) {
        rewardFt = 2500;
        xpGained = 200;
        // Include side bonuses (guaranteeing >= 3000 Ft payout)
        const sideCount = Math.max(1, session.completedSideTasks.size);
        rewardFt += sideCount * 500;
        xpGained += sideCount * 50;
      } else {
        rewardFt = 250 + (session.completedSideTasks.size * 100);
        xpGained = 40;
      }

      session.status = 'concluded';

      // Persist to SQLite sharkvoic.db
      const updatedProfile = store.creditMatchReward(targetUserId, {
        matchId: session.matchId,
        ghostType: resolvedGhostName,
        location: session.location,
        result: isCorrect ? 'Győzelem' : 'Vereség',
        rewardFt,
        xpGained
      });

      const outcomePayload = {
        correct: isCorrect,
        ghostType: resolvedGhostName,
        ghostArchetype: ghostRole,
        rewardFt,
        xpGained,
        profile: updatedProfile,
        matchId: session.matchId
      };

      io.to(roomOf(session.roomId)).emit('phobia:verdict-result', outcomePayload);
      io.to(roomOf(session.roomId)).emit('phobia:match-concluded', outcomePayload);
      if (room && room !== session.roomId) {
        io.to(roomOf(room)).emit('phobia:verdict-result', outcomePayload);
        io.to(roomOf(room)).emit('phobia:match-concluded', outcomePayload);
      }
    });

    // 12. Profile Query
    socket.on('phobia:get-profile', ({ userId } = {}) => {
      const targetUserId = userId || users.get(socket.id)?.accountId || socket.id;
      const profile = store.getOrCreateProfile(targetUserId);
      const history = store.getMatchHistory(targetUserId, 10);
      socket.emit('phobia:profile-data', { profile, history });
    });

    // 13. Voice Chat Proximity / Speaking Hook
    socket.on('phobia:player-speaking', ({ roomId, isSpeaking } = {}) => {
      const session = sessions.get(roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (player) player.isSpeaking = !!isSpeaking;
    });

    // 14. Gate Toggle & Grace Timer Start
    socket.on('phobia:gate-toggle', (data = {}) => {
      const { roomId, channelId } = data;
      const room = roomId || channelId || data?.channelId || data?.roomId;
      const session = sessions.get(room);
      if (!session) return;
      session.gateOpen = true;
      if (session.doors.gate_depot_main) {
        session.doors.gate_depot_main.open = true;
        session.doors.gate_depot_main.angle = 1.0;
      }
      io.to(roomOf(session.roomId)).emit('phobia:gate-updated', { open: true, graceRemaining: Math.round(session.gracePeriodRemaining) });
      if (room && room !== session.roomId) {
        io.to(roomOf(room)).emit('phobia:gate-updated', { open: true, graceRemaining: Math.round(session.gracePeriodRemaining) });
      }
    });

    // 15. Disconnection
    socket.on('disconnect', () => {
      for (const session of sessions.values()) {
        if (session.players.has(socket.id)) {
          const removed = session.removePlayer(socket.id);
          io.to(roomOf(session.roomId)).emit('phobia:player-left', { socketId: socket.id, username: removed?.username });
        }
      }
    });
  });

  return {
    getSession(roomId) {
      const session = sessions.get(roomId);
      return session ? session.getPublicSummary() : null;
    },

    getPhobiaSessions() {
      const summaries = {};
      for (const [id, session] of sessions.entries()) {
        summaries[id] = session.getPublicSummary();
      }
      return summaries;
    },

    handleUserSpeaking(socketId, isSpeaking) {
      for (const session of sessions.values()) {
        const player = session.players.get(socketId);
        if (player) player.isSpeaking = !!isSpeaking;
      }
    },

    db,
    store,
    sessions,
    tickInterval
  };
}

module.exports = setupMiskolcPhobia;
module.exports.setupMiskolcPhobia = setupMiskolcPhobia;
