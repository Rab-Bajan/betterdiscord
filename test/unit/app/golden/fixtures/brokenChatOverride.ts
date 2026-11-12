// Golden fixture: a chat override that upper-cases message text, which the golden test must reject.
import type { Socket } from 'socket.io';
import type { ModuleFactory } from '../../../../../src/app/modules/ModuleFactory.ts';
import type { IoFactory, LegacyChat } from '../../../../../src/app/legacy/legacyModules.ts';

const brokenChat: ModuleFactory<'chat'> = (deps) => {
  const adapter = deps.createLegacyAdapter();
  const api = deps.loadLegacy<IoFactory<LegacyChat>>('./chatHandler')(adapter.io);
  const register = adapter.register.bind(adapter);
  adapter.register = (socket: Socket): void => {
    // Rewrite the payload before the legacy listener sees it.
    socket.use(([event, payload], next) => {
      if (event === 'chat:message' && payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string') {
        payload.text = payload.text.toUpperCase();
      }
      next();
    });
    register(socket);
  };
  return {
    controller: adapter,
    initialStateProvider: { getInitialState: () => ({ channelMessages: api.getChannelMessages() }) },
    api
  };
};
export default brokenChat;
