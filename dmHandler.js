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

  // Mindkét résztvevőnek elküldi, hogy egy üzenetet az admin eltávolított (az üzenet helyén jelzés látszik)
  function notifyMessageRemoved(dmKey, messageId) {
    const names = dmKey.split('::');
    for (const [socketId, u] of users.entries()) {
      if (names.includes(u.username.toLowerCase())) {
        io.to(socketId).emit('dm:message-removed', { id: messageId, dmKey });
      }
    }
  }

  io.on('connection', (socket) => {
    // 0. Üzenet jelentése: csak a beszélgetés résztvevője jelentheti a másik fél üzenetét
    socket.on('dm:report-message', ({ messageId, reason } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const me = users.get(socket.id);
      const msg = typeof messageId === 'string' ? db.getDmMessageById(messageId) : null;
      if (!me || !msg) return reply({ ok: false, error: 'Az üzenet nem található.' });

      const myName = me.username.toLowerCase();
      const isParticipant = msg.dmKey.split('::').includes(myName);
      if (!isParticipant || msg.senderUsername.toLowerCase() === myName) {
        return reply({ ok: false, error: 'Csak a beszélgetőpartnered üzenetét jelentheted.' });
      }
      if (msg.removedByAdmin) return reply({ ok: false, error: 'Ezt az üzenetet már eltávolították.' });

      const created = db.createDmReport({
        id: `rep_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        messageId: msg.id,
        dmKey: msg.dmKey,
        reporterUsername: me.username,
        reason: String(reason || '').trim().slice(0, 300)
      });
      if (!created) return reply({ ok: false, error: 'Ezt az üzenetet már jelentetted.' });

      console.log(`[DM Report] ${me.username} jelentette ${msg.senderUsername} üzenetét (${msg.id})`);
      reply({ ok: true });
    });

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
    getDmKey,
    notifyMessageRemoved
  };
};
