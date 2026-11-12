import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CasinoService } from '../../../src/modules/casino/CasinoService.ts';
import { createDeck, handValue, pokerCategory } from '../../../src/modules/casino/cards.ts';
import { normalizeRig } from '../../../src/modules/casino/SlotMachine.ts';
import type { Card, Rank, Suit } from '../../../src/modules/casino/types.ts';

const card = (rank: Rank, suit: Suit = '♠'): Card => ({ rank, suit });
/** randomInt that always answers 0: no shuffle swaps beyond index 0, every reel lands on 🍒. */
const zero = (): number => 0;
const PLAYER = 'player-0123456789abcdef';

const setup = (randomInt = zero) => {
  const pushes: Array<[readonly string[], unknown]> = [];
  let t = 10_000;
  const casino = new CasinoService({ randomInt, onWalletChanged: (ids, w) => { pushes.push([ids, w]); }, now: () => t });
  return { casino, pushes, advance: (ms: number) => { t += ms; } };
};

test('handValue counts aces soft while the hand would bust', () => {
  assert.equal(handValue([card('A'), card('K')]), 21);
  assert.equal(handValue([card('A'), card('A'), card('9')]), 21);
  assert.equal(handValue([card('K'), card('Q'), card('5')]), 25);
});

test('pokerCategory recognises every payout class', () => {
  const hand = (...cards: Array<[Rank, Suit]>): Card[] => cards.map(([r, s]) => card(r, s));
  assert.equal(pokerCategory(hand(['10', '♥'], ['J', '♥'], ['Q', '♥'], ['K', '♥'], ['A', '♥'])), 'royal');
  assert.equal(pokerCategory(hand(['2', '♥'], ['3', '♥'], ['4', '♥'], ['5', '♥'], ['A', '♥'])), 'straightFlush');
  assert.equal(pokerCategory(hand(['9', '♥'], ['9', '♠'], ['9', '♦'], ['9', '♣'], ['A', '♥'])), 'four');
  assert.equal(pokerCategory(hand(['9', '♥'], ['9', '♠'], ['9', '♦'], ['2', '♣'], ['2', '♥'])), 'fullHouse');
  assert.equal(pokerCategory(hand(['2', '♥'], ['7', '♥'], ['9', '♥'], ['J', '♥'], ['K', '♥'])), 'flush');
  assert.equal(pokerCategory(hand(['6', '♥'], ['7', '♠'], ['8', '♥'], ['9', '♥'], ['10', '♥'])), 'straight');
  assert.equal(pokerCategory(hand(['9', '♥'], ['9', '♠'], ['9', '♦'], ['2', '♣'], ['3', '♥'])), 'three');
  assert.equal(pokerCategory(hand(['9', '♥'], ['9', '♠'], ['3', '♦'], ['3', '♣'], ['K', '♥'])), 'twoPair');
  assert.equal(pokerCategory(hand(['Q', '♥'], ['Q', '♠'], ['3', '♦'], ['5', '♣'], ['K', '♥'])), 'jacks');
  assert.equal(pokerCategory(hand(['4', '♥'], ['4', '♠'], ['3', '♦'], ['5', '♣'], ['K', '♥'])), 'pair');
  assert.equal(pokerCategory(hand(['2', '♥'], ['4', '♠'], ['6', '♦'], ['8', '♣'], ['K', '♥'])), 'nothing');
});

test('createDeck: 52 distinct cards', () => {
  const deck = createDeck((max) => Math.floor(Math.random() * max));
  assert.equal(new Set(deck.map((c) => c.rank + c.suit)).size, 52);
});

test('normalizeRig: modes, spins clamp and invalid input', () => {
  assert.equal(normalizeRig(null), null);
  assert.deepEqual(normalizeRig({ mode: 'jackpot', symbols: ['✨'], spins: 0 }), { mode: 'jackpot', symbols: ['⭐'], spins: 1 });
  assert.deepEqual(normalizeRig({ mode: 'lose', spins: 5000 }), { mode: 'lose', spins: 1000 });
  assert.throws(() => normalizeRig({ mode: 'symbols', symbols: ['🍒', '🍒'] }), /Érvénytelen pörgetés-beállítás/);
  assert.throws(() => normalizeRig({ mode: 'chaos' }), /Érvénytelen pörgetés-beállítás/);
});

test('lobby: player id validation, sanitised name, spawn slots, leave', () => {
  const { casino } = setup();
  assert.throws(() => casino.join('s1', 'short', 'x', 'r'), /Érvénytelen játékosazonosító/);
  const first = casino.join('s1', PLAYER, ' <b>Ann</b> ', ' r ');
  assert.equal(first.player.name, 'bAnn/b');
  assert.equal(first.player.channelId, 'r');
  assert.deepEqual(first.others, []);
  const second = casino.join('s2', 'other-player-00000001', '', undefined);
  assert.equal(second.player.channelId, 'default');
  const third = casino.join('s3', 'third-player-00000001', 'C', 'r');
  assert.deepEqual([third.player.x, third.player.z], [-2.5, 13.5]);
  assert.equal(casino.lobbyCount('r'), 2);
  assert.equal(casino.leave('s1'), 'r');
  assert.equal(casino.leave('s1'), null);
});

