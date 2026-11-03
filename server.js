const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST']
}));
app.use(express.json());

const certDir = path.resolve(__dirname, '../certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

// Automatikus tanúsítvány betöltés vagy generálás ha hiányozna
let sslOptions = {};
try {
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.log('[SSL] Tanúsítványok nem találhatók, automatikus generálás...');
    const selfsigned = require('selfsigned');
    const attrs = [
      { name: 'commonName', value: 'localhost' },
      { name: 'organizationName', value: 'Discord VoIP Dev' }
    ];
    // selfsigned v2 sync or promise
    // Ha létezik a certDir, biztosítjuk
    if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
  }
  sslOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
} catch (err) {
  console.error('[SSL] Hiba a tanúsítványok betöltésekor:', err);
  process.exit(1);
}

const server = https.createServer(sslOptions, app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 3D Velvet Room Multiplayer Kaszinó inicializálása
const setupCasino = require('./casinoHandler');
const casinoDir = path.resolve(__dirname, 'casino');
const casinoManager = setupCasino(io, app, casinoDir);

const PORT = process.env.PORT || 5000;

// State management
const users = new Map(); // socket.id -> { id, username, avatarColor, voiceChannel: null, isMuted: false, isDeafened: false }

// Watch Together (YouTube & CineHD Közös Mozizás) inicializálása
const setupWatchParty = require('./watchPartyHandler');
const watchPartyManager = setupWatchParty(io, app, users);

// SharkVoic 1v1 Sakk és Spectator játékmód inicializálása
const setupChess = require('./chessHandler');
const chessManager = setupChess(io, app, users);

// SQLite Adatbázis, Authentikáció és Privát Üzenetek (DM)
const database = require('./database');
const authManager = require('./authManager');
const setupDm = require('./dmHandler');
const dmManager = setupDm(io, users);

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

// In-memory whiteboard storage: channelId -> Map<boardId, board>
const channelWhiteboards = new Map();

function getChannelWhiteboards(channelId) {
  if (!channelWhiteboards.has(channelId)) {
    return [];
  }
  const boardsMap = channelWhiteboards.get(channelId);
  return Array.from(boardsMap.values()).map(b => ({
    id: b.id,
    title: b.title,
    creatorId: b.creatorId,
    creatorName: b.creatorName,
    createdAt: b.createdAt,
    strokeCount: b.strokes.length
  }));
}

// In-memory Code Projects per voice channel
const channelCodeProjects = new Map();

function getDefaultProjectTree() {
  return {
    id: 'root',
    name: 'Projekt',
    type: 'folder',
    children: [
      {
        id: 'file-index-js',
        name: 'index.js',
        type: 'file',
        content: `// ======================================\n// 💻 Közös Discord Kód Editor\n// Bárki szerkesztheti valós időben!\n// ======================================\n\nfunction koszontes(nev) {\n  console.log(\`Üdvözlünk a szobában, \${nev}! 🎉\`);\n  return true;\n}\n\nconst szoba = "Általános Hang";\nkoszontes("Csapattárs");\n`
      },
      {
        id: 'folder-src',
        name: 'src',
        type: 'folder',
        children: [
          {
            id: 'file-app-py',
            name: 'app.py',
            type: 'file',
            content: `# Python script példa\nimport time\n\ndef ellenorzes():\n    print("Közös kódolás fut...")\n    time.sleep(1)\n    print("Kész!")\n\nif __name__ == '__main__':\n    ellenorzes()\n`
          },
          {
            id: 'file-styles-css',
            name: 'styles.css',
            type: 'file',
            content: `/* Discord stíluslap */\n.editor-container {\n  background-color: #1e1f22;\n  color: #dbdee1;\n  font-family: Consolas, monospace;\n}\n\n.highlight {\n  color: #5865F2;\n}\n`
          }
        ]
      },
      {
        id: 'file-readme',
        name: 'README.md',
        type: 'file',
        content: `# Közös Kód Projekt 🚀\n\nEz egy valós időben megosztott kód editor.\n- Bal oldalon hozhatsz létre új fájlokat és mappákat.\n- A kód automatikusan szinkronizálódik a szobában lévőkkel.\n- Futtatási funkció nincs (csak szerkesztés és kódolás).\n`
      }
    ]
  };
}

function getChannelProject(channelId) {
  if (!channelCodeProjects.has(channelId)) {
    channelCodeProjects.set(channelId, getDefaultProjectTree());
  }
  return channelCodeProjects.get(channelId);
}

function findNodeById(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function addNodeToFolder(root, parentId, newNode) {
  const parent = findNodeById(root, parentId || 'root');
  if (parent && parent.type === 'folder') {
    if (!parent.children) parent.children = [];
    parent.children.push(newNode);
    return true;
  }
  return false;
}

function deleteNodeById(root, id) {
  if (id === 'root') return false;
  if (!root.children) return false;

  const idx = root.children.findIndex(c => c.id === id);
  if (idx !== -1) {
    root.children.splice(idx, 1);
    return true;
  }

  for (const child of root.children) {
    if (child.type === 'folder' && deleteNodeById(child, id)) {
      return true;
    }
  }
  return false;
}

function renameNodeById(root, id, newName) {
  const node = findNodeById(root, id);
  if (node && id !== 'root') {
    node.name = newName.trim();
    return true;
  }
  return false;
}

function updateFileContent(root, fileId, content) {
  const node = findNodeById(root, fileId);
  if (node && node.type === 'file') {
    node.content = content;
    return true;
  }
  return false;
}

// SQLite-ból betöltött csatorna üzenetek
const defaultChannelIds = ['altalanos', 'gaming', 'zene', 'fejlesztes'];
const channelMessages = database.loadAllChannelMessages(defaultChannelIds);

if (!channelMessages['altalanos'] || channelMessages['altalanos'].length === 0) {
  channelMessages['altalanos'] = [
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

// API endpoint for health check
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    protocol: 'https',
    usersOnline: users.size,
    textChannels,
    voiceChannels
  });
});

