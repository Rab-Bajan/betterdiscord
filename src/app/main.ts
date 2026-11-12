// Production entry point, loaded by the server.js shim (`node server.js`).
import { AppConfig } from '../config/AppConfig.ts';
import { Logger } from '../core/logging/Logger.ts';
import { Application } from './Application.ts';
import { installProcessGuards } from './processGuards.ts';

const logger = new Logger();
installProcessGuards(logger.child('FATAL-GUARD'));

// Config is read inside the chain so an invalid environment (e.g. PORT=abc) exits 1, not 0.
Promise.resolve()
  .then(() => new Application({ config: AppConfig.fromEnv(), logger }).start())
  .catch((err: unknown) => {
    logger.error('Startup failed:', err);
    process.exit(1);
  });
