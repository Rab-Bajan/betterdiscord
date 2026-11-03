const db = require('./database');

function getDmKey(idA, idB) {
  return [String(idA).toLowerCase(), String(idB).toLowerCase()].sort().join('::');
}

module.exports = function setupDm(io, users) {
  // Segédfüggvény: felhasználó socket keresése ID vagy Username alapján
  function findSocketByUserIdOrName(targetIdentifier) {
    if (!targetIdentifier) return null;
    for (const [sId, u] of users.entries()) {
      if (sId === targetIdentifier || u.id === targetIdentifier || u.accountId === targetIdentifier || u.username.toLowerCase() === String(targetIdentifier).toLowerCase()) {
        return io.sockets.sockets.get(sId);
      }
    }
    return null;
  }

  function findUserObj(targetIdentifier) {
    if (!targetIdentifier) return null;
    for (const [sId, u] of users.entries()) {
      if (sId === targetIdentifier || u.id === targetIdentifier || u.accountId === targetIdentifier || u.username.toLowerCase() === String(targetIdentifier).toLowerCase()) {
        return u;
      }
    }
    return null;
  }

  io.on('connection', (socket) => {
    // 1. Meglévő DM partnerek lekérése
    socket.on('dm:get-conversations', () => {
      const self = users.get(socket.id);
      if (!self) return;
      const convs = db.getUserDmConversations(self.username);
      socket.emit('dm:conversations', convs);
    });

    // 2. Privát üzenet előzmények lekérése adott partnerrel SQLite-ból
    socket.on('dm:get-history', ({ targetUserId, targetUsername }) => {
      const self = users.get(socket.id);
      if (!self) return;

      const partner = findUserObj(targetUserId || targetUsername);
      const partnerName = partner ? partner.username : targetUsername;
      const selfName = self.username;

      if (!partnerName) return;

      const dmKey = getDmKey(selfName, partnerName);
      const history = db.getDmMessages(dmKey);

      socket.emit('dm:history', {
        partnerId: targetUserId,
        partnerUsername: partnerName,
        dmKey,
        messages: history
      });
    });

    // 3. Privát üzenet küldése és mentése SQLite-ba
    socket.on('dm:send-message', ({ targetUserId, targetUsername, text, attachments }) => {
      const sender = users.get(socket.id);
      if (!sender) return;

      const cleanText = typeof text === 'string' ? text.trim() : '';
      const validAttachments = Array.isArray(attachments) ? attachments : [];
      if (!cleanText && validAttachments.length === 0) return;

      const recipient = findUserObj(targetUserId || targetUsername);
      const recipientSocket = findSocketByUserIdOrName(targetUserId || targetUsername);

      const senderName = sender.username;
      const recipientName = recipient ? recipient.username : targetUsername;

      if (!recipientName) return;

      const dmKey = getDmKey(senderName, recipientName);

      const dmMsgObj = {
        id: `dm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        dmKey,
        username: sender.username, // Fontos: a ChatArea kompatibilitáshoz!
        senderId: sender.id,
        senderAccountId: sender.accountId || null,
        senderUsername: sender.username,
        senderAvatarColor: sender.avatarColor || '#7655F5',
        senderAvatarUrl: sender.avatarUrl || null,
        recipientId: recipient ? recipient.id : targetUserId,
        recipientUsername: recipientName,
        recipientAvatarColor: recipient ? recipient.avatarColor : '#7655F5',
        recipientAvatarUrl: recipient ? recipient.avatarUrl : null,
        avatarColor: sender.avatarColor || '#7655F5',
        avatarUrl: sender.avatarUrl || null,
        text: cleanText,
        attachments: validAttachments,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        createdAt: Date.now(),
        isPrivate: true
      };

      // Mentés SQLite adatbázisba
      db.saveDmMessage(dmMsgObj);

      // KIZÁRÓLAG a feladó és a címzett kapja meg!
      socket.emit('dm:new-message', dmMsgObj);

      if (recipientSocket && recipientSocket.id !== socket.id) {
        recipientSocket.emit('dm:new-message', dmMsgObj);
      }

      console.log(`[SQLite DM] Privát üzenet elmentve és elküldve: ${senderName} -> ${recipientName}`);
    });
  });

  return {
    getDmKey
  };
};
