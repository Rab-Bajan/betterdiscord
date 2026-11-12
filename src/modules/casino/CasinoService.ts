import { CasinoError } from './CasinoError.ts';
import { createDeck, drawCard, handValue, pokerCategory, POKER_MULTIPLIERS, type PokerCategory } from './cards.ts';
import { normalizeRig, SlotMachine } from './SlotMachine.ts';
import type {
  BlackjackRound, CasinoAccount, CasinoAdminApi, Card, CasinoSession, LobbyPlayer, LobbyPosition, PokerRound, RandomInt, Rig
} from './types.ts';

const START_BALANCE = 1000;
const PLAYER_ID_RE = /^[a-zA-Z0-9-]{16,64}$/;
const SPAWN_XS = [0, -2.5, 2.5, -5, 5, -7.5, 7.5, -10, 10];
const MOVE_INTERVAL_MS = 45;
const CHAT_INTERVAL_MS = 650;
const MAX_ADMIN_AMOUNT = 1_000_000_000;

const isBetAmount = (bet: unknown): bet is number =>
  typeof bet === 'number' && Number.isSafeInteger(bet) && bet >= 10 && bet <= 100 && bet % 10 === 0;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Called after an admin changed a wallet, with the lobby sockets of that player id. */
export type WalletListener = (socketIds: readonly string[], wallet: { balance: number; freeSpins: number }) => void;

export interface CasinoServiceDeps {
  randomInt: RandomInt;
  onWalletChanged: WalletListener;
  now?: () => number;
}

/** Result of `lobby:join`. */
export interface LobbyJoin {
  player: LobbyPlayer;
  account: CasinoAccount;
  /** The other players of the channel, before this one joined. */
  others: LobbyPosition[];
}

export interface BlackjackView {
  player: Card[];
  dealer: Array<Card | null>;
  playerTotal: number;
  balance: number;
  active: true;
}

export interface BlackjackSettlement {
  outcome: 'win' | 'blackjack' | 'push' | 'lose';
  payout: number;
  balance: number;
  player: Card[];
  dealer: Card[];
  playerTotal: number;
  dealerTotal: number;
  active: false;
}

/**
 * The casino (legacy casinoHandler.js): voice-channel sessions, the 3D lobby, in-memory
 * wallets keyed by the client's player id, slots, blackjack and video poker. Invalid
 * actions throw {@link CasinoError} with the Hungarian message for the player.
 */
export class CasinoService {
  readonly #sessions = new Map<string, CasinoSession>();
  readonly #accounts = new Map<string, CasinoAccount>();
  /** socket id -> lobby player */
  readonly #players = new Map<string, LobbyPlayer>();
  /** player id -> round */
  readonly #blackjack = new Map<string, BlackjackRound>();
  readonly #poker = new Map<string, PokerRound>();
  readonly #randomInt: RandomInt;
  readonly #slots: SlotMachine;
  readonly #now: () => number;
  readonly #onWalletChanged: WalletListener;
  /** Admin api (the admin module checks the rights). */
  readonly admin: CasinoAdminApi;

  constructor(deps: CasinoServiceDeps) {
    this.#randomInt = deps.randomInt;
    this.#slots = new SlotMachine(deps.randomInt);
    this.#now = deps.now ?? (() => Date.now());
    this.#onWalletChanged = deps.onWalletChanged;
    this.admin = {
      listAccounts: () => this.#listAccounts(),
      setBalance: (playerId, balance, freeSpins) => this.#setBalance(playerId, balance, freeSpins),
      setRig: (playerId, rig) => this.#setRig(playerId, rig)
    };
  }

  // --- voice-channel sessions ---

