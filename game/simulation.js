// Szerveroldali meccs-szimuláció: minden játékmód közös magja. Nincs benne hálózat vagy adatbázis.
// A kliens csak bemenetet küld (irány, nézés, gombok): pozíciót, sebzést és találatot a szerver számol.
const { stepMovement, rayBox, rayWorld, BODY_RADIUS, BODY_HEIGHT } = require('./physics');
const { MODES } = require('./modes');
const { NPCS } = require('./content');

const AIM_HEIGHT = 1.9;
const RESPAWN_SECONDS = 4;
const SPAWN_PROTECTION_SECONDS = 2;
const HIT_PADDING = 0.12;
const MAX_QUEUED_INPUTS = 4;
// A kliensek ennyivel a múltban látják a többieket (interpoláció), a találatot ehhez igazítjuk
const REWIND_TICKS = 4;
const CHAOS_CHANCE_PER_SECOND = 1 / 240;
const CHAOS_DURATION = 10;

const round = (v) => Math.round(v * 100) / 100;

const IDLE_INPUT = { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, fire: false, ability: false, interact: false };

class Match {
  constructor({ id, roster, world, characters, scoreLimit = 30, timeLimit = 480, tickRate = 30, rng = Math.random, mode = 'team_deathmatch', options = {} }) {
    this.id = id;
    this.mode = MODES[mode];
    if (!this.mode) throw new Error(`Ismeretlen mód: ${mode}`);
    this.world = this.mode.prepareWorld ? this.mode.prepareWorld(world) : world;
    this.characters = characters;
    this.scoreLimit = scoreLimit;
    this.timeLimit = timeLimit;
    this.tickRate = tickRate;
    this.dt = 1 / tickRate;
    this.rng = rng;
    this.options = options;
    this.time = 0;
    this.score = Object.fromEntries(Object.keys(world.spawns).map((team) => [team, 0]));
    this.events = [];
    this.result = null;
    this.spawnCursor = {};
    this.npcs = [];
    this.nextNpcId = 1;
    this.pickups = [];
    this.nextPickupId = 1;
    this.hazards = [];
    this.nextHazardId = 1;
    this.structures = [];
    this.state = {};
    this.chaosUntil = 0;
    this.chaosEnabled = options.chaos !== false && this.mode.chaos === true;
    this.chaosSeen = false;

    this.players = roster.map((entry, index) => this.createPlayer(entry, index));
    this.byKey = new Map(this.players.map((p) => [p.key, p]));
    this.mode.init?.(this);
    for (const p of this.players) this.spawn(p);
  }

  createPlayer(entry, index) {
    const stats = this.characters[entry.characterId];
    if (!stats) throw new Error(`Ismeretlen karakter: ${entry.characterId}`);
    return {
      isPlayer: true,
      index,
      key: entry.key,
      username: entry.username,
      team: entry.team,
      side: entry.side || entry.team,
      characterId: entry.characterId,
      cosmetics: entry.cosmetics || {},
      stats,
      x: 0, y: 0, z: 0, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, dashX: 0, dashZ: 0,
      speed: 0, heading: 0, nitro: 50, boostTime: 0, stunTime: 0,
      lap: 0, checkpoint: 0, place: 0, finishedAt: 0, item: null,
      yaw: 0, pitch: 0,
      hp: stats.maxHp, armor: 0,
      alive: true, downed: false, eliminated: false,
      respawnAt: 0, protectedUntil: 0, shieldUntil: 0, nextFireAt: 0, abilityReadyAt: 0,
      weapon: null, attackOverride: null,
      connected: true, activeTicks: 0,
      kills: 0, deaths: 0, assists: 0, damage: 0, counters: {}, bonusXp: 0,
      revive: 0,
      damagers: new Map(), queue: [], input: { ...IDLE_INPUT }, lastSeq: 0, history: []
    };
  }

  count(p, key, amount = 1) {
    p.counters[key] = (p.counters[key] || 0) + amount;
  }

  emit(event) {
    this.events.push(event);
  }

  isEnemy(a, b) {
    if (a === b) return false;
    return this.mode.isEnemy ? this.mode.isEnemy(this, a, b) : a.side !== b.side;
  }

  spawnPoint(p) {
    if (this.mode.spawnPoint) return this.mode.spawnPoint(this, p);
    const key = this.world.spawns[p.side] ? p.side : p.team;
    const spots = this.world.spawns[key];
    const cursor = this.spawnCursor[key] || 0;
    this.spawnCursor[key] = cursor + 1;
    return spots[cursor % spots.length];
  }

