import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { DirectMessageRepository } from '../../infrastructure/database/repositories/DirectMessageRepository.ts';
import { DmReportRepository } from '../../infrastructure/database/repositories/DmReportRepository.ts';
import { AdminController } from './AdminController.ts';
import { AdminService } from './AdminService.ts';

/**
 * Replaces legacy `adminHandler(io, { casino, chess, dm })`, taking the same three module
 * apis (legacy or overridden) through `deps.module`. Legacy returned nothing.
 */
export const adminModule: ModuleFactory<'admin'> = (deps) => {
  const service = new AdminService({
    casino: deps.module('casino'),
    chess: deps.module('chess'),
    dm: deps.module('dm'),
    messages: new DirectMessageRepository(deps.database),
    reports: new DmReportRepository(deps.database)
  });
  return { controller: new AdminController(service, deps.users, deps.logger), api: undefined };
};

export default adminModule;
