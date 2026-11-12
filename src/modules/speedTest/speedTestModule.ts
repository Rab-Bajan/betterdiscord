import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { SpeedTestController } from './SpeedTestController.ts';
import { SpeedTestService } from './SpeedTestService.ts';

/** Override for the legacy `speedTest` module (speedTestHandler.js). */
export const speedTestModule: ModuleFactory<'speedTest'> = (deps) => ({
  controller: new SpeedTestController(deps.io, new SpeedTestService(deps.users), deps.presence, deps.logger.child('SpeedTest')),
  api: undefined
});

export default speedTestModule;
