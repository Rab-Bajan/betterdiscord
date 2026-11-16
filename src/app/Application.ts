import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type https from 'node:https';
import type { Express } from 'express';
import { Server } from 'socket.io';
import { AppConfig } from '../config/AppConfig.ts';
import { voiceChannels } from '../config/channels.ts';
import { Logger } from '../core/logging/Logger.ts';
import { createExpressApp, CORS_OPTIONS } from '../infrastructure/http/ExpressAppFactory.ts';
import { HttpsServerFactory } from '../infrastructure/http/HttpsServerFactory.ts';
import type { FatalExit } from '../infrastructure/http/HttpsServerFactory.ts';
import { SocketServer } from '../infrastructure/socket/SocketServer.ts';
import { MIGRATED_MODULES } from '../modules/migratedModules.ts';
import { PresenceService } from '../modules/presence/PresenceService.ts';
import { UserRegistry } from '../modules/presence/UserRegistry.ts';
import { LegacyModuleRegistry } from './legacy/LegacyModuleRegistry.ts';
import type { MountedModule } from './legacy/LegacyModuleRegistry.ts';
import type { LegacyPhobia, LegacyState } from './legacy/legacyModules.ts';
import type { ModuleOverrides } from './modules/ModuleFactory.ts';

export interface ApplicationOptions {
  config: AppConfig;
  /** Root logger; defaults to the console. */
  logger?: Logger;
  /** Listen address. Omitted in production (all interfaces, as legacy); tests pass 127.0.0.1. */
  host?: string;
  /** Called when certificates are missing; defaults to `process.exit`. */
  exit?: FatalExit;
  /**
   * Factories mounted at the position of the legacy module they replace. Defaults to
   * {@link MIGRATED_MODULES}; when given, it replaces that set (`{}` mounts only legacy modules).
   */
  moduleOverrides?: ModuleOverrides;
}

/** Everything that exists once {@link Application.start} has built the app. */
interface Runtime {
  app: Express;
  httpServer: https.Server;
  io: Server;
  socketServer: SocketServer;
  presence: PresenceService;
  users: UserRegistry;
  phobia: LegacyPhobia;
  registry: LegacyModuleRegistry;
  mounted: readonly MountedModule[];
}

/**
 * Composition root. Reproduces legacy server.js step by step: Express
 * middleware, HTTPS certificates (log + exit on failure), socket.io with the
 * same CORS, every socket module in server.js order (the migrated TypeScript
 * module, or the legacy one behind a LegacyModuleAdapter), HTTP routes, then
 * listen with the same startup line.
 *
 * Legacy modules keep module-level state (state.js `users`, database
 * connection), so start at most one Application per process.
 */
export class Application {
  readonly #config: AppConfig;
  readonly #logger: Logger;
  readonly #host: string | undefined;
  readonly #exit: FatalExit | undefined;
  readonly #overrides: ModuleOverrides;
  #runtime: Runtime | undefined;

  constructor(options: ApplicationOptions) {
    this.#config = options.config;
    this.#logger = options.logger ?? new Logger();
    this.#host = options.host;
    this.#exit = options.exit;
    this.#overrides = options.moduleOverrides ?? MIGRATED_MODULES;
  }

  /** Builds everything and starts listening; resolves with the bound address. */
  async start(): Promise<AddressInfo> {
    if (this.#runtime) throw new Error('Application already started');
    const runtime = this.#build();
    this.#runtime = runtime;
    await this.#listen(runtime.httpServer);
    const address = runtime.httpServer.address() as AddressInfo;
    this.#logger.info(`>>> Discord VoIP & Chat Backend (HTTPS) fut: https://localhost:${address.port}`);
    return address;
  }

  /** Stops the phobia tick loop, disposes the modules, closes socket.io and the HTTPS server (incl. keep-alive connections). */
  async stop(): Promise<void> {
    const runtime = this.#runtime;
    if (!runtime) return;
    clearInterval(runtime.phobia.tickInterval);
    runtime.registry.disposeModules();
    runtime.httpServer.closeAllConnections();
    await runtime.io.close();
  }

  get socketServer(): SocketServer { return this.#require().socketServer; }
  get presence(): PresenceService { return this.#require().presence; }
  get users(): UserRegistry { return this.#require().users; }
  get io(): Server { return this.#require().io; }
  /** Socket modules in the order they were mounted, with their source (legacy or override). */
  get mountedModules(): readonly MountedModule[] { return this.#require().mounted; }

  #build(): Runtime {
    const app = createExpressApp();
    const factory = new HttpsServerFactory(this.#config.certsDir, this.#logger.child('SSL'), this.#exit);
    const httpServer = factory.create(app);
    const io = new Server(httpServer, { cors: { origin: CORS_OPTIONS.origin, methods: [...CORS_OPTIONS.methods] } });
    const socketServer = new SocketServer(io, this.#logger.child('Socket'));
    const backendRoot = AppConfig.backendRoot;
    const users = new UserRegistry(this.#loadState(backendRoot).users);
    const presence = new PresenceService(users, voiceChannels);
    const registry = new LegacyModuleRegistry({
      backendRoot, io, app, socketServer, users, presence, config: this.#config, logger: this.#logger,
      overrides: this.#overrides
    });
    const phobia = registry.mountSocketModules();
    registry.mountHttpRoutes();
    socketServer.start();
    return { app, httpServer, io, socketServer, users, presence, phobia, registry, mounted: registry.mounted };
  }

  #loadState(backendRoot: string): LegacyState {
    // state.js is untyped CommonJS; LegacyState describes the member used here.
    return createRequire(path.join(backendRoot, 'server.js'))('./state') as LegacyState;
  }

  #listen(server: https.Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      const onListening = (): void => {
        server.off('error', reject);
        resolve();
      };
      if (this.#host === undefined) server.listen(this.#config.port, onListening);
      else server.listen(this.#config.port, this.#host, onListening);
    });
  }

  #require(): Runtime {
    if (!this.#runtime) throw new Error('Application not started');
    return this.#runtime;
  }
}
