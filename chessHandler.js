const { Chess } = require('chess.js');

module.exports = function setupChess(io, app, users) {
  // Csatornánkénti sakk állapot: channelId -> session
  const chessSessions = new Map();

  function sanitizeSession(session) {
    if (!session) return null;
    return {
      channelId: session.channelId,
      active: session.active,
      fen: session.chess.fen(),
      turn: session.chess.turn(), // 'w' vagy 'b'
      white: session.white,
      black: session.black,
      spectators: session.spectators,
      history: session.history,
      status: session.status, // 'waiting' | 'playing' | 'checkmate' | 'draw' | 'resigned' | 'timeout'
      winner: session.winner, // 'white' | 'black' | 'draw' | null
      reason: session.reason, // 'checkmate' | 'resignation' | 'stalemate' | 'threefold' | 'insufficient' | 'draw-agreement'
      inCheck: session.chess.inCheck(),
      isGameOver: session.chess.isGameOver(),
      startedBy: session.startedBy,
      createdAt: session.createdAt,
      lastMove: session.lastMove || null
    };
  }

  function emitSessionUpdate(channelId) {
    const session = chessSessions.get(channelId);
    const sanitized = sanitizeSession(session);
    io.to(channelId).emit('chess:state', sanitized);
    io.emit('chess:session-updated', { channelId, state: sanitized });
  }

  // Socket.io kezelők a Sakkhoz
  io.on('connection', (socket) => {
    // 1. Sakk Parti indítása vagy lekérése
    socket.on('chess:start', ({ channelId, colorPreference = 'white' }) => {
      if (!channelId) return;
      const user = users.get(socket.id);
      const username = user?.username || 'Játékos';
      const avatarColor = user?.avatarColor || '#7655F5';

      let session = chessSessions.get(channelId);

      if (!session) {
        // Új parti létrehozása
        const chessInstance = new Chess();
        const playerObj = {
          id: socket.id,
          username,
          avatarColor
        };

        session = {
          channelId,
          active: true,
          chess: chessInstance,
          white: colorPreference === 'black' ? null : playerObj,
          black: colorPreference === 'black' ? playerObj : null,
          spectators: [],
          history: [],
          status: 'waiting', // Várakozik az ellenfélre
          winner: null,
          reason: null,
          startedBy: username,
          createdAt: Date.now(),
          lastMove: null
        };

        chessSessions.set(channelId, session);
        console.log(`[Chess] Új sakk parti indítva a(z) ${channelId} szobában (${username})`);
      } else {
        // Ha már létezik és nem játékos és van üres hely, nem írjuk felül, csak csatlakozik
        if (session.white?.id !== socket.id && session.black?.id !== socket.id) {
          if (!session.spectators.some(s => s.id === socket.id)) {
            session.spectators.push({ id: socket.id, username, avatarColor });
          }
        }
      }

      emitSessionUpdate(channelId);
    });

    // 2. Csatlakozás játékosként (1v1)
    socket.on('chess:join', ({ channelId }) => {
      const session = chessSessions.get(channelId);
      if (!session) return;
      const user = users.get(socket.id);
      const username = user?.username || 'Játékos';
      const avatarColor = user?.avatarColor || '#536CFF';

      const playerObj = {
        id: socket.id,
        username,
        avatarColor
      };

      // Ha már játékos, nincs teendő
      if (session.white?.id === socket.id || session.black?.id === socket.id) {
        emitSessionUpdate(channelId);
        return;
      }

      // Ellenőrizzük az üres helyet
      if (!session.white) {
        session.white = playerObj;
      } else if (!session.black) {
        session.black = playerObj;
      } else {
        // Mindkét hely foglalt, nézőként rögzítjük
        if (!session.spectators.some(s => s.id === socket.id)) {
          session.spectators.push(playerObj);
        }
        emitSessionUpdate(channelId);
        return;
      }

      // Eltávolítjuk a nézők közül, ha ott volt
      session.spectators = session.spectators.filter(s => s.id !== socket.id);

      // Ha mindkét hely betelt, indul a játék!
      if (session.white && session.black && session.status === 'waiting') {
        session.status = 'playing';
      }

      console.log(`[Chess] ${username} csatlakozott a sakkhoz a(z) ${channelId} szobában`);
      emitSessionUpdate(channelId);
    });

    // 3. Lépés végrehajtása
    socket.on('chess:move', ({ channelId, from, to, promotion = 'q' }) => {
      const session = chessSessions.get(channelId);
      if (!session || !session.active || session.status !== 'playing') {
        return socket.emit('chess:error', { message: 'A játék még nem indult el, vagy már véget ért!' });
      }

      const turn = session.chess.turn(); // 'w' vagy 'b'
      const isWhiteTurn = turn === 'w';
      const expectedPlayer = isWhiteTurn ? session.white : session.black;

      // Ellenőrizzük, hogy valóban az a játékos lép-e, akinek a köre van
      if (!expectedPlayer || expectedPlayer.id !== socket.id) {
        return socket.emit('chess:error', { message: 'Nem te vagy a soron következő játékos!' });
      }

      try {
        const moveResult = session.chess.move({
          from,
          to,
          promotion: promotion || 'q'
        });

        if (!moveResult) {
          return socket.emit('chess:error', { message: 'Érvénytelen lépés!' });
        }

        // Lépés rögzítése
        session.lastMove = {
          from: moveResult.from,
          to: moveResult.to,
          san: moveResult.san,
          piece: moveResult.piece,
          color: moveResult.color,
          captured: moveResult.captured || null
        };

        session.history.push({
          san: moveResult.san,
          from: moveResult.from,
          to: moveResult.to,
          color: moveResult.color,
          piece: moveResult.piece,
          captured: moveResult.captured || null,
          fen: session.chess.fen()
        });

        // Játék vége ellenőrzése
        if (session.chess.isCheckmate()) {
          session.status = 'checkmate';
          session.winner = moveResult.color === 'w' ? 'white' : 'black';
          session.reason = 'checkmate';
        } else if (session.chess.isDraw()) {
          session.status = 'draw';
          session.winner = 'draw';
          if (session.chess.isStalemate()) session.reason = 'stalemate';
          else if (session.chess.isThreefoldRepetition()) session.reason = 'threefold';
          else if (session.chess.isInsufficientMaterial()) session.reason = 'insufficient';
          else session.reason = '50-move-rule';
        }

        emitSessionUpdate(channelId);
      } catch (err) {
        console.error('[Chess Move Hiba]:', err);
        socket.emit('chess:error', { message: 'Nem sikerült a lépés: ' + err.message });
      }
    });

    // 4. Feladás (Resign)
    socket.on('chess:resign', ({ channelId }) => {
      const session = chessSessions.get(channelId);
      if (!session || session.status !== 'playing') return;

      if (session.white?.id === socket.id) {
        session.status = 'resigned';
        session.winner = 'black';
        session.reason = 'resignation';
      } else if (session.black?.id === socket.id) {
        session.status = 'resigned';
        session.winner = 'white';
        session.reason = 'resignation';
      } else {
        return; // Néző nem adhatja fel
      }

      console.log(`[Chess] Feladás a(z) ${channelId} szobában, nyertes: ${session.winner}`);
      emitSessionUpdate(channelId);
    });

    // 5. Új meccs (Visszavágó / Rematch)
    socket.on('chess:rematch', ({ channelId }) => {
      const session = chessSessions.get(channelId);
      if (!session) return;
      const user = users.get(socket.id);

      // Új üres sakktábla inicializálása
      session.chess = new Chess();
      session.history = [];
      session.lastMove = null;
      session.winner = null;
      session.reason = null;

      // Színek megcserélése a visszavágóhoz!
      const oldWhite = session.white;
      session.white = session.black;
      session.black = oldWhite;

      session.status = (session.white && session.black) ? 'playing' : 'waiting';

      console.log(`[Chess] Új mérkőzés indítva a(z) ${channelId} szobában (${user?.username})`);
      emitSessionUpdate(channelId);
    });

    // 6. Szoba bezárása / Session leállítása
    socket.on('chess:stop', ({ channelId }) => {
      if (!channelId) return;
      chessSessions.delete(channelId);
      io.to(channelId).emit('chess:state', null);
      io.emit('chess:session-updated', { channelId, state: null });
      console.log(`[Chess] Sakk parti leállítva a(z) ${channelId} szobában`);
    });

    // 7. Felhasználó kilép a szobából vagy disconnectel
    socket.on('disconnect', () => {
      for (const [channelId, session] of chessSessions.entries()) {
        let changed = false;
        if (session.white?.id === socket.id) {
          session.white = null;
          if (session.status === 'playing') {
            session.status = 'waiting';
          }
          changed = true;
        }
        if (session.black?.id === socket.id) {
          session.black = null;
          if (session.status === 'playing') {
            session.status = 'waiting';
          }
          changed = true;
        }
        const specIndex = session.spectators.findIndex(s => s.id === socket.id);
        if (specIndex !== -1) {
          session.spectators.splice(specIndex, 1);
          changed = true;
        }

        // Ha mindkét játékos kilépett és nincs néző sem, bezárjuk a partit
        if (!session.white && !session.black && session.spectators.length === 0) {
          chessSessions.delete(channelId);
          io.emit('chess:session-updated', { channelId, state: null });
        } else if (changed) {
          emitSessionUpdate(channelId);
        }
      }
    });
  });

  return {
    getChessSessions: () => {
      const result = {};
      for (const [channelId, session] of chessSessions.entries()) {
        result[channelId] = sanitizeSession(session);
      }
      return result;
    },
    getChessSession: (channelId) => sanitizeSession(chessSessions.get(channelId))
  };
};
