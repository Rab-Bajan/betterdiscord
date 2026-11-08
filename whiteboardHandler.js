// Közös rajztáblák (szobánként, memóriában)
const { users } = require('./state');

const MAX_STROKES = 10000;

module.exports = function setupWhiteboard(io) {
  const channelWhiteboards = new Map(); // channelId -> Map<boardId, board>

  const summarize = (b) => ({
    id: b.id,
    title: b.title,
    creatorId: b.creatorId,
    creatorName: b.creatorName,
    createdAt: b.createdAt,
    strokeCount: b.strokes.length
  });

  function getBoardList(channelId) {
    const boards = channelWhiteboards.get(channelId);
    return boards ? Array.from(boards.values()).map(summarize) : [];
  }

  io.on('connection', (socket) => {
    // Csak a szobában lévő felhasználó módosíthat; visszaadja a felhasználót és a táblát
    const resolve = (channelId, boardId) => {
      const user = users.get(socket.id);
      if (!user || user.voiceChannel !== channelId) return {};
      return { user, board: channelWhiteboards.get(channelId)?.get(boardId) };
    };

    socket.on('whiteboard:create', ({ channelId, title } = {}) => {
      const user = users.get(socket.id);
      if (!user || user.voiceChannel !== channelId) return;

      if (!channelWhiteboards.has(channelId)) channelWhiteboards.set(channelId, new Map());
      const board = {
        id: `board_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        title: String(title || `${user.username} Rajztáblája`).trim(),
        creatorId: user.id,
        creatorName: user.username,
        strokes: [],
        createdAt: Date.now()
      };
      channelWhiteboards.get(channelId).set(board.id, board);

      io.to(channelId).emit('whiteboard:list', getBoardList(channelId));
      io.to(channelId).emit('whiteboard:created', { board: summarize(board) });
      console.log(`[Whiteboard] Új tábla a(z) ${channelId} szobában: "${board.title}" (${user.username})`);
    });

    socket.on('whiteboard:get', ({ channelId, boardId } = {}) => {
      const board = channelWhiteboards.get(channelId)?.get(boardId);
      if (board) {
        socket.emit('whiteboard:data', { boardId, title: board.title, strokes: board.strokes });
      }
    });

    socket.on('whiteboard:draw', ({ channelId, boardId, stroke } = {}) => {
      const { user, board } = resolve(channelId, boardId);
      if (!board) return;
      board.strokes.push(stroke);
      if (board.strokes.length > MAX_STROKES) board.strokes.shift();
      socket.to(channelId).emit('whiteboard:stroke', {
        boardId,
        stroke,
        senderId: socket.id,
        senderName: user.username
      });
    });

    socket.on('whiteboard:clear', ({ channelId, boardId } = {}) => {
      const { user, board } = resolve(channelId, boardId);
      if (!board) return;
      board.strokes = [];
      io.to(channelId).emit('whiteboard:cleared', { boardId, clearedBy: user.username });
      console.log(`[Whiteboard] Tábla letisztítva: ${boardId} (${user.username})`);
    });

    socket.on('whiteboard:delete', ({ channelId, boardId } = {}) => {
      const { user, board } = resolve(channelId, boardId);
      if (!board) return;
      channelWhiteboards.get(channelId).delete(boardId);
      io.to(channelId).emit('whiteboard:deleted', { boardId });
      io.to(channelId).emit('whiteboard:list', getBoardList(channelId));
      console.log(`[Whiteboard] Tábla törölve: ${boardId} (${user.username})`);
    });
  });

  return { getBoardList };
};
