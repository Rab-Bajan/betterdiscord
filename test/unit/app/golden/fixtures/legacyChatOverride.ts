// Golden fixture: the legacy chat module mounted through the ModuleFactory interface.
import type { ModuleFactory } from '../../../../../src/app/modules/ModuleFactory.ts';
import type { IoFactory, LegacyChat } from '../../../../../src/app/legacy/legacyModules.ts';

const legacyChat: ModuleFactory<'chat'> = (deps) => {
  const adapter = deps.createLegacyAdapter();
  const api = deps.loadLegacy<IoFactory<LegacyChat>>('./chatHandler')(adapter.io);
  return {
    controller: adapter,
    initialStateProvider: { getInitialState: () => ({ channelMessages: api.getChannelMessages() }) },
    api
  };
};
export default legacyChat;
