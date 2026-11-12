/** A shared drawing board of one voice channel (kept in memory only). */
export interface Board {
  readonly id: string;
  readonly title: string;
  readonly creatorId: string;
  readonly creatorName: string;
  /** Strokes exactly as clients sent them (opaque to the server). */
  strokes: unknown[];
  readonly createdAt: number;
}

/** Board entry of `whiteboard:list` / `whiteboard:created`. */
export interface BoardSummary {
  id: string;
  title: string;
  creatorId: string;
  creatorName: string;
  createdAt: number;
  strokeCount: number;
}

/** What other modules consume (legacy whiteboardHandler return value). */
export interface WhiteboardApi {
  getBoardList(channelId: string): BoardSummary[];
}
