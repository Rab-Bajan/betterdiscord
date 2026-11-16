import path from 'node:path';
import { createRequire } from 'node:module';
import type { Express } from 'express';
import type { Server } from 'socket.io';
import type { AppConfig } from '../../config/AppConfig.ts';
import type { Logger } from '../../core/logging/Logger.ts';
import type { InitialStateProvider, RoomStateProvider } from '../../core/socket/SocketStateProviders.ts';
import { LegacyModuleAdapter } from '../../infrastructure/socket/LegacyModuleAdapter.ts';
import type { SocketServer } from '../../infrastructure/socket/SocketServer.ts';
import type { PresenceService } from '../../modules/presence/PresenceService.ts';
import type { UserRegistry } from '../../modules/presence/UserRegistry.ts';
import { INITIAL_STATE_ORDER, MODULE_ORDER, ROOM_STATE_ORDER, TS_ONLY_MODULES } from '../modules/ModuleFactory.ts';
import type {
  DatabaseConnection, LegacyModuleName, ModuleApis, ModuleDeps, ModuleFactory, ModuleName, ModuleOverrides, ModuleRegistration
} from '../modules/ModuleFactory.ts';
import { LEGACY_DEFINITIONS } from './legacyDefinitions.ts';
import type * as L from './legacyModules.ts';

const isLegacyModule = (name: ModuleName): name is LegacyModuleName => !(TS_ONLY_MODULES as readonly ModuleName[]).includes(name);

/** Kept for existing imports: the same list as {@link MODULE_ORDER}. */
export const LEGACY_MODULE_ORDER = MODULE_ORDER;

/** Everything the modules are wired into. */
export interface LegacyWiringContext {
  backendRoot: string;
  io: Server;
  app: Express;
  socketServer: SocketServer;
  logger: Logger;
  config: AppConfig;
  users: UserRegistry;
  presence: PresenceService;
  overrides?: ModuleOverrides;
}

/** One mounted module: its name and whether the legacy code or an override provides it. */
export interface MountedModule {
  name: ModuleName;
  source: 'legacy' | 'override';
}

/**
 * Mounts every socket module in {@link MODULE_ORDER}: the legacy module
 * (behind a LegacyModuleAdapter, exactly as server.js wired it) or its
 * override. A TypeScript-only module (no legacy handler) is mounted only when
 * an override provides it. Controllers are registered in module order;
 * providers are slotted into the legacy room-state / init-data order by module name.
 */
export class LegacyModuleRegistry {
  readonly #ctx: LegacyWiringContext;
  readonly #require: NodeJS.Require;
  readonly #apis = new Map<ModuleName, unknown>();
  readonly #registrations = new Map<ModuleName, ModuleRegistration<unknown>>();
  #database: DatabaseConnection | undefined;
  /** Mounted modules in mount order. */
  readonly mounted: MountedModule[] = [];

  constructor(ctx: LegacyWiringContext) {
    this.#ctx = ctx;
    this.#require = createRequire(path.join(ctx.backendRoot, 'server.js'));
  }

  /** Requires a legacy module relative to the backend root. */
  load<T>(id: string): T {
    // Legacy modules are untyped CommonJS; the declared interfaces in legacyModules.ts describe them.
    return this.#require(id) as T;
  }

  /** Mounts every module in order, then registers the providers. Returns the phobia API (its tick loop is cleared on stop). */
  mountSocketModules(): ModuleApis['phobia'] {
    const { users } = this.load<L.LegacyState>('./state');
    for (const name of MODULE_ORDER) this.#mountOne(name, users);
    this.#registerProviders();
    return this.#api('phobia');
  }

  /** Legacy HTTP routes, in server.js order: API, analysis, then the static frontend. */
  mountHttpRoutes(): void {
    const { app } = this.#ctx;
    const routes = this.load<L.LegacyHttpRoutes>('./httpRoutes');
    routes.setupApiRoutes(app);
    this.load<L.LegacyAnalysisRoutes>('./analysis/routes').setupAnalysisRoutes(app);
    routes.serveFrontend(app);
  }

  /** Disposes every mounted module that has a `dispose` hook, in reverse mount order. Errors are logged. */
  disposeModules(): void {
    for (const { name } of [...this.mounted].reverse()) {
      try {
        this.#registrations.get(name)?.dispose?.();
      } catch (err) {
        this.#ctx.logger.error(`Disposing module "${name}" failed`, err);
      }
    }
  }

  #mountOne(name: ModuleName, usersMap: L.UsersMap): void {
    const override = this.#ctx.overrides?.[name];
    const legacy = isLegacyModule(name) ? LEGACY_DEFINITIONS[name] : undefined;
    if (!override && !legacy) return;
    // Each factory is typed for its own name; the map lookup erases that, the registration is stored as unknown.
    const factory = (override ?? legacy) as ModuleFactory;
    const registration = factory(this.#deps(name, usersMap)) as ModuleRegistration<unknown>;
    if (registration.controller) this.#ctx.socketServer.addController(registration.controller);
    this.#apis.set(name, registration.api);
    this.#registrations.set(name, registration);
    this.mounted.push({ name, source: override ? 'override' : 'legacy' });
  }

  #deps(name: ModuleName, usersMap: L.UsersMap): ModuleDeps {
    const ctx = this.#ctx;
    const db = (): DatabaseConnection => this.#db();
    return {
      name, io: ctx.io, app: ctx.app, users: ctx.users, usersMap, presence: ctx.presence, config: ctx.config,
      logger: ctx.logger, socketServer: ctx.socketServer, backendRoot: ctx.backendRoot,
      get database() { return db(); },
      module: (other) => this.#api(other),
      loadLegacy: (id) => this.load(id),
      createLegacyAdapter: () => new LegacyModuleAdapter(name, ctx.io, ctx.logger.child(name))
    };
  }

  #db(): DatabaseConnection {
    this.#database ??= { connection: this.load<{ db: DatabaseConnection['connection'] }>('./database').db };
    return this.#database;
  }

  #api<K extends ModuleName>(name: K): ModuleApis[K] {
    if (!this.#apis.has(name)) throw new Error(`Module "${name}" is not mounted yet (check MODULE_ORDER)`);
    // Stored by #mountOne from the factory registered for this very name.
    return this.#apis.get(name) as ModuleApis[K];
  }

  #registerProviders(): void {
    const { socketServer } = this.#ctx;
    for (const provider of this.#providers(ROOM_STATE_ORDER, (r) => r.roomStateProvider)) socketServer.addRoomStateProvider(provider);
    for (const provider of this.#providers(INITIAL_STATE_ORDER, (r) => r.initialStateProvider)) socketServer.addInitialStateProvider(provider);
  }

  /** Providers in the legacy slot order, then providers of modules outside it, in module order. */
  #providers<P extends RoomStateProvider | InitialStateProvider>(
    slots: readonly ModuleName[], pick: (r: ModuleRegistration<unknown>) => P | undefined
  ): P[] {
    const names = [...slots, ...MODULE_ORDER.filter((n) => !slots.includes(n))];
    return names.flatMap((n) => {
      const reg = this.#registrations.get(n);
      const provider = reg ? pick(reg) : undefined;
      return provider ? [provider] : [];
    });
  }
}