  spawn(p) {
    const [x, y, z] = this.spawnPoint(p);
    Object.assign(p, { x, y, z, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, speed: 0, boostTime: 0, stunTime: 0 });
    p.yaw = p.side === Object.keys(this.world.spawns)[0] || p.team === Object.keys(this.world.spawns)[0] ? -Math.PI / 2 : Math.PI / 2;
    p.heading = this.world.heading ?? p.yaw;
    p.hp = p.stats.maxHp;
    p.alive = true;
    p.downed = false;
    p.protectedUntil = this.time + (this.mode.spawnProtection ?? SPAWN_PROTECTION_SECONDS);
    p.shieldUntil = 0;
    p.damagers.clear();
    p.history = [];
  }

  queueInput(key, input) {
    const p = this.byKey.get(key);
    if (!p || input.seq <= p.lastQueuedSeq) return;
    p.lastQueuedSeq = input.seq;
    p.queue.push(input);
    // Tickenként egy bemenet fogy: a gyorsabb küldés nem ad gyorsabb mozgást, csak eldobódik
    if (p.queue.length > MAX_QUEUED_INPUTS) p.queue.shift();
  }

  setConnected(key, connected) {
    const p = this.byKey.get(key);
    if (!p) return;
    p.connected = connected;
    // Visszatérő kliens 1-től számozza újra a bemeneteit
    if (connected) {
      p.lastQueuedSeq = 0;
      p.lastSeq = 0;
    } else {
      p.queue = [];
      p.input = { ...p.input, mx: 0, mz: 0, jump: false, sprint: false, fire: false, ability: false, interact: false };
    }
  }

  connectedOnSide(side) {
    return this.players.filter((p) => p.side === side && p.connected).length;
  }

  // Végleges kilépés: csapatmódban az elfogyott csapat veszít, különben a mód dönt
  abandon(key) {
    const p = this.byKey.get(key);
    if (!p || this.result) return;
    p.connected = false;
    this.mode.onAbandon?.(this, p);
    if (this.result) return;
    if (!this.players.some((q) => q.connected)) {
      this.finish(null, 'abandoned');
      return;
    }
    if (this.mode.teams) {
      const sides = Object.keys(this.score);
      const emptied = sides.find((side) => this.connectedOnSide(side) === 0);
      if (!emptied) return;
      this.finish(sides.find((side) => side !== emptied && this.connectedOnSide(side) > 0) || null, 'abandoned');
    }
  }

  tick() {
    if (this.result) return;
    this.time += this.dt;

    for (const p of this.players) {
      if (!p.alive && !p.downed && !p.eliminated && this.time >= p.respawnAt) {
        this.spawn(p);
        this.emit({ t: 'respawn', i: p.index });
      }
      const next = p.queue.shift();
      if (next) {
        p.input = next;
        p.lastSeq = next.seq;
        p.activeTicks += 1;
      } else {
        p.input = { ...p.input, ability: false };
      }
      p.yaw = p.input.yaw;
      p.pitch = p.input.pitch;

      if (p.alive) {
        if (this.mode.move) this.mode.move(this, p);
        else stepMovement(p, p.input, p.stats.speed, this.world, this.dt);
      }
      p.history.push({ x: p.x, y: p.y, z: p.z });
      if (p.history.length > REWIND_TICKS + 1) p.history.shift();
    }

    this.updateChaos();
    this.mode.tick?.(this);
    if (this.result) return;

    for (const p of this.players) {
      if (!p.alive || !p.connected) continue;
      if (this.mode.onAction) this.mode.onAction(this, p);
      else {
        if (p.input.ability) this.useAbility(p);
        if (p.input.fire) this.fire(p);
      }
      if (this.result) return;
    }

    if (this.time >= this.timeLimit) this.mode.onTimeUp(this);
  }

  // Ritka véletlen esemény: rövid ideig duplázza a tűzgyorsaságot
  updateChaos() {
    if (!this.chaosEnabled || this.time < this.chaosUntil) return;
    if (this.rng() < CHAOS_CHANCE_PER_SECOND * this.dt) {
      this.chaosUntil = this.time + CHAOS_DURATION;
      this.chaosSeen = true;
      this.emit({ t: 'chaos', until: CHAOS_DURATION });
    }
  }

