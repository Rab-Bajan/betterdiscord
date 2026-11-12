import { randomInt } from 'node:crypto';
import path from 'node:path';
import type { ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import { CasinoController } from './CasinoController.ts';
import { CasinoService } from './CasinoService.ts';
import { mountCasinoRoutes } from './casinoRoutes.ts';

/**
 * Replaces legacy `casinoHandler(io, app, <root>/casino)`: the `/casino` page, init
 * `casinoSessions`, and the `admin` api used by the admin module.
 */
export const casinoModule: ModuleFactory<'casino'> = (deps) => {
  mountCasinoRoutes(deps.app, path.resolve(deps.backendRoot, 'casino'));
  const casino = new CasinoService({
    randomInt: (max) => randomInt(max),
    onWalletChanged: (socketIds, wallet) => {
      for (const id of socketIds) deps.io.to(id).emit('wallet:balance', wallet);
    }
  });
  return {
    controller: new CasinoController(deps.io, casino, deps.logger),
    initialStateProvider: { getInitialState: () => ({ casinoSessions: casino.getSessions() }) },
    api: { getCasinoSessions: () => casino.getSessions(), admin: casino.admin }
  };
};

export default casinoModule;
