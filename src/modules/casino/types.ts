export type Suit = '♠' | '♥' | '♦' | '♣';
export type Rank = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A';

export interface Card {
  rank: Rank;
  suit: Suit;
}

/** Uniform random integer in `[0, max)` (crypto.randomInt in production). */
export type RandomInt = (max: number) => number;

/** A casino started in a voice channel (shown in the channel UI). */
export interface CasinoSession {
  active: true;
  channelId: string;
  startedBy: string;
  startedAt: number;
}

/** Admin-forced outcome of the next slot spins. */
export type Rig =
  | { mode: 'jackpot'; symbols: [string]; spins: number }
  | { mode: 'bonus' | 'lose'; spins: number }
  | { mode: 'symbols'; symbols: string[]; spins: number };

/** In-memory wallet of a casino player id (lost on restart, as in legacy). */
export interface CasinoAccount {
  balance: number;
  freeSpins: number;
  rig?: Rig | null;
}

/** A socket inside the 3D casino lobby. */
export interface LobbyPlayer {
  /** Socket id. */
  id: string;
  channelId: string;
  /** Casino player id chosen by the client (its wallet key). */
  accountId: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
  lastMove: number;
  lastChat: number;
}

/** Position broadcast of a lobby player. */
export interface LobbyPosition {
  id: string;
  name: string;
  x: number;
  z: number;
  yaw: number;
}

export interface BlackjackRound {
  id: string;
  bet: number;
  deck: Card[];
  player: Card[];
  dealer: Card[];
}

export interface PokerRound {
  bet: number;
  hand: Card[];
  deck: Card[];
}

/** `casino.admin`, used by the admin module (results are passed through to its ack). */
export interface CasinoAdminApi {
  listAccounts(): Array<{ playerId: string; name: string | null; online: boolean; balance: number; freeSpins: number; rig: Rig | null }>;
  setBalance(playerId: string, balance: unknown, freeSpins: unknown): { balance: number; freeSpins: number };
  setRig(playerId: string, rig: unknown): { rig: Rig | null };
}

/** What other modules consume (legacy casinoHandler return value). */
export interface CasinoApi {
  getCasinoSessions(): Record<string, CasinoSession>;
  admin: CasinoAdminApi;
}