  clearLine(ax, ay, az, bx, by, bz) {
    const d = [bx - ax, by - ay, bz - az];
    const span = Math.hypot(...d) || 0.001;
    return rayWorld([ax, ay, az], d.map((v) => v / span), this.world, span) >= span;
  }

  aimRay(p) {
    const cosPitch = Math.cos(p.pitch);
    return {
      origin: [p.x, p.y + AIM_HEIGHT, p.z],
      dir: [-Math.sin(p.yaw) * cosPitch, Math.sin(p.pitch), -Math.cos(p.yaw) * cosPitch]
    };
  }

  attackStats(p) {
    return p.attackOverride || p.weapon || p.stats;
  }

  fire(p) {
    if (this.time < p.nextFireAt) return;
    const attack = this.attackStats(p);
    const frenzy = this.time < this.chaosUntil ? 0.5 : 1;
    p.nextFireAt = this.time + attack.fireCooldown * frenzy;

    const { origin, dir } = this.aimRay(p);
    const wall = rayWorld(origin, dir, this.world, attack.range);
    let nearest = wall;
    let target = null;
    let kind = null;

    for (const enemy of this.players) {
      if (!enemy.alive || !this.isEnemy(p, enemy)) continue;
      const seen = enemy.history[0] || enemy;
      const r = BODY_RADIUS + HIT_PADDING;
      const t = rayBox(origin, dir, [seen.x - r, seen.y, seen.z - r], [seen.x + r, seen.y + BODY_HEIGHT + HIT_PADDING, seen.z + r], nearest);
      if (t !== null && t < nearest) {
        nearest = t;
        target = enemy;
        kind = 'player';
      }
    }
    for (const npc of this.npcs) {
      if (!npc.alive) continue;
      const r = BODY_RADIUS * npc.size + HIT_PADDING;
      const t = rayBox(origin, dir, [npc.x - r, npc.y, npc.z - r], [npc.x + r, npc.y + BODY_HEIGHT * npc.size, npc.z + r], nearest);
      if (t !== null && t < nearest) {
        nearest = t;
        target = npc;
        kind = 'npc';
      }
    }
    for (const s of this.structures) {
      if (s.hp <= 0 || s.side === p.side) continue;
      // A szerkezet maga is akadály, ezért a fal-távolság elé kell ellenőrizni
      const t = rayBox(origin, dir, s.min, s.max, attack.range);
      if (t !== null && t <= nearest + 0.05) {
        nearest = t;
        target = s;
        kind = 'structure';
      }
    }

    this.emit({ t: 'shot', i: p.index, to: origin.map((v, axis) => round(v + dir[axis] * nearest)), hit: kind === 'player' ? target.index : kind ? 9999 : -1 });
    if (kind === 'player') this.damage(target, attack.damage, p);
    else if (kind === 'npc') this.damageNpc(target, attack.damage, p);
    else if (kind === 'structure') this.damageStructure(target, attack.damage, p);
  }

  useAbility(p) {
    if (this.time < p.abilityReadyAt) return;
    const ability = p.stats.ability;
    p.abilityReadyAt = this.time + ability.cooldown;
    this.emit({ t: 'ability', i: p.index, kind: ability.kind });

    if (ability.kind === 'shield') {
      p.shieldUntil = this.time + ability.duration;
    } else if (ability.kind === 'dash') {
      const { mx, mz, yaw } = p.input;
      const len = Math.hypot(mx, mz);
      const fx = len > 0 ? mx / len : 0;
      const fz = len > 0 ? mz / len : 1;
      p.dashX = (fx * Math.cos(yaw) - fz * Math.sin(yaw)) * ability.speed;
      p.dashZ = (-fx * Math.sin(yaw) - fz * Math.cos(yaw)) * ability.speed;
      p.dashTime = ability.duration;
    } else if (ability.kind === 'blast') {
      this.blast(p, ability);
    }
  }

