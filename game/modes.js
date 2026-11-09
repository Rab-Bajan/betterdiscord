// Játékmódok: a szimuláció kampói. Új mód = új objektum itt, a mag érintetlen marad.
const { stepVehicle, stepMovement } = require('./physics');
const { WEAPONS, NPCS, BOSS_IDS, DIFFICULTIES } = require('./content');

const alivePlayers = (m) => m.players.filter((p) => p.alive);
const shuffle = (m, list) => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(m.rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const everySecond = (m) => Math.floor(m.time) !== Math.floor(m.time - m.dt);

function randomArenaSpot(m) {
  const { bounds } = m.world;
  for (let i = 0; i < 30; i += 1) {
    const x = bounds.minX + 4 + m.rng() * (bounds.maxX - bounds.minX - 8);
    const z = bounds.minZ + 4 + m.rng() * (bounds.maxZ - bounds.minZ - 8);
    if (m.world.colliders.every((c) => x + 2 < c.min[0] || x - 2 > c.max[0] || z + 2 < c.min[2] || z - 2 > c.max[2])) return [x, 0, z];
  }
  return [0, 0, bounds.minZ + 4];
}

function nearestPlayer(m, npc) {
  let best = null;
  let bestDist = Infinity;
  for (const p of m.players) {
    if (!p.alive || m.time < p.protectedUntil) continue;
    const dist = Math.hypot(p.x - npc.x, p.z - npc.z);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return { target: best, dist: bestDist };
}

const NAV_CELL = 2;

// Rácsos útvonalkereső: a játékosoktól induló szélességi bejárás, amely minden cellára megadja a távolságot.
// Fél másodpercenként újul, így a falak mögül is odatalálnak az ellenfelek.
function navGrid(m) {
  if (m.state.nav) return m.state.nav;
  const { bounds, colliders } = m.world;
  const w = Math.ceil((bounds.maxX - bounds.minX) / NAV_CELL);
  const h = Math.ceil((bounds.maxZ - bounds.minZ) / NAV_CELL);
  const blocked = new Uint8Array(w * h);
  for (let cz = 0; cz < h; cz += 1) {
    for (let cx = 0; cx < w; cx += 1) {
      const x = bounds.minX + (cx + 0.5) * NAV_CELL;
      const z = bounds.minZ + (cz + 0.5) * NAV_CELL;
      if (colliders.some((c) => x > c.min[0] - 1 && x < c.max[0] + 1 && z > c.min[2] - 1 && z < c.max[2] + 1)) blocked[cz * w + cx] = 1;
    }
  }
  m.state.nav = { w, h, blocked, dist: new Int32Array(w * h), nextAt: 0 };
  return m.state.nav;
}

const navCell = (m, nav, x, z) => {
  const { bounds } = m.world;
  const cx = Math.max(0, Math.min(nav.w - 1, Math.floor((x - bounds.minX) / NAV_CELL)));
  const cz = Math.max(0, Math.min(nav.h - 1, Math.floor((z - bounds.minZ) / NAV_CELL)));
  return cz * nav.w + cx;
};

function refreshNav(m) {
  const nav = navGrid(m);
  if (m.time < nav.nextAt) return nav;
  nav.nextAt = m.time + 0.5;
  nav.dist.fill(-1);
  const queue = [];
  for (const p of m.players) {
    if (!p.alive || m.time < p.protectedUntil) continue;
    const cell = navCell(m, nav, p.x, p.z);
    if (nav.dist[cell] === -1) {
      nav.dist[cell] = 0;
      queue.push(cell);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    const cx = cell % nav.w;
    const next = [cx > 0 ? cell - 1 : -1, cx < nav.w - 1 ? cell + 1 : -1, cell - nav.w, cell + nav.w];
    for (const n of next) {
      if (n < 0 || n >= nav.dist.length || nav.blocked[n] || nav.dist[n] !== -1) continue;
      nav.dist[n] = nav.dist[cell] + 1;
      queue.push(n);
    }
  }
  return nav;
}

function navHeading(m, npc, nav) {
  const { bounds } = m.world;
  const cell = navCell(m, nav, npc.x, npc.z);
  const cx = cell % nav.w;
  let best = null;
  let bestDist = nav.dist[cell] === -1 ? Infinity : nav.dist[cell];
  for (const n of [cx > 0 ? cell - 1 : -1, cx < nav.w - 1 ? cell + 1 : -1, cell - nav.w, cell + nav.w]) {
    if (n < 0 || n >= nav.dist.length || nav.dist[n] === -1 || nav.dist[n] >= bestDist) continue;
    best = n;
    bestDist = nav.dist[n];
  }
  if (best === null) return null;
  const tx = bounds.minX + ((best % nav.w) + 0.5) * NAV_CELL;
  const tz = bounds.minZ + (Math.floor(best / nav.w) + 0.5) * NAV_CELL;
  return Math.atan2(-(tx - npc.x), -(tz - npc.z));
}

// Közös ellenfél-MI: rálátásnál egyenesen üldöz, különben a rács mentén kerül, majd támad
function updateNpc(m, npc) {
  const { target, dist } = nearestPlayer(m, npc);
  if (!target) return null;
  const dx = target.x - npc.x;
  const dz = target.z - npc.z;
  const direct = Math.atan2(-dx, -dz);
  const { def } = npc;
  const inRange = dist <= def.range + npc.size * 0.5;
  const visible = m.clearLine(npc.x, npc.y + 1, npc.z, target.x, target.y + 1, target.z);
  const stopped = inRange && visible;

  npc.yaw = visible ? direct : navHeading(m, npc, refreshNav(m)) ?? direct;
  stepMovement(npc, { mx: 0, mz: stopped ? 0 : 1, yaw: npc.yaw, jump: false }, def.speed, m.world, m.dt);

  if (stopped && m.time >= npc.nextAttackAt) {
    npc.nextAttackAt = m.time + def.cooldown;
    m.emit({ t: 'npc_attack', id: npc.id, to: target.index });
    m.damage(target, Math.round(def.damage * npc.damageMul), null);
  }
  return target;
}

function downPlayer(m, target) {
  target.alive = false;
  target.downed = true;
  target.revive = 0;
}

// Földre került csapattárs felsegítése: az E nyomva tartásával a közelében
function updateRevives(m) {
  for (const p of m.players) {
    if (!p.downed) continue;
    const helper = m.players.find((q) => q.alive && q.connected && q.input.interact && Math.hypot(q.x - p.x, q.z - p.z) <= 3);
    p.revive = helper ? p.revive + m.dt : 0;
    if (helper && p.revive >= 2.5) {
      p.downed = false;
      p.alive = true;
      p.hp = Math.ceil(p.stats.maxHp / 2);
      p.revive = 0;
      p.protectedUntil = m.time + 1.5;
      m.count(helper, 'revives');
      m.emit({ t: 'revived', i: p.index, by: helper.index });
    }
  }
}

function reviveEveryone(m) {
  for (const p of m.players) {
    if (p.downed) {
      p.downed = false;
      p.alive = true;
      p.hp = Math.ceil(p.stats.maxHp / 2);
      p.protectedUntil = m.time + 2;
    }
  }
}

const teamDeathmatch = {
  id: 'team_deathmatch',
  name: 'Szappan vs Kosz',
  description: 'Két csapat harca: az nyer, aki előbb eléri a pontlimitet.',
  map: 'bathroom_arena',
  teams: true,
  chaos: true,
  min: 2, max: 12,
  defaults: { scoreLimit: 30, timeLimit: 480 },
  onDeath(m, target, attacker) {
    if (!attacker?.isPlayer) return;
    m.score[attacker.side] += 1;
    if (m.score[attacker.side] >= m.scoreLimit) m.finish(attacker.side, 'score');
  },
  onTimeUp(m) {
    const [a, b] = Object.keys(m.score);
    m.finish(m.score[a] === m.score[b] ? null : m.score[a] > m.score[b] ? a : b, 'time');
  }
};

const INFECTED_ATTACK = { damage: 45, fireCooldown: 0.55, range: 3.6 };

const infection = {
  id: 'infection',
  name: 'Fertőzés',
  description: 'A fertőzöttek vadásznak, minden áldozatból új fertőzött lesz. A túlélőknek ki kell bírniuk a végéig.',
  map: 'bathroom_arena',
  chaos: true,
  min: 3, max: 16,
  respawnSeconds: 3,
  defaults: { timeLimit: 180 },
  init(m) {
    const count = Math.max(1, Math.ceil(m.players.length / 5));
    const picked = new Set(shuffle(m, m.players).slice(0, count));
    for (const p of m.players) infection.setSide(m, p, picked.has(p) ? 'infected' : 'survivor');
    infection.updateScore(m);
  },
  setSide(m, p, side) {
    p.side = side;
    p.attackOverride = side === 'infected' ? INFECTED_ATTACK : null;
  },
  spawnPoint(m, p) {
    const spots = m.world.spawns[p.side === 'infected' ? 'grime' : 'soap'];
    const cursor = m.spawnCursor[p.side] || 0;
    m.spawnCursor[p.side] = cursor + 1;
    return spots[cursor % spots.length];
  },
  updateScore(m) {
    m.score = { survivor: m.players.filter((p) => p.side === 'survivor').length, infected: m.players.filter((p) => p.side === 'infected').length };
  },
  onDeath(m, target, attacker) {
    if (target.side === 'survivor') {
      infection.setSide(m, target, 'infected');
      m.emit({ t: 'infected', i: target.index });
      if (attacker?.isPlayer) m.count(attacker, 'infections');
      infection.updateScore(m);
      if (m.score.survivor === 0) m.finish('infected', 'all_infected');
    }
  },
  onAbandon(m) {
    infection.updateScore(m);
    if (!m.players.some((p) => p.connected && p.side === 'infected')) m.finish('survivor', 'abandoned');
    else if (!m.players.some((p) => p.connected && p.side === 'survivor')) m.finish('infected', 'abandoned');
  },
  onTimeUp(m) {
    m.finish('survivor', 'time');
  }
};

const survivalWaveComposition = (wave) => {
  const list = [];
  const count = Math.min(30, 3 + wave * 2);
  for (let i = 0; i < count; i += 1) {
    if (wave >= 3 && i % 4 === 0) list.push('spitter');
    else if (wave >= 4 && i % 7 === 0) list.push('brute');
    else list.push('slime');
  }
  return list;
};

const survival = {
  id: 'survival',
  name: 'Túlélés',
  description: 'Egyre erősebb hullámok, ötödikenként főellenséggel. Segítsétek fel egymást E-vel.',
  map: 'bathroom_arena',
  pve: true,
  min: 1, max: 8,
  defaults: { timeLimit: 1800 },
  init(m) {
    for (const p of m.players) p.side = 'players';
    Object.assign(m.state, { wave: 0, nextWaveAt: 4 });
  },
  isEnemy: () => false,
  spawnPoint(m, p) {
    const spots = m.world.spawns.soap;
    return spots[p.index % spots.length];
  },
  tick(m) {
    const s = m.state;
    updateRevives(m);
    // Semleges terület elfoglalása: a megadott számú hullám letisztítása a cél
    if (m.options.waveGoal && s.wave >= m.options.waveGoal && m.npcs.length === 0) {
      survival.end(m, 'goal');
      return;
    }
    if (m.npcs.length === 0 && m.time >= s.nextWaveAt) survival.startWave(m);
    for (const npc of m.npcs) updateNpc(m, npc);
    m.updateHazards();
    for (const pickup of [...m.pickups]) {
      const p = alivePlayers(m).find((q) => Math.hypot(q.x - pickup.x, q.z - pickup.z) < 2);
      if (p) {
        p.hp = Math.min(p.stats.maxHp, p.hp + 35);
        m.count(p, 'pickups');
        m.removePickup(pickup);
      }
    }
    if (m.players.every((p) => !p.alive || !p.connected) && !m.result) survival.end(m, 'wiped');
  },
  startWave(m) {
    const s = m.state;
    s.wave += 1;
    const scale = { hp: (1 + (s.wave - 1) * 0.12) * (1 + (m.players.length - 1) * 0.25), damage: 1 + (s.wave - 1) * 0.05 };
    reviveEveryone(m);
    if (s.wave % 5 === 0) {
      const [x, , z] = randomArenaSpot(m);
      m.spawnNpc('brute', x, z, { hp: scale.hp * 4, damage: scale.damage * 1.5 });
      m.emit({ t: 'boss_wave', wave: s.wave });
    }
    for (const type of survivalWaveComposition(s.wave)) {
      const [x, , z] = randomArenaSpot(m);
      m.spawnNpc(type, x, z, scale);
    }
    m.emit({ t: 'wave', wave: s.wave });
    if (s.wave % 2 === 0) {
      const [x, , z] = randomArenaSpot(m);
      m.addPickup('medkit', x, z);
    }
    s.nextWaveAt = m.time + 3;
  },
  onNpcDeath(m) {
    if (m.npcs.filter((n) => n.alive).length === 0) m.state.nextWaveAt = m.time + 4;
  },
  onDeath(m, target) {
    downPlayer(m, target);
    if (m.players.every((p) => !p.alive || !p.connected)) survival.end(m, 'wiped');
  },
  end(m, reason) {
    const wave = m.state.wave;
    for (const p of m.players) {
      p.counters.survival_best = wave;
      p.bonusXp += Math.min(300, wave * 15);
    }
    m.score = { hullám: wave };
    m.finish(wave >= 5 ? 'players' : null, reason, { waves: wave });
  },
  onTimeUp(m) {
    survival.end(m, 'time');
  },
  outcome: (m) => (m.state.wave >= 5 ? 'win' : 'loss'),
  hud: (m) => ({ wave: m.state.wave, enemies: m.npcs.length })
};

const boss = {
  id: 'boss',
  name: 'Főellenség',
  description: 'Együtt, időre győzzetek le egy óriási szörnyet több fázison át.',
  map: 'bathroom_arena',
  pve: true,
  min: 1, max: 10,
  respawnSeconds: 6,
  options: { bosses: BOSS_IDS, difficulties: Object.keys(DIFFICULTIES) },
  defaults: { timeLimit: 300 },
  init(m) {
    for (const p of m.players) p.side = 'players';
    const difficulty = DIFFICULTIES[m.options.difficulty] || DIFFICULTIES.normal;
    let bossId = BOSS_IDS.includes(m.options.bossId) ? m.options.bossId : BOSS_IDS[0];
    // Ritka titkos főellenség nehéz fokozaton
    if (m.options.difficulty !== 'normal' && m.options.difficulty && m.rng() < 0.08) bossId = 'void_plunger';
    const npc = m.spawnNpc(bossId, 0, -14, { hp: difficulty.hp * (1 + (m.players.length - 1) * 0.7), damage: difficulty.damage });
    Object.assign(m.state, { bossNpc: npc, phase: 1, nextPatternAt: 5, difficulty });
  },
  isEnemy: () => false,
  spawnPoint(m, p) {
    const spots = m.world.spawns.soap;
    return spots[p.index % spots.length];
  },
  tick(m) {
    const s = m.state;
    const npc = s.bossNpc;
    if (npc.alive) {
      const ratio = npc.hp / npc.maxHp;
      const phase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
      if (phase !== s.phase) {
        s.phase = phase;
        m.emit({ t: 'boss_phase', phase });
        if (phase === 3) m.addHazard(0, 0, 10, 1.5, 12, 6);
      }
      updateNpc(m, npc);
      if (m.time >= s.nextPatternAt) boss.pattern(m, npc);
    }
    for (const add of m.npcs) if (add !== npc) updateNpc(m, add);
    m.updateHazards();
  },
  pattern(m, npc) {
    const s = m.state;
    s.nextPatternAt = m.time + (4 - s.phase) * 1.4 + 1;
    const choice = Math.floor(m.rng() * (s.phase + 1));
    const { damage } = s.difficulty;
    if (choice === 0) {
      m.addHazard(npc.x, npc.z, 10, 1.2, 0.2, 0, Math.round(35 * damage));
      m.emit({ t: 'boss_attack', kind: 'slam' });
    } else if (choice === 1) {
      for (const p of alivePlayers(m)) m.addHazard(p.x, p.z, 4, 1, 4, Math.round(7 * damage));
      m.emit({ t: 'boss_attack', kind: 'spray' });
    } else if (choice === 2) {
      for (let i = 0; i < 2 + s.phase; i += 1) {
        m.spawnNpc('slime', npc.x + (m.rng() - 0.5) * 12, npc.z + (m.rng() - 0.5) * 12, { hp: 1 + m.players.length * 0.2, damage });
      }
      m.emit({ t: 'boss_attack', kind: 'summon' });
    } else {
      const target = alivePlayers(m)[Math.floor(m.rng() * alivePlayers(m).length)];
      if (target) {
        const dx = target.x - npc.x;
        const dz = target.z - npc.z;
        const len = Math.hypot(dx, dz) || 1;
        Object.assign(npc, { dashX: (dx / len) * 22, dashZ: (dz / len) * 22, dashTime: 0.5 });
        m.emit({ t: 'boss_attack', kind: 'charge' });
      }
    }
  },
  onDeath() {},
  onNpcDeath(m, npc) {
    if (npc !== m.state.bossNpc) return;
    for (const p of m.players) {
      if ((npc.damagers.get(p.index) || 0) > 0) {
        m.count(p, 'boss_kills');
        if (npc.def.titan) m.count(p, 'titan_kills');
        if (npc.def.secret) m.count(p, 'secret_boss_kills');
        p.bonusXp += 100 + Math.round((npc.damagers.get(p.index) / npc.maxHp) * 200);
      }
    }
    m.finish('players', 'boss_dead', { bossId: npc.type });
  },
  onTimeUp(m) {
    m.finish(null, 'time', { bossId: m.state.bossNpc.type });
  },
  outcome: (m, p, winner) => (winner === 'players' ? 'win' : 'loss'),
  hud(m) {
    const n = m.state.bossNpc;
    return { boss: n.def.name, bossHp: n.hp, bossMax: n.maxHp, phase: m.state.phase };
  }
};

const ZONE_PHASES = [
  { wait: 35, shrink: 25, ratio: 0.65, dps: 4 },
  { wait: 25, shrink: 25, ratio: 0.42, dps: 7 },
  { wait: 20, shrink: 20, ratio: 0.25, dps: 11 },
  { wait: 15, shrink: 20, ratio: 0.12, dps: 16 },
  { wait: 10, shrink: 20, ratio: 0.02, dps: 25 }
];

const LOOT_TABLE = ['pistol', 'pistol', 'smg', 'smg', 'rifle', 'shotgun', 'sniper', 'medkit', 'medkit', 'medkit', 'armor', 'armor'];

const royale = {
  id: 'royale',
  name: 'Lefolyó Royale',
  description: 'Mindenki mindenki ellen, szűkülő zónában. Az utolsó talpon maradó nyer.',
  map: 'drain_city',
  ffa: true,
  min: 2, max: 50,
  interestRadius: 95,
  spawnProtection: 8,
  defaults: { timeLimit: 420 },
  init(m) {
    m.players.forEach((p, i) => { p.side = `p${i}`; });
    m.score = { életben: m.players.length };
    const { bounds, lootSpots } = m.world;
    const spots = shuffle(m, lootSpots);
    for (const [x, z] of spots.slice(0, Math.min(spots.length, 40 + m.players.length * 3))) {
      m.pickups.push({ id: m.nextPickupId++, type: LOOT_TABLE[Math.floor(m.rng() * LOOT_TABLE.length)], x, y: 0.6, z });
    }
    const radius = Math.hypot(bounds.maxX, bounds.maxZ);
    m.state.zone = { x: (m.rng() - 0.5) * bounds.maxX * 0.5, z: (m.rng() - 0.5) * bounds.maxZ * 0.5, r: radius, from: radius, to: radius, start: 0, end: 0, phase: -1, nextAt: 0, dps: 0, base: bounds.maxX };
    royale.nextPhase(m);
    m.state.nextHazardAt = 45;
  },
  spawnPoint(m, p) {
    const spots = m.world.spawns.soap;
    return spots[(p.index * 7) % spots.length];
  },
  nextPhase(m) {
    const z = m.state.zone;
    z.phase += 1;
    const phase = ZONE_PHASES[z.phase];
    if (!phase) {
      z.nextAt = Infinity;
      return;
    }
    z.from = z.r;
    z.to = z.base * phase.ratio;
    z.start = m.time + phase.wait;
    z.end = z.start + phase.shrink;
    z.nextAt = z.end;
    z.dps = phase.dps;
    m.emit({ t: 'zone', phase: z.phase });
  },
  tick(m) {
    const z = m.state.zone;
    if (m.time >= z.start && m.time <= z.end) {
      const t = (m.time - z.start) / (z.end - z.start);
      z.r = z.from + (z.to - z.from) * t;
    }
    if (m.time >= z.nextAt) royale.nextPhase(m);

    for (const p of m.players) {
      if (!p.alive) continue;
      if (everySecond(m) && Math.hypot(p.x - z.x, p.z - z.z) > z.r) m.damage(p, z.dps, null);
      if (m.result) return;
    }

    // Lootolás rálépéssel: jobb fegyver, gyógyítás és páncél
    for (const pickup of [...m.pickups]) {
      const p = alivePlayers(m).find((q) => Math.hypot(q.x - pickup.x, q.z - pickup.z) < 1.8 && royale.canUse(q, pickup));
      if (p) {
        royale.apply(p, pickup);
        m.count(p, 'loot');
        m.removePickup(pickup);
      }
    }

    if (m.time >= m.state.nextHazardAt) {
      m.state.nextHazardAt = m.time + 30;
      m.addHazard(z.x + (m.rng() - 0.5) * z.r, z.z + (m.rng() - 0.5) * z.r, 12, 3, 10, 8);
    }
    m.updateHazards();
  },
  canUse(p, pickup) {
    if (pickup.type === 'medkit') return p.hp < p.stats.maxHp;
    if (pickup.type === 'armor') return p.armor < 100;
    return WEAPONS[pickup.type].tier > (p.weapon?.tier || 0);
  },
  apply(p, pickup) {
    if (pickup.type === 'medkit') p.hp = Math.min(p.stats.maxHp, p.hp + 50);
    else if (pickup.type === 'armor') p.armor = Math.min(100, p.armor + 50);
    else p.weapon = WEAPONS[pickup.type];
  },
  eliminate(m, target) {
    target.eliminated = true;
    target.alive = false;
    const left = alivePlayers(m).length;
    target.place = left + 1;
    m.score = { életben: left };
    if (left <= 1) {
      const winner = alivePlayers(m)[0];
      if (winner) {
        winner.place = 1;
        m.count(winner, 'royale_wins');
      }
      m.finish(winner ? winner.side : null, 'last_alive');
    }
  },
  onDeath(m, target) {
    royale.eliminate(m, target);
  },
  onAbandon(m, p) {
    if (p.alive) {
      p.deaths += 1;
      royale.eliminate(m, p);
    }
  },
  onTimeUp(m) {
    const best = alivePlayers(m).sort((a, b) => b.kills - a.kills)[0];
    alivePlayers(m).filter((p) => p !== best).forEach((p, i) => { p.place = i + 2; });
    if (best) best.place = 1;
    m.finish(best ? best.side : null, 'time');
  },
  outcome: (m, p, winner) => (p.side === winner ? 'win' : 'loss'),
  hud(m) {
    const z = m.state.zone;
    return { zx: Math.round(z.x), zz: Math.round(z.z), zr: Math.round(z.r), zt: Math.round(z.to), alive: alivePlayers(m).length };
  }
};

const RACE_ITEMS = ['boost', 'mine', 'rocket'];

const racing = {
  id: 'racing',
  name: 'Kádverseny',
  description: 'Három kör, nitró és csapdák. Shift a nitró, Q a tárgy használata.',
  map: 'tub_ring',
  ffa: true,
  vehicle: true,
  min: 1, max: 12,
  spawnProtection: 0,
  options: { tracks: ['tub_ring', 'drain_circuit'] },
  defaults: { timeLimit: 300 },
  init(m) {
    m.players.forEach((p, i) => { p.side = `p${i}`; p.startIndex = i; });
    m.score = { kör: 0 };
    m.state.startAt = 3;
    m.state.finished = 0;
    m.state.mines = [];
    const { track } = m.world;
    m.state.pads = track.boostPads.map(([x, z]) => ({ x, z, ready: 0 }));
    m.state.boxes = track.itemBoxes.map(([x, z]) => ({ x, z, ready: 0 }));
  },
  spawnPoint(m, p) {
    return m.world.spawns.soap[p.index % m.world.spawns.soap.length];
  },
  isEnemy: () => false,
  move(m, p) {
    if (m.time < m.state.startAt || p.finishedAt) {
      p.input = { ...p.input, mx: 0, mz: 0, sprint: false };
      if (p.finishedAt) p.speed *= 0.95;
    }
    stepVehicle(p, p.input, m.world, m.dt);
  },
  onAction(m, p) {
    if (p.input.ability && p.item && !p.finishedAt) racing.useItem(m, p);
  },
  useItem(m, p) {
    const item = p.item;
    p.item = null;
    if (item === 'boost') {
      p.boostTime = 1.8;
    } else if (item === 'mine') {
      m.state.mines.push({ id: m.nextHazardId++, x: p.x + Math.sin(p.heading) * 4, z: p.z + Math.cos(p.heading) * 4, owner: p.index, armAt: m.time + 0.5 });
      m.emit({ t: 'mine', mines: racing.mineList(m) });
    } else if (item === 'rocket') {
      // A rakéta a közvetlenül előttünk haladót találja el
      const order = racing.ranking(m);
      const ahead = order[order.indexOf(p) - 1];
      if (ahead && !ahead.finishedAt) {
        ahead.stunTime = 1.2;
        m.emit({ t: 'rocket', i: p.index, to: ahead.index });
        m.count(p, 'rocket_hits');
      }
    }
  },
  mineList: (m) => m.state.mines.map((q) => [q.id, Math.round(q.x), Math.round(q.z)]),
  progress(m, p) {
    const { checkpoints } = m.world.track;
    const next = checkpoints[p.checkpoint % checkpoints.length];
    return p.lap * checkpoints.length + p.checkpoint - Math.min(0.99, Math.hypot(p.x - next[0], p.z - next[1]) / 1000);
  },
  ranking(m) {
    return [...m.players].sort((a, b) => {
      if (a.finishedAt && b.finishedAt) return a.finishedAt - b.finishedAt;
      if (a.finishedAt || b.finishedAt) return a.finishedAt ? -1 : 1;
      return racing.progress(m, b) - racing.progress(m, a);
    });
  },
  tick(m) {
    const { track } = m.world;
    const s = m.state;
    if (m.time >= s.startAt && s.startAnnounced !== true) {
      s.startAnnounced = true;
      m.emit({ t: 'go' });
    }
    for (const p of m.players) {
      if (p.finishedAt) continue;
      // Az ellenőrzőpontok csak sorrendben számítanak: a pálya levágása nem ad kört
      const cp = track.checkpoints[p.checkpoint % track.checkpoints.length];
      if (Math.hypot(p.x - cp[0], p.z - cp[1]) <= track.checkpointRadius) {
        const wasStart = p.checkpoint === 0;
        if (wasStart && p.started) {
          p.lap += 1;
          if (p.lap >= track.laps) {
            s.finished += 1;
            p.finishedAt = m.time;
            p.place = s.finished;
            m.emit({ t: 'finish', i: p.index, place: p.place });
            if (s.finished === 1) {
              m.count(p, 'race_wins');
              s.endAt = m.time + 30;
            }
          }
        }
        p.started = true;
        p.checkpoint = (p.checkpoint + 1) % track.checkpoints.length;
      }
      for (const pad of s.pads) {
        if (m.time >= pad.ready && Math.hypot(p.x - pad.x, p.z - pad.z) < 7) p.boostTime = Math.max(p.boostTime, 0.9);
      }
      for (const b of s.boxes) {
        if (m.time >= b.ready && !p.item && Math.hypot(p.x - b.x, p.z - b.z) < 6) {
          p.item = RACE_ITEMS[Math.floor(m.rng() * RACE_ITEMS.length)];
          b.ready = m.time + 6;
          m.count(p, 'items');
        }
      }
      for (const mine of [...s.mines]) {
        if (m.time >= mine.armAt && Math.hypot(p.x - mine.x, p.z - mine.z) < 3) {
          p.stunTime = 1.4;
          s.mines = s.mines.filter((q) => q !== mine);
          m.emit({ t: 'mine', mines: racing.mineList(m), blast: [mine.x, mine.z] });
        }
      }
    }
    if (s.finished === m.players.filter((p) => p.connected || p.finishedAt).length && s.finished > 0) racing.end(m, 'all_finished');
    else if (s.endAt && m.time >= s.endAt) racing.end(m, 'finish_timer');
  },
  end(m, reason) {
    const order = racing.ranking(m);
    order.forEach((p, i) => {
      p.place = i + 1;
      p.counters.race_finish = p.finishedAt ? 1 : 0;
      p.bonusXp += p.finishedAt ? Math.max(10, 90 - i * 15) : 0;
    });
    const winner = order[0];
    m.finish(winner?.finishedAt ? winner.side : null, reason);
  },
  onDeath() {},
  onAbandon(m) {
    const remaining = m.players.filter((p) => p.connected && !p.finishedAt);
    if (remaining.length === 0 && m.state.finished > 0) racing.end(m, 'all_finished');
  },
  onTimeUp(m) {
    racing.end(m, 'time');
  },
  outcome: (m, p) => (p.place === 1 && p.finishedAt ? 'win' : 'loss'),
  hud(m) {
    return { laps: m.world.track.laps, startIn: Math.max(0, Math.ceil(m.state.startAt - m.time)), rank: racing.ranking(m).map((p) => p.index) };
  }
};

const clanWars = {
  id: 'clan_wars',
  name: 'Klánháború',
  description: 'Rombold le az ellenséges magot, vagy tartsd a nyersanyagpontokat 60 másodpercig.',
  map: 'fortress',
  teams: true,
  min: 2, max: 12,
  respawnSeconds: 6,
  defaults: { timeLimit: 600 },
  prepareWorld(world) {
    return { ...world, colliders: [...world.colliders, ...world.structures.map((s) => ({ min: s.min, max: s.max, kind: s.kind }))] };
  },
  init(m) {
    m.structures = m.world.structures.map((s) => ({ ...s }));
    m.score = { a: 0, b: 0 };
    m.state.nodes = m.world.nodes.map((n) => ({ ...n, owner: null, progress: 0 }));
    m.state.resources = { a: 0, b: 0 };
    m.state.hold = { a: 0, b: 0 };
    m.state.siegeUntil = { a: 0, b: 0 };
    m.state.towerNext = {};
  },
  structureMultiplier: (m, attacker) => (m.time < m.state.siegeUntil[attacker.side] ? 1.5 : 1),
  tick(m) {
    const s = m.state;
    for (const node of s.nodes) {
      const near = alivePlayers(m).filter((p) => Math.hypot(p.x - node.x, p.z - node.z) <= 6);
      const a = near.filter((p) => p.side === 'a').length;
      const b = near.filter((p) => p.side === 'b').length;
      if (a !== b) {
        const side = a > b ? 'a' : 'b';
        node.progress = node.owner === side ? 0 : node.progress + m.dt;
        if (node.progress >= 4) {
          node.owner = side;
          node.progress = 0;
          for (const p of near) if (p.side === side) m.count(p, 'nodes_captured');
          m.emit({ t: 'node', id: node.id, side });
        }
      } else {
        node.progress = 0;
      }
    }
    if (everySecond(m)) {
      for (const side of ['a', 'b']) {
        const held = s.nodes.filter((n) => n.owner === side).length;
        s.resources[side] += held * 4;
        s.hold[side] = held === s.nodes.length ? s.hold[side] + 1 : 0;
        if (s.resources[side] >= 100) {
          s.resources[side] -= 100;
          s.siegeUntil[side] = m.time + 20;
          m.emit({ t: 'siege', side });
        }
        if (s.hold[side] >= 60) {
          clanWars.reward(m, side);
          m.finish(side, 'objectives');
          return;
        }
      }
    }
    for (const tower of m.structures) {
      if (tower.kind !== 'tower' || tower.hp <= 0 || m.time < (s.towerNext[tower.id] || 0)) continue;
      const cx = (tower.min[0] + tower.max[0]) / 2;
      const cz = (tower.min[2] + tower.max[2]) / 2;
      const target = alivePlayers(m).find((p) => p.side !== tower.side && m.time >= p.protectedUntil && Math.hypot(p.x - cx, p.z - cz) <= 20);
      if (target) {
        s.towerNext[tower.id] = m.time + 1.2;
        m.emit({ t: 'tower', id: tower.id, to: target.index });
        m.damage(target, 9, null);
        if (m.result) return;
      }
    }
  },
  reward(m, side) {
    for (const p of m.players) if (p.side === side) m.count(p, 'clan_war_wins');
  },
  onDeath(m, target, attacker) {
    if (attacker?.isPlayer) m.score[attacker.side] += 1;
  },
  onStructureDown(m, s) {
    if (s.kind !== 'core') return;
    const winner = s.side === 'a' ? 'b' : 'a';
    clanWars.reward(m, winner);
    m.finish(winner, 'core_destroyed');
  },
  coreHp: (m, side) => m.structures.find((s) => s.side === side && s.kind === 'core').hp,
  onTimeUp(m) {
    const a = clanWars.coreHp(m, 'a');
    const b = clanWars.coreHp(m, 'b');
    const winner = a === b ? null : a > b ? 'a' : 'b';
    if (winner) clanWars.reward(m, winner);
    m.finish(winner, 'time');
  },
  hud(m) {
    const s = m.state;
    return { resources: s.resources, nodes: s.nodes.map((n) => [n.id, n.owner]), hold: s.hold, siege: { a: m.time < s.siegeUntil.a, b: m.time < s.siegeUntil.b } };
  }
};

const MODES = { team_deathmatch: teamDeathmatch, infection, survival, boss, royale, racing, clan_wars: clanWars };

const publicModes = () => Object.values(MODES).map((m) => ({
  id: m.id, name: m.name, description: m.description, min: m.min, max: m.max, teams: m.teams === true, options: m.options || null
}));

module.exports = { MODES, publicModes, NPCS };
