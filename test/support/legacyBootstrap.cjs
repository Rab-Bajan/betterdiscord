// TEST-ONLY replica of the legacy server.js wiring (as of commit 18890f1, the last commit touching it), used as the golden
// reference for the new composition root. Kept line-for-line equivalent to legacy server.js;
// the only changes: it is a function, certs dir / port / host are parameters, requires resolve
// from the backend root, and it returns handles so a test can close it.
const { createRequire } = require('node:module');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const requireFromRoot = createRequire(path.join(ROOT, 'server.js'));

function bootLegacy({ certDir, port = 0, host = '127.0.0.1' }) {
  const express = requireFromRoot('express');
  const https = require('https');
  const fs = require('fs');
  const { Server } = requireFromRoot('socket.io');
  const cors = requireFromRoot('cors');

  process.on('uncaughtException', (err) => {
    console.error('[FATAL-GUARD] uncaughtException:', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL-GUARD] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
  });

  const app = express();
  app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
  app.use(express.json({ limit: '512kb' }));

  const sslOptions = {
    key: fs.readFileSync(path.join(certDir, 'key.pem')),
    cert: fs.readFileSync(path.join(certDir, 'cert.pem'))
  };

  const server = https.createServer(sslOptions, app);
  const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
  io.sockets.setMaxListeners(30);

  const { users } = requireFromRoot('./state');

  const casino = requireFromRoot('./casinoHandler')(io, app, path.resolve(ROOT, 'casino'));
  const watchParty = requireFromRoot('./watchPartyHandler')(io, app, users);
  const chess = requireFromRoot('./chessHandler')(io, app, users);
  const codeEditor = requireFromRoot('./codeEditorHandler')(io, users);
  const dm = requireFromRoot('./dmHandler')(io, users);
  const browser = requireFromRoot('./browserHandler')(io, app, users);

  requireFromRoot('./callHandler')(io);

  const chat = requireFromRoot('./chatHandler')(io);
  const whiteboard = requireFromRoot('./whiteboardHandler')(io);
  const game = requireFromRoot('./game/gameHandler')(io, { users });
  const empire = requireFromRoot('./miskolcEmpireHandler').setupMiskolcEmpire(io, users);
  const phobia = requireFromRoot('./miskolcPhobiaHandler').setupMiskolcPhobia(io, users);
  requireFromRoot('./speedTestHandler')(io);

  requireFromRoot('./voiceHandler')(
    io,
    (socket, channelId) => {
      socket.emit('game:session-updated', { channelId, state: game.getSession(channelId) });
      socket.emit('whiteboard:list', whiteboard.getBoardList(channelId));
      socket.emit('code:tree-data', codeEditor.getProject(channelId));
      socket.emit('watch:state', watchParty.getWatchSession(channelId));
      socket.emit('browser:state', browser.getBrowserSession(channelId));
      socket.emit('empire:session-updated', { channelId, state: empire.getSession(channelId) });
      socket.emit('phobia:session-updated', { channelId, state: phobia.getSession(channelId) });
    },
    (socketId, isSpeaking) => {
      phobia.handleUserSpeaking(socketId, isSpeaking);
    }
  );

  requireFromRoot('./authHandler')(io, () => ({
    channelMessages: chat.getChannelMessages(),
    casinoSessions: casino.getCasinoSessions(),
    watchSessions: watchParty.getWatchSessions(),
    chessSessions: chess.getChessSessions(),
    browserSessions: browser.getBrowserSessions(),
    empireSessions: empire.getEmpireSessions(),
    phobiaSessions: phobia.getPhobiaSessions()
  }));

  requireFromRoot('./adminHandler')(io, { casino, chess, dm });

  const { setupApiRoutes, serveFrontend } = requireFromRoot('./httpRoutes');
  setupApiRoutes(app);
  requireFromRoot('./analysis/routes').setupAnalysisRoutes(app);
  serveFrontend(app);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        close: async () => {
          clearInterval(phobia.tickInterval);
          server.closeAllConnections();
          await io.close();
        }
      });
    });
  });
}

module.exports = { bootLegacy };
