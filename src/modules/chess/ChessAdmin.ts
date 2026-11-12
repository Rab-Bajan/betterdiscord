import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { ChessError } from './ChessError.ts';
import type { AdminEditResult, ChessAdminApi, ChessSession, MoveEntry } from './types.ts';

const PIECE_TYPES: readonly unknown[] = ['p', 'n', 'b', 'r', 'q', 'k'] satisfies PieceSymbol[];
const isPieceSymbol = (value: unknown): value is PieceSymbol => PIECE_TYPES.includes(value);
const isColor = (value: unknown): value is Color => value === 'w' || value === 'b';

/** `/^[a-h][1-8]$/` on `String(value)`, as legacy checked squares. */
const toSquare = (value: unknown): Square | null => {
  const text = String(value);
  return /^[a-h][1-8]$/.test(text) ? (text as Square) : null;
};

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Board change made on a draft: an optional side to move and history entry. */
interface EditNote {
  turn?: Color;
  entry?: MoveEntry;
}

/** Recomputes a finished/unfinished status after an admin edit. */
export function refreshStatus(session: ChessSession): void {
  const c = session.chess;
  if (c.isCheckmate()) {
    session.status = 'checkmate';
    session.winner = c.turn() === 'w' ? 'black' : 'white';
    session.reason = 'checkmate';
  } else if (c.isDraw()) {
    session.status = 'draw';
    session.winner = 'draw';
    session.reason = c.isStalemate() ? 'stalemate' : c.isInsufficientMaterial() ? 'insufficient' : '50-move-rule';
  } else if (session.status === 'checkmate' || session.status === 'draw') {
    session.status = session.white && session.black ? 'playing' : 'waiting';
    session.winner = null;
    session.reason = null;
  }
}

export interface ChessAdminDeps {
  session(channelId: unknown): ChessSession | undefined;
  /** Broadcasts the edited session. */
  changed(channelId: string): void;
}

/**
 * Rule-breaking board edits for admins (legacy chessHandler.js `admin`). Each edit runs on a
 * copy and goes live only if chess.js accepts the resulting position (it throws otherwise).
 */
export class ChessAdmin implements ChessAdminApi {
  readonly #deps: ChessAdminDeps;

  constructor(deps: ChessAdminDeps) {
    this.#deps = deps;
  }

  /** Puts `{ type, color }` on `square`, or clears it when `piece` is null. */
  putPiece(channelId: unknown, square: unknown, piece: unknown): AdminEditResult {
    const target = toSquare(square);
    if (!target) throw new ChessError('Érvénytelen mező.');
    return this.#edit(channelId, (c) => {
      if (piece === null) {
        c.remove(target);
        return {};
      }
      const type = field(piece, 'type');
      const color = field(piece, 'color');
      if (!isPieceSymbol(type) || !isColor(color)) throw new ChessError('Érvénytelen bábu.');
      c.remove(target);
      if (!c.put({ type, color }, target)) {
        throw new ChessError('A bábu nem helyezhető oda (pl. második király).');
      }
      return {};
    });
  }

  /** Moves any piece regardless of the rules (capturing whatever is on `to`). */
  forceMove(channelId: unknown, from: unknown, to: unknown, switchTurn: boolean): AdminEditResult {
    const source = toSquare(from);
    const target = toSquare(to);
    if (!source || !target) throw new ChessError('Érvénytelen mező.');
    return this.#edit(channelId, (c) => {
      const piece = c.get(source);
      if (!piece) throw new ChessError(`Nincs bábu a(z) ${source} mezőn.`);
      const captured = c.get(target);
      c.remove(source);
      c.remove(target);
      if (!c.put(piece, target)) throw new ChessError('A lépés után érvénytelen állás állna elő.');
      const mover = piece.color;
      return {
        turn: switchTurn ? (mover === 'w' ? 'b' : 'w') : c.turn(),
        entry: { san: `${source}→${target}*`, from: source, to: target, color: mover, piece: piece.type, captured: captured?.type || null }
      };
    });
  }

  setTurn(channelId: unknown, turn: unknown): AdminEditResult {
    if (turn !== 'w' && turn !== 'b') throw new ChessError('Érvénytelen sor.');
    return this.#edit(channelId, () => ({ turn }));
  }

  #edit(channelId: unknown, mutate: (draft: Chess, session: ChessSession) => EditNote): AdminEditResult {
    const session = this.#deps.session(channelId);
    if (!session) throw new ChessError('Nincs aktív sakk parti ebben a szobában.');
    const draft = new Chess(session.chess.fen());
    const note = mutate(draft, session);
    const parts = draft.fen().split(' ');
    if (note.turn) parts[1] = note.turn;
    parts[3] = '-'; // the en-passant square may no longer be valid
    const next = new Chess(parts.join(' ')); // throws on an invalid position

    session.chess = next;
    if (note.entry) {
      session.lastMove = note.entry;
      session.history.push({ ...note.entry, fen: next.fen() });
    }
    refreshStatus(session);
    this.#deps.changed(session.channelId);
    return { fen: next.fen(), turn: next.turn(), status: session.status };
  }
}
