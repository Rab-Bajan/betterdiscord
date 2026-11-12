import type { Server } from 'socket.io';
import type { ChessSnapshot } from './types.ts';

/** Room and global chess updates (legacy chessHandler.js `emitSessionUpdate`). */
export class ChessBroadcaster {
  readonly #io: Pick<Server, 'to' | 'emit'>;

  constructor(io: Pick<Server, 'to' | 'emit'>) {
    this.#io = io;
  }

  /** `chess:state` to the channel and `chess:session-updated` to everyone (`null` = closed). */
  sessionUpdated(channelId: string, state: ChessSnapshot | null): void {
    this.#io.to(channelId).emit('chess:state', state);
    this.#io.emit('chess:session-updated', { channelId, state });
  }

  /** A game closed because nobody was left: only the global update, as in legacy. */
  sessionClosed(channelId: string): void {
    this.#io.emit('chess:session-updated', { channelId, state: null });
  }
}
