// Frakciók, karakterek és pálya: minden játéktartalom itt van, a szimuláció csak adatot olvas.
// Új karakterhez vagy frakcióhoz elég ezt a fájlt és a frontend modellt bővíteni.

const FACTIONS = {
  soap: { id: 'soap', name: 'Szappan Légió', color: '#5ec8ff' },
  grime: { id: 'grime', name: 'Kosz Horda', color: '#9bd14b' }
};

const blast = (name, damage) => ({ kind: 'blast', name, cooldown: 8, radius: 7, damage, knockback: 15 });
const shield = (name) => ({ kind: 'shield', name, cooldown: 12, duration: 3, reduction: 0.6 });
const dash = (name) => ({ kind: 'dash', name, cooldown: 5, duration: 0.22, speed: 26 });

// A két frakció szerepkörönként azonos számokkal indul, így a csapatválasztás nem ad előnyt
const ROLES = {
  balanced: { maxHp: 100, speed: 6.5, damage: 14, fireCooldown: 0.22, range: 42 },
  tank: { maxHp: 170, speed: 5.4, damage: 22, fireCooldown: 0.45, range: 24 },
  runner: { maxHp: 75, speed: 8, damage: 11, fireCooldown: 0.16, range: 30 }
};

const CHARACTERS = {
  bar_trooper: { id: 'bar_trooper', faction: 'soap', name: 'Szappanbaka', role: 'Kiegyensúlyozott', ...ROLES.balanced, ability: blast('Buborékrobbanás', 25) },
  loofah_bruiser: { id: 'loofah_bruiser', faction: 'soap', name: 'Luffa Verő', role: 'Tank', ...ROLES.tank, ability: shield('Habpajzs') },
  rinse_runner: { id: 'rinse_runner', faction: 'soap', name: 'Öblítő Futár', role: 'Gyors', ...ROLES.runner, ability: dash('Csúszás') },
  mold_creeper: { id: 'mold_creeper', faction: 'grime', name: 'Penészkúszó', role: 'Kiegyensúlyozott', ...ROLES.balanced, ability: blast('Spóravihar', 25) },
  hairball_brute: { id: 'hairball_brute', faction: 'grime', name: 'Szőrgombóc', role: 'Tank', ...ROLES.tank, ability: shield('Csomós Bunda') },
  drain_skitter: { id: 'drain_skitter', faction: 'grime', name: 'Lefolyó Fürge', role: 'Gyors', ...ROLES.runner, ability: dash('Dugulás-ugrás') }
};

const box = (x, y, z, sx, sy, sz, kind = 'crate') => ({
  min: [x - sx / 2, y, z - sz / 2],
  max: [x + sx / 2, y + sy, z + sz / 2],
  kind
});

// Tükörszimmetrikus pálya: minden fedezék az X tengelyre tükrözve is megvan
const mirrored = (x, y, z, sx, sy, sz, kind) => [box(x, y, z, sx, sy, sz, kind), box(-x, y, -z, sx, sy, sz, kind)];

const BATHROOM_ARENA = {
  id: 'bathroom_arena',
  name: 'Fürdőszoba Aréna',
  bounds: { minX: -36, maxX: 36, minZ: -22, maxZ: 22, height: 14 },
  colliders: [
    box(0, 0, 0, 8, 2.4, 8, 'tub'),
    ...mirrored(-14, 0, -9, 5, 2.2, 3, 'crate'),
    ...mirrored(-14, 0, 9, 3, 1.1, 6, 'step'),
    ...mirrored(-24, 0, 0, 2, 3.2, 14, 'wall'),
    ...mirrored(-7, 0, 14, 8, 2.2, 2, 'crate'),
    ...mirrored(-7, 0, -15, 3, 1.1, 3, 'step'),
    ...mirrored(-29, 0, -14, 4, 1.2, 4, 'step'),
    ...mirrored(-29, 0, 14, 4, 2.4, 4, 'crate')
  ],
  spawns: {
    soap: [[-32, 0, -6], [-32, 0, 0], [-32, 0, 6], [-29, 0, -3], [-29, 0, 3], [-32, 0, -11], [-32, 0, 11]],
    grime: [[32, 0, 6], [32, 0, 0], [32, 0, -6], [29, 0, 3], [29, 0, -3], [32, 0, 11], [32, 0, -11]]
  }
};

const TEAMS = Object.keys(FACTIONS);