// Speed Test végpontok
const speedTestSample = Buffer.alloc(1024 * 1024, 'x'); // 1MB minta adat

// Letöltési sebesség mérése
app.get('/api/speedtest/download', (req, res) => {
  const mb = Math.min(Math.max(parseInt(req.query.mb) || 3, 1), 10);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Length', mb * 1024 * 1024);

  for (let i = 0; i < mb; i++) {
    res.write(speedTestSample);
  }
  res.end();
});

// Feltöltési sebesség mérése
app.post('/api/speedtest/upload', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  const bytes = req.body ? req.body.length : 0;
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.json({
    status: 'ok',
    receivedBytes: bytes,
    timestamp: Date.now()
  });
});

// Fájlfeltöltések (Multer tároló) beállítása
const uploadsDir = path.resolve(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    let originalName = file.originalname;
    try {
      originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    } catch (e) {}
    const ext = path.extname(originalName);
    const base = path.basename(originalName, ext).replace(/[^a-zA-Z0-9_\-]/g, '_') || 'file';
    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}${ext}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100 MB max fájlméret
  }
});

// Feltöltött fájlok statikus kiszolgálása
app.use('/uploads', express.static(uploadsDir));

// Fájlfeltöltés végpont (Drag & drop és tallózó gomb)
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'Nincs feltöltött fájl.' });
    }

    const files = req.files.map((file) => {
      let originalName = file.originalname;
      try {
        originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      } catch (e) {}

      return {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        filename: file.filename,
        originalName: originalName,
        size: file.size,
        mimeType: file.mimetype,
        url: `/uploads/${encodeURIComponent(file.filename)}`,
        downloadUrl: `/api/download/${encodeURIComponent(file.filename)}?name=${encodeURIComponent(originalName)}`
      };
    });

    console.log(`[Upload] Sikeres feltöltés: ${files.length} db fájl`);
    res.json({ ok: true, files });
  } catch (err) {
    console.error('[Upload Hiba]:', err);
    res.status(500).json({ error: 'Hiba történt a fájlok mentésekor.' });
  }
});

