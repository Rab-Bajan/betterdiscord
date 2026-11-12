import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { WatchPartyController } from './WatchPartyController.ts';
import { WatchPartyService } from './WatchPartyService.ts';

/**
 * Replaces legacy `watchPartyHandler(io, app, users)` (which added no HTTP routes):
 * init `watchSessions`, room state `watch:state`.
 */
export const watchPartyModule: ModuleFactory<'watchParty'> = (deps) => {
  const watch = new WatchPartyService();
  return {
    controller: new WatchPartyController(deps.io, deps.users, watch, deps.logger.child('WatchParty')),
    initialStateProvider: { getInitialState: () => ({ watchSessions: watch.getSessions() }) },
    roomStateProvider: { getRoomState: (channelId) => [{ event: 'watch:state', payload: watch.getSession(channelId) }] },
    api: { getWatchSessions: () => watch.getSessions(), getWatchSession: (channelId) => watch.getSession(channelId) }
  };
};

export default watchPartyModule;
