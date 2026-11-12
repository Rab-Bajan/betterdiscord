import type { DatabaseConnection, ModuleFactory } from '../../app/modules/ModuleFactory.ts';
import type { Logger } from '../../core/logging/Logger.ts';
import { voiceChannels } from '../../config/channels.ts';
import { MISKOLC_SWEEPERS_MIGRATION } from '../../infrastructure/database/schema/migrations.ts';
import { SweepersBroadcaster } from './SweepersBroadcaster.ts';
import { SweepersController } from './SweepersController.ts';
import { SweepersRepository } from './SweepersRepository.ts';
import { SweepersService } from './SweepersService.ts';
import { SWEEPERS_EVENTS } from './types.ts';

/**
 * Creates the sweepers tables on the shared connection (the legacy database.js one, whose
 * schema has none of them). False, with the error logged, when that fails.
 */
export function ensureSweepersSchema(database: DatabaseConnection, logger: Logger): boolean {
  try {
    MISKOLC_SWEEPERS_MIGRATION.apply(database.connection);
    return true;
  } catch (err) {
    logger.error('MiskolcSweepers schema migration failed; the module is disabled', err);
    return false;
  }
}

/**
 * MiskolcSweepers (no legacy handler): one co-op world per voice channel. Init `sweepersSessions`,
 * the voice-join `miskolc:session-updated` room state, and `dispose` (final save, stop the tick loop).
 */
export const sweepersModule: ModuleFactory<'sweepers'> = (deps) => {
  const logger = deps.logger.child('Sweepers');
  // Without its tables sweepers mounts no controller or providers; the rest of the server still starts.
  if (!ensureSweepersSchema(deps.database, logger)) return { api: { getSweepersSessions: () => ({}), getSession: () => null } };
  const service = new SweepersService({
    store: new SweepersRepository(deps.database),
    events: new SweepersBroadcaster(deps.io),
    logger
  });
  return {
    controller: new SweepersController(service, deps.users, voiceChannels, logger),
    initialStateProvider: { getInitialState: () => ({ sweepersSessions: service.summaries() }) },
    roomStateProvider: {
      getRoomState: (channelId) => [{ event: SWEEPERS_EVENTS.sessionUpdated, payload: { channelId, state: service.summaryOf(channelId) } }]
    },
    dispose: () => service.dispose(),
    api: { getSweepersSessions: () => service.summaries(), getSession: (channelId: string) => service.summaryOf(channelId) }
  };
};

export default sweepersModule;