// Fájlletöltés végpont (eredeti névvel letöltés kényszerítése)
app.get('/api/download/:filename', (req, res) => {
  const filename = path.basename(decodeURIComponent(req.params.filename));
  const filePath = path.join(uploadsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('A kért fájl nem található a szerveren.');
  }

  const customName = req.query.name ? String(req.query.name) : filename;
  const safeAsciiName = customName.replace(/[^\x20-\x7E]/g, '_');
  const encodedName = encodeURIComponent(customName);

  res.setHeader('Content-Disposition', `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error('[Download Stream Error]:', err);
    if (!res.headersSent) res.status(500).send('Hiba történt a fájl olvasásakor.');
  });
  stream.pipe(res);
});

function getVoiceChannelState() {
  const state = {};
  for (const vc of voiceChannels) {
    state[vc.id] = [];
  }
  for (const [id, user] of users.entries()) {
    if (user.voiceChannel && state[user.voiceChannel]) {
      state[user.voiceChannel].push({
        id: user.id,
        username: user.username,
        avatarColor: user.avatarColor,
        isMuted: user.isMuted,
        isDeafened: user.isDeafened,
        isSpeaking: user.isSpeaking || false,
        isScreenSharing: user.isScreenSharing || false,
        speedTest: user.speedTest || null
      });
    }
  }
  return state;
}

function getOnlineUsersList() {
  return Array.from(users.values()).map(u => ({
    id: u.id,
    accountId: u.accountId || null,
    username: u.username,
    avatarColor: u.avatarColor,
    avatarUrl: u.avatarUrl || null,
    voiceChannel: u.voiceChannel,
    isMuted: u.isMuted,
    isDeafened: u.isDeafened,
    isScreenSharing: u.isScreenSharing || false,
    speedTest: u.speedTest || null
  }));
}

io.on('connection', (socket) => {
  console.log(`[Socket HTTPS] Csatlakozott kliens: ${socket.id}`);

  // Helper a felhasználó session beállításához
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
      speedTest: null
    };

    users.set(socket.id, userObj);

    // Kliens inicializálása adatokkal
    socket.emit('init:data', {
      self: userObj,
      textChannels,
      voiceChannels,
      channelMessages,
      voiceStates: getVoiceChannelState(),
      onlineUsers: getOnlineUsersList(),
      casinoSessions: casinoManager.getCasinoSessions(),
      watchSessions: watchPartyManager.getWatchSessions(),
      chessSessions: chessManager.getChessSessions()
    });

    // Értesítés a többieknek
    io.emit('users:updated', getOnlineUsersList());
    io.emit('voice:states-updated', getVoiceChannelState());

    console.log(`[User] Belépett: ${userObj.username} (${socket.id})`);
    return userObj;
  }

  // 1A. Regisztráció
  socket.on('auth:register', ({ username, password, avatarColor, avatarUrl }) => {
    const res = authManager.register({ username, password, avatarColor, avatarUrl });
    if (!res.success) {
      socket.emit('auth:error', { error: res.error });
      return;
    }
    const sessionUser = establishUserSession({
      accountId: res.user.id,
      username: res.user.username,
      avatarColor: res.user.avatarColor,
      avatarUrl: res.user.avatarUrl
    });
    socket.emit('auth:success', { user: sessionUser, token: res.token });
  });

  // 1B. Bejelentkezés
  socket.on('auth:login', ({ username, password }) => {
    const res = authManager.login({ username, password });
    if (!res.success) {
      socket.emit('auth:error', { error: res.error });
      return;
    }
    const sessionUser = establishUserSession({
      accountId: res.user.id,
      username: res.user.username,
      avatarColor: res.user.avatarColor,
      avatarUrl: res.user.avatarUrl
    });
    socket.emit('auth:success', { user: sessionUser, token: res.token });
  });

  // 1B2. Automatikus munkamenet hitelesítés Tokennel
  socket.on('auth:verify-token', ({ token }) => {
    const res = authManager.verifyToken(token);
    if (!res.success) {
      socket.emit('auth:token-invalid', { error: res.error });
      return;
    }
    const sessionUser = establishUserSession({
      accountId: res.user.id,
      username: res.user.username,
      avatarColor: res.user.avatarColor,
      avatarUrl: res.user.avatarUrl
    });
    socket.emit('auth:success', { user: sessionUser, token: res.token });
  });

  // 1B3. Kijelentkezés
  socket.on('auth:logout', ({ token }) => {
    authManager.logout(token);
    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      io.emit('users:updated', getOnlineUsersList());
      io.emit('voice:states-updated', getVoiceChannelState());
    }
  });

  // 1C. Vendég belépés (Visszafelé kompatibilitás)
  socket.on('user:join', ({ username, avatarColor, avatarUrl, accountId }) => {
    const cleanUsername = (username || `Felhasználó_${socket.id.substring(0, 4)}`).trim();
    const color = avatarColor || '#7655F5';
    establishUserSession({
      accountId: accountId || null,
      username: cleanUsername,
      avatarColor: color,
      avatarUrl: avatarUrl || null
    });
  });

  // 1D. Profil szerkesztése (Név, Szín, Profilkép)
  socket.on('user:update-profile', ({ username, avatarColor, avatarUrl }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const res = authManager.updateProfile(user.accountId, { username, avatarColor, avatarUrl });
    if (!res.success) {
      socket.emit('profile:error', { error: res.error });
      return;
    }

    user.username = res.user.username;
    user.avatarColor = res.user.avatarColor;
    user.avatarUrl = res.user.avatarUrl;

    socket.emit('user:profile-updated', user);
    io.emit('users:updated', getOnlineUsersList());
    io.emit('voice:states-updated', getVoiceChannelState());
    console.log(`[User] Profil módosítva: ${user.username} (${socket.id})`);
  });

  // 2. Szöveges vagy fájl csatolmányos üzenet küldése
  socket.on('chat:message', ({ channelId, text, attachments }) => {
    const user = users.get(socket.id);
    const cleanText = typeof text === 'string' ? text.trim() : '';
    const validAttachments = Array.isArray(attachments) ? attachments : [];

    if (!user || (!cleanText && validAttachments.length === 0)) return;

    if (!channelMessages[channelId]) {
      channelMessages[channelId] = [];
    }

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

    // Mentés SQLite adatbázisba
    database.saveChannelMessage(newMsg);

    channelMessages[channelId].push(newMsg);
    if (channelMessages[channelId].length > 150) {
      channelMessages[channelId].shift();
    }

    io.emit('chat:new-message', newMsg);
  });

  // 3. Hangcsatorna csatlakozás (VoIP)
  socket.on('voice:join', ({ channelId }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const prevChannel = user.voiceChannel;
    if (prevChannel) {
      socket.leave(prevChannel);
      socket.to(prevChannel).emit('voice:peer-left', { peerId: socket.id });
    }

    user.voiceChannel = channelId;
    user.isSpeaking = false;
    socket.join(channelId);

    const peersInRoom = [];
    for (const [id, u] of users.entries()) {
      if (u.voiceChannel === channelId && id !== socket.id) {
        peersInRoom.push({
          id: u.id,
          username: u.username,
          avatarColor: u.avatarColor,
          isMuted: u.isMuted,
          isDeafened: u.isDeafened
        });
      }
    }

    socket.emit('voice:joined', {
      channelId,
      peers: peersInRoom
    });

    // Elküldjük a csatornához tartozó aktív rajztáblákat is
    socket.emit('whiteboard:list', getChannelWhiteboards(channelId));

    // Elküldjük a csatorna kód projektjének fájlfáját is
    socket.emit('code:tree-data', getChannelProject(channelId));

    // Elküldjük a csatorna aktív Watch Party (Mozi) állapotát is
    socket.emit('watch:state', watchPartyManager.getWatchSession(channelId));

    socket.to(channelId).emit('voice:peer-joined', {
      peerId: socket.id,
      user: {
        id: user.id,
        username: user.username,
        avatarColor: user.avatarColor,
        isMuted: user.isMuted,
        isDeafened: user.isDeafened
      }
    });

    io.emit('voice:states-updated', getVoiceChannelState());
    console.log(`[Voice] ${user.username} csatlakozott a(z) ${channelId} csatornához`);
  });

  // 4. Hangcsatorna elhagyása
  socket.on('voice:leave', () => {
    const user = users.get(socket.id);
    if (!user || !user.voiceChannel) return;

    const channelId = user.voiceChannel;
    socket.leave(channelId);
    user.voiceChannel = null;
    user.isSpeaking = false;
    user.isScreenSharing = false;

    socket.to(channelId).emit('voice:peer-left', { peerId: socket.id });
    io.emit('voice:states-updated', getVoiceChannelState());
    console.log(`[Voice] ${user.username} kilépett a(z) ${channelId} csatornából`);
  });

  // 5. WebRTC Szignál továbbítás (Offer / Answer / ICE Candidate)
  socket.on('webrtc:signal', ({ targetPeerId, signal }) => {
    const sender = users.get(socket.id);
    if (!sender || !targetPeerId || !signal) return;

    const targetUser = users.get(targetPeerId);
    if (!targetUser) {
      console.warn(`[WebRTC Relay] Célpont nem található: ${targetPeerId} (feladó: ${sender.username})`);
      return;
    }

    io.to(targetPeerId).emit('webrtc:signal', {
      senderPeerId: socket.id,
      signal
    });
  });

  // 6. Beszéd indikátor (Speaking)
  socket.on('voice:speaking', ({ isSpeaking }) => {
    const user = users.get(socket.id);
    if (!user || !user.voiceChannel) return;

    user.isSpeaking = isSpeaking;
    io.to(user.voiceChannel).emit('voice:user-speaking', {
      userId: socket.id,
      isSpeaking
    });
  });

  // 6.b Képernyőmegosztás (Screen Share)
  socket.on('voice:screen-share', ({ isSharing }) => {
    const user = users.get(socket.id);
    if (!user || !user.voiceChannel) return;

    user.isScreenSharing = !!isSharing;
    io.emit('voice:states-updated', getVoiceChannelState());
    io.to(user.voiceChannel).emit('voice:user-screen-sharing', {
      userId: socket.id,
      isSharing: user.isScreenSharing
    });
    console.log(`[ScreenShare] ${user.username} képernyőmegosztás: ${user.isScreenSharing ? 'BE' : 'KI'}`);
  });

  // 7. Mikrofon némítás / Süketítés állapotváltás
  socket.on('voice:state-change', ({ isMuted, isDeafened }) => {
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

  // 7.b Rajztábla (Whiteboard / Paint) Kezelés
  socket.on('whiteboard:create', ({ channelId, title }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    if (!channelWhiteboards.has(channelId)) {
      channelWhiteboards.set(channelId, new Map());
    }
    const boardsMap = channelWhiteboards.get(channelId);
    const boardId = `board_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newBoard = {
      id: boardId,
      title: (title || `${user.username} Rajztáblája`).trim(),
      creatorId: user.id,
      creatorName: user.username,
      strokes: [],
      createdAt: Date.now()
    };
    boardsMap.set(boardId, newBoard);

    io.to(channelId).emit('whiteboard:list', getChannelWhiteboards(channelId));
    io.to(channelId).emit('whiteboard:created', {
      board: {
        id: newBoard.id,
        title: newBoard.title,
        creatorId: newBoard.creatorId,
        creatorName: newBoard.creatorName,
        createdAt: newBoard.createdAt,
        strokeCount: 0
      }
    });
    console.log(`[Whiteboard] Új tábla létrehozva a(z) ${channelId} szobában: "${newBoard.title}" (${user.username})`);
  });

  socket.on('whiteboard:get', ({ channelId, boardId }) => {
    const boardsMap = channelWhiteboards.get(channelId);
    if (boardsMap && boardsMap.has(boardId)) {
      const board = boardsMap.get(boardId);
      socket.emit('whiteboard:data', {
        boardId,
        title: board.title,
        strokes: board.strokes
      });
    }
  });

  socket.on('whiteboard:draw', ({ channelId, boardId, stroke }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const boardsMap = channelWhiteboards.get(channelId);
    if (boardsMap && boardsMap.has(boardId)) {
      const board = boardsMap.get(boardId);
      board.strokes.push(stroke);
      if (board.strokes.length > 10000) {
        board.strokes.shift();
      }
      socket.to(channelId).emit('whiteboard:stroke', {
        boardId,
        stroke,
        senderId: socket.id,
        senderName: user.username
      });
    }
  });

  socket.on('whiteboard:clear', ({ channelId, boardId }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const boardsMap = channelWhiteboards.get(channelId);
    if (boardsMap && boardsMap.has(boardId)) {
      const board = boardsMap.get(boardId);
      board.strokes = [];
      io.to(channelId).emit('whiteboard:cleared', {
        boardId,
        clearedBy: user.username
      });
      console.log(`[Whiteboard] Tábla letisztítva: ${boardId} (${user.username})`);
    }
  });

  socket.on('whiteboard:delete', ({ channelId, boardId }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const boardsMap = channelWhiteboards.get(channelId);
    if (boardsMap && boardsMap.has(boardId)) {
      boardsMap.delete(boardId);
      io.to(channelId).emit('whiteboard:deleted', { boardId });
      io.to(channelId).emit('whiteboard:list', getChannelWhiteboards(channelId));
      console.log(`[Whiteboard] Tábla bezárva/törölve: ${boardId} (${user.username})`);
    }
  });

  // 7.c Net Sebességteszt (Speed Test)
  socket.on('speedtest:ping', ({ clientTime }) => {
    socket.emit('speedtest:pong', {
      clientTime,
      serverTime: Date.now()
    });
  });

  socket.on('speedtest:save-result', (result) => {
    const user = users.get(socket.id);
    if (!user) return;

    user.speedTest = {
      ping: Math.round(result.ping || 0),
      download: Number((result.download || 0).toFixed(1)),
      upload: Number((result.upload || 0).toFixed(1)),
      jitter: Math.round(result.jitter || 0),
      testedAt: Date.now()
    };

    io.emit('users:updated', getOnlineUsersList());
    io.emit('voice:states-updated', getVoiceChannelState());
    io.emit('speedtest:result-announced', {
      userId: user.id,
      username: user.username,
      avatarColor: user.avatarColor,
      result: user.speedTest
    });

    console.log(`[SpeedTest] ${user.username} sebességtesztje: Ping: ${user.speedTest.ping}ms, DL: ${user.speedTest.download} Mbps, UL: ${user.speedTest.upload} Mbps`);
  });

  socket.on('speedtest:request-user', ({ targetUserId }) => {
    const sender = users.get(socket.id);
    const target = users.get(targetUserId);
    if (sender && target) {
      io.to(targetUserId).emit('speedtest:requested-by', {
        requesterId: sender.id,
        requesterName: sender.username
      });
      console.log(`[SpeedTest] ${sender.username} sebességtesztet kért ${target.username}-től`);
    }
  });

  // 7.d Közös Kód Editor (Code Editor)
  socket.on('code:get-tree', ({ channelId }) => {
    socket.emit('code:tree-data', getChannelProject(channelId));
  });

  socket.on('code:create-node', ({ channelId, parentId, name, type }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const project = getChannelProject(channelId);
    const nodeId = `${type}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const newNode = {
      id: nodeId,
      name: (name || (type === 'file' ? 'uj_file.js' : 'uj_mappa')).trim(),
      type, // 'file' | 'folder'
      ...(type === 'file' ? { content: '' } : { children: [] })
    };

    const added = addNodeToFolder(project, parentId, newNode);
    if (added) {
      io.to(channelId).emit('code:tree-data', project);
      console.log(`[CodeEditor] Új ${type} létrehozva: "${newNode.name}" (${user.username})`);
    }
  });

  socket.on('code:delete-node', ({ channelId, nodeId }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const project = getChannelProject(channelId);
    const deleted = deleteNodeById(project, nodeId);
    if (deleted) {
      io.to(channelId).emit('code:tree-data', project);
      console.log(`[CodeEditor] Elem törölve: ${nodeId} (${user.username})`);
    }
  });

  socket.on('code:rename-node', ({ channelId, nodeId, newName }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const project = getChannelProject(channelId);
    const renamed = renameNodeById(project, nodeId, newName);
    if (renamed) {
      io.to(channelId).emit('code:tree-data', project);
      console.log(`[CodeEditor] Elem átnevezve: "${newName}" (${user.username})`);
    }
  });

  socket.on('code:file-change', ({ channelId, fileId, content }) => {
    const user = users.get(socket.id);
    if (!user || user.voiceChannel !== channelId) return;

    const project = getChannelProject(channelId);
    const updated = updateFileContent(project, fileId, content);
    if (updated) {
      // Továbbítjuk a szoba többi tagjának
      socket.to(channelId).emit('code:file-updated', {
        fileId,
        content,
        senderName: user.username
      });
    }
  });

  // 8. Lekapcsolódás
  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      if (user.voiceChannel) {
        socket.to(user.voiceChannel).emit('voice:peer-left', { peerId: socket.id });
      }
      users.delete(socket.id);
      io.emit('users:updated', getOnlineUsersList());
      io.emit('voice:states-updated', getVoiceChannelState());
      console.log(`[User] Kilépett: ${user.username} (${socket.id})`);
    }
  });
});

// Statikus frontend kiszolgálása, ha létezik a build (frontend/dist vagy backend/public)
const frontendDist = path.resolve(__dirname, '../frontend/dist');
const backendPublic = path.resolve(__dirname, 'public');
const staticRoot = fs.existsSync(frontendDist) ? frontendDist : (fs.existsSync(backendPublic) ? backendPublic : null);

if (staticRoot) {
  console.log(`[Static] Statikus frontend fájlok kiszolgálása innen: ${staticRoot}`);
  app.use(express.static(staticRoot));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/socket.io') || req.path.startsWith('/api') || req.path.startsWith('/casino')) {
      return next();
    }
    const indexHtml = path.join(staticRoot, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.sendFile('index.html', { root: staticRoot });
    } else {
      next();
    }
  });
}

server.listen(PORT, () => {
  console.log(`>>> Discord VoIP & Chat Backend (HTTPS) fut: https://localhost:${PORT}`);
});
