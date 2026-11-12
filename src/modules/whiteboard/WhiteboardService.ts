import type { PresenceUser } from '../presence/UserRegistry.ts';
import { defaultIdSource, legacyId, type IdSource } from '../shared/legacyId.ts';
import type { Board, BoardSummary } from './types.ts';

/** Oldest strokes are dropped beyond this count. */
export const MAX_STROKES = 10000;

const summarize = (b: Board): BoardSummary => ({
  id: b.id,
  title: b.title,
  creatorId: b.creatorId,
  creatorName: b.creatorName,
  createdAt: b.createdAt,
  strokeCount: b.strokes.length
});

/**
 * Whiteboards per voice channel (legacy whiteboardHandler.js). Only a user who is in the
 * channel may create, draw on, clear or delete its boards; anyone may read one.
 */
export class WhiteboardService {
  readonly #boards = new Map<string, Map<string, Board>>();
  readonly #ids: IdSource;

  constructor(ids: IdSource = defaultIdSource) {
    this.#ids = ids;
  }

  /** Summaries of the channel's boards in creation order. */
  getBoardList(channelId: string): BoardSummary[] {
    const boards = this.#boards.get(channelId);
    return boards ? Array.from(boards.values(), summarize) : [];
  }

  /** Creates a board for a member of `channelId`; the title defaults to `<name> Rajztáblája`. */
  create(user: PresenceUser | undefined, channelId: unknown, title: unknown): BoardSummary | null {
    if (!user || typeof channelId !== 'string' || !isMember(user, channelId)) return null;
    let boards = this.#boards.get(channelId);
    if (!boards) {
      boards = new Map();
      this.#boards.set(channelId, boards);
    }
    const board: Board = {
      id: legacyId('board', 5, this.#ids),
      title: String(title || `${user.username} Rajztáblája`).trim(),
      creatorId: user.id,
      creatorName: user.username,
      strokes: [],
      createdAt: this.#ids.now()
    };
    boards.set(board.id, board);
    return summarize(board);
  }

  /** Any board by channel and id (no membership needed, as in legacy). */
  find(channelId: unknown, boardId: unknown): Board | undefined {
    if (typeof channelId !== 'string' || typeof boardId !== 'string') return undefined;
    return this.#boards.get(channelId)?.get(boardId);
  }

  /** A board of `channelId` that `user` may modify (the user is in that channel). */
  findEditable(user: PresenceUser | undefined, channelId: unknown, boardId: unknown): Board | undefined {
    return isMember(user, channelId) ? this.find(channelId, boardId) : undefined;
  }

  /** Appends a stroke, dropping the oldest one beyond {@link MAX_STROKES}. */
  draw(board: Board, stroke: unknown): void {
    board.strokes.push(stroke);
    if (board.strokes.length > MAX_STROKES) board.strokes.shift();
  }

  clear(board: Board): void {
    board.strokes = [];
  }

  delete(channelId: string, boardId: string): void {
    this.#boards.get(channelId)?.delete(boardId);
  }
}

/** The user is connected and in voice channel `channelId`. */
function isMember(user: PresenceUser | undefined, channelId: unknown): boolean {
  return user !== undefined && typeof channelId === 'string' && user.voiceChannel === channelId;
}
