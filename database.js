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

// Admin által eltávolított üzenetek jelölése (az üzenet helyén látható marad a jelzés)
if (!db.prepare('PRAGMA table_info(direct_messages)').all().some((c) => c.name === 'removed_by_admin')) {
  db.exec('ALTER TABLE direct_messages ADD COLUMN removed_by_admin INTEGER DEFAULT 0');
}

// Hívás-események a DM-ben (rendszerüzenetként): JSON { callId, status, durationSec, callerUsername }
if (!db.prepare('PRAGMA table_info(direct_messages)').all().some((c) => c.name === 'call_event')) {
  db.exec('ALTER TABLE direct_messages ADD COLUMN call_event TEXT');
}

// Hanghívások naplója (csak metaadat, hang soha nem kerül tárolásra)
db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    dm_key TEXT NOT NULL,
    caller_account_id TEXT NOT NULL,
    caller_username TEXT NOT NULL,
    callee_account_id TEXT NOT NULL,
    callee_username TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    ended_at INTEGER,
    duration_sec INTEGER DEFAULT 0,
    end_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_calls_dm ON calls(dm_key, created_at);
`);

// DM jelentések: egy résztvevő jelent egy üzenetet; az admin csak ezekhez a beszélgetésekhez fér hozzá
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_reports (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    dm_key TEXT NOT NULL,
    reporter_username TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER,
    resolved_by TEXT,
    resolved_at INTEGER,
    resolution TEXT,
    UNIQUE (message_id, reporter_username)
  );
  CREATE INDEX IF NOT EXISTS idx_dm_reports_status ON dm_reports(status, created_at);
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
    text, attachments, timestamp, created_at, call_event
  ) VALUES (
    @id, @dm_key, @sender_id, @sender_account_id, @sender_username, @sender_avatar_color, @sender_avatar_url,
    @recipient_id, @recipient_username, @recipient_avatar_color, @recipient_avatar_url,
    @text, @attachments, @timestamp, @created_at, @call_event
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
    removedByAdmin: !!row.removed_by_admin,
    callEvent: row.call_event ? (typeof row.call_event === 'string' ? JSON.parse(row.call_event) : row.call_event) : null,
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
      created_at: msg.createdAt || Date.now(),
      call_event: msg.callEvent ? JSON.stringify(msg.callEvent) : null
    });
    return formatDmRow({
      ...msg,
      call_event: msg.callEvent ? JSON.stringify(msg.callEvent) : null,
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

  getDmMessageById(id) {
    return formatDmRow(db.prepare('SELECT * FROM direct_messages WHERE id = ?').get(id));
  },

  // A beszélgetés `before` db üzenete a megadott időpont előtt/ott és `after` db utána (a jelentés környezete)
  getDmContext(dmKey, createdAt, before = 10, after = 10) {
    const older = db.prepare(
      'SELECT * FROM direct_messages WHERE dm_key = ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?'
    ).all(dmKey, createdAt, before + 1).reverse();
    const newer = db.prepare(
      'SELECT * FROM direct_messages WHERE dm_key = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?'
    ).all(dmKey, createdAt, after);
    return [...older, ...newer].map(formatDmRow);
  },

  // Üzenet tartalmának eltávolítása; a sor megmarad, a kliens jelzést mutat helyette
  removeDmMessage(id) {
    return db.prepare("UPDATE direct_messages SET text = '', attachments = '[]', removed_by_admin = 1 WHERE id = ?").run(id).changes > 0;
  },

  createDmReport({ id, messageId, dmKey, reporterUsername, reason }) {
    const result = db.prepare(`
      INSERT OR IGNORE INTO dm_reports (id, message_id, dm_key, reporter_username, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?)
    `).run(id, messageId, dmKey, reporterUsername, reason || '', Date.now());
    return result.changes > 0; // false: ugyanezt az üzenetet már jelentette
  },

  getDmReport(id) {
    return db.prepare('SELECT * FROM dm_reports WHERE id = ?').get(id) || null;
  },

  listDmReports(status = 'open') {
    return db.prepare('SELECT * FROM dm_reports WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status);
  },

  resolveDmReport(id, adminUsername, resolution) {
    return db.prepare(
      "UPDATE dm_reports SET status = 'resolved', resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ? AND status = 'open'"
    ).run(adminUsername, Date.now(), resolution || '', id).changes > 0;
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
          lastMessage: r.call_event ? 'Hanghívás' : (r.text || 'Fájl csatolmány'),
          lastTimestamp: r.timestamp
        });
      }
    }
    return Array.from(partnersMap.values());
  },

  // Hívásnapló
  saveCall(c) {
    db.prepare(`
      INSERT OR REPLACE INTO calls (id, dm_key, caller_account_id, caller_username, callee_account_id, callee_username,
        status, created_at, answered_at, ended_at, duration_sec, end_reason)
      VALUES (@id, @dmKey, @callerAccountId, @callerUsername, @calleeAccountId, @calleeUsername,
        @status, @createdAt, @answeredAt, @endedAt, @durationSec, @endReason)
    `).run({ answeredAt: null, endedAt: null, durationSec: 0, endReason: null, ...c });
  },

  getCallHistory(dmKey, limit = 50) {
    return db.prepare('SELECT * FROM calls WHERE dm_key = ? ORDER BY created_at DESC LIMIT ?').all(dmKey, limit).map((r) => ({
      id: r.id,
      callerUsername: r.caller_username,
      calleeUsername: r.callee_username,
      status: r.status,
      createdAt: r.created_at,
      durationSec: r.duration_sec || 0
    }));
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
