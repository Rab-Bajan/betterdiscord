module.exports = function setupWatchParty(io, app, users) {
  // Csatornánkénti közös média állapot: channelId -> session
  const watchSessions = new Map();

  // Socket.io kezelők a szinkronizált YouTube lejátszáshoz
  io.on('connection', (socket) => {
    // Média elindítása / módosítása a hangcsatornában
    socket.on('watch:update-media', ({ channelId, service, url, videoId, title }) => {
      if (!channelId) return;
      const user = users.get(socket.id);
      const username = user?.username || 'Felhasználó';

      const state = {
        active: true,
        channelId,
        service: 'youtube', // YouTube Watch Party
        url: url || '',
        videoId: videoId || '',
        title: title || 'YouTube Videó',
        isPlaying: true,
        currentTime: 0,
        lastUpdated: Date.now(),
        startedBy: username,
        updatedBy: username
      };

      watchSessions.set(channelId, state);
      io.to(channelId).emit('watch:state', state);
      io.emit('watch:session-updated', { channelId, state });
      console.log(`[WatchParty] YouTube média indítva a(z) ${channelId} szobában (${username}): ${state.title} (${state.videoId})`);
    });

    // Lejátszás vezérlés (Play, Pause, Seek)
    socket.on('watch:playback-control', ({ channelId, action, currentTime }) => {
      const state = watchSessions.get(channelId);
      if (!state) return;
      const user = users.get(socket.id);
      const username = user?.username || 'Felhasználó';

      const time = typeof currentTime === 'number' && !isNaN(currentTime) ? currentTime : state.currentTime;
      state.currentTime = time;
      state.lastUpdated = Date.now();
      if (action === 'play') state.isPlaying = true;
      if (action === 'pause') state.isPlaying = false;
      state.updatedBy = username;

      // Szinkron esemény továbbítása a többieknek
      socket.to(channelId).emit('watch:sync-event', {
        action,
        currentTime: state.currentTime,
        timestamp: Date.now(),
        triggeredBy: username
      });
    });

    // Szinkron visszaszámláló indítása (3... 2... 1... Indítás!)
    socket.on('watch:countdown', ({ channelId }) => {
      if (!channelId) return;
      const user = users.get(socket.id);
      io.to(channelId).emit('watch:countdown-start', {
        timestamp: Date.now() + 3000,
        triggeredBy: user?.username || 'Felhasználó'
      });
    });

    // Égő reakciók (🍿 Popcorn, 🔥 Tűz, 😂 Haha, ❤️ Szív)
    socket.on('watch:reaction', ({ channelId, emoji }) => {
      if (!channelId) return;
      const user = users.get(socket.id);
      io.to(channelId).emit('watch:reaction-received', {
        emoji: emoji || '🍿',
        username: user?.username || 'Felhasználó',
        id: Math.random().toString(36).substring(2, 9)
      });
    });

    // Mozi session leállítása
    socket.on('watch:stop', ({ channelId }) => {
      if (!channelId) return;
      watchSessions.delete(channelId);
      io.to(channelId).emit('watch:state', null);
      io.emit('watch:session-updated', { channelId, state: null });
      console.log(`[WatchParty] YouTube Watch Party leállítva a(z) ${channelId} szobában`);
    });
  });

  return {
    getWatchSessions: () => Object.fromEntries(watchSessions),
    getWatchSession: (channelId) => watchSessions.get(channelId) || null
  };
};
