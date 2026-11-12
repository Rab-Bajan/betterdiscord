import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { AccountRepository } from '../../infrastructure/database/repositories/AccountRepository.ts';
import { CallHistoryRepository } from '../../infrastructure/database/repositories/CallHistoryRepository.ts';
import { DirectMessageRepository } from '../../infrastructure/database/repositories/DirectMessageRepository.ts';
import { CallController } from './CallController.ts';
import { CallNotifier } from './CallNotifier.ts';
import { CallService } from './CallService.ts';
import { TurnCredentialService } from './TurnCredentialService.ts';

/**
 * Replaces legacy `callHandler(io)` + callService.js + turnCredentialService.js. STUN/TURN
 * settings come from AppConfig. Legacy returned `{ service }`, which nobody consumed.
 */
export const callModule: ModuleFactory<'call'> = (deps) => {
  const logger = deps.logger.child('Call');
  const accounts = new AccountRepository(deps.database);
  const history = new CallHistoryRepository(deps.database);
  const service = new CallService({ history, logger });
  const notifier = new CallNotifier({
    io: deps.io, users: deps.users, accounts, messages: new DirectMessageRepository(deps.database), logger
  });
  const turn = new TurnCredentialService(deps.config);
  return {
    controller: new CallController({ service, notifier, turn, users: deps.users, accounts, history, logger }),
    api: { service }
  };
};

export default callModule;
