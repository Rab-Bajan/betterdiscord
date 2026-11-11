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

// Biztonsági korlátok
const MAX_SESSIONS = 50;
const MAX_PLAYERS_PER_SESSION = 16;
const MAP_BOUNDS = { x: [-80, 80], y: [-5, 30], z: [-60, 100] };
const MAX_MOVE_SPEED = 14; // m/s (laza korlát), legalább MIN_MOVE_ALLOWANCE méter tick-enként
const MIN_MOVE_ALLOWANCE = 3;
const TRUCK_BOUNDS = { x: [-9, 1], z: [-20, -10] };
const PICKUP_RANGE = 3.0;
const DROP_RANGE = 3.0;
const THROW_RANGE = 6.0;
const MOVED_RANGE = 45.0; // eldobott tárgy legfeljebb ennyire állhat meg a játékostól
const MAX_THROW_SPEED = 20;
const RATE_LIMIT_PER_SEC = 240;
const SAFE_ID = new Set(['__proto__', 'constructor', 'prototype']);
const PHOBIA_STR_FIELDS = {
  roomId: 64, channelId: 64, channel: 64, itemId: 64, doorId: 64, lightId: 64, propId: 64,
  spotId: 64, userId: 128, username: 64, avatarColor: 16, ghostGuess: 80, ghostName: 80, ghostType: 80, currentZone: 32
};

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
    gate_depot_main: { id: 'gate_depot_main', name: 'MÉH Telep Főkapu', angle: 0.0, open: false, x: 0.0, y: 1.5, z: -5.0 },
    // A kliens térkép (ScrapYardMap) által regisztrált további ajtók, azonos azonosítókkal
    door_car_trunk_1: { id: 'door_car_trunk_1', name: 'Csomagtartó 1', angle: 0.0, open: false, x: -18.0, y: 0.8, z: 8.5 },
    door_car_trunk_2: { id: 'door_car_trunk_2', name: 'Csomagtartó 2', angle: 0.0, open: false, x: -14.0, y: 0.8, z: 15.5 },
    door_car_trunk_3: { id: 'door_car_trunk_3', name: 'Csomagtartó 3', angle: 0.0, open: false, x: -21.0, y: 0.8, z: 21.0 },
    door_mazsahaz_locker_1: { id: 'door_mazsahaz_locker_1', name: 'Mázsaház Szekrény 1', angle: 0.0, open: false, x: 16.5, y: 1.0, z: 3.5 },
    door_mazsahaz_locker_2: { id: 'door_mazsahaz_locker_2', name: 'Mázsaház Szekrény 2', angle: 0.0, open: false, x: 16.5, y: 1.0, z: 5.0 },
    door_hangar_locker_1: { id: 'door_hangar_locker_1', name: 'Hangár Szekrény 1', angle: 0.0, open: false, x: -3.5, y: 1.0, z: 24.5 },
    door_hangar_locker_2: { id: 'door_hangar_locker_2', name: 'Hangár Szekrény 2', angle: 0.0, open: false, x: -3.5, y: 1.0, z: 26.0 },
    door_sufni_1: { id: 'door_sufni_1', name: 'Sufni 1 Ajtó', angle: 0.0, open: false, x: -20.0, y: 1.0, z: 33.0 },
    door_sufni_2: { id: 'door_sufni_2', name: 'Sufni 2 Ajtó', angle: 0.0, open: false, x: -20.0, y: 1.0, z: 41.0 }
  };
}

// Light Fixtures Across the Map (Overhead lights dependent on breaker)
function createInitialLights() {
  // Az első 6 azonosító a kliens ScrapYardMap fixture-jeivel egyezik (kapcsolók: switch_*),
  // a többi a kliens által pótolt udvari lámpa (reflektor / folyosó).
  return {
    light_mazsahaz_office: { id: 'light_mazsahaz_office', name: 'Mázsaház Iroda Lámpa', state: false, shattered: false, x: 5.0, y: 2.8, z: 8.0, zone: 'zone1_mazsahaz' },
    light_hangar_flood_1: { id: 'light_hangar_flood_1', name: 'Hangár Reflektor 1', state: false, shattered: false, x: -10.0, y: 5.0, z: 12.0, zone: 'zone3_hangar' },
    light_hangar_flood_2: { id: 'light_hangar_flood_2', name: 'Hangár Reflektor 2', state: false, shattered: false, x: -15.0, y: 5.0, z: 20.0, zone: 'zone3_hangar' },
    light_hangar_catwalk: { id: 'light_hangar_catwalk', name: 'Hangár Folyosó Lámpa', state: false, shattered: false, x: -12.0, y: 4.5, z: 16.0, zone: 'zone3_hangar' },
    light_sufni_1: { id: 'light_sufni_1', name: 'Sufni Izzó 1', state: false, shattered: false, x: -12.0, y: 2.5, z: 32.0, zone: 'zone4_kutyatelep' },
    light_sufni_2: { id: 'light_sufni_2', name: 'Sufni Izzó 2', state: false, shattered: false, x: -14.0, y: 2.5, z: 32.0, zone: 'zone4_kutyatelep' },
    light_mazsahaz_hall: { id: 'light_mazsahaz_hall', name: 'Mázsaház Folyosó Lámpa', state: false, shattered: false, x: 3.0, y: 2.8, z: 5.0, zone: 'zone1_mazsahaz' },
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
      if (typeof userId !== 'string' || !userId || userId.length > 128) return null;
      let row = getProfileStmt.get(userId);
      if (!row) {
        insertProfileStmt.run(userId);
        row = getProfileStmt.get(userId);
      }
      return row;
    },

    creditMatchReward(userId, { matchId, ghostType, location, result, rewardFt, xpGained = 150 }) {
      if (typeof userId !== 'string' || !userId) return null;
      let profile = this.getOrCreateProfile(userId);
      if (!profile) return null;
      rewardFt = Number.isFinite(rewardFt) ? Math.trunc(rewardFt) : 0;
      xpGained = Number.isFinite(xpGained) ? Math.trunc(xpGained) : 0;
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
      if (typeof userId !== 'string' || !userId) return [];
      return getMatchHistoryStmt.all(userId, limit);
    }
  };
}

// ----------------------------------------------------------------------------
// PhobiaSession Class: Authoritative Session State
// ----------------------------------------------------------------------------
function sanitizeUsername(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 32);
}

function sanitizeColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '';
}

function clampNum(v, [lo, hi]) {
  return Math.min(hi, Math.max(lo, v));
}


// Rejtekhelyek (ScrapYardMap.js: fémszekrények és roncsautó csomagtartók), szerveroldali tábla
const HIDING_RANGE = 3.0;
const HIDING_SPOTS = {
  mazsahaz_locker_1: { x: 16.5, z: 3.5, type: 'locker' },
  mazsahaz_locker_2: { x: 16.5, z: 5.0, type: 'locker' },
  hangar_locker_1: { x: -3.5, z: 24.5, type: 'locker' },
  hangar_locker_2: { x: -3.5, z: 26.0, type: 'locker' },
  car_trunk_1: { x: -18.0, z: 8.5, type: 'car_trunk' },
  car_trunk_2: { x: -14.0, z: 15.5, type: 'car_trunk' },
  car_trunk_3: { x: -21.0, z: 21.0, type: 'car_trunk' }
};

