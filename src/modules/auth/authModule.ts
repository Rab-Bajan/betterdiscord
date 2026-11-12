import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { textChannels, voiceChannels } from '../../config/channels.ts';
import { AccountRepository } from '../../infrastructure/database/repositories/AccountRepository.ts';
import { AuthTokenRepository } from '../../infrastructure/database/repositories/AuthTokenRepository.ts';
import { AuthController } from './AuthController.ts';
import { AuthService } from './AuthService.ts';
import { UserSessionService } from './UserSessionService.ts';

/**
 * Replaces legacy `authHandler(io, getExtraInitData)` + authManager.js. Admin names come
 * from AppConfig (ADMIN_USERNAMES, same parsing as state.js); extra `init:data` keys from
 * the SocketServer providers, read per login. Legacy returned nothing, so the api is empty.
 */
export const authModule: ModuleFactory<'auth'> = (deps) => {
  const auth = new AuthService({
    accounts: new AccountRepository(deps.database),
    tokens: new AuthTokenRepository(deps.database),
    logger: deps.logger
  });
  const controller = new AuthController({
    auth,
    sessions: new UserSessionService(deps.users, (name) => deps.config.isAdmin(name)),
    presence: deps.presence,
    io: deps.io,
    buildInitialState: () => deps.socketServer.buildInitialState(),
    textChannels,
    voiceChannels,
    logger: deps.logger
  });
  return { controller, api: undefined };
};

export default authModule;
