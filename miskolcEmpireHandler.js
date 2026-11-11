// MiskolcEmpire: valós idejű stratégiai játék szobák, lobbik és meccsek Socket.IO-n.
// A szimuláció a miskolcEmpire/ mappában van, itt csak a hálózati réteg, a lobby és az életciklus él.
const crypto = require('crypto');
const content = require('./miskolcEmpire/content');
const { EmpireMatch } = require('./miskolcEmpire/simulation');
const { createAi } = require('./miskolcEmpire/ai');
const { createView, resetView, buildTick } = require('./miskolcEmpire/view');
const { createEmpireStore } = require('./miskolcEmpire/store');

const GRACE_MS = 45000;
const TICK_MS = 100;
const MAX_STEPS_PER_FIRE = 3;
const BROWSE_ROOM = 'empire:browse';
const MODES = ['ai', '1v1', '2v2', 'ffa'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const fail = (error) => ({ ok: false, error });
const CHAT_MAX = 200;

function setupMiskolcEmpire(io, users, opts = {}) {
  const db = opts.db || require('./database').db;
  const store = createEmpireStore(db);
  const graceMs = opts.graceMs ?? GRACE_MS;
  const tickMs = opts.tickMs ?? TICK_MS;
  const now = opts.now || Date.now;

  const sessions = new Map(); // roomId -> session
  const bindings = new Map(); // socket.id -> { roomId, idx }
  const accountRoom = new Map(); // accountId -> roomId (csak hitelesített fiók)
  let timer = null;
  let acc = 0;
  let lastFire = 0;

  const roomOf = (roomId) => `empire:${roomId}`;
  const teamFor = (mode, idx) => (mode === '2v2' ? idx % 2 : idx);
  const colorFor = (idx) => content.PLAYER_COLORS[idx % content.PLAYER_COLORS.length];

  function summary(s) {
    return {
      roomId: s.roomId, channelId: s.channelId, name: s.name, mode: s.mode, status: s.status, active: s.status !== 'ended',
      startedBy: s.startedBy, host: s.host,
      players: s.players.map((p) => ({ idx: p.idx, name: p.name, team: p.team, color: p.color, isAi: p.isAi, connected: p.isAi ? true : p.connected })),
      maxPlayers: s.maxPlayers, difficulty: s.difficulty, mapSize: s.mapSize || null
    };
  }

  const emitSession = (s, state) => {
    const payload = { channelId: s.channelId, roomId: s.roomId, state };
    if (s.channelId) io.to(s.channelId).to(roomOf(s.roomId)).emit('empire:session-updated', payload);
    else io.to(roomOf(s.roomId)).emit('empire:session-updated', payload);
  };
  const broadcastMatches = () => io.to(BROWSE_ROOM).emit('empire:matches', [...sessions.values()].map(summary));
  const sessionChanged = (s) => { emitSession(s, summary(s)); broadcastMatches(); };

  const socketOf = (id) => (id ? io.sockets.sockets.get(id) : null);

  // ---------- Korlátozás ----------
  const buckets = new WeakMap();
  function allow(socket, kind) {
    const cap = kind === 'cmd' ? 60 : kind === 'chat' ? 5 : 12;
    const rate = kind === 'cmd' ? 40 : kind === 'chat' ? 1 : 6;
    let all = buckets.get(socket);
    if (!all) { all = {}; buckets.set(socket, all); }
    const t = now();
    const b = all[kind] || (all[kind] = { tokens: cap, t });
    b.tokens = Math.min(cap, b.tokens + ((t - b.t) / 1000) * rate);
    b.t = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // ---------- Életciklus ----------
  function release(s, p) {
    if (p.socketId && bindings.get(p.socketId)?.roomId === s.roomId) bindings.delete(p.socketId);
    const sock = socketOf(p.socketId);
    if (sock) sock.leave(roomOf(s.roomId));
    if (p.accountId && accountRoom.get(p.accountId) === s.roomId) accountRoom.delete(p.accountId);
  }

  function dropSession(s) {
    for (const p of s.players) release(s, p);
    sessions.delete(s.roomId);
    stopLoopIfIdle();
  }

  function sendSnapshot(s, p) {
    const sock = socketOf(p.socketId);
    if (!sock || !s.match) return;
    const snap = s.match.snapshot(p.idx);
    snap.roomId = s.roomId;
    resetView(s.match, p.idx, p.view, snap);
    sock.emit('empire:snapshot', snap);
    return snap;
  }

  function addHuman(s, socket, user) {
    const idx = s.players.length;
    const p = {
      idx, name: String(user.username || 'Vendég').slice(0, 24), team: teamFor(s.mode, idx), color: colorFor(idx), isAi: false, connected: true,
      accountId: user.authenticated === true && user.accountId ? String(user.accountId) : null, socketId: socket.id,
      token: crypto.randomBytes(16).toString('hex'), view: createView(), budget: graceMs, left: false
    };
    s.players.push(p);
    bindings.set(socket.id, { roomId: s.roomId, idx });
    if (p.accountId) accountRoom.set(p.accountId, s.roomId);
    socket.join(roomOf(s.roomId));
    return p;
  }

  function reindex(s) {
    s.players.forEach((p, i) => {
      p.idx = i; p.team = teamFor(s.mode, i); p.color = colorFor(i);
      if (p.socketId && bindings.has(p.socketId)) bindings.set(p.socketId, { roomId: s.roomId, idx: i });
    });
  }

  function leaveLobby(s, p) {
    release(s, p);
    const old = p.idx;
    s.players.splice(old, 1);
    if (!s.players.some((x) => !x.isAi)) {
      emitSession(s, null);
      dropSession(s);
      broadcastMatches();
      return;
    }
    reindex(s);
    if (old === s.host) s.host = s.players.findIndex((x) => !x.isAi);
    else if (old < s.host) s.host -= 1;
    sessionChanged(s);
  }

  function startMatch(s, fillWithAi, difficulty) {
    if (fillWithAi) {
      while (s.players.length < s.maxPlayers) {
        const idx = s.players.length;
        s.players.push({ idx, name: `Gép ${idx + 1}`, team: teamFor(s.mode, idx), color: colorFor(idx), isAi: true, connected: true, difficulty, accountId: null, socketId: null });
      }
    }
    const teams = new Set(s.players.map((p) => p.team));
    if (s.players.length < 2 || teams.size < 2) {
      s.players = s.players.filter((p) => !p.isAi);
      return false;
    }
    s.difficulty = difficulty;
    s.match = new EmpireMatch({
      seed: opts.seed ?? crypto.randomBytes(4).readUInt32LE(0),
      players: s.players.map((p) => ({ name: p.name, team: p.team, isAi: p.isAi, difficulty: p.difficulty || difficulty, color: p.color })),
      createAi,
      mapSize: s.mapSize || null
    });
    s.status = 'playing';
    s.lastService = now();
    s.pauseKey = '';
    for (const p of s.players) if (!p.isAi) { s.match.players[p.idx].connected = p.connected; sendSnapshot(s, p); }
    startLoop();
    sessionChanged(s);
    return true;
  }

  function finish(s, discard) {
    const m = s.match;
    if (!discard && m) {
      const results = m.results();
      const vsAi = s.players.some((p) => p.isAi);
      store.record(s.players.filter((p) => p.accountId).map((p) => {
        const r = results[p.idx];
        return { accountId: p.accountId, username: p.name, won: r.won, vsAi, unitsKilled: r.unitsKilled, buildingsDestroyed: r.buildingsDestroyed, gathered: r.gathered };
      }));
      const payload = { roomId: s.roomId, winnerTeam: m.winnerTeam, results };
      for (const p of s.players) { const sock = socketOf(p.socketId); if (sock) sock.emit('empire:match-ended', payload); }
    }
    s.status = 'ended';
    emitSession(s, null);
    dropSession(s);
    broadcastMatches();
  }

  // stay: a feladó a szobában marad megfigyelőként (empire:resign); különben kilép (leave-match, türelmi idő)
  function resignPlayer(s, p, auto, stay = false) {
    const m = s.match;
    if (!m || p.left) return;
    if (auto && !s.players.some((x) => !x.isAi && x !== p && !x.left && x.connected)) {
      // Mindenki lekapcsolódott: a meccs eldobva, nem számít bele a statisztikába
      return finish(s, true);
    }
    m.resign(p.idx);
    if (!stay) leaveMatch(s, p);
    if (m.status === 'ended') return finish(s, false);
    sessionChanged(s);
  }

  // Végleges kilépés egy futó meccsből (megfigyelő is): nem kap több ticket
  function leaveMatch(s, p) {
    p.left = true;
    release(s, p);
    p.connected = false;
    s.match.players[p.idx].connected = false;
  }

  const isSpectator = (s, p) => !!(s.match && s.match.players[p.idx] && s.match.players[p.idx].spectator);

  // ---------- Szünet és türelmi idő ----------
  function service(s) {
    const m = s.match;
    if (!m || s.status !== 'playing') return;
    const t = now();
    const dt = Math.max(0, t - s.lastService);
    s.lastService = t;
    const away = s.players.filter((p) => !p.isAi && !p.left && !p.connected && m.players[p.idx].alive);
    for (const p of away) p.budget -= dt;
    for (const p of away.filter((x) => x.budget <= 0)) {
      if (s.status !== 'playing') return;
      resignPlayer(s, p, true);
    }
    if (s.status !== 'playing') return;
    // Nincs élő ember a meccsben, és megfigyelő sincs csatlakozva: senki sem nézi, a meccs eldobva
    const humans = s.players.filter((p) => !p.isAi && !p.left);
    if (!humans.some((p) => m.players[p.idx].alive) && !humans.some((p) => p.connected)) return finish(s, true);
    const waiting = s.players.filter((p) => !p.isAi && !p.left && !p.connected && m.players[p.idx].alive);
    if (!waiting.length) {
      if (m.paused) { m.paused = null; s.pauseKey = ''; m.notify('A játék folytatódik.'); }
      return;
    }
    const key = waiting.map((p) => p.idx).join(',');
    if (!m.paused || s.pauseKey !== key) {
      s.pauseKey = key;
      m.paused = { reason: 'Egy játékos kapcsolata megszakadt. Várunk rá.', untilMs: t + Math.max(0, Math.min(...waiting.map((p) => p.budget))) };
    }
  }

  function runStep(s) {
    const m = s.match;
    if (!m || s.status !== 'playing') return;
    try {
      if (m.paused) m.prepareIdle(); else m.step();
      for (const p of s.players) {
        if (p.isAi || !p.connected || p.left) continue;
        const sock = socketOf(p.socketId);
        if (!sock) continue;
        const tick = buildTick(m, p.idx, p.view);
        if (tick) sock.emit('empire:tick', tick);
        // Kiesés után egyszer friss, szűretlen snapshot (you.spectator: true)
        if (m.players[p.idx].spectator && !p.specSent) { p.specSent = true; sendSnapshot(s, p); }
      }
      if (m.status === 'ended') finish(s, false);
    } catch (err) {
      console.error('[MiskolcEmpire] hiba a meccs léptetésekor:', err);
      finish(s, true);
    }
  }

  function tick() {
    for (const s of [...sessions.values()]) { service(s); runStep(s); }
  }

  function fire() {
    const t = now();
    acc += Math.min(1000, t - lastFire);
    lastFire = t;
    for (const s of [...sessions.values()]) service(s);
    let n = 0;
    while (acc >= tickMs && n < MAX_STEPS_PER_FIRE) {
      for (const s of [...sessions.values()]) runStep(s);
      acc -= tickMs; n++;
    }
    if (acc > tickMs * MAX_STEPS_PER_FIRE) acc = 0;
  }

  function startLoop() {
    if (timer) return;
    lastFire = now(); acc = 0;
    timer = setInterval(fire, tickMs);
    if (timer.unref) timer.unref();
  }
  function stopLoopIfIdle() {
    if (timer && ![...sessions.values()].some((s) => s.status === 'playing')) { clearInterval(timer); timer = null; }
  }

  // ---------- Események ----------
  io.on('connection', (socket) => {
    const respond = (ack, res) => { if (typeof ack === 'function') ack(res); };
    const guard = (event, kind, fn) => {
      socket.on(event, (payload, ack) => {
        if (typeof payload === 'function') { ack = payload; payload = undefined; }
        try {
          const user = users.get(socket.id);
          if (!user) return respond(ack, fail('Nem vagy bejelentkezve.'));
          if (!allow(socket, kind)) return respond(ack, fail('Túl gyorsan küldesz parancsokat.'));
          respond(ack, fn(user, isObj(payload) ? payload : {}));
        } catch (err) {
          console.error(`[MiskolcEmpire] ${event}:`, err);
          respond(ack, fail('Váratlan hiba történt.'));
        }
      });
    };

    const mySession = () => {
      const b = bindings.get(socket.id);
      const s = b && sessions.get(b.roomId);
      return s ? { s, p: s.players[b.idx] } : null;
    };
    const alreadyIn = (user) => bindings.has(socket.id) || (user.authenticated === true && user.accountId && accountRoom.has(String(user.accountId)));

    guard('empire:get-content', 'misc', () => ({ ok: true, content: content.getContent() }));

    guard('empire:get-stats', 'misc', (user) => ({
      ok: true,
      stats: user.authenticated === true && user.accountId ? store.get(String(user.accountId)) : null,
      top: store.top(10)
    }));

    guard('empire:list-matches', 'misc', () => {
      socket.join(BROWSE_ROOM);
      return { ok: true, matches: [...sessions.values()].map(summary) };
    });

    guard('empire:create-match', 'misc', (user, d) => {
      if (!MODES.includes(d.mode)) return fail('Ismeretlen játékmód.');
      if (alreadyIn(user)) return fail('Már egy meccsben vagy.');
      let channelId = null;
      if (d.channelId !== undefined && d.channelId !== null) {
        if (!str(d.channelId, 80)) return fail('Érvénytelen szoba.');
        if (user.voiceChannel !== d.channelId) return fail('Előbb lépj be a hangszobába.');
        const existing = sessions.get(d.channelId);
        if (existing) return fail('Ebben a szobában már folyik egy játék.');
        channelId = d.channelId;
      }
      const difficulty = d.difficulty === undefined ? 'medium' : d.difficulty;
      if (!content.DIFFICULTIES.includes(difficulty)) return fail('Ismeretlen nehézségi szint.');
      let maxPlayers = d.mode === '1v1' ? 2 : d.mode === '2v2' ? 4 : 2;
      if (d.mode === 'ffa') maxPlayers = 4;
      if (d.maxPlayers !== undefined && (d.mode === 'ffa' || d.mode === 'ai')) {
        if (!Number.isInteger(d.maxPlayers) || d.maxPlayers < 2 || d.maxPlayers > 4) return fail('Érvénytelen játékosszám.');
        maxPlayers = d.maxPlayers;
      }
      let mapSize = null;
      if (d.mapSize !== undefined && d.mapSize !== null) {
        if (!content.MAP_SIZE_IDS.includes(d.mapSize)) return fail('Ismeretlen térképméret.');
        mapSize = d.mapSize;
      }
      let name = `${String(user.username || 'Vendég').slice(0, 24)} játéka`;
      if (d.name !== undefined) {
        if (typeof d.name !== 'string' || d.name.trim().length === 0 || d.name.length > 40) return fail('Érvénytelen név.');
        name = d.name.trim();
      }
      const roomId = channelId || `lobby-${crypto.randomBytes(4).toString('hex')}`;
      const s = { roomId, channelId, name, mode: d.mode, status: 'lobby', difficulty, maxPlayers, mapSize, startedBy: String(user.username || 'Vendég'), host: 0, players: [], match: null, createdAt: now() };
      sessions.set(roomId, s);
      const p = addHuman(s, socket, user);
      if (d.mode === 'ai') startMatch(s, true, difficulty);
      else sessionChanged(s);
      return { ok: true, roomId, rejoinToken: p.token, idx: p.idx, summary: summary(s) };
    });

    guard('empire:join-match', 'misc', (user, d) => {
      if (!str(d.roomId, 80)) return fail('Érvénytelen szoba.');
      const s = sessions.get(d.roomId);
      if (!s) return fail('Nincs ilyen meccs.');
      if (s.status === 'lobby') {
        if (alreadyIn(user)) return fail('Már egy meccsben vagy.');
        if (s.channelId && user.voiceChannel !== s.channelId) return fail('Előbb lépj be a hangszobába.');
        if (s.players.length >= s.maxPlayers) return fail('Megtelt a meccs.');
        const p = addHuman(s, socket, user);
        sessionChanged(s);
        return { ok: true, roomId: s.roomId, rejoinToken: p.token, idx: p.idx, summary: summary(s) };
      }
      // Újracsatlakozás: hitelesített fióknál a fiókazonosító, vendégnél a token
      const token = typeof d.rejoinToken === 'string' && d.rejoinToken.length <= 64 ? d.rejoinToken : null;
      const p = s.players.find((x) => !x.isAi && !x.left && (
        (token && x.token === token) || (user.authenticated === true && user.accountId && x.accountId === String(user.accountId))
      ));
      if (!p) return fail('A játék már folyik, nem csatlakozhatsz.');
      const elsewhere = (bindings.has(socket.id) && bindings.get(socket.id).roomId !== s.roomId)
        || (user.authenticated === true && user.accountId && accountRoom.has(String(user.accountId)) && accountRoom.get(String(user.accountId)) !== s.roomId);
      if (elsewhere) return fail('Már egy másik meccsben vagy.');
      if (p.socketId && p.socketId !== socket.id) {
        const old = socketOf(p.socketId);
        if (old) old.leave(roomOf(s.roomId));
        bindings.delete(p.socketId);
      }
      p.socketId = socket.id;
      p.connected = true;
      bindings.set(socket.id, { roomId: s.roomId, idx: p.idx });
      if (p.accountId) accountRoom.set(p.accountId, s.roomId);
      socket.join(roomOf(s.roomId));
      s.match.players[p.idx].connected = true;
      s.match.notify(`${p.name} visszatért.`);
      sendSnapshot(s, p);
      sessionChanged(s);
      return { ok: true, roomId: s.roomId, rejoinToken: p.token, idx: p.idx, summary: summary(s) };
    });

    guard('empire:start-match', 'misc', (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      const { s, p } = me;
      if (s.status !== 'lobby') return fail('A meccs már elindult.');
      if (s.host !== p.idx) return fail('Csak a házigazda indíthatja el.');
      const difficulty = d.difficulty === undefined ? s.difficulty : d.difficulty;
      if (!content.DIFFICULTIES.includes(difficulty)) return fail('Ismeretlen nehézségi szint.');
      if (d.mapSize !== undefined && d.mapSize !== null) {
        if (!content.MAP_SIZE_IDS.includes(d.mapSize)) return fail('Ismeretlen térképméret.');
        s.mapSize = d.mapSize;
      }
      if (!startMatch(s, d.fillWithAi === true, difficulty)) return fail('Nincs elég játékos az induláshoz.');
      return { ok: true, roomId: s.roomId, summary: summary(s) };
    });

    const leave = (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      const { s, p } = me;
      if (s.status === 'lobby') leaveLobby(s, p);
      else if (isSpectator(s, p)) { leaveMatch(s, p); sessionChanged(s); }
      else resignPlayer(s, p, false);
      return { ok: true };
    };
    guard('empire:leave-match', 'misc', leave);
    guard('empire:resign', 'misc', (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      if (me.s.status !== 'playing') return fail('A meccs nem fut.');
      if (isSpectator(me.s, me.p)) return fail('Már kiestél a játékból.');
      resignPlayer(me.s, me.p, false, true);
      return { ok: true };
    });

    guard('empire:get-state', 'misc', (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      if (me.s.status !== 'playing') return { ok: true, summary: summary(me.s) };
      const snapshot = sendSnapshot(me.s, me.p);
      return { ok: true, snapshot, summary: summary(me.s) };
    });

    guard('empire:command', 'cmd', (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      if (me.s.status !== 'playing' || me.p.left) return fail('A meccs nem fut.');
      return me.s.match.command(me.p.idx, d);
    });

    guard('empire:demolish-building', 'cmd', (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      if (me.s.status !== 'playing' || me.p.left) return fail('A meccs nem fut.');
      return me.s.match.command(me.p.idx, { type: 'demolish', buildingId: d.buildingId });
    });

    guard('empire:chat', 'chat', (user, d) => {
      const me = mySession();
      if (!me || !str(d.roomId, 80) || me.s.roomId !== d.roomId) return fail('Nem vagy ebben a meccsben.');
      if (me.s.status === 'ended' || me.p.left) return fail('A meccs nem fut.');
      const text = typeof d.text === 'string' ? d.text.trim() : '';
      if (text.length < 1 || text.length > CHAT_MAX) return fail('Az üzenet 1-200 karakter lehet.');
      const spectator = isSpectator(me.s, me.p);
      io.to(roomOf(me.s.roomId)).emit('empire:chat', { from: (spectator ? '[Néző] ' : '') + me.p.name, idx: me.p.idx, text, spectator, t: now() });
      return { ok: true };
    });

    socket.on('disconnect', () => {
      const b = bindings.get(socket.id);
      bindings.delete(socket.id);
      const s = b && sessions.get(b.roomId);
      if (!s) return;
      const p = s.players[b.idx];
      if (!p || p.socketId !== socket.id) return;
      if (s.status === 'lobby') { leaveLobby(s, p); return; }
      if (p.left) return;
      p.connected = false;
      s.match.players[p.idx].connected = false;
      s.match.notify(`${p.name} lekapcsolódott.`);
      sessionChanged(s);
    });
  });

  return {
    getSession: (channelId) => { const s = sessions.get(channelId); return s ? summary(s) : null; },
    getEmpireSessions: () => {
      const out = {};
      for (const s of sessions.values()) if (s.channelId) out[s.channelId] = summary(s);
      return out;
    },
    // Tesztekhez: egy kézi tick és a belső állapot
    tick,
    sessions,
    store,
    close() { if (timer) { clearInterval(timer); timer = null; } }
  };
}

module.exports = { setupMiskolcEmpire };