const WEAPONS = {
  pistol: { id: 'pistol', name: 'Buborékpisztoly', tier: 1, damage: 12, fireCooldown: 0.3, range: 34 },
  smg: { id: 'smg', name: 'Habszóró', tier: 2, damage: 9, fireCooldown: 0.1, range: 30 },
  shotgun: { id: 'shotgun', name: 'Vízágyú', tier: 3, damage: 42, fireCooldown: 0.85, range: 14 },
  rifle: { id: 'rifle', name: 'Klórpuska', tier: 3, damage: 18, fireCooldown: 0.2, range: 60 },
  sniper: { id: 'sniper', name: 'Tű-sugár', tier: 4, damage: 70, fireCooldown: 1.4, range: 120 }
};

const NPCS = {
  slime: { id: 'slime', name: 'Nyálka', hp: 60, speed: 4.6, damage: 10, range: 2.2, cooldown: 0.9, size: 1 },
  spitter: { id: 'spitter', name: 'Köpködő', hp: 40, speed: 3.6, damage: 8, range: 18, cooldown: 1.6, size: 0.9 },
  brute: { id: 'brute', name: 'Dugó', hp: 220, speed: 3.2, damage: 28, range: 2.8, cooldown: 1.5, size: 1.6 },
  clog_giant: { id: 'clog_giant', name: 'Óriás Dugulás', hp: 3000, speed: 3, damage: 30, range: 5, cooldown: 1.4, size: 3.4, boss: true },
  mold_queen: { id: 'mold_queen', name: 'Penészkirálynő', hp: 2500, speed: 3.8, damage: 24, range: 22, cooldown: 1.1, size: 3, boss: true },
  hair_titan: { id: 'hair_titan', name: 'Szőrtitán', hp: 4200, speed: 2.8, damage: 38, range: 6, cooldown: 1.7, size: 4, boss: true, titan: true },
  void_plunger: { id: 'void_plunger', name: 'Üresség Pumpa', hp: 5200, speed: 4.2, damage: 42, range: 26, cooldown: 1, size: 3.6, boss: true, titan: true, secret: true }
};

const BOSS_IDS = ['clog_giant', 'mold_queen', 'hair_titan'];
const DIFFICULTIES = { normal: { label: 'Normál', hp: 1, damage: 1 }, hard: { label: 'Nehéz', hp: 1.5, damage: 1.35 }, insane: { label: 'Őrült', hp: 2.2, damage: 1.8 } };

// Determinisztikus véletlen: a szerver és a kliens ugyanazt a pályát látja, a pálya adatát a szerver küldi
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRoyaleMap() {
  const rng = seeded(4711);
  const size = 120;
  const colliders = [];
  const free = (x, z, r) => colliders.every((c) => x + r < c.min[0] || x - r > c.max[0] || z + r < c.min[2] || z - r > c.max[2]);
  for (let i = 0; i < 900 && colliders.length < 70; i += 1) {
    const x = -size + 8 + rng() * (size * 2 - 16);
    const z = -size + 8 + rng() * (size * 2 - 16);
    const sx = 5 + rng() * 11;
    const sz = 5 + rng() * 11;
    if (free(x, z, Math.max(sx, sz) / 2 + 4)) colliders.push(box(x, 0, z, sx, 2.5 + rng() * 7, sz, rng() < 0.3 ? 'wall' : 'crate'));
  }
  const lootSpots = [];
  while (lootSpots.length < 130) {
    const x = -size + 4 + rng() * (size * 2 - 8);
    const z = -size + 4 + rng() * (size * 2 - 8);
    if (free(x, z, 1)) lootSpots.push([Math.round(x), Math.round(z)]);
  }
  const ring = [];
  for (let i = 0; i < 60; i += 1) {
    const a = (i / 60) * Math.PI * 2;
    const x = Math.cos(a) * (size - 12) * (0.7 + rng() * 0.3);
    const z = Math.sin(a) * (size - 12) * (0.7 + rng() * 0.3);
    if (free(x, z, 1)) ring.push([Math.round(x), 0, Math.round(z)]);
  }
  return { id: 'drain_city', name: 'Lefolyóváros', bounds: { minX: -size, maxX: size, minZ: -size, maxZ: size, height: 24 }, colliders, spawns: { soap: ring, grime: ring }, lootSpots };
}

const circle = (cx, cz, rx, rz, n) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return [Math.round(cx + Math.cos(a) * rx), Math.round(cz + Math.sin(a) * rz)];
});