  startSession(channelId: string, startedBy: string): CasinoSession {
    const session: CasinoSession = { active: true, channelId, startedBy, startedAt: this.#now() };
    this.#sessions.set(channelId, session);
    return session;
  }

  stopSession(channelId: string): void {
    this.#sessions.delete(channelId);
  }

  getSessions(): Record<string, CasinoSession> {
    return Object.fromEntries(this.#sessions);
  }

  // --- lobby ---

  /** Puts socket `socketId` into the lobby of the payload's channel under the player id it names. */
  join(socketId: string, id: unknown, rawName: unknown, rawChannelId: unknown): LobbyJoin {
    const playerId = typeof id === 'string' ? id : '';
    if (!PLAYER_ID_RE.test(playerId)) throw new CasinoError('Érvénytelen játékosazonosító.');
    const name = String(rawName || 'Vendég').replace(/[<>]/g, '').trim().slice(0, 20) || 'Vendég';
    const channelId = String(rawChannelId || 'default').trim();
    const account = this.#account(playerId);
    const spawnIndex = this.#inChannel(channelId).length;
    const player: LobbyPlayer = {
      id: socketId,
      channelId,
      accountId: playerId,
      name,
      x: SPAWN_XS[spawnIndex % SPAWN_XS.length] ?? 0,
      z: Math.min(20, 13.5 + Math.floor(spawnIndex / SPAWN_XS.length) * 2.5),
      yaw: 0,
      lastMove: 0,
      lastChat: 0
    };
    this.#players.set(socketId, player);
    return { player, account, others: this.lobbySnapshot(channelId).filter((p) => p.id !== socketId) };
  }

  player(socketId: string): LobbyPlayer | undefined {
    return this.#players.get(socketId);
  }

  /** Positions of the channel's lobby players, in join order. */
  lobbySnapshot(channelId: string): LobbyPosition[] {
    return this.#inChannel(channelId).map(({ id, name, x, z, yaw }) => ({ id, name, x, z, yaw }));
  }

  lobbyCount(channelId: string): number {
    return this.#inChannel(channelId).length;
  }

  /**
   * Applies a movement (rate-limited, clamped to the room, no teleporting).
   * Returns the new position, or null when ignored.
   */
  move(socketId: string, position: unknown): LobbyPosition | null {
    const player = this.#players.get(socketId);
    if (!player || !position) return null;
    const now = this.#now();
    if (now - player.lastMove < MOVE_INTERVAL_MS) return null;
    const { x, z, yaw } = position as Record<string, unknown>;
    if (typeof x !== 'number' || typeof z !== 'number' || typeof yaw !== 'number') return null;
    if (![x, z, yaw].every(Number.isFinite)) return null;
    const nextX = clamp(x, -21.2, 21.2);
    const nextZ = clamp(z, -24, 23);
    const elapsed = player.lastMove ? (now - player.lastMove) / 1000 : 1;
    if (Math.hypot(nextX - player.x, nextZ - player.z) > Math.max(1.2, elapsed * 10)) return null;
    player.x = nextX;
    player.z = nextZ;
    player.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    player.lastMove = now;
    return { id: socketId, name: player.name, x: player.x, z: player.z, yaw: player.yaw };
  }

  /** Validates a lobby chat line (rate-limited, tags stripped, max 160). */
  chat(socketId: string, text: unknown): { player: LobbyPlayer; message: { name: string; text: string; timestamp: number } } {
    const player = this.#players.get(socketId);
    if (!player) throw new CasinoError('Csatlakozz a kaszinóhoz az üzenetküldéshez.');
    const now = this.#now();
    if (now - player.lastChat < CHAT_INTERVAL_MS) throw new CasinoError('Várj egy pillanatot az új üzenet előtt.');
    const clean = typeof text === 'string' ? text.replace(/[<>]/g, '').trim().slice(0, 160) : '';
    if (!clean) throw new CasinoError('Az üzenet nem lehet üres.');
    player.lastChat = now;
    return { player, message: { name: player.name, text: clean, timestamp: now } };
  }

  /**
   * Removes the socket from the lobby. When it was the player id's last socket, open
   * blackjack / poker bets are refunded. Returns the channel it left, or null.
   */
  leave(socketId: string): string | null {
    const player = this.#players.get(socketId);
    if (!player) return null;
    this.#players.delete(socketId);
    const playerId = player.accountId;
    if (![...this.#players.values()].some((p) => p.accountId === playerId)) {
      const account = this.#account(playerId);
      account.balance += (this.#blackjack.get(playerId)?.bet ?? 0) + (this.#poker.get(playerId)?.bet ?? 0);
      this.#blackjack.delete(playerId);
      this.#poker.delete(playerId);
    }
    return player.channelId;
  }

  /** Wallet of the socket's lobby player; throws when the socket has not joined. */
  walletOf(socketId: string): { playerId: string; account: CasinoAccount } {
    const playerId = this.#players.get(socketId)?.accountId;
    if (!playerId) throw new CasinoError('Előbb csatlakozz a kaszinóhoz.');
    return { playerId, account: this.#account(playerId) };
  }

  // --- games ---

  slot(account: CasinoAccount, bet: unknown): { result: string[]; winnings: number; message: string; balance: number; freeSpins: number } {
    const freeSpin = account.freeSpins > 0;
    if (!isBetAmount(bet) || (!freeSpin && bet > account.balance)) throw new CasinoError('Érvénytelen tét vagy kevés kredit.');
    if (freeSpin) account.freeSpins -= 1;
    else account.balance -= bet;
    const outcome = this.#slots.spin(account, bet);
    account.freeSpins += outcome.freeSpinsWon;
    account.balance += outcome.winnings;
    return { result: outcome.result, winnings: outcome.winnings, message: outcome.message, balance: account.balance, freeSpins: account.freeSpins };
  }

  blackjackStart(playerId: string, account: CasinoAccount, bet: unknown): BlackjackView | BlackjackSettlement {
    if (this.#blackjack.has(playerId)) throw new CasinoError('Már van folyamatban lévő leosztás.');
    const stake = this.#takeBet(account, bet);
    const deck = createDeck(this.#randomInt);
    const round: BlackjackRound = { id: playerId, bet: stake, deck, player: [drawCard(deck), drawCard(deck)], dealer: [drawCard(deck), drawCard(deck)] };
    this.#blackjack.set(playerId, round);
    if (handValue(round.player) === 21) {
      return this.#settle(account, round, handValue(round.dealer) === 21 ? 'push' : 'blackjack');
    }
    return this.#view(account, round);
  }

  blackjackHit(playerId: string, account: CasinoAccount): BlackjackView | BlackjackSettlement {
    const round = this.#round(playerId);
    round.player.push(drawCard(round.deck));
    return handValue(round.player) > 21 ? this.#settle(account, round, 'lose') : this.#view(account, round);
  }

  blackjackStand(playerId: string, account: CasinoAccount): BlackjackSettlement {
    const round = this.#round(playerId);
    while (handValue(round.dealer) < 17) round.dealer.push(drawCard(round.deck));
    const playerTotal = handValue(round.player);
    const dealerTotal = handValue(round.dealer);
    const outcome = playerTotal > 21 ? 'lose'
      : dealerTotal > 21 || playerTotal > dealerTotal ? 'win'
        : playerTotal === dealerTotal ? 'push' : 'lose';
    return this.#settle(account, round, outcome);
  }

  pokerDeal(playerId: string, account: CasinoAccount, bet: unknown): { hand: Card[]; balance: number } {
    if (this.#poker.has(playerId)) throw new CasinoError('Előbb fejezd be a jelenlegi pókerkört.');
    const stake = this.#takeBet(account, bet);
    const deck = createDeck(this.#randomInt);
    const hand = Array.from({ length: 5 }, () => drawCard(deck));
    this.#poker.set(playerId, { bet: stake, hand, deck });
    return { hand, balance: account.balance };
  }

  /** Replaces every card whose index (0-4) is not in `held`, then pays the hand. */
  pokerDraw(playerId: string, account: CasinoAccount, held: unknown): { hand: Card[]; category: PokerCategory; multiplier: number; winnings: number; balance: number } {
    const round = this.#poker.get(playerId);
    if (!round) throw new CasinoError('Előbb oszd ki a lapokat.');
    const keep = new Set(Array.isArray(held) ? held.filter((i): i is number => Number.isInteger(i) && i >= 0 && i <= 4) : []);
    const hand = round.hand.map((card, index) => (keep.has(index) ? card : drawCard(round.deck)));
    const category = pokerCategory(hand);
    const multiplier = POKER_MULTIPLIERS[category];
    const winnings = round.bet * multiplier;
    account.balance += winnings;
    this.#poker.delete(playerId);
    return { hand, category, multiplier, winnings, balance: account.balance };
  }

  /** Lobby sockets of a player id (for live wallet updates). */
  socketsOfPlayer(playerId: string): string[] {
    return [...this.#players].filter(([, p]) => p.accountId === playerId).map(([socketId]) => socketId);
  }

  #takeBet(account: CasinoAccount, bet: unknown): number {
    if (!isBetAmount(bet) || bet > account.balance) throw new CasinoError('Érvénytelen tét vagy kevés kredit.');
    account.balance -= bet;
    return bet;
  }

  #round(playerId: string): BlackjackRound {
    const round = this.#blackjack.get(playerId);
    if (!round) throw new CasinoError('Nincs aktív blackjack-leosztás.');
    return round;
  }

  #view(account: CasinoAccount, round: BlackjackRound): BlackjackView {
    return { player: round.player, dealer: [round.dealer[0] ?? null, null], playerTotal: handValue(round.player), balance: account.balance, active: true };
  }

  #settle(account: CasinoAccount, round: BlackjackRound, outcome: BlackjackSettlement['outcome']): BlackjackSettlement {
    const payout = outcome === 'win' ? round.bet * 2 : outcome === 'blackjack' ? Math.floor(round.bet * 2.5) : outcome === 'push' ? round.bet : 0;
    account.balance += payout;
    this.#blackjack.delete(round.id);
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

  #account(playerId: string): CasinoAccount {
    let account = this.#accounts.get(playerId);
    if (!account) {
      account = { balance: START_BALANCE, freeSpins: 0 };
      this.#accounts.set(playerId, account);
    }
    return account;
  }

  #inChannel(channelId: string): LobbyPlayer[] {
    return [...this.#players.values()].filter((p) => p.channelId === channelId);
  }

  #listAccounts(): ReturnType<CasinoAdminApi['listAccounts']> {
    const online = new Map<string, LobbyPlayer>();
    for (const p of this.#players.values()) online.set(p.accountId, p);
    return [...this.#accounts].map(([playerId, a]) => ({
      playerId,
      name: online.get(playerId)?.name || null,
      online: online.has(playerId),
      balance: a.balance,
      freeSpins: a.freeSpins,
      rig: a.rig || null
    }));
  }

  #setBalance(playerId: string, balance: unknown, freeSpins: unknown): { balance: number; freeSpins: number } {
    const account = this.#accounts.get(playerId);
    if (!account) throw new CasinoError('Ismeretlen játékos.');
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_ADMIN_AMOUNT;
    if (balance !== undefined) {
      if (!valid(balance)) throw new CasinoError('Érvénytelen egyenleg.');
      account.balance = balance;
    }
    if (freeSpins !== undefined) {
      if (!valid(freeSpins)) throw new CasinoError('Érvénytelen ingyenes pörgetésszám.');
      account.freeSpins = freeSpins;
    }
    this.#onWalletChanged(this.socketsOfPlayer(playerId), { balance: account.balance, freeSpins: account.freeSpins });
    return { balance: account.balance, freeSpins: account.freeSpins };
  }

  #setRig(playerId: string, rig: unknown): { rig: Rig | null } {
    const account = this.#accounts.get(playerId);
    if (!account) throw new CasinoError('Ismeretlen játékos.');
    const normalized = normalizeRig(rig);
    account.rig = normalized;
    return { rig: normalized };
  }
}
