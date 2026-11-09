// Hangszobákhoz kötött játéklobbik és meccsek a meglévő Socket.IO kapcsolaton.
// Minden bejövő esemény validált és hibatűrő: egy elromlott meccs nem érintheti a szerver többi részét.
const crypto = require('crypto');
const { FACTIONS, CHARACTERS, BATHROOM_ARENA, TEAMS, MAPS, NPCS, WEAPONS, DIFFICULTIES } = require('./content');
const { MODES, publicModes } = require('./modes');
const { GameError } = require('./meta');
const { Match } = require('./simulation');
const { createGameStore } = require('./store');
const { levelFromXp } = require('./progression');

const SNAPSHOT_EVERY_TICKS = 2;
const COUNTDOWN_MS = 3000;
const RECONNECT_GRACE_MS = 30000;
const PRIVATE_CODE_RE = /^private:[A-Z0-9]{6}$/;
const MAINTENANCE_MS = 60000;
const EMOTE_FALLBACK = '👋';
const MAX_INPUTS_PER_SECOND = 90;
const MAX_ACTIONS_PER_SECOND = 15;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function parseInput(raw) {
  if (!Array.isArray(raw) || raw.length !== 6 || !raw.every(isNum)) return null;
  const [seq, mx, mz, yaw, pitch, bits] = raw;
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return {
    seq,
    mx: clamp(mx, -1, 1),
    mz: clamp(mz, -1, 1),
    yaw: ((yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI,
    pitch: clamp(pitch, -1.45, 1.45),
    jump: (bits & 1) !== 0,
    sprint: (bits & 2) !== 0,
    fire: (bits & 4) !== 0,
    ability: (bits & 8) !== 0,
    interact: (bits & 16) !== 0
  };
}

module.exports = function setupGame(io, options = {}) {
  const users = options.users || require('../state').users;
  const store = createGameStore(options.db || require('../database').db, options);
  const { meta } = store;
  const matchOverrides = options.match || {};
  const graceMs = options.graceMs ?? RECONNECT_GRACE_MS;
  const countdownMs = options.countdownMs ?? COUNTDOWN_MS;

  const lobbies = new Map(); // channelId -> lobby
  const liveByKey = new Map(); // játékos kulcs -> futó meccs

  const playerKey = (socket, user) =>
    user.authenticated === true && user.accountId ? `acc:${user.accountId}` : `guest:${socket.id}`;
  const lobbyRoom = (channelId) => `game:${channelId}`;
  const matchRoom = (id) => `game:match:${id}`;

  const isVoiceLobby = (channelId) => !channelId.startsWith('public:') && !channelId.startsWith('private:');
  const modeOf = (lobby) => MODES[lobby.mode];
  const teamLimit = (mode) => (mode.teams ? Math.ceil(mode.max / 2) : mode.max);
  const worldFor = (lobby) => {
    if (options.world && lobby.mode === 'team_deathmatch') return options.world;
    if (lobby.mode === 'racing' && lobby.options.trackId && MAPS[lobby.options.trackId]) return MAPS[lobby.options.trackId];
    return MAPS[modeOf(lobby).map] || BATHROOM_ARENA;
  };
  const socketsOfAccount = (accountId) => {
    const out = [];
    for (const [id, u] of users) if (u.authenticated === true && u.accountId === accountId) out.push(id);
    return out;
  };
  const notify = (accountId, payload) => socketsOfAccount(accountId).forEach((id) => io.to(id).emit('game:notify', payload));

  const publicLobby = (lobby) => ({
    channelId: lobby.channelId,
    mode: lobby.mode,
    modeOptions: lobby.options,
    battle: lobby.battle ? { id: lobby.battle.id, territory: lobby.battle.territoryName, attacker: lobby.battle.attacker, defender: lobby.battle.defender } : null,
    phase: lobby.run ? 'playing' : lobby.countdownEndsAt ? 'countdown' : 'lobby',
    countdownMs: lobby.countdownEndsAt ? Math.max(0, lobby.countdownEndsAt - Date.now()) : 0,
    teamLimit: teamLimit(modeOf(lobby)),
    players: [...lobby.players.values()].map((p) => ({
      id: p.socketId, username: p.username, team: p.team, characterId: p.characterId, ready: p.ready, canEarnXp: !!p.accountId, title: p.title || null
    }))
  });

  const summary = (lobby) =>
    lobby && (lobby.run || lobby.players.size > 0)
      ? { channelId: lobby.channelId, active: !!lobby.run, playerCount: lobby.players.size, startedBy: lobby.startedBy }
      : null;

  function broadcastLobby(lobby) {
    io.to(lobbyRoom(lobby.channelId)).emit('game:lobby', publicLobby(lobby));
    io.to(lobby.channelId).emit('game:session-updated', { channelId: lobby.channelId, state: summary(lobby) });
  }

  function cleanupLobby(lobby) {
    if (lobby.players.size === 0 && !lobby.run) {
      clearTimeout(lobby.countdownTimer);
      lobbies.delete(lobby.channelId);
    }
  }

  function cancelCountdown(lobby) {
    if (!lobby.countdownEndsAt) return;
    clearTimeout(lobby.countdownTimer);
    lobby.countdownEndsAt = 0;
  }

  // A hangszobát időközben elhagyók nem kerülnek be a meccsbe
  const eligiblePlayers = (lobby) =>
    [...lobby.players.values()].filter((p) => users.has(p.socketId) && (!isVoiceLobby(lobby.channelId) || users.get(p.socketId).voiceChannel === lobby.channelId));

  function clanSides(players) {
    const clans = [...new Set(players.map((p) => (p.accountId ? meta.clanOf(p.accountId) : null)))];
    if (clans.includes(null) || clans.length !== 2) return null;
    return new Map(clans.map((clan, i) => [clan, i === 0 ? 'a' : 'b']));
  }

  const sideFor = (lobby, p, clans) => (lobby.mode === 'clan_wars' ? clans.get(meta.clanOf(p.accountId)) : p.team);

  function startProblem(lobby, players) {
    const mode = modeOf(lobby);
    if (meta.isModeDisabled(lobby.mode)) return 'Ezt a játékmódot az adminok kikapcsolták.';
    if (players.length < mode.min) return `Legalább ${mode.min} játékos kell.`;
    if (players.length > mode.max) return `Legfeljebb ${mode.max} játékos játszhat.`;
    if (lobby.battle) {
      if (!meta.getBattle(lobby.battle.id)) return 'Ez a csata már lezárult.';
      const sides = [lobby.battle.attacker, lobby.battle.defender];
      if (players.some((p) => !p.accountId || !meta.factionOf(p.accountId) || !sides.includes(meta.factionOf(p.accountId)))) return 'Csak a harcoló frakciók bejelentkezett tagjai vehetnek részt.';
      if (players.some((p) => p.team !== meta.factionOf(p.accountId))) return 'Mindenki a saját frakciója oldalán harcolhat.';
    }
    if (!mode.teams) return null;
    let clans = null;
    if (lobby.mode === 'clan_wars') {
      clans = clanSides(players);
      if (!clans) return 'A klánháborúhoz pontosan két klán bejelentkezett tagjai kellenek.';
    }
    const counts = {};
    for (const p of players) {
      const side = sideFor(lobby, p, clans);
      counts[side] = (counts[side] || 0) + 1;
    }
    const values = Object.values(counts);
    if (values.length < 2) return 'Mindkét csapatban kell lennie játékosnak.';
    if (Math.max(...values) - Math.min(...values) > 1) return 'A csapatok nincsenek kiegyensúlyozva.';
    return null;
  }

  function updateCountdown(lobby) {
    if (lobby.run) return;
    const players = [...lobby.players.values()];
    const shouldRun = players.length > 0 && players.every((p) => p.ready) && !startProblem(lobby, players);
    if (!shouldRun) {
      cancelCountdown(lobby);
      return;
    }
    if (lobby.countdownEndsAt) return;
    lobby.countdownEndsAt = Date.now() + countdownMs;
    lobby.countdownTimer = setTimeout(() => {
      lobby.countdownEndsAt = 0;
      try {
        startMatch(lobby);
      } catch (err) {
        console.error('[Game] Meccs indítási hiba:', err);
        io.to(lobbyRoom(lobby.channelId)).emit('game:error', { message: 'Nem sikerült elindítani a meccset.' });
      }
      broadcastLobby(lobby);
    }, countdownMs);
  }

  function matchInfo(run, index) {
    const { match } = run;
    return {
      matchId: match.id,
      you: index,
      mode: match.mode.id,
      modeName: match.mode.name,
      flags: { vehicle: match.mode.vehicle === true, pve: match.mode.pve === true, ffa: match.mode.ffa === true, teams: match.mode.teams === true },
      world: match.world,
      factions: FACTIONS,
      characters: CHARACTERS,
      npcDefs: NPCS,
      weapons: WEAPONS,
      pickups: match.pickups,
      structures: match.structures.map(({ id, side, kind, min, max, hp }) => ({ id, side, kind, min, max, hp })),
      scoreLimit: match.scoreLimit,
      timeLimit: match.timeLimit,
      tickRate: match.tickRate,
      snapshotMs: (1000 / match.tickRate) * SNAPSHOT_EVERY_TICKS,
      players: match.players.map((p) => ({ i: p.index, sid: run.sockets.get(p.key) || null, username: p.username, team: p.team, side: p.side, characterId: p.characterId, cosmetics: p.cosmetics }))
    };
  }

  // Nagy létszámú módban mindenki csak a közelben lévőket kapja meg
  function sendSnapshot(run) {
    const { match } = run;
    const snapshot = match.snapshot();
    const radius = match.mode.interestRadius;
    if (!radius) {
      io.to(matchRoom(match.id)).volatile.emit('game:snapshot', snapshot);
      return;
    }
    for (const viewer of match.players) {
      const socketId = run.sockets.get(viewer.key);
      if (!viewer.connected || !socketId) continue;
      const filtered = !viewer.alive ? snapshot : {
        ...snapshot,
        p: snapshot.p.map((entry, i) => {
          const other = match.players[i];
          return other === viewer || Math.hypot(other.x - viewer.x, other.z - viewer.z) <= radius ? entry : null;
        })
      };
      io.to(socketId).volatile.emit('game:snapshot', filtered);
    }
  }

  function startMatch(lobby) {
    const players = eligiblePlayers(lobby);
    const problem = startProblem(lobby, players);
    if (problem) {
      io.to(lobbyRoom(lobby.channelId)).emit('game:error', { message: problem });
      return;
    }

    const clans = lobby.mode === 'clan_wars' ? clanSides(players) : null;
    const match = new Match({
      id: crypto.randomUUID(),
      mode: lobby.mode,
      options: lobby.options,
      roster: players.map((p) => ({
        key: p.key, username: p.username, team: p.team, characterId: p.characterId,
        side: sideFor(lobby, p, clans),
        cosmetics: p.accountId ? meta.cosmeticsOf(p.accountId) : {}
      })),
      world: worldFor(lobby),
      characters: CHARACTERS,
      ...modeOf(lobby).defaults,
      ...matchOverrides
    });

    const run = {
      match,
      lobby,
      battle: lobby.battle || null,
      accounts: new Map(players.filter((p) => p.accountId).map((p) => [p.key, p.accountId])),
      sockets: new Map(players.map((p) => [p.key, p.socketId])),
      graceTimers: new Map(),
      ticks: 0,
      ended: false,
      nextTickAt: performance.now()
    };
    lobby.run = run;

    for (const p of players) {
      liveByKey.set(p.key, run);
      const socket = io.sockets.sockets.get(p.socketId);
      socket?.join(matchRoom(match.id));
      socket?.emit('game:match-start', matchInfo(run, match.byKey.get(p.key).index));
    }

    const stepMs = 1000 / match.tickRate;
    run.timer = setInterval(() => {
      try {
        // A setInterval csúszását pótló ticket futtat, de egy elakadás után nem próbál mindent behozni
        const now = performance.now();
        let steps = 0;
        while (run.nextTickAt <= now && steps < 5 && !match.result) {
          match.tick();
          run.nextTickAt += stepMs;
          run.ticks += 1;
          steps += 1;
          if (run.ticks % SNAPSHOT_EVERY_TICKS === 0) {
            sendSnapshot(run);
          }
        }
        if (run.nextTickAt <= now) run.nextTickAt = now + stepMs;
        const events = match.drainEvents();
        if (events.length) io.to(matchRoom(match.id)).emit('game:events', events);
        if (match.result) endMatch(run);
      } catch (err) {
        console.error('[Game] Szimulációs hiba, a meccs jutalom nélkül leáll:', err);
        abortMatch(run);
      }
    }, stepMs);
  }

  function releaseRun(run) {
    run.ended = true;
    clearInterval(run.timer);
    for (const timer of run.graceTimers.values()) clearTimeout(timer);
    for (const key of run.sockets.keys()) liveByKey.delete(key);
    io.in(matchRoom(run.match.id)).socketsLeave(matchRoom(run.match.id));
    const { lobby } = run;
    lobby.run = null;
    // Aki a meccs alatt elment vagy kilépett a nézetből, ne tartsa fel a következő indítást
    for (const [key, p] of lobby.players) {
      const socket = io.sockets.sockets.get(p.socketId);
      if (socket && !p.suspended) {
        p.ready = false;
      } else {
        socket?.leave(lobbyRoom(lobby.channelId));
        lobby.players.delete(key);
      }
    }
    broadcastLobby(lobby);
    cleanupLobby(lobby);
  }

  function endMatch(run) {
    if (run.ended) return;
    const { result } = run.match;
    let rewards = {};
    let rewardsSaved = true;
    try {
      const muted = new Set([...run.sockets].filter(([, id]) => users.get(id)?.isMuted === true).map(([key]) => key));
      const battle = run.battle;
      const battleWinner = !battle ? null : run.match.mode.id === 'survival' ? (result.reason === 'goal' ? battle.attacker : null) : result.winner;
      ({ rewards } = store.recordMatch(result, run.lobby.channelId, run.accounts, { muted, battleId: battle?.id, battleWinner }));
      if (battle) {
        run.lobby.battle = null;
        io.emit('game:war-updated', { territory: battle.territoryName });
      }
    } catch (err) {
      console.error('[Game] A meccs eredményét nem sikerült menteni:', err);
      rewardsSaved = false;
    }
    const publicPlayers = result.players.map(({ key: _key, activeShare: _share, counters: _counters, ...rest }) => rest);
    io.to(matchRoom(run.match.id)).emit('game:match-end', { ...result, players: publicPlayers, rewards, rewardsSaved });
    releaseRun(run);
  }

  function abortMatch(run) {
    if (run.ended) return;
    io.to(matchRoom(run.match.id)).emit('game:match-aborted', { message: 'A meccs szerverhiba miatt megszakadt, jutalom nem jár.' });
    releaseRun(run);
  }

  // Elment a kapcsolat vagy kilépett a nézetből: rövid ideig visszatérhet a meccsbe
  function suspendFromMatch(run, key) {
    if (run.ended || !run.match.byKey.has(key)) return;
    run.match.setConnected(key, false);
    const lobbyEntry = run.lobby.players.get(key);
    if (lobbyEntry) lobbyEntry.suspended = true;
    clearTimeout(run.graceTimers.get(key));
    run.graceTimers.set(key, setTimeout(() => {
      try {
        run.match.abandon(key);
        if (run.match.result) endMatch(run);
      } catch (err) {
        console.error('[Game] Kilépés kezelési hiba:', err);
      }
    }, graceMs));
  }

  function leaveLobby(socket, lobby) {
    for (const [key, p] of lobby.players) {
      if (p.socketId !== socket.id) continue;
      lobby.players.delete(key);
      socket.leave(lobbyRoom(lobby.channelId));
      if (lobby.startedBy === p.username && lobby.players.size > 0) {
        lobby.startedBy = lobby.players.values().next().value.username;
      }
      updateCountdown(lobby);
      broadcastLobby(lobby);
      cleanupLobby(lobby);
      return p;
    }
    return null;
  }

  const rpcMethods = {
    overview: (_p, id) => meta.overview(id),
    setFaction: (p, id, user) => meta.setFaction(id, user.username, p.faction),
    missions: (_p, id) => meta.missions(id),
    claimMission: (p, id) => meta.claimMission(id, p.id),
    achievements: (_p, id) => meta.achievements(id),
    shop: (_p, id) => ({ ...meta.catalogue(), wallet: meta.wallet(id) }),
    inventory: (_p, id) => meta.inventory(id),
    buy: (p, id) => meta.buy(id, p.id),
    equip: (p, id) => meta.equip(id, p.id, p.unequip === true),
    leaderboards: () => meta.leaderboards(),
    leaderboard: (p) => meta.leaderboard(p.id),
    clanInfo: (_p, id) => meta.clanInfo(id),
    clanCreate: (p, id) => meta.clanCreate(id, p.name, p.description),
    clanJoin: (p, id) => meta.clanJoin(id, p.id),
    clanLeave: (_p, id) => meta.clanLeave(id),
    clanInvite(p, id, user) {
      const { invited } = meta.clanInvite(id, p.username);
      notify(invited, { kind: 'info', text: `${user.username} meghívott a klánjába.` });
      return {};
    },
    clanKick: (p, id) => meta.clanKick(id, p.username),
    clanSetRank: (p, id) => meta.clanSetRank(id, p.username, p.rank),
    clanUpdate: (p, id) => meta.clanUpdate(id, p),
    clanChat(p, id, user) {
      const { clanId, entry } = meta.clanChat(id, user.username, p.text);
      for (const [socketId, u] of users) {
        if (u.authenticated === true && u.accountId && meta.clanOf(u.accountId) === clanId) io.to(socketId).emit('game:clan-chat', entry);
      }
      return {};
    },
    trades: (_p, id) => meta.trades(id),
    tradeCreate(p, id, user) {
      const { tradeId, to } = meta.tradeCreate(id, p.username);
      notify(to, { kind: 'trade', text: `${user.username} cserélni szeretne veled.` });
      return { tradeId };
    },
    tradeAccept(p, id, user) {
      const { other } = meta.tradeAccept(id, p.id);
      notify(other, { kind: 'trade', text: `${user.username} elfogadta a cserét.` });
      return {};
    },
    tradeSetOffer(p, id) {
      const { other } = meta.tradeSetOffer(id, p.id, p.offer);
      notify(other, { kind: 'trade-refresh' });
      return {};
    },
    tradeConfirm(p, id) {
      const out = meta.tradeConfirm(id, p.id);
      notify(out.other, { kind: 'trade-refresh', text: out.completed ? 'A csere teljesült.' : undefined });
      return { completed: out.completed };
    },
    tradeCancel(p, id) {
      const { other } = meta.tradeCancel(id, p.id);
      notify(other, { kind: 'trade-refresh', text: 'A cserét lemondták.' });
      return {};
    },
    warMap: () => meta.warMap(),
    warAttack(p, id) {
      const out = meta.warAttack(id, p.id);
      io.emit('game:war-updated', { territory: out.territory, attacker: out.attacker, battleId: out.battleId });
      return out;
    },
    baseState: (_p, id) => meta.baseState(id),
    baseBuild: (p, id, user) => meta.baseBuild(id, user.username, p.type),
    baseUpgrade: (p, id) => meta.baseUpgrade(id, p.id),
    baseRepair: (p, id) => meta.baseRepair(id, p.id),
    baseCollect: (_p, id) => meta.baseCollect(id),
    baseRaid(p, id, user) {
      const out = meta.baseRaid(id, p.username, Math.random);
      const target = meta.accountByName(p.username);
      notify(target.id, { kind: 'info', text: `${user.username} rajtaütést indított a bázisod ellen (${out.success ? 'sikeres' : 'visszaverted'}).` });
      return out;
    },
    friends: (_p, id) => meta.friends(id).map((f) => ({ ...f, online: socketsOfAccount(f.accountId).length > 0, accountId: undefined })),
    friendRequest(p, id, user) {
      const { to } = meta.friendRequest(id, p.username);
      notify(to, { kind: 'info', text: `${user.username} barátnak jelölt.` });
      return {};
    },
    friendAccept: (p, id) => meta.friendAccept(id, p.username),
    friendRemove: (p, id) => meta.friendRemove(id, p.username),
    block: (p, id) => meta.block(id, p.username),
    report: (p, id) => meta.report(id, p.username, p.reason),
    inviteToLobby(p, id, user) {
      const target = meta.accountByName(p.username);
      if (!meta.isFriend(id, target.id)) throw new GameError('Csak barátot hívhatsz meg.');
      const lobbyId = typeof p.lobbyId === 'string' ? p.lobbyId : '';
      notify(target.id, { kind: 'invite', text: `${user.username} hív a játékba.`, lobbyId: isVoiceLobby(lobbyId) ? null : lobbyId });
      return {};
    },
    seasons: () => meta.seasons(),
    playerProfile: (p) => meta.profile(meta.accountByName(p.username).id),
    adminOverview() {
      const live = new Set(liveByKey.values());
      return {
        ...meta.admin.overview(),
        lobbies: lobbies.size,
        memoryMb: Math.round(process.memoryUsage().rss / 1e6),
        matches: [...live].map((run) => ({ id: run.match.id, mode: run.match.mode.id, players: run.match.players.length, time: Math.round(run.match.time), score: run.match.score }))
      };
    },
    adminSetSeasonDays: (p, _id, user) => meta.admin.setSeasonDays(user.username, p.days),
    adminSetXpMultiplier: (p, _id, user) => meta.admin.setXpMultiplier(user.username, p.value),
    adminSetDisabledModes: (p, _id, user) => meta.admin.setDisabledModes(user.username, p.modes),
    adminEndSeason: (_p, _id, user) => meta.admin.endSeasonNow(user.username),
    adminSetTerritory: (p, _id, user) => meta.admin.setTerritory(user.username, p.id, p.owner ?? null),
    adminSuspend: (p, _id, user) => meta.admin.suspend(user.username, p.username, p.hours),
    adminCloseReport: (p, _id, user) => meta.admin.closeReport(user.username, p.id),
    adminPlayer: (p, _id, user) => meta.admin.playerDetail(user.username, p.username)
  };

  const maintenance = setInterval(() => {
    try {
      const ended = meta.maintain();
      if (ended) io.emit('game:war-updated', { season: ended });
    } catch (err) {
      console.error('[Game] Karbantartási hiba:', err);
    }
  }, MAINTENANCE_MS);
  maintenance.unref();

  io.on('connection', (socket) => {
    const rate = { second: 0, inputs: 0, actions: 0 };
    const allow = (bucket, limit) => {
      const second = Math.floor(Date.now() / 1000);
      if (second !== rate.second) Object.assign(rate, { second, inputs: 0, actions: 0 });
      rate[bucket] += 1;
      return rate[bucket] <= limit;
    };

    // Egy kezelő kivétele sem juthat el a folyamatig
    const on = (event, handler) => {
      socket.on(event, (payload) => {
        try {
          if (!allow('actions', MAX_ACTIONS_PER_SECOND)) return;
          const user = users.get(socket.id);
          if (user) handler(payload && typeof payload === 'object' ? payload : {}, user);
        } catch (err) {
          console.error(`[Game] Hiba a(z) ${event} kezelésekor:`, err);
          socket.emit('game:error', { message: 'Váratlan szerverhiba történt.' });
        }
      });
    };
    const fail = (message) => socket.emit('game:error', { message });

    const myLobbyEntry = () => {
      for (const lobby of lobbies.values()) {
        for (const p of lobby.players.values()) {
          if (p.socketId === socket.id) return { lobby, player: p };
        }
      }
      return null;
    };

    on('game:lobby-join', ({ channelId }, user) => {
      if (typeof channelId !== 'string') return;
      const key = playerKey(socket, user);
      const liveRun = liveByKey.get(key);
      if (isVoiceLobby(channelId) && user.voiceChannel !== channelId && liveRun?.lobby.channelId !== channelId) {
        fail('Csak a hangszoba tagjai csatlakozhatnak a játékhoz.');
        return;
      }
      const publicMode = channelId.startsWith('public:') ? channelId.slice('public:'.length) : null;
      if (publicMode && !Object.prototype.hasOwnProperty.call(MODES, publicMode)) return;
      if (channelId.startsWith('private:') && !lobbies.has(channelId) && !liveRun) {
        fail('Nincs ilyen privát lobbi.');
        return;
      }
      if (user.authenticated === true && user.accountId && meta.isSuspended(user.accountId)) {
        fail('A játékhoz való hozzáférésedet felfüggesztették.');
        return;
      }

      const previous = myLobbyEntry();
      if (previous && previous.lobby.channelId !== channelId) leaveLobby(socket, previous.lobby);

      let lobby = lobbies.get(channelId);
      if (!lobby) {
        lobby = { channelId, players: new Map(), run: null, countdownEndsAt: 0, startedBy: user.username, mode: publicMode || 'team_deathmatch', options: {}, battle: null };
        lobbies.set(channelId, lobby);
      }

      const existing = lobby.players.get(key);
      if (existing && existing.socketId !== socket.id) {
        io.sockets.sockets.get(existing.socketId)?.leave(lobbyRoom(channelId));
      }

      if (existing) {
        existing.socketId = socket.id;
        existing.suspended = false;
      } else {
        const counts = TEAMS.map((team) => [...lobby.players.values()].filter((p) => p.team === team).length);
        const team = TEAMS[counts.indexOf(Math.min(...counts))];
        if (lobby.players.size >= modeOf(lobby).max && !liveRun) {
          fail('A lobbi megtelt.');
          cleanupLobby(lobby);
          return;
        }
        lobby.players.set(key, {
          key,
          socketId: socket.id,
          username: user.username,
          accountId: user.authenticated === true ? user.accountId : null,
          team,
          characterId: Object.values(CHARACTERS).find((c) => c.faction === team).id,
          title: user.authenticated === true && user.accountId ? meta.cosmeticsOf(user.accountId).title || null : null,
          ready: false
        });
      }
      socket.join(lobbyRoom(channelId));
      socket.emit('game:catalog', { factions: FACTIONS, characters: CHARACTERS, modes: publicModes(), difficulties: DIFFICULTIES, tracks: Object.fromEntries(MODES.racing.options.tracks.map((id) => [id, MAPS[id].name])), npcDefs: NPCS });

      // Visszatérés futó meccsbe, új socket azonosítóval
      if (liveRun && !liveRun.ended) {
        clearTimeout(liveRun.graceTimers.get(key));
        liveRun.graceTimers.delete(key);
        const old = liveRun.sockets.get(key);
        if (old !== socket.id) io.sockets.sockets.get(old)?.leave(matchRoom(liveRun.match.id));
        liveRun.sockets.set(key, socket.id);
        liveRun.match.setConnected(key, true);
        socket.join(matchRoom(liveRun.match.id));
        socket.emit('game:match-start', { ...matchInfo(liveRun, liveRun.match.byKey.get(key).index), resumed: true });
      }

      updateCountdown(lobby);
      broadcastLobby(lobby);
    });

    on('game:lobby-leave', () => {
      const entry = myLobbyEntry();
      if (!entry) return;
      const run = liveByKey.get(entry.player.key);
      if (run) {
        // Meccs közben a nézetből kilépés nem bontja a helyet, a türelmi idő alatt vissza lehet jönni
        socket.leave(matchRoom(run.match.id));
        suspendFromMatch(run, entry.player.key);
        return;
      }
      leaveLobby(socket, entry.lobby);
    });

    on('game:set-loadout', ({ team, characterId }) => {
      const entry = myLobbyEntry();
      if (!entry || entry.lobby.run || !Object.prototype.hasOwnProperty.call(FACTIONS, team)) return;
      const character = Object.prototype.hasOwnProperty.call(CHARACTERS, characterId) ? CHARACTERS[characterId] : null;
      if (!character || character.faction !== team) {
        fail('Ez a karakter nem ehhez a frakcióhoz tartozik.');
        return;
      }
      const onTeam = [...entry.lobby.players.values()].filter((p) => p.team === team && p !== entry.player).length;
      if (onTeam >= teamLimit(modeOf(entry.lobby))) {
        fail('Ez a csapat megtelt.');
        return;
      }
      Object.assign(entry.player, { team, characterId, ready: false });
      updateCountdown(entry.lobby);
      broadcastLobby(entry.lobby);
    });

    on('game:ready', ({ ready }) => {
      const entry = myLobbyEntry();
      if (!entry || entry.lobby.run) return;
      entry.player.ready = ready === true;
      if (entry.player.ready) {
        const problem = startProblem(entry.lobby, [...entry.lobby.players.values()]);
        if (problem) socket.emit('game:notice', { message: problem });
      }
      updateCountdown(entry.lobby);
      broadcastLobby(entry.lobby);
    });

    on('game:set-mode', ({ mode, options: modeOptions }, user) => {
      const entry = myLobbyEntry();
      if (!entry || entry.lobby.run || entry.lobby.channelId.startsWith('public:')) return;
      if (!Object.prototype.hasOwnProperty.call(MODES, mode)) return;
      const { lobby } = entry;
      const raw = modeOptions && typeof modeOptions === 'object' ? modeOptions : {};
      let battle = null;
      if (raw.battleId) {
        battle = meta.getBattle(raw.battleId);
        if (!battle) {
          fail('Ez a csata már lezárult.');
          return;
        }
      }
      const chosen = battle ? (battle.defender ? 'team_deathmatch' : 'survival') : mode;
      const clean = {};
      if (MODES[chosen].options?.bosses?.includes(raw.bossId)) clean.bossId = raw.bossId;
      if (MODES[chosen].options?.difficulties?.includes(raw.difficulty)) clean.difficulty = raw.difficulty;
      if (MODES[chosen].options?.tracks?.includes(raw.trackId)) clean.trackId = raw.trackId;
      if (battle && !battle.defender) clean.waveGoal = Math.max(3, battle.defense + 2);
      if (lobby.players.size > MODES[chosen].max) {
        fail('Túl sokan vagytok ehhez a módhoz.');
        return;
      }
      Object.assign(lobby, { mode: chosen, options: clean, battle });
      for (const p of lobby.players.values()) p.ready = false;
      cancelCountdown(lobby);
      lobby.modeChangedBy = user.username;
      broadcastLobby(lobby);
    });

    on('game:private-create', () => {
      const code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      const channelId = `private:${code}`;
      if (!PRIVATE_CODE_RE.test(channelId)) return;
      lobbies.set(channelId, { channelId, players: new Map(), run: null, countdownEndsAt: 0, startedBy: users.get(socket.id).username, mode: 'team_deathmatch', options: {}, battle: null });
      socket.emit('game:private-created', { channelId, code });
    });

    on('game:emote', (_payload, user) => {
      const key = playerKey(socket, user);
      const run = liveByKey.get(key);
      const p = run?.match.byKey.get(key);
      if (!p?.alive) return;
      if (run.match.time < (p.nextEmoteAt || 0)) return;
      p.nextEmoteAt = run.match.time + 2;
      run.match.emit({ t: 'emote', i: p.index, e: p.cosmetics.emote || EMOTE_FALLBACK });
    });

    socket.on('game:rpc', (method, params, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (!allow('actions', MAX_ACTIONS_PER_SECOND)) {
          ack({ ok: false, error: 'Túl sok kérés, lassíts egy kicsit.' });
          return;
        }
        const user = users.get(socket.id);
        if (!user || typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(rpcMethods, method)) {
          ack({ ok: false, error: 'Ismeretlen művelet.' });
          return;
        }
        const handler = rpcMethods[method];
        if (user.authenticated !== true || !user.accountId) {
          ack({ ok: false, error: 'Ehhez be kell jelentkezned.', needsLogin: true });
          return;
        }
        if (method.startsWith('admin') && user.isAdmin !== true) {
          ack({ ok: false, error: 'Nincs jogosultságod ehhez.' });
          return;
        }
        meta.ensurePlayer(user.accountId, user.username);
        ack({ ok: true, data: handler(params && typeof params === 'object' ? params : {}, user.accountId, user) ?? {} });
      } catch (err) {
        if (err instanceof GameError) {
          ack({ ok: false, error: err.message });
        } else {
          console.error(`[Game] RPC hiba (${method}):`, err);
          ack({ ok: false, error: 'Váratlan szerverhiba történt.' });
        }
      }
    });

    on('game:get-profile', (_payload, user) => {
      socket.emit('game:profile', user.authenticated === true && user.accountId ? store.getProfile(user.accountId) : null);
    });

    socket.on('game:input', (raw) => {
      try {
        if (!allow('inputs', MAX_INPUTS_PER_SECOND)) return;
        const user = users.get(socket.id);
        if (!user) return;
        const key = playerKey(socket, user);
        const run = liveByKey.get(key);
        if (!run || run.ended || run.sockets.get(key) !== socket.id) return;
        const input = parseInput(raw);
        if (input) run.match.queueInput(key, input);
      } catch (err) {
        console.error('[Game] Bemenet feldolgozási hiba:', err);
      }
    });

    socket.on('disconnect', () => {
      try {
        const entry = myLobbyEntry();
        if (!entry) return;
        const run = liveByKey.get(entry.player.key);
        if (run && run.sockets.get(entry.player.key) === socket.id) {
          suspendFromMatch(run, entry.player.key);
          if (entry.player.key.startsWith('guest:')) {
            // Vendég nem azonosítható újra, ezért a lobbiból azonnal kikerül
            entry.lobby.players.delete(entry.player.key);
            broadcastLobby(entry.lobby);
          }
          return;
        }
        leaveLobby(socket, entry.lobby);
      } catch (err) {
        console.error('[Game] Lekapcsolódás kezelési hiba:', err);
      }
    });
  });

  return {
    getSession: (channelId) => summary(lobbies.get(channelId)),
    getStats: () => ({ lobbies: lobbies.size, liveMatches: new Set(liveByKey.values()).size }),
    levelFromXp
  };
};
