// Megosztott szerver-állapot és a belőle számolt nézetek

// socket.id -> { id, accountId, username, avatarColor, avatarUrl, voiceChannel, isMuted, isDeafened, isSpeaking, isScreenSharing, speedTest }
const users = new Map();

const textChannels = [
  { id: 'altalanos', name: 'általános', description: 'Általános beszélgetés minden témáról' },
  { id: 'gaming', name: 'gaming', description: 'Játék megbeszélések, mémek és stratégiák' },
  { id: 'zene', name: 'zene-és-klipek', description: 'Kedvenc zenék és videók megosztása' },
  { id: 'fejlesztes', name: 'fejlesztés', description: 'Kódolás, technológia és projektek' }
];

const voiceChannels = [
  { id: 'hang-altalanos', name: 'Általános Hang', userLimit: 10 },
  { id: 'hang-gaming-1', name: 'Gaming 1 (Squad)', userLimit: 5 },
  { id: 'hang-chill', name: 'Chill & Dumcsi', userLimit: 15 }
];

// Admin felhasználónevek (vesszővel elválasztva az ADMIN_USERNAMES környezeti változóban)
const adminUsernames = (process.env.ADMIN_USERNAMES || 'bajan')
  .split(',')
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);

const isAdminUsername = (name) => adminUsernames.includes(String(name || '').toLowerCase());

function getVoiceChannelState() {
  const state = {};
  for (const vc of voiceChannels) state[vc.id] = [];

  for (const user of users.values()) {
    if (user.voiceChannel && state[user.voiceChannel]) {
      state[user.voiceChannel].push({
        id: user.id,
        username: user.username,
        avatarColor: user.avatarColor,
        isMuted: user.isMuted,
        isDeafened: user.isDeafened,
        isSpeaking: user.isSpeaking || false,
        isScreenSharing: user.isScreenSharing || false,
        isCameraOn: user.isCameraOn || false,
        speedTest: user.speedTest || null
      });
    }
  }
  return state;
}

function getOnlineUsersList() {
  return Array.from(users.values()).map((u) => ({
    id: u.id,
    accountId: u.accountId || null,
    username: u.username,
    avatarColor: u.avatarColor,
    avatarUrl: u.avatarUrl || null,
    voiceChannel: u.voiceChannel,
    isMuted: u.isMuted,
    isDeafened: u.isDeafened,
    isScreenSharing: u.isScreenSharing || false,
    isCameraOn: u.isCameraOn || false,
    speedTest: u.speedTest || null
  }));
}

// Mindenkinek elküldi a frissített felhasználó- és hangszoba-listát
function broadcastPresence(io) {
  io.emit('users:updated', getOnlineUsersList());
  io.emit('voice:states-updated', getVoiceChannelState());
}

module.exports = {
  users,
  textChannels,
  voiceChannels,
  getVoiceChannelState,
  getOnlineUsersList,
  broadcastPresence,
  isAdminUsername
};
