import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { BrowserController } from './BrowserController.ts';
import { BrowserService } from './BrowserService.ts';
import { findChromeExecutable } from './chromePath.ts';
import { PuppeteerLauncher } from './PuppeteerLauncher.ts';

/**
 * Replaces legacy `browserHandler(io, app, users)` + browserSecurity.js (no HTTP routes were
 * added): init `browserSessions`, room state `browser:state`. Chrome starts only when a
 * shared browser is started; CHROME_PATH comes from AppConfig.
 */
export const browserModule: ModuleFactory<'browser'> = (deps) => {
  const logger = deps.logger.child('SharedBrowser');
  const browser = new BrowserService({
    chromePath: findChromeExecutable(deps.config.chromePath),
    launcher: new PuppeteerLauncher(deps.logger),
    broadcaster: {
      state: (channelId, state) => {
        deps.io.to(channelId).emit('browser:state', state);
        deps.io.emit('browser:session-updated', { channelId, state });
      },
      frame: (channelId, frame) => { deps.io.to(channelId).emit('browser:frame', frame); }
    },
    logger
  });
  browser.logChromeAvailability();
  return {
    controller: new BrowserController(deps.users, browser, logger),
    initialStateProvider: { getInitialState: () => ({ browserSessions: browser.publicStates() }) },
    roomStateProvider: { getRoomState: (channelId) => [{ event: 'browser:state', payload: browser.publicState(channelId) }] },
    api: {
      getBrowserSessions: () => browser.publicStates(),
      getBrowserSession: (channelId) => browser.publicState(channelId),
      destroySession: (channelId: string) => browser.destroy(channelId)
    }
  };
};

export default browserModule;
