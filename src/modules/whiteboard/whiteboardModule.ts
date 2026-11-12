import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { WhiteboardController } from './WhiteboardController.ts';
import { WhiteboardService } from './WhiteboardService.ts';

/** Replaces legacy `whiteboardHandler(io)`; room state `whiteboard:list` on voice join. */
export const whiteboardModule: ModuleFactory<'whiteboard'> = (deps) => {
  const boards = new WhiteboardService();
  return {
    controller: new WhiteboardController(deps.io, deps.users, boards, deps.logger.child('Whiteboard')),
    roomStateProvider: { getRoomState: (channelId) => [{ event: 'whiteboard:list', payload: boards.getBoardList(channelId) }] },
    api: { getBoardList: (channelId) => boards.getBoardList(channelId) }
  };
};

export default whiteboardModule;
