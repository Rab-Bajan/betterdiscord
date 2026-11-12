import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { DirectMessageRepository } from '../../infrastructure/database/repositories/DirectMessageRepository.ts';
import { DmReportRepository } from '../../infrastructure/database/repositories/DmReportRepository.ts';
import { DmController } from './DmController.ts';
import { DmService } from './DmService.ts';

/**
 * Replaces legacy `dmHandler(io, users)`. Uses the shared legacy database connection and
 * the root logger (legacy lines carry their own `[SQLite DM]` / `[DM Report]` prefixes).
 * The api keeps the legacy `{ getDmKey, notifyMessageRemoved }` shape.
 */
export const dmModule: ModuleFactory<'dm'> = (deps) => {
  const service = new DmService({
    users: deps.users,
    messages: new DirectMessageRepository(deps.database),
    reports: new DmReportRepository(deps.database),
    logger: deps.logger
  });
  const controller = new DmController(service, deps.io, deps.logger);
  return { controller, api: controller.api };
};

export default dmModule;