  blast(p, ability) {
    const inRange = (e) => {
      const dist = Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z);
      return dist <= ability.radius && this.clearLine(p.x, p.y + 1, p.z, e.x, e.y + 1, e.z);
    };
    for (const enemy of this.players) {
      if (!enemy.alive || !this.isEnemy(p, enemy) || !inRange(enemy)) continue;
      if (this.time >= enemy.protectedUntil) {
        const flat = Math.hypot(enemy.x - p.x, enemy.z - p.z) || 1;
        enemy.kx += ((enemy.x - p.x) / flat) * ability.knockback;
        enemy.kz += ((enemy.z - p.z) / flat) * ability.knockback;
        enemy.vy = Math.max(enemy.vy, 5);
      }
      this.damage(enemy, ability.damage, p);
      if (this.result) return;
    }
    for (const npc of this.npcs) {
      if (npc.alive && inRange(npc)) this.damageNpc(npc, ability.damage, p);
      if (this.result) return;
    }
  }

  // attacker: játékos, NPC, vagy null (környezeti sebzés)
  damage(target, amount, attacker = null) {
    if (!target.alive || this.time < target.protectedUntil) return;
    const reduction = this.time < target.shieldUntil ? target.stats.ability.reduction : 0;
    let remaining = Math.round(amount * (1 - reduction));
    if (target.armor > 0) {
      const absorbed = Math.min(target.armor, remaining);
      target.armor -= absorbed;
      remaining -= absorbed;
    }
    const dealt = Math.min(target.hp, remaining);
    target.hp -= dealt;
    if (attacker?.isPlayer) {
      attacker.damage += dealt;
      target.damagers.set(attacker.index, (target.damagers.get(attacker.index) || 0) + dealt);
    }
    this.emit({ t: 'hit', i: target.index, by: attacker?.isPlayer ? attacker.index : -1, dmg: dealt });
    if (target.hp <= 0) this.kill(target, attacker);
  }

  damageNpc(npc, amount, attacker) {
    if (!npc.alive) return;
    const dealt = Math.min(npc.hp, amount);
    npc.hp -= dealt;
    if (attacker?.isPlayer) {
      attacker.damage += dealt;
      npc.damagers.set(attacker.index, (npc.damagers.get(attacker.index) || 0) + dealt);
      this.emit({ t: 'npc_hit', id: npc.id, by: attacker.index });
    }
    if (npc.hp <= 0) {
      npc.alive = false;
      if (attacker?.isPlayer) attacker.kills += 1;
      this.emit({ t: 'npc_kill', id: npc.id, by: attacker?.isPlayer ? attacker.index : -1 });
      this.mode.onNpcDeath?.(this, npc, attacker);
      this.npcs = this.npcs.filter((n) => n.alive);
    }
  }

  damageStructure(s, amount, attacker) {
    const multiplier = attacker && this.mode.structureMultiplier ? this.mode.structureMultiplier(this, attacker) : 1;
    const dealt = Math.min(s.hp, Math.round(amount * multiplier));
    s.hp -= dealt;
    if (attacker?.isPlayer) {
      attacker.damage += dealt;
      this.count(attacker, 'structure_damage', dealt);
    }
    if (s.hp <= 0) {
      this.emit({ t: 'structure_down', id: s.id, by: attacker?.isPlayer ? attacker.index : -1 });
      this.mode.onStructureDown?.(this, s, attacker);
    }
  }

  kill(target, attacker) {
    target.alive = false;
    target.deaths += 1;
    target.respawnAt = this.time + (this.mode.respawnSeconds ?? RESPAWN_SECONDS);
    if (attacker?.isPlayer) {
      attacker.kills += 1;
      this.count(attacker, `kills_${attacker.team}`);
    }
    for (const [index, dealt] of target.damagers) {
      if ((!attacker || index !== attacker.index) && dealt >= target.stats.maxHp * 0.25) this.players[index].assists += 1;
    }
    this.emit({ t: 'kill', i: target.index, by: attacker?.isPlayer ? attacker.index : -1 });
    this.mode.onDeath(this, target, attacker);
  }

  spawnNpc(type, x, z, multiplier = {}) {
    const def = NPCS[type];
    const npc = {
      id: this.nextNpcId++, type, def, x, y: 0, z, vy: 0, kx: 0, kz: 0, onGround: true, dashTime: 0, dashX: 0, dashZ: 0,
      yaw: 0, size: def.size, alive: true,
      hp: Math.round(def.hp * (multiplier.hp || 1)), maxHp: Math.round(def.hp * (multiplier.hp || 1)),
      damageMul: multiplier.damage || 1, nextAttackAt: this.time + 1, damagers: new Map()
    };
    this.npcs.push(npc);
    return npc;
  }

  addPickup(type, x, z) {
    const pickup = { id: this.nextPickupId++, type, x, y: 0.6, z };
    this.pickups.push(pickup);
    this.emit({ t: 'pickup_add', p: pickup });
    return pickup;
  }

  removePickup(pickup) {
    this.pickups = this.pickups.filter((q) => q !== pickup);
    this.emit({ t: 'pickup_gone', id: pickup.id });
  }

  addHazard(x, z, r, armIn, duration, dps, burst = 0) {
    const hazard = { id: this.nextHazardId++, x, z, r, armAt: this.time + armIn, until: this.time + armIn + duration, dps, burst, burstDone: false };
    this.hazards.push(hazard);
    return hazard;
  }

  updateHazards() {
    for (const h of this.hazards) {
      if (this.time < h.armAt) continue;
      const fresh = !h.burstDone;
      h.burstDone = true;
      for (const p of this.players) {
        if (!p.alive || Math.hypot(p.x - h.x, p.z - h.z) > h.r) continue;
        if (fresh && h.burst) this.damage(p, h.burst, null);
        if (h.dps && Math.floor(this.time) !== Math.floor(this.time - this.dt)) this.damage(p, h.dps, null);
        if (this.result) return;
      }
    }
    this.hazards = this.hazards.filter((h) => this.time < h.until);
  }

  finish(winner, reason, extra = {}) {
    if (this.result) return;
    if (this.state.onFinish) this.state.onFinish();
    this.result = {
      matchId: this.id,
      mode: this.mode.id,
      winner,
      reason,
      pve: this.mode.pve === true,
      ffa: this.mode.ffa === true,
      score: { ...this.score },
      durationS: Math.round(this.time),
      playerCount: this.players.length,
      chaos: this.chaosSeen,
      ...extra,
      players: this.players.map((p) => ({
        i: p.index, key: p.key, username: p.username, team: p.team, side: p.side, characterId: p.characterId,
        kills: p.kills, deaths: p.deaths, assists: p.assists, damage: p.damage,
        connected: p.connected, place: p.place,
        outcome: this.mode.outcome?.(this, p, winner),
        counters: { ...p.counters },
        bonusXp: p.bonusXp,
        activeShare: this.time > 0 ? Math.min(1, p.activeTicks / (this.time * this.tickRate)) : 0
      }))
    };
  }

  drainEvents() {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  playerEntry(p) {
    const flags =
      (p.alive ? 1 : 0) | (this.time < p.shieldUntil ? 2 : 0) | (p.onGround ? 4 : 0) |
      (p.input.mx || p.input.mz ? 8 : 0) | (p.connected ? 16 : 0) | (this.time < p.protectedUntil ? 32 : 0) |
      (p.downed ? 64 : 0) | (p.eliminated ? 128 : 0);
    return [
      round(p.x), round(p.y), round(p.z), round(p.yaw), round(p.pitch), p.hp, flags, p.lastSeq,
      round(p.vy), round(p.kx), round(p.kz), round(p.dashTime), round(p.dashX), round(p.dashZ),
      Math.max(0, Math.ceil((p.abilityReadyAt - this.time) * 10)),
      p.kills, p.deaths,
      p.alive || p.downed || p.eliminated ? 0 : Math.max(0, Math.ceil((p.respawnAt - this.time) * 10)),
      p.side, round(p.speed), round(p.heading), p.lap, p.checkpoint, round(p.nitro), round(p.boostTime), round(p.stunTime),
      p.weapon?.id || p.item || '', p.armor, p.place, Math.round(p.revive * 10)
    ];
  }

  snapshot() {
    const snapshot = {
      t: round(this.time),
      left: Math.max(0, Math.ceil(this.timeLimit - this.time)),
      score: this.score,
      p: this.players.map((p) => this.playerEntry(p))
    };
    if (this.npcs.length || this.mode.pve) snapshot.n = this.npcs.map((n) => [n.id, n.type, round(n.x), round(n.y), round(n.z), round(n.yaw), n.hp, n.maxHp]);
    if (this.hazards.length) snapshot.hz = this.hazards.map((h) => [h.id, round(h.x), round(h.z), h.r, this.time >= h.armAt ? 1 : 0]);
    if (this.structures.length) snapshot.st = this.structures.map((s) => s.hp);
    const hud = this.mode.hud?.(this);
    if (hud) snapshot.m = hud;
    return snapshot;
  }
}

module.exports = { Match, REWIND_TICKS };