function raceMap(id, name, points, shortcut) {
  const routes = [{ points, width: 14 }];
  if (shortcut) routes.push({ points: shortcut, width: 9, open: true, shortcut: true });
  const step = Math.floor(points.length / 8);
  const checkpoints = Array.from({ length: 8 }, (_, i) => points[i * step]);
  const [sx, sz] = points[0];
  const [nx, nz] = points[1];
  const heading = Math.atan2(-(nx - sx), -(nz - sz));
  const grid = Array.from({ length: 12 }, (_, i) => {
    const side = (i % 3) - 1;
    const row = Math.floor(i / 3) + 1;
    return [sx + Math.cos(heading) * side * 3.5 + Math.sin(heading) * row * 5, 0, sz - Math.sin(heading) * side * 3.5 + Math.cos(heading) * row * 5];
  });
  const boostPads = points.filter((_, i) => i % 7 === 3).map(([x, z]) => [x, z]);
  const itemBoxes = points.filter((_, i) => i % 7 === 5).map(([x, z]) => [x, z]);
  return { id, name, bounds: { minX: -150, maxX: 150, minZ: -110, maxZ: 110, height: 24 }, colliders: [], spawns: { soap: grid, grime: grid }, heading, track: { routes, checkpoints, checkpointRadius: 16, boostPads, itemBoxes, laps: 3 } };
}

const RACE_TRACKS = {
  tub_ring: raceMap('tub_ring', 'Kádgyűrű', circle(0, 0, 120, 80, 40), [[-60, -60], [-20, 0], [60, 62]]),
  drain_circuit: raceMap('drain_circuit', 'Lefolyó Pálya', [[-120, -70], [-40, -86], [50, -60], [120, -80], [132, -10], [70, 12], [120, 70], [40, 86], [-20, 44], [-90, 84], [-132, 20]].flatMap((p, i, all) => {
    const next = all[(i + 1) % all.length];
    return [p, [Math.round((p[0] * 2 + next[0]) / 3), Math.round((p[1] * 2 + next[1]) / 3)], [Math.round((p[0] + next[0] * 2) / 3), Math.round((p[1] + next[1] * 2) / 3)]];
  }))
};
for (const track of Object.values(RACE_TRACKS)) {
  // Akadályok a pályán, de mindig kikerülhetően a sáv szélén
  const pts = track.track.routes[0].points;
  for (let i = 4; i < pts.length; i += 9) {
    const [x, z] = pts[i];
    track.colliders.push(box(x + (i % 2 ? 4 : -4), 0, z + (i % 2 ? -3 : 3), 2.4, 1.8, 2.4, 'crate'));
  }
}

const FORTRESS_MAP = {
  id: 'fortress', name: 'Erőd Csatatér',
  bounds: { minX: -60, maxX: 60, minZ: -30, maxZ: 30, height: 16 },
  colliders: [...mirrored(-30, 0, 0, 3, 3, 16, 'wall'), ...mirrored(-14, 0, -14, 6, 2.2, 4, 'crate'), ...mirrored(-14, 0, 14, 6, 1.1, 4, 'step')],
  spawns: { a: [[-56, 0, -8], [-56, 0, 0], [-56, 0, 8], [-52, 0, -4], [-52, 0, 4], [-56, 0, -14]], b: [[56, 0, 8], [56, 0, 0], [56, 0, -8], [52, 0, 4], [52, 0, -4], [56, 0, 14]] },
  structures: [
    { id: 'core_a', side: 'a', kind: 'core', hp: 2500, ...box(-48, 0, 0, 6, 6, 6, 'core') },
    { id: 'tower_a1', side: 'a', kind: 'tower', hp: 800, ...box(-38, 0, -12, 3, 7, 3, 'tower') },
    { id: 'tower_a2', side: 'a', kind: 'tower', hp: 800, ...box(-38, 0, 12, 3, 7, 3, 'tower') },
    { id: 'core_b', side: 'b', kind: 'core', hp: 2500, ...box(48, 0, 0, 6, 6, 6, 'core') },
    { id: 'tower_b1', side: 'b', kind: 'tower', hp: 800, ...box(38, 0, 12, 3, 7, 3, 'tower') },
    { id: 'tower_b2', side: 'b', kind: 'tower', hp: 800, ...box(38, 0, -12, 3, 7, 3, 'tower') }
  ],
  nodes: [{ id: 'n1', x: 0, z: -18 }, { id: 'n2', x: 0, z: 18 }, { id: 'n3', x: 0, z: 0 }]
};

const MAPS = { bathroom_arena: BATHROOM_ARENA, drain_city: buildRoyaleMap(), fortress: FORTRESS_MAP, ...RACE_TRACKS };

module.exports = { FACTIONS, CHARACTERS, BATHROOM_ARENA, TEAMS, WEAPONS, NPCS, BOSS_IDS, DIFFICULTIES, MAPS, RACE_TRACKS };
