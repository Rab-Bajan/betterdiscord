import { textChannels } from '../../config/channels.ts';
import { ChannelMessageRepository } from '../../infrastructure/database/repositories/ChannelMessageRepository.ts';
import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { ChatController } from './ChatController.ts';
import { ChatService } from './ChatService.ts';
import type { ChannelMessageStore } from './ChatService.ts';

/** Override for the legacy `chat` module (chatHandler.js). */
export const chatModule: ModuleFactory<'chat'> = (deps) => {
  // The repository's saveChannelMessage accepts any NewChannelMessage; ChatMessage is one.
  const store: ChannelMessageStore = new ChannelMessageRepository(deps.database);
  const service = new ChatService(store, textChannels.map((c) => c.id));
  return {
    controller: new ChatController(deps.io, deps.users, service, deps.logger.child('Chat')),
    initialStateProvider: { getInitialState: () => ({ channelMessages: service.getChannelMessages() }) },
    api: { getChannelMessages: () => service.getChannelMessages() }
  };
};

export default chatModule;
