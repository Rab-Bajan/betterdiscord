import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { ChessBroadcaster } from './ChessBroadcaster.ts';
import { ChessController } from './ChessController.ts';
import { ChessService } from './ChessService.ts';

/**
 * Replaces legacy `chessHandler(io, app, users)` (which added no HTTP routes): init
 * `chessSessions`, and the `admin` api used by the admin module.
 */
export const chessModule: ModuleFactory<'chess'> = (deps) => {
  const broadcaster = new ChessBroadcaster(deps.io);
  const chess: ChessService = new ChessService((channelId) => broadcaster.sessionUpdated(channelId, chess.snapshotOf(channelId)));
  return {
    controller: new ChessController(broadcaster, deps.users, chess, deps.logger),
    initialStateProvider: { getInitialState: () => ({ chessSessions: chess.snapshots() }) },
    api: { getChessSessions: () => chess.snapshots(), getChessSession: (channelId: string) => chess.snapshotOf(channelId), admin: chess.admin }
  };
};

export default chessModule;