// Munkamenet-beállítások
const DEFAULT_SETTINGS = { evidenceCount: 3, startingSanity: 100 };
function sanitizeSettings(raw, base = DEFAULT_SETTINGS) {
  const out = { evidenceCount: base.evidenceCount, startingSanity: base.startingSanity };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (Object.hasOwn(raw, 'evidenceCount')) {
    const n = Number(raw.evidenceCount);
    if (Number.isFinite(n)) out.evidenceCount = Math.min(3, Math.max(1, Math.round(n)));
  }
  if (Object.hasOwn(raw, 'startingSanity')) {
    const n = Number(raw.startingSanity);
    if (Number.isFinite(n)) out.startingSanity = Math.min(100, Math.max(0, Math.round(n)));
  }
  return out;
}

// Rack azonosítók (kliens) -> polc típus (szerver)
const RACK_ALIASES = {
  uv_flashlight: 'uv_light', uv: 'uv_light', emf: 'emf_reader', spiritbox: 'spirit_box',
  writing_book: 'ghost_writing_book', book: 'ghost_writing_book', palinka_flask: 'sanity_palinka', palinka: 'sanity_palinka',
  dots: 'dots_projector', smudge: 'smudge_sticks', crucifix: 'mobile_jesus', jesus: 'mobile_jesus',
  camera: 'photo_camera', thermo: 'thermometer'
};
function normalizeItemKey(id) {
  const base = String(id).toLowerCase().replace(/_\d+$/, '');
  return RACK_ALIASES[base] || base;
}
function findShelfIndex(shelf, itemId) {
  const exact = shelf.findIndex((i) => i.id === itemId);
  if (exact !== -1) return exact;
  const key = normalizeItemKey(itemId);
  return shelf.findIndex((i) => normalizeItemKey(i.id) === key || i.type === key);
}

// Célok: a szerver generálja és észleli (id = észlelési kulcs)
const OBJECTIVE_POOL = [
  { id: 'emf_5', textHu: 'Mérj EMF 5-ös szintet', rewardFt: 500 },
  { id: 'photo_ghost', textHu: 'Fotózd le a szellemet', rewardFt: 600 },
  { id: 'smudge_ghost', textHu: 'Füstölj a szellem közelében', rewardFt: 400 },
  { id: 'freezing_temp', textHu: 'Mérj fagypont alatti hőmérsékletet', rewardFt: 500 },
  { id: 'ghost_event', textHu: 'Légy szemtanúja egy szellemi eseménynek', rewardFt: 400 },
  { id: 'survive_hunt', textHu: 'Élj túl egy vadászatot', rewardFt: 700 },
  { id: 'crucifix_block', textHu: 'Háríts el egy vadászatot a Mobil Jézussal', rewardFt: 750 },
  { id: 'low_sanity', textHu: 'A csapat átlagos elmeállapota essen 25% alá', rewardFt: 500 },
  { id: 'drink_palinka', textHu: 'Idd meg a pálinkát', rewardFt: 300 },
  { id: 'ghost_writing', textHu: 'Szerezz szellemfirkát a könyvbe', rewardFt: 500 }
];
function generateObjectives(count = 3, rng = Math.random) {
  const pool = OBJECTIVE_POOL.slice();
  const out = [];
  while (out.length < count && pool.length) {
    const [o] = pool.splice(Math.floor(rng() * pool.length), 1);
    out.push({ id: o.id, textHu: o.textHu, done: false, rewardFt: o.rewardFt });
  }
  return out;
}

const worldItemView = (it) => ({
  id: it.id, type: it.type, x: it.x, y: it.y, z: it.z,
  rx: it.rx || 0, ry: it.ry || 0, rz: it.rz || 0
});

