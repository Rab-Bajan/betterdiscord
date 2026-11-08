// YouTube Watch Party: szobánkénti szinkronizált lejátszási állapot
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

module.exports = function setupWatchParty(io, app, users) {
  // channelId -> session
  const watchSessions = new Map();

  // A tárolt állapotból kiszámolja az ÉLŐ időkódot: lejátszás közben a
  // mentett pozíció + az azóta eltelt idő. Így aki később csatlakozik
  // (vagy visszalép a nézetbe), nem az elejéről kezdi.
  function toLiveState(state) {
    if (!state) return null;
    const now = Date.now();
    const elapsed = state.isPlaying ? Math.max(0, (now - state.lastUpdated) / 1000) : 0;
    return { ...state, currentTime: state.currentTime + elapsed, serverTime: now };
  }

  const usernameOf = (socket) => users.get(socket.id)?.username || 'Felhasználó';
  const isInRoom = (socket, channelId) => users.get(socket.id)?.voiceChannel === channelId;

  function broadcastState(channelId, state) {
    const live = toLiveState(state);
    io.to(channelId).emit('watch:state', live);
    io.emit('watch:session-updated', { channelId, state: live });
  }

  io.on('connection', (socket) => {
    // Új videó indítása / váltás
    socket.on('watch:update-media', ({ channelId, url, videoId, title } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) return;
      if (!YOUTUBE_ID_RE.test(videoId || '')) return;

      const username = usernameOf(socket);
      const state = {
        active: true,
        channelId,
        service: 'youtube',
        url: url || '',
        videoId,
        title: title || 'YouTube Videó',
        isPlaying: true,
        currentTime: 0,
        lastUpdated: Date.now(),
        startedBy: username,
        updatedBy: username
      };

      watchSessions.set(channelId, state);
      broadcastState(channelId, state);
      console.log(`[WatchParty] Videó indítva a(z) ${channelId} szobában (${username}): ${state.videoId}`);
    });

    // Play / Pause / Seek
    socket.on('watch:playback-control', ({ channelId, action, currentTime } = {}) => {
      const state = watchSessions.get(channelId);
      if (!state || !isInRoom(socket, channelId)) return;

      // Az eddigi élő pozíciót mentjük el alapnak, ha a kliens nem küldött időt
      const time =
        typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime >= 0
          ? currentTime
          : toLiveState(state).currentTime;

      state.currentTime = time;
      state.lastUpdated = Date.now();
      if (action === 'play') state.isPlaying = true;
      if (action === 'pause') state.isPlaying = false;
      state.updatedBy = usernameOf(socket);

      // A többieknek szinkron esemény, mindenkinek frissített session (hogy újracsatlakozáskor friss legyen)
      socket.to(channelId).emit('watch:sync-event', {
        action,
        currentTime: state.currentTime,
        timestamp: Date.now(),
        triggeredBy: state.updatedBy
      });
      io.emit('watch:session-updated', { channelId, state: toLiveState(state) });
    });

    // Friss állapot lekérése (pl. a nézetbe való visszatéréskor)
    socket.on('watch:get-state', ({ channelId } = {}) => {
      if (!channelId) return;
      socket.emit('watch:state', toLiveState(watchSessions.get(channelId)));
    });

    // Közös 3-2-1 visszaszámlálás
    socket.on('watch:countdown', ({ channelId } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) return;
      io.to(channelId).emit('watch:countdown-start', {
        timestamp: Date.now() + 3000,
        triggeredBy: usernameOf(socket)
      });
    });

    // Lebegő reakciók
    socket.on('watch:reaction', ({ channelId, emoji } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) return;
      io.to(channelId).emit('watch:reaction-received', {
        emoji: String(emoji || '🍿').slice(0, 8),
        username: usernameOf(socket),
        id: Math.random().toString(36).substring(2, 9)
      });
    });

    // Session leállítása
    socket.on('watch:stop', ({ channelId } = {}) => {
      if (!channelId || !isInRoom(socket, channelId)) return;
      watchSessions.delete(channelId);
      io.to(channelId).emit('watch:state', null);
      io.emit('watch:session-updated', { channelId, state: null });
      console.log(`[WatchParty] Leállítva a(z) ${channelId} szobában`);
    });
  });

  return {
    getWatchSessions: () =>
      Object.fromEntries([...watchSessions].map(([id, s]) => [id, toLiveState(s)])),
    getWatchSession: (channelId) => toLiveState(watchSessions.get(channelId))
  };
};
