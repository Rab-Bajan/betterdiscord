// Csatorna szöveges üzenetek (SQLite-ban mentve, memóriában az utolsó 150)
const database = require('./database');
const { users, textChannels } = require('./state');

const MAX_MESSAGES_PER_CHANNEL = 150;

module.exports = function setupChat(io) {
  const channelMessages = database.loadAllChannelMessages(textChannels.map((c) => c.id));

  if (!channelMessages.altalanos || channelMessages.altalanos.length === 0) {
    channelMessages.altalanos = [
      {
        id: 'welcome-1',
        senderId: 'system',
        username: 'Rendszer Bot',
        avatarColor: '#7655F5',
        text: 'Üdvözlünk a SharkVoic prémium kommunikációs szerveren! 🔒🎉 Válassz egy hangcsatornát vagy csevegj a szobákban.',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        isSystem: true
      }
    ];
  }

  io.on('connection', (socket) => {
    socket.on('chat:message', ({ channelId, text, attachments } = {}) => {
      const user = users.get(socket.id);
      const cleanText = typeof text === 'string' ? text.trim() : '';
      const validAttachments = Array.isArray(attachments) ? attachments : [];
      if (!user || (!cleanText && validAttachments.length === 0)) return;

      const newMsg = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        senderId: user.id,
        username: user.username,
        avatarColor: user.avatarColor,
        avatarUrl: user.avatarUrl || null,
        text: cleanText,
        attachments: validAttachments,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        channelId
      };

      database.saveChannelMessage(newMsg);

      const list = (channelMessages[channelId] = channelMessages[channelId] || []);
      list.push(newMsg);
      if (list.length > MAX_MESSAGES_PER_CHANNEL) list.shift();

      io.emit('chat:new-message', newMsg);
    });
  });

  return { getChannelMessages: () => channelMessages };
};
