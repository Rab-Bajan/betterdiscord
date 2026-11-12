import type { Chess, Color, PieceSymbol } from 'chess.js';

/** A seat or spectator of a chess game. */
export interface ChessPlayer {
  id: string;
  username: string;
  avatarColor: string;
}

export type ChessStatus = 'waiting' | 'playing' | 'checkmate' | 'draw' | 'resigned';

/** One played (or admin-forced) move. */
export interface MoveEntry {
  san: string;
  from: string;
  to: string;
  color: Color;
  piece: PieceSymbol;
  captured: PieceSymbol | null;
}

/** The game of one voice channel (legacy chessHandler.js session). */
export interface ChessSession {
  channelId: string;
  active: true;
  chess: Chess;
  white: ChessPlayer | null;
  black: ChessPlayer | null;
  spectators: ChessPlayer[];
  history: Array<MoveEntry & { fen: string }>;
  status: ChessStatus;
  winner: 'white' | 'black' | 'draw' | null;
  reason: string | null;
  startedBy: string;
  createdAt: number;
  lastMove: MoveEntry | null;
}

/** Client view of a session (`chess:state`, `chess:session-updated`, init `chessSessions`). */
export interface ChessSnapshot {
  channelId: string;
  active: true;
  fen: string;
  turn: Color;
  white: ChessPlayer | null;
  black: ChessPlayer | null;
  spectators: ChessPlayer[];
  history: Array<MoveEntry & { fen: string }>;
  status: ChessStatus;
  winner: ChessSession['winner'];
  reason: string | null;
  inCheck: boolean;
  isGameOver: boolean;
  startedBy: string;
  createdAt: number;
  lastMove: MoveEntry | null;
}

/** Result of an admin board edit. */
export interface AdminEditResult {
  fen: string;
  turn: Color;
  status: ChessStatus;
}

/** `chess.admin`, used by the admin module (errors carry the message for the admin). */
export interface ChessAdminApi {
  forceMove(channelId: unknown, from: unknown, to: unknown, switchTurn: boolean): AdminEditResult;
  putPiece(channelId: unknown, square: unknown, piece: unknown): AdminEditResult;
  setTurn(channelId: unknown, turn: unknown): AdminEditResult;
}

/** What other modules consume (legacy chessHandler return value). */
export interface ChessApi {
  getChessSessions(): Record<string, ChessSnapshot>;
  getChessSession(channelId: string): ChessSnapshot | null;
  admin: ChessAdminApi;
}
