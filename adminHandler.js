// Admin eszközök (kaszinó és sakk). Minden eseményt a szerver ellenőriz: csak hitelesített,
// admin jogú munkamenet használhatja, és minden művelet bekerül a szerver naplójába.
const { users } = require('./state');
const db = require('./database');

const CONTEXT_SIZE = 10; // ennyi üzenet előtte/utána látszik a jelentett üzenet körül

module.exports = function setupAdmin(io, { casino, chess, dm }) {
  io.on('connection', (socket) => {
    // Ack-es admin esemény: jogosultság ellenőrzés + hibakezelés + naplózás
    function adminAction(event, handler) {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const me = users.get(socket.id);
        if (!me || me.isAdmin !== true) {
          return reply({ ok: false, error: 'Nincs jogosultságod ehhez.' });
        }
        try {
          const result = handler(payload || {}, me);
          if (event !== 'admin:casino-list' && event !== 'admin:dm-reports') {
            console.log(`[Admin] ${me.username}: ${event} ${JSON.stringify(payload || {})}`);
          }
          reply({ ok: true, ...result });
        } catch (err) {
          reply({ ok: false, error: err.message || 'A művelet sikertelen.' });
        }
      });
    }

    // --- Kaszinó ---
    adminAction('admin:casino-list', () => ({ players: casino.admin.listAccounts() }));

    adminAction('admin:casino-set-balance', ({ playerId, balance, freeSpins }) =>
      casino.admin.setBalance(String(playerId), balance, freeSpins));

    adminAction('admin:casino-set-rig', ({ playerId, rig }) =>
      casino.admin.setRig(String(playerId), rig));

    // --- DM moderáció ---
    // Az admin kizárólag olyan beszélgetésekhez fér hozzá, amelyekben egy résztvevő jelentett egy üzenetet,
    // és csak a jelentett üzenet környékéhez. Minden megnyitás és eltávolítás naplózódik.
    const reportContext = (report) => {
      const msg = db.getDmMessageById(report.message_id);
      if (!msg) throw new Error('A jelentett üzenet már nem létezik.');
      return { msg, messages: db.getDmContext(report.dm_key, msg.createdAt, CONTEXT_SIZE, CONTEXT_SIZE) };
    };
    const getReport = (reportId) => {
      const report = db.getDmReport(String(reportId));
      if (!report) throw new Error('Ismeretlen jelentés.');
      return report;
    };

    adminAction('admin:dm-reports', () => ({
      reports: db.listDmReports('open').map((r) => {
        const msg = db.getDmMessageById(r.message_id);
        return {
          id: r.id,
          reporter: r.reporter_username,
          reportedUser: msg?.senderUsername || '?',
          reason: r.reason,
          createdAt: r.created_at
        };
      })
    }));

    adminAction('admin:dm-report-context', ({ reportId }) => {
      const report = getReport(reportId);
      const { msg, messages } = reportContext(report);
      return {
        report: { id: report.id, reporter: report.reporter_username, reason: report.reason, status: report.status, reportedMessageId: msg.id },
        messages
      };
    });

    adminAction('admin:dm-remove-message', ({ reportId, messageId }) => {
      const report = getReport(reportId);
      if (report.status !== 'open') throw new Error('Ez a jelentés már le van zárva.');
      const { messages } = reportContext(report);
      if (!messages.some((m) => m.id === messageId)) {
        throw new Error('Csak a jelentett üzenet környezetében lévő üzenet távolítható el.');
      }
      db.removeDmMessage(messageId);
      dm.notifyMessageRemoved(report.dm_key, messageId);
      return { removed: messageId };
    });

    adminAction('admin:dm-resolve', ({ reportId, resolution }, me) => {
      const report = getReport(reportId);
      const done = db.resolveDmReport(report.id, me.username, String(resolution || '').slice(0, 200));
      if (!done) throw new Error('Ez a jelentés már le van zárva.');
      return {};
    });

    // --- Sakk ---
    adminAction('admin:chess-force-move', ({ channelId, from, to, switchTurn }) =>
      chess.admin.forceMove(channelId, from, to, switchTurn !== false));

    adminAction('admin:chess-put', ({ channelId, square, piece }) =>
      chess.admin.putPiece(channelId, square, piece ?? null));

    adminAction('admin:chess-set-turn', ({ channelId, turn }) =>
      chess.admin.setTurn(channelId, turn));
  });
};
