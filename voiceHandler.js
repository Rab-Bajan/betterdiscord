// Hangszobák: csatlakozás/kilépés, WebRTC szignálozás, beszéd, képernyőmegosztás, némítás
const { users, getVoiceChannelState } = require('./state');

const publicPeer = (u) => ({
  id: u.id,
  username: u.username,
  avatarColor: u.avatarColor,
  isMuted: u.isMuted,
  isDeafened: u.isDeafened
});

// onRoomJoined(socket, channelId): a szobához kötött állapotok (rajztáblák, kód, mozi) küldése a belépőnek
module.exports = function setupVoice(io, onRoomJoined) {
  io.on('connection', (socket) => {
    socket.on('voice:join', ({ channelId } = {}) => {
      const user = users.get(socket.id);
      if (!user || !channelId) return;

      const prevChannel = user.voiceChannel;
      if (prevChannel) {
        socket.leave(prevChannel);
        socket.to(prevChannel).emit('voice:peer-left', { peerId: socket.id });
      }

      user.voiceChannel = channelId;
      user.isSpeaking = false;
      user.isCameraOn = false;
      socket.join(channelId);

      const peers = [];
      for (const [id, u] of users.entries()) {
        if (u.voiceChannel === channelId && id !== socket.id) peers.push(publicPeer(u));
      }

      socket.emit('voice:joined', { channelId, peers });
      onRoomJoined?.(socket, channelId);
      socket.to(channelId).emit('voice:peer-joined', { peerId: socket.id, user: publicPeer(user) });

      io.emit('voice:states-updated', getVoiceChannelState());
      console.log(`[Voice] ${user.username} csatlakozott a(z) ${channelId} csatornához`);
    });

    socket.on('voice:leave', () => {
      const user = users.get(socket.id);
      if (!user?.voiceChannel) return;

      const channelId = user.voiceChannel;
      socket.leave(channelId);
      user.voiceChannel = null;
      user.isSpeaking = false;
      user.isScreenSharing = false;
      user.isCameraOn = false;

      socket.to(channelId).emit('voice:peer-left', { peerId: socket.id });
      io.emit('voice:states-updated', getVoiceChannelState());
      console.log(`[Voice] ${user.username} kilépett a(z) ${channelId} csatornából`);
    });

    // Offer / Answer / ICE candidate továbbítása
    socket.on('webrtc:signal', ({ targetPeerId, signal } = {}) => {
      const sender = users.get(socket.id);
      if (!sender || !targetPeerId || !signal) return;
      if (!users.has(targetPeerId)) {
        console.warn(`[WebRTC Relay] Célpont nem található: ${targetPeerId} (feladó: ${sender.username})`);
        return;
      }
      io.to(targetPeerId).emit('webrtc:signal', { senderPeerId: socket.id, signal });
    });

    socket.on('voice:speaking', ({ isSpeaking } = {}) => {
      const user = users.get(socket.id);
      if (!user?.voiceChannel) return;
      user.isSpeaking = !!isSpeaking;
      io.to(user.voiceChannel).emit('voice:user-speaking', { userId: socket.id, isSpeaking: user.isSpeaking });
    });

    socket.on('voice:screen-share', ({ isSharing } = {}) => {
      const user = users.get(socket.id);
      if (!user?.voiceChannel) return;
      user.isScreenSharing = !!isSharing;
      io.emit('voice:states-updated', getVoiceChannelState());
      io.to(user.voiceChannel).emit('voice:user-screen-sharing', {
        userId: socket.id,
        isSharing: user.isScreenSharing
      });
      console.log(`[ScreenShare] ${user.username} képernyőmegosztás: ${user.isScreenSharing ? 'BE' : 'KI'}`);
    });

    socket.on('voice:camera', ({ isOn } = {}) => {
      const user = users.get(socket.id);
      if (!user?.voiceChannel) return;
      user.isCameraOn = !!isOn;
      io.emit('voice:states-updated', getVoiceChannelState());
      io.to(user.voiceChannel).emit('voice:user-camera', { userId: socket.id, isOn: user.isCameraOn });
    });

    socket.on('voice:state-change', ({ isMuted, isDeafened } = {}) => {
      const user = users.get(socket.id);
      if (!user) return;
      if (typeof isMuted === 'boolean') user.isMuted = isMuted;
      if (typeof isDeafened === 'boolean') user.isDeafened = isDeafened;

      io.emit('voice:states-updated', getVoiceChannelState());
      if (user.voiceChannel) {
        io.to(user.voiceChannel).emit('voice:peer-state-changed', {
          userId: user.id,
          isMuted: user.isMuted,
          isDeafened: user.isDeafened
        });
      }
    });
  });
};