class PhobiaSession {
  constructor(roomId, options = {}) {
    this.roomId = roomId;
    this.matchId = options.matchId || `phobia_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this.lobby = options.lobby === true;
    this.status = this.lobby ? 'lobby' : 'active'; // 'lobby' | 'staging' | 'active' | 'hunting' | 'concluded'
    this.settings = sanitizeSettings(options.settings);
    this.hostSocketId = options.starterSocketId || null;
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
    this.primaryObjective = { textHu: 'Azonosítsd a szellem típusát', done: false };
    this.objectives = generateObjectives(3);
    this.photoBounties = []; // Registered photo evidence

    // Last time tick was evaluated
    this.lastTickTime = Date.now();
  }

  initGhost(archetype) {
    let ai = null;
    try { ai = require('./miskolcPhobiaAI'); } catch (e) {}
    if (ai && typeof ai.createGhostAI === 'function') {
      try {
        const extGhost = ai.createGhostAI(archetype.type, { x: 5.0, y: 0.0, z: 8.0 }, { evidenceCount: this.settings.evidenceCount });
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

    let activeEvidence = [...archetype.evidence];
    try {
      const aiMod = require('./miskolcPhobiaAI');
      if (aiMod && typeof aiMod.pickActiveEvidence === 'function') activeEvidence = aiMod.pickActiveEvidence(archetype.evidence, this.settings.evidenceCount);
    } catch (e) {}
    return {
      id: `ghost_${this.matchId}`,
      activeEvidence,
      name: archetype.type,
      type: archetype.type,
      archetype: archetype.archetype,
      evidence: [...archetype.evidence],
      hasEvidence(ev) { return this.activeEvidence.includes(ev) || (!!this.fakeEvidence && ev === this.fakeEvidence); },
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
      username: sanitizeUsername(user.username) || `Kutató_${socketId.slice(0, 4)}`,
      avatarColor: sanitizeColor(user.avatarColor) || '#7655F5',
      position: [...TRUCK_SPAWN_COORDS],
      rotation: [0.0, 0.0], // pitch, yaw
      crouched: false,
      sprinting: false,
      isSpeaking: false,
      flashlightOn: true,
      sanity: this.settings.startingSanity, // 0 to 100%
      hidingSpotId: null,
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
      channelId: this.roomId,
      matchId: this.matchId,
      status: this.status,
      settings: this.settings,
      hostSocketId: this.hostSocketId,
      active: this.status !== 'concluded',
      startedBy: this.startedBy || null,
      graceTimer: Math.max(0, Math.round(this.gracePeriodRemaining)),
      gateOpen: this.gateOpen,
      lights: Object.fromEntries(Object.entries(this.lights).map(([k, v]) => [k, { x: v.x, y: v.y, z: v.z, zone: v.zone, shattered: v.shattered, state: !!v.state }])),
      location: this.location,
      difficulty: this.difficulty,
      graceRemaining: Math.max(0, Math.round(this.gracePeriodRemaining)),
      breakerOn: this.breakerOn,
      activeLights: Array.from(this.activeLights),
      doors: Object.fromEntries(Object.entries(this.doors).map(([k, v]) => [k, { open: v.open, angle: v.angle }])),
      equipmentShelf: this.equipmentShelf,
      droppedItems: this.droppedItems,
      scrapProps: this.scrapProps,
      primaryObjective: this.primaryObjective,
      objectives: this.objectives,
      playerCount: this.players.size,
      players: Array.from(this.players.values()).map((p) => ({
        id: p.socketId,
        socketId: p.socketId,
        userId: p.userId,
        username: p.username,
        avatarColor: p.avatarColor,
        position: p.position,
        rotation: p.rotation,
        sanity: Math.round(p.sanity),
        alive: p.alive,
        hidingSpotId: p.hidingSpotId || null,
        isSpeaking: !!p.isSpeaking,
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

  // Teszt-hátsóajtók: csak PHOBIA_TEST_HOOKS=1 ÉS teszt szoba azonosító mellett
  const TEST_ROOM_RE = /^(e2e_test|test_room_)/;
  function isTestRoomId(roomId) {
    return typeof roomId === 'string' && TEST_ROOM_RE.test(roomId);
  }
  function testHooksEnabled(roomId) {
    return process.env.PHOBIA_TEST_HOOKS === '1' && isTestRoomId(roomId);
  }

  // Szerveroldali identitás: a fiók azonosítója; csak teszt hookkal engedett a kliens userId
  function identityOf(socket, roomId, payloadUserId) {
    const acc = users.get(socket.id)?.accountId;
    if (typeof acc === 'string' && acc) return acc;
    if (Number.isInteger(acc)) return String(acc);
    if (testHooksEnabled(roomId) && typeof payloadUserId === 'string' && payloadUserId && payloadUserId.length <= 128) return payloadUserId;
    return socket.id;
  }

  // A kezdeményező (vagy ha már nincs bent, bármely tag) állíthatja le / indíthatja újra
  function isStarterOrOrphan(session, socket) {
    if (session.starterSocketId === socket.id) return true;
    const acc = users.get(socket.id)?.accountId;
    if (acc && session.starterAccountId && String(acc) === session.starterAccountId) return true;
    return !session.starterSocketId || !session.players.has(session.starterSocketId);
  }

  function roomOf(roomId) {
    return `phobia:${roomId}`;
  }

  function broadcastSessionState(roomId) {
    const session = sessions.get(roomId);
    // Csak a csatorna (hangszoba) és a játékosok szobájába, nem az egész szerverre
    io.to(roomId).to(roomOf(roomId)).emit('phobia:session-updated', { channelId: roomId, state: session ? session.getPublicSummary() : null });
  }

  function getOrCreateSession(roomId, options = {}) {
    if (!roomId) roomId = 'default_phobia_room';
    let session = sessions.get(roomId);
    // Lezárt meccs után az új belépő új küldetést kap (különben a szoba örökre "concluded" maradna)
    if (session && session.status === 'concluded' && (options.newMatch || session.players.size === 0)) {
      const hadPlayers = session.players.size > 0;
      sessions.delete(roomId);
      session = null;
      // A régi meccsben maradt játékosok értesítése: újracsatlakozhatnak az új munkamenethez
      if (hadPlayers) {
        io.to(roomOf(roomId)).emit('phobia:session-reset', { roomId, channelId: roomId, reason: 'new_match' });
        io.in(roomOf(roomId)).socketsLeave(roomOf(roomId));
      }
    }
    if (!session) {
      if (sessions.size >= MAX_SESSIONS) return null;
      session = new PhobiaSession(roomId, options);
      session.startedBy = options.startedBy || null;
      session.starterSocketId = options.starterSocketId || null;
      session.starterAccountId = options.starterAccountId || null;
      session.paidOut = new Set();
      session.broadcast = (eventName, payload) => {
        detectObjectiveFromEvent(session, eventName, payload);
        io.to(roomOf(roomId)).emit(eventName, payload);
        if (eventName === 'phobia:item-thrown' && payload && typeof payload.itemId === 'string' && !payload.actorSocketId) emitGhostThrow(session, payload);
      };
      sessions.set(roomId, session);
      broadcastSessionState(roomId);
    }
    return session;
  }

  // --- Célok: szerveroldali észlelés ---
  function emitObjectives(session) {
    io.to(roomOf(session.roomId)).emit('phobia:objectives-updated', {
      primary: session.primaryObjective,
      objectives: session.objectives
    });
  }

  function completeObjective(session, id) {
    const obj = session.objectives.find((o) => o.id === id);
    if (!obj || obj.done) return false;
    obj.done = true;
    emitObjectives(session);
    return true;
  }

  function detectObjectiveFromEvent(session, eventName, payload) {
    if (!session || session.lobby && session.status === 'lobby') return;
    switch (eventName) {
      case 'phobia:emf-reading':
        if (payload && payload.level >= 5) completeObjective(session, 'emf_5');
        break;
      case 'phobia:ghost-event': completeObjective(session, 'ghost_event'); break;
      case 'phobia:ghost-writing': completeObjective(session, 'ghost_writing'); break;
      case 'phobia:hunt-cancelled':
        if (payload && payload.reason === 'crucifix') completeObjective(session, 'crucifix_block');
        break;
      case 'phobia:hunt-started':
        session.huntAliveAtStart = Array.from(session.players.values()).filter((p) => p.alive).map((p) => p.socketId);
        break;
      case 'phobia:hunt-ended': {
        const start = session.huntAliveAtStart || [];
        const survivors = start.filter((sid) => session.players.get(sid)?.alive);
        if (survivors.length > 0) completeObjective(session, 'survive_hunt');
        session.huntAliveAtStart = null;
        break;
      }
      default: break;
    }
  }

  // Szellem dobás: a szerver tárolt transzformját és a világ-esemény küldése (a tényleges nyugvó pozíciót a kliensek item-moved-dal jelzik)
  function emitGhostThrow(session, payload) {
    const it = session.scrapProps.find((p) => p.id === payload.itemId) || session.droppedItems.find((i) => i.id === payload.itemId);
    if (!it) return;
    io.to(roomOf(session.roomId)).emit('phobia:world-item-updated', { action: 'moved', item: worldItemView(it), actorSocketId: null, impulse: payload.impulse });
  }

  // Kilépés a játékból (nézetváltás / bezárás): a játékos eltávolítása, üres munkamenet törlése
  function leaveSession(socket, roomId) {
    const session = sessions.get(roomId);
    if (!session || !session.players.has(socket.id)) return;
    const removed = session.removePlayer(socket.id);
    socket.leave(roomOf(roomId));
    io.to(roomOf(roomId)).emit('phobia:player-left', { socketId: socket.id, username: removed?.username });
    if (session.players.size === 0) {
      sessions.delete(roomId);
    } else if (session.hostSocketId === socket.id) {
      session.hostSocketId = session.players.keys().next().value;
      io.to(roomOf(roomId)).emit('phobia:settings-updated', { settings: session.settings, hostSocketId: session.hostSocketId });
    }
    broadcastSessionState(roomId);
  }

  // Csak a munkamenetben lévő játékos módosíthatja annak állapotát
  function memberSession(socket, roomId) {
    const session = sessions.get(roomId);
    if (!session || !session.players.has(socket.id)) return null;
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

      const inLobby = session.status === 'lobby';

      // 1. Preparation Grace Period Countdown
      if (!inLobby && session.gracePeriodRemaining > 0 && session.gateOpen) {
        session.gracePeriodRemaining -= deltaMs / 1000;
        if (session.gracePeriodRemaining < 0) session.gracePeriodRemaining = 0;
      }

      // 2. Sanity Drain Simulation
      for (const player of inLobby ? [] : session.players.values()) {
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
      if (inLobby) {
        // Előszoba: nincs szellem-MI, vadászat és józanság-fogyás
      } else if (ai && typeof ai.updateGhostAI === 'function') {
        try {
          ai.updateGhostAI(session.ghost, session, deltaMs, io);
        } catch (err) {
          updateInternalGhostAI(session, deltaMs);
        }
      } else {
        updateInternalGhostAI(session, deltaMs);
      }

      if (!inLobby) {
        const alive = Array.from(session.players.values()).filter((p) => p.alive);
        if (alive.length && alive.reduce((a, p) => a + p.sanity, 0) / alive.length < 25) completeObjective(session, 'low_sanity');
      }

      // 4. Broadcast 12 Hz State Delta
      const tickPayload = {
        tick: session.tickCount,
        timestamp: now,
        graceRemaining: Math.round(session.gracePeriodRemaining),
        graceTimer: Math.round(session.gracePeriodRemaining),
        gateOpen: session.gateOpen,
        status: session.status,
        breakerOn: session.breakerOn,
        breaker: { isOn: session.breakerOn },
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
          username: p.username,
          avatarColor: p.avatarColor,
          flashlightOn: p.flashlightOn,
          isSpeaking: !!p.isSpeaking,
          isInsideTruck: p.isInsideTruck,
          x: p.position[0],
          y: p.position[1],
          z: p.position[2],
          pitch: p.rotation[0],
          yaw: p.rotation[1],
          sanity: Math.round(p.sanity),
          crouched: p.crouched,
          sprinting: p.sprinting,
          alive: p.alive,
          hidingSpotId: p.hidingSpotId || null,
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
          session.broadcast('phobia:hunt-cancelled', {
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
          session.broadcast('phobia:hunt-started', {
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
          if (!p.alive || p.isInsideTruck || p.hidden) continue;
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
              playerId: nearestPlayer.socketId,
              userId: nearestPlayer.userId,
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
          session.broadcast('phobia:hunt-ended', { ghostId: ghost.id });
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
    // 0. Védelem: csak sima objektum payload, típusellenőrzött azonosítók, sebességkorlát
    let rlWindowStart = Date.now();
    let rlCount = 0;
    socket.use((packet, next) => {
      const ev = packet[0];
      if (typeof ev !== 'string' || !ev.startsWith('phobia:')) return next();
      const now = Date.now();
      if (now - rlWindowStart >= 1000) { rlWindowStart = now; rlCount = 0; }
      if (++rlCount > RATE_LIMIT_PER_SEC) return next(new Error('rate_limited'));
      const data = packet[1];
      if (data === undefined) return next();
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return next(new Error('invalid_payload'));
      for (const [key, max] of Object.entries(PHOBIA_STR_FIELDS)) {
        if (!Object.hasOwn(data, key)) continue;
        const v = data[key];
        if (v !== undefined && (typeof v !== 'string' || v.length > max)) return next(new Error('invalid_payload'));
      }
      if (Object.hasOwn(data, 'slot') && data.slot !== undefined && !(Number.isInteger(data.slot) && data.slot >= 0 && data.slot <= 2)) {
        return next(new Error('invalid_payload'));
      }
      if (Object.hasOwn(data, 'user') && data.user !== undefined && (data.user === null || typeof data.user !== 'object' || Array.isArray(data.user))) {
        return next(new Error('invalid_payload'));
      }
      next();
    });

    // 1. Session Initialization / Join
    socket.on('phobia:init-session', (data = {}) => {
      const { userId, username, difficulty, user } = data;
      const room = data.roomId || data.channelId || 'default_phobia_room';
      const rawName = typeof username === 'string' ? username : (typeof user?.username === 'string' ? user.username : '');
      const rawColor = typeof data.avatarColor === 'string' ? data.avatarColor : users.get(socket.id)?.avatarColor;
      const diff = ['Amateur', 'Intermediate', 'Professional'].includes(difficulty) ? difficulty : undefined;

      // newMatch csak a lezárt meccs tagjától (vagy üres szobában) fogadható el
      const existing = sessions.get(room);
      const newMatch = !!data.newMatch && (!existing || existing.players.size === 0 || existing.players.has(socket.id));
      const session = getOrCreateSession(room, {
        difficulty: diff,
        lobby: data.lobby === true,
        settings: data.settings,
        newMatch,
        startedBy: sanitizeUsername(rawName) || null,
        starterSocketId: socket.id,
        starterAccountId: users.get(socket.id)?.accountId ? String(users.get(socket.id).accountId) : null
      });
      if (!session) { socket.emit('phobia:error', { reason: 'session_limit' }); return; }

      let player = session.players.get(socket.id);
      if (!player) {
        if (session.players.size >= MAX_PLAYERS_PER_SESSION) { socket.emit('phobia:error', { reason: 'session_full' }); return; }
        socket.join(roomOf(room));
        const existingUser = users.get(socket.id);
        player = session.addPlayer(socket.id, {
          userId: identityOf(socket, room, userId),
          username: rawName || existingUser?.username || `Kutató_${socket.id.slice(0, 4)}`,
          avatarColor: rawColor || existingUser?.avatarColor || '#7655F5'
        });
        socket.to(roomOf(room)).emit('phobia:player-joined', { player });
      } else {
        socket.join(roomOf(room));
      }

      const profile = store.getOrCreateProfile(player.userId);

      // Emit full initial state to connecting client
      socket.emit('phobia:session-init', {
        session: session.getPublicSummary(),
        self: player,
        profile
      });

      broadcastSessionState(room);
    });

    // Szoba-szintű indítás / leállítás (useRoomActivities): a munkamenet létrehozása, ill. lezárása
    socket.on('phobia:start-session', (data = {}) => {
      const room = data.roomId || data.channelId || data.channel;
      if (!room) return;
      // Aktív meccsbe csak annak tagja / kezdeményezője nyúlhat bele
      const existing = sessions.get(room);
      if (existing && existing.status !== 'concluded' && existing.players.size > 0) {
        if (!existing.players.has(socket.id) || !isStarterOrOrphan(existing, socket)) return;
      } else if (existing && existing.players.size > 0 && !existing.players.has(socket.id)) {
        return;
      }
      const created = getOrCreateSession(room, {
        newMatch: true,
        startedBy: sanitizeUsername(data.username) || null,
        starterSocketId: socket.id,
        starterAccountId: users.get(socket.id)?.accountId ? String(users.get(socket.id).accountId) : null
      });
      if (!created) { socket.emit('phobia:error', { reason: 'session_limit' }); return; }
      broadcastSessionState(room);
    });

    socket.on('phobia:stop-session', (data = {}) => {
      const room = data.roomId || data.channelId || data.channel;
      const session = room && sessions.get(room);
      if (!session) return;
      if (!session.players.has(socket.id) || !isStarterOrOrphan(session, socket)) return;
      for (const sid of Array.from(session.players.keys())) session.removePlayer(sid);
      io.to(roomOf(room)).emit('phobia:player-left', { socketId: null, stopped: true });
      io.in(roomOf(room)).socketsLeave(roomOf(room));
      sessions.delete(room);
      broadcastSessionState(room);
    });

    socket.on('phobia:leave-session', (data = {}) => {
      const room = data.roomId || data.channelId;
      if (room) leaveSession(socket, room);
    });

    socket.on('phobia:flashlight-toggle', ({ roomId, on } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      player.flashlightOn = typeof on === 'boolean' ? on : !player.flashlightOn;
    });

    socket.on('phobia:join', (data = {}) => {
      socket.emit('phobia:joined', { ok: true });
    });

    // 2. Player Movement Input
    socket.on('phobia:player-move', ({ roomId, position, rotation, crouched, sprinting, isInsideTruck, hidden, currentZone } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      const now = Date.now();
      if (Array.isArray(position) && position.length === 3 && position.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        let np = [
          clampNum(position[0], MAP_BOUNDS.x),
          clampNum(position[1], MAP_BOUNDS.y),
          clampNum(position[2], MAP_BOUNDS.z)
        ];
        if (!testHooksEnabled(roomId)) {
          // Laza sebességkorlát: a megengedett távolságnál messzebbre nem ugorhat
          const dt = Math.min(2, Math.max(0, (now - (player.lastMoveAt || now)) / 1000));
          const maxDist = Math.max(MIN_MOVE_ALLOWANCE, MAX_MOVE_SPEED * dt);
          const dx = np[0] - player.position[0];
          const dz = np[2] - player.position[2];
          const d = Math.hypot(dx, dz);
          if (d > maxDist) {
            np = [player.position[0] + (dx / d) * maxDist, np[1], player.position[2] + (dz / d) * maxDist];
          }
        }
        player.position = np;
        player.lastMoveAt = now;
      }
      if (Array.isArray(rotation) && rotation.length === 2 && rotation.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        player.rotation = [clampNum(rotation[0], [-Math.PI, Math.PI]), ((rotation[1] % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)];
      }
      if (typeof crouched === 'boolean') player.crouched = crouched;
      if (typeof sprinting === 'boolean') player.sprinting = sprinting;
      if (typeof hidden === 'boolean') player.hidden = hidden || !!player.hidingSpotId;
      // A teherautóban tartózkodás a szerver által ismert zónából / pozícióból származik
      if (typeof isInsideTruck === 'boolean') {
        const px = player.position[0];
        const pz = player.position[2];
        const inTruckBounds = px >= TRUCK_BOUNDS.x[0] && px <= TRUCK_BOUNDS.x[1] && pz >= TRUCK_BOUNDS.z[0] && pz <= TRUCK_BOUNDS.z[1];
        player.isInsideTruck = isInsideTruck && inTruckBounds;
      }
      if (typeof currentZone === 'string' && Object.hasOwn(MAP_ZONES, currentZone)) player.currentZone = currentZone;
      // Elhagyta a rejtekhelyet: a rejtőzés megszűnik
      if (player.hidingSpotId) {
        const spot = HIDING_SPOTS[player.hidingSpotId];
        if (!spot || Math.hypot(spot.x - player.position[0], spot.z - player.position[2]) > HIDING_RANGE) {
          const left = player.hidingSpotId;
          player.hidingSpotId = null;
          player.hidden = false;
          io.to(roomOf(roomId)).emit('phobia:player-hide', { socketId: socket.id, spotId: left, hidden: false });
        }
      }
    });

    // Rejtőzés: szerveroldali rejtekhely-tábla, élő játékos, 3 m-en belül
    socket.on('phobia:hide', ({ roomId, spotId, hidden } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session || session.status === 'lobby' || session.status === 'concluded') return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive || typeof hidden !== 'boolean') return;
      if (typeof spotId !== 'string' || SAFE_ID.has(spotId) || !Object.hasOwn(HIDING_SPOTS, spotId)) return;
      const spot = HIDING_SPOTS[spotId];
      if (hidden) {
        if (Math.hypot(spot.x - player.position[0], spot.z - player.position[2]) > HIDING_RANGE) return;
        for (const other of session.players.values()) {
          if (other !== player && other.hidingSpotId === spotId) return;
        }
        player.hidingSpotId = spotId;
        player.hidden = true;
      } else {
        if (player.hidingSpotId !== spotId) return;
        player.hidingSpotId = null;
        player.hidden = false;
      }
      player.seenEnteringHide = false;
      io.to(roomOf(roomId)).emit('phobia:player-hide', { socketId: socket.id, spotId, hidden });
    });

    // Előszoba: beállítások (csak házigazda) és meccs indítás
    socket.on('phobia:update-settings', ({ roomId, settings } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session || session.status !== 'lobby' || session.hostSocketId !== socket.id) return;
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
      session.settings = sanitizeSettings(settings, session.settings);
      io.to(roomOf(roomId)).emit('phobia:settings-updated', { settings: session.settings, hostSocketId: session.hostSocketId });
      broadcastSessionState(roomId);
    });

    socket.on('phobia:start-match', ({ roomId } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session || session.status !== 'lobby' || session.hostSocketId !== socket.id) return;
      session.status = 'active';
      session.lastTickTime = Date.now();
      session.ghost = session.initGhost(session.ghostArchetype);
      for (const p of session.players.values()) p.sanity = session.settings.startingSanity;
      for (const [sid, p] of session.players) {
        io.to(sid).emit('phobia:session-init', {
          session: session.getPublicSummary(),
          self: p,
          profile: store.getOrCreateProfile(p.userId)
        });
      }
      emitObjectives(session);
      broadcastSessionState(roomId);
    });

    // 3. Item Pickup & Drop
    const handlePickup = ({ roomId, itemId, slot = 0 } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      if (typeof itemId !== 'string' || itemId.length > 64) return;
      if (!Number.isInteger(slot) || slot < 0 || slot > 2) return;

      // Hatótávolság-ellenőrzés (a felszerelés-polc a teherautóban van, ahol a játékos spawnol)
      const inRange = (it) => {
        if (typeof it.x !== 'number' || typeof it.z !== 'number') return true;
        return Math.hypot(it.x - player.position[0], it.z - player.position[2]) <= PICKUP_RANGE;
      };

      // Check equipment shelf first
      let itemIndex = findShelfIndex(session.equipmentShelf, itemId);
      let pickedItem = null;
      if (itemIndex !== -1) {
        if (!inRange(session.equipmentShelf[itemIndex])) return;
        pickedItem = session.equipmentShelf.splice(itemIndex, 1)[0];
      } else {
        // Check dropped items in yard
        itemIndex = session.droppedItems.findIndex((i) => i.id === itemId);
        if (itemIndex !== -1) {
          if (!inRange(session.droppedItems[itemIndex])) return;
          pickedItem = session.droppedItems.splice(itemIndex, 1)[0];
          io.to(roomOf(roomId)).emit('phobia:world-item-updated', { action: 'removed', item: worldItemView(pickedItem), actorSocketId: socket.id });
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
          io.to(roomOf(roomId)).emit('phobia:world-item-updated', { action: 'spawned', item: worldItemView(oldItem), actorSocketId: socket.id });
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
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player) return;

      if (!Number.isInteger(slot) || slot < 0 || slot > 2) return;
      const droppedItem = player.inventory[slot];
      if (!droppedItem) return;

      // A koordináták a játékos közelére korlátozottak; az impulzus véges, kis vektor
      const near = (v, base, range) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(base + range, Math.max(base - range, v)) : base);
      const safeImpulse = Array.isArray(impulse) && impulse.length === 3 && impulse.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? impulse.map((n) => Math.min(20, Math.max(-20, n)))
        : [0, 0, 0];

      player.inventory[slot] = null;
      droppedItem.x = near(x, player.position[0], DROP_RANGE);
      droppedItem.y = typeof y === 'number' && Number.isFinite(y) ? Math.min(3, Math.max(0, y)) : 0.1;
      droppedItem.z = near(z, player.position[2], DROP_RANGE);

      session.droppedItems.push(droppedItem);
      io.to(roomOf(roomId)).emit('phobia:world-item-updated', { action: 'spawned', item: worldItemView(droppedItem), actorSocketId: socket.id });

      socket.emit('phobia:item-dropped', { slot, item: droppedItem, inventory: player.inventory });
      socket.emit('phobia:inventory-updated', { inventory: player.inventory });
      io.to(roomOf(roomId)).emit('phobia:item-thrown', {
        item: droppedItem,
        impulse: safeImpulse
      });
    };

    socket.on('phobia:drop-item', handleDrop);
    socket.on('phobia:item-drop', handleDrop);

    // Kliens oldali eldobás (EnvironmentalPhysics): tulajdonosi és sebességkorlát, majd szétküldés a többieknek
    let lastThrowAt = 0;
    socket.on('phobia:item-thrown', ({ roomId, itemId, position, velocity } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || player.alive === false) return;
      if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > PHOBIA_STR_FIELDS.itemId || SAFE_ID.has(itemId)) return;

      const isVec = (v) => v && typeof v === 'object' && ['x', 'y', 'z'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
      if (!isVec(position) || !isVec(velocity)) return;

      // Csak a játékosnál lévő, a szobában eldobott vagy a szobához tartozó tárgy dobható
      const known = player.inventory.some((i) => i && i.id === itemId)
        || session.droppedItems.some((i) => i.id === itemId)
        || session.scrapProps.some((p) => p.id === itemId);
      if (!known) return;

      const now = Date.now();
      if (now - lastThrowAt < 100) return;
      lastThrowAt = now;

      const near = (v, base, range) => Math.min(base + range, Math.max(base - range, v));
      const mag = Math.hypot(velocity.x, velocity.y, velocity.z);
      const k = mag > MAX_THROW_SPEED ? MAX_THROW_SPEED / mag : 1;

      socket.to(roomOf(roomId)).emit('phobia:item-thrown', {
        propId: itemId,
        x: near(position.x, player.position[0], THROW_RANGE),
        y: clampNum(position.y, MAP_BOUNDS.y),
        z: near(position.z, player.position[2], THROW_RANGE),
        impulse: [velocity.x * k, velocity.y * k, velocity.z * k]
      });
    });

    // Nyugalomba került eldobott / eldobott tárgy: a szerver tárolja az utolsó transzformot (késői csatlakozóknak)
    let lastMovedAt = 0;
    socket.on('phobia:item-moved', ({ roomId, itemId, position, rotation } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session || session.status === 'lobby') return;
      const player = session.players.get(socket.id);
      if (!player || player.alive === false) return;
      if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > PHOBIA_STR_FIELDS.itemId || SAFE_ID.has(itemId)) return;
      const isVec = (v) => v && typeof v === 'object' && ['x', 'y', 'z'].every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
      if (!isVec(position) || !isVec(rotation)) return;
      const item = session.droppedItems.find((i) => i.id === itemId) || session.scrapProps.find((p) => p.id === itemId);
      if (!item) return;
      const now = Date.now();
      if (now - lastMovedAt < 20) return;
      lastMovedAt = now;
      const px = clampNum(position.x, MAP_BOUNDS.x);
      const pz = clampNum(position.z, MAP_BOUNDS.z);
      if (Math.hypot(px - player.position[0], pz - player.position[2]) > MOVED_RANGE) return;
      item.x = px;
      item.y = clampNum(position.y, MAP_BOUNDS.y);
      item.z = pz;
      item.rx = rotation.x; item.ry = rotation.y; item.rz = rotation.z;
      io.to(roomOf(roomId)).emit('phobia:world-item-updated', { action: 'moved', item: worldItemView(item), actorSocketId: socket.id });
    });

    // 4. Interactive Doors & Gates
    socket.on('phobia:door-toggle', ({ roomId, doorId } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      if (typeof doorId !== 'string' || SAFE_ID.has(doorId) || !Object.hasOwn(session.doors, doorId)) return;
      const door = session.doors[doorId];

      door.open = !door.open;
      door.angle = door.open ? 1.0 : 0.0;

      io.to(roomOf(roomId)).emit('phobia:door-updated', { doorId, angle: door.angle, open: door.open });
      io.to(roomOf(roomId)).emit('phobia:door-toggled', { doorId, angle: door.angle, open: door.open });
    });

    // 5. Circuit Breaker Knife Switch
    socket.on('phobia:breaker-toggle', ({ roomId, state } = {}) => {
      const session = memberSession(socket, roomId);
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
      const session = memberSession(socket, roomId);
      if (!session) return;

      if (typeof lightId !== 'string' || SAFE_ID.has(lightId) || !Object.hasOwn(session.lights, lightId)) return;
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
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      // Consume item from active slot or specified slot
      const checkSlot = Number.isInteger(slot) && slot >= 0 && slot <= 2 ? slot : player.activeSlot;
      if (player.inventory[checkSlot]?.type === 'sanity_palinka') {
        player.inventory[checkSlot] = null;
      } else {
        // Client may hold the item without the server having seen a pickup: fall back to any palinka slot
        const idx = player.inventory.findIndex((i) => i && i.type === 'sanity_palinka');
        if (idx === -1) return;
        player.inventory[idx] = null;
      }

      player.sanity = Math.min(100.0, player.sanity + 35.0);
      completeObjective(session, 'drink_palinka');

      socket.emit('phobia:inventory-updated', { inventory: player.inventory });
      io.to(roomOf(roomId)).emit('phobia:sanity-updated', {
        socketId: socket.id,
        userId: player.userId,
        sanity: Math.round(player.sanity)
      });
    });


    // 7b. Smudge Sticks: blinds the ghost for 5s and delays hunts (90s, Demon 60s)
    socket.on('phobia:use-smudge', ({ roomId, slot } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session || session.status === 'concluded') return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive) return;

      const checkSlot = Number.isInteger(slot) && slot >= 0 && slot <= 2 ? slot : player.activeSlot;
      let item = player.inventory[checkSlot];
      if (!item || item.type !== 'smudge_sticks') {
        // Client may hold the item without the server having seen a pickup: fall back to any smudge slot
        const idx = player.inventory.findIndex((i) => i && i.type === 'smudge_sticks');
        if (idx === -1) return;
        item = player.inventory[idx];
        player.inventory[idx] = null;
      } else {
        player.inventory[checkSlot] = null;
      }

      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }
      const ghost = session.ghost;
      let result = null;
      if (ai && typeof ai.applySmudgeSticks === 'function' && ghost.type && typeof ghost.type === 'object') {
        try { result = ai.applySmudgeSticks(ghost, player, session, io); } catch (e) {}
      }
      if (!result) {
        // Internal fallback ghost model
        const isDemon = ghost.archetype === 'Démon' || ghost.type === 'Raffael Dzsenifer';
        const roamDelay = isDemon ? 60 : 90;
        ghost.smudgeBlindedTimer = 5.0;
        ghost.huntBlockedBySmudgeUntil = Date.now() + roamDelay * 1000;
        result = { blinded: true, duration: 5.0, roamDelay };
      }

      const sg = session.ghost;
      const sgx = typeof sg.x === 'number' ? sg.x : sg.position?.[0];
      const sgz = typeof sg.z === 'number' ? sg.z : sg.position?.[2];
      if (typeof sgx === 'number' && typeof sgz === 'number' && Math.hypot(sgx - player.position[0], sgz - player.position[2]) <= 8) {
        completeObjective(session, 'smudge_ghost');
      }

      socket.emit('phobia:inventory-updated', { inventory: player.inventory });
      io.to(roomOf(roomId)).emit('phobia:smudge-used', {
        socketId: socket.id,
        userId: player.userId,
        duration: result.duration,
        roamDelay: result.roamDelay
      });
    });

    // 7c. Photo capture: stored server-side as a bounty record, echoed to the room
    const PHOTO_BOUNTY = { ghost: 1000, fingerprint: 500, orb: 500, writing: 500, dots: 750, generic: 100 };
    socket.on('phobia:photo-captured', ({ roomId, photo } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session || session.status === 'concluded') return;
      const player = session.players.get(socket.id);
      if (!player || !player.alive || !photo || typeof photo !== 'object') return;
      // Reject oversized payloads (the client strips images, but never trust it)
      let size = 0;
      try { size = JSON.stringify(photo).length; } catch (e) { return; }
      if (size > 200 * 1024) return;
      if (session.photoBounties.length >= 100) return;

      const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : '');
      const subject = str(photo.subject || photo.labelHu || photo.label, 80) || 'Fotó';
      const claim = `${subject} ${str(photo.kind || photo.evidenceType || photo.type, 24)}`.toLowerCase();

      // Authoritative check: the ghost must currently be visible, within 20 m and in front of the camera
      let ghostInFrame = false;
      const g = session.ghost;
      const gx = typeof g.x === 'number' ? g.x : g.position?.[0];
      const gz = typeof g.z === 'number' ? g.z : g.position?.[2];
      if (g.visible && typeof gx === 'number' && typeof gz === 'number') {
        const dx = gx - player.position[0];
        const dz = gz - player.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        const yaw = Number(player.rotation?.[1]) || 0;
        const facing = dist > 0.001 ? ((-Math.sin(yaw)) * dx + (-Math.cos(yaw)) * dz) / dist : 1;
        ghostInFrame = dist <= 20 && facing > 0.75;
      }

      // Prefer an explicit, valid client kind; evidence/ghost-in-frame are still verified server-side
      const claimedKind = ['ghost', 'fingerprint', 'orb', 'other'].includes(photo.kind) ? photo.kind : null;
      const wantsFingerprint = claimedKind ? claimedKind === 'fingerprint' : /ujjlenyomat|fingerprint|l[aá]bnyom/.test(claim);
      const wantsOrb = claimedKind ? claimedKind === 'orb' : /orb|g[oö]mb/.test(claim);
      let kind = 'generic';
      if (ghostInFrame) kind = 'ghost';
      else if (wantsFingerprint && session.ghost.evidence?.includes?.('fingerprints')) kind = 'fingerprint';
      else if (wantsOrb && session.ghost.evidence?.includes?.('ghost_orbs')) kind = 'orb';
      const reward = PHOTO_BOUNTY[kind];

      const record = {
        id: `photo_${session.photoBounties.length + 1}`,
        userId: player.userId,
        username: player.username,
        kind,
        ghostInFrame,
        subject,
        reward,
        timestamp: Date.now()
      };
      session.photoBounties.push(record);

      if (ghostInFrame) {
        completeObjective(session, 'photo_ghost');
        session.completedSideTasks.add('photo_ghost');
        let task = session.sideTasks.find((t) => t.id === 'photo_ghost');
        if (!task) {
          task = { id: 'photo_ghost', desc: 'Fotózd le a szellemet a kamerával', reward: 500, completed: false };
          session.sideTasks.push(task);
        }
        task.completed = true;
      }

      io.to(roomOf(roomId)).emit('phobia:photo-taken', {
        id: record.id,
        subject,
        reward,
        kind,
        ghostInFrame,
        takenBy: player.username
      });
    });

    // 8. Ambient Temperature Check (<0.0°C in freezing zones)
    socket.on('phobia:get-temperature', ({ roomId, position } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      const player = session.players.get(socket.id);

      const pos = player.position;
      const posObj = { x: pos[0], y: pos[1], z: pos[2] };
      const isInZone1 = (posObj.x >= 0 && posObj.x <= 10 && posObj.z >= 3 && posObj.z <= 14);

      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }

      const isTestRoom = testHooksEnabled(roomId);
      const evList = Array.isArray(session.ghost.evidence) ? session.ghost.evidence : [];
      const hasFreezing = isTestRoom || (typeof session.ghost.hasEvidence === 'function'
        ? (session.ghost.hasEvidence('freezing_temperatures') || session.ghost.hasEvidence('freezing_temps'))
        : evList.some((e) => String(e).includes('freezing')));
      const zoneTag = player?.isInsideTruck ? 'truck' : (isInZone1 ? 'zone1_mazsahaz' : (player?.currentZone || 'yard'));
      const jitter = (Math.random() - 0.5) * 0.6;
      let reading;
      if (zoneTag === 'truck') {
        reading = 18.0 + jitter;
      } else {
        // Alap udvari hőmérséklet 8–12 °C (zónánként kissé eltér)
        const ZONE_BASE = { zone1_mazsahaz: 9.0, zone2_roncsdomb: 10.5, zone3_hangar: 8.5, zone4_kutyatelep: 9.5, zone5_ocskavas: 10.0, yard: 10.0 };
        reading = (ZONE_BASE[zoneTag] ?? 10.0) + jitter;
        // Fagypont alatt csak fagyos szellem közelében (kedvenc szoba / szellem pozíciója)
        const gp = session.ghost.position || [session.ghost.x, session.ghost.y, session.ghost.z];
        const dxg = posObj.x - (gp[0] ?? 5.0);
        const dzg = posObj.z - (gp[2] ?? 8.0);
        const nearGhost = Math.hypot(dxg, dzg) <= 9.0;
        const inFavorite = session.ghost.favoriteRoom ? session.ghost.favoriteRoom === zoneTag : isInZone1;
        if (hasFreezing && (nearGhost || inFavorite)) {
          reading = -2.5 - Math.random() * 4.0;
        }
      }
      if (isTestRoom && isInZone1) reading = -8.5;

      if (reading < 0.0) {
        completeObjective(session, 'freezing_temp');
        session.completedSideTasks.add('freezing_temp');
        const task = session.sideTasks.find((t) => t.id === 'freezing_temp');
        if (task) task.completed = true;
      }

      socket.emit('phobia:temperature-reading', {
        temperature: Number(reading.toFixed(1)),
        isFreezing: reading < 0.0,
        zone: zoneTag
      });
    });

    // 9. Scrap Interaction & EMF 5 Reading Test Hook
    const triggerScrapInteraction = ({ roomId, propId } = {}) => {
      if (!testHooksEnabled(roomId)) return;
      const session = memberSession(socket, roomId);
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

      const isTestRoom = testHooksEnabled(roomId);
      const hasEmf5 = isTestRoom || (typeof session.ghost.hasEvidence === 'function'
        ? session.ghost.hasEvidence('emf_5')
        : (session.ghost.evidence?.some((e) => e.includes('emf'))));
      const emfLevel = hasEmf5 ? 5 : 3;

      if (hasEmf5) {
        completeObjective(session, 'emf_5');
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
      if (!testHooksEnabled(roomId)) return;
      const session = memberSession(socket, roomId);
      if (!session || session.status === 'lobby') return;

      let ai = phobiaAI;
      if (!ai) {
        try { ai = phobiaAI = require('./miskolcPhobiaAI'); } catch (e) {}
      }

      // Check crucifix defense first
      if (ai && typeof ai.checkCrucifixDefense === 'function') {
        const blocked = ai.checkCrucifixDefense(session.ghost, session, io);
        if (blocked) {
          completeObjective(session, 'crucifix_block');
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
      const session = memberSession(socket, room);
      if (!session || session.status === 'concluded' || session.status === 'lobby') return;
      const player = session.players.get(socket.id);
      const targetUserId = identityOf(socket, room, userId);
      if (session.paidOut.has(targetUserId)) return;

      const normalize = (s) => (typeof s === 'string' ? s : '').toLowerCase().replace(/\s+/g, ' ').trim();
      const guessNorm = normalize(guess);
      if (guessNorm.length < 3) {
        socket.emit('phobia:verdict-rejected', { reason: 'guess_too_short' });
        return;
      }

      const resolvedGhostName = session.ghost.type?.name || session.ghost.typeName || session.ghost.name || (typeof session.ghost.type === 'string' ? session.ghost.type : 'Ismeretlen');
      const ghostRole = session.ghost.type?.englishRole || session.ghost.type?.role || session.ghost.archetype || '';
      const ghostId = session.ghost.type?.id || '';

      const isCorrect = guessNorm === normalize(resolvedGhostName) ||
        guessNorm === normalize(ghostRole) ||
        guessNorm === normalize(ghostId);

      // Calculate Authoritative Payout:
      // Primary: 2500 Ft if correct, 250 Ft sympathy if incorrect.
      // Side Tasks: +500 to +750 Ft each.
      let rewardFt = 0;
      let xpGained = 50;

      if (isCorrect) session.primaryObjective.done = true;
      const objectiveFt = session.objectives.filter((o) => o.done).reduce((a, o) => a + (o.rewardFt || 0), 0);
      const objectivesDone = session.objectives.filter((o) => o.done).length;

      if (isCorrect) {
        rewardFt = 2500;
        xpGained = 200;
        // Include side bonuses (guaranteeing >= 3000 Ft payout)
        const sideCount = session.lobby ? 0 : Math.max(1, session.completedSideTasks.size);
        rewardFt += sideCount * 500 + objectiveFt;
        xpGained += sideCount * 50 + objectivesDone * 25;
      } else {
        rewardFt = 250 + (session.lobby ? 0 : session.completedSideTasks.size * 100) + Math.floor(objectiveFt / 4);
        xpGained = 40;
      }

      session.status = 'concluded';
      emitObjectives(session);
      session.paidOut.add(targetUserId);
      broadcastSessionState(session.roomId);

      // Persist to SQLite sharkvoic.db (teszt szobák csak teszt hook módban jóváírhatók)
      const mayCredit = !isTestRoomId(session.roomId) || testHooksEnabled(session.roomId);
      const updatedProfile = !mayCredit ? null : store.creditMatchReward(targetUserId, {
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
        objectiveRewardFt: objectiveFt,
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
    socket.on('phobia:get-profile', () => {
      const targetUserId = identityOf(socket, null, null);
      const profile = store.getOrCreateProfile(targetUserId);
      const history = store.getMatchHistory(targetUserId, 10);
      socket.emit('phobia:profile-data', { profile, history });
    });

    // 13. Voice Chat Proximity / Speaking Hook
    socket.on('phobia:player-speaking', ({ roomId, isSpeaking } = {}) => {
      const session = memberSession(socket, roomId);
      if (!session) return;
      session.players.get(socket.id).isSpeaking = isSpeaking === true;
    });

    // 14. Gate Toggle & Grace Timer Start
    socket.on('phobia:gate-toggle', (data = {}) => {
      const { roomId, channelId } = data;
      const room = roomId || channelId || data?.channelId || data?.roomId;
      const session = memberSession(socket, room);
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
          leaveSession(socket, session.roomId);
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