test('move: throttled and limited in distance; chat throttled and sanitised', () => {
  const { casino, advance } = setup();
  casino.join('s1', PLAYER, 'A', 'r');
  assert.equal(casino.move('s1', { x: 30, z: 13.5, yaw: 0 }), null);
  assert.deepEqual(casino.move('s1', { x: 1, z: 14, yaw: 0 }), { id: 's1', name: 'A', x: 1, z: 14, yaw: 0 });
  assert.equal(casino.move('s1', { x: 1.5, z: 14, yaw: 0 }), null);
  advance(100);
  assert.equal(casino.move('s1', { x: 1.5, z: 14, yaw: Number.NaN }), null);
  assert.throws(() => casino.chat('s1', '  '), /nem lehet üres/);
  assert.equal(casino.chat('s1', ' hi <i> ').message.text, 'hi i');
  assert.throws(() => casino.chat('s1', 'again'), /Várj egy pillanatot/);
  assert.throws(() => casino.chat('nobody', 'x'), /Csatlakozz a kaszinóhoz/);
});

test('slot: bets, free spins and rigged outcomes', () => {
  const { casino } = setup();
  casino.join('s1', PLAYER, 'A', 'r');
  const { account } = casino.walletOf('s1');
  assert.throws(() => casino.slot(account, 15), /Érvénytelen tét/);
  assert.deepEqual(casino.slot(account, 10), { result: ['🍒', '🍒', '🍒'], winnings: 50, message: 'JACKPOT! 50 kredit nyeremény.', balance: 1040, freeSpins: 0 });
  casino.admin.setRig(PLAYER, { mode: 'bonus' });
  assert.equal(casino.slot(account, 10).freeSpins, 5);
  casino.admin.setRig(PLAYER, { mode: 'lose' });
  assert.deepEqual(casino.slot(account, 100), { result: ['🍒', '🍋', '🍇'], winnings: 0, message: 'Most nem nyertél. Próbáld újra!', balance: 1030, freeSpins: 4 });
  assert.throws(() => casino.walletOf('nobody'), /Előbb csatlakozz/);
});

test('blackjack: deal, hit, stand settle and pay; one round at a time', () => {
  const { casino } = setup();
  casino.join('s1', PLAYER, 'A', 'r');
  const { playerId, account } = casino.walletOf('s1');
  // randomInt = 0 gives a fixed deck: player 2♠ A♣, dealer K♣ + hidden Q♣, then J♣, 10♣...
  assert.deepEqual(casino.blackjackStart(playerId, account, 10), {
    player: [card('2'), card('A', '♣')], dealer: [card('K', '♣'), null], playerTotal: 13, balance: 990, active: true
  });
  assert.throws(() => casino.blackjackStart(playerId, account, 10), /folyamatban/);
  assert.equal(casino.blackjackHit(playerId, account).playerTotal, 13);
  const settled = casino.blackjackStand(playerId, account);
  assert.equal(settled.active, false);
  assert.equal(settled.dealerTotal, 20);
  assert.equal(settled.outcome, 'lose');
  assert.equal(settled.balance, 990);
  assert.throws(() => casino.blackjackHit(playerId, account), /Nincs aktív/);
});

test('poker: deal then draw keeps held cards; disconnect refunds open bets', () => {
  const { casino } = setup();
  casino.join('s1', PLAYER, 'A', 'r');
  const { playerId, account } = casino.walletOf('s1');
  const dealt = casino.pokerDeal(playerId, account, 20);
  assert.equal(dealt.balance, 980);
  assert.throws(() => casino.pokerDeal(playerId, account, 20), /fejezd be/);
  const drawn = casino.pokerDraw(playerId, account, [0, 4, 9, 'x']);
  assert.equal(drawn.hand[0], dealt.hand[0]);
  assert.equal(drawn.hand[4], dealt.hand[4]);
  assert.equal(drawn.balance, 980 + drawn.winnings);
  casino.pokerDeal(playerId, account, 30);
  const before = account.balance;
  casino.leave('s1');
  assert.equal(account.balance, before + 30);
});

test('admin: list, set balance (pushed to lobby sockets), unknown players', () => {
  const { casino, pushes } = setup();
  casino.join('s1', PLAYER, 'A', 'r');
  assert.deepEqual(casino.admin.listAccounts(), [{ playerId: PLAYER, name: 'A', online: true, balance: 1000, freeSpins: 0, rig: null }]);
  assert.throws(() => casino.admin.setBalance('nincs', 1, 1), /Ismeretlen játékos/);
  assert.throws(() => casino.admin.setBalance(PLAYER, -1, undefined), /Érvénytelen egyenleg/);
  assert.throws(() => casino.admin.setBalance(PLAYER, undefined, 0.5), /ingyenes pörgetésszám/);
  assert.deepEqual(casino.admin.setBalance(PLAYER, 5, 2), { balance: 5, freeSpins: 2 });
  assert.deepEqual(pushes, [[['s1'], { balance: 5, freeSpins: 2 }]]);
});

test('voice-channel sessions', () => {
  const { casino } = setup();
  casino.startSession('r', 'Ann');
  assert.deepEqual(casino.getSessions(), { r: { active: true, channelId: 'r', startedBy: 'Ann', startedAt: 10_000 } });
  casino.stopSession('r');
  assert.deepEqual(casino.getSessions(), {});
});
