const crypto = require('crypto');
const path = require('path');
const express = require('express');

module.exports = function setupCasino(io, app, casinoDir) {
  // 1. Kaszinó weboldal kiszolgálása
  app.use('/casino', express.static(casinoDir));
  app.get('/casino', (req, res) => {
    res.sendFile('index.html', { root: casinoDir });
  });

  // Állapotok
  // Csatornánkénti kaszinó sessionök: channelId -> { active: boolean, startedBy: string, startedAt: number }
  const casinoSessions = new Map();

  const accounts = new Map(); // playerId -> { balance: 1000, freeSpins: 0 }
  const onlinePlayers = new Map(); // socket.id -> player
  const blackjackRounds = new Map(); // playerId -> round
  const pokerRounds = new Map(); // playerId -> round

  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const slotSymbols = [
    { emoji: '🍒', weight: 30, multiplier: 5 },
    { emoji: '🍋', weight: 25, multiplier: 4 },
    { emoji: '🍇', weight: 20, multiplier: 6 },
    { emoji: '💎', weight: 13, multiplier: 10 },
    { emoji: '⭐', weight: 8, multiplier: 15 },
    { emoji: '✨', weight: 4, multiplier: 0 }
  ];

  const pokerMultipliers = {
    royal: 250,
    straightFlush: 50,
    four: 25,
    fullHouse: 9,
    flush: 6,
    straight: 4,
    three: 3,
    twoPair: 2,
    jacks: 1,
    pair: 0,
    nothing: 0
  };

  function getAccount(id) {
    let account = accounts.get(id);
    if (!account) {
      account = { balance: 1000, freeSpins: 0 };
      accounts.set(id, account);
    }
    return account;
  }

  function isValidBet(bet, account) {
    return Number.isSafeInteger(bet) && bet >= 10 && bet <= 100 && bet % 10 === 0 && bet <= account.balance;
  }

  function fail(message) {
    const error = new Error(message);
    error.isClientError = true;
    return error;
  }

  function respond(ack, handler) {
    if (typeof ack !== 'function') return;
    try {
      ack({ ok: true, ...handler() });
    } catch (error) {
      if (!error.isClientError) console.error('Casino action failed:', error);
      ack({ ok: false, error: error.isClientError ? error.message : 'A játék művelete sikertelen.' });
    }
  }

  function emitBalance(socket, account) {
    socket.emit('wallet:balance', {
      balance: account.balance,
      freeSpins: account.freeSpins
    });
  }

  function lobbySnapshot(channelId) {
    return [...onlinePlayers.values()]
      .filter((p) => p.channelId === channelId)
      .map((player) => ({
        id: player.id,
        name: player.name,
        x: player.x,
        z: player.z,
        yaw: player.yaw
      }));
  }

  function sendLobbySnapshot(channelId) {
    io.to(`casino:${channelId}`).emit('lobby:players', lobbySnapshot(channelId));
    const count = [...onlinePlayers.values()].filter((p) => p.channelId === channelId).length;
    io.to(`casino:${channelId}`).emit('lobby:count', count);
  }

  function createDeck() {
    const deck = suits.flatMap((suit) => ranks.map((rank) => ({ rank, suit })));
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const swapIndex = crypto.randomInt(index + 1);
      [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
    }
    return deck;
  }

  function drawCard(deck) {
    if (deck.length === 0) throw fail('Elfogyott a pakli.');
    return deck.pop();
  }

  function cardValue(card) {
    if (card.rank === 'A') return 11;
    if (['J', 'Q', 'K'].includes(card.rank)) return 10;
    return Number(card.rank);
  }

  function handValue(hand) {
    let total = hand.reduce((sum, card) => sum + cardValue(card), 0);
    let aces = hand.filter((card) => card.rank === 'A').length;
    while (total > 21 && aces > 0) {
      total -= 10;
      aces -= 1;
    }
    return total;
  }

  function pokerCategory(hand) {
    const counts = {};
    const values = hand.map((card) => (card.rank === 'A' ? 14 : ranks.indexOf(card.rank) + 2)).sort((a, b) => a - b);
    hand.forEach((card) => { counts[card.rank] = (counts[card.rank] || 0) + 1; });
    const groups = Object.values(counts).sort((a, b) => b - a);
    const flush = hand.every((card) => card.suit === hand[0].suit);
    const unique = [...new Set(values)];
    const straight = unique.length === 5 && (unique[4] - unique[0] === 4 || unique.join(',') === '2,3,4,5,14');

    if (flush && straight && values[0] === 10) return 'royal';
    if (flush && straight) return 'straightFlush';
    if (groups[0] === 4) return 'four';
    if (groups[0] === 3 && groups[1] === 2) return 'fullHouse';
    if (flush) return 'flush';
    if (straight) return 'straight';
    if (groups[0] === 3) return 'three';
    if (groups[0] === 2 && groups[1] === 2) return 'twoPair';
    if (groups[0] === 2) {
      const pairRank = Object.keys(counts).find((rank) => counts[rank] === 2);
      return pairRank === 'A' || ['J', 'Q', 'K'].includes(pairRank) ? 'jacks' : 'pair';
    }
    return 'nothing';
  }

  function settleBlackjack(account, round, outcome) {
    let payout = 0;
    if (outcome === 'win') payout = round.bet * 2;
    if (outcome === 'blackjack') payout = Math.floor(round.bet * 2.5);
    if (outcome === 'push') payout = round.bet;
    account.balance += payout;
    blackjackRounds.delete(round.id);
    return {
      outcome,
      payout,
      balance: account.balance,
      player: round.player,
      dealer: round.dealer,
      playerTotal: handValue(round.player),
      dealerTotal: handValue(round.dealer),
      active: false
    };
  }

  function handleSocketEvent(socket, name, handler) {
    socket.on(name, (payload, ack) => {
      respond(ack, () => {
        if (!socket.data.playerId) throw fail('Előbb csatlakozz a kaszinóhoz.');
        return handler(socket, getAccount(socket.data.playerId), payload || {});
      });
    });
  }

  // Socket kezelők
  io.on('connection', (socket) => {
    // Session indítása / leállítása a hangcsatornában
    socket.on('casino:start-session', ({ channelId, username }) => {
      if (!channelId) return;
      const session = {
        active: true,
        channelId,
        startedBy: username || 'Felhasználó',
        startedAt: Date.now()
      };
      casinoSessions.set(channelId, session);
      io.emit('casino:session-updated', { channelId, session });
      console.log(`[Casino] Új kaszinó indítva a(z) ${channelId} szobában (${session.startedBy})`);
    });

    socket.on('casino:stop-session', ({ channelId }) => {
      if (!channelId) return;
      casinoSessions.delete(channelId);
      io.emit('casino:session-updated', { channelId, session: null });
      console.log(`[Casino] Kaszinó leállítva a(z) ${channelId} szobában`);
    });

    // Csatlakozás a kaszinó 3D világához
    socket.on('lobby:join', (payload, ack) => {
      respond(ack, () => {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        if (!/^[a-zA-Z0-9-]{16,64}$/.test(id)) throw fail('Érvénytelen játékosazonosító.');
        const name = String(payload.name || 'Vendég').replace(/[<>]/g, '').trim().slice(0, 20) || 'Vendég';
        const channelId = String(payload.channelId || 'default').trim();

        const account = getAccount(id);
        socket.data.playerId = id;
        socket.data.name = name;
        socket.data.channelId = channelId;

        socket.join(`casino:${channelId}`);

        const channelPlayers = [...onlinePlayers.values()].filter(p => p.channelId === channelId);
        const spawnXs = [0, -2.5, 2.5, -5, 5, -7.5, 7.5, -10, 10];
        const spawnIndex = channelPlayers.length;
        const spawnX = spawnXs[spawnIndex % spawnXs.length];
        const spawnZ = Math.min(20, 13.5 + Math.floor(spawnIndex / spawnXs.length) * 2.5);

        const player = {
          id: socket.id,
          channelId,
          accountId: id,
          name,
          x: spawnX,
          z: spawnZ,
          yaw: 0,
          lastMove: 0,
          lastChat: 0
        };

        onlinePlayers.set(socket.id, player);
        socket.emit('lobby:players', lobbySnapshot(channelId).filter((online) => online.id !== socket.id));
        emitBalance(socket, account);
        sendLobbySnapshot(channelId);

        return { id: socket.id, name, x: spawnX, z: spawnZ, balance: account.balance, freeSpins: account.freeSpins };
      });
    });

    socket.on('player:move', (position) => {
      const player = onlinePlayers.get(socket.id);
      if (!player || !position) return;
      const now = Date.now();
      if (now - player.lastMove < 45) return;
      const { x, z, yaw } = position;
      if (![x, z, yaw].every(Number.isFinite)) return;
      const nextX = Math.max(-21.2, Math.min(21.2, x));
      const nextZ = Math.max(-24, Math.min(23, z));
      const elapsed = player.lastMove ? (now - player.lastMove) / 1000 : 1;
      if (Math.hypot(nextX - player.x, nextZ - player.z) > Math.max(1.2, elapsed * 10)) return;

      player.x = nextX;
      player.z = nextZ;
      player.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
      player.lastMove = now;

      socket.to(`casino:${player.channelId}`).emit('player:moved', {
        id: socket.id,
        name: player.name,
        x: player.x,
        z: player.z,
        yaw: player.yaw
      });
    });

    socket.on('chat:send', (text, ack) => {
      respond(ack, () => {
        const player = onlinePlayers.get(socket.id);
        if (!player) throw fail('Csatlakozz a kaszinóhoz az üzenetküldéshez.');
        const now = Date.now();
        if (now - player.lastChat < 650) throw fail('Várj egy pillanatot az új üzenet előtt.');
        const message = typeof text === 'string' ? text.replace(/[<>]/g, '').trim().slice(0, 160) : '';
        if (!message) throw fail('Az üzenet nem lehet üres.');
        player.lastChat = now;
        io.to(`casino:${player.channelId}`).emit('chat:message', { name: player.name, text: message, timestamp: now });
        return {};
      });
    });

    handleSocketEvent(socket, 'casino:slot', (_currentSocket, account, payload) => {
      const bet = payload.bet;
      const freeSpin = account.freeSpins > 0;
      const validSpinBet = Number.isSafeInteger(bet) && bet >= 10 && bet <= 100 && bet % 10 === 0;
      if (!validSpinBet || (!freeSpin && bet > account.balance)) throw fail('Érvénytelen tét vagy kevés kredit.');
      if (freeSpin) account.freeSpins -= 1;
      else account.balance -= bet;

      let selection;
      const result = Array.from({ length: 3 }, () => {
        selection = crypto.randomInt(100);
        for (const symbol of slotSymbols) {
          selection -= symbol.weight;
          if (selection < 0) return symbol.emoji;
        }
        return slotSymbols[0].emoji;
      });
      const bonusCount = result.filter((symbol) => symbol === '✨').length;
      let winnings = 0;
      let message = 'Most nem nyertél. Próbáld újra!';
      if (bonusCount === 3) {
        account.freeSpins += 5;
        message = 'BÓNUSZ! 5 ingyenes pörgetést nyertél!';
      } else if (result[0] === result[1] && result[1] === result[2]) {
        winnings = bet * slotSymbols.find((symbol) => symbol.emoji === result[0]).multiplier;
        message = `JACKPOT! ${winnings} kredit nyeremény.`;
      } else if (bonusCount === 2) {
        winnings = bet * 2;
        message = `Két ✨! +${winnings} kredit.`;
      }
      account.balance += winnings;
      return { result, winnings, message, balance: account.balance, freeSpins: account.freeSpins };
    });

    handleSocketEvent(socket, 'blackjack:start', (_currentSocket, account, payload) => {
      if (blackjackRounds.has(socket.data.playerId)) throw fail('Már van folyamatban lévő leosztás.');
      const bet = payload.bet;
      if (!isValidBet(bet, account)) throw fail('Érvénytelen tét vagy kevés kredit.');
      account.balance -= bet;
      const deck = createDeck();
      const round = {
        id: socket.data.playerId,
        bet,
        deck,
        player: [drawCard(deck), drawCard(deck)],
        dealer: [drawCard(deck), drawCard(deck)]
      };
      blackjackRounds.set(round.id, round);
      if (handValue(round.player) === 21) {
        const outcome = handValue(round.dealer) === 21 ? 'push' : 'blackjack';
        const settled = settleBlackjack(account, round, outcome);
        return { ...settled, balance: account.balance };
      }
      return {
        player: round.player,
        dealer: [round.dealer[0], null],
        playerTotal: handValue(round.player),
        balance: account.balance,
        active: true
      };
    });

    handleSocketEvent(socket, 'blackjack:hit', (_currentSocket, account) => {
      const round = blackjackRounds.get(socket.data.playerId);
      if (!round) throw fail('Nincs aktív blackjack-leosztás.');
      round.player.push(drawCard(round.deck));
      if (handValue(round.player) > 21) return settleBlackjack(account, round, 'lose');
      return {
        player: round.player,
        dealer: [round.dealer[0], null],
        playerTotal: handValue(round.player),
        balance: account.balance,
        active: true
      };
    });

    handleSocketEvent(socket, 'blackjack:stand', (_currentSocket, account) => {
      const round = blackjackRounds.get(socket.data.playerId);
      if (!round) throw fail('Nincs aktív blackjack-leosztás.');
      while (handValue(round.dealer) < 17) round.dealer.push(drawCard(round.deck));
      const playerTotal = handValue(round.player);
      const dealerTotal = handValue(round.dealer);
      const outcome = playerTotal > 21 ? 'lose' :
        dealerTotal > 21 || playerTotal > dealerTotal ? 'win' :
          playerTotal === dealerTotal ? 'push' : 'lose';
      return settleBlackjack(account, round, outcome);
    });

    handleSocketEvent(socket, 'poker:deal', (_currentSocket, account, payload) => {
      if (pokerRounds.has(socket.data.playerId)) throw fail('Előbb fejezd be a jelenlegi pókerkört.');
      const bet = payload.bet;
      if (!isValidBet(bet, account)) throw fail('Érvénytelen tét vagy kevés kredit.');
      account.balance -= bet;
      const deck = createDeck();
      const hand = Array.from({ length: 5 }, () => drawCard(deck));
      pokerRounds.set(socket.data.playerId, { bet, hand, deck });
      return { hand, balance: account.balance };
    });

    handleSocketEvent(socket, 'poker:draw', (_currentSocket, account, payload) => {
      const round = pokerRounds.get(socket.data.playerId);
      if (!round) throw fail('Előbb oszd ki a lapokat.');
      const held = Array.isArray(payload.held) ? new Set(payload.held.filter((index) => Number.isInteger(index) && index >= 0 && index <= 4)) : new Set();
      const hand = round.hand.map((card, index) => held.has(index) ? card : drawCard(round.deck));
      const category = pokerCategory(hand);
      const multiplier = pokerMultipliers[category];
      const winnings = round.bet * multiplier;
      account.balance += winnings;
      pokerRounds.delete(socket.data.playerId);
      return { hand, category, multiplier, winnings, balance: account.balance };
    });

    socket.on('disconnect', () => {
      const player = onlinePlayers.get(socket.id);
      if (player) {
        const channelId = player.channelId;
        onlinePlayers.delete(socket.id);
        if (![...onlinePlayers.values()].some((online) => online.accountId === player.accountId)) {
          const account = getAccount(player.accountId);
          const blackjack = blackjackRounds.get(player.accountId);
          const poker = pokerRounds.get(player.accountId);
          if (blackjack) account.balance += blackjack.bet;
          if (poker) account.balance += poker.bet;
          blackjackRounds.delete(player.accountId);
          pokerRounds.delete(player.accountId);
        }
        sendLobbySnapshot(channelId);
      }
    });
  });

  return {
    getCasinoSessions: () => Object.fromEntries(casinoSessions)
  };
};
