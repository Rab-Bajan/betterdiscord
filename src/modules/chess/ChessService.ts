import { Chess } from 'chess.js';
import { ChessAdmin } from './ChessAdmin.ts';
import { ChessError } from './ChessError.ts';
import type { ChessPlayer, ChessSession, ChessSnapshot } from './types.ts';

export const CHESS_ERRORS = Object.freeze({
  notPlaying: 'A játék még nem indult el, vagy már véget ért!',
  notYourTurn: 'Nem te vagy a soron következő játékos!',
  invalidMove: 'Érvénytelen lépés!'
});

/** Snapshot sent to clients. */
export function snapshot(session: ChessSession): ChessSnapshot {
  return {
    channelId: session.channelId,
    active: session.active,
    fen: session.chess.fen(),
    turn: session.chess.turn(),
    white: session.white,
    black: session.black,
    spectators: session.spectators,
    history: session.history,
    status: session.status,
    winner: session.winner,
    reason: session.reason,
    inCheck: session.chess.inCheck(),
    isGameOver: session.chess.isGameOver(),
    startedBy: session.startedBy,
    createdAt: session.createdAt,
    lastMove: session.lastMove || null
  };
}

/** What a disconnect did to one session. */
export type LeaveEffect = { channelId: string; closed: boolean };

/**
 * One chess game per voice channel (legacy chessHandler.js): seats, spectators, legal moves
 * via chess.js, resign, rematch with swapped colours. Refused moves throw {@link ChessError}.
 */
export class ChessService {
  readonly #sessions = new Map<string, ChessSession>();
  readonly #now: () => number;
  readonly admin: ChessAdmin;

  /** @param changed broadcasts a session after an admin edit */
  constructor(changed: (channelId: string) => void, now: () => number = () => Date.now()) {
    this.#now = now;
    this.admin = new ChessAdmin({ session: (id) => this.get(id), changed });
  }

  get(channelId: unknown): ChessSession | undefined {
    return typeof channelId === 'string' ? this.#sessions.get(channelId) : undefined;
  }

  snapshotOf(channelId: string): ChessSnapshot | null {
    const session = this.#sessions.get(channelId);
    return session ? snapshot(session) : null;
  }

  snapshots(): Record<string, ChessSnapshot> {
    const result: Record<string, ChessSnapshot> = {};
    for (const [channelId, session] of this.#sessions) result[channelId] = snapshot(session);
    return result;
  }

  /**
   * Opens a game with `player` on the preferred colour, or, when one exists, adds the player
   * as a spectator (unless seated already). Returns true when a new game was created.
   */
  start(channelId: string, player: ChessPlayer, colorPreference: unknown): boolean {
    const session = this.#sessions.get(channelId);
    if (session) {
      const seated = session.white?.id === player.id || session.black?.id === player.id;
      if (!seated && !session.spectators.some((s) => s.id === player.id)) session.spectators.push(player);
      return false;
    }
    const black = colorPreference === 'black';
    this.#sessions.set(channelId, {
      channelId,
      active: true,
      chess: new Chess(),
      white: black ? null : player,
      black: black ? player : null,
      spectators: [],
      history: [],
      status: 'waiting',
      winner: null,
      reason: null,
      startedBy: player.username,
      createdAt: this.#now(),
      lastMove: null
    });
    return true;
  }

  /** Takes a free seat (the game starts when both are taken) or spectates. True when seated now. */
  join(session: ChessSession, player: ChessPlayer): boolean {
    if (session.white?.id === player.id || session.black?.id === player.id) return false;
    if (!session.white) session.white = player;
    else if (!session.black) session.black = player;
    else {
      if (!session.spectators.some((s) => s.id === player.id)) session.spectators.push(player);
      return false;
    }
    session.spectators = session.spectators.filter((s) => s.id !== player.id);
    if (session.white && session.black && session.status === 'waiting') session.status = 'playing';
    return true;
  }

  /** Plays a legal move for the player whose turn it is; chess.js errors propagate. */
  move(session: ChessSession | undefined, socketId: string, from: unknown, to: unknown, promotion: unknown): void {
    if (!session || !session.active || session.status !== 'playing') throw new ChessError(CHESS_ERRORS.notPlaying);
    const expected = session.chess.turn() === 'w' ? session.white : session.black;
    if (!expected || expected.id !== socketId) throw new ChessError(CHESS_ERRORS.notYourTurn);
    const piece = promotion || 'q';
    if (typeof from !== 'string' || typeof to !== 'string' || typeof piece !== 'string') throw new ChessError(CHESS_ERRORS.invalidMove);

    const result = session.chess.move({ from, to, promotion: piece });
    const entry = {
      san: result.san,
      from: result.from,
      to: result.to,
      color: result.color,
      piece: result.piece,
      captured: result.captured || null
    };
    session.lastMove = { from: entry.from, to: entry.to, san: entry.san, piece: entry.piece, color: entry.color, captured: entry.captured };
    session.history.push({ ...entry, fen: session.chess.fen() });

    const c = session.chess;
    if (c.isCheckmate()) {
      session.status = 'checkmate';
      session.winner = result.color === 'w' ? 'white' : 'black';
      session.reason = 'checkmate';
    } else if (c.isDraw()) {
      session.status = 'draw';
      session.winner = 'draw';
      session.reason = c.isStalemate() ? 'stalemate'
        : c.isThreefoldRepetition() ? 'threefold'
          : c.isInsufficientMaterial() ? 'insufficient' : '50-move-rule';
    }
  }

  /** A seated player resigns a running game; false for spectators or other states. */
  resign(session: ChessSession, socketId: string): boolean {
    if (session.status !== 'playing') return false;
    if (session.white?.id === socketId) session.winner = 'black';
    else if (session.black?.id === socketId) session.winner = 'white';
    else return false;
    session.status = 'resigned';
    session.reason = 'resignation';
    return true;
  }

  /** New board, colours swapped. */
  rematch(session: ChessSession): void {
    session.chess = new Chess();
    session.history = [];
    session.lastMove = null;
    session.winner = null;
    session.reason = null;
    const oldWhite = session.white;
    session.white = session.black;
    session.black = oldWhite;
    session.status = session.white && session.black ? 'playing' : 'waiting';
  }

  stop(channelId: string): void {
    this.#sessions.delete(channelId);
  }

  /**
   * Frees the socket's seats and spectator slot in every game. Games left with nobody are
   * closed. Returns the games to broadcast (changed or closed), in session order.
   */
  leave(socketId: string): LeaveEffect[] {
    const effects: LeaveEffect[] = [];
    for (const [channelId, session] of [...this.#sessions]) {
      let changed = false;
      if (session.white?.id === socketId) {
        session.white = null;
        if (session.status === 'playing') session.status = 'waiting';
        changed = true;
      }
      if (session.black?.id === socketId) {
        session.black = null;
        if (session.status === 'playing') session.status = 'waiting';
        changed = true;
      }
      const spectator = session.spectators.findIndex((s) => s.id === socketId);
      if (spectator !== -1) {
        session.spectators.splice(spectator, 1);
        changed = true;
      }
      if (!session.white && !session.black && session.spectators.length === 0) {
        this.#sessions.delete(channelId);
        effects.push({ channelId, closed: true });
      } else if (changed) {
        effects.push({ channelId, closed: false });
      }
    }
    return effects;
  }
}
