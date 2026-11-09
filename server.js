const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const PORT = process.env.PORT || 5000;

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
// A PGN fájlok a szokásosnál nagyobbak lehetnek (az elemzés importja)
app.use(express.json({ limit: '512kb' }));

// HTTPS tanúsítványok betöltése
const certDir = path.resolve(__dirname, '../certs');
let sslOptions;
try {
  sslOptions = {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
  };
} catch (err) {
  console.error(`[SSL] Hiba a tanúsítványok betöltésekor (${certDir}/key.pem, cert.pem):`, err.message);
  process.exit(1);
}

const server = https.createServer(sslOptions, app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
io.sockets.setMaxListeners(30); // sok modul köti a 'connection' eseményt

const { users } = require('./state');

// Modulok. A (io, app, users) szignatúrájú kezelők a régebbi, önálló modulok.
const casino = require('./casinoHandler')(io, app, path.resolve(__dirname, 'casino'));
const watchParty = require('./watchPartyHandler')(io, app, users);
const chess = require('./chessHandler')(io, app, users);
const codeEditor = require('./codeEditorHandler')(io, users);
const dm = require('./dmHandler')(io, users);
const browser = require('./browserHandler')(io, app, users);

require('./callHandler')(io); // DM hanghívások szignálozása (WebRTC)

const chat = require('./chatHandler')(io);
const whiteboard = require('./whiteboardHandler')(io);
const game = require('./game/gameHandler')(io, { users });
require('./speedTestHandler')(io);

// A szobába belépő felhasználó megkapja a szobához kötött állapotokat
require('./voiceHandler')(io, (socket, channelId) => {
  socket.emit('game:session-updated', { channelId, state: game.getSession(channelId) });
  socket.emit('whiteboard:list', whiteboard.getBoardList(channelId));
  socket.emit('code:tree-data', codeEditor.getProject(channelId));
  socket.emit('watch:state', watchParty.getWatchSession(channelId));
  socket.emit('browser:state', browser.getBrowserSession(channelId));
});

require('./authHandler')(io, () => ({
  channelMessages: chat.getChannelMessages(),
  casinoSessions: casino.getCasinoSessions(),
  watchSessions: watchParty.getWatchSessions(),
  chessSessions: chess.getChessSessions(),
  browserSessions: browser.getBrowserSessions()
}));

require('./adminHandler')(io, { casino, chess, dm });

const { setupApiRoutes, serveFrontend } = require('./httpRoutes');
setupApiRoutes(app);

// Chess.com import + Stockfish játszma-elemzés
require('./analysis/routes').setupAnalysisRoutes(app);
serveFrontend(app);

server.listen(PORT, () => {
  console.log(`>>> Discord VoIP & Chat Backend (HTTPS) fut: https://localhost:${PORT}`);
});
