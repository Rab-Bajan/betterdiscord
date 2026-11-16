import type { Express } from 'express';
import type { Server } from 'socket.io';
import type { AppConfig } from '../../config/AppConfig.ts';
import type { Logger } from '../../core/logging/Logger.ts';
import type { SocketController } from '../../core/socket/SocketController.ts';
import type { InitialStateProvider, RoomStateProvider } from '../../core/socket/SocketStateProviders.ts';
import type { SqliteDatabase } from '../../infrastructure/database/SqliteDatabase.ts';
import type { LegacyModuleAdapter } from '../../infrastructure/socket/LegacyModuleAdapter.ts';
import type { SocketServer } from '../../infrastructure/socket/SocketServer.ts';
import type { PresenceService } from '../../modules/presence/PresenceService.ts';
import type { UserRegistry } from '../../modules/presence/UserRegistry.ts';
import type { SweepersApi } from '../../modules/sweepers/types.ts';
import type * as L from '../legacy/legacyModules.ts';

/**
 * Socket modules in mount order (= legacy server.js order, then the modules without a legacy
 * handler). Disconnect listeners fire in this order.
 */
export const MODULE_ORDER = Object.freeze([
  'casino', 'watchParty', 'chess', 'codeEditor', 'dm', 'browser', 'call', 'chat', 'whiteboard',
  'game', 'empire', 'phobia', 'speedTest', 'voice', 'auth', 'admin', 'sweepers'
] as const);

export type ModuleName = (typeof MODULE_ORDER)[number];

/** Modules that exist only in TypeScript: mounted when an override provides them, otherwise skipped. */
export const TS_ONLY_MODULES = Object.freeze(['sweepers'] as const);

export type TsOnlyModuleName = (typeof TS_ONLY_MODULES)[number];

/** Modules backed by a legacy handler. */
export type LegacyModuleName = Exclude<ModuleName, TsOnlyModuleName>;

/** Order of the voice-join room-state emits (legacy voiceHandler callback in server.js). */
export const ROOM_STATE_ORDER: readonly ModuleName[] = Object.freeze(
  ['game', 'whiteboard', 'codeEditor', 'watchParty', 'browser', 'empire', 'phobia', 'sweepers'] as const
);

/** Order of the extra `init:data` keys (legacy authHandler getter in server.js). */
export const INITIAL_STATE_ORDER: readonly ModuleName[] = Object.freeze(
  ['chat', 'casino', 'watchParty', 'chess', 'browser', 'empire', 'phobia', 'sweepers'] as const
);

/**
 * Public API each module exposes to the modules mounted after it: the same
 * shape the legacy factory returned (an override must keep it).
 */
export interface ModuleApis {
  casino: L.LegacyCasino;
  watchParty: L.LegacyWatchParty;
  chess: L.LegacyChess;
  codeEditor: L.LegacyCodeEditor;
  dm: L.LegacyDm;
  browser: L.LegacyBrowser;
  call: unknown;
  chat: L.LegacyChat;
  whiteboard: L.LegacyWhiteboard;
  game: L.LegacyGame;
  empire: L.LegacyEmpire;
  phobia: L.LegacyPhobia;
  speedTest: unknown;
  voice: unknown;
  auth: unknown;
  admin: unknown;
  sweepers: SweepersApi;
}

/** The shared better-sqlite3 connection (legacy database.js `db`), usable by every repository. */
export type DatabaseConnection = Pick<SqliteDatabase, 'connection'>;

/** Shared dependencies handed to every {@link ModuleFactory}. */
export interface ModuleDeps {
  /** Name of the module being mounted. */
  readonly name: ModuleName;
  /** The real socket.io Server. A controller binds per-socket events in `register`; never call `io.on('connection')`. */
  readonly io: Server;
  readonly app: Express;
  /** Typed view over the state.js `users` Map (same instance legacy code mutates). */
  readonly users: UserRegistry;
  /** The raw state.js `users` Map, for legacy factories that take it. */
  readonly usersMap: L.UsersMap;
  readonly presence: PresenceService;
  /** Lazily opened: the legacy database.js connection (one connection for old and new code). */
  readonly database: DatabaseConnection;
  readonly config: AppConfig;
  /** Root application logger; take a `child(...)` with the legacy log prefix. */
  readonly logger: Logger;
  /** For `emitRoomState` (voice) and `buildInitialState` (auth); providers are complete before the first connection. */
  readonly socketServer: SocketServer;
  readonly backendRoot: string;
  /** API of a module mounted EARLIER in {@link MODULE_ORDER}; throws for a later or unknown one. */
  module<K extends ModuleName>(name: K): ModuleApis[K];
  /** Requires a legacy CommonJS module relative to the backend root. */
  loadLegacy<T>(id: string): T;
  /** Adapter to run a legacy `io.on('connection')` factory: pass `adapter.io` to it, return the adapter as `controller`. */
  createLegacyAdapter(): LegacyModuleAdapter;
}

/** What a module contributes. Providers are slotted into the legacy order lists by module name. */
export interface ModuleRegistration<TApi> {
  controller?: SocketController;
  initialStateProvider?: InitialStateProvider;
  roomStateProvider?: RoomStateProvider;
  /** Releases what the module owns (timers, pending saves); called once by `Application.stop`, in reverse mount order. */
  dispose?: () => void;
  api: TApi;
}

/** Builds one module. Called once, synchronously, at the module's position in {@link MODULE_ORDER}. */
export type ModuleFactory<N extends ModuleName = ModuleName> = (deps: ModuleDeps) => ModuleRegistration<ModuleApis[N]>;

/** Replacement factories keyed by the legacy module they replace. */
export type ModuleOverrides = { [N in ModuleName]?: ModuleFactory<N> };
