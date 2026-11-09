// Belépés, regisztráció, token, profil és lekapcsolódás
const authManager = require('./authManager');
const {
  users, textChannels, voiceChannels,
  getVoiceChannelState, getOnlineUsersList, broadcastPresence, isAdminUsername
} = require('./state');

// getExtraInitData(): a modulok által adott további kezdőadatok (üzenetek, kaszinó, mozi, sakk, birodalom, phobia)
module.exports = function setupAuth(io, getExtraInitData) {
  io.on('connection', (socket) => {
    console.log(`[Socket HTTPS] Csatlakozott kliens: ${socket.id}`);

    function establishUserSession(data) {
      const userObj = {
        id: socket.id,
        accountId: data.accountId || null,
        username: data.username,
        avatarColor: data.avatarColor || '#7655F5',
        avatarUrl: data.avatarUrl || null,
        voiceChannel: null,
        isMuted: false,
        isDeafened: false,
        isSpeaking: false,
        isScreenSharing: false,
        isCameraOn: false,
        // Admin csak hitelesített fiókkal lehet (vendég név alapján soha)
        // Hitelesített (jelszavas/tokenes) munkamenet: a hívások csak ilyenekkel engedélyezettek
        authenticated: data.authenticated === true,
        isAdmin: data.authenticated === true && isAdminUsername(data.username),
        speedTest: null
      };
      users.set(socket.id, userObj);

      socket.emit('init:data', {
        self: userObj,
        textChannels,
        voiceChannels,
        voiceStates: getVoiceChannelState(),
        onlineUsers: getOnlineUsersList(),
        ...getExtraInitData()
      });

      broadcastPresence(io);
      console.log(`[User] Belépett: ${userObj.username} (${socket.id})`);
      return userObj;
    }

    // Sikeres auth-eredményből munkamenet + válasz
    function startAuthedSession(res) {
      if (!res.success) {
        socket.emit('auth:error', { error: res.error });
        return;
      }
      const sessionUser = establishUserSession({
        authenticated: true,
        accountId: res.user.id,
        username: res.user.username,
        avatarColor: res.user.avatarColor,
        avatarUrl: res.user.avatarUrl
      });
      socket.emit('auth:success', { user: sessionUser, token: res.token });
    }

    socket.on('auth:register', ({ username, password, avatarColor, avatarUrl }) => {
      startAuthedSession(authManager.register({ username, password, avatarColor, avatarUrl }));
    });

    socket.on('auth:login', ({ username, password }) => {
      startAuthedSession(authManager.login({ username, password }));
    });

    // Automatikus munkamenet-hitelesítés tokennel
    socket.on('auth:verify-token', ({ token }) => {
      const res = authManager.verifyToken(token);
      if (!res.success) {
        socket.emit('auth:token-invalid', { error: res.error });
        return;
      }
      startAuthedSession(res);
    });

    socket.on('auth:logout', ({ token }) => {
      authManager.logout(token);
      if (users.delete(socket.id)) broadcastPresence(io);
    });

    // Vendég belépés
    socket.on('user:join', ({ username, avatarColor, avatarUrl, accountId }) => {
      establishUserSession({
        accountId: accountId || null,
        username: (username || `Felhasználó_${socket.id.substring(0, 4)}`).trim(),
        avatarColor: avatarColor || '#7655F5',
        avatarUrl: avatarUrl || null
      });
    });

    socket.on('user:update-profile', ({ username, avatarColor, avatarUrl }) => {
      const user = users.get(socket.id);
      if (!user) return;

      const res = authManager.updateProfile(user.accountId, { username, avatarColor, avatarUrl });
      if (!res.success) {
        socket.emit('profile:error', { error: res.error });
        return;
      }

      user.username = res.user.username;
      // Átnevezéssel admin jog nem szerezhető, csak elveszíthető
      user.isAdmin = user.isAdmin && isAdminUsername(res.user.username);
      user.avatarColor = res.user.avatarColor;
      user.avatarUrl = res.user.avatarUrl;

      socket.emit('user:profile-updated', user);
      broadcastPresence(io);
      console.log(`[User] Profil módosítva: ${user.username} (${socket.id})`);
    });

    socket.on('disconnect', () => {
      const user = users.get(socket.id);
      if (!user) return;
      if (user.voiceChannel) {
        socket.to(user.voiceChannel).emit('voice:peer-left', { peerId: socket.id });
      }
      users.delete(socket.id);
      broadcastPresence(io);
      console.log(`[User] Kilépett: ${user.username} (${socket.id})`);
    });
  });
};
