import type { DirectMessage } from '../../infrastructure/database/types/models.ts';

/** Admin surface of the casino module (`casino.admin`, casinoHandler.js). Results are passed through. */
export interface CasinoAdmin {
  listAccounts(): unknown;
  setBalance(playerId: string, balance: unknown, freeSpins: unknown): unknown;
  setRig(playerId: string, rig: unknown): unknown;
}

/** Admin surface of the chess module (`chess.admin`, chessHandler.js). Results are passed through. */
export interface ChessAdmin {
  forceMove(channelId: unknown, from: unknown, to: unknown, switchTurn: boolean): unknown;
  putPiece(channelId: unknown, square: unknown, piece: unknown): unknown;
  setTurn(channelId: unknown, turn: unknown): unknown;
}

/** The modules admin depends on, shaped exactly like legacy `setupAdmin(io, { casino, chess, dm })`. */
export interface AdminModules {
  casino: { admin: CasinoAdmin };
  chess: { admin: ChessAdmin };
  dm: { notifyMessageRemoved(dmKey: string, messageId: string): void };
}

/** Raw payload fields of an admin event (legacy `payload || {}` destructured). */
export type AdminFields = Readonly<Record<string, unknown>>;

/** One entry of `admin:dm-reports`. */
export interface DmReportSummary {
  id: string;
  reporter: string;
  reportedUser: string;
  reason: string | null;
  createdAt: number | null;
}

/** `admin:dm-report-context` result. */
export interface DmReportContext {
  report: { id: string; reporter: string; reason: string | null; status: string; reportedMessageId: string };
  messages: DirectMessage[];
}
