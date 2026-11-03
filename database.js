const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.resolve(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'sharkvoic.db');
const db = new Database(dbPath);

// WAL mód bekapcsolása a gyors és biztonságos párhuzamos írás/olvasásért
db.pragma('journal_mode = WAL');

// 1. Fiókok (Accounts) tábla
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE COLLATE NOCASE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    avatar_color TEXT,
    avatar_url TEXT,
    created_at INTEGER
  );
`);

// 2. Csatorna üzenetek (Channel Messages) tábla
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    sender_id TEXT,
    username TEXT NOT NULL,
    avatar_color TEXT,
    avatar_url TEXT,
    text TEXT,
    attachments TEXT,
    timestamp TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at);
`);

// 3. Privát üzenetek (Direct Messages) tábla
db.exec(`
  CREATE TABLE IF NOT EXISTS direct_messages (
    id TEXT PRIMARY KEY,
    dm_key TEXT NOT NULL,
    sender_id TEXT,
    sender_account_id TEXT,
    sender_username TEXT NOT NULL,
    sender_avatar_color TEXT,
    sender_avatar_url TEXT,
    recipient_id TEXT,
    recipient_username TEXT NOT NULL,
    recipient_avatar_color TEXT,
    recipient_avatar_url TEXT,
    text TEXT,
    attachments TEXT,
    timestamp TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_dm_key_created ON direct_messages(dm_key, created_at);
`);

// 4. Munkamenet Tokenek (Auth Tokens) tábla az automatikus bejelentkezéshez
db.exec(`
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_account ON auth_tokens(account_id);
`);

console.log(`[SQLite] Adatbázis inicializálva és kész: ${dbPath}`);

// ==========================================
// ACCOUNTS MŰVELETEK
// ==========================================
const insertAccountStmt = db.prepare(`
  INSERT INTO accounts (id, username, password_hash, salt, avatar_color, avatar_url, created_at)
  VALUES (@id, @username, @password_hash, @salt, @avatar_color, @avatar_url, @created_at)
`);

const getAccountByIdStmt = db.prepare(`SELECT * FROM accounts WHERE id = ?`);
const getAccountByUsernameStmt = db.prepare(`SELECT * FROM accounts WHERE username = ? COLLATE NOCASE`);

const updateAccountStmt = db.prepare(`
  UPDATE accounts 
  SET username = @username, avatar_color = @avatar_color, avatar_url = @avatar_url
  WHERE id = @id
`);

// ==========================================
// AUTH TOKENEK MŰVELETEK
// ==========================================
const insertAuthTokenStmt = db.prepare(`
  INSERT INTO auth_tokens (token, account_id, created_at)
  VALUES (?, ?, ?)
`);

const getAccountByTokenStmt = db.prepare(`
  SELECT a.* FROM accounts a
  INNER JOIN auth_tokens t ON a.id = t.account_id
  WHERE t.token = ?
`);

const deleteAuthTokenStmt = db.prepare(`
  DELETE FROM auth_tokens WHERE token = ?
`);

const deleteAccountTokensStmt = db.prepare(`
  DELETE FROM auth_tokens WHERE account_id = ?
`);
const insertChannelMessageStmt = db.prepare(`
  INSERT INTO channel_messages (id, channel_id, sender_id, username, avatar_color, avatar_url, text, attachments, timestamp, created_at)
  VALUES (@id, @channel_id, @sender_id, @username, @avatar_color, @avatar_url, @text, @attachments, @timestamp, @created_at)
`);

const getChannelMessagesStmt = db.prepare(`
  SELECT * FROM channel_messages 
  WHERE channel_id = ? 
  ORDER BY created_at ASC 
  LIMIT 200
`);

// ==========================================
// PRIVÁT ÜZENETEK (DM) MŰVELETEK
// ==========================================
const insertDmMessageStmt = db.prepare(`
  INSERT INTO direct_messages (
    id, dm_key, sender_id, sender_account_id, sender_username, sender_avatar_color, sender_avatar_url,
    recipient_id, recipient_username, recipient_avatar_color, recipient_avatar_url,
    text, attachments, timestamp, created_at
  ) VALUES (
    @id, @dm_key, @sender_id, @sender_account_id, @sender_username, @sender_avatar_color, @sender_avatar_url,
    @recipient_id, @recipient_username, @recipient_avatar_color, @recipient_avatar_url,
    @text, @attachments, @timestamp, @created_at
  )
`);

const getDmMessagesStmt = db.prepare(`
  SELECT * FROM direct_messages 
  WHERE dm_key = ? 
  ORDER BY created_at ASC 
  LIMIT 250
`);

const getAllUserDmsStmt = db.prepare(`
  SELECT * FROM direct_messages 
  WHERE sender_username = ? COLLATE NOCASE OR recipient_username = ? COLLATE NOCASE
  ORDER BY created_at DESC
`);

// Helper formázó
function formatMessageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    username: row.username,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url,
    text: row.text,
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    timestamp: row.timestamp,
    createdAt: row.created_at
  };
}

function formatDmRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    dmKey: row.dm_key,
    username: row.sender_username, // Kompatibilitás a ChatArea-hoz
    senderId: row.sender_id,
    senderAccountId: row.sender_account_id,
    senderUsername: row.sender_username,
    senderAvatarColor: row.sender_avatar_color,
    senderAvatarUrl: row.sender_avatar_url,
    recipientId: row.recipient_id,
    recipientUsername: row.recipient_username,
    recipientAvatarColor: row.recipient_avatar_color,
    recipientAvatarUrl: row.recipient_avatar_url,
    avatarColor: row.sender_avatar_color,
    avatarUrl: row.sender_avatar_url,
    text: row.text,
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
    timestamp: row.timestamp,
    createdAt: row.created_at,
    isPrivate: true
  };
}

module.exports = {
  db,

  // Fiók metódusok
  createAccount({ id, username, passwordHash, salt, avatarColor, avatarUrl, createdAt }) {
    insertAccountStmt.run({
      id,
      username,
      password_hash: passwordHash,
      salt,
      avatar_color: avatarColor || '#7655F5',
      avatar_url: avatarUrl || null,
      created_at: createdAt || Date.now()
    });
    return this.getAccountById(id);
  },

  getAccountById(id) {
    const row = getAccountByIdStmt.get(id);
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      salt: row.salt,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at
    };
  },

  getAccountByUsername(username) {
    if (!username) return null;
    const row = getAccountByUsernameStmt.get(username);
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      salt: row.salt,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at
    };
  },

  updateAccount(id, { username, avatarColor, avatarUrl }) {
    updateAccountStmt.run({
      id,
      username,
      avatar_color: avatarColor,
      avatar_url: avatarUrl
    });
    return this.getAccountById(id);
  },

  // Csatorna üzenet metódusok
  saveChannelMessage(msg) {
    insertChannelMessageStmt.run({
      id: msg.id,
      channel_id: msg.channelId,
      sender_id: msg.senderId,
      username: msg.username,
      avatar_color: msg.avatarColor || '#7655F5',
      avatar_url: msg.avatarUrl || null,
      text: msg.text || '',
      attachments: JSON.stringify(msg.attachments || []),
      timestamp: msg.timestamp,
      created_at: msg.createdAt || Date.now()
    });
    return msg;
  },

  getChannelMessages(channelId) {
    const rows = getChannelMessagesStmt.all(channelId);
    return rows.map(formatMessageRow);
  },

  loadAllChannelMessages(channelIds) {
    const result = {};
    for (const cid of channelIds) {
      result[cid] = this.getChannelMessages(cid);
    }
    return result;
  },

  // Privát üzenet metódusok
  saveDmMessage(msg) {
    insertDmMessageStmt.run({
      id: msg.id,
      dm_key: msg.dmKey,
      sender_id: msg.senderId,
      sender_account_id: msg.senderAccountId || null,
      sender_username: msg.senderUsername,
      sender_avatar_color: msg.senderAvatarColor || '#7655F5',
      sender_avatar_url: msg.senderAvatarUrl || null,
      recipient_id: msg.recipientId,
      recipient_username: msg.recipientUsername,
      recipient_avatar_color: msg.recipientAvatarColor || '#7655F5',
      recipient_avatar_url: msg.recipientAvatarUrl || null,
      text: msg.text || '',
      attachments: JSON.stringify(msg.attachments || []),
      timestamp: msg.timestamp,
      created_at: msg.createdAt || Date.now()
    });
    return formatDmRow({
      ...msg,
      dm_key: msg.dmKey,
      sender_username: msg.senderUsername,
      sender_avatar_color: msg.senderAvatarColor,
      sender_avatar_url: msg.senderAvatarUrl,
      recipient_username: msg.recipientUsername,
      recipient_avatar_color: msg.recipientAvatarColor,
      recipient_avatar_url: msg.recipientAvatarUrl,
      attachments: JSON.stringify(msg.attachments || []),
      created_at: msg.createdAt
    });
  },

  getDmMessages(dmKey) {
    const rows = getDmMessagesStmt.all(dmKey);
    return rows.map(formatDmRow);
  },

  getUserDmConversations(username) {
    if (!username) return [];
    const rows = getAllUserDmsStmt.all(username, username);
    const partnersMap = new Map();

    for (const r of rows) {
      const isSender = r.sender_username.toLowerCase() === username.toLowerCase();
      const partnerName = isSender ? r.recipient_username : r.sender_username;
      const partnerColor = isSender ? r.recipient_avatar_color : r.sender_avatar_color;
      const partnerUrl = isSender ? r.recipient_avatar_url : r.sender_avatar_url;
      const partnerId = isSender ? r.recipient_id : r.sender_id;

      if (!partnersMap.has(partnerName.toLowerCase())) {
        partnersMap.set(partnerName.toLowerCase(), {
          id: partnerId || partnerName,
          username: partnerName,
          avatarColor: partnerColor || '#7655F5',
          avatarUrl: partnerUrl || null,
          lastMessage: r.text || 'Fájl csatolmány',
          lastTimestamp: r.timestamp
        });
      }
    }
    return Array.from(partnersMap.values());
  },

  // Token műveletek
  saveAuthToken(token, accountId) {
    insertAuthTokenStmt.run(token, accountId, Date.now());
  },

  getAccountByToken(token) {
    if (!token) return null;
    const row = getAccountByTokenStmt.get(token);
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at
    };
  },

  deleteAuthToken(token) {
    if (!token) return;
    deleteAuthTokenStmt.run(token);
  },

  deleteAccountTokens(accountId) {
    if (!accountId) return;
    deleteAccountTokensStmt.run(accountId);
  }
};
