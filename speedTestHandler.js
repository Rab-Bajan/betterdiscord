// Sebességteszt: ping, eredménymentés, kérés másik felhasználótól
const { users, broadcastPresence } = require('./state');

module.exports = function setupSpeedTest(io) {
  io.on('connection', (socket) => {
    socket.on('speedtest:ping', ({ clientTime } = {}) => {
      socket.emit('speedtest:pong', { clientTime, serverTime: Date.now() });
    });

    socket.on('speedtest:save-result', (result = {}) => {
      const user = users.get(socket.id);
      if (!user) return;

      user.speedTest = {
        ping: Math.round(result.ping || 0),
        download: Number((result.download || 0).toFixed(1)),
        upload: Number((result.upload || 0).toFixed(1)),
        jitter: Math.round(result.jitter || 0),
        testedAt: Date.now()
      };

      broadcastPresence(io);
      io.emit('speedtest:result-announced', {
        userId: user.id,
        username: user.username,
        avatarColor: user.avatarColor,
        result: user.speedTest
      });
      console.log(`[SpeedTest] ${user.username}: Ping ${user.speedTest.ping}ms, DL ${user.speedTest.download} Mbps, UL ${user.speedTest.upload} Mbps`);
    });

    socket.on('speedtest:request-user', ({ targetUserId } = {}) => {
      const sender = users.get(socket.id);
      const target = users.get(targetUserId);
      if (!sender || !target) return;
      io.to(targetUserId).emit('speedtest:requested-by', {
        requesterId: sender.id,
        requesterName: sender.username
      });
      console.log(`[SpeedTest] ${sender.username} sebességtesztet kért ${target.username}-től`);
    });
  });
};
